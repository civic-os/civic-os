/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataQuery } from '../model/query.js';

/** Options for {@link compileDataQuery}. */
export interface CompileDataQueryOptions {
  /**
   * When true, also produce the PostgREST pagination headers (`Range-Unit`,
   * `Range`, `Prefer: count=exact`) from `query.pagination` (default page 1,
   * size 25). When false/omitted no headers are produced, even if
   * `query.pagination` is set (matches `DataService.getData`).
   */
  paginated?: boolean;
}

/** Result of {@link compileDataQuery}. */
export interface CompiledDataQuery {
  /** `query.key + '?' + params.join('&')` (a trailing `?` remains when there are no params). */
  path: string;
  /** Query parameters in request order; values are NOT encoded except the text search term. */
  params: string[];
  /** Extra request headers; empty unless `options.paginated`. */
  headers: Record<string, string>;
}

/**
 * Compiles a {@link DataQuery} to a PostgREST request path, parameter list and
 * headers. Pure: does not mutate `query`. When `select` applies and the query
 * is not a summary view, `id` is appended to the selected fields if missing.
 * Filter values are deliberately not URL-encoded (preserved from the original
 * string building).
 *
 * @consumer app
 */
export function compileDataQuery(query: DataQuery, options: CompileDataQueryOptions = {}): CompiledDataQuery {
  const args: string[] = [];
  if (query.fields) {
    const fields = !query.isSummaryView && !query.fields.includes('id')
      ? [...query.fields, 'id']
      : query.fields;
    args.push('select=' + fields.join(','));
  }
  if (query.searchQuery && query.searchQuery.trim()) {
    // Use wfts (websearch full-text search) for natural query syntax
    args.push('civic_os_text_search=wfts.' + encodeURIComponent(query.searchQuery.trim()));
    // When searching, order by relevance (no explicit order needed, PostgREST defaults to relevance)
  } else if (query.orderField) {
    args.push('order=' + query.orderField + '.' + (query.orderDirection ?? 'asc'));
  }
  if (query.entityId) {
    args.push('id=eq.' + query.entityId);
  }
  // Process filters
  if (query.filters && query.filters.length > 0) {
    query.filters.forEach(filter => {
      if (filter.value !== null && filter.value !== undefined && filter.value !== '') {
        // Handle 'in' operator with array values - PostgREST requires in.(val1,val2) format
        if (filter.operator === 'in' && Array.isArray(filter.value)) {
          args.push(`${filter.column}=in.(${filter.value.join(',')})`);
        } else {
          args.push(`${filter.column}=${filter.operator}.${filter.value}`);
        }
      }
    });
  }
  // Add limit if specified
  if (query.limit) {
    args.push(`limit=${query.limit}`);
  }
  // Append raw PostgREST query params (e.g., or=(...) clauses)
  if (query.rawQueryParams) {
    args.push(...query.rawQueryParams);
  }

  const headers: Record<string, string> = {};
  if (options.paginated) {
    const pagination = query.pagination || { page: 1, pageSize: 25 };
    const offset = (pagination.page - 1) * pagination.pageSize;
    const rangeEnd = offset + pagination.pageSize - 1;
    headers['Range-Unit'] = 'items';
    headers['Range'] = `${offset}-${rangeEnd}`;
    headers['Prefer'] = 'count=exact';
  }

  return { path: query.key + '?' + args.join('&'), params: args, headers };
}
