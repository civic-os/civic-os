/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * create_record tool — "Create a new time entry for Project X, 90 minutes, today"
 * Creates a record with FK display name resolution.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { PostgRESTClient } from '../postgrest-client.js';
import { PostgRESTRequestError } from '../postgrest-client.js';
import type { SchemaCache } from '../schema-cache.js';
import type { NameResolver } from '../name-resolver.js';
import { NameResolutionError } from '../name-resolver.js';

export function registerCreateRecord(
  server: McpServer,
  client: PostgRESTClient,
  cache: SchemaCache,
  resolver: NameResolver,
  cacheKey?: string,
): void {
  server.registerTool(
    'create_record',
    {
      title: 'Create Record',
      description:
        'Create a new record in an entity. Field values can use display names ' +
        '(e.g., {project: "Website Redesign"}) — foreign key names are automatically ' +
        'resolved to IDs. Before using this tool, check if an Entity Action exists ' +
        'for the creation workflow you need (some entities use guided forms or actions).',
      inputSchema: z.object({
        entity: z.string().describe('Entity display name or table name'),
        data: z.record(z.string(), z.unknown()).describe(
          'Field values as key-value pairs. Keys can be display names or column names. ' +
          'FK values can be display names (resolved to IDs automatically).',
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ entity, data }) => {
      await cache.ensureFreshForUser(client, cacheKey);

      const resolved = resolver.resolveEntity(entity);

      if (!resolved.insert) {
        return {
          content: [{
            type: 'text' as const,
            text: `You do not have permission to create records in ${resolved.display_name}.`,
          }],
          isError: true,
        };
      }

      // Resolve field names and FK values
      let resolvedData: Record<string, unknown>;
      try {
        resolvedData = await resolver.resolveData(resolved.table_name, data);
      } catch (err) {
        if (err instanceof NameResolutionError) {
          return {
            content: [{ type: 'text' as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }

      // Convert empty display_name to null so the DB's NOT NULL constraint
      // catches it with a friendly error instead of silently breaking FK resolution.
      if ('display_name' in resolvedData) {
        const dn = resolvedData.display_name;
        if (dn === '' || (typeof dn === 'string' && dn.trim() === '')) {
          resolvedData.display_name = null;
        }
      }

      try {
        const response = await client.post<Record<string, unknown>[]>(
          resolved.table_name,
          resolvedData,
          { Prefer: 'return=representation' },
        );

        const created = Array.isArray(response.data) ? response.data[0] : response.data;
        const id = (created as Record<string, unknown>)?.id;

        let text = `Successfully created ${resolved.display_name} record${id != null ? ` (ID: ${id})` : ''}.`;
        if (id != null) {
          text += `\n\nUse \`get_record\` with entity "${resolved.display_name}" and ID ${id} to see the full record.`;
        }

        return {
          content: [{ type: 'text' as const, text }],
        };
      } catch (err) {
        if (err instanceof PostgRESTRequestError) {
          // Not-null violation — resolve column name to display name
          if (err.code === '23502') {
            const colMatch = err.message.match(/column "([^"]+)"/);
            if (colMatch?.[1]) {
              const allProperties = cache.getPropertiesForUser(cacheKey, resolved.table_name);
              const prop = allProperties.find(p => p.column_name === colMatch[1]);
              const fieldName = prop ? prop.display_name : colMatch[1];
              return {
                content: [{ type: 'text' as const, text: `Required field "${fieldName}" is missing.` }],
                isError: true,
              };
            }
          }
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
