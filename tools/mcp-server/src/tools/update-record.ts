/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * update_record tool — "Change client Acme's status to Active"
 * Updates a record with ETag-based optimistic concurrency.
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
): void {
  server.registerTool(
    'update_record',
    {
      title: 'Update Record',
      description:
        'Update fields on an existing record. Requires an ETag from a prior get_record call ' +
        'to prevent stale-context overwrites. Before using this tool, check if an Entity Action ' +
        'exists for the change you want to make (especially status changes, approvals, or ' +
        'workflow transitions) — actions embed business logic that direct updates bypass.',
      inputSchema: z.object({
        entity: z.string().describe('Entity display name or table name'),
        id: z.union([z.number(), z.string()]).describe('Record ID'),
        data: z.record(z.string(), z.unknown()).describe(
          'Fields to update as key-value pairs. Keys can be display names or column names. ' +
          'FK values can be display names (resolved to IDs automatically).',
        ),
        etag: z.string().describe(
          'ETag from a prior get_record call. Required to prevent overwriting changes ' +
          'made by other users. Get it from the get_record response.',
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ entity, id, data, etag }) => {
      await cache.ensureFresh();

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

      try {
        const response = await client.patch<Record<string, unknown>[]>(
          resolved.table_name,
          resolvedData,
          { id: `eq.${id}` },
          {
            'If-Match': etag,
            'Prefer': 'return=representation',
          },
        );

        const updated = Array.isArray(response.data) ? response.data[0] : response.data;
        const newEtag = response.etag;

        let text = `Successfully updated ${resolved.display_name} #${id}.`;
        if (newEtag) {
          text += `\n\n**New ETag**: \`${newEtag}\``;
          text += '\n_Use this new ETag for any subsequent updates to this record._';
        }

        return {
          content: [{ type: 'text' as const, text }],
        };
      } catch (err) {
        if (err instanceof PostgRESTRequestError) {
          const message = err.toHumanMessage(cache.constraintMessages);

          if (err.httpCode === 412) {
            return {
              content: [{
                type: 'text' as const,
                text: `${message}\n\nCall \`get_record\` for ${resolved.display_name} #${id} to get the current state and a fresh ETag.`,
              }],
              isError: true,
            };
          }

          return {
            content: [{ type: 'text' as const, text: message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}
