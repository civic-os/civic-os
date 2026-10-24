/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { DataQuery } from '../model/query.js';
import { compileDataQuery, QueryValidationError } from './compile.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Decodes the compiled query string the way PostgREST (an HTTP server) does. */
function decode(params: string[]): Array<[string, string]> {
  // application/x-www-form-urlencoded: '+' is a space, %XX is a byte (same as URLSearchParams, which core's lib set lacks).
  return params.join('&').split('&').filter(Boolean).map(pair => {
    const eq = pair.indexOf('=');
    const raw = (text: string) => decodeURIComponent(text.replace(/\+/g, ' '));
    return eq < 0 ? [raw(pair), ''] : [raw(pair.slice(0, eq)), raw(pair.slice(eq + 1))];
  });
}

const NO_FIELDS = undefined as never;

describe('compileDataQuery', () => {
  it('orders params: select, order, id, filters, limit, raw', () => {
    const q = deepFreeze<DataQuery>({
      key: 'issues', fields: ['name'], orderField: 'created_at', orderDirection: 'desc', entityId: '5',
      filters: [{ column: 'a', operator: 'eq', value: 'x y' }, { column: 'b', operator: 'in', value: [1, 2] }],
      limit: 10, rawQueryParams: ['or=(a.eq.1,b.eq.2)'],
    });
    const r = compileDataQuery(q);
    expect(r.params).toEqual(['select=name,id', 'order=created_at.desc', 'id=eq.5', 'a=eq.x%20y', 'b=in.(1,2)', 'limit=10', 'or=(a.eq.1,b.eq.2)']);
    expect(r.path).toBe('issues?' + r.params.join('&'));
    expect(r.headers).toEqual({});
  });

  it('search term is trimmed and encoded; direction defaults to asc', () => {
    expect(compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, searchQuery: ' a b&c ' })).params)
      .toEqual(['civic_os_text_search=wfts.a%20b%26c']);
    expect(compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, orderField: 'x' })).params).toEqual(['order=x.asc']);
  });

  it('keeps a trailing ? when there are no params', () => {
    expect(compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS })).path).toBe('k?');
  });

  it('adds id to select unless summary view or already present, without mutating the input', () => {
    const base = { key: 'k', fields: ['name'] };
    expect(compileDataQuery(deepFreeze<DataQuery>({ ...base, fields: ['name'] })).params[0]).toBe('select=name,id');
    expect(compileDataQuery(deepFreeze<DataQuery>({ ...base, fields: ['name'], isSummaryView: true })).params).toEqual(['select=name']);
    expect(compileDataQuery(deepFreeze<DataQuery>({ ...base, fields: ['id', 'name'] })).params[0]).toBe('select=id,name');
    expect(compileDataQuery(deepFreeze<DataQuery>({ ...base, fields: [] })).params[0]).toBe('select=id');
  });

  it('paginated option produces Range headers with default page 1 / size 25', () => {
    const none = compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS }), { paginated: true });
    expect(none.headers).toEqual({ 'Range-Unit': 'items', 'Range': '0-24', 'Prefer': 'count=exact' });
    const p3 = compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, pagination: { page: 3, pageSize: 10 } }), { paginated: true });
    expect(p3.headers['Range']).toBe('20-29');
    expect(Object.keys(p3.headers)).toEqual(['Range-Unit', 'Range', 'Prefer']);
  });

  it('plain compilation ignores pagination', () => {
    expect(compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, pagination: { page: 2, pageSize: 5 } })).headers).toEqual({});
    // ... including an invalid one: it is never used, so it is never validated.
    expect(compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, pagination: { page: 0, pageSize: 1 } })).headers).toEqual({});
  });
});

describe('F-01: filter values and entityId are URL-encoded', () => {
  const eq = (value: unknown) => compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, filters: [{ column: 'name', operator: 'eq', value }] })).params;

  it('F-01: encodes every reserved or unsafe character in a filter value and decodes back intact', () => {
    const cases: Array<[string, string]> = [
      ['a+b', 'a%2Bb'],
      ['a,b', 'a%2Cb'],
      ['a(b)', 'a(b)'],
      ['a"b', 'a%22b'],
      ['a:b', 'a%3Ab'],
      ['a.b', 'a.b'],
      ['100%', '100%25'],
      ['50%25', '50%2525'],
      ['a&b', 'a%26b'],
      ['a#b', 'a%23b'],
      ['a=b', 'a%3Db'],
      ['a?b', 'a%3Fb'],
      ['a b', 'a%20b'],
      [' lead', '%20lead'],
      ['ñandú', '%C3%B1and%C3%BA'],
      ['日本語', '%E6%97%A5%E6%9C%AC%E8%AA%9E'],
      ['2026-07-04T10:30:00+05:30', '2026-07-04T10%3A30%3A00%2B05%3A30'],
    ];
    for (const [raw, encoded] of cases) {
      expect(eq(raw), raw).toEqual([`name=eq.${encoded}`]);
      expect(decode(eq(raw)), raw).toEqual([['name', `eq.${raw}`]]);
    }
  });

  it('F-01: encodes numbers and booleans through the same function, and the operator stays literal', () => {
    expect(eq(5)).toEqual(['name=eq.5']);
    expect(eq(true)).toEqual(['name=eq.true']);
    const ov = compileDataQuery(deepFreeze<DataQuery>({
      key: 'k', fields: NO_FIELDS,
      filters: [{ column: 'during', operator: 'ov', value: '[2026-06-28T00:00:00.000Z,2026-08-09T00:00:00.000Z)' }],
    })).params;
    expect(decode(ov)).toEqual([['during', 'ov.[2026-06-28T00:00:00.000Z,2026-08-09T00:00:00.000Z)']]);
  });

  it('F-01: encodes entityId', () => {
    const r = compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, entityId: 'a&b=c' }));
    expect(r.params).toEqual(['id=eq.a%26b%3Dc']);
    expect(decode(r.params)).toEqual([['id', 'eq.a&b=c']]);
    // A uuid has nothing to encode.
    expect(compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, entityId: '44444444-4444-4444-8444-444444444444' })).params)
      .toEqual(['id=eq.44444444-4444-4444-8444-444444444444']);
  });

  it('F-01: any string survives the round trip through a PostgREST-style decoder (property)', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary-ascii', maxLength: 20 }), fc.string({ maxLength: 20 }), (a, b) => {
      for (const value of [a, b].filter(v => v !== '')) {
        expect(decode(eq(value))).toEqual([['name', `eq.${value}`]]);
        expect(decode(compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, entityId: value })).params)).toEqual([['id', `eq.${value}`]]);
      }
    }), { numRuns: 300 });
  });
});

describe('F-02 and Q-10: page, pageSize, limit and offset are validated', () => {
  const paged = (page: number, pageSize: number) =>
    compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, pagination: { page, pageSize } }), { paginated: true });

  it('F-02: page and pageSize must be integers >= 1', () => {
    for (const [page, pageSize] of [[0, 25], [-1, 25], [1, 0], [2.5, 10], [1, 2.5], [NaN, 10], [1, -5]] as const) {
      expect(() => paged(page, pageSize), `${page}/${pageSize}`).toThrow(QueryValidationError);
    }
    expect(paged(1, 1).headers['Range']).toBe('0-0');
    expect(paged(10, 7).headers['Range']).toBe('63-69');
  });

  it('Q-10: limit must be an integer >= 1, offset an integer >= 0', () => {
    const compile = (extra: Partial<DataQuery>, options = {}) => compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, ...extra }), options);
    expect(() => compile({ limit: 0 })).toThrow(QueryValidationError);
    expect(() => compile({ limit: -1 })).toThrow(QueryValidationError);
    expect(() => compile({ limit: 1.5 })).toThrow(QueryValidationError);
    expect(() => compile({ offset: -1 })).toThrow(QueryValidationError);
    expect(() => compile({ offset: 0.5 })).toThrow(QueryValidationError);
    expect(compile({ limit: 1, offset: 0 }).params).toEqual(['limit=1']);
    expect(compile({ limit: 5, offset: 10 }).params).toEqual(['limit=5', 'offset=10']);
    expect(compile({}).params).toEqual([]);
  });

  it('Q-10: the maximum is an option, not a constant', () => {
    const compile = (extra: Partial<DataQuery>, options: object) => compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, ...extra }), options);
    expect(compile({ limit: 5000 }, {}).params).toEqual(['limit=5000']);
    expect(() => compile({ limit: 101 }, { maxLimit: 100 })).toThrow(QueryValidationError);
    expect(compile({ limit: 100 }, { maxLimit: 100 }).params).toEqual(['limit=100']);
    expect(() => compile({ pagination: { page: 1, pageSize: 1001 } }, { paginated: true, maxLimit: 1000 })).toThrow(QueryValidationError);
    expect(compile({ pagination: { page: 1, pageSize: 1000 } }, { paginated: true, maxLimit: 1000 }).headers['Range']).toBe('0-999');
  });
});

describe('F-13: in.() items', () => {
  const inList = (value: unknown) =>
    compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, filters: [{ column: 'c', operator: 'in', value }] })).params;

  it('F-13: quotes items containing any of ,().:" and drops empty items', () => {
    expect(inList(['a,b', 'c d', '(e)', 1, null, ''])).toEqual(['c=in.(%22a%2Cb%22,c%20d,%22(e)%22,1)']);
    expect(decode(inList(['a,b', 'c d', '(e)', 1, null, '']))).toEqual([['c', 'in.("a,b",c d,"(e)",1)']]);
    expect(decode(inList(['x.y', 'x:y', 'say "hi"', 'back\\slash']))).toEqual([['c', 'in.("x.y","x:y","say \\"hi\\"",back\\slash)']]);
    expect(decode(inList(['2026-07-04T10:30:00+05:30']))).toEqual([['c', 'in.("2026-07-04T10:30:00+05:30")']]);
  });

  it('F-13: in.() stays "matches nothing", eq.false and eq.0 stay, a non-array in stays literal', () => {
    expect(inList([])).toEqual(['c=in.()']);
    expect(inList(['', null, undefined])).toEqual(['c=in.()']);
    expect(inList('not-an-array')).toEqual(['c=in.not-an-array']);
    const eq = (value: unknown) => compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, filters: [{ column: 'c', operator: 'eq', value }] })).params;
    expect(eq(0)).toEqual(['c=eq.0']);
    expect(eq(false)).toEqual(['c=eq.false']);
  });
});

describe('Q-01: default order', () => {
  const order = (query: Partial<DataQuery>) =>
    compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: ['name'], ...query })).params.filter(p => p.startsWith('order='));

  it('Q-01: without an explicit order, orders by display_name then id', () => {
    expect(order({ fields: ['display_name', 'status_id'] })).toEqual(['order=display_name.asc,id.asc']);
    expect(order({ fields: ['id', 'display_name'] })).toEqual(['order=display_name.asc,id.asc']);
  });

  it('Q-01: falls back to id, and to no order when neither is known', () => {
    expect(order({ fields: ['name'] })).toEqual(['order=id.asc']);
    expect(order({ fields: [] })).toEqual(['order=id.asc']);
    expect(order({ fields: ['month', 'total'], isSummaryView: true })).toEqual([]);
    expect(order({ fields: ['display_name'], isSummaryView: true })).toEqual(['order=display_name.asc']);
    expect(order({ fields: NO_FIELDS })).toEqual([]);
  });

  it('Q-01: only plain selected columns are ordered by; an explicit order gets no tie-breaker', () => {
    expect(order({ fields: ['owner:users!owner(id,display_name)'] })).toEqual(['order=id.asc']);
    expect(order({ fields: ['display_name'], orderField: 'created_at', orderDirection: 'desc' })).toEqual(['order=created_at.desc']);
    expect(order({ fields: ['display_name'], orderField: 'owner(display_name)' })).toEqual(['order=owner(display_name).asc']);
  });
});

describe('Q-02: transport policy', () => {
  const compile = (query: Partial<DataQuery>, options = {}) => compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, ...query }), options);

  it('Q-02: by default limit and offset are query parameters and no count is requested', () => {
    const r = compile({ limit: 5, offset: 10 });
    expect(r.params).toEqual(['limit=5', 'offset=10']);
    expect(r.headers).toEqual({});
  });

  it('Q-02: the count flag asks for the total on any transport', () => {
    expect(compile({ limit: 5, count: true }).headers).toEqual({ Prefer: 'count=exact' });
    expect(compile({ count: true }, { useRange: true }).headers).toEqual({ 'Range-Unit': 'items', Range: '0-24', Prefer: 'count=exact' });
  });

  it('Q-02: useRange sends limit and offset as a Range window instead of parameters', () => {
    const r = compile({ limit: 10, offset: 20 }, { useRange: true });
    expect(r.params).toEqual([]);
    expect(r.headers).toEqual({ 'Range-Unit': 'items', Range: '20-29' });
    expect(compile({}, { useRange: true }).headers['Range']).toBe('0-24');
  });

  it('Q-02: paginated reads keep Range plus count=exact', () => {
    expect(compile({ pagination: { page: 2, pageSize: 25 } }, { paginated: true }).headers).toEqual({ 'Range-Unit': 'items', Range: '25-49', Prefer: 'count=exact' });
  });
});

describe('Q-06: the sort is kept while searching', () => {
  const compile = (query: Partial<DataQuery>) => compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: ['display_name'], ...query })).params;

  it('Q-06: order and search are independent', () => {
    expect(compile({ searchQuery: 'pot', orderField: 'name', orderDirection: 'desc' }))
      .toEqual(['select=display_name,id', 'civic_os_text_search=wfts.pot', 'order=name.desc']);
    expect(compile({ searchQuery: 'pot' })).toEqual(['select=display_name,id', 'civic_os_text_search=wfts.pot', 'order=display_name.asc,id.asc']);
    // A blank search is no search, and the order is unaffected.
    expect(compile({ searchQuery: '   ', orderField: 'name' })).toEqual(['select=display_name,id', 'order=name.asc']);
  });
});

describe('Q-08: null and empty filter values', () => {
  const compile = (filters: DataQuery['filters']) => compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, filters })).params;

  it('Q-08: null becomes is.null, an empty string or undefined is dropped', () => {
    expect(compile([
      { column: 'a', operator: 'eq', value: null },
      { column: 'b', operator: 'eq', value: '' },
      { column: 'c', operator: 'eq', value: undefined },
      { column: 'd', operator: 'is', value: null },
    ])).toEqual(['a=is.null', 'd=is.null']);
  });

  it('Q-08: neq null is not.is.null; an operator with no null meaning drops the filter', () => {
    expect(compile([{ column: 'a', operator: 'neq', value: null }, { column: 'b', operator: 'gte', value: null }])).toEqual(['a=not.is.null']);
  });
});

describe('Q-09: several filters on one column', () => {
  const compile = (filters: DataQuery['filters']) => compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: NO_FIELDS, filters })).params;

  it('Q-09: become and=(col.op.a,col.op.b); single-condition columns stay plain parameters', () => {
    expect(compile([
      { column: 'start', operator: 'gte', value: '2026-07-04T00:00:00+00:00' },
      { column: 'name', operator: 'eq', value: 'x' },
      { column: 'start', operator: 'lt', value: '2026-08-01T00:00:00+00:00' },
    ])).toEqual(['name=eq.x', 'and=(start.gte.2026-07-04T00%3A00%3A00%2B00%3A00,start.lt.2026-08-01T00%3A00%3A00%2B00%3A00)']);
  });

  it('Q-09: ISO timestamps need no quotes, a value with a comma or parenthesis is quoted, and + is encoded', () => {
    const params = compile([
      { column: 'c', operator: 'gte', value: '2026-07-04T10:30:00.000+05:30' },
      { column: 'c', operator: 'eq', value: 'a,b' },
      { column: 'c', operator: 'eq', value: 'x(y)' },
      { column: 'c', operator: 'in', value: [1, 'z,w'] },
      { column: 'c', operator: 'eq', value: null },
    ]);
    expect(params).toHaveLength(1);
    expect(decode(params)).toEqual([['and', '(c.gte.2026-07-04T10:30:00.000+05:30,c.eq."a,b",c.eq."x(y)",c.in.(1,"z,w"),c.is.null)']]);
  });

  it('Q-09: dropped conditions do not count toward grouping', () => {
    expect(compile([
      { column: 'a', operator: 'eq', value: 1 },
      { column: 'a', operator: 'eq', value: '' },
    ])).toEqual(['a=eq.1']);
  });
});

describe('Q-11: id is selected only when the entity has an id column', () => {
  const select = (query: Partial<DataQuery>) => compileDataQuery(deepFreeze<DataQuery>({ key: 'k', fields: ['name'], ...query })).params[0];

  it('Q-11: entityHasId decides; the summary-view proxy applies only when it is unset', () => {
    expect(select({ entityHasId: false })).toBe('select=name');
    expect(select({ entityHasId: true })).toBe('select=name,id');
    expect(select({ entityHasId: true, isSummaryView: true })).toBe('select=name,id');
    expect(select({ entityHasId: false, isSummaryView: false })).toBe('select=name');
    expect(select({ isSummaryView: true })).toBe('select=name');
    expect(select({})).toBe('select=name,id');
  });

  it('Q-11: an entity without an id column gets no id order either', () => {
    const r = compileDataQuery(deepFreeze<DataQuery>({ key: 'junction', fields: ['contact_id'], entityHasId: false }));
    expect(r.params).toEqual(['select=contact_id']);
  });
});

describe('Q-05: text search configuration on the compiled query', () => {
  it('Q-05: bare wfts without a config, wfts(config) with one, invalid config rejected', () => {
    const base = { key: 'items', fields: ['id'], searchQuery: 'a(b), c' };
    expect(compileDataQuery(base).params).toContain('civic_os_text_search=wfts.a(b)%2C%20c');
    expect(compileDataQuery({ ...base, textSearchConfig: 'simple' }).params).toContain('civic_os_text_search=wfts(simple).a(b)%2C%20c');
    expect(() => compileDataQuery({ ...base, textSearchConfig: 'Simple;' })).toThrow(QueryValidationError);
  });
});
