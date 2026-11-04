/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import type { Params } from '@angular/router';
import type { FilterCriteria, ListStateInput } from '@civic-os/core';
import { clampPageSize } from '../utils/query-limits';

/** The page size when nothing is in the URL or in storage. */
export const DEFAULT_LIST_PAGE_SIZE = 25;
/** Where the user's page size preference is kept. */
export const LIST_PAGE_SIZE_STORAGE_KEY = 'civic_os_list_page_size';

/** The filters in the URL: `f{n}_col`, `f{n}_op`, `f{n}_val` for n = 0, 1, ... until a column is missing. */
export function filtersFromParams(params: Params): FilterCriteria[] {
  const filters: FilterCriteria[] = [];
  let index = 0;
  while (params[`f${index}_col`]) {
    filters.push({
      column: params[`f${index}_col`],
      operator: params[`f${index}_op`],
      value: params[`f${index}_val`],
    });
    index++;
  }
  return filters;
}

/** The stored page size preference, made safe, or the default (also when storage is blocked and the read throws). */
export function storedListPageSize(): number {
  let stored: string | null;
  try {
    stored = localStorage.getItem(LIST_PAGE_SIZE_STORAGE_KEY);
  } catch {
    return DEFAULT_LIST_PAGE_SIZE;
  }
  if (stored) {
    return clampPageSize(parseInt(stored, 10), DEFAULT_LIST_PAGE_SIZE);
  }
  return DEFAULT_LIST_PAGE_SIZE;
}

/**
 * The list state a URL stands for, as raw values for the facade to normalize. Every field is given, because the
 * facade keeps a field that is left out: a URL without `page` means page 1, not "keep the page". The stored page
 * size applies only when the URL has no `pageSize`; an invalid URL value falls back to the default instead.
 * The calendar counts only when both `cal_view` and `cal_date` are present.
 */
export function listStateFromParams(params: Params, storedPageSize: () => number = storedListPageSize): ListStateInput {
  return {
    page: params['page'] ?? 1,
    pageSize: params['pageSize'] ? params['pageSize'] : storedPageSize(),
    sort: { column: params['sort'] || null, direction: params['dir'] || null },
    search: params['q'] || '',
    filters: filtersFromParams(params),
    calendar: params['cal_view'] && params['cal_date'] ? { view: params['cal_view'], date: params['cal_date'] } : null,
  };
}

/** What a list link needs from a widget: the filters as resolved (ids, never status or category keys) and its order. */
export interface ListLinkInput {
  filters: readonly FilterCriteria[];
  orderBy?: string;
  orderDirection?: string;
}

const LIST_VALUE_ITEM = /^[A-Za-z0-9_.\- ]+$/;

/** Core sends no clause for these values (`compile.ts`), so the URL may leave such a filter out and stay faithful. */
const NO_FILTER = 'none' as const;

/**
 * A single filter as the list page reads it back; {@link NO_FILTER} when core would send no clause for it;
 * or null when the URL cannot carry it faithfully.
 */
function filterToParamValues(filter: FilterCriteria): { operator: string; value: string } | typeof NO_FILTER | null {
  const { operator, value } = filter;
  if (value === undefined || value === '') return NO_FILTER;
  if (value === null) {
    // The URL has no null; `is.null` is what core compiles it to anyway.
    if (operator === 'eq' || operator === 'is') return { operator: 'is', value: 'null' };
    if (operator === 'neq' || operator === 'not.is') return { operator: 'not.is', value: 'null' };
    return null;
  }
  if (operator === 'in' || operator === 'not.in') {
    // The shape the filter bar writes: filtersFromParams() hands the string back and core compiles it as
    // `in.(a,b)`. An array would need repeated params, which read back as a plain string when there is one
    // item. An item with a reserved character (comma, quote, parenthesis) cannot be written this way.
    if (!Array.isArray(value)) return typeof value === 'string' ? { operator, value } : null;
    const items = value.filter(item => item !== null && item !== undefined && item !== '').map(String);
    if (items.length === 0 || !items.every(item => LIST_VALUE_ITEM.test(item))) return null;
    return { operator, value: `(${items.join(',')})` };
  }
  if (typeof value === 'object') return null;
  return { operator, value: String(value) };
}

/**
 * The List page query params for a widget's rows: `f{n}_col/op/val` per filter (the inverse of
 * {@link filtersFromParams}) and `sort` / `dir`; or null when a filter cannot be carried, since a list
 * without it would show rows the widget excludes. Filters with no value (core sends no clause for them)
 * are skipped and the rest renumbered, so the indexes stay contiguous for filtersFromParams().
 */
export function listQueryParams(input: ListLinkInput): Params | null {
  const params: Params = {};
  let index = 0;
  for (const filter of input.filters) {
    const encoded = filterToParamValues(filter);
    if (encoded === null) return null;
    if (encoded === NO_FILTER) continue;
    params[`f${index}_col`] = filter.column;
    params[`f${index}_op`] = encoded.operator;
    params[`f${index}_val`] = encoded.value;
    index++;
  }
  if (input.orderBy) {
    params['sort'] = input.orderBy;
    params['dir'] = input.orderDirection === 'asc' ? 'asc' : 'desc';
  }
  return params;
}
