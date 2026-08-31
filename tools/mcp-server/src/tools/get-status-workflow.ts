/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * get_status_workflow tool — "What are the status options for a project?"
 * Shows status values, transitions, and workflow structure.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { SchemaCache } from '../schema-cache.js';
import type { NameResolver } from '../name-resolver.js';
import { EntityPropertyType } from '../interfaces.js';

export function registerGetStatusWorkflow(
  server: McpServer,
  cache: SchemaCache,
  resolver: NameResolver,
): void {
  server.registerTool(
    'get_status_workflow',
    {
      title: 'Get Status Workflow',
      description:
        'Show the status workflow for an entity: status values, allowed transitions, ' +
        'initial/terminal states. Useful for understanding what status changes are valid.',
      inputSchema: z.object({
        entity: z.string().describe('Entity display name or table name'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ entity }) => {
      await cache.ensureFresh();

      const resolved = resolver.resolveEntity(entity);
      const properties = cache.getProperties(resolved.table_name);

      // Find status properties
      const statusProps = properties.filter(p => p.type === EntityPropertyType.Status);

      if (statusProps.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `${resolved.display_name} does not have a status property.`,
          }],
        };
      }

      const lines: string[] = [];

      for (const statusProp of statusProps) {
        const entityType = statusProp.status_entity_type!;
        const statuses = cache.getStatuses(entityType);
        const transitions = cache.getTransitions(entityType);

        lines.push(`## ${statusProp.display_name} Workflow for ${resolved.display_name}`);
        lines.push('');

        if (statuses.length === 0) {
          lines.push('No statuses configured.');
          lines.push('');
          continue;
        }

        // Status values
        lines.push('### Statuses');
        lines.push('');
        for (const status of statuses) {
          let line = `- **${status.display_name}**`;
          if (status.color) line += ` (${status.color})`;
          if (status.is_initial) line += ' — *initial*';
          if (status.is_terminal) line += ' — *terminal*';
          if (status.status_key) line += ` [\`${status.status_key}\`]`;
          lines.push(line);
        }
        lines.push('');

        // Transitions
        if (transitions.length > 0) {
          lines.push('### Allowed Transitions');
          lines.push('');

          // Build transition map
          const statusById = new Map(statuses.map(s => [s.id, s]));

          for (const status of statuses) {
            const outgoing = transitions.filter(t => t.from_status_id === status.id);
            if (outgoing.length === 0) {
              if (status.is_terminal) {
                lines.push(`- **${status.display_name}** → *(terminal — no transitions out)*`);
              }
              continue;
            }
            const targets = outgoing
              .map(t => statusById.get(t.to_status_id)?.display_name ?? `#${t.to_status_id}`)
              .join(', ');
            lines.push(`- **${status.display_name}** → ${targets}`);
          }
          lines.push('');
        } else {
          lines.push('*No transition restrictions configured — any status change is allowed.*');
          lines.push('');
        }
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
