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
import { NameResolutionError } from '../name-resolver.js';
import { describeConditionFailure, evaluateActionCondition, propsForDetail } from '@civic-os/core';
import type { EntityActionResult } from '../interfaces.js';
import { detailSelectFields } from '../select-fields.js';

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
        'status changes and workflow operations.',
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

      // Fetch current record to check conditions.
      // Use FK embedding so dot-notation conditions (e.g., "status_id.status_key") resolve correctly.
      // Conditions gate the action, so if the record cannot be loaded the action is
      // refused rather than sent to the RPC unchecked (the frontend never shows it).
      let currentRecord: Record<string, unknown> | undefined;
      if (actionConfig.visibility_condition || actionConfig.enabled_condition) {
        try {
          // The core detail plan (Q-13): detail properties, id, and the fields the conditions read.
          const allProperties = cache.getPropertiesForUser(cacheKey, resolved.table_name);
          const selectList = detailSelectFields(
            allProperties,
            propsForDetail(allProperties),
            cache.getActionsForUser(cacheKey, resolved.table_name),
          );
          // Core drops an empty filter value (Q-08), which would read every row: an empty id matches none.
          const rows = String(id) === '' ? [] : await client.data.getData({
            key: resolved.table_name,
            fields: selectList,
            entityHasId: allProperties.some(p => p.column_name === 'id' || p.is_identity === true),
            entityId: String(id),
          });
          currentRecord = rows[0];
        } catch (err) {
          if (err instanceof PostgRESTRequestError) {
            return {
              content: [{
                type: 'text' as const,
                text: `Could not load ${resolved.display_name} #${id} to check whether "${actionConfig.display_name}" is allowed: ` +
                  err.toHumanMessage(cache.constraintMessages),
              }],
              isError: true,
            };
          }
          throw err;
        }

        if (!currentRecord) {
          return {
            content: [{
              type: 'text' as const,
              text: `Record #${id} not found in ${resolved.display_name} (or you cannot read it), ` +
                `so the conditions for "${actionConfig.display_name}" cannot be checked.`,
            }],
            isError: true,
          };
        }
      }

      // Check visibility condition
      if (currentRecord && actionConfig.visibility_condition) {
        if (!evaluateActionCondition(actionConfig.visibility_condition, currentRecord)) {
          const reason = describeConditionFailure(actionConfig.visibility_condition, currentRecord);
          return {
            content: [{
              type: 'text' as const,
              text: `Action "${actionConfig.display_name}" is not available for this record.\n\n${reason}\n\nUse \`get_record\` to see the current state and available actions.`,
            }],
            isError: true,
          };
        }
      }

      // Check enabled condition
      if (currentRecord && actionConfig.enabled_condition) {
        if (!evaluateActionCondition(actionConfig.enabled_condition, currentRecord)) {
          const reason = actionConfig.disabled_tooltip
            ?? describeConditionFailure(actionConfig.enabled_condition, currentRecord);
          return {
            content: [{
              type: 'text' as const,
              text: `Action "${actionConfig.display_name}" is disabled: ${reason}\n\nUse \`get_record\` to see the current state and available actions.`,
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

          // Resolve FK param values — surface name resolution errors
          if (typeof value === 'string' && actionParam.join_table) {
            try {
              rpcPayload[actionParam.param_name] = await resolver.resolveForeignKeyValue(
                actionParam.join_table,
                value,
              );
              continue;
            } catch (paramErr) {
              if (paramErr instanceof NameResolutionError) {
                return {
                  content: [{ type: 'text' as const, text: `Parameter "${actionParam.display_name}": ${paramErr.message}` }],
                  isError: true,
                };
              }
              // Non-resolution error — fall through to raw value
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
            } catch (paramErr) {
              if (paramErr instanceof NameResolutionError) {
                return {
                  content: [{ type: 'text' as const, text: `Parameter "${actionParam.display_name}": ${paramErr.message}` }],
                  isError: true,
                };
              }
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
            } catch (paramErr) {
              if (paramErr instanceof NameResolutionError) {
                return {
                  content: [{ type: 'text' as const, text: `Parameter "${actionParam.display_name}": ${paramErr.message}` }],
                  isError: true,
                };
              }
            }
          }

          rpcPayload[actionParam.param_name] = value;
        }
      }

      try {
        const result = (await client.data.callRpc(actionConfig.rpc_function, rpcPayload)) as EntityActionResult | null | undefined;

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
