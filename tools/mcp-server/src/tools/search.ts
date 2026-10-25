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
import { buildSearchParams } from '@civic-os/core';

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
          // Core's search builder (Q-05): wfts and/or substring (hybrid), display_name ILIKE as the MCP fallback.
          const rawQueryParams = buildSearchParams(query, {
            fulltextColumn: e.fulltext_search_column,
            substringColumns: e.substring_search_column ? [e.substring_search_column] : [],
            displayNameFallback: true,
          });

          try {
            const response = await client.data.getDataWindow({
              key: e.table_name,
              fields: ['id', 'display_name'],
              rawQueryParams,
              limit,
            });
            const records = response.data as unknown as Array<{ id: number | string; display_name: string }>;
            return {
              entity: e,
              records,
              // An unknown total falls back to the rows returned (Q-16).
              total: response.totalCount ?? records.length,
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
