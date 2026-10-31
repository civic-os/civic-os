/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `recordList`: the List page's state and loading, without layout
 * (`docs/notes/FRONTEND_SDK_DESIGN.md` §11).
 *
 * The facade holds the list state and changes it only through its commands.
 * Each command normalizes its input wherever it came from (a URL, a control,
 * a custom app) and returns the new state, so a caller that mirrors the state
 * elsewhere (the generic app's URL) knows what to write. The URL is not the
 * facade's concern, and neither is the stored page-size preference: the
 * caller reads them and hands the values to {@link RecordList.set}.
 *
 * Loading: a command that changes the state schedules one load in a
 * microtask, so several commands in one task send one request. A new load
 * aborts the one in flight (latest wins). A command that leaves the state
 * equal to the current one schedules nothing.
 */

import { createStore } from '../client/store.js';
import type { EntityHandle } from '../handles/handles.js';
import { EntityPropertyType } from '../model/index.js';
import type { DataQuery, EntityData, FilterCriteria, SchemaEntityProperty } from '../model/index.js';
import { buildHybridSearchParams, buildOrderField } from '../query/search.js';
import { propsForFilter, propsForList } from '../schema/property-views.js';
import { propertyToSelectStringForList } from '../schema/select.js';
import type { AbortSignalLike } from '../transport/types.js';
import type { FacadeDeps } from './deps.js';

/**
 * The sort as the user set it. Both halves are kept apart, as the URL holds
 * them: a column without a direction sends no order.
 *
 * @consumer typed recordList
 */
export interface ListSort {
  readonly column: string | null;
  readonly direction: 'asc' | 'desc' | null;
}

/**
 * The calendar's visible range as a view name and a local `YYYY-MM-DD` focus
 * date. The view is kept as given; an unknown view yields an empty range.
 *
 * @consumer typed recordList
 */
export interface ListCalendar {
  readonly view: string;
  readonly date: string;
}

/**
 * The normalized list state.
 *
 * @consumer typed recordList
 */
export interface ListState {
  /** An integer of at least 1. */
  readonly page: number;
  /** An integer from 1 to the largest page-size option. */
  readonly pageSize: number;
  readonly sort: ListSort;
  /** The search text as typed; `''` when none. */
  readonly search: string;
  /**
   * Every filter in the order given, including filters on columns the entity
   * does not have (they show as chips and are left out of the request).
   */
  readonly filters: readonly FilterCriteria[];
  /** `null` until the calendar reports a range, or when the caller sets none. */
  readonly calendar: ListCalendar | null;
}

/**
 * Raw values for {@link RecordList.set}, as a URL or a control hands them
 * over. A field left out keeps its current value.
 *
 * Normalization, per field:
 * - `page`: `Math.floor(Number(v))`; not finite or below 1 gives 1.
 * - `pageSize`: `Math.floor(Number(v))`; not finite or below 1 gives the
 *   default page size; above the largest option gives the largest option.
 * - `sort`: `column` becomes `null` when empty, and `direction` when it is
 *   neither `'asc'` nor `'desc'`.
 * - `search`: `null` or `undefined` gives `''`.
 * - `calendar`: `null` unless both `view` and `date` are non-empty.
 *
 * @consumer typed recordList
 */
export interface ListStateInput {
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly sort?: { readonly column?: string | null; readonly direction?: string | null } | null;
  readonly search?: string | null;
  readonly filters?: readonly FilterCriteria[];
  readonly calendar?: { readonly view?: string | null; readonly date?: string | null } | null;
}

/**
 * One active-filter chip. Filters on one column merge: a `gte` and an `lte`
 * become one `range` chip, and a lone `gte` or `lte` its own chip; otherwise
 * each filter is a chip. `label` is the display name of the column's property
 * in `columns` or `filterColumns`; a column in neither (hidden from the list
 * and not filterable, or unknown) gives the column name and a `value` chip.
 * The caller words the value (`≥ 4`, `2 selected`, `Yes`).
 *
 * @consumer typed recordList
 */
export type ListFilterChip =
  | { readonly kind: 'range'; readonly column: string; readonly label: string; readonly min: unknown; readonly max: unknown }
  | { readonly kind: 'gte' | 'lte'; readonly column: string; readonly label: string; readonly value: unknown }
  /** An `in` filter on a foreign-key or user column; `count` is the number of ids in `(a,b,c)`, or 1. */
  | { readonly kind: 'selected'; readonly column: string; readonly label: string; readonly operator: string; readonly value: unknown; readonly count: number }
  /** A filter on a Boolean column; `yes` is `value === 'true'`. */
  | { readonly kind: 'boolean'; readonly column: string; readonly label: string; readonly operator: string; readonly value: unknown; readonly yes: boolean }
  | { readonly kind: 'value'; readonly column: string; readonly label: string; readonly operator: string; readonly value: unknown };

/**
 * One row placed on the map: `name` is the row's `display_name`, or
 * `` `${entity display name} #${id}` `` when it has none.
 *
 * @consumer typed recordList
 */
export interface ListMapFeature {
  readonly id: number;
  readonly name: string;
  /** The map property's value as PostgREST returned it (WKT through the `_text` alias). */
  readonly wkt: string;
  /** Polygons only: the row's `map_color_property` value, unresolved (a hex string or an embedded category). */
  readonly color?: unknown;
}

/**
 * One row placed on the calendar, from its `tstzrange` value.
 *
 * @consumer typed recordList
 */
export interface ListCalendarEvent {
  readonly id: number;
  /** The row's `display_name`, or `` `${entity display name} #${id}` ``. */
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  /** The row's `calendar_color_property` value, or `'#3B82F6'` when unset or empty. */
  readonly color: string;
  readonly row: EntityData;
}

/**
 * Which views the entity shows.
 *
 * @consumer typed recordList
 */
export interface ListViews {
  /** A read-only summary VIEW (`is_view` and not insertable): rows are not links. */
  readonly summary: boolean;
  /** `show_map` with a map property: `'polygon'` when it is a GeoPolygon, otherwise `'point'`. */
  readonly map: 'point' | 'polygon' | null;
  /** `show_calendar` with a calendar property, and the user may select the entity. */
  readonly calendar: boolean;
}

/**
 * Everything the facade knows at one moment. Stable between changes (the
 * `useSyncExternalStore` contract).
 *
 * @consumer typed recordList
 */
export interface RecordListSnapshot {
  readonly state: ListState;
  /** True from creation until the first load settles, while a load is scheduled or in flight, and after {@link RecordList.setCalendarRange}. */
  readonly loading: boolean;
  /** `[]` from the moment a load starts until it settles. */
  readonly rows: readonly EntityData[];
  /** The `Content-Range` total, or the row count when the server sends none; 0 while loading. */
  readonly totalCount: number;
  /** The last load's failure, or `undefined`. Rows are `[]` after a failure. */
  readonly error: unknown;
  /** The state the current rows were loaded for; `undefined` until a load settles. */
  readonly loadedState: ListState | undefined;
  /** The properties the list fetches: `propsForList` (the map property and the structural columns included). */
  readonly columns: readonly SchemaEntityProperty[];
  /** The columns the table shows: `columns` without those with `show_on_list === false`. */
  readonly displayColumns: readonly SchemaEntityProperty[];
  /** `propsForFilter`: the filter bar's columns, which may be hidden from the table. */
  readonly filterColumns: readonly SchemaEntityProperty[];
  readonly chips: readonly ListFilterChip[];
  /** The search split on whitespace, for highlighting; `[]` when blank. */
  readonly searchTerms: readonly string[];
  /** Any filter, or a non-blank search. */
  readonly filtered: boolean;
  readonly views: ListViews;
  /** GeoPoint map only; rows without a map value are left out. */
  readonly markers: readonly ListMapFeature[];
  /** GeoPolygon map only; rows without a map value are left out. */
  readonly polygons: readonly ListMapFeature[];
  /** Calendar only; rows without a calendar value are left out. */
  readonly events: readonly ListCalendarEvent[];
}

/**
 * Policy a caller may set; the defaults are the generic app's.
 *
 * @consumer typed recordList
 */
export interface RecordListOptions {
  /** The starting state, normalized as {@link RecordList.set} does. */
  readonly initial?: ListStateInput;
  /** The page size when none is given or the given one is invalid. Default 25. */
  readonly defaultPageSize?: number;
  /** The page sizes offered; the largest caps `pageSize`. Default `[10, 25, 50, 100, 200]`. */
  readonly pageSizeOptions?: readonly number[];
}

/**
 * A list over one entity.
 *
 * The request each load sends, with `columns` from the entity's properties:
 * - `fields`: `propertyToSelectStringForList` of each column, then the
 *   `calendar_color_property` and the `map_color_property` (FK-aware) when
 *   configured and not already selected;
 * - `filters`: the state's filters on columns in `columns` or
 *   `filterColumns`, then, when the entity has a calendar configured
 *   (`show_calendar` and a calendar property, whether or not
 *   `views.calendar`) and the state has a range,
 *   `{ column: calendar_property_name, operator: 'ov', value: '[start,end)' }`
 *   with ISO bounds;
 * - search, for an entity with a full-text or substring search column:
 *   `buildHybridSearchParams` as `rawQueryParams`; with only `search_fields`,
 *   `searchQuery`;
 * - order: `buildOrderField` of the sorted column when both sort halves are
 *   set, the column is in `columns` and no search is active; otherwise none,
 *   so the query compiler's default order applies (`display_name.asc,id.asc`);
 * - `pagination`: the state's, or `{ page: 1, pageSize: 1000 }` under the same
 *   condition as the `ov` filter;
 * - `isSummaryView` for a summary VIEW, and `entityColumns` from the entity's
 *   non-M:M properties.
 *
 * No load is sent while the entity is unknown or has no list columns. When
 * `views.calendar` is true and the state has no range, the load uses the
 * calendar's opening range, the `timeGridWeek` holding the clock's today, so a
 * calendar list never sends an unranged request; a state change that leaves
 * the loaded query as it was (the calendar then reporting that same range)
 * sends nothing.
 *
 * @consumer app
 */
export interface RecordList {
  getSnapshot(): RecordListSnapshot;
  /** Returns an idempotent unsubscribe. */
  subscribe(listener: () => void): () => void;

  /** Sets the given fields, each normalized; the others keep their values. */
  set(input: ListStateInput): ListState;
  setPage(page: unknown): ListState;
  /** Also returns to page 1. */
  setPageSize(pageSize: unknown): ListState;
  /** Also returns to page 1. */
  setSearch(search: string | null): ListState;
  /**
   * Cycles the column's sort, ascending, then descending, then none; another
   * column starts at ascending. Also returns to page 1. A column whose
   * property has `sortable === false` changes nothing.
   */
  toggleSort(column: string): ListState;
  /**
   * The filter bar's filters replace those on its columns; filters on other
   * columns (a Related Records link's) are kept, first. Also returns to page 1.
   */
  applyFilterBar(filters: readonly FilterCriteria[]): ListState;
  /** Drops every filter on the column. Also returns to page 1. */
  removeFilter(column: string): ListState;
  /** Drops every filter and the search. Also returns to page 1. */
  clearFilters(): ListState;
  /**
   * The calendar's visible range: up to a day is `timeGridDay` at its start,
   * up to a week `timeGridWeek` at its start, longer is `dayGridMonth` at the
   * first of the month holding the range's midpoint. Also returns to page 1.
   */
  setCalendarRange(range: { readonly start: Date; readonly end: Date }): ListState;
  /** Loads the current state again. */
  reload(): void;
  /** Aborts the load in flight and stops notifying. Further commands throw. */
  dispose(): void;
}

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_PAGE_SIZE_OPTIONS: readonly number[] = [10, 25, 50, 100, 200];
const DEFAULT_EVENT_COLOR = '#3B82F6';
/** The calendar page size: all events in the visible range (the legacy page's). */
const CALENDAR_PAGE_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}

// The core compiles without DOM types; every runtime it targets has AbortController.
const AbortControllerCtor = (globalThis as unknown as { AbortController: new () => AbortControllerLike }).AbortController;

/** `YYYY-MM-DD` in the local timezone; `toISOString()` would shift the date through UTC. */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The visible range of a calendar view around a local `YYYY-MM-DD` date, as FullCalendar computes it. */
function calendarRange(view: string, dateStr: string): { start: Date; end: Date } {
  const date = new Date(dateStr + 'T00:00:00'); // local, not UTC

  if (view === 'timeGridDay') {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(24, 0, 0, 0);
    return { start, end };
  }
  if (view === 'timeGridWeek') {
    const start = new Date(date);
    start.setDate(start.getDate() - start.getDay()); // back to Sunday
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { start, end };
  }
  if (view === 'dayGridMonth') {
    // The month widened to whole weeks, Sunday to Saturday.
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    start.setDate(start.getDate() - start.getDay());
    start.setHours(0, 0, 0, 0);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    end.setDate(end.getDate() + (6 - end.getDay()) + 1);
    return { start, end };
  }
  return { start: date, end: date };
}

function stateEqual(a: ListState, b: ListState): boolean {
  return (
    a.page === b.page &&
    a.pageSize === b.pageSize &&
    a.sort.column === b.sort.column &&
    a.sort.direction === b.sort.direction &&
    a.search === b.search &&
    a.calendar?.view === b.calendar?.view &&
    a.calendar?.date === b.calendar?.date &&
    a.filters.length === b.filters.length &&
    a.filters.every((f, i) => f.column === b.filters[i].column && f.operator === b.filters[i].operator && Object.is(f.value, b.filters[i].value))
  );
}

/** What a load would do for the current state. */
type LoadPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'load'; readonly query: DataQuery };

/**
 * Creates a {@link RecordList} for `entity` and schedules its first load.
 *
 * @consumer app
 */
export function recordList(deps: FacadeDeps, entity: EntityHandle, options: RecordListOptions = {}): RecordList {
  const pageSizeOptions = options.pageSizeOptions && options.pageSizeOptions.length > 0 ? options.pageSizeOptions : DEFAULT_PAGE_SIZE_OPTIONS;
  const maxPageSize = Math.max(...pageSizeOptions);
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;

  const normalizePage = (value: unknown): number => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 1 ? n : 1;
  };
  const normalizePageSize = (value: unknown): number => {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) return defaultPageSize;
    return Math.min(n, maxPageSize);
  };
  const normalizeSort = (sort: ListStateInput['sort']): ListSort => {
    if (!sort) return { column: null, direction: null };
    return {
      column: sort.column ? sort.column : null,
      direction: sort.direction === 'asc' || sort.direction === 'desc' ? sort.direction : null,
    };
  };
  const normalizeCalendar = (calendar: ListStateInput['calendar']): ListCalendar | null =>
    calendar && calendar.view && calendar.date ? { view: calendar.view, date: calendar.date } : null;

  /** `current` with the given fields replaced by their normalized values. */
  const merge = (current: ListState, input: ListStateInput): ListState => ({
    page: input.page !== undefined ? normalizePage(input.page) : current.page,
    pageSize: input.pageSize !== undefined ? normalizePageSize(input.pageSize) : current.pageSize,
    sort: input.sort !== undefined ? normalizeSort(input.sort) : current.sort,
    search: input.search !== undefined ? (input.search ?? '') : current.search,
    filters: input.filters !== undefined ? [...input.filters] : current.filters,
    calendar: input.calendar !== undefined ? normalizeCalendar(input.calendar) : current.calendar,
  });

  let state = merge(
    { page: 1, pageSize: defaultPageSize, sort: { column: null, direction: null }, search: '', filters: [], calendar: null },
    options.initial ?? {},
  );

  let properties: readonly SchemaEntityProperty[] | undefined;
  let ready = false;
  let disposed = false;
  let loading = true;
  let rows: readonly EntityData[] = [];
  let totalCount = 0;
  let error: unknown;
  let loadedState: ListState | undefined;
  let scheduled = false;
  /** Bumped by every request, so a load started earlier knows it is stale. */
  let generation = 0;
  let controller: AbortControllerLike | undefined;

  /** The columns, the filter columns and the views, read from the live entity row. */
  const derive = () => {
    const row = entity.liveRow;
    const columns = row && properties ? propsForList(row, properties) : [];
    const filterColumns = properties ? propsForFilter(properties) : [];
    const features = entity.features;
    const calendarConfigured = !!(features?.calendar && features.calendarProperty);
    const mapConfigured = !!(features?.map && features.mapProperty);
    const mapProp = mapConfigured ? columns.find(p => p.column_name === features!.mapProperty) : undefined;
    const views: ListViews = {
      summary: !!(entity.schema?.isView && !entity.can?.insert),
      map: mapConfigured ? (mapProp?.type === EntityPropertyType.GeoPolygon ? 'polygon' : 'point') : null,
      calendar: calendarConfigured && entity.can?.select === true,
    };
    return { row, columns, filterColumns, features, calendarConfigured, views };
  };

  /** The calendar's opening range: the week holding the clock's today, from its Sunday (as `setCalendarRange` records a week). */
  const openingCalendar = (): ListCalendar => {
    const now = deps.clock.now();
    return { view: 'timeGridWeek', date: formatLocalDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay())) };
  };

  /** The state a load reads: with the calendar shown and no range, the calendar's opening range. */
  const loadState = (s: ListState, calendarShown: boolean): ListState =>
    calendarShown && !s.calendar ? { ...s, calendar: openingCalendar() } : s;

  const calendarShown = (): boolean => {
    try {
      return derive().views.calendar;
    } catch {
      return false;
    }
  };

  const plan = (): LoadPlan => {
    try {
      const { row, columns, filterColumns, features, calendarConfigured, views } = derive();
      if (!row || !properties || !features || columns.length === 0) return { kind: 'none' };
      const s = loadState(state, views.calendar);

      const fields = columns.map(propertyToSelectStringForList);
      if (features.calendarColorProperty && !fields.includes(features.calendarColorProperty)) {
        fields.push(features.calendarColorProperty);
      }
      // FK-aware, so a category embeds as {id, display_name, color}.
      const mapColor = features.mapColorProperty;
      if (mapColor && !fields.some(c => c === mapColor || c.startsWith(mapColor + ':'))) {
        const meta = [...columns, ...filterColumns].find(p => p.column_name === mapColor);
        fields.push(meta ? propertyToSelectStringForList(meta) : mapColor);
      }

      const valid = new Set([...columns, ...filterColumns].map(p => p.column_name));
      const filters = s.filters.filter(f => valid.has(f.column));
      let calendarRangeActive = false;
      if (calendarConfigured && s.calendar) {
        const range = calendarRange(s.calendar.view, s.calendar.date);
        filters.push({ column: features.calendarProperty!, operator: 'ov', value: `[${range.start.toISOString()},${range.end.toISOString()})` });
        calendarRangeActive = true;
      }

      const structural = entity.structural!;
      // Any non-empty search counts, as on the legacy page: a blank one sends no search
      // clause (the builder and the compiler trim it) but still drops the sort.
      const searching = s.search.length > 0;
      const hasSearchCapability = !!(structural.fulltextSearchColumn || structural.substringSearchColumn || structural.searchFields.length > 0);
      const searchParams =
        hasSearchCapability && searching
          ? buildHybridSearchParams(s.search, structural.fulltextSearchColumn, structural.substringSearchColumn ? [structural.substringSearchColumn] : [])
          : [];

      const query: DataQuery = {
        key: entity.name,
        fields,
        pagination: calendarRangeActive ? { page: 1, pageSize: CALENDAR_PAGE_SIZE } : { page: s.page, pageSize: s.pageSize },
        isSummaryView: views.summary,
      };
      const entityColumns = properties.filter(p => p.type !== EntityPropertyType.ManyToMany).map(p => p.column_name);
      if (entityColumns.length > 0) query.entityColumns = entityColumns;
      if (filters.length > 0) query.filters = filters;
      if (hasSearchCapability && searching) {
        // wfts does not rank, but the legacy page drops the sort while searching.
        if (searchParams.length > 0) query.rawQueryParams = searchParams;
        else query.searchQuery = s.search;
      } else if (s.sort.column && s.sort.direction) {
        const sorted = columns.find(p => p.column_name === s.sort.column);
        if (sorted) {
          query.orderField = buildOrderField(sorted);
          query.orderDirection = s.sort.direction;
        }
      }
      return { kind: 'load', query };
    } catch (err) {
      return { kind: 'error', error: err };
    }
  };

  const parseTimeSlot = (value: unknown): { start: Date; end: Date } => {
    // ["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")
    const match = String(value).match(/\["?([^",]+)"?,\s*"?([^")]+)"?\)/);
    if (!match) {
      const now = deps.clock.now();
      return { start: now, end: now };
    }
    return { start: new Date(match[1]), end: new Date(match[2]) };
  };

  const buildSnapshot = (): RecordListSnapshot => {
    const { row, columns, filterColumns, features, views } = derive();
    const displayColumns = columns.filter(p => p.show_on_list !== false);
    const displayName = row?.display_name ?? '';
    const name = (r: EntityData) => (r.display_name as string | undefined) || `${displayName} #${r.id}`;

    const labeled = [...displayColumns, ...filterColumns.filter(fp => !displayColumns.some(p => p.column_name === fp.column_name))];
    const groups = new Map<string, FilterCriteria[]>();
    for (const f of state.filters) {
      const group = groups.get(f.column);
      if (group) group.push(f);
      else groups.set(f.column, [f]);
    }
    const chips: ListFilterChip[] = [];
    for (const [column, group] of groups) {
      const p = labeled.find(x => x.column_name === column);
      const label = p?.display_name || column;
      const gte = group.find(f => f.operator === 'gte');
      const lte = group.find(f => f.operator === 'lte');
      if (gte && lte) {
        chips.push({ kind: 'range', column, label, min: gte.value, max: lte.value });
      } else if (gte) {
        chips.push({ kind: 'gte', column, label, value: gte.value });
      } else if (lte) {
        chips.push({ kind: 'lte', column, label, value: lte.value });
      } else {
        for (const f of group) {
          if ((p?.type === EntityPropertyType.ForeignKeyName || p?.type === EntityPropertyType.User) && f.operator === 'in') {
            const ids = String(f.value).match(/\(([^)]+)\)/);
            chips.push({ kind: 'selected', column, label, operator: f.operator, value: f.value, count: ids ? ids[1].split(',').length : 1 });
          } else if (p?.type === EntityPropertyType.Boolean) {
            chips.push({ kind: 'boolean', column, label, operator: f.operator, value: f.value, yes: f.value === 'true' });
          } else {
            chips.push({ kind: 'value', column, label, operator: f.operator, value: f.value });
          }
        }
      }
    }

    const mapProperty = features?.mapProperty ?? null;
    const placed = views.map && mapProperty ? rows.filter(r => !!r[mapProperty]) : [];
    const markers: ListMapFeature[] = views.map === 'point' ? placed.map(r => ({ id: r.id as number, name: name(r), wkt: r[mapProperty!] as string })) : [];
    const colorProperty = features?.mapColorProperty;
    const polygons: ListMapFeature[] =
      views.map === 'polygon'
        ? placed.map(r => ({ id: r.id as number, name: name(r), wkt: r[mapProperty!] as string, color: colorProperty && r[colorProperty] ? r[colorProperty] : undefined }))
        : [];

    const slotProperty = features?.calendar ? features.calendarProperty : null;
    const events: ListCalendarEvent[] = slotProperty
      ? rows
          .filter(r => !!r[slotProperty])
          .map(r => {
            const { start, end } = parseTimeSlot(r[slotProperty]);
            const colorProp = features!.calendarColorProperty;
            return {
              id: r.id as number,
              title: name(r),
              start,
              end,
              color: colorProp && r[colorProp] ? (r[colorProp] as string) : DEFAULT_EVENT_COLOR,
              row: r,
            };
          })
      : [];

    const search = state.search.trim();
    return {
      state,
      loading,
      rows,
      totalCount,
      error,
      loadedState,
      columns,
      displayColumns,
      filterColumns,
      chips,
      searchTerms: search ? search.split(/\s+/) : [],
      filtered: state.filters.length > 0 || search.length > 0,
      views,
      markers,
      polygons,
      events,
    };
  };

  const store = createStore<RecordListSnapshot>(buildSnapshot());
  const publish = () => {
    if (!disposed) store.set(buildSnapshot());
  };

  const run = (): void => {
    scheduled = false;
    if (disposed || !ready) return;
    const p = plan();
    if (p.kind === 'error') {
      error = p.error;
      loading = false;
      publish();
      return;
    }
    if (p.kind !== 'load') return; // the request already settled 'none'
    const id = generation;
    const ac = new AbortControllerCtor();
    controller = ac;
    const forState = state;
    deps.data.getDataPaginated(p.query, { signal: ac.signal }).then(
      result => {
        if (disposed || id !== generation) return;
        rows = result.data;
        totalCount = result.totalCount ?? result.data.length;
        error = undefined;
        loadedState = forState;
        loading = false;
        publish();
      },
      (err: unknown) => {
        if (disposed || id !== generation) return;
        rows = [];
        totalCount = 0;
        error = err;
        loadedState = forState;
        loading = false;
        publish();
      },
    );
  };

  /** Invalidates the load in flight and schedules a load of the current state. The caller publishes. */
  const requestLoad = (): void => {
    generation++;
    controller?.abort();
    controller = undefined;
    rows = [];
    totalCount = 0;
    error = undefined;
    loading = !ready || plan().kind !== 'none';
    if (!scheduled) {
      scheduled = true;
      void Promise.resolve().then(run);
    }
  };

  const assertAlive = (): void => {
    if (disposed) throw new Error('recordList is disposed');
  };

  const change = (next: ListState): ListState => {
    assertAlive();
    if (stateEqual(next, state)) return state;
    // The calendar reporting the opening range the load already used changes the state, not the query.
    const shown = calendarShown();
    const sameLoad = ready && stateEqual(loadState(next, shown), loadState(state, shown));
    state = next;
    if (!sameLoad) requestLoad();
    publish();
    return state;
  };

  // Properties load once; the first load follows. The entity row is read when it is needed.
  void (async () => {
    try {
      const row = entity.liveRow;
      properties = row ? await deps.schema.properties(row) : [];
    } catch (err) {
      if (disposed) return;
      ready = true;
      error = err;
      loading = false;
      publish();
      return;
    }
    if (disposed) return;
    ready = true;
    requestLoad();
    publish();
  })();

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,

    set: input => change(merge(state, input)),
    setPage: page => change({ ...state, page: normalizePage(page) }),
    setPageSize: pageSize => change({ ...state, pageSize: normalizePageSize(pageSize), page: 1 }),
    setSearch: search => change({ ...state, search: search ?? '', page: 1 }),
    toggleSort(column) {
      assertAlive();
      if (properties?.find(p => p.column_name === column)?.sortable === false) return state;
      let sort: ListSort;
      if (state.sort.column !== column) sort = { column, direction: 'asc' };
      else if (state.sort.direction === 'asc') sort = { column, direction: 'desc' };
      else sort = { column: null, direction: null };
      return change({ ...state, sort, page: 1 });
    },
    applyFilterBar(filters) {
      assertAlive();
      const bar = new Set((properties ? propsForFilter(properties) : []).map(p => p.column_name));
      return change({ ...state, filters: [...state.filters.filter(f => !bar.has(f.column)), ...filters], page: 1 });
    },
    removeFilter: column => change({ ...state, filters: state.filters.filter(f => f.column !== column), page: 1 }),
    clearFilters: () => change({ ...state, filters: [], search: '', page: 1 }),
    setCalendarRange(range) {
      assertAlive();
      const days = Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS);
      let calendar: ListCalendar;
      if (days <= 1) {
        calendar = { view: 'timeGridDay', date: formatLocalDate(range.start) };
      } else if (days <= 7) {
        calendar = { view: 'timeGridWeek', date: formatLocalDate(range.start) };
      } else {
        // The featured month holds the midpoint; the range has overflow days at both ends.
        const midpoint = new Date((range.start.getTime() + range.end.getTime()) / 2);
        calendar = { view: 'dayGridMonth', date: formatLocalDate(new Date(midpoint.getFullYear(), midpoint.getMonth(), 1)) };
      }
      return change({ ...state, calendar, page: 1 });
    },
    reload() {
      assertAlive();
      requestLoad();
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller?.abort();
      controller = undefined;
    },
  };
}
