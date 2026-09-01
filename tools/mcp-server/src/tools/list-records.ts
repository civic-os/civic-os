/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * list_records tool — "Show me active clients"
 * Query, filter, search, and paginate entity records.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { PostgRESTClient } from '../postgrest-client.js';
import { PostgRESTRequestError } from '../postgrest-client.js';
import type { SchemaCache } from '../schema-cache.js';
import type { NameResolver } from '../name-resolver.js';
import { buildSelectString, filterProperties } from '../select-builder.js';
import { renderMarkdownTable } from '../formatters/markdown-table.js';

export function registerListRecords(
  server: McpServer,
  client: PostgRESTClient,
  cache: SchemaCache,
  resolver: NameResolver,
  cacheKey?: string,
): void {
  server.registerTool(
    'list_records',
    {
      title: 'List Records',
      description:
        'List records from an entity with optional filters, search, sorting, and pagination. ' +
        'Foreign key columns are automatically resolved to display names. ' +
        'Use the `filters` parameter to narrow results (e.g., status = "Active").',
      inputSchema: z.object({
        entity: z.string().describe('Entity display name or table name'),
        filters: z.array(z.object({
          field: z.string().describe('Column display name or column name'),
          operator: z.string().describe(
            'Filter operator: eq, neq, gt, gte, lt, lte, like, ilike, in, is',
          ),
          value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))])
            .describe('Value to filter by. For FK fields, use display name. For "in" operator, use array. For "is" operator, use null.'),
        })).optional().describe('Array of filter conditions'),
        search: z.string().optional().describe(
          'Full-text search query (requires entity to have fulltext_search_column configured)',
        ),
        sort: z.string().optional().describe(
          'Column to sort by (display name or column name). Prefix with "-" for descending.',
        ),
        limit: z.number().int().min(1).max(100).optional().describe(
          'Maximum records to return (default 25, max 100)',
        ),
        offset: z.number().int().min(0).optional().describe(
          'Number of records to skip (for pagination)',
        ),
        columns: z.array(z.string()).optional().describe(
          'Specific columns to include (display names or column names). Defaults to list-view columns.',
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ entity, filters, search, sort, limit = 25, offset = 0, columns }) => {
      await cache.ensureFreshForUser(client, cacheKey);

      const resolved = resolver.resolveEntity(entity);
      const allProperties = cache.getProperties(resolved.table_name);

      // Determine which properties to display
      let displayProperties = columns
        ? columns.map(c => resolver.resolveColumn(resolved.table_name, c))
        : filterProperties(allProperties, 'list');

      // Build select string with FK embedding
      const selectStr = buildSelectString(displayProperties);

      // Build query params
      const params: Record<string, string> = {
        select: selectStr,
      };

      // Apply filters
      if (filters) {
        for (const filter of filters) {
          const prop = resolver.resolveColumn(resolved.table_name, filter.field);
          const pgOperator = mapOperator(filter.operator);
          let value = filter.value;

          // Resolve FK display names to IDs
          if (typeof value === 'string' && prop.join_table && pgOperator === 'eq') {
            try {
              value = await resolver.resolveForeignKeyValue(prop.join_table, value as string);
            } catch {
              // If FK resolution fails, use the raw value — PostgREST will handle it
            }
          }

          // Format value for PostgREST
          if (pgOperator === 'in' && Array.isArray(value)) {
            params[prop.column_name] = `in.(${(value as Array<string | number>).join(',')})`;
          } else if (pgOperator === 'is') {
            params[prop.column_name] = `is.${value}`;
          } else {
            params[prop.column_name] = `${pgOperator}.${value}`;
          }
        }
      }

      // Apply full-text search
      if (search && resolved.fulltext_search_column) {
        params[resolved.fulltext_search_column] = `wfts.${search}`;
      } else if (search && resolved.substring_search_column) {
        params[resolved.substring_search_column] = `ilike.*${search}*`;
      } else if (search) {
        // No search column configured — try display_name ILIKE as fallback
        params['display_name'] = `ilike.*${search}*`;
      }

      // Apply sorting
      if (sort) {
        const descending = sort.startsWith('-');
        const sortField = descending ? sort.slice(1) : sort;
        const sortProp = resolver.resolveColumn(resolved.table_name, sortField);
        params['order'] = `${sortProp.column_name}.${descending ? 'desc' : 'asc'}`;
      } else {
        // Default sort: display_name if it exists, otherwise id
        const hasDisplayName = allProperties.some(p => p.column_name === 'display_name');
        params['order'] = hasDisplayName ? 'display_name.asc' : 'id.asc';
      }

      // Pagination headers
      const rangeEnd = offset + limit - 1;
      const headers: Record<string, string> = {
        'Range-Unit': 'items',
        'Range': `${offset}-${rangeEnd}`,
        'Prefer': 'count=exact',
      };

      try {
        const response = await client.get<Record<string, unknown>[]>(
          resolved.table_name,
          params,
          headers,
        );

        const records = response.data;
        const total = response.contentRange?.total;

        // Build output
        const table = renderMarkdownTable(records, displayProperties);

        let summary = `**${resolved.display_name}**`;
        if (total !== null && total !== undefined) {
          summary += ` — ${total} total record${total !== 1 ? 's' : ''}`;
        }
        if (offset > 0) {
          summary += ` (showing ${offset + 1}–${offset + records.length})`;
        } else if (records.length < (total ?? Infinity)) {
          summary += ` (showing first ${records.length})`;
        }

        return {
          content: [{
            type: 'text' as const,
            text: `${summary}\n\n${table}`,
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

/** Map user-friendly operator names to PostgREST operators */
function mapOperator(op: string): string {
  switch (op.toLowerCase()) {
    case 'eq':
    case '=':
    case 'equals': return 'eq';
    case 'neq':
    case 'ne':
    case '!=':
    case 'not_equal': return 'neq';
    case 'gt':
    case '>':
    case 'greater_than': return 'gt';
    case 'gte':
    case '>=': return 'gte';
    case 'lt':
    case '<':
    case 'less_than': return 'lt';
    case 'lte':
    case '<=': return 'lte';
    case 'like': return 'like';
    case 'ilike': return 'ilike';
    case 'in': return 'in';
    case 'is': return 'is';
    default: return op;
  }
}
