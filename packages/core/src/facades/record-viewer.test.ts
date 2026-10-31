/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures are partial schema rows, as in the handle tests. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataClient } from '../client/data-client.js';
import { DataClientError } from '../client/errors.js';
import { humanizeError } from '../errors/index.js';
import { EntityHandle, mintEntityHandle } from '../handles/handles.js';
import { EntityPropertyType } from '../model/entity.js';
import type { GuidedFormContext, GuidedFormStep } from '../model/index.js';
import type {
  ActionParamType,
  EntityAction,
  EntityActionParam,
  InverseRelationshipMeta,
  RenderableItem,
  SchemaEntityProperty,
  SchemaEntityTable,
  StaticText,
} from '../model/entity.js';
import { propertyToSelectString } from '../schema/select.js';
import { createFakeClock, FAKE_API_URL, fakeTransport, reply } from '../testing/index.js';
import { TransportError } from '../transport/errors.js';
import type { FakeTransport } from '../testing/index.js';
import type { TransportRequest, TransportResponse } from '../transport/types.js';
import { recordViewer } from './record-viewer.js';
import type { RecordViewer, RecordViewerOptions, ViewerDeps } from './record-viewer.js';

// Core compiles without DOM or Node types (see fetch-transport.test.ts).
declare const setTimeout: (callback: () => void, ms: number) => unknown;

const T = EntityPropertyType;

let seq = 0;

const entityRow = (over: Partial<SchemaEntityTable> = {}): SchemaEntityTable =>
  ({
    table_name: 'issues',
    display_name: 'Issues',
    sort_order: 1,
    description: null,
    search_fields: null,
    show_map: false,
    map_property_name: null,
    show_calendar: false,
    calendar_property_name: null,
    calendar_color_property: null,
    insert: true,
    select: true,
    update: true,
    delete: true,
    ...over,
  }) as SchemaEntityTable;

const prop = (column: string, type: EntityPropertyType, over: Partial<SchemaEntityProperty> = {}): SchemaEntityProperty =>
  ({
    table_catalog: 'db',
    table_schema: 'public',
    table_name: 'issues',
    column_name: column,
    display_name: column.charAt(0).toUpperCase() + column.slice(1),
    sort_order: 1,
    is_nullable: true,
    data_type: 'text',
    udt_name: 'text',
    is_generated: false,
    is_identity: false,
    is_updatable: true,
    join_schema: '',
    join_table: '',
    join_column: '',
    show_on_list: true,
    type,
    ...over,
  }) as SchemaEntityProperty;

const P = {
  id: prop('id', T.IntegerNumber, { show_on_list: false }),
  displayName: prop('display_name', T.TextShort, { show_on_list: false }),
  name: prop('name', T.TextShort, { display_name: 'Name' }),
  geo: prop('location', T.GeoPoint, { display_name: 'Location' }),
  payment: prop('payment_id', T.Payment, { display_name: 'Payment' }),
};

const BASE = [P.id, P.displayName, P.name];

const action = (name: string, over: Partial<EntityAction> = {}): EntityAction =>
  ({
    id: ++seq,
    table_name: 'issues',
    action_name: name,
    display_name: name.toUpperCase(),
    rpc_function: `do_${name}`,
    button_style: 'primary',
    sort_order: 1,
    requires_confirmation: false,
    refresh_after_action: false,
    show_on_detail: true,
    can_execute: true,
    parameters: [],
    ...over,
  }) as EntityAction;

const param = (name: string, type: ActionParamType, over: Partial<EntityActionParam> = {}): EntityActionParam =>
  ({ id: ++seq, param_name: name, display_name: name, param_type: type, required: false, sort_order: 1, ...over }) as EntityActionParam;

const inverseMeta = (table: string, over: Partial<InverseRelationshipMeta> = {}): InverseRelationshipMeta => ({
  sourceTable: table,
  sourceTableDisplayName: table,
  sourceColumn: 'issue_id',
  sourceColumnDisplayName: 'Issue',
  showOnDetail: true,
  sortOrder: 1,
  previewLimit: 5,
  previewMode: 'display_name',
  ...over,
});

const m2m = (column: string, over: Record<string, unknown> = {}): SchemaEntityProperty =>
  prop(column, T.ManyToMany, {
    many_to_many_meta: {
      junctionTable: 'issue_tags',
      sourceTable: 'issues',
      targetTable: 'tags',
      sourceColumn: 'issue_id',
      targetColumn: 'tag_id',
      relatedTable: 'tags',
      relatedTableDisplayName: 'Tags',
      showOnSource: true,
      showOnTarget: true,
      displayOrder: 1,
      relatedTableHasColor: false,
      extraColumns: [],
      ...over,
    } as any,
  });

const step = (key: string, over: Partial<GuidedFormStep> = {}): GuidedFormStep => ({
  id: ++seq,
  guided_form_key: 'intake',
  step_key: key,
  display_name: key,
  description: null,
  step_table: `${key}_steps`,
  parent_fk_column: 'issue_id',
  step_order: 1,
  can_skip: false,
  track_key: null,
  conditions: [],
  ...over,
});

const context = (over: Partial<GuidedFormContext> = {}): GuidedFormContext =>
  ({
    definition: { guided_form_key: 'intake', parent_table: 'issues' },
    steps: [],
    progress: [],
    status_options: [],
    parent_status_id: 1,
    parent_status_key: 'draft',
    parent_id: 7,
    record_id: 7,
    is_child_step: false,
    step_key: null,
    step_record_ids: {},
    ...over,
  }) as GuidedFormContext;

const progress = (...keys: string[]) => keys.map(step_key => ({ id: ++seq, step_key }) as any);

const staticText = (id: number, sort_order: number, content: string): StaticText =>
  ({ itemType: 'static_text', id, table_name: 'issues', content, sort_order, column_width: 2, show_on_detail: true }) as any;

/** Lets the microtask-scheduled load and the fake transport settle. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

interface Call {
  method: string;
  path: string;
  body: any;
}
/** Answers a request, or returns `undefined` to leave it to the default reply. */
type Route = (call: Call, req: TransportRequest) => TransportResponse | Promise<TransportResponse> | undefined;

interface Scenario {
  /** `null`: the entity is not in the live schema. */
  entity?: Partial<SchemaEntityTable> | null;
  props?: SchemaEntityProperty[];
  actions?: EntityAction[];
  renderables?: RenderableItem[];
  inverse?: InverseRelationshipMeta[];
  entities?: SchemaEntityTable[];
  /** The record request's row; `null` answers `[]`. */
  record?: Record<string, unknown> | null;
  recordId?: string | number;
  respond?: Route;
  options?: RecordViewerOptions;
}

interface World {
  viewer: RecordViewer;
  deps: ViewerDeps;
  ft: FakeTransport;
  handle: EntityHandle;
  /** What the schema stub returns; tests change it between loads. */
  state: {
    props: SchemaEntityProperty[];
    actions: EntityAction[];
    inverse: InverseRelationshipMeta[];
    entities: SchemaEntityTable[];
    propertiesFail: boolean;
    exclusions: (ReadonlySet<string> | undefined)[];
  };
}

const DEFAULT_RECORD = { id: 7, display_name: 'Pothole', name: 'Pothole' };

function make(sc: Scenario = {}): World {
  const row = sc.entity === null ? undefined : entityRow(sc.entity);
  const state: World['state'] = {
    props: sc.props ?? BASE,
    actions: sc.actions ?? [],
    inverse: sc.inverse ?? [],
    entities: sc.entities ?? (row ? [row] : []),
    propertiesFail: false,
    exclusions: [],
  };
  const ft = fakeTransport(async req => {
    const path = req.url.startsWith(FAKE_API_URL) ? req.url.slice(FAKE_API_URL.length) : req.url;
    const call: Call = { method: req.method, path, body: req.body === undefined ? undefined : JSON.parse(req.body) };
    const custom = sc.respond?.(call, req);
    if (custom !== undefined) return custom;
    if (req.method === 'GET' && path.startsWith('issues?select=')) {
      return reply(200, sc.record === null ? [] : [sc.record ?? DEFAULT_RECORD]);
    }
    return req.method === 'GET' ? reply(200, []) : reply(200, null);
  });
  const handle = mintEntityHandle(
    { peekEntities: () => (row ? [row] : []), peekProperties: () => state.props, peekEntityActions: () => undefined },
    'issues',
  );
  const deps: ViewerDeps = {
    data: ft.client as DataClient,
    clock: createFakeClock('2026-10-21T12:00:00Z'),
    schema: {
      properties: async () => {
        if (state.propertiesFail) throw new Error('schema down');
        return state.props;
      },
      renderables: async () =>
        sc.renderables ?? state.props.filter(p => p.show_on_detail !== false).map(p => ({ ...p, itemType: 'property' }) as RenderableItem),
      actions: async () => state.actions,
      inverseRelationships: async (_entity, excludeTables) => {
        state.exclusions.push(excludeTables);
        return state.inverse;
      },
      entities: async () => state.entities,
    },
  };
  const viewer = recordViewer(deps, handle, sc.recordId ?? 7, sc.options);
  return { viewer, deps, ft, handle, state };
}

const snap = (w: World) => w.viewer.getSnapshot();
const sent = (w: World) => w.ft.recorded();
const gets = (w: World, prefix: string) => sent(w).filter(r => r.method === 'GET' && r.path.startsWith(prefix));
const rpcs = (w: World, fn: string) =>
  sent(w)
    .filter(r => r.method === 'POST' && r.path === `rpc/${fn}`)
    .map(r => ({ ...r, body: r.body as any }));
const recordGets = (w: World) => gets(w, 'issues?select=');

/** A response held until the test settles it. */
function deferred() {
  let resolve!: (r: TransportResponse) => void;
  const promise = new Promise<TransportResponse>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const SELECT_BASE = 'issues?select=id,display_name,name&order=display_name.asc,id.asc&id=eq.7';

describe('recordViewer: the record request', () => {
  it('serves the properties the legacy Detail page showed (ported 181)', async () => {
    const hidden = prop('internal', T.TextShort, { show_on_detail: false });
    const w = make({ props: [P.id, P.displayName, P.name, hidden] });
    await flush();
    expect(snap(w).properties.map(p => p.column_name)).toEqual(['id', 'display_name', 'name']);
    expect(snap(w).renderables.map(r => (r as SchemaEntityProperty).column_name)).toEqual(['id', 'display_name', 'name']);
  });

  it('adds the structural display_name to the detail properties when the schema hides it', async () => {
    const hiddenName = prop('display_name', T.TextShort, { show_on_detail: false });
    const w = make({ props: [P.id, P.name, hiddenName] });
    await flush();
    expect(snap(w).properties.map(p => p.column_name)).toEqual(['id', 'name', 'display_name']);
  });

  it('has empty properties and sends no record request when the entity is not in the schema (ported 198)', async () => {
    const w = make({ entity: null });
    await flush();
    expect(snap(w).properties).toEqual([]);
    expect(snap(w).record).toBeUndefined();
    expect(snap(w).notFound).toBe(false);
    expect(snap(w).loading).toBe(false);
    expect(snap(w).features).toBeUndefined();
    expect(sent(w)).toEqual([]);
  });

  it('sends the entity, the detail fields and the id filter (ported 208)', async () => {
    const w = make();
    await flush();
    expect(recordGets(w).map(r => r.path)).toEqual([SELECT_BASE]);
  });

  it('serves the first row of the response as the record (ported 236)', async () => {
    const w = make({ respond: ({ method, path }) => (method === 'GET' && path.startsWith('issues?select=') ? reply(200, [{ id: 7, name: 'first' }, { id: 8, name: 'second' }]) : undefined) });
    await flush();
    expect(snap(w).record).toEqual({ id: 7, name: 'first' });
    expect(snap(w).notFound).toBe(false);
    expect(snap(w).loading).toBe(false);
    expect(snap(w).error).toBeUndefined();
  });

  it('leaves the record undefined and flags notFound when no row matches (ported 251)', async () => {
    const w = make({ record: null });
    await flush();
    expect(snap(w).record).toBeUndefined();
    expect(snap(w).notFound).toBe(true);
    expect(snap(w).loading).toBe(false);
    expect(snap(w).error).toBeUndefined();
  });

  it('sends a string id unchanged and a numeric id as its text (ported 262)', async () => {
    const uuid = '3f2a0c1e-5b7d-4e8a-9c1d-0a1b2c3d4e5f';
    const a = make({ recordId: uuid });
    const b = make({ recordId: 42 });
    await flush();
    expect(recordGets(a)[0].path).toBe(`issues?select=id,display_name,name&order=display_name.asc,id.asc&id=eq.${uuid}`);
    expect(recordGets(b)[0].path).toBe('issues?select=id,display_name,name&order=display_name.asc,id.asc&id=eq.42');
  });

  it('selects every property type the way propertyToSelectString does (ported 1209)', async () => {
    const fk = prop('status_id', T.ForeignKeyName, { join_schema: 'public', join_table: 'Status', join_column: 'id' });
    const user = prop('owner_id', T.User, { join_table: 'civic_os_users', join_column: 'id' });
    const props = [P.id, P.displayName, P.name, P.geo, fk, user, P.payment, prop('photo', T.FileImage)];
    const w = make({ props });
    await flush();
    const select = recordGets(w)[0].path.split('select=')[1].split('&')[0];
    expect(select).toBe(props.map(propertyToSelectString).join(','));
    expect(select).toContain('location:location_text');
    expect(select).toContain('owner_id:civic_os_users!owner_id(id,display_name,full_name,phone,email)');
  });

  it('adds the columns the actions\' conditions read, once each, as bare names (dotted conditions use the base column)', async () => {
    const actions = [
      action('close', {
        visibility_condition: { field: 'priority', operator: 'eq', value: 'high' },
        enabled_condition: { field: 'status_id.status_key', operator: 'eq', value: 'open' },
      }),
      action('reopen', {
        visibility_condition: { field: 'name', operator: 'is_not_null' },
        enabled_condition: { or: [{ field: 'priority', operator: 'eq', value: 'low' }, { and: [{ field: 'owner', operator: 'is_null' }] }] } as any,
      }),
    ];
    const w = make({ actions, record: { id: 7, name: 'x', priority: 'high', status_id: { id: 1, status_key: 'open' }, owner: null } });
    await flush();
    expect(recordGets(w)[0].path).toBe('issues?select=id,display_name,name,priority,status_id,owner&order=display_name.asc,id.asc&id=eq.7');
    expect(snap(w).record).toMatchObject({ priority: 'high', status_id: { status_key: 'open' } });
    expect(snap(w).properties.map(p => p.column_name)).toEqual(['id', 'display_name', 'name']);
  });

  it('leaves the condition columns of actions the caller cannot execute in the request as the legacy page did', async () => {
    const hidden = action('secret', { can_execute: false, visibility_condition: { field: 'secret_col', operator: 'is_null' } });
    const w = make({ actions: [hidden] });
    await flush();
    expect(recordGets(w)[0].path).toContain('select=id,display_name,name,secret_col&');
  });
});

describe('recordViewer: properties and renderables', () => {
  it('flattens a pure M:M into related rows and selects its junction embed', async () => {
    const tags = m2m('tags');
    const w = make({
      props: [...BASE, tags],
      record: { id: 7, name: 'x', tags: [{ tags: { id: 1, display_name: 'Urgent' } }, { tags: { id: 2, display_name: 'Road' } }] },
    });
    await flush();
    expect(snap(w).record!['tags']).toEqual([{ id: 1, display_name: 'Urgent' }, { id: 2, display_name: 'Road' }]);
    expect(recordGets(w)[0].path).toBe(
      'issues?select=id,display_name,name,tags:issue_tags!issue_id(tags!tag_id(id,display_name))&order=display_name.asc,id.asc&id=eq.7',
    );
  });

  it('flattens a rich-junction M:M with its extra columns under _junction', async () => {
    const qty = prop('quantity', T.IntegerNumber);
    const tools = m2m('tools', { junctionTable: 'issue_tools', targetTable: 'tools', relatedTable: 'tools', targetColumn: 'tool_id', extraColumns: [qty] });
    const w = make({ props: [...BASE, tools], record: { id: 7, tools: [{ quantity: 3, tools: { id: 1, display_name: 'Mower' } }] } });
    await flush();
    expect(snap(w).record!['tools']).toEqual([{ id: 1, display_name: 'Mower', _junction: { quantity: 3 } }]);
  });

  it('flattens a parent-hop M:M through the intermediate tables and drops duplicates', async () => {
    const hops = m2m('saws', { junctionTable: 'issue_reservations', targetTable: 'reservations', relatedTable: 'tools', targetColumn: 'reservation_id', parentHops: [{ table: 'tools', fkColumn: 'tool_id' }] });
    const w = make({
      props: [...BASE, hops],
      record: { id: 7, saws: [{ reservations: { tools: { id: 5, display_name: 'Saw' } } }, { reservations: { tools: { id: 5, display_name: 'Saw' } } }, { reservations: null }] },
    });
    await flush();
    expect(snap(w).record!['saws']).toEqual([{ id: 5, display_name: 'Saw' }]);
  });

  it('turns an absent M:M value into an empty array', async () => {
    const w = make({ props: [...BASE, m2m('tags')], record: { id: 7, name: 'x' } });
    await flush();
    expect(snap(w).record!['tags']).toEqual([]);
  });

  it('keeps the M:M columns out of the entity columns that decide the default order', async () => {
    const w = make({ props: [P.id, P.name, m2m('tags')] });
    await flush();
    // no display_name column: the order falls back to id
    expect(recordGets(w)[0].path).toContain('&order=id.asc&');
  });

  it('splits inline from non-inline M:M properties and leaves show_on_detail=false out', async () => {
    const card = m2m('tags');
    const inline = m2m('labels', { junctionTable: 'issue_labels', targetTable: 'labels', relatedTable: 'labels' });
    (inline as any).show_inline = true;
    const hiddenM2m = m2m('flags', { junctionTable: 'issue_flags', targetTable: 'flags', relatedTable: 'flags' });
    (hiddenM2m as any).show_on_detail = false;
    const hiddenCol = prop('secret', T.TextShort, { show_on_detail: false });
    const w = make({ props: [...BASE, card, inline, hiddenM2m, hiddenCol] });
    await flush();
    expect(snap(w).inlineProperties.map(p => p.column_name)).toEqual(['id', 'display_name', 'name', 'labels']);
    expect(snap(w).manyToManyProperties.map(p => p.column_name)).toEqual(['tags']);
    expect(snap(w).properties.map(p => p.column_name)).toEqual(['id', 'display_name', 'name', 'tags', 'labels']);
  });

  it('serves the schema\'s renderables, static text blocks interspersed by sort_order', async () => {
    const block = staticText(1, 5, '## Note');
    const items: RenderableItem[] = [{ ...P.name, itemType: 'property' } as any, block, { ...P.id, itemType: 'property' } as any];
    const w = make({ renderables: items });
    await flush();
    expect(snap(w).renderables).toEqual(items);
  });

  it('exposes the entity\'s features and permissions from the live schema', async () => {
    const w = make({ entity: { supports_recurring: true, guided_form_key: 'intake', delete: false } });
    await flush();
    expect(snap(w).features).toMatchObject({ recurring: true, guidedFormKey: 'intake' });
    expect(snap(w).can).toMatchObject({ delete: false, update: true });
  });
});

describe('recordViewer: lifecycle', () => {
  it('starts loading and settles after the first load', async () => {
    const w = make();
    expect(snap(w).loading).toBe(true);
    expect(snap(w).record).toBeUndefined();
    await flush();
    expect(snap(w).loading).toBe(false);
    expect(snap(w).record).toEqual(DEFAULT_RECORD);
  });

  it('reports a failed record request as error with no record', async () => {
    const w = make({ respond: ({ method, path }) => (method === 'GET' && path.startsWith('issues?select=') ? reply(500, { message: 'boom' }) : undefined) });
    await flush();
    expect(snap(w).error).toBeInstanceOf(DataClientError);
    expect(snap(w).record).toBeUndefined();
    expect(snap(w).notFound).toBe(false);
    expect(snap(w).loading).toBe(false);
  });

  it('reports a schema failure as error and sends no record request', async () => {
    const row = entityRow();
    const ft = fakeTransport();
    const handle = mintEntityHandle({ peekEntities: () => [row], peekProperties: () => BASE, peekEntityActions: () => undefined }, 'issues');
    const viewer = recordViewer(
      {
        data: ft.client as DataClient,
        clock: createFakeClock('2026-10-21T12:00:00Z'),
        schema: {
          properties: async () => {
            throw new Error('schema down');
          },
          renderables: async () => [],
          actions: async () => [],
          inverseRelationships: async () => [],
          entities: async () => [row],
        },
      },
      handle,
      7,
    );
    await flush();
    expect(viewer.getSnapshot().error).toBeInstanceOf(Error);
    expect(viewer.getSnapshot().loading).toBe(false);
    expect(ft.requests).toEqual([]);
  });

  it('keeps the stale record while a reload runs, then replaces it', async () => {
    let calls = 0;
    const gate = deferred();
    const w = make({
      respond: ({ method, path }) => {
        if (method === 'GET' && path.startsWith('issues?select=')) {
          calls++;
          return calls === 1 ? reply(200, [{ id: 7, name: 'old' }]) : gate.promise;
        }
        return undefined;
      },
    });
    await flush();
    expect(snap(w).record).toEqual({ id: 7, name: 'old' });
    w.viewer.reload();
    expect(snap(w).loading).toBe(true);
    await flush();
    expect(snap(w).loading).toBe(true);
    expect(snap(w).record).toEqual({ id: 7, name: 'old' });
    gate.resolve(reply(200, [{ id: 7, name: 'new' }]));
    await flush();
    expect(snap(w).loading).toBe(false);
    expect(snap(w).record).toEqual({ id: 7, name: 'new' });
  });

  it('aborts the load in flight on reload and keeps only the newest result (latest wins)', async () => {
    const first = deferred();
    let calls = 0;
    const w = make({
      respond: ({ method, path }) => {
        if (method === 'GET' && path.startsWith('issues?select=')) {
          calls++;
          return calls === 1 ? first.promise : reply(200, [{ id: 7, name: 'second' }]);
        }
        return undefined;
      },
    });
    await flush();
    w.viewer.reload();
    await flush();
    first.resolve(reply(200, [{ id: 7, name: 'first' }]));
    await flush();
    expect(recordGets(w).map(r => r.aborted)).toEqual([true, undefined]);
    expect(snap(w).record).toEqual({ id: 7, name: 'second' });
  });

  it('re-reads the record and the sections on reload, but not the actions, the properties or the renderables (legacy refreshData)', async () => {
    const w = make({ actions: [action('a')], inverse: [inverseMeta('comments')], respond: ({ path }) => (path.startsWith('comments?') ? reply(200, [{ id: 1 }], { 'content-range': '0-0/1' }) : undefined) });
    const reads = { properties: vi.spyOn(w.deps.schema, 'properties'), renderables: vi.spyOn(w.deps.schema, 'renderables'), actions: vi.spyOn(w.deps.schema, 'actions') };
    await flush();
    expect(snap(w).actions.map(a => a.key)).toEqual(['a']);
    expect(snap(w).inverse).toHaveLength(1);
    w.state.actions = [action('b')];
    w.state.inverse = [];
    w.viewer.reload();
    await flush();
    expect(snap(w).actions.map(a => a.key)).toEqual(['a']);
    expect(snap(w).inverse).toEqual([]);
    expect(recordGets(w)).toHaveLength(2);
    expect([reads.properties.mock.calls.length, reads.renderables.mock.calls.length, reads.actions.mock.calls.length]).toEqual([1, 1, 1]);
  });

  it('reads the schema again on a reload when the first schema read failed', async () => {
    const w = make({ actions: [action('a')] });
    w.state.propertiesFail = true;
    await flush();
    expect(snap(w).error).toBeDefined();
    w.state.propertiesFail = false;
    w.viewer.reload();
    await flush();
    expect(snap(w).error).toBeUndefined();
    expect(snap(w).actions.map(a => a.key)).toEqual(['a']);
    expect(recordGets(w)).toHaveLength(1);
  });

  it('notifies subscribers on change and returns the same snapshot object between changes', async () => {
    const w = make();
    const listener = vi.fn();
    const off = w.viewer.subscribe(listener);
    const first = snap(w);
    expect(snap(w)).toBe(first);
    await flush();
    expect(listener).toHaveBeenCalled();
    const settled = snap(w);
    expect(snap(w)).toBe(settled);
    expect(settled).not.toBe(first);
    off();
    off();
    const calls = listener.mock.calls.length;
    w.viewer.reload();
    await flush();
    expect(listener.mock.calls.length).toBe(calls);
  });

  it('a viewer built for the next route id loads that record, and the disposed one never publishes its own (ported 282)', async () => {
    const gate = deferred();
    const w = make({ respond: ({ method, path }) => (method === 'GET' && path.includes('id=eq.7') ? gate.promise : method === 'GET' && path.includes('id=eq.8') ? reply(200, [{ id: 8, name: 'next' }]) : undefined) });
    await flush();
    const first = vi.fn();
    w.viewer.subscribe(first);
    w.viewer.dispose();
    const next = recordViewer(w.deps, w.handle, 8);
    await flush();
    gate.resolve(reply(200, [{ id: 7, name: 'stale' }]));
    await flush();
    expect(next.getSnapshot().record).toEqual({ id: 8, name: 'next' });
    expect(first).not.toHaveBeenCalled();
    expect(recordGets(w).map(r => [r.path.match(/id=eq\.(\d+)/)?.[1], Boolean(r.aborted)])).toEqual([['7', true], ['8', false]]);
    next.dispose();
  });

  it('aborts the load on dispose, publishes nothing after it and leaves no stale record (ported 339)', async () => {
    const gate = deferred();
    const w = make({ respond: ({ method, path }) => (method === 'GET' && path.startsWith('issues?select=') ? gate.promise : undefined) });
    await flush();
    const listener = vi.fn();
    w.viewer.subscribe(listener);
    w.viewer.dispose();
    gate.resolve(reply(200, [{ id: 7, name: 'late' }]));
    await flush();
    expect(recordGets(w).map(r => r.aborted)).toEqual([true]);
    expect(snap(w).record).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it('makes reload and the commands throw after dispose, and dispose twice is harmless', async () => {
    const w = make({ actions: [action('go')] });
    await flush();
    const handle = w.viewer.action('go')!;
    w.viewer.dispose();
    w.viewer.dispose();
    expect(() => w.viewer.reload()).toThrow('recordViewer is disposed');
    expect(() => w.viewer.deleteRecord()).toThrow('recordViewer is disposed');
    expect(() => w.viewer.initiatePayment()).toThrow('recordViewer is disposed');
    expect(() => w.viewer.submitGuidedForm()).toThrow('recordViewer is disposed');
    expect(() => handle.run()).toThrow('recordViewer is disposed');
  });
});

describe('recordViewer: actions', () => {
  it('lists the executable actions in sort_order with their live state', async () => {
    const actions = [
      action('b', { sort_order: 2, display_name: 'Beta', description: 'Does b', icon: 'bolt', button_style: 'error', requires_confirmation: true, confirmation_message: 'Sure?', default_success_message: 'Done' }),
      action('a', { sort_order: 1 }),
      action('c', { sort_order: 3, can_execute: false }),
    ];
    const w = make({ actions });
    await flush();
    expect(snap(w).actions.map(a => a.key)).toEqual(['a', 'b']);
    expect(snap(w).actions[1]).toMatchObject({
      key: 'b',
      displayName: 'Beta',
      description: 'Does b',
      icon: 'bolt',
      buttonStyle: 'error',
      sortOrder: 2,
      requiresConfirmation: true,
      confirmationMessage: 'Sure?',
      defaultSuccessMessage: 'Done',
      visible: true,
      enabled: true,
      parameters: [],
    });
    expect(w.viewer.action('c')).toBeUndefined();
  });

  it('lists no actions before the record is there', async () => {
    const w = make({ actions: [action('a')], record: null });
    await flush();
    expect(snap(w).actions).toEqual([]);
    expect(w.viewer.action('a')).toBeUndefined();
  });

  it('evaluates visible and enabled against the record, and picks the tooltip', async () => {
    const actions = [
      action('open', { description: 'Open it', visibility_condition: { field: 'status_id.status_key', operator: 'eq', value: 'open' }, enabled_condition: { field: 'priority', operator: 'eq', value: 'high' }, disabled_tooltip: 'Only high priority' }),
      action('hidden', { visibility_condition: { field: 'status_id.status_key', operator: 'eq', value: 'closed' } }),
      action('plain', { description: 'Plain', disabled_tooltip: 'never shown' }),
    ];
    const w = make({ actions, record: { id: 7, name: 'x', priority: 'low', status_id: { id: 1, status_key: 'open' } } });
    await flush();
    const by = Object.fromEntries(snap(w).actions.map(a => [a.key, a]));
    expect(by['open']).toMatchObject({ visible: true, enabled: false, tooltip: 'Only high priority' });
    expect(by['hidden']).toMatchObject({ visible: false, enabled: true });
    expect(by['plain']).toMatchObject({ visible: true, enabled: true, tooltip: 'Plain' });
  });

  it('gives the parameters in sort_order', async () => {
    const w = make({ actions: [action('go', { parameters: [param('p_b', 'text', { sort_order: 2 }), param('p_a', 'text', { sort_order: 1 })] })] });
    await flush();
    expect(snap(w).actions[0].parameters.map(p => p.param_name)).toEqual(['p_a', 'p_b']);
  });

  it('returns a handle for a listed action and none for an unknown key', async () => {
    const w = make({ actions: [action('go')] });
    await flush();
    expect(w.viewer.action('go')?.key).toBe('go');
    expect(w.viewer.action('nope')).toBeUndefined();
  });

  it('keeps every action through a reload and re-evaluates state() against the reloaded record', async () => {
    let calls = 0;
    const w = make({
      actions: [action('go', { visibility_condition: { field: 'name', operator: 'eq', value: 'Pothole' } as any })],
      respond: ({ method, path }) => {
        if (method !== 'GET' || !path.startsWith('issues?select=')) return undefined;
        calls++;
        return reply(200, [{ id: 7, display_name: 'Pothole', name: calls === 1 ? 'Pothole' : 'Fixed' }]);
      },
    });
    await flush();
    const handle = w.viewer.action('go')!;
    expect(handle.state()?.visible).toBe(true);
    w.state.actions = [];
    w.viewer.reload();
    await flush();
    expect(handle.state()?.visible).toBe(false);
    expect(w.viewer.action('go')?.key).toBe('go');
  });

  it('opens no parameter session for an action without parameters', async () => {
    const w = make({ actions: [action('go')] });
    await flush();
    expect(w.viewer.action('go')!.openParams()).toBeUndefined();
  });
});

describe('recordViewer: running an action', () => {
  it('sends only p_entity_id for an action without parameters (ported 521)', async () => {
    const w = make({ actions: [action('go')], respond: ({ path }) => (path === 'rpc/do_go' ? reply(200, { success: true }) : undefined) });
    await flush();
    const result = await w.viewer.action('go')!.run();
    expect(rpcs(w, 'do_go').map(r => r.body)).toEqual([{ p_entity_id: 7 }]);
    expect(result).toMatchObject({ status: 'succeeded' });
  });

  it('sends the parameter values after p_entity_id (ported 493)', async () => {
    const params = [param('p_reason', 'text', { required: true }), param('p_count', 'number', { sort_order: 2 })];
    const w = make({ actions: [action('go', { parameters: params })], respond: ({ path }) => (path === 'rpc/do_go' ? reply(200, { success: true }) : undefined) });
    await flush();
    const result = await w.viewer.action('go')!.run({ p_reason: 'because', p_count: '4' });
    expect(rpcs(w, 'do_go').map(r => r.body)).toEqual([{ p_entity_id: 7, p_reason: 'because', p_count: 4 }]);
    expect(result.status).toBe('succeeded');
  });

  it('resolves invalid with the missing names and sends nothing for an empty required parameter (ported 443)', async () => {
    const w = make({ actions: [action('go', { parameters: [param('p_reason', 'text', { required: true }), param('p_note', 'text', { required: true, sort_order: 2 })] })] });
    await flush();
    const result = await w.viewer.action('go')!.run({ p_note: 'ok' });
    expect(result).toEqual({ status: 'invalid', missing: ['p_reason'] });
    expect(rpcs(w, 'do_go')).toEqual([]);
  });

  it('treats null, undefined, an empty string and an empty array as empty for a required parameter (ported 482)', async () => {
    const w = make({ actions: [action('go', { parameters: [param('a', 'text', { required: true }), param('b', 'text', { required: true, sort_order: 2 }), param('c', 'text', { required: true, sort_order: 3 }), param('d', 'text', { required: true, sort_order: 4 })] })] });
    await flush();
    const result = await w.viewer.action('go')!.run({ a: null, b: undefined, c: '', d: [] });
    expect(result).toEqual({ status: 'invalid', missing: ['a', 'b', 'c', 'd'] });
  });

  it('sends nothing while the required form is invalid (ported 578)', async () => {
    const w = make({ actions: [action('go', { parameters: [param('p_reason', 'text', { required: true })] })] });
    await flush();
    await w.viewer.action('go')!.run();
    await w.viewer.action('go')!.run({ p_reason: null });
    expect(sent(w).filter(r => r.method === 'POST')).toEqual([]);
  });

  it('leaves out the empty values of optional parameters (ported 1176)', async () => {
    const params = [param('p_a', 'text'), param('p_b', 'text', { sort_order: 2 }), param('p_c', 'number', { sort_order: 3 }), param('p_d', 'text', { sort_order: 4 })];
    const w = make({ actions: [action('go', { parameters: params })], respond: ({ path }) => (path === 'rpc/do_go' ? reply(200, null) : undefined) });
    await flush();
    await w.viewer.action('go')!.run({ p_a: null, p_b: '', p_c: undefined, p_d: 'kept' });
    expect(rpcs(w, 'do_go')[0].body).toEqual({ p_entity_id: 7, p_d: 'kept' });
  });

  it('collects number and money as numbers, boolean as boolean and datetime_local as UTC ISO', async () => {
    const params = [
      param('p_n', 'number', { required: true }),
      param('p_m', 'money', { sort_order: 2 }),
      param('p_flag', 'boolean', { sort_order: 3 }),
      param('p_off', 'boolean', { sort_order: 4 }),
      param('p_when', 'datetime_local', { sort_order: 5 }),
      param('p_zero', 'number', { sort_order: 6 }),
    ];
    const w = make({ actions: [action('go', { parameters: params })] });
    await flush();
    await w.viewer.action('go')!.run({ p_n: '12.5', p_m: '3', p_flag: 'yes', p_off: false, p_when: '2026-10-21T08:30:00Z', p_zero: 0 });
    expect(rpcs(w, 'do_go')[0].body).toEqual({
      p_entity_id: 7,
      p_n: 12.5,
      p_m: 3,
      p_flag: true,
      p_off: false,
      p_when: '2026-10-21T08:30:00.000Z',
      p_zero: 0,
    });
  });

  it('sends a numeric record id as a number and a string id as the string given', async () => {
    const a = make({ actions: [action('go')], recordId: 7 });
    const b = make({ actions: [action('go')], recordId: '7' });
    await flush();
    await a.viewer.action('go')!.run();
    await b.viewer.action('go')!.run();
    expect(rpcs(a, 'do_go')[0].body.p_entity_id).toBe(7);
    expect(rpcs(b, 'do_go')[0].body.p_entity_id).toBe('7');
  });

  it('resolves failed with the RPC message when the body says success false', async () => {
    const w = make({ actions: [action('go')], respond: ({ path }) => (path === 'rpc/do_go' ? reply(200, { success: false, message: 'Not allowed today' }) : undefined) });
    await flush();
    expect(await w.viewer.action('go')!.run()).toEqual({ status: 'failed', message: 'Not allowed today' });
  });

  it('resolves failed without a message when a success false body has none', async () => {
    const w = make({ actions: [action('go')], respond: ({ path }) => (path === 'rpc/do_go' ? reply(200, { success: false }) : undefined) });
    await flush();
    expect(await w.viewer.action('go')!.run()).toEqual({ status: 'failed' });
  });

  it('resolves failed with the humanized message when the request is rejected', async () => {
    const w = make({ actions: [action('go')], respond: ({ path }) => (path === 'rpc/do_go' ? reply(409, { code: '23505', message: 'duplicate key value' }) : undefined) });
    await flush();
    const result = await w.viewer.action('go')!.run();
    expect(result).toEqual({ status: 'failed', message: humanizeError({ httpCode: 409, code: '23505', message: 'duplicate key value' }) });
  });

  it('resolves a raised exception\'s own text as the message', async () => {
    const w = make({ actions: [action('go')], respond: ({ path }) => (path === 'rpc/do_go' ? reply(400, { code: 'P0001', message: 'Cannot close an open task' }) : undefined) });
    await flush();
    expect(await w.viewer.action('go')!.run()).toEqual({ status: 'failed', message: 'Cannot close an open task' });
  });

  it('resolves failed with no message for a network failure', async () => {
    const w = make({
      actions: [action('go')],
      respond: ({ path }) => (path === 'rpc/do_go' ? (Promise.reject(new Error('offline')) as unknown as Promise<TransportResponse>) : undefined),
    });
    await flush();
    const result = await w.viewer.action('go')!.run();
    expect(result.status).toBe('failed');
  });

  it('prefers the RPC\'s message, navigate_to and refresh over the action\'s defaults', async () => {
    const w = make({
      actions: [action('go', { default_success_message: 'Default', default_navigate_to: '/default', refresh_after_action: false })],
      respond: ({ path }) => (path === 'rpc/do_go' ? reply(200, { success: true, message: 'From RPC', navigate_to: '/rpc', refresh: true }) : undefined),
    });
    await flush();
    expect(await w.viewer.action('go')!.run()).toEqual({
      status: 'succeeded',
      message: 'From RPC',
      navigateTo: '/rpc',
      refresh: true,
      result: { success: true, message: 'From RPC', navigate_to: '/rpc', refresh: true },
    });
  });

  it('falls back to the action\'s default message, navigation and refresh', async () => {
    const w = make({
      actions: [action('go', { default_success_message: 'Default', default_navigate_to: '/default', refresh_after_action: true })],
      respond: ({ path }) => (path === 'rpc/do_go' ? reply(200, { success: true }) : undefined),
    });
    await flush();
    expect(await w.viewer.action('go')!.run()).toMatchObject({ status: 'succeeded', message: 'Default', navigateTo: '/default', refresh: true });
  });

  it('lets an RPC\'s refresh false override refresh_after_action true, and succeeds on an empty body', async () => {
    const a = make({ actions: [action('go', { refresh_after_action: true })], respond: ({ path }) => (path === 'rpc/do_go' ? reply(200, { success: true, refresh: false }) : undefined) });
    const b = make({ actions: [action('go')], respond: ({ path }) => (path === 'rpc/do_go' ? reply(200, null) : undefined) });
    await flush();
    expect(await a.viewer.action('go')!.run()).toMatchObject({ status: 'succeeded', refresh: false });
    expect(await b.viewer.action('go')!.run()).toEqual({ status: 'succeeded', refresh: false, result: undefined });
  });

  it('does not reload the record after a run', async () => {
    const w = make({ actions: [action('go', { refresh_after_action: true })] });
    await flush();
    await w.viewer.action('go')!.run();
    expect(recordGets(w)).toHaveLength(1);
  });
});

describe('recordViewer: parameter sessions', () => {
  const go = (parameters: EntityActionParam[]) => [action('go', { parameters })];
  const open = async (w: World) => {
    await flush();
    return w.viewer.action('go')!.openParams()!;
  };

  it('defaults a boolean without a default to false (ported 542)', async () => {
    const w = make({ actions: go([param('p_flag', 'boolean')]) });
    const session = await open(w);
    expect(session.getSnapshot().values).toEqual({ p_flag: false });
  });

  it('casts default_value by type (ported 553)', async () => {
    const params = [
      param('p_n', 'number', { default_value: '42' }),
      param('p_m', 'money', { default_value: '9.5', sort_order: 2 }),
      param('p_bad', 'number', { default_value: 'abc', sort_order: 3 }),
      param('p_t', 'boolean', { default_value: 'true', sort_order: 4 }),
      param('p_one', 'boolean', { default_value: '1', sort_order: 5 }),
      param('p_f', 'boolean', { default_value: 'no', sort_order: 6 }),
      param('p_text', 'text', { default_value: 'hello', sort_order: 7 }),
      param('p_none', 'text', { sort_order: 8 }),
    ];
    const w = make({ actions: go(params) });
    const session = await open(w);
    expect(session.getSnapshot().values).toEqual({ p_n: 42, p_m: 9.5, p_bad: null, p_t: true, p_one: true, p_f: false, p_text: 'hello', p_none: null });
  });

  it('starts a photo_gallery parameter at null (ported 1091)', async () => {
    const w = make({ actions: go([param('p_photos', 'photo_gallery', { target_column: 'photos' })]) });
    const session = await open(w);
    expect(session.getSnapshot().values).toEqual({ p_photos: null });
    expect(session.getSnapshot().options).toEqual({});
  });

  it('sends a value set on the session when the action runs (ported 697)', async () => {
    const w = make({ actions: go([param('p_file', 'file', { required: true })]) });
    const session = await open(w);
    session.setValue('p_file', '9b2f7c1a-1111-4222-8333-444455556666');
    const result = await w.viewer.action('go')!.run(session.getSnapshot().values);
    expect(result.status).toBe('succeeded');
    expect(rpcs(w, 'do_go')[0].body).toEqual({ p_entity_id: 7, p_file: '9b2f7c1a-1111-4222-8333-444455556666' });
  });

  it('sends a gallery UUID set on the session to the RPC (ported 1130)', async () => {
    const w = make({ actions: go([param('p_photos', 'photo_gallery', { required: true })]) });
    const session = await open(w);
    session.setValue('p_photos', 'gal-uuid-1');
    await w.viewer.action('go')!.run(session.getSnapshot().values);
    expect(rpcs(w, 'do_go')[0].body).toEqual({ p_entity_id: 7, p_photos: 'gal-uuid-1' });
  });

  it('ignores a value for an unknown parameter and notifies subscribers of a known one', async () => {
    const w = make({ actions: go([param('p_a', 'text')]) });
    const session = await open(w);
    const listener = vi.fn();
    session.subscribe(listener);
    session.setValue('nope', 1);
    expect(listener).not.toHaveBeenCalled();
    session.setValue('p_a', 'x');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().values).toEqual({ p_a: 'x' });
  });

  it('loads a foreign_key parameter\'s options as id and display_name (ported 725)', async () => {
    const respond: Route = ({ method, path }) =>
      method === 'GET' && path.startsWith('tags?') ? reply(200, [{ id: 1, display_name: 'A' }, { id: 2, display_name: 'B' }]) : undefined;
    const w = make({ actions: go([param('p_tag', 'foreign_key', { join_table: 'tags', join_column: 'id' })]), respond });
    const session = await open(w);
    await flush();
    expect(gets(w, 'tags?').map(r => r.path)).toEqual(['tags?select=id,display_name&order=display_name.asc']);
    expect(session.getSnapshot().options['p_tag']).toEqual([{ id: 1, display_name: 'A' }, { id: 2, display_name: 'B' }]);
    expect(session.getSnapshot().loading).toEqual([]);
  });

  it('adds join_column to the selected fields when it is another column (ported 750)', async () => {
    const w = make({ actions: go([param('p_tag', 'foreign_key', { join_table: 'tags', join_column: 'color' })]) });
    await open(w);
    await flush();
    expect(gets(w, 'tags?').map(r => r.path)).toEqual(['tags?select=id,display_name,color&order=display_name.asc']);
  });

  it('marks a parameter as loading while its options are in flight', async () => {
    const gate = deferred();
    const w = make({ actions: go([param('p_tag', 'foreign_key', { join_table: 'tags', join_column: 'id' })]), respond: ({ path }) => (path.startsWith('tags?') ? gate.promise : undefined) });
    const session = await open(w);
    expect(session.getSnapshot().loading).toEqual(['p_tag']);
    gate.resolve(reply(200, [{ id: 1, display_name: 'A' }]));
    await flush();
    expect(session.getSnapshot().loading).toEqual([]);
  });

  it('loads status, category and user options from their sources', async () => {
    const params = [
      param('p_status', 'status', { status_entity_type: 'issue' }),
      param('p_cat', 'category', { category_entity_type: 'issue_kind', sort_order: 2 }),
      param('p_user', 'user', { sort_order: 3 }),
    ];
    const respond: Route = ({ method, path }) => (method === 'GET' && !path.startsWith('issues?') ? reply(200, [{ id: 1, display_name: path }]) : undefined);
    const w = make({ actions: go(params), respond });
    const session = await open(w);
    await flush();
    const paths = sent(w).filter(r => !r.path.startsWith('issues?')).map(r => r.path);
    expect(paths).toContain('statuses?select=id,display_name&order=sort_order.asc&entity_type=eq.issue');
    expect(paths).toContain('categories?select=id,display_name&order=sort_order.asc&entity_type=eq.issue_kind');
    expect(paths).toContain('civic_os_users?select=id,display_name&order=display_name.asc');
    expect(Object.keys(session.getSnapshot().options).sort()).toEqual(['p_cat', 'p_status', 'p_user']);
  });

  it('loads an options_source_rpc parameter through the RPC (ported 782)', async () => {
    const respond: Route = ({ path }) => (path === 'rpc/get_options' ? reply(200, [{ id: 3, display_name: 'Three' }]) : undefined);
    const w = make({ actions: go([param('p_opt', 'foreign_key', { options_source_rpc: 'get_options', join_table: 'things', join_column: 'id' })]), respond });
    const session = await open(w);
    await flush();
    expect(rpcs(w, 'get_options').map(r => r.body)).toEqual([{ p_id: 7, p_depends_on: {} }]);
    expect(gets(w, 'things?')).toEqual([]);
    expect(session.getSnapshot().options['p_opt']).toEqual([{ id: 3, display_name: 'Three' }]);
  });

  it('sends p_id as the number the string id parses to, else the string, and null without an id (ported 811)', async () => {
    const respond: Route = ({ path }) => (path === 'rpc/get_options' ? reply(200, [{ id: 1, display_name: 'x' }]) : undefined);
    const params = [
      param('p_site', 'text', { default_value: 'north' }),
      param('p_opt', 'foreign_key', { options_source_rpc: 'get_options', depends_on_params: ['p_site'], sort_order: 2 }),
    ];
    const worlds = [
      make({ actions: go(params), recordId: '7', respond }),
      make({ actions: go(params), recordId: 'abc', respond }),
      make({ actions: go(params), recordId: 7, respond }),
      make({ actions: go(params), recordId: '', respond }),
    ];
    for (const w of worlds) {
      await open(w);
    }
    await flush();
    expect(worlds.map(w => rpcs(w, 'get_options').map(r => r.body.p_id))).toEqual([[7], ['abc'], [7], [null]]);
  });

  it('skips the initial RPC load while every dependency is null (ported 851)', async () => {
    const params = [
      param('p_site', 'foreign_key', { join_table: 'sites', join_column: 'id' }),
      param('p_opt', 'foreign_key', { options_source_rpc: 'get_options', depends_on_params: ['p_site'], sort_order: 2 }),
    ];
    const w = make({ actions: go(params) });
    const session = await open(w);
    await flush();
    expect(rpcs(w, 'get_options')).toEqual([]);
    expect(session.getSnapshot().options['p_opt']).toBeUndefined();
    expect(session.getSnapshot().loading).toEqual([]);
  });

  it('loads with the dependency values once one has a value, p_depends_on keyed by name (ported 811)', async () => {
    const params = [
      param('p_site', 'text', { default_value: 'north' }),
      param('p_opt', 'foreign_key', { options_source_rpc: 'get_options', depends_on_params: ['p_site', 'p_zone'], sort_order: 2 }),
      param('p_zone', 'text', { sort_order: 3 }),
    ];
    const respond: Route = ({ path }) => (path === 'rpc/get_options' ? reply(200, [{ id: 1, display_name: 'x' }]) : undefined);
    const w = make({ actions: go(params), respond, recordId: '7' });
    await open(w);
    await flush();
    expect(rpcs(w, 'get_options').map(r => r.body)).toEqual([{ p_id: 7, p_depends_on: { p_site: 'north', p_zone: null } }]);
  });

  describe('dependent parameters (debounced)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const dependent = (extra: Partial<EntityActionParam> = {}) => [
      param('p_site', 'text'),
      param('p_opt', 'foreign_key', { options_source_rpc: 'get_options', depends_on_params: ['p_site'], sort_order: 2, ...extra }),
    ];
    const optionsFor: Route = ({ path, body }) => {
      if (path !== 'rpc/get_options') return undefined;
      const site = body.p_depends_on.p_site;
      return reply(200, [{ id: `${site}-1`, display_name: `${site} one` }, { id: `${site}-2`, display_name: `${site} two` }]);
    };
    const settle = () => vi.advanceTimersByTimeAsync(0);

    it('re-fetches the options after the debounce when a dependency changes (ported 884)', async () => {
      vi.useFakeTimers();
      const w = make({ actions: go(dependent()), respond: optionsFor });
      await settle();
      const session = w.viewer.action('go')!.openParams()!;
      await settle();
      session.setValue('p_site', 'north');
      await vi.advanceTimersByTimeAsync(299);
      expect(rpcs(w, 'get_options')).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(rpcs(w, 'get_options').map(r => r.body)).toEqual([{ p_id: 7, p_depends_on: { p_site: 'north' } }]);
      expect(session.getSnapshot().options['p_opt']).toEqual([{ id: 'north-1', display_name: 'north one' }, { id: 'north-2', display_name: 'north two' }]);
    });

    it('collapses a burst of changes into one re-fetch with the last value', async () => {
      vi.useFakeTimers();
      const w = make({ actions: go(dependent()), respond: optionsFor });
      await settle();
      const session = w.viewer.action('go')!.openParams()!;
      session.setValue('p_site', 'a');
      await vi.advanceTimersByTimeAsync(100);
      session.setValue('p_site', 'b');
      await vi.advanceTimersByTimeAsync(300);
      expect(rpcs(w, 'get_options').map(r => r.body.p_depends_on)).toEqual([{ p_site: 'b' }]);
    });

    it('uses the paramDebounceMs option', async () => {
      vi.useFakeTimers();
      const w = make({ actions: go(dependent()), respond: optionsFor, options: { paramDebounceMs: 50 } });
      await settle();
      const session = w.viewer.action('go')!.openParams()!;
      session.setValue('p_site', 'a');
      await vi.advanceTimersByTimeAsync(49);
      expect(rpcs(w, 'get_options')).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(rpcs(w, 'get_options')).toHaveLength(1);
    });

    it('clears the options and the value at once when every dependency is cleared (ported 930)', async () => {
      vi.useFakeTimers();
      const w = make({ actions: go(dependent()), respond: optionsFor });
      await settle();
      const session = w.viewer.action('go')!.openParams()!;
      session.setValue('p_site', 'north');
      await vi.advanceTimersByTimeAsync(300);
      session.setValue('p_opt', 'north-1');
      session.setValue('p_site', null);
      await vi.advanceTimersByTimeAsync(300);
      expect(session.getSnapshot().options['p_opt']).toEqual([]);
      expect(session.getSnapshot().values['p_opt']).toBeNull();
      expect(rpcs(w, 'get_options')).toHaveLength(1);
    });

    it('nulls a selection that is not among the new options (ported 979)', async () => {
      vi.useFakeTimers();
      const w = make({ actions: go(dependent()), respond: optionsFor });
      await settle();
      const session = w.viewer.action('go')!.openParams()!;
      session.setValue('p_site', 'north');
      await vi.advanceTimersByTimeAsync(300);
      session.setValue('p_opt', 'north-2');
      session.setValue('p_site', 'south');
      await vi.advanceTimersByTimeAsync(300);
      expect(session.getSnapshot().values['p_opt']).toBeNull();
      expect(session.getSnapshot().options['p_opt']).toEqual([{ id: 'south-1', display_name: 'south one' }, { id: 'south-2', display_name: 'south two' }]);
    });

    it('keeps a selection that is still among the new options, comparing ids as text', async () => {
      vi.useFakeTimers();
      const respond: Route = ({ path }) => (path === 'rpc/get_options' ? reply(200, [{ id: 5, display_name: 'Five' }]) : undefined);
      const w = make({ actions: go(dependent()), respond });
      await settle();
      const session = w.viewer.action('go')!.openParams()!;
      session.setValue('p_site', 'north');
      session.setValue('p_opt', '5');
      await vi.advanceTimersByTimeAsync(300);
      expect(session.getSnapshot().values['p_opt']).toBe('5');
    });

    it('cancels pending re-fetches on dispose (ported 1037)', async () => {
      vi.useFakeTimers();
      const w = make({ actions: go(dependent()), respond: optionsFor });
      await settle();
      const session = w.viewer.action('go')!.openParams()!;
      session.setValue('p_site', 'north');
      session.dispose();
      await vi.advanceTimersByTimeAsync(1000);
      session.setValue('p_site', 'south');
      await vi.advanceTimersByTimeAsync(1000);
      expect(rpcs(w, 'get_options')).toEqual([]);
    });

    it('cancels pending re-fetches and aborts open sessions when the viewer is disposed', async () => {
      vi.useFakeTimers();
      const w = make({ actions: go(dependent()), respond: optionsFor });
      await settle();
      const session = w.viewer.action('go')!.openParams()!;
      session.setValue('p_site', 'north');
      w.viewer.dispose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(rpcs(w, 'get_options')).toEqual([]);
      expect(session.getSnapshot().options['p_opt']).toBeUndefined();
    });

    it('chains: clearing a dependency clears a parameter that depends on the cleared one', async () => {
      vi.useFakeTimers();
      const params = [
        param('p_a', 'text'),
        param('p_b', 'foreign_key', { options_source_rpc: 'get_b', depends_on_params: ['p_a'], sort_order: 2 }),
        param('p_c', 'foreign_key', { options_source_rpc: 'get_c', depends_on_params: ['p_b'], sort_order: 3 }),
      ];
      const respond: Route = ({ path }) =>
        path === 'rpc/get_b' ? reply(200, [{ id: 'b1', display_name: 'B1' }]) : path === 'rpc/get_c' ? reply(200, [{ id: 'c1', display_name: 'C1' }]) : undefined;
      const w = make({ actions: go(params), respond });
      await settle();
      const session = w.viewer.action('go')!.openParams()!;
      session.setValue('p_a', 'x');
      await vi.advanceTimersByTimeAsync(300);
      session.setValue('p_b', 'b1');
      await vi.advanceTimersByTimeAsync(300);
      session.setValue('p_c', 'c1');
      session.setValue('p_a', null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(session.getSnapshot().options['p_b']).toEqual([]);
      expect(session.getSnapshot().values['p_b']).toBeNull();
      expect(session.getSnapshot().options['p_c']).toEqual([]);
      expect(session.getSnapshot().values['p_c']).toBeNull();
    });
  });

  it('gives [] when an options_source_rpc fails, leaving the other parameters\' options intact', async () => {
    const params = [
      param('p_opt', 'foreign_key', { options_source_rpc: 'get_options' }),
      param('p_tag', 'foreign_key', { join_table: 'tags', join_column: 'id', sort_order: 2 }),
    ];
    const respond: Route = ({ method, path }) =>
      path === 'rpc/get_options' ? reply(500, { message: 'nope' }) : method === 'GET' && path.startsWith('tags?') ? reply(200, [{ id: 1, display_name: 'A' }]) : undefined;
    const w = make({ actions: go(params), respond });
    const session = await open(w);
    await flush();
    expect(session.getSnapshot().options).toEqual({ p_opt: [], p_tag: [{ id: 1, display_name: 'A' }] });
  });

  it('leaves every parameter of the batch without options when one table request fails (the legacy forkJoin)', async () => {
    const params = [
      param('p_tag', 'foreign_key', { join_table: 'tags', join_column: 'id' }),
      param('p_user', 'user', { sort_order: 2 }),
    ];
    const respond: Route = ({ method, path }) =>
      method === 'GET' && path.startsWith('tags?') ? reply(500, { message: 'down' }) : method === 'GET' && path.startsWith('civic_os_users?') ? reply(200, [{ id: 'u1', display_name: 'Una' }]) : undefined;
    const w = make({ actions: go(params), respond });
    const session = await open(w);
    await flush();
    expect(session.getSnapshot().options).toEqual({});
    expect(session.getSnapshot().loading).toEqual([]);
  });

  it('stops notifying after the session is disposed and ignores later values (ported 564)', async () => {
    const w = make({ actions: go([param('p_a', 'text', { default_value: 'x' })]) });
    const session = await open(w);
    const listener = vi.fn();
    session.subscribe(listener);
    session.dispose();
    session.dispose();
    session.setValue('p_a', 'y');
    expect(listener).not.toHaveBeenCalled();
    expect(session.getSnapshot().values).toEqual({ p_a: 'x' });
  });

  it('opens an independent session each time', async () => {
    const w = make({ actions: go([param('p_a', 'text')]) });
    await flush();
    const first = w.viewer.action('go')!.openParams()!;
    first.setValue('p_a', 'x');
    first.dispose();
    const second = w.viewer.action('go')!.openParams()!;
    expect(second.getSnapshot().values).toEqual({ p_a: null });
  });
});

describe('recordViewer: payment', () => {
  const paid = (status: string, over: Record<string, unknown> = {}) => ({ id: 7, name: 'x', payment_id: { id: 'pay-1', status, amount: 10, ...over } });
  const PAY = { payment_initiation_rpc: 'initiate_payment' };
  const props = [...BASE, P.payment];

  it('is null without a payment_initiation_rpc and without a Payment property', async () => {
    const a = make({ props });
    const b = make({ entity: PAY, props: BASE });
    await flush();
    expect(snap(a).payment).toBeNull();
    expect(snap(b).payment).toBeNull();
  });

  it('is available with no payment on the record, and does not resume (ported 1380)', async () => {
    const w = make({ entity: PAY, props, record: { id: 7, name: 'x', payment_id: null } });
    await flush();
    expect(snap(w).payment).toEqual({ available: true, resume: false, payment: undefined, loading: false });
  });

  it('resumes a pending payment (ported 1389)', async () => {
    const w = make({ entity: PAY, props, record: paid('pending') });
    await flush();
    expect(snap(w).payment).toMatchObject({ available: true, resume: true, payment: { id: 'pay-1', status: 'pending' } });
  });

  it('is not available once the payment succeeded, and does not resume', async () => {
    const w = make({ entity: PAY, props, record: paid('succeeded') });
    await flush();
    expect(snap(w).payment).toMatchObject({ available: false, resume: false });
  });

  it('can start a failed or canceled payment again', async () => {
    const a = make({ entity: PAY, props, record: paid('failed') });
    const b = make({ entity: PAY, props, record: paid('canceled') });
    await flush();
    expect(snap(a).payment).toMatchObject({ available: true });
    expect(snap(b).payment).toMatchObject({ available: true });
  });

  it('is not available without a record', async () => {
    const w = make({ entity: PAY, props, record: null });
    await flush();
    expect(snap(w).payment).toMatchObject({ available: false, resume: false, payment: undefined });
  });

  it('reuses a pending payment without an RPC', async () => {
    const w = make({ entity: PAY, props, record: paid('pending') });
    await flush();
    expect(await w.viewer.initiatePayment()).toEqual({ status: 'checkout', paymentId: 'pay-1' });
    expect(rpcs(w, 'initiate_payment')).toEqual([]);
  });

  it('reuses a pending_intent payment without an RPC', async () => {
    const w = make({ entity: PAY, props, record: paid('pending_intent') });
    await flush();
    expect(await w.viewer.initiatePayment()).toEqual({ status: 'checkout', paymentId: 'pay-1' });
    expect(rpcs(w, 'initiate_payment')).toEqual([]);
  });

  it('calls the RPC with p_entity_id as given for a failed, canceled or missing payment', async () => {
    const respond: Route = ({ path }) => (path === 'rpc/initiate_payment' ? reply(200, '"pay-new"') : undefined);
    const a = make({ entity: PAY, props, record: paid('failed'), respond });
    const b = make({ entity: PAY, props, record: paid('canceled'), respond, recordId: '7' });
    const c = make({ entity: PAY, props, record: { id: 7, name: 'x', payment_id: null }, respond });
    await flush();
    expect(await a.viewer.initiatePayment()).toEqual({ status: 'checkout', paymentId: 'pay-new' });
    expect(await b.viewer.initiatePayment()).toEqual({ status: 'checkout', paymentId: 'pay-new' });
    expect(await c.viewer.initiatePayment()).toEqual({ status: 'checkout', paymentId: 'pay-new' });
    expect(rpcs(a, 'initiate_payment')[0].body).toEqual({ p_entity_id: 7 });
    expect(rpcs(b, 'initiate_payment')[0].body).toEqual({ p_entity_id: '7' });
  });

  it('takes the first element of an array response as the payment id', async () => {
    const w = make({ entity: PAY, props, record: paid('failed'), respond: ({ path }) => (path === 'rpc/initiate_payment' ? reply(200, ['pay-arr']) : undefined) });
    await flush();
    expect(await w.viewer.initiatePayment()).toEqual({ status: 'checkout', paymentId: 'pay-arr' });
  });

  it('fails with no_payment_id when the RPC returns none', async () => {
    const a = make({ entity: PAY, props, record: paid('failed'), respond: ({ path }) => (path === 'rpc/initiate_payment' ? reply(200, []) : undefined) });
    const b = make({ entity: PAY, props, record: paid('failed'), respond: ({ path }) => (path === 'rpc/initiate_payment' ? reply(200, null) : undefined) });
    await flush();
    expect(await a.viewer.initiatePayment()).toEqual({ status: 'failed', reason: 'no_payment_id' });
    expect(await b.viewer.initiatePayment()).toEqual({ status: 'failed', reason: 'no_payment_id' });
  });

  it('fails with not_configured and sends nothing without a payment_initiation_rpc', async () => {
    const w = make({ props });
    await flush();
    expect(await w.viewer.initiatePayment()).toEqual({ status: 'failed', reason: 'not_configured' });
    expect(sent(w).filter(r => r.method === 'POST')).toEqual([]);
  });

  it('fails with rejected and the server\'s message when the RPC request fails', async () => {
    const w = make({ entity: PAY, props, record: paid('failed'), respond: ({ path }) => (path === 'rpc/initiate_payment' ? reply(400, { code: 'P0001', message: 'Amount is zero' }) : undefined) });
    await flush();
    expect(await w.viewer.initiatePayment()).toEqual({ status: 'failed', reason: 'rejected', message: 'Amount is zero' });
  });

  it('toggles payment.loading around the request', async () => {
    const gate = deferred();
    const w = make({ entity: PAY, props, record: paid('failed'), respond: ({ path }) => (path === 'rpc/initiate_payment' ? gate.promise : undefined) });
    await flush();
    const pending = w.viewer.initiatePayment();
    expect(snap(w).payment!.loading).toBe(true);
    gate.resolve(reply(200, '"pay-new"'));
    await pending;
    expect(snap(w).payment!.loading).toBe(false);
  });
});

describe('recordViewer: inverse relationships', () => {
  const preview = (rows: unknown[], total: number): TransportResponse => reply(200, rows, { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${total}` });

  it('lists the relationships with rows, drops zero counts and orders by the source entity\'s sort_order', async () => {
    const entities = [
      entityRow(),
      entityRow({ table_name: 'comments', display_name: 'Comments', sort_order: 30 }),
      entityRow({ table_name: 'photos', display_name: 'Photos', sort_order: 10 }),
      entityRow({ table_name: 'empty', display_name: 'Empty', sort_order: 5 }),
    ];
    const respond: Route = ({ path }) =>
      path.startsWith('comments?') ? preview([{ id: 1, display_name: 'c1' }], 4) : path.startsWith('photos?') ? preview([{ id: 9, display_name: 'p1' }], 1) : path.startsWith('empty?') ? preview([], 0) : undefined;
    const w = make({ entities, inverse: [inverseMeta('comments'), inverseMeta('empty'), inverseMeta('photos')], respond });
    await flush();
    expect(snap(w).inverse.map(i => i.meta.sourceTable)).toEqual(['photos', 'comments']);
    expect(snap(w).inverse[1]).toMatchObject({ totalCount: 4, previewRecords: [{ id: 1, display_name: 'c1' }], targetId: 7 });
  });

  it('requests each preview with the previewMode\'s select and limit', async () => {
    const metas = [
      inverseMeta('comments', { previewLimit: 3 }),
      inverseMeta('links', { previewMode: 'id', previewLimit: 2 }),
      inverseMeta('stamps', { previewMode: 'count', sourceColumn: 'issue_ref' }),
    ];
    const w = make({ inverse: metas });
    await flush();
    expect(gets(w, 'comments?').map(r => r.path)).toEqual(['comments?issue_id=eq.7&select=id,display_name&limit=3']);
    expect(gets(w, 'links?').map(r => r.path)).toEqual(['links?issue_id=eq.7&select=id&limit=2']);
    expect(gets(w, 'stamps?').map(r => r.path)).toEqual(['stamps?issue_ref=eq.7&select=issue_ref&limit=0']);
    expect(gets(w, 'comments?')[0].headers).toMatchObject({ Prefer: 'count=exact' });
  });

  it('falls back to the row count when the response has no total, and to zero when a preview fails', async () => {
    const respond: Route = ({ path }) =>
      path.startsWith('comments?') ? reply(200, [{ id: 1 }, { id: 2 }]) : path.startsWith('photos?') ? reply(500, { message: 'down' }) : undefined;
    const w = make({ inverse: [inverseMeta('comments'), inverseMeta('photos')], respond });
    await flush();
    expect(snap(w).inverse.map(i => [i.meta.sourceTable, i.totalCount])).toEqual([['comments', 2]]);
  });

  it('sends the id of the loaded record as the filter value', async () => {
    const uuid = '3f2a0c1e-5b7d-4e8a-9c1d-0a1b2c3d4e5f';
    const w = make({ inverse: [inverseMeta('comments')], recordId: uuid, record: { id: uuid, display_name: 'Pothole', name: 'Pothole' } });
    await flush();
    expect(gets(w, 'comments?')[0].path).toBe(`comments?issue_id=eq.${uuid}&select=id,display_name&limit=5`);
  });

  it('sorts a source entity missing from the schema as sort_order 0', async () => {
    const entities = [entityRow(), entityRow({ table_name: 'comments', sort_order: 30 })];
    const respond: Route = ({ path }) => (path.startsWith('ghosts?') || path.startsWith('comments?') ? preview([{ id: 1 }], 1) : undefined);
    const w = make({ entities, inverse: [inverseMeta('comments'), inverseMeta('ghosts')], respond });
    await flush();
    expect(snap(w).inverse.map(i => i.meta.sourceTable)).toEqual(['ghosts', 'comments']);
  });

  it('reads the relationships without exclusions for an entity without a guided form', async () => {
    const w = make({ inverse: [inverseMeta('comments')] });
    await flush();
    expect(w.state.exclusions.filter(e => e !== undefined)).toEqual([]);
  });

  it('excludes the guided form\'s step tables once the context has settled', async () => {
    const ctx = context({ steps: [step('applicant'), step('household')] });
    const respond: Route = ({ path }) => (path === 'rpc/get_guided_form_context' ? reply(200, ctx) : undefined);
    const w = make({ entity: { guided_form_key: 'intake' }, inverse: [inverseMeta('comments')], respond });
    await flush();
    expect([...w.state.exclusions[w.state.exclusions.length - 1]!].sort()).toEqual(['applicant_steps', 'household_steps']);
  });

  it('reads the relationships without exclusions when the guided-form context fails', async () => {
    const respond: Route = ({ path }) => (path === 'rpc/get_guided_form_context' ? reply(500, { message: 'down' }) : undefined);
    const w = make({ entity: { guided_form_key: 'intake' }, inverse: [inverseMeta('comments')], respond });
    await flush();
    expect(w.state.exclusions[w.state.exclusions.length - 1]).toBeUndefined();
    expect(snap(w).guidedForm).toMatchObject({ context: null });
  });

  it('re-reads the previews on reload', async () => {
    let total = 1;
    const w = make({ inverse: [inverseMeta('comments')], respond: ({ path }) => (path.startsWith('comments?') ? preview([{ id: 1 }], total) : undefined) });
    await flush();
    expect(snap(w).inverse[0].totalCount).toBe(1);
    total = 6;
    w.viewer.reload();
    await flush();
    expect(snap(w).inverse[0].totalCount).toBe(6);
    expect(gets(w, 'comments?')).toHaveLength(2);
  });

  it('reads no relationships when the record is not found', async () => {
    const w = make({ inverse: [inverseMeta('comments')], record: null });
    await flush();
    expect(snap(w).inverse).toEqual([]);
    expect(gets(w, 'comments?')).toEqual([]);
  });
});

describe('recordViewer: series membership and delete', () => {
  const RECURRING = { supports_recurring: true };
  const member = { is_member: true, series_id: 11, group_id: 5, occurrence_date: '2026-10-21' };
  const membership = (body: unknown): Route => ({ path }) => (path === 'rpc/get_series_membership' ? reply(200, body) : undefined);

  it('checks membership only for an entity with recurring support, sending the id as given', async () => {
    const a = make({ entity: RECURRING, respond: membership(member), recordId: '7' });
    const b = make();
    await flush();
    expect(rpcs(a, 'get_series_membership').map(r => r.body)).toEqual([{ p_entity_table: 'issues', p_entity_id: '7' }]);
    expect(snap(a).series).toEqual(member);
    expect(rpcs(b, 'get_series_membership')).toEqual([]);
    expect(snap(b).series).toBeUndefined();
  });

  it('gives { is_member: false } when the check fails or returns nothing', async () => {
    const a = make({ entity: RECURRING, respond: ({ path }) => (path === 'rpc/get_series_membership' ? reply(500, { message: 'down' }) : undefined) });
    const b = make({ entity: RECURRING });
    await flush();
    expect(snap(a).series).toEqual({ is_member: false });
    expect(snap(b).series).toEqual({ is_member: false });
  });

  it('checks membership even when the record is not found, as the legacy page did', async () => {
    const w = make({ entity: RECURRING, record: null, respond: membership({ is_member: false }) });
    await flush();
    expect(rpcs(w, 'get_series_membership')).toHaveLength(1);
    expect(snap(w).series).toEqual({ is_member: false });
  });

  it('re-checks membership on reload', async () => {
    const w = make({ entity: RECURRING, respond: membership(member) });
    await flush();
    w.viewer.reload();
    await flush();
    expect(rpcs(w, 'get_series_membership')).toHaveLength(2);
  });

  it('deletes with DELETE <entity>?id=eq.<id> without a scope', async () => {
    const w = make({ respond: ({ method }) => (method === 'DELETE' ? reply(204, null) : undefined) });
    await flush();
    expect(await w.viewer.deleteRecord()).toEqual({ status: 'deleted' });
    expect(sent(w).filter(r => r.method === 'DELETE').map(r => r.path)).toEqual(['issues?id=eq.7']);
  });

  it('fails with the humanized message when the plain delete is rejected', async () => {
    const w = make({ respond: ({ method }) => (method === 'DELETE' ? reply(409, { code: '23503', message: 'violates foreign key constraint' }) : undefined) });
    await flush();
    expect(await w.viewer.deleteRecord()).toEqual({ status: 'failed', message: humanizeError({ httpCode: 409, code: '23503', message: 'violates foreign key constraint' }) });
  });

  it('toggles deleting around the request', async () => {
    const gate = deferred();
    const w = make({ respond: ({ method }) => (method === 'DELETE' ? gate.promise : undefined) });
    await flush();
    const pending = w.viewer.deleteRecord();
    expect(snap(w).deleting).toBe(true);
    gate.resolve(reply(204, null));
    await pending;
    expect(snap(w).deleting).toBe(false);
  });

  it('cancels one occurrence for this_only, with the reason or null', async () => {
    const w = make({ entity: RECURRING, recordId: '7', respond: (call, req) => (call.path === 'rpc/cancel_series_occurrence' ? reply(200, { success: true }) : membership(member)(call, req)) });
    await flush();
    expect(await w.viewer.deleteRecord('this_only', 'Rain')).toEqual({ status: 'deleted' });
    expect(await w.viewer.deleteRecord('this_only')).toEqual({ status: 'deleted' });
    expect(rpcs(w, 'cancel_series_occurrence').map(r => r.body)).toEqual([
      { p_entity_table: 'issues', p_entity_id: 7, p_reason: 'Rain' },
      { p_entity_table: 'issues', p_entity_id: 7, p_reason: null },
    ]);
  });

  it('ends the series at the occurrence for this_and_future, with the membership\'s series_id and occurrence_date', async () => {
    const w = make({ entity: RECURRING, respond: (call, req) => (call.path === 'rpc/end_series_from_date' ? reply(200, { success: true, entities_deleted: 3 }) : membership(member)(call, req)) });
    await flush();
    expect(await w.viewer.deleteRecord('this_and_future', 'ignored')).toEqual({ status: 'deleted' });
    expect(rpcs(w, 'end_series_from_date').map(r => r.body)).toEqual([{ p_series_id: 11, p_occurrence_date: '2026-10-21' }]);
    expect(rpcs(w, 'cancel_series_occurrence')).toEqual([]);
    expect(sent(w).filter(r => r.method === 'DELETE')).toEqual([]);
  });

  it('fails this_and_future with the RPC\'s message when the body says success false', async () => {
    const w = make({ entity: RECURRING, respond: (call, req) => (call.path === 'rpc/end_series_from_date' ? reply(200, { success: false, message: 'Series not found' }) : membership(member)(call, req)) });
    await flush();
    expect(await w.viewer.deleteRecord('this_and_future')).toEqual({ status: 'failed', message: 'Series not found' });
  });

  it('fails this_and_future with the humanized message when the RPC is rejected', async () => {
    const fk = { code: '23503', message: 'update or delete on table "reservation_requests" violates foreign key constraint' };
    const denied = { code: 'P0001', message: 'Permission denied', hint: 'Requires reservation_requests:delete permission' };
    const a = make({ entity: RECURRING, respond: (call, req) => (call.path === 'rpc/end_series_from_date' ? reply(409, fk) : membership(member)(call, req)) });
    const b = make({ entity: RECURRING, respond: (call, req) => (call.path === 'rpc/end_series_from_date' ? reply(400, denied) : membership(member)(call, req)) });
    await flush();
    expect(await a.viewer.deleteRecord('this_and_future')).toEqual({ status: 'failed', message: humanizeError({ httpCode: 409, ...fk }) });
    expect(await b.viewer.deleteRecord('this_and_future')).toEqual({ status: 'failed', message: 'Permission denied' });
  });

  it('fails this_and_future with the network wording when the request cannot be sent', async () => {
    const w = make({ entity: RECURRING, respond: (call, req) => (call.path === 'rpc/end_series_from_date' ? Promise.reject(new TransportError('network')) : membership(member)(call, req)) });
    await flush();
    expect(await w.viewer.deleteRecord('this_and_future')).toEqual({ status: 'failed', message: humanizeError({ httpCode: 0 }) });
    expect(snap(w).deleting).toBe(false);
  });

  it('falls back for this_and_future without a series_id and an occurrence_date', async () => {
    const a = make({ entity: RECURRING, respond: membership({ is_member: true, group_id: 5, occurrence_date: '2026-10-21' }) });
    const b = make({ entity: RECURRING, respond: membership({ is_member: true, series_id: 11, group_id: 5 }) });
    await flush();
    expect(await a.viewer.deleteRecord('this_and_future')).toEqual({ status: 'fallback' });
    expect(await b.viewer.deleteRecord('this_and_future')).toEqual({ status: 'fallback' });
    expect(rpcs(a, 'end_series_from_date')).toEqual([]);
    expect(rpcs(b, 'end_series_from_date')).toEqual([]);
  });

  it('deletes the whole series group for all', async () => {
    const w = make({ entity: RECURRING, respond: (call, req) => (call.path === 'rpc/delete_series_group' ? reply(200, { success: true }) : membership(member)(call, req)) });
    await flush();
    expect(await w.viewer.deleteRecord('all')).toEqual({ status: 'deleted' });
    expect(rpcs(w, 'delete_series_group').map(r => r.body)).toEqual([{ p_group_id: 5 }]);
  });

  it('falls back for all without a group_id', async () => {
    const w = make({ entity: RECURRING, respond: membership({ is_member: true, series_id: 11, occurrence_date: '2026-10-21' }) });
    await flush();
    expect(await w.viewer.deleteRecord('all')).toEqual({ status: 'fallback' });
    expect(rpcs(w, 'delete_series_group')).toEqual([]);
  });

  it('falls back for any scope on a record that is not a series member, and for an entity without recurring support', async () => {
    const a = make({ entity: RECURRING, respond: membership({ is_member: false }) });
    const b = make();
    await flush();
    for (const scope of ['this_only', 'this_and_future', 'all'] as const) {
      expect(await a.viewer.deleteRecord(scope)).toEqual({ status: 'fallback' });
      expect(await b.viewer.deleteRecord(scope)).toEqual({ status: 'fallback' });
    }
    expect(sent(a).filter(r => r.method === 'DELETE' || r.path.startsWith('rpc/cancel') || r.path.startsWith('rpc/delete'))).toEqual([]);
  });

  it('fails with the RPC\'s message when the body says success false', async () => {
    const w = make({ entity: RECURRING, respond: (call, req) => (call.path === 'rpc/cancel_series_occurrence' ? reply(200, { success: false, message: 'Already past' }) : membership(member)(call, req)) });
    await flush();
    expect(await w.viewer.deleteRecord('this_only')).toEqual({ status: 'failed', message: 'Already past' });
  });

  it('fails with the server\'s message when a series RPC is rejected', async () => {
    const w = make({ entity: RECURRING, respond: (call, req) => (call.path === 'rpc/delete_series_group' ? reply(400, { code: 'P0001', message: 'Series is locked' }) : membership(member)(call, req)) });
    await flush();
    expect(await w.viewer.deleteRecord('all')).toEqual({ status: 'failed', message: 'Series is locked' });
  });

  it('toggles deleting around a series request', async () => {
    const gate = deferred();
    const w = make({ entity: RECURRING, respond: (call, req) => (call.path === 'rpc/cancel_series_occurrence' ? gate.promise : membership(member)(call, req)) });
    await flush();
    const pending = w.viewer.deleteRecord('this_only');
    expect(snap(w).deleting).toBe(true);
    gate.resolve(reply(200, { success: true }));
    await pending;
    expect(snap(w).deleting).toBe(false);
  });
});

describe('recordViewer: guided form', () => {
  const GF = { guided_form_key: 'intake' };
  const withContext = (ctx: GuidedFormContext | null, extra?: Route): Route => (call, req) =>
    call.path === 'rpc/get_guided_form_context' ? reply(200, ctx) : extra?.(call, req);

  it('is null for an entity without a guided form and before the record loads', async () => {
    const a = make();
    const b = make({ entity: GF, record: null });
    expect(snap(a).guidedForm).toBeNull();
    await flush();
    expect(snap(a).guidedForm).toBeNull();
    expect(snap(b).guidedForm).toBeNull();
    expect(rpcs(b, 'get_guided_form_context')).toEqual([]);
  });

  it('loads the context with the key, the table and the numeric record id', async () => {
    const ctx = context({ parent_status_key: 'draft', steps: [step('applicant')] });
    const w = make({ entity: GF, recordId: '7', respond: withContext(ctx) });
    await flush();
    expect(rpcs(w, 'get_guided_form_context').map(r => r.body)).toEqual([{ p_guided_form_key: 'intake', p_table_name: 'issues', p_record_id: 7 }]);
    expect(snap(w).guidedForm).toMatchObject({ context: ctx, submitted: false, submitting: false });
  });

  it('is in context null, with no review, while the context is pending or has failed', async () => {
    const a = make({ entity: GF, respond: ({ path }) => (path === 'rpc/get_guided_form_context' ? reply(500, { message: 'down' }) : undefined) });
    const b = make({ entity: GF, respond: withContext(null) });
    await flush();
    expect(snap(a).guidedForm).toEqual({ context: null, submitted: false, showReview: false, steps: [], nextStepKey: null, submitting: false });
    expect(snap(b).guidedForm).toMatchObject({ context: null, showReview: false });
  });

  it('flags submitted and shows the review for a submitted form', async () => {
    const w = make({ entity: GF, respond: withContext(context({ parent_status_key: 'submitted', steps: [step('a')] })) });
    await flush();
    expect(snap(w).guidedForm).toMatchObject({ submitted: true, showReview: true });
  });

  it('shows the review for a complete form even with steps left', async () => {
    const w = make({ entity: GF, respond: withContext(context({ parent_status_key: 'complete', steps: [step('a')] })) });
    await flush();
    expect(snap(w).guidedForm).toMatchObject({ submitted: false, showReview: true });
  });

  it('shows the review for a draft once every required step is complete, optional ones aside', async () => {
    const steps = [step('a'), step('b', { can_skip: true })];
    const done = make({ entity: GF, respond: withContext(context({ steps, progress: progress('a') })) });
    const open = make({ entity: GF, respond: withContext(context({ steps, progress: progress('b') })) });
    await flush();
    expect(snap(done).guidedForm).toMatchObject({ showReview: true, nextStepKey: null });
    expect(snap(open).guidedForm).toMatchObject({ showReview: false, nextStepKey: 'a' });
  });

  it('does not show the review for another status', async () => {
    const w = make({ entity: GF, respond: withContext(context({ parent_status_key: 'archived', steps: [step('a')], progress: progress('a') })) });
    await flush();
    expect(snap(w).guidedForm!.showReview).toBe(false);
  });

  it('derives the steps with completion, skip and requirement against a null parent record', async () => {
    const steps = [
      step('a', { step_order: 1 }),
      step('b', { step_order: 2, can_skip: true }),
      step('c', { step_order: 3, can_skip: true, conditions: [{ id: 1, condition_type: 'require_if', field: 'kind', operator: 'is_null', value: null }] as any }),
      step('d', { step_order: 4, conditions: [{ id: 2, condition_type: 'skip_if', field: 'kind', operator: 'is_null', value: null }] as any }),
    ];
    const w = make({ entity: GF, respond: withContext(context({ steps, progress: progress('a') })) });
    await flush();
    const effective = snap(w).guidedForm!.steps;
    expect(effective.map(s => [s.step_key, s.isCompleted, s.isSkipped, s.isRequired])).toEqual([
      ['a', true, false, true],
      ['b', false, false, false],
      ['c', false, false, true],
      ['d', false, true, true],
    ]);
    expect(snap(w).guidedForm!.nextStepKey).toBe('c');
  });

  it('names the record\'s own step as the next one when it is the first incomplete required step', async () => {
    const steps = [step('__parent__'), step('a')];
    const w = make({ entity: GF, respond: withContext(context({ steps })) });
    await flush();
    expect(snap(w).guidedForm!.nextStepKey).toBe('__parent__');
  });

  it('defaults a step without conditions to none', async () => {
    const bare = { ...step('a') } as any;
    delete bare.conditions;
    const w = make({ entity: GF, respond: withContext(context({ steps: [bare] })) });
    await flush();
    expect(snap(w).guidedForm!.steps[0]).toMatchObject({ step_key: 'a', isSkipped: false, isRequired: true });
  });

  it('submits with the key and the numeric record id and returns submitted', async () => {
    const w = make({ entity: GF, recordId: '7', respond: withContext(context({ steps: [step('a')] }), ({ path }) => (path === 'rpc/submit_guided_form' ? reply(200, { ok: true }) : undefined)) });
    await flush();
    expect(await w.viewer.submitGuidedForm()).toEqual({ status: 'submitted' });
    expect(rpcs(w, 'submit_guided_form').map(r => r.body)).toEqual([{ p_guided_form_key: 'intake', p_parent_id: 7 }]);
  });

  it('returns the navigate_to the on_submit_rpc gave, and does not reload', async () => {
    const w = make({ entity: GF, respond: withContext(context(), ({ path }) => (path === 'rpc/submit_guided_form' ? reply(200, { navigate_to: '/view/receipts/3' }) : undefined)) });
    await flush();
    expect(await w.viewer.submitGuidedForm()).toEqual({ status: 'submitted', navigateTo: '/view/receipts/3' });
    expect(recordGets(w)).toHaveLength(1);
    expect(rpcs(w, 'get_guided_form_context')).toHaveLength(1);
  });

  it('fails with the server\'s message, else the error\'s text, and sends nothing for an entity without a guided form', async () => {
    const a = make({ entity: GF, respond: withContext(context(), ({ path }) => (path === 'rpc/submit_guided_form' ? reply(400, { code: 'P0001', message: 'Missing required steps' }) : undefined)) });
    const b = make({ entity: GF, respond: withContext(context(), ({ path }) => (path === 'rpc/submit_guided_form' ? (Promise.reject(new Error('offline')) as unknown as Promise<TransportResponse>) : undefined)) });
    const c = make();
    await flush();
    expect(await a.viewer.submitGuidedForm()).toEqual({ status: 'failed', message: 'Missing required steps' });
    expect(await b.viewer.submitGuidedForm()).toEqual({ status: 'failed', message: 'offline' });
    expect(await c.viewer.submitGuidedForm()).toEqual({ status: 'failed' });
    expect(rpcs(c, 'submit_guided_form')).toEqual([]);
  });

  it('toggles submitting around the request', async () => {
    const gate = deferred();
    const w = make({ entity: GF, respond: withContext(context(), ({ path }) => (path === 'rpc/submit_guided_form' ? gate.promise : undefined)) });
    await flush();
    const pending = w.viewer.submitGuidedForm();
    expect(snap(w).guidedForm!.submitting).toBe(true);
    gate.resolve(reply(200, {}));
    await pending;
    expect(snap(w).guidedForm!.submitting).toBe(false);
  });

  it('re-fetches the context on reload and keeps the stale one until it arrives', async () => {
    let status = 'draft';
    const gate = deferred();
    let calls = 0;
    const w = make({
      entity: GF,
      respond: ({ path }) => {
        if (path !== 'rpc/get_guided_form_context') return undefined;
        calls++;
        return calls === 1 ? reply(200, context({ parent_status_key: status })) : gate.promise;
      },
    });
    await flush();
    expect(snap(w).guidedForm!.context!.parent_status_key).toBe('draft');
    status = 'submitted';
    w.viewer.reload();
    await flush();
    expect(snap(w).guidedForm!.context!.parent_status_key).toBe('draft');
    gate.resolve(reply(200, context({ parent_status_key: 'submitted' })));
    await flush();
    expect(snap(w).guidedForm).toMatchObject({ submitted: true });
    expect(rpcs(w, 'get_guided_form_context')).toHaveLength(2);
  });
});
