/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * describe_entity tool — "What fields does a Client have?"
 * Shows properties, types, relationships, and actions for an entity.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { PostgRESTClient } from '../postgrest-client.js';
import type { SchemaCache } from '../schema-cache.js';
import type { NameResolver } from '../name-resolver.js';
import { getTypeLabel } from '../formatters/value.js';

export function registerDescribeEntity(
  server: McpServer,
  client: PostgRESTClient,
  cache: SchemaCache,
  resolver: NameResolver,
  cacheKey?: string,
): void {
  server.registerTool(
    'describe_entity',
    {
      title: 'Describe Entity',
      description:
        'Show the structure of an entity: its properties (fields), their types, ' +
        'relationships to other entities, and available actions. ' +
        'Use display name or table name (e.g., "Clients" or "clients").',
      inputSchema: z.object({
        entity: z.string().describe('Entity display name or table name'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ entity }) => {
      await cache.ensureFreshForUser(client, cacheKey);

      const resolved = resolver.resolveEntity(entity);
      const properties = cache.getProperties(resolved.table_name);
      const actions = cache.getActionsForUser(cacheKey, resolved.table_name);

      const lines: string[] = [];

      // Header
      lines.push(`# ${resolved.display_name} (\`${resolved.table_name}\`)`);
      if (resolved.description) {
        lines.push('');
        lines.push(resolved.description);
      }
      lines.push('');

      // Permissions
      const perms = [
        resolved.select ? 'Read' : null,
        resolved.insert ? 'Create' : null,
        resolved.update ? 'Edit' : null,
        resolved.delete ? 'Delete' : null,
      ].filter(Boolean);
      lines.push(`**Permissions**: ${perms.join(', ')}`);
      lines.push('');

      // Properties table
      lines.push('## Properties');
      lines.push('');
      lines.push('| Property | Column | Type | List | Detail | Create | Edit |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- |');

      for (const prop of properties) {
        const typeLabel = getTypeLabel(prop);
        const flags = [
          prop.show_on_list !== false ? 'Y' : '',
          prop.show_on_detail !== false ? 'Y' : '',
          prop.show_on_create !== false ? 'Y' : '',
          prop.show_on_edit !== false ? 'Y' : '',
        ];
        lines.push(
          `| ${prop.display_name} | \`${prop.column_name}\` | ${typeLabel} | ${flags.join(' | ')} |`,
        );
      }
      lines.push('');

      // Status options (if any status properties exist)
      const statusProps = properties.filter(p => p.status_entity_type);
      for (const sp of statusProps) {
        const statuses = cache.getStatuses(sp.status_entity_type!);
        if (statuses.length > 0) {
          lines.push(`### Status: ${sp.display_name}`);
          lines.push('');
          lines.push(
            statuses
              .map(s => `- **${s.display_name}**${s.is_initial ? ' (initial)' : ''}${s.is_terminal ? ' (terminal)' : ''}`)
              .join('\n'),
          );
          lines.push('');
        }
      }

      // Category options
      const categoryProps = properties.filter(p => p.category_entity_type);
      for (const cp of categoryProps) {
        const categories = cache.getCategories(cp.category_entity_type!);
        if (categories.length > 0) {
          lines.push(`### Categories: ${cp.display_name}`);
          lines.push('');
          lines.push(categories.map(c => `- ${c.display_name}`).join('\n'));
          lines.push('');
        }
      }

      // Actions (prominent — guide LLM to prefer actions over direct edits)
      if (actions.length > 0) {
        lines.push('## Available Actions');
        lines.push('');
        lines.push(
          '> **Tip**: When you need to change status, approve, or trigger workflow logic, ' +
          'use `execute_action` instead of `update_record`. Actions embed business logic ' +
          '(validation, notifications, audit trails) that direct updates bypass.',
        );
        lines.push('');

        for (const action of actions) {
          let line = `- **${action.display_name}** (\`${action.action_name}\`)`;
          if (action.description) line += ` — ${action.description}`;
          if (!action.can_execute) line += ' *(no permission)*';
          if (action.parameters.length > 0) {
            const paramNames = action.parameters.map(
              p => `${p.display_name}${p.required ? '*' : ''}`,
            );
            line += `\n  Parameters: ${paramNames.join(', ')}`;
          }
          lines.push(line);
        }
        lines.push('');
      }

      // Features
      const features: string[] = [];
      if (resolved.enable_notes) features.push('Entity Notes (use `add_note` to add notes)');
      if (resolved.show_calendar) features.push(`Calendar (property: ${resolved.calendar_property_name})`);
      if (resolved.fulltext_search_column) features.push('Full-text search (use `search` tool)');
      if (resolved.show_map) features.push(`Map view (property: ${resolved.map_property_name})`);
      if (resolved.payment_initiation_rpc) features.push('Payment processing');

      if (features.length > 0) {
        lines.push('## Features');
        lines.push('');
        lines.push(features.map(f => `- ${f}`).join('\n'));
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
