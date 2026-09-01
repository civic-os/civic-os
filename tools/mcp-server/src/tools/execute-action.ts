/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * execute_action tool — "Approve reservation request #42"
 * Executes an entity action (RPC) with condition checks and parameter resolution.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { PostgRESTClient } from '../postgrest-client.js';
import { PostgRESTRequestError } from '../postgrest-client.js';
import type { SchemaCache } from '../schema-cache.js';
import type { NameResolver } from '../name-resolver.js';
import type { ActionCondition, EntityActionResult } from '../interfaces.js';

export function registerExecuteAction(
  server: McpServer,
  client: PostgRESTClient,
  cache: SchemaCache,
  resolver: NameResolver,
  cacheKey?: string,
): void {
  server.registerTool(
    'execute_action',
    {
      title: 'Execute Action',
      description:
        'Execute an entity action (approval, status change, workflow transition, etc.). ' +
        'Actions embed server-side business logic — prefer this over update_record for ' +
        'status changes and workflow operations. No ETag required (RPCs are atomic).',
      inputSchema: z.object({
        entity: z.string().describe('Entity display name or table name'),
        id: z.union([z.number(), z.string()]).describe('Record ID to act on'),
        action: z.string().describe('Action display name or action_name'),
        params: z.record(z.string(), z.unknown()).optional().describe(
          'Optional action parameters as key-value pairs. Use param display names as keys. ' +
          'FK parameter values can be display names (resolved automatically).',
        ),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ entity, id, action, params }) => {
      await cache.ensureFreshForUser(client, cacheKey);

      const resolved = resolver.resolveEntity(entity);
      const actionConfig = resolver.resolveAction(resolved.table_name, action);

      // Check permission
      if (!actionConfig.can_execute) {
        return {
          content: [{
            type: 'text' as const,
            text: `You do not have permission to execute "${actionConfig.display_name}" on ${resolved.display_name}.`,
          }],
          isError: true,
        };
      }

      // Fetch current record to check conditions
      let currentRecord: Record<string, unknown> | undefined;
      if (actionConfig.visibility_condition || actionConfig.enabled_condition) {
        try {
          const response = await client.get<Record<string, unknown>[]>(
            resolved.table_name,
            { id: `eq.${id}` },
          );
          currentRecord = response.data[0];
        } catch {
          // If we can't fetch the record, proceed — the RPC will validate
        }
      }

      // Check visibility condition
      if (currentRecord && actionConfig.visibility_condition) {
        if (!evaluateCondition(actionConfig.visibility_condition, currentRecord)) {
          return {
            content: [{
              type: 'text' as const,
              text: `Action "${actionConfig.display_name}" is not available for this record in its current state.`,
            }],
            isError: true,
          };
        }
      }

      // Check enabled condition
      if (currentRecord && actionConfig.enabled_condition) {
        if (!evaluateCondition(actionConfig.enabled_condition, currentRecord)) {
          return {
            content: [{
              type: 'text' as const,
              text: actionConfig.disabled_tooltip
                ? `Action "${actionConfig.display_name}" is disabled: ${actionConfig.disabled_tooltip}`
                : `Action "${actionConfig.display_name}" is disabled for this record in its current state.`,
            }],
            isError: true,
          };
        }
      }

      // Validate required parameters
      const requiredParams = actionConfig.parameters.filter(p => p.required);
      for (const rp of requiredParams) {
        const provided = params?.[rp.param_name] ?? params?.[rp.display_name];
        if (provided === undefined || provided === null || provided === '') {
          return {
            content: [{
              type: 'text' as const,
              text: `Missing required parameter "${rp.display_name}" (\`${rp.param_name}\`).`,
            }],
            isError: true,
          };
        }
      }

      // Build RPC payload
      const rpcPayload: Record<string, unknown> = {
        p_entity_id: id,
      };

      // Resolve action parameters
      if (params) {
        for (const actionParam of actionConfig.parameters) {
          const value = params[actionParam.param_name] ?? params[actionParam.display_name];
          if (value === undefined) continue;

          // Resolve FK param values
          if (typeof value === 'string' && actionParam.join_table) {
            try {
              rpcPayload[actionParam.param_name] = await resolver.resolveForeignKeyValue(
                actionParam.join_table,
                value,
              );
              continue;
            } catch {
              // Fall through to raw value
            }
          }

          // Resolve status param values
          if (typeof value === 'string' && actionParam.status_entity_type) {
            try {
              rpcPayload[actionParam.param_name] = resolver.resolveStatus(
                actionParam.status_entity_type,
                value,
              );
              continue;
            } catch {
              // Fall through to raw value
            }
          }

          // Resolve category param values
          if (typeof value === 'string' && actionParam.category_entity_type) {
            try {
              rpcPayload[actionParam.param_name] = resolver.resolveCategory(
                actionParam.category_entity_type,
                value,
              );
              continue;
            } catch {
              // Fall through to raw value
            }
          }

          rpcPayload[actionParam.param_name] = value;
        }
      }

      try {
        const response = await client.post<EntityActionResult>(
          `rpc/${actionConfig.rpc_function}`,
          rpcPayload,
        );

        const result = response.data;

        // Build success message
        const message = result?.message
          ?? actionConfig.default_success_message
          ?? `Action "${actionConfig.display_name}" executed successfully.`;

        let text = message;
        if (result?.navigate_to) {
          text += `\n\nSuggested next step: navigate to ${result.navigate_to}`;
        }
        if (result?.refresh || actionConfig.refresh_after_action) {
          text += `\n\nThe record has been modified. Use \`get_record\` to see the updated state.`;
        }

        return {
          content: [{ type: 'text' as const, text }],
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

/**
 * Evaluate a visibility/enabled condition against record data.
 * Supports simple conditions, AND, and OR compounds.
 * Exported for use by get_record tool.
 */
export function evaluateCondition(
  condition: ActionCondition,
  record: Record<string, unknown>,
): boolean {
  // Compound OR
  if ('or' in condition) {
    return condition.or.some(c => evaluateCondition(c, record));
  }

  // Compound AND
  if ('and' in condition) {
    return condition.and.every(c => evaluateCondition(c, record));
  }

  // Simple condition
  const { field, operator, value } = condition;
  const recordValue = resolveFieldValue(record, field);

  switch (operator) {
    case 'eq': return recordValue == value; // loose equality for number/string coercion
    case 'ne': return recordValue != value;
    case 'gt': return (recordValue as number) > (value as number);
    case 'lt': return (recordValue as number) < (value as number);
    case 'gte': return (recordValue as number) >= (value as number);
    case 'lte': return (recordValue as number) <= (value as number);
    case 'in': return Array.isArray(value) && value.includes(recordValue);
    case 'is_null': return recordValue === null || recordValue === undefined;
    case 'is_not_null': return recordValue !== null && recordValue !== undefined;
    default: return true;
  }
}

/**
 * Resolve a field value from a record, supporting dot-notation paths.
 * e.g., "status_id.id" → record.status_id.id (for embedded FK objects)
 */
function resolveFieldValue(record: Record<string, unknown>, field: string): unknown {
  const parts = field.split('.');
  let current: unknown = record;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
