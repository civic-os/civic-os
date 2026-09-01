/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * list_notes tool — "Show me the notes on Client #5"
 * Fetches entity notes with author info, ordered by most recent first.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { PostgRESTClient } from '../postgrest-client.js';
import { PostgRESTRequestError } from '../postgrest-client.js';
import type { SchemaCache } from '../schema-cache.js';
import type { NameResolver } from '../name-resolver.js';
import { formatDateTimeLocal } from '../formatters/value.js';

interface EntityNote {
  id: number;
  content: string;
  note_type: 'note' | 'system';
  created_at: string;
  author_id: { id: string; display_name: string; full_name?: string | null } | null;
}

export function registerListNotes(
  server: McpServer,
  client: PostgRESTClient,
  cache: SchemaCache,
  resolver: NameResolver,
  cacheKey?: string,
): void {
  server.registerTool(
    'list_notes',
    {
      title: 'List Notes',
      description:
        'List notes on a record, ordered by most recent first. ' +
        'Includes author name, timestamp, and content. ' +
        'The entity must have notes enabled.',
      inputSchema: z.object({
        entity: z.string().describe('Entity display name or table name'),
        id: z.union([z.number(), z.string()]).describe('Record ID'),
        limit: z.number().int().min(1).max(50).optional().describe(
          'Maximum notes to return (default 25, max 50)',
        ),
        offset: z.number().int().min(0).optional().describe(
          'Number of notes to skip (for pagination)',
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ entity, id, limit = 25, offset = 0 }) => {
      await cache.ensureFreshForUser(client, cacheKey);

      const resolved = resolver.resolveEntity(entity);

      if (!resolved.enable_notes) {
        return {
          content: [{
            type: 'text' as const,
            text: `Notes are not enabled for ${resolved.display_name}.`,
          }],
          isError: true,
        };
      }

      try {
        // Verify the record exists before fetching notes
        const recordCheck = await client.get<Array<{ id: unknown }>>(
          resolved.table_name,
          { select: 'id', id: `eq.${id}`, limit: '1' },
        );
        if (recordCheck.data.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `Record #${id} not found in ${resolved.display_name}.`,
            }],
            isError: true,
          };
        }

        const response = await client.get<EntityNote[]>(
          'entity_notes',
          {
            select: 'id,content,note_type,created_at,author_id:civic_os_users!author_id(id,display_name,full_name)',
            entity_type: `eq.${resolved.table_name}`,
            entity_id: `eq.${id}`,
            order: 'created_at.desc',
            limit: String(limit),
            offset: String(offset),
          },
          {
            'Range-Unit': 'items',
            'Range': `${offset}-${offset + limit - 1}`,
            'Prefer': 'count=exact',
          },
        );

        const notes = response.data ?? [];
        const total = response.contentRange?.total;

        if (notes.length === 0 && offset === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No notes on ${resolved.display_name} #${id}.`,
            }],
          };
        }

        const lines: string[] = [];
        let summary = `**Notes on ${resolved.display_name} #${id}**`;
        if (total != null) {
          summary += ` — ${total} note${total !== 1 ? 's' : ''}`;
        }
        if (offset > 0 && notes.length > 0) {
          summary += ` (showing ${offset + 1}–${offset + notes.length})`;
        }
        lines.push(summary);
        lines.push('');

        for (const note of notes) {
          const author = note.author_id
            ? (note.author_id.full_name || note.author_id.display_name)
            : 'System';
          const time = formatDateTimeLocal(note.created_at);
          const typeLabel = note.note_type === 'system' ? ' *(system)* ' : '';

          lines.push(`---`);
          lines.push(`**${author}** — ${time}${typeLabel}`);
          lines.push('');
          // Replace literal \n sequences with actual newlines (LLMs sometimes send escaped newlines)
          lines.push(note.content.replace(/\\n/g, '\n'));
          lines.push('');
        }

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n'),
          }],
        };
      } catch (err) {
        if (err instanceof PostgRESTRequestError) {
          return {
            content: [{ type: 'text' as const, text: err.toHumanMessage(cache.constraintMessages) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}
