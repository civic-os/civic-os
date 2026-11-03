/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SchemaClient } from '../client/schema-client.js';
import { EntityPropertyType } from '../model/entity.js';
import type { SchemaEntityProperty } from '../model/entity.js';
import type { FilterCriteria } from '../model/query.js';
import { getPropertyType } from '../schema/property-type.js';

const KEY_COLUMN = /^([A-Za-z_][A-Za-z0-9_]*)\.(status_key|category_key)$/;
const SINGLE_KEY_OPERATORS: ReadonlySet<string> = new Set(['eq', 'neq', 'not.eq']);
const KEY_LIST_OPERATORS: ReadonlySet<string> = new Set(['in', 'not.in']);

/**
 * Why a key filter could not be resolved:
 * - `not_status_or_category`: the column is not a property of the entity typed Status or Category, or
 *   the key kind does not match it. This is how the unsupported `status.status_key` form fails.
 * - `operator`: only `eq`, `neq`, `not.eq`, `in` and `not.in` are allowed.
 * - `invalid_value`: a single key needs a non-empty string, a list a non-empty array of them.
 * - `unknown_key`: the type has values but none with this key.
 * - `unavailable`: the type returned no values. A failed load resolves to an empty list, so an empty
 *   list cannot be told from a failure and is never reported as an unknown key.
 *
 * @consumer typed KeyFilterError
 */
export type KeyFilterReason = 'not_status_or_category' | 'operator' | 'invalid_value' | 'unknown_key' | 'unavailable';

/**
 * A dashboard widget filter that names a Status or Category by key and cannot be resolved to ids.
 *
 * @consumer app
 */
export class KeyFilterError extends Error {
  constructor(
    readonly reason: KeyFilterReason,
    readonly column: string,
    readonly entityType?: string,
    readonly key?: string,
  ) {
    super(`Key filter "${column}" failed: ${reason}${key === undefined ? '' : ` ("${key}")`}`);
    this.name = 'KeyFilterError';
  }
}

/**
 * The part of {@link SchemaClient} that {@link resolveKeyFilters} reads.
 *
 * @consumer typed resolveKeyFilters
 */
export type KeyFilterClient = Pick<SchemaClient, 'getStatuses' | 'getCategories' | 'invalidateStatuses' | 'invalidateCategories'>;

/**
 * True when a filter's column has the `<column>.status_key` or `<column>.category_key` form.
 *
 * @consumer app
 */
export function hasKeyFilters(filters: readonly FilterCriteria[] | undefined): boolean {
  return filters?.some((filter) => KEY_COLUMN.test(filter.column)) ?? false;
}

interface KeyLookup {
  filter: FilterCriteria;
  column: string;
  kind: 'status_key' | 'category_key';
  entityType: string;
  keys: readonly string[];
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * The status or category type behind a column, only when the property is that kind. Classifies with
 * `getPropertyType`, not `property.type`, because `SchemaClient.getProperties()` returns raw rows.
 */
function entityTypeOf(property: SchemaEntityProperty | undefined, kind: KeyLookup['kind']): string | undefined {
  if (!property) return undefined;
  const type = getPropertyType(property);
  if (kind === 'status_key') return type === EntityPropertyType.Status ? property.status_entity_type : undefined;
  return type === EntityPropertyType.Category ? property.category_entity_type : undefined;
}

/** Checks one filter without any request, so bad config costs no lookup. Returns undefined for a plain filter. */
function parseKeyFilter(filter: FilterCriteria, properties: readonly SchemaEntityProperty[]): KeyLookup | undefined {
  const match = KEY_COLUMN.exec(filter.column);
  if (!match) return undefined;
  const column = match[1] as string;
  const kind = match[2] as KeyLookup['kind'];
  const property = properties.find((candidate) => candidate.column_name === column);
  const entityType = entityTypeOf(property, kind);
  if (!entityType) throw new KeyFilterError('not_status_or_category', filter.column);

  const { operator, value } = filter;
  if (SINGLE_KEY_OPERATORS.has(operator)) {
    if (!isKey(value)) throw new KeyFilterError('invalid_value', filter.column, entityType);
    return { filter, column, kind, entityType, keys: [value] };
  }
  if (KEY_LIST_OPERATORS.has(operator)) {
    if (!Array.isArray(value) || value.length === 0 || !value.every(isKey)) {
      throw new KeyFilterError('invalid_value', filter.column, entityType);
    }
    return { filter, column, kind, entityType, keys: value };
  }
  throw new KeyFilterError('operator', filter.column, entityType);
}

/**
 * Replaces `<column>.status_key` and `<column>.category_key` filters with the real column and the ids
 * of the named values, read through the client's cache. Every other filter passes through as it is.
 *
 * Resolving rather than embedding keeps the query shape widgets already send: an embedded filter
 * without `!inner` returns every row with a null embed, and a mistyped key returns an empty list, both
 * with status 200. See `docs/notes/DASHBOARD_DESIGN.md`.
 *
 * An empty list for a type is thrown as `unavailable` after invalidating that type, so a failed load
 * is retried on the next call instead of staying cached.
 *
 * @param properties The properties of the filtered entity. The type comes from the property, so two
 *   status columns on one table resolve against their own types.
 * @throws KeyFilterError Before any lookup for a bad column, operator or value; after them for an
 *   unknown key or an empty list.
 *
 * @consumer app
 */
export async function resolveKeyFilters(
  filters: readonly FilterCriteria[] | undefined,
  properties: readonly SchemaEntityProperty[],
  client: KeyFilterClient,
): Promise<FilterCriteria[]> {
  if (!filters) return [];
  const lookups = filters.map((filter) => parseKeyFilter(filter, properties));
  const options = await Promise.all(
    lookups.map((lookup) => {
      if (!lookup) return undefined;
      return lookup.kind === 'status_key' ? client.getStatuses(lookup.entityType) : client.getCategories(lookup.entityType);
    }),
  );

  const unavailable = lookups.filter((lookup, index) => lookup && options[index]?.length === 0);
  for (const lookup of unavailable) {
    if (lookup?.kind === 'status_key') client.invalidateStatuses(lookup.entityType);
    else if (lookup) client.invalidateCategories(lookup.entityType);
  }
  const first = unavailable[0];
  if (first) throw new KeyFilterError('unavailable', first.filter.column, first.entityType);

  return filters.map((filter, index) => {
    const lookup = lookups[index];
    if (!lookup) return filter;
    const ids = lookup.keys.map((key) => {
      const option = options[index]?.find((candidate) =>
        (lookup.kind === 'status_key' ? (candidate as { status_key?: string }).status_key : (candidate as { category_key?: string }).category_key) === key,
      );
      if (!option) throw new KeyFilterError('unknown_key', filter.column, lookup.entityType, key);
      return option.id;
    });
    return { column: lookup.column, operator: filter.operator, value: KEY_LIST_OPERATORS.has(filter.operator) ? ids : ids[0] };
  });
}
