/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * list_actions tool — "What can I do with a Reservation Request?"
 * Shows available entity actions the user can execute.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { SchemaCache } from '../schema-cache.js';
import type { NameResolver } from '../name-resolver.js';

export function registerListActions(
  server: McpServer,
  cache: SchemaCache,
  resolver: NameResolver,
): void {
  server.registerTool(
    'list_actions',
    {
      title: 'List Actions',
      description:
        'Show available actions for an entity. Actions execute server-side business logic ' +
        '(approvals, status changes, workflows) that direct record updates would bypass. ' +
        'Prefer using execute_action over update_record when an applicable action exists.',
      inputSchema: z.object({
        entity: z.string().describe('Entity display name or table name'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ entity }) => {
      await cache.ensureFresh();

      const resolved = resolver.resolveEntity(entity);
      const actions = cache.getActions(resolved.table_name);

      if (actions.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No actions available for ${resolved.display_name}.`,
          }],
        };
      }

      const lines: string[] = [];
      lines.push(`## Actions for ${resolved.display_name}`);
      lines.push('');

      for (const action of actions) {
        lines.push(`### ${action.display_name} (\`${action.action_name}\`)`);
        if (action.description) lines.push(action.description);
        lines.push('');

        // Permission
        if (!action.can_execute) {
          lines.push('**Permission**: You cannot execute this action.');
          lines.push('');
          continue;
        }

        // Conditions
        if (action.visibility_condition) {
          lines.push(`**Visible when**: ${formatCondition(action.visibility_condition)}`);
        }
        if (action.enabled_condition) {
          lines.push(`**Enabled when**: ${formatCondition(action.enabled_condition)}`);
          if (action.disabled_tooltip) {
            lines.push(`**When disabled**: ${action.disabled_tooltip}`);
          }
        }

        // Confirmation
        if (action.requires_confirmation) {
          lines.push(`**Requires confirmation**: ${action.confirmation_message ?? 'Yes'}`);
        }

        // Parameters
        if (action.parameters.length > 0) {
          lines.push('**Parameters**:');
          for (const param of action.parameters) {
            let paramLine = `- \`${param.param_name}\` (${param.display_name})`;
            paramLine += ` — ${param.param_type}`;
            if (param.required) paramLine += ' **(required)**';
            if (param.default_value) paramLine += `, default: ${param.default_value}`;
            if (param.join_table) paramLine += `, from: ${param.join_table}`;
            lines.push(paramLine);
          }
        }

        // Success behavior
        if (action.default_success_message) {
          lines.push(`**On success**: ${action.default_success_message}`);
        }

        lines.push('');
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n'),
        }],
      };
    },
  );
}

/** Format a condition object into human-readable text */
function formatCondition(condition: unknown): string {
  if (!condition || typeof condition !== 'object') return 'always';

  const cond = condition as Record<string, unknown>;

  // Compound conditions
  if ('or' in cond && Array.isArray(cond.or)) {
    return (cond.or as unknown[]).map(c => formatCondition(c)).join(' OR ');
  }
  if ('and' in cond && Array.isArray(cond.and)) {
    return (cond.and as unknown[]).map(c => formatCondition(c)).join(' AND ');
  }

  // Simple condition
  if ('field' in cond) {
    const field = cond.field as string;
    const op = cond.operator as string;
    const val = cond.value;

    switch (op) {
      case 'eq': return `${field} = ${JSON.stringify(val)}`;
      case 'ne': return `${field} ≠ ${JSON.stringify(val)}`;
      case 'gt': return `${field} > ${val}`;
      case 'lt': return `${field} < ${val}`;
      case 'gte': return `${field} ≥ ${val}`;
      case 'lte': return `${field} ≤ ${val}`;
      case 'in': return `${field} in ${JSON.stringify(val)}`;
      case 'is_null': return `${field} is empty`;
      case 'is_not_null': return `${field} is not empty`;
      default: return `${field} ${op} ${JSON.stringify(val)}`;
    }
  }

  return JSON.stringify(condition);
}
