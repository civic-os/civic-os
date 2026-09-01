/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * search tool — "Find clients mentioning 'budget'"
 * Cross-entity or single-entity full-text search.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { PostgRESTClient } from '../postgrest-client.js';
import { PostgRESTRequestError } from '../postgrest-client.js';
import type { SchemaCache } from '../schema-cache.js';
import type { NameResolver } from '../name-resolver.js';

export function registerSearch(
  server: McpServer,
  client: PostgRESTClient,
  cache: SchemaCache,
  resolver: NameResolver,
  cacheKey?: string,
): void {
  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'Full-text search across one or all entities. When no entity is specified, ' +
        'searches all entities that have full-text search configured. ' +
        'Returns grouped results by entity with display names.',
      inputSchema: z.object({
        query: z.string().describe('Search query text'),
        entity: z.string().optional().describe(
          'Optional: limit search to a specific entity (display name or table name)',
        ),
        limit: z.number().int().min(1).max(20).optional().describe(
          'Maximum results per entity (default 5)',
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, entity, limit = 5 }) => {
      await cache.ensureFreshForUser(client, cacheKey);

      // Determine which entities to search
      let searchableEntities = cache.getEntitiesForUser(cacheKey).filter(
        e => e.select && (e.fulltext_search_column || e.substring_search_column),
      );

      if (entity) {
        const resolved = resolver.resolveEntity(entity);
        searchableEntities = searchableEntities.filter(
          e => e.table_name === resolved.table_name,
        );
        if (searchableEntities.length === 0) {
          // Entity exists but has no search column — try substring search on display_name
          searchableEntities = [resolved as typeof searchableEntities[0]];
        }
      }

      if (searchableEntities.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No searchable entities found. Entities need fulltext_search_column or substring_search_column configured.',
          }],
        };
      }

      // Search each entity in parallel
      const results = await Promise.allSettled(
        searchableEntities.map(async e => {
          const params: Record<string, string> = {
            select: 'id,display_name',
            limit: String(limit),
          };

          // Use FTS if available, otherwise fall back to ILIKE
          if (e.fulltext_search_column) {
            params[e.fulltext_search_column] = `wfts.${query}`;
          } else if (e.substring_search_column) {
            params[e.substring_search_column] = `ilike.*${query}*`;
          } else {
            params['display_name'] = `ilike.*${query}*`;
          }

          try {
            const response = await client.get<Array<{ id: number | string; display_name: string }>>(
              e.table_name,
              params,
              { Prefer: 'count=exact', 'Range-Unit': 'items', Range: `0-${limit - 1}` },
            );
            return {
              entity: e,
              records: response.data,
              total: response.contentRange?.total ?? response.data.length,
            };
          } catch (err) {
            if (err instanceof PostgRESTRequestError && err.httpCode === 404) {
              return { entity: e, records: [], total: 0 };
            }
            throw err;
          }
        }),
      );

      // Build output
      const lines: string[] = [];
      lines.push(`## Search results for "${query}"`);
      lines.push('');

      let totalFound = 0;

      for (const result of results) {
        if (result.status === 'rejected') continue;
        const { entity: e, records, total } = result.value;
        if (records.length === 0) continue;

        totalFound += total;

        lines.push(`### ${e.display_name} (${total} result${total !== 1 ? 's' : ''})`);
        for (const record of records) {
          lines.push(`- ${record.display_name ?? `#${record.id}`} (ID: ${record.id})`);
        }
        if (total > records.length) {
          lines.push(`  _...and ${total - records.length} more_`);
        }
        lines.push('');
      }

      if (totalFound === 0) {
        lines.push(`No results found for "${query}".`);
      } else {
        lines.unshift(`Found ${totalFound} total result${totalFound !== 1 ? 's' : ''} across entities.\n`);
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
