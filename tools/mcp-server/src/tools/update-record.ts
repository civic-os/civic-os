/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * update_record tool — "Change client Acme's status to Active"
 * Updates a record by ID.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { PostgRESTClient } from '../postgrest-client.js';
import { PostgRESTRequestError } from '../postgrest-client.js';
import type { SchemaCache } from '../schema-cache.js';
import type { NameResolver } from '../name-resolver.js';
import { NameResolutionError } from '../name-resolver.js';

export function registerUpdateRecord(
  server: McpServer,
  client: PostgRESTClient,
  cache: SchemaCache,
  resolver: NameResolver,
  cacheKey?: string,
): void {
  server.registerTool(
    'update_record',
    {
      title: 'Update Record',
      description:
        'Update fields on an existing record. Before using this tool, check if an Entity Action ' +
        'exists for the change you want to make (especially status changes, approvals, or ' +
        'workflow transitions) — actions embed business logic that direct updates bypass.',
      inputSchema: z.object({
        entity: z.string().describe('Entity display name or table name'),
        id: z.union([z.number(), z.string()]).describe('Record ID'),
        data: z.record(z.string(), z.unknown()).describe(
          'Fields to update as key-value pairs. Keys can be display names or column names. ' +
          'FK values can be display names (resolved to IDs automatically).',
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ entity, id, data }) => {
      await cache.ensureFreshForUser(client, cacheKey);

      const resolved = resolver.resolveEntity(entity);

      if (!resolved.update) {
        return {
          content: [{
            type: 'text' as const,
            text: `You do not have permission to update records in ${resolved.display_name}.`,
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
        const response = await client.patch<Record<string, unknown>[]>(
          resolved.table_name,
          resolvedData,
          { id: `eq.${id}` },
          { 'Prefer': 'return=representation' },
        );

        // PostgREST returns empty array when no rows match the filter
        if (Array.isArray(response.data) && response.data.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `Record #${id} not found in ${resolved.display_name}.`,
            }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: `Successfully updated ${resolved.display_name} #${id}.` }],
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
                content: [{ type: 'text' as const, text: `Required field "${fieldName}" cannot be set to null.` }],
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
