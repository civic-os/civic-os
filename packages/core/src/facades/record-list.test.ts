/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures are partial schema rows, as in the handle tests. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DataClient } from '../client/data-client.js';
import { EntityHandle, mintEntityHandle } from '../handles/handles.js';
import { EntityPropertyType } from '../model/entity.js';
import type { SchemaEntityProperty, SchemaEntityTable } from '../model/entity.js';
import type { DataQuery } from '../model/query.js';
import { createFakeClock, fakeTransport, reply } from '../testing/index.js';
import type { FakeTransport } from '../testing/index.js';
import type { TransportRequest, TransportResponse } from '../transport/types.js';
import type { FacadeDeps } from './deps.js';
import { recordList } from './record-list.js';
import type { RecordList, RecordListOptions } from './record-list.js';

// Core compiles without DOM or Node types (see fetch-transport.test.ts).
declare const setTimeout: (callback: () => void, ms: number) => unknown;
declare const process: { env: { TZ?: string } };

const T = EntityPropertyType;

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
  name: prop('name', T.TextShort, { display_name: 'Name' }),
  status: prop('status_id', T.ForeignKeyName, { display_name: 'Status', join_schema: 'public', join_table: 'Status', join_column: 'id' }),
  geo: prop('location', T.GeoPoint, { display_name: 'Location' }),
  polygon: prop('area', T.GeoPolygon, { display_name: 'Area' }),
  slot: prop('time_slot', T.TimeSlot, { display_name: 'Time slot' }),
  id: prop('id', T.IntegerNumber, { show_on_list: false }),
  displayName: prop('display_name', T.TextShort, { show_on_list: false }),
};

/** Lets the microtask-scheduled load and the fake transport settle. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

interface World {
  list: RecordList;
  ft: FakeTransport;
  /** The `DataQuery` of every `getDataPaginated` call, in order. */
  queries: DataQuery[];
  /** The signal of every call. */
  signals: any[];
  row: SchemaEntityTable | undefined;
  handle: EntityHandle;
}

interface MakeOptions {
  entity?: Partial<SchemaEntityTable> | null;
  props?: SchemaEntityProperty[];
  respond?: (req: TransportRequest) => Promise<TransportResponse>;
  options?: RecordListOptions;
}

function make(opts: MakeOptions = {}): World {
  const row = opts.entity === null ? undefined : entityRow(opts.entity);
  const props = opts.props ?? [P.name, P.status];
  const ft = fakeTransport(opts.respond);
  const queries: DataQuery[] = [];
  const signals: any[] = [];
  const data = ft.client as DataClient;
  const original = data.getDataPaginated.bind(data);
  vi.spyOn(data, 'getDataPaginated').mockImplementation((query, options) => {
    queries.push(JSON.parse(JSON.stringify(query)) as DataQuery);
    signals.push(options?.signal);
    return original(query, options);
  });
  const handle = mintEntityHandle(
    { peekEntities: () => (row ? [row] : []), peekProperties: () => props, peekEntityActions: () => undefined },
    'issues',
  );
  const deps: FacadeDeps = {
    data,
    schema: { properties: async () => props },
    clock: createFakeClock('2026-10-21T12:00:00Z'),
  };
  const list = recordList(deps, handle, opts.options);
  return { list, ft, queries, signals, row, handle };
}

/** A response held until the test settles it. */
function deferred() {
  let resolve!: (r: TransportResponse) => void;
  const promise = new Promise<TransportResponse>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const CAL = { show_calendar: true, calendar_property_name: 'time_slot' };

describe('recordList: columns and views', () => {
  it('lists the columns the legacy List page fetched (ported 153)', async () => {
    const hidden = prop('internal', T.TextShort, { show_on_list: false });
    const w = make({ props: [P.name, hidden, P.status, P.id, P.displayName] });
    await flush();
    const snap = w.list.getSnapshot();
    expect(snap.columns.map(c => c.column_name)).toEqual(['name', 'status_id', 'display_name']);
    expect(snap.displayColumns.map(c => c.column_name)).toEqual(['name', 'status_id']);
  });

  it('exposes the filter bar columns (propsForFilter)', async () => {
    const filterable = prop('priority', T.IntegerNumber, { filterable: true, show_on_list: false });
    const w = make({ props: [P.name, filterable, prop('note', T.TextLong, { filterable: true })] });
    await flush();
    expect(w.list.getSnapshot().filterColumns.map(c => c.column_name)).toEqual(['priority']);
  });

  it('sends no request and reports empty columns for an unknown entity (ported 171)', async () => {
    const w = make({ entity: null });
    await flush();
    const snap = w.list.getSnapshot();
    expect(w.ft.requests).toHaveLength(0);
    expect(snap.columns).toEqual([]);
    expect(snap.rows).toEqual([]);
    expect(snap.loading).toBe(false);
  });

  it('sends no request when the entity has no list columns (ported 241)', async () => {
    const w = make({ props: [] });
    await flush();
    const snap = w.list.getSnapshot();
    expect(w.ft.requests).toHaveLength(0);
    expect(snap.columns).toEqual([]);
    expect(snap.totalCount).toBe(0);
    expect(snap.loading).toBe(false);
  });

  it('reports the summary view for a non-insertable VIEW (ported 1138)', async () => {
    const w = make({ entity: { is_view: true, insert: false, update: false, delete: false } });
    await flush();
    expect(w.list.getSnapshot().views.summary).toBe(true);
    expect(w.queries[0].isSummaryView).toBe(true);
  });

  it('reports no summary view for a regular table (ported 1158)', async () => {
    const w = make();
    await flush();
    expect(w.list.getSnapshot().views.summary).toBe(false);
    expect(w.queries[0].isSummaryView).toBe(false);
  });

  it('reports no summary view for an insertable VIEW (ported 1169)', async () => {
    const w = make({ entity: { is_view: true, insert: true } });
    await flush();
    expect(w.list.getSnapshot().views.summary).toBe(false);
    expect(w.queries[0].isSummaryView).toBe(false);
  });

  it('reports the point map when show_map has a GeoPoint property (ported 570)', async () => {
    const w = make({ entity: { show_map: true, map_property_name: 'location' }, props: [P.geo] });
    await flush();
    expect(w.list.getSnapshot().views.map).toBe('point');
  });

  it('reports the polygon map for a GeoPolygon property', async () => {
    const w = make({ entity: { show_map: true, map_property_name: 'area' }, props: [P.polygon] });
    await flush();
    expect(w.list.getSnapshot().views.map).toBe('polygon');
  });

  it('reports no map when show_map is off or the property is unset (ported 589)', async () => {
    const off = make({ entity: { show_map: false, map_property_name: null }, props: [P.geo] });
    const unset = make({ entity: { show_map: true, map_property_name: null }, props: [P.geo] });
    await flush();
    expect(off.list.getSnapshot().views.map).toBeNull();
    expect(unset.list.getSnapshot().views.map).toBeNull();
  });

  it('shows the calendar only with a calendar property and select permission', async () => {
    const on = make({ entity: CAL, props: [P.name, P.slot] });
    const noSelect = make({ entity: { ...CAL, select: false }, props: [P.name, P.slot] });
    const noProp = make({ entity: { show_calendar: true, calendar_property_name: null }, props: [P.name] });
    const off = make({ props: [P.name] });
    await flush();
    expect(on.list.getSnapshot().views.calendar).toBe(true);
    expect(noSelect.list.getSnapshot().views.calendar).toBe(false);
    expect(noProp.list.getSnapshot().views.calendar).toBe(false);
    expect(off.list.getSnapshot().views.calendar).toBe(false);
  });
});

describe('recordList: the request', () => {
  it('builds the select list from propertyToSelectStringForList (ported 182, 293)', async () => {
    const w = make({ props: [P.name, P.status] });
    await flush();
    expect(w.queries[0]).toEqual({
      key: 'issues',
      fields: ['name', 'status_id:Status!status_id(id,display_name)'],
      pagination: { page: 1, pageSize: 25 },
      isSummaryView: false,
      entityColumns: ['name', 'status_id'],
    });
    // No id or display_name column, so the compiler appends no id and no default order.
    expect(w.ft.recorded()[0].path).toBe('issues?select=name,status_id:Status!status_id(id,display_name)');
  });

  it('selects mixed property types the way the legacy page did (ported 293)', async () => {
    const money = prop('cost', T.Money);
    const user = prop('owner_id', T.User, { join_schema: 'public', join_table: 'civic_os_users', join_column: 'id' });
    const gallery = prop('photos', T.PhotoGallery);
    const w = make({ props: [P.name, money, user, gallery] });
    await flush();
    expect(w.queries[0].fields).toEqual([
      'name',
      'cost',
      'owner_id:civic_os_users!owner_id(id,display_name,full_name,phone,email)',
      'photos:photo_galleries!photos(id,photo_gallery_files(file_id))',
    ]);
  });

  it('aliases a GeoPoint to its _text companion (ported 215)', async () => {
    const w = make({ props: [P.geo] });
    await flush();
    expect(w.queries[0].fields).toEqual(['location:location_text']);
  });

  it('adds the calendar color property and the FK-aware map color property', async () => {
    const category = prop('category_id', T.Category, { show_on_list: false, filterable: true, join_schema: 'metadata', join_table: 'categories', join_column: 'id', category_entity_type: 'issue' });
    const w = make({
      entity: { calendar_color_property: 'status_color', map_color_property: 'category_id' },
      props: [P.name, category],
    });
    await flush();
    expect(w.queries[0].fields).toEqual(['name', 'status_color', 'category_id:categories!category_id(id,display_name,color)']);
  });

  it('does not repeat a color property the list already selects', async () => {
    const color = prop('status_color', T.Color);
    const w = make({ entity: { calendar_color_property: 'status_color' }, props: [P.name, color] });
    await flush();
    expect(w.queries[0].fields).toEqual(['name', 'status_color']);
  });

  it('selects a map color property that is a plain column by name when it has no property', async () => {
    const w = make({ entity: { map_color_property: 'fill' }, props: [P.name] });
    await flush();
    expect(w.queries[0].fields).toEqual(['name', 'fill']);
  });

  it('sends entityColumns without the many-to-many properties', async () => {
    const m2m = prop('tags', T.ManyToMany);
    const w = make({ props: [P.name, m2m, P.id] });
    await flush();
    expect(w.queries[0].entityColumns).toEqual(['name', 'id']);
  });

  it('loads on creation and fills the snapshot', async () => {
    const rows = [{ id: 1, name: 'a' }];
    const w = make({ props: [P.name, P.displayName, P.id], respond: async () => reply(200, rows, { 'content-range': '0-0/7' }) });
    expect(w.list.getSnapshot().loading).toBe(true);
    await flush();
    const snap = w.list.getSnapshot();
    expect(snap.loading).toBe(false);
    expect(snap.rows).toEqual(rows);
    expect(snap.totalCount).toBe(7);
    expect(snap.error).toBeUndefined();
    expect(snap.loadedState).toEqual(snap.state);
    expect(w.ft.recorded()[0].path).toContain('order=display_name.asc,id.asc');
  });

  it('falls back to the row count when the server sends no Content-Range', async () => {
    const w = make({ respond: async () => reply(200, [{ id: 1 }, { id: 2 }]) });
    await flush();
    expect(w.list.getSnapshot().totalCount).toBe(2);
  });

  it('empties the rows when a load starts and until it settles', async () => {
    const d = deferred();
    let n = 0;
    const w = make({ respond: () => (n++ === 0 ? Promise.resolve(reply(200, [{ id: 1 }])) : d.promise) });
    await flush();
    expect(w.list.getSnapshot().rows).toHaveLength(1);
    w.list.setPage(2);
    await flush();
    const mid = w.list.getSnapshot();
    expect(mid.loading).toBe(true);
    expect(mid.rows).toEqual([]);
    expect(mid.totalCount).toBe(0);
    d.resolve(reply(200, [{ id: 2 }]));
    await flush();
    expect(w.list.getSnapshot().rows).toEqual([{ id: 2 }]);
  });

  it('turns a failed load into empty rows and an error', async () => {
    const w = make({ respond: async () => reply(500, { message: 'boom' }) });
    await flush();
    const snap = w.list.getSnapshot();
    expect(snap.loading).toBe(false);
    expect(snap.rows).toEqual([]);
    expect(snap.totalCount).toBe(0);
    expect(snap.error).toBeDefined();
  });

  it('clears the error on the next successful load', async () => {
    let n = 0;
    const w = make({ respond: async () => (n++ === 0 ? reply(500, { message: 'boom' }) : reply(200, [])) });
    await flush();
    w.list.setPage(2);
    await flush();
    expect(w.list.getSnapshot().error).toBeUndefined();
  });

  it('sends the sorted column through buildOrderField when it is in the columns', async () => {
    const w = make({ props: [P.name, P.status] });
    await flush();
    w.list.toggleSort('status_id');
    await flush();
    expect(w.queries[1].orderField).toBe('status_id(display_name)');
    expect(w.queries[1].orderDirection).toBe('asc');
    expect(w.ft.recorded()[1].path).toContain('order=status_id(display_name).asc');
  });

  it('sends no order for a sorted column outside the columns', async () => {
    const w = make({ props: [P.name, P.displayName, P.id] });
    await flush();
    w.list.set({ sort: { column: 'nope', direction: 'asc' } });
    await flush();
    expect(w.queries[1].orderField).toBeUndefined();
    expect(w.ft.recorded()[1].path).toContain('order=display_name.asc,id.asc');
  });

  it('leaves the order to the query compiler when unsorted', async () => {
    const w = make({ props: [P.name, P.displayName, P.id] });
    await flush();
    expect(w.queries[0].orderField).toBeUndefined();
    expect(w.queries[0].orderDirection).toBeUndefined();
    expect(w.ft.recorded()[0].path).toContain('order=display_name.asc,id.asc');
  });
});

describe('recordList: state and normalization', () => {
  it('normalizes page and pageSize (ported Q-10 1111-1120)', async () => {
    const w = make();
    await flush();
    expect(w.list.set({ pageSize: 5000 }).pageSize).toBe(200);
    expect(w.list.set({ pageSize: 'abc' }).pageSize).toBe(25);
    expect(w.list.set({ pageSize: 0 }).pageSize).toBe(25);
    expect(w.list.set({ pageSize: 50.9 }).pageSize).toBe(50);
    expect(w.list.set({ page: 0 }).page).toBe(1);
    expect(w.list.set({ page: -3 }).page).toBe(1);
    expect(w.list.set({ page: 'abc' }).page).toBe(1);
    expect(w.list.set({ page: '4' }).page).toBe(4);
  });

  it('sends the normalized page size (ported Q-10 1111)', async () => {
    const w = make({ options: { initial: { pageSize: 5000, page: -3 } } });
    await flush();
    expect(w.queries[0].pagination).toEqual({ page: 1, pageSize: 200 });
    const bad = make({ options: { initial: { pageSize: 'abc' } } });
    await flush();
    expect(bad.queries[0].pagination).toEqual({ page: 1, pageSize: 25 });
  });

  it('honours defaultPageSize and pageSizeOptions', async () => {
    const w = make({ options: { defaultPageSize: 10, pageSizeOptions: [10, 20, 40] } });
    await flush();
    expect(w.list.getSnapshot().state.pageSize).toBe(10);
    expect(w.list.set({ pageSize: 1000 }).pageSize).toBe(40);
    expect(w.list.set({ pageSize: 'x' }).pageSize).toBe(10);
  });

  it('normalizes sort, search and calendar input', async () => {
    const w = make();
    await flush();
    expect(w.list.set({ sort: { column: '', direction: 'sideways' } }).sort).toEqual({ column: null, direction: null });
    expect(w.list.set({ sort: { column: 'name', direction: 'desc' } }).sort).toEqual({ column: 'name', direction: 'desc' });
    expect(w.list.set({ sort: null }).sort).toEqual({ column: null, direction: null });
    expect(w.list.set({ search: null }).search).toBe('');
    expect(w.list.set({ calendar: { view: 'timeGridDay', date: '' } }).calendar).toBeNull();
    expect(w.list.set({ calendar: { view: 'timeGridDay', date: '2026-10-21' } }).calendar).toEqual({ view: 'timeGridDay', date: '2026-10-21' });
  });

  it('keeps the fields a set call leaves out', async () => {
    const w = make({ options: { initial: { search: 'x', page: 3 } } });
    await flush();
    const next = w.list.set({ pageSize: 50 });
    expect(next.search).toBe('x');
    expect(next.page).toBe(3);
  });

  it('returns to page 1 for the commands that say so', async () => {
    const w = make({ props: [P.name, prop('priority', T.IntegerNumber, { filterable: true })] });
    await flush();
    const reset = (cmd: () => unknown) => {
      w.list.setPage(5);
      cmd();
      expect(w.list.getSnapshot().state.page).toBe(1);
    };
    reset(() => w.list.setPageSize(50));
    reset(() => w.list.setSearch('x'));
    reset(() => w.list.toggleSort('name'));
    reset(() => w.list.applyFilterBar([{ column: 'priority', operator: 'eq', value: '1' }]));
    reset(() => w.list.removeFilter('priority'));
    reset(() => w.list.clearFilters());
    w.list.setPage(5);
    expect(w.list.getSnapshot().state.page).toBe(5);
  });

  it('returns the new state from every command', async () => {
    const w = make();
    await flush();
    expect(w.list.setPage(3)).toBe(w.list.getSnapshot().state);
    expect(w.list.setSearch('a')).toBe(w.list.getSnapshot().state);
  });

  it('cycles the sort ascending, descending, then none (ported toggleSort)', async () => {
    const w = make();
    await flush();
    expect(w.list.toggleSort('name').sort).toEqual({ column: 'name', direction: 'asc' });
    expect(w.list.toggleSort('name').sort).toEqual({ column: 'name', direction: 'desc' });
    expect(w.list.toggleSort('name').sort).toEqual({ column: null, direction: null });
  });

  it('starts another column at ascending', async () => {
    const w = make();
    await flush();
    w.list.toggleSort('name');
    w.list.toggleSort('name');
    expect(w.list.toggleSort('status_id').sort).toEqual({ column: 'status_id', direction: 'asc' });
  });

  it('changes nothing for a column that is not sortable', async () => {
    const w = make({ props: [prop('name', T.TextShort, { sortable: false })] });
    await flush();
    const before = w.list.getSnapshot();
    w.list.setPage(3);
    const state = w.list.toggleSort('name');
    expect(state.sort).toEqual({ column: null, direction: null });
    expect(state.page).toBe(3);
    await flush();
    expect(w.ft.requests).toHaveLength(2);
    expect(before).not.toBe(w.list.getSnapshot());
  });

  it('replaces the filter bar filters and keeps the others first', async () => {
    const priority = prop('priority', T.IntegerNumber, { filterable: true });
    const w = make({ props: [P.name, priority] });
    await flush();
    const link = { column: 'name', operator: 'eq', value: 'x' };
    w.list.set({ filters: [{ column: 'priority', operator: 'gte', value: '1' }, link] });
    const state = w.list.applyFilterBar([{ column: 'priority', operator: 'lte', value: '9' }]);
    expect(state.filters).toEqual([link, { column: 'priority', operator: 'lte', value: '9' }]);
    expect(w.list.applyFilterBar([]).filters).toEqual([link]);
  });

  it('removes every filter on a column and clears filters and search', async () => {
    const w = make();
    await flush();
    w.list.set({
      search: 'q',
      filters: [
        { column: 'a', operator: 'gte', value: '1' },
        { column: 'a', operator: 'lte', value: '2' },
        { column: 'b', operator: 'eq', value: '3' },
      ],
    });
    expect(w.list.removeFilter('a').filters).toEqual([{ column: 'b', operator: 'eq', value: '3' }]);
    const cleared = w.list.clearFilters();
    expect(cleared.filters).toEqual([]);
    expect(cleared.search).toBe('');
  });

  it('keeps the snapshot reference between changes and replaces it on one', async () => {
    const w = make();
    await flush();
    const a = w.list.getSnapshot();
    expect(w.list.getSnapshot()).toBe(a);
    w.list.setPage(2);
    expect(w.list.getSnapshot()).not.toBe(a);
  });
});

describe('recordList: loading', () => {
  it('sends nothing for a state equal to the current one and one request for a new state (ported 264)', async () => {
    const w = make();
    await flush();
    expect(w.ft.requests).toHaveLength(1);
    w.list.set({ page: 1, pageSize: 25, search: '' });
    w.list.setPage(1);
    await flush();
    expect(w.ft.requests).toHaveLength(1);
    w.list.set({ page: 2 });
    await flush();
    expect(w.ft.requests).toHaveLength(2);
    expect(w.queries[1].pagination).toEqual({ page: 2, pageSize: 25 });
  });

  it('does not notify for a command that leaves the state equal', async () => {
    const w = make();
    await flush();
    const listener = vi.fn();
    w.list.subscribe(listener);
    w.list.setPage(1);
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it('coalesces several commands in one task into one request', async () => {
    const w = make();
    await flush();
    w.list.setPage(3);
    w.list.setSearch('pothole');
    w.list.toggleSort('name');
    w.list.setPageSize(50);
    await flush();
    expect(w.ft.requests).toHaveLength(2);
    expect(w.queries[1].pagination).toEqual({ page: 1, pageSize: 50 });
  });

  it('marks the list loading as soon as a command changes the state', async () => {
    const w = make();
    await flush();
    expect(w.list.getSnapshot().loading).toBe(false);
    w.list.setPage(2);
    expect(w.list.getSnapshot().loading).toBe(true);
  });

  it('coalesces commands made before the first load into the one initial request', async () => {
    const w = make();
    w.list.setPage(2);
    w.list.setSearch('x');
    await flush();
    expect(w.ft.requests).toHaveLength(1);
    expect(w.queries[0].pagination).toEqual({ page: 1, pageSize: 25 });
  });

  it('lets the latest load win and drops the aborted one', async () => {
    const first = deferred();
    const second = deferred();
    const replies = [Promise.resolve(reply(200, [])), first.promise, second.promise];
    const w = make({ respond: () => replies.shift()! });
    await flush();
    w.list.setPage(2);
    await flush();
    w.list.setPage(3);
    await flush();
    expect(w.signals[1].aborted).toBe(true);
    expect(w.signals[2].aborted).toBe(false);
    expect(w.ft.recorded()[1].aborted).toBe(true);
    first.resolve(reply(200, [{ id: 'stale' }]));
    second.resolve(reply(200, [{ id: 'fresh' }]));
    await flush();
    const snap = w.list.getSnapshot();
    expect(snap.rows).toEqual([{ id: 'fresh' }]);
    expect(snap.loadedState?.page).toBe(3);
    expect(snap.error).toBeUndefined();
  });

  it('never lands a stale result even when it settles last', async () => {
    const first = deferred();
    const replies = [first.promise, Promise.resolve(reply(200, [{ id: 'fresh' }]))];
    const w = make({ respond: () => replies.shift()! });
    await flush();
    w.list.setPage(2);
    await flush();
    first.resolve(reply(200, [{ id: 'stale' }]));
    await flush();
    expect(w.list.getSnapshot().rows).toEqual([{ id: 'fresh' }]);
  });

  it('reloads the current state on reload', async () => {
    const w = make();
    await flush();
    w.list.reload();
    await flush();
    expect(w.ft.requests).toHaveLength(2);
    expect(w.queries[1]).toEqual(w.queries[0]);
  });

  it('notifies subscribers and unsubscribes idempotently', async () => {
    const w = make();
    await flush();
    const listener = vi.fn();
    const off = w.list.subscribe(listener);
    w.list.setPage(2);
    expect(listener).toHaveBeenCalled();
    await flush();
    const calls = listener.mock.calls.length;
    off();
    off();
    w.list.setPage(3);
    await flush();
    expect(listener.mock.calls.length).toBe(calls);
  });

  it('aborts the load in flight on dispose, stops notifying and rejects later commands', async () => {
    const d = deferred();
    const w = make({ respond: () => d.promise });
    await flush();
    const listener = vi.fn();
    w.list.subscribe(listener);
    w.list.dispose();
    expect(w.signals[0].aborted).toBe(true);
    d.resolve(reply(200, [{ id: 1 }]));
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(() => w.list.setPage(2)).toThrow();
    expect(() => w.list.set({ page: 2 })).toThrow();
    expect(() => w.list.reload()).toThrow();
  });
});

describe('recordList: search', () => {
  it('searches through searchQuery for an entity with only search_fields (ported 401)', async () => {
    const w = make({ entity: { search_fields: ['name'] } });
    await flush();
    w.list.setSearch('pothole');
    await flush();
    expect(w.queries[1].searchQuery).toBe('pothole');
    expect(w.queries[1].rawQueryParams).toBeUndefined();
    expect(w.ft.recorded()[1].path).toContain('civic_os_text_search=wfts.pothole');
  });

  it('searches through buildHybridSearchParams for a full-text or substring column (ported 412)', async () => {
    const fts = make({ entity: { fulltext_search_column: 'search_vec' } });
    const both = make({ entity: { fulltext_search_column: 'search_vec', substring_search_column: 'name', search_fields: ['name'] } });
    const sub = make({ entity: { substring_search_column: 'name' } });
    await flush();
    fts.list.setSearch('pot hole');
    both.list.setSearch('pot');
    sub.list.setSearch('pot');
    await flush();
    expect(fts.queries[1].rawQueryParams).toEqual(['search_vec=wfts.pot%20hole']);
    expect(fts.queries[1].searchQuery).toBeUndefined();
    expect(both.queries[1].rawQueryParams).toEqual(['or=(search_vec.wfts.pot,name.ilike.*pot*)']);
    expect(both.queries[1].searchQuery).toBeUndefined();
    expect(sub.queries[1].rawQueryParams).toEqual(['name=ilike.*pot*']);
  });

  it('sends no search for an entity without search configuration (ported 412)', async () => {
    const w = make();
    await flush();
    w.list.setSearch('pothole');
    await flush();
    expect(w.queries[1].searchQuery).toBeUndefined();
    expect(w.queries[1].rawQueryParams).toBeUndefined();
  });

  it('drops the sort while searching on the searchQuery path', async () => {
    const w = make({ entity: { search_fields: ['name'] }, props: [P.name, P.displayName, P.id], options: { initial: { sort: { column: 'name', direction: 'desc' } } } });
    await flush();
    expect(w.queries[0].orderField).toBe('name');
    w.list.setSearch('pot');
    await flush();
    expect(w.queries[1].orderField).toBeUndefined();
    expect(w.queries[1].orderDirection).toBeUndefined();
    expect(w.ft.recorded()[1].path).toContain('order=display_name.asc,id.asc');
    expect(w.list.getSnapshot().state.sort).toEqual({ column: 'name', direction: 'desc' });
  });

  it('drops the sort while searching on the hybrid path', async () => {
    const w = make({ entity: { fulltext_search_column: 'search_vec' }, options: { initial: { sort: { column: 'name', direction: 'asc' } } } });
    await flush();
    w.list.setSearch('pot');
    await flush();
    expect(w.queries[1].orderField).toBeUndefined();
    expect(w.queries[1].orderDirection).toBeUndefined();
  });

  it.each([
    ['searchQuery', { search_fields: ['name'] }],
    ['hybrid', { substring_search_column: 'name' }],
  ])('drops the sort but sends no search clause for a blank search on the %s path, as the legacy page did', async (_path, entity) => {
    const w = make({ entity, props: [P.name, P.displayName, P.id], options: { initial: { sort: { column: 'name', direction: 'asc' } } } });
    await flush();
    w.list.setSearch('   ');
    await flush();
    expect(w.queries[1].orderField).toBeUndefined();
    expect(w.queries[1].rawQueryParams).toBeUndefined();
    const path = w.ft.recorded()[1].path;
    expect(path).toContain('order=display_name.asc,id.asc');
    expect(path).not.toContain('civic_os_text_search');
    expect(path).not.toContain('ilike');
  });

  it('splits the search into terms for highlighting (ported 347-373)', async () => {
    const w = make();
    await flush();
    const terms = (s: string | null) => w.list.set({ search: s }) && w.list.getSnapshot().searchTerms;
    expect(terms('pothole main street')).toEqual(['pothole', 'main', 'street']);
    expect(terms('')).toEqual([]);
    expect(terms('  pothole   main   ')).toEqual(['pothole', 'main']);
    expect(terms('pothole')).toEqual(['pothole']);
    expect(terms('   ')).toEqual([]);
  });

  it('reports filtered for a filter or a non-blank search', async () => {
    const w = make();
    await flush();
    expect(w.list.getSnapshot().filtered).toBe(false);
    w.list.set({ search: '  ' });
    expect(w.list.getSnapshot().filtered).toBe(false);
    w.list.set({ search: 'x' });
    expect(w.list.getSnapshot().filtered).toBe(true);
    w.list.set({ search: '', filters: [{ column: 'name', operator: 'eq', value: 'x' }] });
    expect(w.list.getSnapshot().filtered).toBe(true);
  });
});

describe('recordList: filters and chips', () => {
  const priority = prop('priority', T.IntegerNumber, { display_name: 'Priority', filterable: true });
  const hiddenFk = prop('owner_id', T.ForeignKeyName, { display_name: 'Owner', show_on_list: false, filterable: true, join_schema: 'public', join_table: 'Owner', join_column: 'id' });
  const flag = prop('urgent', T.Boolean, { display_name: 'Urgent', filterable: true });
  const assignee = prop('assignee_id', T.User, { display_name: 'Assignee', filterable: true, join_schema: 'public', join_table: 'civic_os_users', join_column: 'id' });
  const props = [P.name, priority, hiddenFk, flag, assignee, P.status];

  it('sends the filters on list and filter columns, including a hidden filterable column', async () => {
    const w = make({
      props,
      options: {
        initial: {
          filters: [
            { column: 'name', operator: 'eq', value: 'x' },
            { column: 'owner_id', operator: 'in', value: '(1,2)' },
          ],
        },
      },
    });
    await flush();
    expect(w.queries[0].filters).toEqual([
      { column: 'name', operator: 'eq', value: 'x' },
      { column: 'owner_id', operator: 'in', value: '(1,2)' },
    ]);
  });

  it('does not send a filter on a column outside the columns and filter columns, but still shows a chip', async () => {
    const w = make({ props, options: { initial: { filters: [{ column: 'ghost', operator: 'eq', value: 'x' }] } } });
    await flush();
    expect(w.queries[0].filters).toBeUndefined();
    expect(w.ft.recorded()[0].path).not.toContain('ghost');
    expect(w.list.getSnapshot().chips).toEqual([{ kind: 'value', column: 'ghost', label: 'ghost', operator: 'eq', value: 'x' }]);
  });

  it('sends two filters on one column together', async () => {
    const w = make({
      props,
      options: { initial: { filters: [{ column: 'priority', operator: 'gte', value: '1' }, { column: 'priority', operator: 'lte', value: '5' }] } },
    });
    await flush();
    expect(w.queries[0].filters).toHaveLength(2);
    expect(w.ft.recorded()[0].path).toContain('and=(priority.gte.1,priority.lte.5)');
  });

  it('merges gte and lte on one column into a range chip', async () => {
    const w = make({ props, options: { initial: { filters: [{ column: 'priority', operator: 'gte', value: '1' }, { column: 'priority', operator: 'lte', value: '5' }] } } });
    await flush();
    expect(w.list.getSnapshot().chips).toEqual([{ kind: 'range', column: 'priority', label: 'Priority', min: '1', max: '5' }]);
  });

  it('shows a lone gte or lte as its own chip', async () => {
    const w = make({ props, options: { initial: { filters: [{ column: 'priority', operator: 'gte', value: '4' }] } } });
    await flush();
    expect(w.list.getSnapshot().chips).toEqual([{ kind: 'gte', column: 'priority', label: 'Priority', value: '4' }]);
    w.list.set({ filters: [{ column: 'priority', operator: 'lte', value: '9' }] });
    expect(w.list.getSnapshot().chips).toEqual([{ kind: 'lte', column: 'priority', label: 'Priority', value: '9' }]);
  });

  it('counts the ids of an in filter on a foreign key or user column', async () => {
    const w = make({
      props,
      options: {
        initial: {
          filters: [
            { column: 'status_id', operator: 'in', value: '(1,2,3)' },
            { column: 'assignee_id', operator: 'in', value: '7' },
          ],
        },
      },
    });
    await flush();
    expect(w.list.getSnapshot().chips).toEqual([
      { kind: 'selected', column: 'status_id', label: 'Status', operator: 'in', value: '(1,2,3)', count: 3 },
      { kind: 'selected', column: 'assignee_id', label: 'Assignee', operator: 'in', value: '7', count: 1 },
    ]);
  });

  it('marks a Boolean filter yes or no', async () => {
    const w = make({ props, options: { initial: { filters: [{ column: 'urgent', operator: 'eq', value: 'true' }] } } });
    await flush();
    expect(w.list.getSnapshot().chips).toEqual([{ kind: 'boolean', column: 'urgent', label: 'Urgent', operator: 'eq', value: 'true', yes: true }]);
    w.list.set({ filters: [{ column: 'urgent', operator: 'eq', value: 'false' }] });
    expect(w.list.getSnapshot().chips[0]).toMatchObject({ kind: 'boolean', yes: false });
  });

  it('shows other operators as value chips, labelled from a filter-only column', async () => {
    const w = make({ props, options: { initial: { filters: [{ column: 'owner_id', operator: 'eq', value: '4' }, { column: 'name', operator: 'eq', value: 'x' }] } } });
    await flush();
    expect(w.list.getSnapshot().chips).toEqual([
      { kind: 'value', column: 'owner_id', label: 'Owner', operator: 'eq', value: '4' },
      { kind: 'value', column: 'name', label: 'Name', operator: 'eq', value: 'x' },
    ]);
  });

  it('has no chips without filters', async () => {
    const w = make({ props });
    await flush();
    expect(w.list.getSnapshot().chips).toEqual([]);
  });
});

describe('recordList: map', () => {
  const mapEntity = { show_map: true, map_property_name: 'location', display_name: 'Issue' };

  it('builds markers from WKT and skips rows without a location (ported 609, 638)', async () => {
    const rows = [
      { id: 1, name: 'a', location: 'POINT(-83.5 43.0)', display_name: 'Issue 1' },
      { id: 2, name: 'b', location: null, display_name: 'Issue 2' },
      { id: 3, name: 'c', location: 'POINT(-83.6 43.1)' },
    ];
    const w = make({ entity: mapEntity, props: [P.name, P.geo], respond: async () => reply(200, rows) });
    await flush();
    const snap = w.list.getSnapshot();
    expect(snap.markers).toEqual([
      { id: 1, name: 'Issue 1', wkt: 'POINT(-83.5 43.0)' },
      { id: 3, name: 'Issue #3', wkt: 'POINT(-83.6 43.1)' },
    ]);
    expect(snap.polygons).toEqual([]);
  });

  it('builds polygons with the unresolved color value, and no markers', async () => {
    const rows = [
      { id: 1, area: 'POLYGON((0 0,1 0,1 1,0 0))', display_name: 'A', fill: '#ff0000' },
      { id: 2, area: 'POLYGON((0 0,2 0,2 2,0 0))', display_name: 'B', fill: null },
      { id: 3, area: null, display_name: 'C' },
    ];
    const w = make({
      entity: { show_map: true, map_property_name: 'area', map_color_property: 'fill' },
      props: [P.polygon],
      respond: async () => reply(200, rows),
    });
    await flush();
    const snap = w.list.getSnapshot();
    expect(snap.markers).toEqual([]);
    expect(snap.polygons).toEqual([
      { id: 1, name: 'A', wkt: 'POLYGON((0 0,1 0,1 1,0 0))', color: '#ff0000' },
      { id: 2, name: 'B', wkt: 'POLYGON((0 0,2 0,2 2,0 0))', color: undefined },
    ]);
  });

  it('has no markers or polygons while loading or when the map is off', async () => {
    const w = make({ entity: { ...mapEntity, show_map: false }, props: [P.geo], respond: async () => reply(200, [{ id: 1, location: 'POINT(1 1)' }]) });
    await flush();
    expect(w.list.getSnapshot().markers).toEqual([]);
  });
});

describe('recordList: calendar events', () => {
  const rows = (...r: object[]) => async () => reply(200, r);
  // A calendar list loads once a range is known.
  const range = { calendar: { view: 'timeGridWeek', date: '2025-03-16' } };

  it('has no events for an entity without a calendar (ported 666)', async () => {
    const w = make({ entity: { show_calendar: false }, props: [P.name], respond: rows({ id: 1, time_slot: '[2025-03-15T14:00:00Z,2025-03-15T16:00:00Z)' }) });
    await flush();
    expect(w.list.getSnapshot().events).toEqual([]);
  });

  it('builds events with the default color (ported 680)', async () => {
    const w = make({
      entity: CAL,
      props: [P.name, P.slot],
      options: { initial: range },
      respond: rows(
        { id: 1, display_name: 'Team Meeting', time_slot: '[2025-03-15T14:00:00Z,2025-03-15T16:00:00Z)' },
        { id: 2, display_name: 'Workshop', time_slot: '[2025-03-20T09:00:00Z,2025-03-20T12:00:00Z)' },
      ),
    });
    await flush();
    const events = w.list.getSnapshot().events;
    expect(events).toHaveLength(2);
    expect(events.map(e => e.color)).toEqual(['#3B82F6', '#3B82F6']);
    expect(events[0].title).toBe('Team Meeting');
    expect(events[0].start).toEqual(new Date('2025-03-15T14:00:00Z'));
    expect(events[0].end).toEqual(new Date('2025-03-15T16:00:00Z'));
    expect(events[0].id).toBe(1);
    expect(events[0].row).toMatchObject({ id: 1, display_name: 'Team Meeting' });
  });

  it('takes the color from calendar_color_property (ported 721)', async () => {
    const w = make({
      entity: { ...CAL, calendar_color_property: 'status_color' },
      props: [P.name, P.slot],
      options: { initial: range },
      respond: rows(
        { id: 1, display_name: 'A', time_slot: '[2025-03-15T14:00:00Z,2025-03-15T16:00:00Z)', status_color: '#10B981' },
        { id: 2, display_name: 'B', time_slot: '[2025-03-20T09:00:00Z,2025-03-20T12:00:00Z)', status_color: '#EF4444' },
        { id: 3, display_name: 'C', time_slot: '[2025-03-22T13:00:00Z,2025-03-22T15:00:00Z)', status_color: '#F59E0B' },
      ),
    });
    await flush();
    expect(w.list.getSnapshot().events.map(e => [e.title, e.color])).toEqual([
      ['A', '#10B981'],
      ['B', '#EF4444'],
      ['C', '#F59E0B'],
    ]);
  });

  it('leaves out rows without a time slot (ported 772)', async () => {
    const w = make({
      entity: CAL,
      props: [P.name, P.slot],
      options: { initial: range },
      respond: rows(
        { id: 1, display_name: 'Valid', time_slot: '[2025-03-15T14:00:00Z,2025-03-15T16:00:00Z)' },
        { id: 2, display_name: 'None', time_slot: null },
        { id: 3, display_name: 'Valid too', time_slot: '[2025-03-20T09:00:00Z,2025-03-20T12:00:00Z)' },
      ),
    });
    await flush();
    expect(w.list.getSnapshot().events.map(e => e.id)).toEqual([1, 3]);
  });

  it('falls back to the default color when the color value is missing or empty (ported 812)', async () => {
    const w = make({
      entity: { ...CAL, calendar_color_property: 'status_color' },
      props: [P.name, P.slot],
      options: { initial: range },
      respond: rows(
        { id: 1, display_name: 'With', time_slot: '[2025-03-15T14:00:00Z,2025-03-15T16:00:00Z)', status_color: '#10B981' },
        { id: 2, display_name: 'Null', time_slot: '[2025-03-20T09:00:00Z,2025-03-20T12:00:00Z)', status_color: null },
        { id: 3, display_name: 'Empty', time_slot: '[2025-03-21T09:00:00Z,2025-03-21T12:00:00Z)', status_color: '' },
      ),
    });
    await flush();
    expect(w.list.getSnapshot().events.map(e => e.color)).toEqual(['#10B981', '#3B82F6', '#3B82F6']);
  });

  it('titles a row without display_name with the entity name and id (ported 849)', async () => {
    const w = make({
      entity: { ...CAL, display_name: 'Reservation' },
      props: [P.name, P.slot],
      options: { initial: range },
      respond: rows({ id: 1, time_slot: '[2025-03-15T14:00:00Z,2025-03-15T16:00:00Z)' }),
    });
    await flush();
    expect(w.list.getSnapshot().events[0].title).toBe('Reservation #1');
  });

  it('parses a PostgreSQL tstzrange with quoted bounds', async () => {
    const w = make({
      entity: CAL,
      props: [P.name, P.slot],
      options: { initial: range },
      respond: rows({ id: 1, display_name: 'Q', time_slot: '["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")' }),
    });
    await flush();
    const [event] = w.list.getSnapshot().events;
    expect(event.start).toEqual(new Date('2025-03-15T14:00:00Z'));
    expect(event.end).toEqual(new Date('2025-03-15T16:00:00Z'));
  });
});

describe('recordList: calendar loading', () => {
  const props = [P.name, P.slot];

  it('sends no request before a range while the calendar view is shown, and stays loading', async () => {
    const w = make({ entity: CAL, props });
    await flush();
    expect(w.ft.requests).toHaveLength(0);
    expect(w.list.getSnapshot().loading).toBe(true);
    w.list.set({ calendar: { view: 'timeGridDay', date: '2026-10-21' } });
    await flush();
    expect(w.ft.requests).toHaveLength(1);
    expect(w.list.getSnapshot().loading).toBe(false);
  });

  it('loads once setCalendarRange reports a range', async () => {
    const w = make({ entity: CAL, props });
    await flush();
    w.list.setCalendarRange({ start: new Date(2026, 9, 18), end: new Date(2026, 9, 25) });
    await flush();
    expect(w.ft.requests).toHaveLength(1);
  });

  it('adds the ov filter after the list filters with page 1 and size 1000', async () => {
    const w = make({
      entity: CAL,
      props,
      options: {
        initial: {
          page: 4,
          pageSize: 50,
          filters: [{ column: 'name', operator: 'eq', value: 'x' }],
          calendar: { view: 'timeGridDay', date: '2026-10-21' },
        },
      },
    });
    await flush();
    const start = new Date(2026, 9, 21).toISOString();
    const end = new Date(2026, 9, 22).toISOString();
    expect(w.queries[0].filters).toEqual([
      { column: 'name', operator: 'eq', value: 'x' },
      { column: 'time_slot', operator: 'ov', value: `[${start},${end})` },
    ]);
    expect(w.queries[0].pagination).toEqual({ page: 1, pageSize: 1000 });
    expect(w.list.getSnapshot().state.page).toBe(4);
  });

  it('still sends the ov filter when the calendar is configured but select is false', async () => {
    const w = make({ entity: { ...CAL, select: false }, props, options: { initial: { calendar: { view: 'timeGridDay', date: '2026-10-21' } } } });
    await flush();
    expect(w.list.getSnapshot().views.calendar).toBe(false);
    expect(w.queries[0].filters?.[0]).toMatchObject({ column: 'time_slot', operator: 'ov' });
    expect(w.queries[0].pagination).toEqual({ page: 1, pageSize: 1000 });
  });

  it('loads without a range when the calendar is configured but not shown', async () => {
    const w = make({ entity: { ...CAL, select: false }, props });
    await flush();
    expect(w.ft.requests).toHaveLength(1);
    expect(w.queries[0].filters).toBeUndefined();
    expect(w.queries[0].pagination).toEqual({ page: 1, pageSize: 25 });
  });

  it('sends no ov filter for an entity without a calendar even with a range in the state', async () => {
    const w = make({ props: [P.name], options: { initial: { calendar: { view: 'timeGridDay', date: '2026-10-21' } } } });
    await flush();
    expect(w.queries[0].filters).toBeUndefined();
    expect(w.queries[0].pagination).toEqual({ page: 1, pageSize: 25 });
  });

  it('gives an unknown view an empty range', async () => {
    const w = make({ entity: CAL, props, options: { initial: { calendar: { view: 'listYear', date: '2026-10-21' } } } });
    await flush();
    const at = new Date(2026, 9, 21).toISOString();
    expect(w.queries[0].filters).toEqual([{ column: 'time_slot', operator: 'ov', value: `[${at},${at})` }]);
  });

  describe('setCalendarRange inference', () => {
    const infer = async (start: Date, end: Date) => {
      const w = make({ entity: CAL, props });
      await flush();
      const state = w.list.setCalendarRange({ start, end });
      return { w, state };
    };

    it('takes up to a day as timeGridDay at the start', async () => {
      const { state } = await infer(new Date(2026, 9, 21), new Date(2026, 9, 22));
      expect(state.calendar).toEqual({ view: 'timeGridDay', date: '2026-10-21' });
    });

    it('takes up to a week as timeGridWeek at the start', async () => {
      const { state } = await infer(new Date(2026, 9, 18), new Date(2026, 9, 25));
      expect(state.calendar).toEqual({ view: 'timeGridWeek', date: '2026-10-18' });
    });

    it('takes a longer range as dayGridMonth at the 1st of the midpoint month', async () => {
      const { state } = await infer(new Date(2026, 8, 27), new Date(2026, 10, 1));
      expect(state.calendar).toEqual({ view: 'dayGridMonth', date: '2026-10-01' });
    });

    it('returns to page 1 and marks the list loading', async () => {
      const { w, state } = await infer(new Date(2026, 9, 21), new Date(2026, 9, 22));
      w.list.setPage(3);
      const next = w.list.setCalendarRange({ start: new Date(2026, 9, 22), end: new Date(2026, 9, 23) });
      expect(next.page).toBe(1);
      expect(state.calendar).not.toEqual(next.calendar);
      expect(w.list.getSnapshot().loading).toBe(true);
    });

    it('marks the list loading even when the state stays equal', async () => {
      const { w } = await infer(new Date(2026, 9, 21), new Date(2026, 9, 22));
      await flush();
      expect(w.list.getSnapshot().loading).toBe(false);
      w.list.setCalendarRange({ start: new Date(2026, 9, 21), end: new Date(2026, 9, 22) });
      expect(w.list.getSnapshot().loading).toBe(true);
      await flush();
      expect(w.ft.requests).toHaveLength(1);
    });

    // Ported 917-958: the focus date is the LOCAL date, never the UTC date.
    it.each([
      ['late evening (before local midnight, after UTC midnight) (917)', new Date(2025, 10, 28, 23, 30), '2025-11-28'],
      ['early morning (930)', new Date(2025, 10, 28, 1, 0), '2025-11-28'],
      ['noon (937)', new Date(2025, 10, 28, 12, 0), '2025-11-28'],
      ['a month boundary (944)', new Date(2025, 10, 30, 23, 59), '2025-11-30'],
      ['a year boundary (951)', new Date(2025, 11, 31, 23, 59), '2025-12-31'],
      ['zero-padded month and day (958)', new Date(2025, 0, 5, 12, 0), '2025-01-05'],
    ])('writes the local date for %s', async (_name, start, expected) => {
      const { state } = await infer(start, new Date(start.getTime() + 60 * 60 * 1000));
      expect(state.calendar).toEqual({ view: 'timeGridDay', date: expected });
    });
  });

  describe('range from a ListCalendar (ported 971-998)', () => {
    const rangeOf = async (view: string, date: string) => {
      const w = make({ entity: CAL, props, options: { initial: { calendar: { view, date } } } });
      await flush();
      return (w.queries[0].filters ?? []).find(f => f.operator === 'ov')!.value as string;
    };
    const bounds = (start: Date, end: Date) => `[${start.toISOString()},${end.toISOString()})`;

    it('parses the date in the local timezone (971)', async () => {
      expect(await rangeOf('timeGridDay', '2025-11-28')).toBe(bounds(new Date(2025, 10, 28), new Date(2025, 10, 29)));
    });

    it('starts the week on the Sunday on or before the date (998)', async () => {
      // Friday 2025-11-28: the week is Sun 11-23 up to Sun 11-30.
      expect(await rangeOf('timeGridWeek', '2025-11-28')).toBe(bounds(new Date(2025, 10, 23), new Date(2025, 10, 30)));
      // A Sunday starts its own week.
      expect(await rangeOf('timeGridWeek', '2025-11-23')).toBe(bounds(new Date(2025, 10, 23), new Date(2025, 10, 30)));
    });

    it('extends the month to whole weeks', async () => {
      // November 2025 starts on a Saturday and ends on a Sunday.
      expect(await rangeOf('dayGridMonth', '2025-11-01')).toBe(bounds(new Date(2025, 9, 26), new Date(2025, 11, 7)));
    });
  });
});

describe('recordList: calendar ranges in America/New_York', () => {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  const ov = async (view: string, date: string) => {
    const w = make({ entity: CAL, props: [P.name, P.slot], options: { initial: { calendar: { view, date } } } });
    await flush();
    return (w.queries[0].filters ?? []).find(f => f.operator === 'ov')!.value;
  };

  it('sends a day as local midnight to the next local midnight', async () => {
    expect(await ov('timeGridDay', '2026-10-21')).toBe('[2026-10-21T04:00:00.000Z,2026-10-22T04:00:00.000Z)');
  });

  it('sends a week from its Sunday', async () => {
    expect(await ov('timeGridWeek', '2026-10-18')).toBe('[2026-10-18T04:00:00.000Z,2026-10-25T04:00:00.000Z)');
  });

  it('sends the month grid', async () => {
    expect(await ov('dayGridMonth', '2026-10-01')).toBe('[2026-09-27T04:00:00.000Z,2026-11-01T04:00:00.000Z)');
  });

  it('sends a month grid that crosses the DST change', async () => {
    expect(await ov('dayGridMonth', '2026-11-01')).toBe('[2026-11-01T04:00:00.000Z,2026-12-06T05:00:00.000Z)');
  });
});
