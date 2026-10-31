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
