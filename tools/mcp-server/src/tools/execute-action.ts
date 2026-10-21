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
import type {
  ActionCondition,
  AndCondition,
  EntityActionResult,
  OrCondition,
  SimpleCondition,
} from '../interfaces.js';
import { buildSelectString } from '../select-builder.js';

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
          const allProperties = cache.getPropertiesForUser(cacheKey, resolved.table_name);
          const selectStr = buildSelectString(allProperties);
          const response = await client.get<Record<string, unknown>[]>(
            resolved.table_name,
            { select: selectStr, id: `eq.${id}` },
          );
          currentRecord = response.data?.[0];
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
        if (!evaluateCondition(actionConfig.visibility_condition, currentRecord)) {
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
        if (!evaluateCondition(actionConfig.enabled_condition, currentRecord)) {
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

/** A condition entry is usable only when it is a non-null object. */
function isConditionObject(c: unknown): c is ActionCondition {
  return typeof c === 'object' && c !== null;
}

/** OR compound — only when `or` is an array (matches the frontend's type guard). */
function isOrCondition(c: ActionCondition): c is OrCondition {
  return 'or' in c && Array.isArray((c as OrCondition).or);
}

/** AND compound — only when `and` is an array. */
function isAndCondition(c: ActionCondition): c is AndCondition {
  return 'and' in c && Array.isArray((c as AndCondition).and);
}

/**
 * Evaluate a visibility/enabled condition against record data.
 * Supports simple conditions, AND, and OR compounds.
 * Exported for use by get_record tool.
 *
 * Mirrors the frontend's src/app/utils/condition-evaluator.ts: no condition is
 * always true, no record is always false, equality is strict, ordering operators
 * need numbers on both sides, and anything it cannot evaluate fails closed.
 */
export function evaluateCondition(
  condition: ActionCondition | null | undefined,
  record: Record<string, unknown> | null | undefined,
): boolean {
  // No condition means always true
  if (!condition) return true;

  // No record means the condition cannot be evaluated — fail closed
  if (!record) return false;

  // A scalar in the metadata JSONB ("x", 5) is not a condition — fail closed
  if (typeof condition !== 'object') return false;

  // Compound OR / AND. Only an absent *top-level* condition means "always";
  // a null, false or scalar entry inside a compound is malformed and fails closed,
  // so {or: [null]} cannot enable an action.
  if (isOrCondition(condition)) {
    return condition.or.some(c => isConditionObject(c) && evaluateCondition(c, record));
  }

  if (isAndCondition(condition)) {
    return condition.and.every(c => isConditionObject(c) && evaluateCondition(c, record));
  }

  // Simple condition (a malformed one without a field name fails closed)
  const { field, operator, value } = condition as SimpleCondition;
  if (typeof field !== 'string') return false;
  const recordValue = resolveFieldValue(record, field);

  switch (operator) {
    case 'eq': return recordValue === value;
    case 'ne': return recordValue !== value;
    case 'gt': return typeof recordValue === 'number' && typeof value === 'number' && recordValue > value;
    case 'lt': return typeof recordValue === 'number' && typeof value === 'number' && recordValue < value;
    case 'gte': return typeof recordValue === 'number' && typeof value === 'number' && recordValue >= value;
    case 'lte': return typeof recordValue === 'number' && typeof value === 'number' && recordValue <= value;
    case 'in': return Array.isArray(value) && value.includes(recordValue);
    case 'is_null': return recordValue === null || recordValue === undefined;
    case 'is_not_null': return recordValue !== null && recordValue !== undefined;
    // Unknown operator: fail closed so a typo in metadata never exposes a gated action
    // (matches the frontend's condition-evaluator.ts)
    default: return false;
  }
}

/**
 * Resolve a field value from a record, supporting dot-notation paths.
 * e.g., "status_id.status_key" → record.status_id.status_key (for embedded FK objects)
 *
 * A plain field holding an embedded FK object (`status_id: {id: 5, ...}`) resolves
 * to its `.id`, so `status_id eq 5` matches the way it does in the frontend.
 */
function resolveFieldValue(record: Record<string, unknown>, field: string): unknown {
  if (!field.includes('.')) {
    const value = record[field];
    if (value !== null && typeof value === 'object' && 'id' in value) {
      return (value as Record<string, unknown>).id;
    }
    return value;
  }

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

/**
 * Build a human-readable explanation of why a condition failed.
 * Tells the LLM what the record's current value is vs what was expected.
 * Exported for the golden-output tests (src/__tests__/golden).
 */
export function describeConditionFailure(
  condition: ActionCondition,
  record: Record<string, unknown>,
): string {
  if (typeof condition !== 'object' || condition === null) return 'the condition is malformed';
  if (isOrCondition(condition)) {
    const parts = condition.or.map(c => isConditionObject(c)
      ? describeConditionFailure(c, record)
      : 'a sub-condition is malformed');
    return `None of these conditions are met:\n${parts.map(p => `  - ${p}`).join('\n')}`;
  }

  if (isAndCondition(condition)) {
    const failing = condition.and.filter(c => !isConditionObject(c) || !evaluateCondition(c, record));
    const parts = failing.map(c => isConditionObject(c)
      ? describeConditionFailure(c, record)
      : 'a sub-condition is malformed');
    return parts.join('; ');
  }

  const { field, operator, value } = condition as SimpleCondition;
  if (typeof field !== 'string') return 'the condition is malformed (no field name)';
  const actual = resolveFieldValue(record, field);
  const fmt = (v: unknown) => v === null || v === undefined ? 'null' : JSON.stringify(v);

  switch (operator) {
    case 'eq': return `${field} is ${fmt(actual)}, expected ${fmt(value)}`;
    case 'ne': return `${field} is ${fmt(actual)}, must not be ${fmt(value)}`;
    case 'gt': return `${field} is ${fmt(actual)}, must be > ${fmt(value)}`;
    case 'lt': return `${field} is ${fmt(actual)}, must be < ${fmt(value)}`;
    case 'gte': return `${field} is ${fmt(actual)}, must be >= ${fmt(value)}`;
    case 'lte': return `${field} is ${fmt(actual)}, must be <= ${fmt(value)}`;
    case 'in': return `${field} is ${fmt(actual)}, must be one of ${fmt(value)}`;
    case 'is_null': return `${field} is ${fmt(actual)}, must be null`;
    case 'is_not_null': return `${field} is null, must have a value`;
    default: return `${field} failed condition "${operator}"`;
  }
}
