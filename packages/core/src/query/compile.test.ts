/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { DataQuery } from '../model/query.js';
import { compileDataQuery } from './compile.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/**
 * Oracle: DataService.getData / getDataPaginated URL building as it was before
 * the compiler moved into core (including the in-place `fields.push('id')`).
 * Mutates the query exactly like the original did.
 */
function referenceUrl(query: DataQuery): string {
  const args: string[] = [];
  if (query.fields) {
    if (!query.isSummaryView && !query.fields.includes('id')) {
      query.fields.push('id');
    }
    args.push('select=' + query.fields.join(','));
  }
  if (query.searchQuery && query.searchQuery.trim()) {
    args.push('civic_os_text_search=wfts.' + encodeURIComponent(query.searchQuery.trim()));
  } else if (query.orderField) {
    args.push('order=' + query.orderField + '.' + (query.orderDirection ?? 'asc'));
  }
  if (query.entityId) {
    args.push('id=eq.' + query.entityId);
  }
  if (query.filters && query.filters.length > 0) {
    query.filters.forEach(filter => {
      if (filter.value !== null && filter.value !== undefined && filter.value !== '') {
        if (filter.operator === 'in' && Array.isArray(filter.value)) {
          args.push(`${filter.column}=in.(${filter.value.join(',')})`);
        } else {
          args.push(`${filter.column}=${filter.operator}.${filter.value}`);
        }
      }
    });
  }
  if (query.limit) {
    args.push(`limit=${query.limit}`);
  }
  if (query.rawQueryParams) {
    args.push(...query.rawQueryParams);
  }
  return query.key + '?' + args.join('&');
}

function referenceHeaders(query: DataQuery): Record<string, string> {
  const pagination = query.pagination || { page: 1, pageSize: 25 };
  const offset = (pagination.page - 1) * pagination.pageSize;
  const rangeEnd = offset + pagination.pageSize - 1;
  return { 'Range-Unit': 'items', 'Range': `${offset}-${rangeEnd}`, 'Prefer': 'count=exact' };
}

/** JSON deep clone: generated queries hold only strings, numbers, booleans, null and arrays; dropped undefined keys are treated identically by the compiler. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const text = fc.string({ maxLength: 12 });
const filterValue = fc.oneof(
  text, fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined), fc.constant(''),
  fc.array(fc.oneof(text, fc.integer()), { maxLength: 4 }),
);
const queryArb: fc.Arbitrary<DataQuery> = fc.record({
  key: fc.constantFrom('issues', 'public.things', ''),
  fields: fc.option(fc.array(fc.constantFrom('id', 'name', 'status_id(id,display_name)', 'x'), { maxLength: 4 }), { nil: undefined }),
  entityId: fc.option(fc.oneof(fc.constant(''), fc.constantFrom('7', 'abc')), { nil: undefined }),
  orderField: fc.option(fc.constantFrom('', 'created_at', 'owner(display_name)'), { nil: undefined }),
  orderDirection: fc.option(fc.constantFrom('asc', 'desc'), { nil: undefined }),
  searchQuery: fc.option(fc.oneof(fc.constant('  '), text), { nil: undefined }),
  filters: fc.option(
    fc.array(
      fc.record({ column: fc.constantFrom('a', 'b_id'), operator: fc.constantFrom('eq', 'in', 'ilike', 'gte'), value: filterValue }),
      { maxLength: 4 },
    ),
    { nil: undefined },
  ),
  rawQueryParams: fc.option(fc.array(text, { maxLength: 3 }), { nil: undefined }),
  pagination: fc.option(
    fc.record({ page: fc.integer({ min: 1, max: 50 }), pageSize: fc.integer({ min: 1, max: 200 }) }),
    { nil: undefined },
  ),
  limit: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
  isSummaryView: fc.option(fc.boolean(), { nil: undefined }),
}, { requiredKeys: ['key'] }) as fc.Arbitrary<DataQuery>;

describe('compileDataQuery', () => {
  it('orders params: select, order, id, filters, limit, raw', () => {
    const q = deepFreeze<DataQuery>({
      key: 'issues', fields: ['name'], orderField: 'created_at', orderDirection: 'desc', entityId: '5',
      filters: [{ column: 'a', operator: 'eq', value: 'x y' }, { column: 'b', operator: 'in', value: [1, 2] }],
      limit: 10, rawQueryParams: ['or=(a.eq.1,b.eq.2)'],
    });
    const r = compileDataQuery(q);
    expect(r.params).toEqual(['select=name,id', 'order=created_at.desc', 'id=eq.5', 'a=eq.x y', 'b=in.(1,2)', 'limit=10', 'or=(a.eq.1,b.eq.2)']);
    expect(r.path).toBe('issues?' + r.params.join('&'));
    expect(r.headers).toEqual({});
  });

  it('search term wins over order, is trimmed and encoded; direction defaults to asc', () => {
    expect(compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: undefined as never, searchQuery: ' a b&c ', orderField: 'x' })).params)
      .toEqual(['civic_os_text_search=wfts.a%20b%26c']);
    expect(compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: undefined as never, orderField: 'x' })).params).toEqual(['order=x.asc']);
  });

  it('keeps a trailing ? when there are no params', () => {
    expect(compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: undefined as never })).path).toBe('k?');
  });

  it('does not encode filter values and skips null, undefined and empty', () => {
    const r = compileDataQuery(deepFreeze<DataQuery>({
      key: 'k', fields: undefined as never,
      filters: [
        { column: 'a', operator: 'eq', value: 'x&y=z' }, { column: 'b', operator: 'eq', value: null },
        { column: 'c', operator: 'eq', value: undefined }, { column: 'd', operator: 'eq', value: '' },
        { column: 'e', operator: 'eq', value: 0 }, { column: 'f', operator: 'in', value: 'notarray' },
      ],
    }));
    expect(r.params).toEqual(['a=eq.x&y=z', 'e=eq.0', 'f=in.notarray']);
  });

  it('adds id to select unless summary view or already present, without mutating the input', () => {
    const base = { key: 'k', fields: ['name'] };
    expect(compileDataQuery(deepFreeze<DataQuery>({ ...base, fields: ['name'] })).params).toEqual(['select=name,id']);
    expect(compileDataQuery(deepFreeze<DataQuery>({ ...base, fields: ['name'], isSummaryView: true })).params).toEqual(['select=name']);
    expect(compileDataQuery(deepFreeze<DataQuery>({ ...base, fields: ['id', 'name'] })).params).toEqual(['select=id,name']);
    expect(compileDataQuery(deepFreeze<DataQuery>({ ...base, fields: [] })).params).toEqual(['select=id']);
  });

  it('paginated option produces Range headers with default page 1 / size 25', () => {
    const none = compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: undefined as never }), { paginated: true });
    expect(none.headers).toEqual({ 'Range-Unit': 'items', 'Range': '0-24', 'Prefer': 'count=exact' });
    const p3 = compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: undefined as never, pagination: { page: 3, pageSize: 10 } }), { paginated: true });
    expect(p3.headers['Range']).toBe('20-29');
    expect(Object.keys(p3.headers)).toEqual(['Range-Unit', 'Range', 'Prefer']);
  });

  it('plain compilation ignores pagination', () => {
    expect(compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: undefined as never, pagination: { page: 2, pageSize: 5 } })).headers).toEqual({});
  });

  it('matches the reference string building for random queries (property)', () => {
    fc.assert(fc.property(queryArb, (generated) => {
      const frozen = deepFreeze(clone(generated));
      const oracleInput = clone(generated);
      const expectedUrl = referenceUrl(oracleInput);
      const plain = compileDataQuery(frozen);
      const paged = compileDataQuery(frozen, { paginated: true });
      expect(plain.path).toBe(expectedUrl);
      expect(paged.path).toBe(expectedUrl);
      expect(plain.path).toBe(frozen.key + '?' + plain.params.join('&'));
      expect(plain.headers).toEqual({});
      expect(paged.headers).toEqual(referenceHeaders(generated));
      expect(Object.keys(paged.headers)).toEqual(['Range-Unit', 'Range', 'Prefer']);
    }), { numRuns: 500 });
  });
});
