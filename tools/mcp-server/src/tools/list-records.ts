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
import { NameResolutionError } from '../name-resolver.js';
import { EntityPropertyType } from '../interfaces.js';
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
      const allProperties = cache.getPropertiesForUser(cacheKey, resolved.table_name);

      // Determine which properties to display
      let displayProperties = columns
        ? columns.map(c => resolver.resolveColumn(resolved.table_name, c))
        : filterProperties(allProperties, 'list');

      // Build select string with FK embedding.
      // Include `id` when the entity has one — essential for LLM record references.
      // Junction tables (composite PK, no `id` column) skip this.
      const entityHasId = allProperties.some(p => p.column_name === 'id' || p.is_identity);
      let selectStr = buildSelectString(displayProperties);
      if (entityHasId && !displayProperties.some(p => p.column_name === 'id' || p.is_identity)) {
        selectStr = 'id,' + selectStr;
      }

      // Build query params
      const params: Record<string, string> = {
        select: selectStr,
      };

      // Apply filters.
      // Collect conditions first, then group by column to handle same-column
      // multi-condition filters (e.g., date ranges) via PostgREST `and=()` syntax.
      if (filters) {
        const filterConditions: Array<{ column: string; expression: string }> = [];

        for (const filter of filters) {
          const prop = resolver.resolveColumn(resolved.table_name, filter.field);
          const pgOperator = mapOperator(filter.operator);
          let value = filter.value;

          // Reject pattern-matching operators on reference columns (FK, Status, Category).
          // These store integer IDs — like/ilike would match against the raw ID, not the name.
          const isReferenceColumn = (prop.type === EntityPropertyType.Status && prop.status_entity_type)
            || (prop.type === EntityPropertyType.Category && prop.category_entity_type)
            || prop.join_table;
          if (isReferenceColumn && (pgOperator === 'like' || pgOperator === 'ilike')) {
            return {
              content: [{
                type: 'text' as const,
                text: `Cannot use ${pgOperator} on "${prop.display_name}" — it is a foreign key column that stores IDs, not text. ` +
                  `Use eq with the exact display name or use the search parameter for full-text search.`,
              }],
              isError: true,
            };
          }

          // Resolve display names to IDs for FK, Status, and Category columns.
          // Status/Category resolution errors are surfaced directly — the shared
          // statuses table means a raw string would cause a Postgres type error.
          if (prop.type === EntityPropertyType.Status && prop.status_entity_type) {
            try {
              if (pgOperator === 'in' && Array.isArray(value)) {
                value = (value as Array<string | number>).map(v =>
                  typeof v === 'string' ? resolver.resolveStatus(prop.status_entity_type!, v) : v,
                );
              } else if (typeof value === 'string') {
                value = resolver.resolveStatus(prop.status_entity_type, value);
              }
            } catch (err) {
              if (err instanceof NameResolutionError) {
                return {
                  content: [{ type: 'text' as const, text: err.message }],
                  isError: true,
                };
              }
              throw err;
            }
          } else if (prop.type === EntityPropertyType.Category && prop.category_entity_type) {
            try {
              if (pgOperator === 'in' && Array.isArray(value)) {
                value = (value as Array<string | number>).map(v =>
                  typeof v === 'string' ? resolver.resolveCategory(prop.category_entity_type!, v) : v,
                );
              } else if (typeof value === 'string') {
                value = resolver.resolveCategory(prop.category_entity_type, value);
              }
            } catch (err) {
              if (err instanceof NameResolutionError) {
                return {
                  content: [{ type: 'text' as const, text: err.message }],
                  isError: true,
                };
              }
              throw err;
            }
          } else if (prop.join_table) {
            // FK name resolution — works for eq, neq, in, and other operators
            try {
              if (pgOperator === 'in' && Array.isArray(value)) {
                value = await Promise.all(
                  (value as Array<string | number>).map(v =>
                    typeof v === 'string' ? resolver.resolveForeignKeyValue(prop.join_table!, v) : v,
                  ),
                );
              } else if (typeof value === 'string') {
                value = await resolver.resolveForeignKeyValue(prop.join_table, value);
              }
            } catch (err) {
              if (err instanceof NameResolutionError) {
                return {
                  content: [{ type: 'text' as const, text: err.message }],
                  isError: true,
                };
              }
              throw err;
            }
          }

          // Format condition expression for PostgREST
          if (pgOperator === 'in' && Array.isArray(value)) {
            filterConditions.push({
              column: prop.column_name,
              expression: `in.(${(value as Array<string | number>).join(',')})`,
            });
          } else if (pgOperator === 'is') {
            filterConditions.push({ column: prop.column_name, expression: `is.${value}` });
          } else {
            filterConditions.push({ column: prop.column_name, expression: `${pgOperator}.${value}` });
          }
        }

        // Group by column — single-condition columns go as direct params,
        // multi-condition columns (date ranges, numeric ranges) use PostgREST `and=()`.
        const byColumn = new Map<string, string[]>();
        for (const { column, expression } of filterConditions) {
          const existing = byColumn.get(column) ?? [];
          existing.push(expression);
          byColumn.set(column, existing);
        }

        const andClauses: string[] = [];
        for (const [column, expressions] of byColumn) {
          if (expressions.length === 1) {
            params[column] = expressions[0];
          } else {
            // Multiple conditions on same column → combine via PostgREST `and`
            for (const expr of expressions) {
              andClauses.push(`${column}.${expr}`);
            }
          }
        }
        if (andClauses.length > 0) {
          params['and'] = `(${andClauses.join(',')})`;
        }
      }

      // Apply full-text search.
      // Civic OS tsvectors use the 'simple' config — specify it explicitly
      // to avoid stemming mismatches with PostgREST's default ('english').
      if (search && resolved.fulltext_search_column) {
        params[resolved.fulltext_search_column] = `wfts(simple).${search}`;
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
        // Default sort: display_name if it exists, then id, then first available column
        const hasDisplayName = allProperties.some(p => p.column_name === 'display_name');
        if (hasDisplayName) {
          params['order'] = 'display_name.asc';
        } else {
          const hasId = allProperties.some(p => p.column_name === 'id' || p.is_identity === true);
          if (hasId) {
            params['order'] = 'id.asc';
          } else {
            const firstProp = allProperties[0];
            if (firstProp) {
              params['order'] = `${firstProp.column_name}.asc`;
            }
            // If no properties at all, skip sorting entirely
          }
        }
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

        const records = response.data ?? [];
        const total = response.contentRange?.total;

        // Build output — skip ID column for entities without one (junction tables)
        const table = renderMarkdownTable(records, displayProperties, { includeId: entityHasId });

        let summary = `**${resolved.display_name}**`;
        if (total !== null && total !== undefined) {
          summary += ` — ${total} total record${total !== 1 ? 's' : ''}`;
        }
        if (offset > 0 && records.length > 0) {
          summary += ` (showing ${offset + 1}–${offset + records.length})`;
        } else if (offset > 0 && records.length === 0) {
          summary += ` (offset ${offset} is beyond the last record)`;
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
          // 416 Range Not Satisfiable — offset exceeds total record count
          if (err.httpCode === 416) {
            return {
              content: [{
                type: 'text' as const,
                text: `**${resolved.display_name}** — offset ${offset} is beyond the last record. Try a smaller offset or omit it to start from the beginning.`,
              }],
            };
          }
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
