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

import type { EntityHandle } from '../handles/handles.js';
import type { EntityData, FilterCriteria, SchemaEntityProperty } from '../model/index.js';
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
 * No load is sent while the entity is unknown or has no list columns, nor,
 * when `views.calendar` is true, before the state has a range: the list stays
 * loading until {@link RecordList.setCalendarRange} or `set({ calendar })`,
 * so a calendar list never sends an unranged request.
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
   * first of the month holding the range's midpoint. Also returns to page 1,
   * and marks the list loading at once, even when the state stays equal.
   */
  setCalendarRange(range: { readonly start: Date; readonly end: Date }): ListState;
  /** Loads the current state again. */
  reload(): void;
  /** Aborts the load in flight and stops notifying. Further commands throw. */
  dispose(): void;
}

/**
 * Creates a {@link RecordList} for `entity` and schedules its first load.
 *
 * @consumer app
 */
export function recordList(deps: FacadeDeps, entity: EntityHandle, options: RecordListOptions = {}): RecordList {
  void deps;
  void entity;
  void options;
  throw new Error('recordList is not implemented yet');
}
