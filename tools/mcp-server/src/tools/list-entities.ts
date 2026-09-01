/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * list_entities tool — "What can I work with?"
 * Lists entities the user has access to, with permissions and feature flags.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { PostgRESTClient } from '../postgrest-client.js';
import type { SchemaCache } from '../schema-cache.js';

export function registerListEntities(
  server: McpServer,
  client: PostgRESTClient,
  cache: SchemaCache,
  cacheKey?: string,
): void {
  server.registerTool(
    'list_entities',
    {
      title: 'List Entities',
      description:
        'List all entities (data types) you have access to. ' +
        'Shows display names, descriptions, your permissions (create/read/update/delete), ' +
        'and available features (calendar, notes, search, etc.).',
      inputSchema: z.object({
        filter: z.string().optional().describe(
          'Optional substring to filter entities by display name',
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ filter }) => {
      await cache.ensureFreshForUser(client, cacheKey);

      let entities = cache.getEntitiesForUser(cacheKey).filter(e => e.select);

      if (filter) {
        const f = filter.toLowerCase();
        entities = entities.filter(
          e =>
            e.display_name.toLowerCase().includes(f) ||
            e.table_name.includes(f),
        );
      }

      if (entities.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: filter
              ? `No entities found matching "${filter}".`
              : 'No entities available. You may not have permission to view any entities.',
          }],
        };
      }

      const lines = entities.map(e => {
        const perms = [
          e.select ? 'read' : null,
          e.insert ? 'create' : null,
          e.update ? 'edit' : null,
          e.delete ? 'delete' : null,
        ].filter(Boolean).join(', ');

        const features: string[] = [];
        if (e.show_calendar) features.push('calendar');
        if (e.enable_notes) features.push('notes');
        if (e.fulltext_search_column) features.push('full-text search');
        if (e.show_map) features.push('map');
        if (e.payment_initiation_rpc) features.push('payments');
        if (e.supports_recurring) features.push('recurring');
        if (e.guided_form_key) features.push('guided form');

        let line = `- **${e.display_name}** (\`${e.table_name}\`)`;
        if (e.description) line += ` — ${e.description}`;
        line += `\n  Permissions: ${perms}`;
        if (features.length > 0) line += ` | Features: ${features.join(', ')}`;

        return line;
      });

      return {
        content: [{
          type: 'text' as const,
          text: `Found ${entities.length} entities:\n\n${lines.join('\n\n')}`,
        }],
      };
    },
  );
}
