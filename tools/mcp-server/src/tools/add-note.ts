/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * add_note tool — "Add a note to Client Acme: 'Discussed renewal terms'"
 * Creates an entity note via the create_entity_note RPC.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { PostgRESTClient } from '../postgrest-client.js';
import { PostgRESTRequestError } from '../postgrest-client.js';
import type { SchemaCache } from '../schema-cache.js';
import type { NameResolver } from '../name-resolver.js';

export function registerAddNote(
  server: McpServer,
  client: PostgRESTClient,
  cache: SchemaCache,
  resolver: NameResolver,
): void {
  server.registerTool(
    'add_note',
    {
      title: 'Add Note',
      description:
        'Add a note to a record. Notes support Markdown formatting. ' +
        'The entity must have notes enabled (enable_notes = true).',
      inputSchema: z.object({
        entity: z.string().describe('Entity display name or table name'),
        id: z.union([z.number(), z.string()]).describe('Record ID'),
        content: z.string().describe('Note content (Markdown supported)'),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ entity, id, content }) => {
      await cache.ensureFresh();

      const resolved = resolver.resolveEntity(entity);

      if (!resolved.enable_notes) {
        return {
          content: [{
            type: 'text' as const,
            text: `Notes are not enabled for ${resolved.display_name}. ` +
              'An administrator can enable notes with: ' +
              `\`SELECT enable_entity_notes('${resolved.table_name}')\``,
          }],
          isError: true,
        };
      }

      try {
        const response = await client.post<{ id: number; created_at: string }>(
          'rpc/create_entity_note',
          {
            p_entity_type: resolved.table_name,
            p_entity_id: id,
            p_content: content,
          },
        );

        const result = response.data;

        return {
          content: [{
            type: 'text' as const,
            text: `Note added to ${resolved.display_name} #${id}.` +
              (result?.id ? ` (Note ID: ${result.id})` : ''),
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
