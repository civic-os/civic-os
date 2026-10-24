/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataQuery, FilterCriteria } from '../model/query.js';
import { encodeQueryValue, QueryValidationError, quoteListItem, quoteLogicValue } from './encode.js';
import { buildSearchParams } from './search.js';

export { QueryValidationError };

/** Options for {@link compileDataQuery}. */
export interface CompileDataQueryOptions {
  /**
   * When true, also produce the PostgREST pagination headers (`Range-Unit`,
   * `Range`, `Prefer: count=exact`) from `query.pagination` (default page 1,
   * size 25). When false/omitted no headers are produced, even if
   * `query.pagination` is set (matches `DataService.getData`).
   */
  paginated?: boolean;
  /**
   * When true (and not `paginated`), send `query.limit` / `query.offset` as a
   * `Range` window (`Range-Unit`, `Range`; default limit 25, offset 0) instead
   * of the `limit=` / `offset=` parameters. `Prefer: count=exact` only when
   * `query.count` is set. This is the MCP transport policy (Q-02).
   */
  useRange?: boolean;
  /**
   * Largest accepted `limit` and `pageSize`. Consumer policy, not a core
   * constant (Q-10): the MCP uses 100, the app 1000. Unset means no maximum.
   */
  maxLimit?: number;
}

/** Result of {@link compileDataQuery}. */
export interface CompiledDataQuery {
  /** `query.key + '?' + params.join('&')` (a trailing `?` remains when there are no params). */
  path: string;
  /** Query parameters in request order; filter values and the entity id are URL-encoded, the search term is encoded as before. */
  params: string[];
  /** Extra request headers; empty unless `options.paginated`, `options.useRange` or `query.count`. */
  headers: Record<string, string>;
}

function requireInteger(name: string, value: unknown, min: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new QueryValidationError(`${name} must be an integer >= ${min}, got ${String(value)}`);
  }
  if (max !== undefined && value > max) {
    throw new QueryValidationError(`${name} must be <= ${max}, got ${value}`);
  }
  return value;
}

/** `op.value` for a filter, or null when it is dropped (empty string, undefined, or a null the operator cannot express). */
function filterExpression(filter: FilterCriteria, quoteScalar: (value: unknown) => string): string | null {
  const { operator, value } = filter;
  if (value === undefined || value === '') return null;
  if (value === null) {
    // Q-08: null is a real IS NULL test; an operator with no null meaning drops the filter.
    if (operator === 'eq' || operator === 'is') return 'is.null';
    if (operator === 'neq') return 'not.is.null';
    return null;
  }
  // PostgREST requires in.(val1,val2); items with reserved characters are quoted, empty items dropped (F-13).
  if (operator === 'in' && Array.isArray(value)) {
    const items = value
      .filter(item => item !== null && item !== undefined && item !== '')
      .map(item => encodeQueryValue(quoteListItem(item)));
    return `in.(${items.join(',')})`;
  }
  return `${operator}.${encodeQueryValue(quoteScalar(value))}`;
}

/** Plain selected column names (aliases and embeds are not orderable by name). */
function plainColumns(fields: readonly string[]): Set<string> {
  return new Set(fields.filter(field => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field)));
}

/**
 * Default order when the caller gave none (Q-01): `display_name`, with an
 * `id` tie-breaker so pages are stable; else `id`; else none. With
 * `entityColumns` the entity's own columns decide (ordering by an unselected
 * column is valid PostgREST); without it only the selected plain columns, or
 * the id proxy, are considered.
 */
function defaultOrder(
  fields: readonly string[] | undefined,
  hasId: boolean,
  entityColumns: readonly string[] | undefined,
): string | undefined {
  let columns: Set<string>;
  let idAvailable: boolean;
  if (entityColumns) {
    columns = new Set(entityColumns);
    idAvailable = columns.has('id');
  } else {
    if (!fields) return undefined;
    columns = plainColumns(fields);
    idAvailable = hasId || columns.has('id');
  }
  if (columns.has('display_name')) {
    return idAvailable ? 'display_name.asc,id.asc' : 'display_name.asc';
  }
  return idAvailable ? 'id.asc' : undefined;
}

/**
 * Compiles a {@link DataQuery} to a PostgREST request path, parameter list and
 * headers. Pure: does not mutate `query`. When `select` applies, `id` is
 * appended to the selected fields if missing and the entity has an id column
 * (`query.entityColumns` includes `id`; without it, not a summary view).
 *
 * Filter values and `entityId` are URL-encoded (F-01); reserved characters in
 * `in.()` items are double-quoted (F-13); several filters on one column become
 * one `and=(col.op.a,col.op.b)` parameter (Q-09). With no explicit order the
 * rows are ordered by `display_name` then `id` (Q-01), also while searching
 * (Q-06). `limit`, `offset` and `pagination` are validated and throw
 * {@link QueryValidationError} (F-02, Q-10).
 *
 * @consumer app
 */
export function compileDataQuery(query: DataQuery, options: CompileDataQueryOptions = {}): CompiledDataQuery {
  const args: string[] = [];
  const idWanted = query.entityColumns ? query.entityColumns.includes('id') : !query.isSummaryView;
  let fields: readonly string[] | undefined;
  if (query.fields) {
    fields = idWanted && !query.fields.includes('id') ? [...query.fields, 'id'] : query.fields;
    args.push('select=' + fields.join(','));
  }
  if (query.searchQuery && query.searchQuery.trim()) {
    // wfts (websearch full-text search) on the generic civic_os_text_search column; one builder with the hybrid search (Q-05).
    args.push(...buildSearchParams(query.searchQuery, {
      fulltextColumn: 'civic_os_text_search',
      textSearchConfig: query.textSearchConfig,
      stripReserved: false,
    }));
  }
  // The sort is kept while searching: wfts does not rank, so there is no relevance order to preserve (Q-06).
  if (query.orderField) {
    args.push('order=' + query.orderField + '.' + (query.orderDirection ?? 'asc'));
  } else {
    const order = defaultOrder(fields, idWanted, query.entityColumns);
    if (order) args.push('order=' + order);
  }
  if (query.entityId) {
    args.push('id=eq.' + encodeQueryValue(query.entityId));
  }
  // Process filters
  if (query.filters && query.filters.length > 0) {
    const conditions: Array<{ column: string; param: string; logic: string }> = [];
    for (const filter of query.filters) {
      const param = filterExpression(filter, String);
      const logic = filterExpression(filter, quoteLogicValue);
      if (param !== null && logic !== null) conditions.push({ column: filter.column, param, logic });
    }
    const perColumn = new Map<string, number>();
    for (const { column } of conditions) perColumn.set(column, (perColumn.get(column) ?? 0) + 1);
    const grouped: string[] = [];
    for (const { column, param, logic } of conditions) {
      if (perColumn.get(column) === 1) args.push(`${column}=${param}`);
      else grouped.push(`${column}.${logic}`);
    }
    if (grouped.length > 0) args.push(`and=(${grouped.join(',')})`);
  }

  const headers: Record<string, string> = {};
  const limit = query.limit === undefined || query.limit === null ? undefined : requireInteger('limit', query.limit, 1, options.maxLimit);
  const offset = query.offset === undefined || query.offset === null ? undefined : requireInteger('offset', query.offset, 0);
  if (options.paginated) {
    const pagination = query.pagination || { page: 1, pageSize: 25 };
    const page = requireInteger('page', pagination.page, 1);
    const pageSize = requireInteger('pageSize', pagination.pageSize, 1, options.maxLimit);
    const start = (page - 1) * pageSize;
    headers['Range-Unit'] = 'items';
    headers['Range'] = `${start}-${start + pageSize - 1}`;
    headers['Prefer'] = 'count=exact';
    if (limit !== undefined) args.push(`limit=${limit}`);
  } else if (options.useRange) {
    const size = limit ?? 25;
    const start = offset ?? 0;
    headers['Range-Unit'] = 'items';
    headers['Range'] = `${start}-${start + size - 1}`;
    if (query.count) headers['Prefer'] = 'count=exact';
  } else {
    if (limit !== undefined) args.push(`limit=${limit}`);
    if (offset) args.push(`offset=${offset}`);
    if (query.count) headers['Prefer'] = 'count=exact';
  }
  // Append raw PostgREST query params (e.g., or=(...) clauses)
  if (query.rawQueryParams) {
    args.push(...query.rawQueryParams);
  }

  return { path: query.key + '?' + args.join('&'), params: args, headers };
}
