/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * get_record tool — "Show me Client #5 with all details"
 * Full record detail with resolved FK values, ETag capture, and available actions.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { PostgRESTClient } from '../postgrest-client.js';
import { PostgRESTRequestError } from '../postgrest-client.js';
import type { SchemaCache } from '../schema-cache.js';
import type { NameResolver } from '../name-resolver.js';
import { buildSelectString, filterProperties } from '../select-builder.js';
import { renderRecordDetail } from '../formatters/markdown-table.js';
import { evaluateCondition } from './execute-action.js';

export function registerGetRecord(
  server: McpServer,
  client: PostgRESTClient,
  cache: SchemaCache,
  resolver: NameResolver,
  cacheKey?: string,
): void {
  server.registerTool(
    'get_record',
    {
      title: 'Get Record',
      description:
        'Get the full details of a single record by ID. Returns all detail-view fields ' +
        'with resolved foreign key values, status/category names, and the record\'s ETag ' +
        '(required for subsequent update_record calls). Also shows available actions for ' +
        'the current record state.',
      inputSchema: z.object({
        entity: z.string().describe('Entity display name or table name'),
        id: z.union([z.number(), z.string()]).describe('Record ID'),
        columns: z.array(z.string()).optional().describe(
          'Specific columns to include. Defaults to detail-view columns.',
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ entity, id, columns }) => {
      await cache.ensureFreshForUser(client, cacheKey);

      const resolved = resolver.resolveEntity(entity);
      const allProperties = cache.getProperties(resolved.table_name);

      // Determine which properties to display
      const displayProperties = columns
        ? columns.map(c => resolver.resolveColumn(resolved.table_name, c))
        : filterProperties(allProperties, 'detail');

      // Build select string with FK embedding + timestamps
      const selectStr = buildSelectString(displayProperties, { includeTimestamps: true });

      try {
        const response = await client.get<Record<string, unknown>[]>(
          resolved.table_name,
          {
            select: selectStr,
            id: `eq.${id}`,
          },
        );

        if (response.data.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `Record #${id} not found in ${resolved.display_name}.`,
            }],
            isError: true,
          };
        }

        const record = response.data[0];
        const etag = response.etag;

        // Build detail output
        const lines: string[] = [];
        lines.push(`# ${resolved.display_name} #${id}`);
        lines.push('');
        lines.push(renderRecordDetail(record, displayProperties));

        // Include ETag for update_record
        if (etag) {
          lines.push('');
          lines.push(`**ETag**: \`${etag}\``);
          lines.push('_Use this ETag value in update_record to safely update this record._');
        }

        // Show available actions for current record state
        const actions = cache.getActionsForUser(cacheKey, resolved.table_name);
        const availableActions = actions.filter(action => {
          if (!action.can_execute) return false;
          if (!action.show_on_detail) return false;
          // Check visibility condition against current record
          if (action.visibility_condition) {
            return evaluateCondition(action.visibility_condition, record);
          }
          return true;
        });

        if (availableActions.length > 0) {
          lines.push('');
          lines.push('## Available Actions');
          lines.push('');
          lines.push(
            '> Use `execute_action` for status changes and workflow transitions ' +
            'instead of `update_record` — actions include business logic.',
          );
          lines.push('');

          for (const action of availableActions) {
            let line = `- **${action.display_name}** (\`${action.action_name}\`)`;
            if (action.description) line += ` — ${action.description}`;

            // Check enabled condition
            if (action.enabled_condition && !evaluateCondition(action.enabled_condition, record)) {
              line += ` *(disabled: ${action.disabled_tooltip ?? 'conditions not met'})*`;
            }

            lines.push(line);
          }
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
