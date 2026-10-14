/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Golden outputs: DataService request shapes (URL strings and headers exactly
 * as emitted, captured through HttpTestingController), the pure helpers around
 * them (buildHybridSearchParams, ListPage.buildOrderField/buildSearchParams,
 * transformManyToManyData, Content-Range parsing, compare*, checkEditResult,
 * parseEWKBPoint, executeRpc normalization).
 *
 * Observation: DataService builds queries by string concatenation and does NOT
 * encode filter values (only the search term goes through encodeURIComponent).
 * These goldens record that as-is.
 */
import { TestBed } from '@angular/core/testing';
import { HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { Observable, firstValueFrom } from 'rxjs';
import { DataService } from '../../services/data.service';
import { AnalyticsService } from '../../services/analytics.service';
import { SchemaService } from '../../services/schema.service';
import { ListPage } from '../../pages/list/list.page';
import { buildHybridSearchParams } from '../../utils/search.utils';
import { getPostgrestUrl } from '../../config/runtime';
import { DataQuery } from '../../interfaces/query';
import { EntityPropertyType, ManyToManyMeta, SchemaEntityProperty, SchemaEntityTable } from '../../interfaces/entity';
import { acrossZones, checkGolden, expectNoOrphans, listExamples, listVariants, compactStringify } from './golden-io';
import { listGoldenVariants } from './synthetic-fixtures';
import { configureHttpTesting, loadSchema, typeName } from './schema-harness';

const stubAnalytics = { trackError: () => {}, trackEvent: () => {} };

const strip = (url: string) => {
  const base = getPostgrestUrl();
  return url.startsWith(base) ? `<PGRST>/${url.slice(base.length)}` : url;
};

function describeRequest(r: TestRequest) {
  const headers: Record<string, string> = {};
  for (const k of r.request.headers.keys().sort()) headers[k] = (r.request.headers.getAll(k) ?? []).join(',');
  const params = r.request.params.keys().sort().map(k => `${k}=${r.request.params.getAll(k)!.join(',')}`);
  return {
    method: r.request.method,
    url: strip(r.request.urlWithParams),
    headers,
    ...(params.length ? { params } : {}),
    ...(r.request.body !== null && r.request.body !== undefined ? { body: r.request.body } : {}),
    responseType: r.request.responseType,
    reportProgress: r.request.reportProgress,
  };
}

/** Subscribe, capture the single outgoing request, flush, and return both. */
async function capture<T>(
  httpMock: HttpTestingController,
  call: () => Observable<T>,
  body: unknown = [],
  opts?: { headers?: Record<string, string>; status?: number; statusText?: string }
) {
  const result$ = firstValueFrom(call());
  const reqs = httpMock.match(() => true);
  expect(reqs.length).toBe(1);
  const request = describeRequest(reqs[0]);
  if (opts?.status && opts.status >= 400) {
    reqs[0].flush(body as any, { status: opts.status, statusText: opts.statusText ?? 'Error' });
  } else {
    reqs[0].flush(structuredClone(body) as any, opts as any);
  }
  return { request, result: await result$ };
}

function newDataService() {
  const httpMock = configureHttpTesting({ provide: AnalyticsService, useValue: stubAnalytics });
  return { httpMock, data: TestBed.inject(DataService) };
}

const listPage = ListPage.prototype as any;
const buildOrderField = (p: SchemaEntityProperty) => listPage.buildOrderField.call({}, p);
const buildSearchParams = (q: string, e: Partial<SchemaEntityTable>) => listPage.buildSearchParams.call({}, q, e);

/** Query as a golden record: input (fields elided when named), the fields array after the call, and the request. */
async function runQuery(
  httpMock: HttpTestingController, data: DataService, name: string, kind: 'plain' | 'paginated',
  query: DataQuery, named: Record<string, string[]> = {}
) {
  const input = structuredClone(query) as any;
  for (const [n, arr] of Object.entries(named)) {
    if (JSON.stringify(input.fields) === JSON.stringify(arr)) input.fields = `<${n}>`;
  }
  const working = structuredClone(query);
  const { request, result } = kind === 'plain'
    ? await capture(httpMock, () => data.getData(working))
    : await capture(httpMock, () => data.getDataPaginated(working), [], { headers: { 'Content-Range': '0-24/237' } });
  return {
    name, call: kind === 'plain' ? 'getData' : 'getDataPaginated', input,
    fieldsAfter: working.fields === undefined ? undefined : working.fields.length === query.fields?.length ? '=' : working.fields,
    request, ...(kind === 'paginated' ? { result } : {}),
  };
}

function sampleFilter(p: SchemaEntityProperty): { operator: string; value: unknown } | null {
  switch (p.type) {
    case EntityPropertyType.ForeignKeyName:
    case EntityPropertyType.Status:
    case EntityPropertyType.Category: return { operator: 'eq', value: 5 };
    case EntityPropertyType.User: return { operator: 'eq', value: '33333333-3333-4333-8333-333333333333' };
    case EntityPropertyType.IntegerNumber:
    case EntityPropertyType.Money: return { operator: 'gte', value: 100 };
    case EntityPropertyType.Date: return { operator: 'eq', value: '2026-07-04' };
    case EntityPropertyType.DateTime:
    case EntityPropertyType.DateTimeLocal: return { operator: 'gte', value: '2026-07-04T10:30:00' };
    case EntityPropertyType.Boolean: return { operator: 'eq', value: true };
    default: return null;
  }
}

describe('golden: DataService requests', () => {
  for (const example of listExamples()) {
    it(`${example}: query matrix over the admin schema`, async () => {
      const admin = listVariants(example).find(v => v.variant === 'testadmin')!;
      const loaded = await loadSchema(admin, { provide: AnalyticsService, useValue: stubAnalytics });
      const { service, httpMock, tables } = loaded;
      const data = TestBed.inject(DataService);
      const entities: Record<string, unknown> = {};

      for (const t of tables) {
        const [list, detail, edit, filter] = await Promise.all([
          firstValueFrom(service.getPropsForList(t)), firstValueFrom(service.getPropsForDetail(t)),
          firstValueFrom(service.getPropsForEdit(t)), firstValueFrom(service.getPropsForFilter(t)),
        ]);
        const named = {
          list: list.map(p => SchemaService.propertyToSelectStringForList(p)),
          detail: detail.map(p => SchemaService.propertyToSelectString(p)),
          edit: edit.map(p => SchemaService.propertyToSelectStringForEdit(p)),
        };
        const q: Awaited<ReturnType<typeof runQuery>>[] = [];
        const run = async (name: string, kind: 'plain' | 'paginated', query: DataQuery) =>
          q.push(await runQuery(httpMock, data, name, kind, query, named));
        const key = t.table_name;
        const isSummary = !!(t.is_view && !t.insert);

        await run('list', 'paginated', { key, fields: [...named.list], pagination: { page: 1, pageSize: 25 }, isSummaryView: isSummary });
        for (const [page, pageSize] of [[3, 10], [2, 100], [1, 1]] as const) {
          await run(`list page ${page}/${pageSize}`, 'paginated', { key, fields: [...named.list], pagination: { page, pageSize }, isSummaryView: isSummary });
        }
        await run('list without pagination arg', 'paginated', { key, fields: ['display_name'] });
        for (const [i, p] of list.entries()) {
          for (const dir of i < 2 ? ['asc', 'desc'] : ['asc']) {
            await run(`order ${p.column_name} ${dir} [${typeName(p.type)}]`, 'paginated',
              { key, fields: ['id', 'display_name'], orderField: buildOrderField(p), orderDirection: dir, pagination: { page: 1, pageSize: 25 } });
          }
        }
        await run('order without direction', 'plain', { key, fields: ['id'], orderField: 'created_at' });

        const filters = filter.flatMap(p => {
          const s = sampleFilter(p);
          return s ? [{ column: p.column_name, ...s }] : [];
        });
        if (filters.length) {
          await run('filters (one per filterable property)', 'paginated', { key, fields: [...named.list], filters, pagination: { page: 1, pageSize: 25 } });
          await run('filters with in-array, empty and null values', 'plain', {
            key, fields: ['id'],
            filters: [
              { column: filters[0].column, operator: 'in', value: [1, 2, 3] },
              { column: filters[0].column, operator: 'eq', value: '' },
              { column: filters[0].column, operator: 'eq', value: null },
              { column: filters[0].column, operator: 'eq', value: undefined },
              { column: filters[0].column, operator: 'in', value: [] },
              { column: filters[0].column, operator: 'in', value: 'not-an-array' },
              { column: filters[0].column, operator: 'eq', value: 0 },
              { column: filters[0].column, operator: 'eq', value: false },
            ],
          });
        }
        await run('legacy search ignores order', 'paginated', { key, fields: ['id', 'display_name'], searchQuery: '  pot hole & co  ', orderField: 'display_name', orderDirection: 'desc', pagination: { page: 1, pageSize: 25 } });
        await run('blank search falls through to order', 'paginated', { key, fields: ['id'], searchQuery: '   ', orderField: 'display_name', pagination: { page: 1, pageSize: 25 } });
        if (t.fulltext_search_column || t.substring_search_column) {
          const raw = buildSearchParams('pot hole', t);
          await run('hybrid search rawQueryParams', 'paginated', { key, fields: [...named.list], rawQueryParams: raw, pagination: { page: 1, pageSize: 25 } });
        }
        if (t.show_calendar && t.calendar_property_name) {
          await run('calendar overlap filter', 'paginated', {
            key, fields: [...named.list], pagination: { page: 1, pageSize: 1000 },
            filters: [{ column: t.calendar_property_name, operator: 'ov', value: '[2026-06-28T00:00:00.000Z,2026-08-09T00:00:00.000Z)' }],
          });
        }
        await run('detail', 'plain', { key, fields: [...named.detail], entityId: '1' });
        await run('edit', 'plain', { key, fields: [...named.edit], entityId: '44444444-4444-4444-8444-444444444444' });
        await run('limit and rawQueryParams', 'plain', { key, fields: ['id'], limit: 5, rawQueryParams: ['or=(a.eq.1,b.eq.2)', 'select=ignored'] });

        entities[key] = {
          flags: { is_view: !!t.is_view, insert: !!t.insert, show_calendar: !!t.show_calendar, hasHybridSearch: !!(t.fulltext_search_column || t.substring_search_column) },
          named,
          queries: q,
        };
      }

      // inverse-relationship preview URLs, from the real inverse relationships
      const previews: unknown[] = [];
      for (const t of tables) {
        const rels = await firstValueFrom(service.getInverseRelationships(t.table_name));
        for (const meta of rels) {
          const { request, result } = await capture(httpMock, () => data.getInverseRelationshipData(meta, 7), [{ id: 1 }], { headers: { 'Content-Range': '0-0/15' } });
          previews.push({ target: t.table_name, meta, request, result });
        }
      }
      checkGolden(`${example}/_example/data.queries.json`, { entities, inversePreviews: previews });
      httpMock.verify();
    });
  }

  for (const v of listGoldenVariants()) {
    it(`${v.example}/${v.variant}: transformManyToManyData over synthetic junction rows`, async () => {
      const { props } = await loadSchema(v);
      const out: Record<string, unknown> = {};
      for (const p of props.filter(x => x.type === EntityPropertyType.ManyToMany && x.many_to_many_meta)) {
        const m = p.many_to_many_meta as ManyToManyMeta;
        const extra = m.extraColumns.map(c => c.column_name);
        const rel = (id: number) => ({ id, display_name: `Item ${id}`, ...(m.relatedTableHasColor ? { color: '#ff0000' } : {}) });
        let junction: any[];
        if (m.parentHops?.length) {
          const build = (id: number) => m.parentHops!.slice().reverse().reduce((acc: any, hop) => ({ [hop.table]: acc }), rel(id));
          junction = [{ [m.targetTable]: build(1) }, { [m.targetTable]: build(2) }, { [m.targetTable]: build(1) }, { [m.targetTable]: null }, { [m.targetTable]: {} }];
        } else {
          junction = [
            { [m.relatedTable]: rel(1), ...Object.fromEntries(extra.map((c, i) => [c, `${c}-1-${i}`])) },
            { [m.relatedTable]: rel(2), ...Object.fromEntries(extra.slice(0, 1).map(c => [c, 2])) },
            { [m.relatedTable]: null },
            { [m.relatedTable]: undefined },
          ];
        }
        out[`${p.table_name}.${p.column_name}`] = {
          meta: { relatedTable: m.relatedTable, targetTable: m.targetTable, extraColumns: extra, parentHops: m.parentHops ?? null },
          junction,
          withMeta: DataService.transformManyToManyData(junction, m.relatedTable, extra.length ? extra : undefined, m.parentHops, m.parentHops?.length ? m.targetTable : undefined),
          withoutExtras: DataService.transformManyToManyData(junction, m.relatedTable),
        };
      }
      checkGolden(`${v.example}/${v.variant}/data.m2m-transform.json`, out);
    });
  }

  it('special-character query matrix (filters, search, order, pagination, headers)', async () => {
    const { httpMock, data } = newDataService();
    const nasty = ['a&b', 'a,b', 'a(b)', 'a b', '100%', '50%25', 'ñandú', '日本語', 'a=b', 'a#b', 'a+b', "o'brien", 'a"b', 'a/b', 'a?b', 'a;b', '\\', '*wild*', 'null', 'true', ' lead', 'trail ', '\n'];
    const out: Record<string, unknown> = {};
    const named = {};
    for (const v of nasty) {
      out[`filter eq ${JSON.stringify(v)}`] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: ['id'], filters: [{ column: 'name', operator: 'eq', value: v }] }, named)).request;
      out[`filter ilike ${JSON.stringify(v)}`] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: ['id'], filters: [{ column: 'name', operator: 'ilike', value: `*${v}*` }] }, named)).request;
      out[`search ${JSON.stringify(v)}`] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: ['id'], searchQuery: v }, named)).request;
    }
    out['in array with specials'] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: ['id'], filters: [{ column: 'c', operator: 'in', value: ['a,b', 'c d', '(e)', 1, null, ''] }] }, named)).request;
    out['in array of uuids'] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: ['id'], filters: [{ column: 'c', operator: 'in', value: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] }] }, named)).request;
    out['non-in operator with array value'] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: ['id'], filters: [{ column: 'c', operator: 'eq', value: [1, 2] }] }, named)).request;
    out['order with FK embed'] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: ['id'], orderField: 'owner(display_name)', orderDirection: 'desc' }, named)).request;
    out['entityId with specials'] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: ['id'], entityId: 'a&b=c' }, named)).request;
    out['no fields'] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items' } as any, named)).request;
    out['empty fields'] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: [] }, named)).request;
    out['fields already containing id'] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: ['id', 'name'] }, named)).request;
    out['summary view skips id'] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: ['name'], isSummaryView: true }, named)).request;
    out['limit 0 is dropped'] = (await runQuery(httpMock, data, 'x', 'plain', { key: 'items', fields: ['id'], limit: 0 }, named)).request;
    out['everything at once'] = (await runQuery(httpMock, data, 'x', 'plain', {
      key: 'items', fields: ['name', 'owner:users!owner(id,display_name)'], searchQuery: 'a b', orderField: 'name', entityId: '9',
      filters: [{ column: 'x', operator: 'eq', value: 'y' }], limit: 3, rawQueryParams: ['or=(a.eq.1)'],
    }, named)).request;
    for (const [page, pageSize] of [[1, 25], [2, 25], [10, 7], [1, 1], [0, 25], [-1, 25], [1, 0], [2.5, 10]] as const) {
      out[`pagination ${page}/${pageSize}`] = (await runQuery(httpMock, data, 'x', 'paginated', { key: 'items', fields: ['id'], pagination: { page, pageSize } }, named)).request;
    }
    checkGolden('_shared/data.query-matrix.json', out);
    httpMock.verify();
  });

  it('Content-Range parsing (paginated and inverse preview)', async () => {
    const { httpMock, data } = newDataService();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const headers: Array<string | null> = ['0-24/237', '0-24/*', '*/0', '*/5', '0-0/1', 'items 0-24/237', '0-24/', 'garbage', '0-9/12abc', '', null];
    const paginated: Record<string, unknown> = {};
    const preview: Record<string, unknown> = {};
    for (const h of headers) {
      const opts = h === null ? undefined : { headers: { 'Content-Range': h } };
      const rows = [{ id: 1 }, { id: 2 }];
      paginated[String(h)] = (await capture(httpMock, () => data.getDataPaginated({ key: 'items', fields: ['id'] }), rows, opts)).result;
      preview[String(h)] = (await capture(httpMock, () => data.getInverseRelationshipPreview('items', 'owner_id', 1), rows, opts)).result;
    }
    const errorBody = await capture(httpMock, () => data.getDataPaginated({ key: 'items', fields: ['id'] }), { message: 'x' }, { status: 500 });
    const errorPreview = await capture(httpMock, () => data.getInverseRelationshipPreview('items', 'owner_id', 1), { message: 'x' }, { status: 500 });
    const nullBody = await capture(httpMock, () => data.getDataPaginated({ key: 'items', fields: ['id'] }), null, { headers: { 'Content-Range': '0-0/3' } });
    const previewModes: Record<string, unknown> = {};
    for (const mode of ['display_name', 'id', 'count'] as const) {
      previewModes[mode] = (await capture(httpMock, () => data.getInverseRelationshipPreview('child', 'parent_id', 'a&b', 5, mode), [], { headers: { 'Content-Range': '*/0' } })).request;
    }
    errSpy.mockRestore();
    checkGolden('_shared/data.content-range.json', {
      paginated, preview, paginatedOnHttpError: errorBody.result, previewOnHttpError: errorPreview.result,
      paginatedNullBody: nullBody.result, previewModes,
    });
    httpMock.verify();
  });

  it('mutation, RPC and M:M request shapes; executeRpc normalization', async () => {
    const { httpMock, data } = newDataService();
    const meta: ManyToManyMeta = {
      junctionTable: 'issue_tags', sourceTable: 'Issue', targetTable: 'Tag', sourceColumn: 'issue_id', targetColumn: 'tag_id',
      relatedTable: 'Tag', relatedTableDisplayName: 'Tags', showOnSource: true, showOnTarget: true, displayOrder: 100,
      relatedTableHasColor: true, extraColumns: [],
    };
    const out: Record<string, unknown> = {};
    out['createData'] = (await capture(httpMock, () => data.createData('Issue', { a: 1 }), [{ id: 1 }])).request;
    out['editData'] = (await capture(httpMock, () => data.editData('Issue', 'a&b', { a: 1 }), [{ id: 1, a: 1 }])).request;
    out['deleteData'] = (await capture(httpMock, () => data.deleteData('Issue', 5), null)).request;
    out['refreshCurrentUser'] = (await capture(httpMock, () => data.refreshCurrentUser(), {})).request;
    out['callRpc'] = (await capture(httpMock, () => data.callRpc('fn', { p_a: 1 }), { ok: 1 })).request;
    out['addManyToManyRelation'] = (await capture(httpMock, () => data.addManyToManyRelation(1, meta, 2, { quantity: 3 }), null)).request;
    out['updateManyToManyRelation'] = (await capture(httpMock, () => data.updateManyToManyRelation(1, meta, 2, { quantity: 4 }), null)).request;
    out['removeManyToManyRelation'] = (await capture(httpMock, () => data.removeManyToManyRelation('u&1', meta, 2), null)).request;
    out['bulkInsertJunctions'] = (await capture(httpMock, () => data.bulkInsertJunctions('issue_tags', [{ issue_id: 1, tag_id: 2 }]), null)).request;
    out['bulkInsertJunctions (empty, no request)'] = await firstValueFrom(data.bulkInsertJunctions('issue_tags', []));
    {
      const result$ = firstValueFrom(data.bulkInsert('Issue', [{ a: 1 }, { a: 2 }]));
      const reqs = httpMock.match(() => true);
      out['bulkInsert'] = describeRequest(reqs[0]);
      reqs[0].flush([{ id: 1 }, { id: 2 }]);
      out['bulkInsert result'] = await result$;
    }

    const rpcBodies: Array<[string, unknown]> = [
      ['success true', { success: true, message: 'ok', navigate_to: '/x' }], ['success false with message', { success: false, message: 'Nope' }],
      ['success false no message', { success: false }], ['no success key', { message: 'm' }], ['null body', null],
      ['string body', 'text'], ['array body', [1, 2]], ['empty object', {}], ['success 0', { success: 0 }], ['success "false"', { success: 'false' }],
    ];
    const rpc: Record<string, unknown> = {};
    for (const [name, body] of rpcBodies) rpc[name] = (await capture(httpMock, () => data.executeRpc('act', { p_id: 1 }), body)).result;
    rpc['request'] = (await capture(httpMock, () => data.executeRpc('act', { p_id: 1 }), {})).request;
    rpc['http 400 postgrest error'] = (await capture(httpMock, () => data.executeRpc('act', {}), { code: 'P0001', message: 'raised' }, { status: 400, statusText: 'Bad Request' })).result;
    rpc['http 403'] = (await capture(httpMock, () => data.executeRpc('act', {}), { code: '42501', message: 'denied' }, { status: 403, statusText: 'Forbidden' })).result;
    out['executeRpc'] = rpc;

    // editData success path runs checkEditResult on the representation
    const edits: Record<string, unknown> = {};
    const editCases: Array<[string, any, unknown]> = [
      ['identical', { a: 1 }, [{ id: 1, a: 1 }]], ['mismatch', { a: 1, b: 'x' }, [{ id: 1, a: 2, b: 'x' }]],
      ['empty representation (RLS)', { a: 1 }, []], ['FK embedded', { fk: 3 }, [{ fk: { id: 3, display_name: 'x' } }]],
      ['FK embedded mismatch', { fk: 4 }, [{ fk: { id: 3 } }]], ['string vs number', { n: '4' }, [{ n: 4 }]],
      ['datetime tz suffix', { t: '2026-07-04T10:30:00' }, [{ t: '2026-07-04T10:30:00+00:00' }]],
      ['datetimelocal Z vs offset', { t: '2026-07-04T17:30:00.000Z' }, [{ t: '2026-07-04T17:30:00+00:00' }]],
      ['date vs timestamp', { d: '2026-07-04' }, [{ d: '2026-07-04T05:00:00.000Z' }]], ['money', { m: 1234.5 }, [{ m: '$1,234.50' }]],
      ['color case', { c: '#3B82F6' }, [{ c: '#3b82f6' }]],
      ['time_slot', { s: '[2025-11-07T15:00:00Z,2025-11-07T22:00:00Z)' }, [{ s: '["2025-11-07 15:00:00+00","2025-11-07 22:00:00+00")' }]],
      ['geography point', { g: 'SRID=4326;POINT(-83 43)' }, [{ g: ewkbPoint(-83, 43) }]],
      ['geography mismatch', { g: 'SRID=4326;POINT(-83 44)' }, [{ g: ewkbPoint(-83, 43) }]],
      ['geography polygon trusts', { g: 'SRID=4326;POLYGON((0 0,1 0,1 1,0 0))' }, [{ g: '0103000020E610000001000000040000000000000000000000' }]],
      ['null vs missing', { a: null }, [{ id: 1 }]], ['extra response keys ignored', { a: 1 }, [{ a: 1, z: 9 }]],
    ];
    for (const [name, input, rep] of editCases) edits[name] = (await capture(httpMock, () => data.editData('t', 1, input), rep)).result;
    out['editData results'] = edits;
    checkGolden('_shared/data.mutation-requests.json', out);
    httpMock.verify();
  });

  it('compare* helpers, checkEditResult and parseEWKBPoint (private, characterized)', () => {
    const { data } = newDataService();
    const d = data as any;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pairs = (names: string[], values: Array<[unknown, unknown]>) => names.map(n => ({
      method: n,
      cases: values.map(([a, b]) => ({ input: a, response: b, results: acrossZones(() => d[n](a, b)) })),
    }));
    const cases: Array<[unknown, unknown]> = [
      ['2025-10-31T17:00:00', '2025-10-31T17:00:00+00:00'], ['2025-10-31T17:00', '2025-10-31T17:00:00.000Z'], ['2025-10-31 17:00:00', '2025-10-31T17:00:00Z'],
      ['2025-10-31T17:00:00', '2025-10-31T18:00:00+00:00'], ['2025-10-31', '2025-10-31T05:00:00.000Z'], ['2025-10-31', '2025-10-31'], ['2025-10-31', '2025-11-01T05:00:00.000Z'],
      ['2025-10-31T17:00', '2025-10-31'], [100, '$100.00'], ['100', '$100.00'], [100.004, '$100.00'], [100.5, '$100.00'], ['$1,234.50', '$1,234.50'], [100, '100.00'], [100, '€100.00'], ['abc', '$1.00'], [null, '$1.00'],
      ['#3b82f6', '#3B82F6'], ['#3b82f6', '#3b82f7'], ['#fff', '#fff'], ['#3b82f6', 'red'],
      ['[2025-11-07T15:00:00Z,2025-11-07T22:00:00Z)', '["2025-11-07 15:00:00+00","2025-11-07 22:00:00+00")'],
      ['[2025-11-07T15:00:00.000Z,2025-11-07T22:00:00.000Z)', '["2025-11-07 15:00:00+00","2025-11-07 22:00:00+00")'],
      ['[2025-11-07T15:00:00Z,2025-11-07T23:00:00Z)', '["2025-11-07 15:00:00+00","2025-11-07 22:00:00+00")'],
      ['[2025-11-07T15:00:00.500Z,2025-11-07T22:00:00.500Z)', '["2025-11-07 15:00:00+00","2025-11-07 22:00:00+00")'],
      ['[2025-11-07T15:00:00.500Z,2025-11-07T22:00:00.500Z)', '["2025-11-07 15:00:00.500+00","2025-11-07 22:00:00.500+00")'],
      ['[bad', '[also,bad)'],
      ['[2025-11-07T15:00:00+05:00,2025-11-07T22:00:00+05:00)', '["2025-11-07 15:00:00+05","2025-11-07 22:00:00+05")'],
      ['[2025-11-07T15:00:00+00:00,2025-11-07T22:00:00+00:00)', '["2025-11-07 15:00:00+00","2025-11-07 22:00:00+00")'],
      ['[2025-11-07T15:00:00Z,2025-11-07T22:00:00Z)', '["2025-11-07 20:00:00+05","2025-11-08 03:00:00+05")'],
      ['[2026-03-08T07:30:00Z,2026-03-08T09:00:00Z)', '["2026-03-08 02:30:00-05","2026-03-08 04:00:00-04")'],
      ['[2026-10-03T16:15:00Z,2026-10-03T17:00:00Z)', '["2026-10-03 16:15:00+00","2026-10-03 17:00:00+00")'],
      ['[2025-11-07T15:00:00.000Z,2025-11-07T22:00:00.000Z)', '[2025-11-07T15:00:00Z,2025-11-07T22:00:00Z)'],
      ['[2025-11-07T15:00:00Z,2025-11-07T22:00:00Z]', '["2025-11-07 15:00:00+00","2025-11-07 22:00:00+00"]'],
      ['2025-10-31T17:00:00-05:00', '2025-10-31T22:00:00+00:00'],
      ['2026-03-08T02:30:00', '2026-03-08T07:30:00Z'],
      ['SRID=4326;POINT(-83 43)', ewkbPoint(-83, 43)], ['POINT(-83 43)', ewkbPoint(-83, 43)], ['SRID=4326;POINT(-83 43.0)', ewkbPoint(-83, 43)], ['SRID=4326;POINT(1 2)', ewkbPoint(-83, 43)],
      ['SRID=4326;POLYGON((0 0))', '0103000020E6100000010000000100000000000000'], ['text', 'text'], [1, 1], [null, null],
    ];
    const compare = pairs(['compareDateTimeValues', 'compareDateValues', 'compareMoneyValues', 'compareColorValues', 'compareTimeSlotValues', 'compareGeographyValues'], cases);
    const ewkb = [
      ewkbPoint(-83, 43), ewkbPoint(0, 0), ewkbPoint(179.999999, -89.5), ewkbPoint(-83.0457544, 42.331427), '', '0101', '0101000020E6100000',
      '00' + ewkbPoint(-83, 43).slice(2), ewkbPoint(-83, 43).replace('01000020', '02000020'), ewkbPoint(-83, 43).toLowerCase(), 'zz'.repeat(25),
    ].map(h => ({ hex: h, ewkt: d.parseEWKBPoint(h) }));
    const checkCases: Array<[string, unknown, unknown]> = [
      ['error response passthrough', {}, { success: false, error: { httpCode: 500 } }],
      ['undefined representation', { a: 1 }, undefined],
      ['empty body', { a: 1 }, { success: true, body: [] }],
      ['null body', { a: 1 }, { success: true, body: null }],
      ['match', { a: 1, b: 'x' }, { success: true, body: [{ a: 1, b: 'x' }] }],
      ['mismatch lists fields', { a: 1, b: 'x', c: 2 }, { success: true, body: [{ a: 2, b: 'y', c: 2 }] }],
      ['empty input matches anything', {}, { success: true, body: [{ a: 1 }] }],
    ];
    const m2mGuards = [
      ['null', null], ['undefined', undefined], ['object', { a: 1 }], ['string', 'x'], ['number', 3], ['empty array', []],
    ].map(([name, input]) => ({ name, result: attempt(() => DataService.transformManyToManyData(input as any, 'Tag')) }));
    const hopGuards = [
      ['hops without targetTable use the plain path', [{ Tag: { id: 1 } }], 'Tag', undefined, [{ table: 'gp', fkColumn: 'x' }], undefined],
      ['hops with empty array use the plain path', [{ Tag: { id: 1 } }], 'Tag', undefined, [], 'mid'],
      ['null intermediate', [{ mid: null }, { mid: { gp: null } }, { mid: { gp: { id: 2 } } }, { mid: { gp: { id: 2 } } }], 'Tag', undefined, [{ table: 'gp', fkColumn: 'x' }], 'mid'],
      ['two hops', [{ mid: { a: { b: { id: 'u1' } } } }, { mid: { a: { b: { id: 'u1' } } } }, { mid: { a: { b: { id: 'u2' } } } }], 'Tag', undefined, [{ table: 'a', fkColumn: 'x' }, { table: 'b', fkColumn: 'y' }], 'mid'],
      ['extra columns missing from the row', [{ Tag: { id: 1 }, q: 1 }, { Tag: { id: 2 } }], 'Tag', ['q', 'z'], undefined, undefined],
      ['empty extras array is not rich', [{ Tag: { id: 1 }, q: 1 }], 'Tag', [], undefined, undefined],
    ].map(([name, rows, rel, extras, hops, target]) => ({
      name, result: attempt(() => DataService.transformManyToManyData(rows as any, rel as string, extras as any, hops as any, target as any)),
    }));
    const check = checkCases.map(([name, input, rep]) => ({ name, input, representation: rep, result: d.checkEditResult(input, rep) }));
    errSpy.mockRestore();
    checkGolden('_shared/data.compare-helpers.json', { compare, ewkb, checkEditResult: check, transformManyToManyGuards: { m2mGuards, hopGuards } });
  });

  it('buildHybridSearchParams matrix', () => {
    const terms = ['pot hole', '  pot hole  ', 'a(b)', 'a,b', '(),', '', '   ', 'a&b', '100%', 'ñandú 日本', "o'brien", 'a.b', 'x*y', 'a=b'];
    const configs: Array<[string, string | null | undefined, string[] | undefined]> = [
      ['none', undefined, undefined], ['fts only', 'civic_os_text_search', []], ['substring only', null, ['display_name']],
      ['both', 'civic_os_text_search', ['display_name']], ['fts + two substring', 'fts', ['a', 'b']], ['two substring', null, ['a', 'b']], ['empty fts string', '', ['a']],
    ];
    const out: Record<string, unknown> = {};
    for (const [name, fts, cols] of configs) {
      const row: Record<string, unknown> = {};
      for (const term of terms) row[compactStringify(term)] = buildHybridSearchParams(term, fts, cols);
      out[name] = row;
    }
    const entityConfigs: Record<string, unknown> = {};
    for (const [name, t] of [
      ['fts', { fulltext_search_column: 'civic_os_text_search', substring_search_column: null }],
      ['substring', { fulltext_search_column: null, substring_search_column: 'display_name' }],
      ['both', { fulltext_search_column: 'civic_os_text_search', substring_search_column: 'display_name' }],
      ['legacy search_fields only', { fulltext_search_column: null, substring_search_column: null, search_fields: ['a'] }],
    ] as Array<[string, Partial<SchemaEntityTable>]>) entityConfigs[name] = buildSearchParams('pot hole', t);
    const orderFields = Object.values(EntityPropertyType).filter(v => typeof v === 'number').map(t => ({
      type: typeName(t as EntityPropertyType),
      order: buildOrderField({ column_name: 'col', type: t } as SchemaEntityProperty),
    }));
    checkGolden('_shared/data.hybrid-search.json', { buildHybridSearchParams: out, listPageBuildSearchParams: entityConfigs, listPageBuildOrderField: orderFields });
  });

  it('no orphan data.* golden files', () => {
    expectNoOrphans(rel => /\/data\.[a-z0-9-]+\.json$/.test(rel));
  });
});

/** Record a thrown error as data so a behavior change names its artifact instead of aborting the test. */
function attempt<T>(fn: () => T): T | { threw: string } {
  try { return fn(); } catch (e) { return { threw: String(e) }; }
}

/** Little-endian EWKB hex for POINT(x y) with SRID 4326. */
function ewkbPoint(x: number, y: number): string {
  const hex = (n: number) => {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, n, true);
    return Array.from({ length: 8 }, (_, i) => b.getUint8(i).toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  return '0101000020E6100000' + hex(x) + hex(y);
}
