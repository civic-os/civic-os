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
import { EntityPropertyType, QueryValidationError, buildOrderField, buildSearchParams, propsForList, type FilterCriteria } from '@civic-os/core';
import { entityColumnNames, selectFields } from '../select-fields.js';
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
          operator: z.preprocess(
            value => (typeof value === 'string' ? value.trim().toLowerCase() : value),
            z.enum(FILTER_OPERATOR_INPUTS),
          ).describe(
            `Filter operator: ${FILTER_OPERATOR_INPUTS.join(', ')}`,
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
      const displayProperties = columns
        ? columns.map(c => resolver.resolveColumn(resolved.table_name, c))
        : propsForList(resolved, allProperties);

      // Select fields: core's list select strings (S-06) for the displayed properties. Core appends `id`
      // when the entity has an id column (junction tables skip it), from `entityColumns` (Q-11, Q-03).
      const entityColumns = entityColumnNames(allProperties);
      const entityHasId = entityColumns.includes('id');
      // With nothing to select and no id, no `select` is sent at all (core sends none for undefined fields).
      const selected = selectFields(displayProperties, { list: true });
      const fields = (selected.length > 0 || entityHasId ? selected : undefined) as unknown as string[];

      const criteria: FilterCriteria[] = [];
      const rawQueryParams: string[] = [];

      // Apply filters.
      // Collect conditions first, then group by column to handle same-column
      // multi-condition filters (e.g., date ranges) via PostgREST `and=()` syntax.
      if (filters) {
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
            // FK name resolution (UUIDs pass through as IDs) — works for eq, neq, in, and other operators
            try {
              if (pgOperator === 'in' && Array.isArray(value)) {
                value = await Promise.all(
                  (value as Array<string | number>).map(v =>
                    typeof v === 'string' ? resolver.resolveForeignKeyFilterValue(prop.join_table!, v) : v,
                  ),
                );
              } else if (typeof value === 'string') {
                value = await resolver.resolveForeignKeyFilterValue(prop.join_table, value);
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

          // Core compiles the filter: encoding (F-01), quoted `in` items (F-13), empty values
          // dropped (Q-08) and several filters on one column combined with and= (Q-09).
          criteria.push({ column: prop.column_name, operator: pgOperator, value });
        }
      }

      // Search: core's builder (Q-05). A tsvector column and a substring column combine into a hybrid
      // or=(); with neither, display_name is matched with ILIKE (MCP policy, kept as an opt-in).
      if (search) {
        rawQueryParams.push(...buildSearchParams(search, {
          fulltextColumn: resolved.fulltext_search_column,
          substringColumns: resolved.substring_search_column ? [resolved.substring_search_column] : [],
          displayNameFallback: true,
        }));
      }

      // Sorting: a foreign-key column orders by the related display_name (Q-04). Without `sort`, core's default
      // order applies (Q-01: display_name then id, from the entity's columns), and the sort is kept while searching (Q-06).
      let orderField: string | undefined;
      let orderDirection: string | undefined;
      if (sort) {
        const descending = sort.startsWith('-');
        const sortProp = resolver.resolveColumn(resolved.table_name, descending ? sort.slice(1) : sort);
        orderField = buildOrderField(sortProp);
        orderDirection = descending ? 'desc' : 'asc';
      }

      try {
        // A Range window with an exact count (Q-02); limit and offset are validated by core (Q-10).
        const response = await client.data.getDataWindow({
          key: resolved.table_name,
          fields,
          entityColumns,
          filters: criteria,
          rawQueryParams,
          orderField,
          orderDirection,
          limit,
          offset,
        });

        const records = response.data;
        // An unknown total is omitted, not guessed (Q-16).
        const total = response.totalCount;

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
        if (err instanceof QueryValidationError) {
          return { content: [{ type: 'text' as const, text: err.message }], isError: true };
        }
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

/** Operators offered to MCP clients. Deliberately narrower than core's PostgREST grammar, and independent of it. */
const FILTER_OPERATOR_INPUTS = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is', 'ov',
  // Aliases that `mapOperator` translates.
  '=', 'equals', 'ne', '!=', 'not_equal', '>', 'greater_than', '>=', '<', 'less_than', '<=',
] as [string, ...string[]];

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
    case 'ov': return 'ov';
    default: return op;
  }
}
