/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Golden outputs (MCP): request building.
 *  - _example/data.queries.json: every per-entity query of the frontend
 *    artifact of the same name (DataService.getData/getDataPaginated inputs),
 *    mapped to the closest list_records / get_record call and run through the
 *    real tool against the example's admin schema. Each entry keeps the
 *    frontend query `name`, the MCP tool input, mapping notes, and every
 *    request the tool sent (URL as sent, decoded parameters, headers). Inputs
 *    the MCP cannot express are marked `inexpressible` with the reason.
 *  - _shared/data.query-matrix.json: the frontend's special-character /
 *    pagination matrix, case by case, against a synthetic `items` entity.
 *  - _shared/data.content-range.json: Content-Range parsing (the client's
 *    contentRange and the total list_records reports) over the frontend's
 *    header list.
 *  - _shared/mcp.names-fk-requests.json (MCP-only): resolveForeignKeyValue
 *    (eq, then ilike fallback) and resolveData request shapes and outcomes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { PostgRESTClient } from '../../postgrest-client.js';
import { NameResolutionError } from '../../name-resolver.js';
import { EntityPropertyType } from '@civic-os/core';
import {
  adminVariant, checkGolden, expectNoOrphans, listExamples, loadFrontendArtifact,
} from './golden-io.js';
import {
  BASE, FixtureBackend, bootMcp, bootVariant, callTool, emptyResponder, makeServer, restoreFetch, routesFrom,
  TRANSPORT_DEFAULTS, type CapturedRequest, type McpContext, type ToolOutcome,
} from './mcp-harness.js';

afterEach(() => restoreFetch());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface Mapped {
  tool?: 'list_records' | 'get_record';
  args?: Record<string, unknown>;
  notes?: string[];
  inexpressible?: string;
}

function outcomeRecord(o: ToolOutcome) {
  return {
    ...(o.invalidInput ? { invalidInput: o.invalidInput } : {}),
    ...(o.thrown ? { thrown: o.thrown } : {}),
    ...(o.toolError ? { toolError: o.toolError } : {}),
    requests: o.requests,
  };
}

/** Entity argument the LLM would use: the table name if it resolves to itself, else the display name. */
function entityArg(ctx: McpContext, table: string): { arg: string; note?: string } {
  const tryResolve = (s: string) => {
    try { return ctx.resolver.resolveEntity(s).table_name; } catch { return undefined; }
  };
  if (tryResolve(table) === table) return { arg: table };
  const e = ctx.cache.getEntity(table);
  if (e && tryResolve(e.display_name) === table) {
    return { arg: e.display_name, note: `entity passed by display name: table name ${JSON.stringify(table)} does not resolve to itself (see mcp.names.json)` };
  }
  return { arg: table, note: 'entity resolves by neither table name nor display name (see mcp.names.json)' };
}

/**
 * Query names of the frontend data.queries.json spec (data.golden.spec.ts) and
 * how each maps to an MCP tool. The frontend artifact elides field arrays that
 * equal one of the entity's named lists as `<list>` / `<detail>` / `<edit>`;
 * those labels collide when two named lists are equal, so the mapping keys off
 * the query NAME and the actual field array (label resolved through `named`).
 */
const LIST_DEFAULT_QUERIES = new Set(['list', 'filters (one per filterable property)', 'hybrid search rawQueryParams', 'calendar overlap filter']);
const EXPLICIT_COLUMN_QUERIES = new Set([
  'list without pagination arg', 'order without direction', 'filters with in-array, empty and null values',
  'legacy search ignores order', 'blank search falls through to order', 'limit and rawQueryParams',
]);

/** The actual field array of a recorded frontend query (resolving an elided `<name>` label). */
function actualFields(q: Any, e: Any): string[] | undefined {
  const f = q.input?.fields;
  if (typeof f === 'string') {
    const m = /^<(\w+)>$/.exec(f);
    if (!m || !Array.isArray(e.named?.[m[1]])) throw new Error(`unresolvable field label ${f} in ${q.name}`);
    return e.named[m[1]];
  }
  return f;
}

/** Map one frontend DataQuery (as recorded in its data.queries.json) to the closest MCP tool call. */
function mapQuery(q: Any, entity: string, e: Any): Mapped {
  const input = q.input ?? {};
  const notes: string[] = [];
  const fields = actualFields(q, e);
  const name = String(q.name);
  if (name === 'edit') {
    return { inexpressible: 'edit-form read: the MCP has no counterpart (update_record sends a PATCH without reading the record first)' };
  }
  if (name === 'detail') {
    notes.push('detail read -> get_record (renders the detail columns; selects every property plus timestamps)');
    return { tool: 'get_record', args: { entity, id: input.entityId }, notes };
  }
  if (input.entityId !== undefined) throw new Error(`unexpected entityId in frontend query ${name}`);
  const args: Record<string, unknown> = { entity };
  if (LIST_DEFAULT_QUERIES.has(name) || name.startsWith('list page ')) {
    if (JSON.stringify(fields) !== JSON.stringify(e.named.list)) throw new Error(`${name}: expected the list columns`);
    notes.push('list columns -> list_records default columns');
  } else if (EXPLICIT_COLUMN_QUERIES.has(name) || name.startsWith('order ')) {
    if (!Array.isArray(fields)) throw new Error(`${name}: expected explicit columns`);
    args.columns = fields;
  } else {
    throw new Error(`frontend query not mapped: ${name}`);
  }
  if (input.pagination) {
    const { page, pageSize } = input.pagination;
    args.offset = (page - 1) * pageSize;
    args.limit = pageSize;
    notes.push(`page ${page}/${pageSize} -> offset ${(page - 1) * pageSize}, limit ${pageSize}`);
  } else if (q.call === 'getDataPaginated') {
    notes.push('no pagination argument: list_records applies its default offset 0, limit 25');
  }
  if (input.limit !== undefined) args.limit = input.limit;
  if (input.orderField) {
    let f = String(input.orderField);
    const m = /^([^()]+)\(([^()]+)\)$/.exec(f);
    if (m) {
      f = m[1];
      notes.push(`order by embedded ${m[2]} of ${m[1]} -> sort by the column ${m[1]} itself (list_records sorts by own columns only)`);
    }
    args.sort = (input.orderDirection === 'desc' ? '-' : '') + f;
  }
  if (input.filters) {
    const filters: Any[] = [];
    for (const f of input.filters) {
      if (!('value' in f)) {
        notes.push(`filter ${f.column} ${f.operator} with an undefined value dropped (no counterpart in the tool input)`);
        continue;
      }
      filters.push({ field: f.column, operator: f.operator, value: f.value });
    }
    args.filters = filters;
  }
  if (input.searchQuery !== undefined) args.search = input.searchQuery;
  if (input.rawQueryParams) {
    if (name === 'hybrid search rawQueryParams') {
      args.search = 'pot hole';
      notes.push("rawQueryParams are ListPage.buildSearchParams('pot hole', entity) -> search: 'pot hole'");
    } else {
      notes.push(`rawQueryParams ${JSON.stringify(input.rawQueryParams)} dropped: list_records has no raw parameter passthrough`);
    }
  }
  if (input.isSummaryView) notes.push('isSummaryView has no counterpart: list_records adds id whenever the entity has an id column');
  return { tool: 'list_records', args, notes };
}

async function runMapped(ctx: McpContext, server: ReturnType<typeof makeServer>, mapped: Mapped) {
  if (mapped.inexpressible) return { inexpressible: mapped.inexpressible };
  const outcome = await callTool(ctx, server, mapped.tool!, mapped.args!);
  return {
    call: mapped.tool,
    input: mapped.args,
    ...(mapped.notes?.length ? { notes: mapped.notes } : {}),
    ...outcomeRecord(outcome),
  };
}

// ---------------------------------------------------------------------------
// Synthetic schema for the example-independent matrices
// ---------------------------------------------------------------------------

const prop = (table: string, column: string, sort: number, extra: Record<string, unknown>) => ({
  table_name: table, column_name: column, display_name: column, description: null, sort_order: sort,
  data_type: 'character varying', udt_name: 'varchar', udt_schema: 'pg_catalog',
  join_schema: null, join_table: null, join_column: null, geography_type: null,
  is_nullable: true, is_updatable: true, is_identity: false, is_generated: false, is_self_referencing: false,
  column_default: null, show_on_list: true, show_on_create: true, show_on_edit: true, show_on_detail: true,
  sortable: true, filterable: false, validation_rules: [], ...extra,
});

const SYNTHETIC = {
  entities: [
    { table_name: 'items', display_name: 'Items', description: null, sort_order: 1, insert: true, select: true, update: true, delete: true,
      fulltext_search_column: 'civic_os_text_search', substring_search_column: null },
    { table_name: 'summary_items', display_name: 'Summary Items', description: null, sort_order: 2, insert: false, select: true, update: false, delete: false,
      is_view: true, fulltext_search_column: null, substring_search_column: null },
    { table_name: 'parents', display_name: 'Parents', description: null, sort_order: 3, insert: true, select: true, update: true, delete: true },
  ],
  properties: [
    prop('items', 'id', 1, { data_type: 'integer', udt_name: 'int4', is_identity: true, is_updatable: false, show_on_list: false, show_on_create: false, show_on_edit: false, show_on_detail: false }),
    prop('items', 'name', 2, {}),
    prop('items', 'c', 3, {}),
    prop('items', 'x', 4, {}),
    prop('items', 'owner', 5, { data_type: 'uuid', udt_name: 'uuid', join_schema: 'metadata', join_table: 'civic_os_users', join_column: 'id' }),
    prop('items', 'parent_id', 6, { data_type: 'integer', udt_name: 'int4', join_schema: 'public', join_table: 'parents', join_column: 'id' }),
    prop('items', 'civic_os_text_search', 7, { data_type: 'tsvector', udt_name: 'tsvector', show_on_list: false, show_on_detail: false, show_on_create: false, show_on_edit: false }),
    prop('parents', 'id', 1, { data_type: 'integer', udt_name: 'int4', is_identity: true, is_updatable: false }),
    prop('parents', 'display_name', 2, {}),
    prop('summary_items', 'name', 1, { is_updatable: false }),
  ],
};

function syntheticRoutes() {
  return routesFrom({
    'schema_entities': SYNTHETIC.entities,
    'schema_m2m_properties': [],
      'schema_properties': SYNTHETIC.properties,
    'schema_entity_actions?order=table_name.asc,sort_order.asc': [],
    'statuses?order=entity_type.asc,sort_order.asc,display_name.asc': [],
    'categories?order=entity_type.asc,sort_order.asc,display_name.asc': [],
    'status_transitions': { __status: 404, __body: { code: '42P01', message: 'relation does not exist' } },
    'constraint_messages': [],
    'schema_cache_versions': [{ cache_name: 'entities', version: '1' }, { cache_name: 'properties', version: '1' }],
  });
}

const PAGINATION = /^pagination (-?[\d.]+)\/(-?[\d.]+)$/;

function matrixCase(key: string): Mapped {
  let m: RegExpExecArray | null;
  if ((m = /^filter eq (.+)$/.exec(key))) {
    return { tool: 'list_records', args: { entity: 'items', columns: ['id'], filters: [{ field: 'name', operator: 'eq', value: JSON.parse(m[1]) }] } };
  }
  if ((m = /^filter ilike (.+)$/.exec(key))) {
    return { tool: 'list_records', args: { entity: 'items', columns: ['id'], filters: [{ field: 'name', operator: 'ilike', value: `*${JSON.parse(m[1])}*` }] } };
  }
  if ((m = /^search (.+)$/.exec(key))) {
    return { tool: 'list_records', args: { entity: 'items', columns: ['id'], search: JSON.parse(m[1]) } };
  }
  if ((m = PAGINATION.exec(key))) {
    const page = Number(m[1]);
    const size = Number(m[2]);
    return {
      tool: 'list_records',
      args: { entity: 'items', columns: ['id'], offset: (page - 1) * size, limit: size },
      notes: [`page ${page}/${size} -> offset ${(page - 1) * size}, limit ${size}`],
    };
  }
  const list = (args: Record<string, unknown>, notes?: string[]): Mapped =>
    ({ tool: 'list_records', args: { entity: 'items', ...args }, ...(notes ? { notes } : {}) });
  switch (key) {
    case 'in array with specials': return list({ columns: ['id'], filters: [{ field: 'c', operator: 'in', value: ['a,b', 'c d', '(e)', 1, null, ''] }] });
    case 'in array of uuids': return list({ columns: ['id'], filters: [{ field: 'c', operator: 'in', value: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] }] });
    case 'non-in operator with array value': return list({ columns: ['id'], filters: [{ field: 'c', operator: 'eq', value: [1, 2] }] });
    case 'order with FK embed': return list({ columns: ['id'], sort: '-owner(display_name)' }, ['orderField passed through as the sort argument']);
    case 'entityId with specials':
      return { tool: 'get_record', args: { entity: 'items', id: 'a&b=c', columns: ['id'] }, notes: ['entityId -> get_record id (select is every property plus timestamps)'] };
    case 'no fields': return list({}, ['no fields -> list_records default columns']);
    case 'empty fields': return list({ columns: [] });
    case 'fields already containing id': return list({ columns: ['id', 'name'] });
    case 'summary view skips id':
      return { tool: 'list_records', args: { entity: 'summary_items', columns: ['name'] }, notes: ['isSummaryView has no counterpart; run against an entity without an id column instead'] };
    case 'limit 0 is dropped': return list({ columns: ['id'], limit: 0 });
    case 'everything at once':
      return list(
        { columns: ['name', 'owner'], search: 'a b', sort: 'name', filters: [{ field: 'x', operator: 'eq', value: 'y' }], limit: 3 },
        ['fields: the embed string for owner is the MCP\'s own (columns are resolved by name)', 'entityId 9 and rawQueryParams ["or=(a.eq.1)"] have no list_records counterpart and are dropped'],
      );
    default: throw new Error(`frontend query-matrix case not mapped: ${key}`);
  }
}

const FK_NAMES = ['Website Redesign', "O'Brien", 'a_b', '100%', 'a*b', 'a,b', 'a&b', 'ñandú', '  padded  ', '33333333-3333-4333-8333-333333333333'];

type Scenario = (req: CapturedRequest) => { status: number; body: unknown };
const value = (req: CapturedRequest, op: string) => req.decoded.find(d => d.startsWith(`display_name=${op}.`))?.slice(`display_name=${op}.`.length);
const FK_SCENARIOS: Record<string, Scenario> = {
  'eq finds one': req => ({ status: 200, body: value(req, 'eq') !== undefined ? [{ id: 7, display_name: value(req, 'eq') }] : [] }),
  'eq finds two': req => ({ status: 200, body: value(req, 'eq') !== undefined ? [{ id: 7, display_name: 'A' }, { id: 9, display_name: 'A' }] : [] }),
  'eq none, ilike one': req => ({ status: 200, body: value(req, 'ilike') !== undefined ? [{ id: 8, display_name: 'pattern match' }] : [] }),
  'eq none, ilike two': req => ({ status: 200, body: value(req, 'ilike') !== undefined ? [{ id: 8, display_name: 'p1' }, { id: 10, display_name: 'p2' }] : [] }),
  'no match': () => ({ status: 200, body: [] }),
};

describe('golden (mcp): request building', () => {
  for (const example of listExamples()) {
    it(`${example}: frontend per-entity queries through list_records / get_record`, async () => {
      const fe = loadFrontendArtifact(`${example}/_example/data.queries.json`);
      const ctx = await bootVariant(adminVariant(example));
      const server = makeServer(ctx);
      ctx.backend.responder = emptyResponder;
      const entities: Record<string, unknown> = {};
      for (const [table, e] of Object.entries(fe.entities as Record<string, Any>)) {
        const { arg, note } = entityArg(ctx, table);
        const queries: unknown[] = [];
        for (const q of e.queries) {
          const mapped = mapQuery(q, arg, e);
          queries.push({ name: q.name, ...(await runMapped(ctx, server, mapped)) });
        }
        entities[table] = { ...(note ? { entityNote: note } : {}), queries };
      }
      checkGolden(`${example}/_example/data.queries.json`, { transportDefaults: TRANSPORT_DEFAULTS, entities });
    });
  }

  it('special-character, id, limit and pagination matrix (frontend cases)', async () => {
    const fe = loadFrontendArtifact('_shared/data.query-matrix.json');
    const ctx = await bootMcp(syntheticRoutes());
    const server = makeServer(ctx);
    ctx.backend.responder = emptyResponder;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(fe)) out[key] = await runMapped(ctx, server, matrixCase(key));
    // MCP-detected types of the synthetic properties (the ledger's request model needs them).
    const syntheticTypes = Object.fromEntries(ctx.cache.properties.map(p => [`${p.table_name}.${p.column_name}`, EntityPropertyType[p.type ?? 0]]));
    checkGolden('_shared/data.query-matrix.json', { transportDefaults: TRANSPORT_DEFAULTS, synthetic: SYNTHETIC, syntheticTypes, cases: out });
  });

  it('Content-Range parsing over the frontend header list', async () => {
    const fe = loadFrontendArtifact('_shared/data.content-range.json');
    const rows = [{ id: 1 }, { id: 2 }];
    const paginated: Record<string, unknown> = {};
    for (const key of Object.keys(fe.paginated)) {
      const backend = new FixtureBackend(new Map());
      const headers: Record<string, string> = key === 'null' ? {} : { 'Content-Range': key };
      backend.responder = () => ({ status: 200, body: rows, headers });
      vi.stubGlobal('fetch', backend.fetch);
      const res = await new PostgRESTClient({ baseUrl: BASE }).get<unknown[]>('items');
      // list_records reports `response.contentRange?.total` (no total when undefined/null).
      paginated[key] = { data: res.data, totalCount: res.contentRange?.total, contentRange: res.contentRange ?? null };
      restoreFetch();
    }
    checkGolden('_shared/data.content-range.json', { paginated });
  });

  it('foreign-key name resolution and resolveData request shapes', async () => {
    const ctx = await bootMcp(syntheticRoutes());
    const fk: Record<string, unknown> = {};
    for (const [scenario, respond] of Object.entries(FK_SCENARIOS)) {
      const row: Record<string, unknown> = {};
      for (const name of FK_NAMES) {
        ctx.backend.responder = respond;
        ctx.backend.take();
        let result: unknown;
        try {
          result = await ctx.resolver.resolveForeignKeyValue('parents', name);
        } catch (e) {
          if (!(e instanceof NameResolutionError)) throw e;
          result = `ERR ${e.message}`;
        }
        row[JSON.stringify(name)] = { result, requests: ctx.backend.take().map(r => r.decoded.join('&')) };
      }
      fk[scenario] = row;
    }
    const data: Record<string, unknown> = {};
    const dataCases: Record<string, Record<string, unknown>> = {
      'FK numeric string': { parent_id: '5' },
      'FK display name': { parent_id: 'Website Redesign' },
      'FK uuid-looking string': { parent_id: '33333333-3333-4333-8333-333333333333' },
      'User uuid': { owner: '33333333-3333-4333-8333-333333333333' },
      'User display name': { owner: 'Pat Doe' },
      'by display names of columns': { Name: 'n', OWNER: '33333333-3333-4333-8333-333333333333' },
      'unknown column passes through': { nope: 1 },
      'non-string FK value': { parent_id: 5 },
    };
    for (const [name, input] of Object.entries(dataCases)) {
      ctx.backend.responder = FK_SCENARIOS['eq finds one'];
      ctx.backend.take();
      let result: unknown;
      try {
        result = await ctx.resolver.resolveData('items', input);
      } catch (e) {
        if (!(e instanceof NameResolutionError)) throw e;
        result = `ERR ${e.message}`;
      }
      data[name] = { input, result, requests: ctx.backend.take().map(r => r.url) };
    }
    checkGolden('_shared/mcp.names-fk-requests.json', { resolveForeignKeyValue: fk, resolveData: data });
  });

  it('matrix mapping covers every frontend case', () => {
    const fe = loadFrontendArtifact('_shared/data.query-matrix.json');
    for (const key of Object.keys(fe)) expect(() => matrixCase(key)).not.toThrow();
  });

  it('no orphan data golden files', () => {
    expectNoOrphans(rel => /\/(data\.[a-z0-9-]+|mcp\.names-fk-requests)\.json$/.test(rel));
  });
});
