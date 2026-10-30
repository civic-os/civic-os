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

import { filtersFromParams, listStateFromParams, storedListPageSize, LIST_PAGE_SIZE_STORAGE_KEY } from './list-url';

describe('listStateFromParams', () => {
  const stored = () => 50;

  it('gives every field, so a URL without them resets the list', () => {
    expect(listStateFromParams({}, stored)).toEqual({
      page: 1,
      pageSize: 50,
      sort: { column: null, direction: null },
      search: '',
      filters: [],
      calendar: null,
    });
  });

  it('reads search, sort, page and page size', () => {
    const input = listStateFromParams({ q: 'pothole', sort: 'name', dir: 'desc', page: '3', pageSize: '10' }, stored);
    expect(input).toMatchObject({ search: 'pothole', sort: { column: 'name', direction: 'desc' }, page: '3', pageSize: '10' });
  });

  it('passes an invalid page size through for the facade to default, not the stored preference', () => {
    expect(listStateFromParams({ pageSize: 'abc' }, stored).pageSize).toBe('abc');
  });

  it('reads the indexed filters until a column is missing', () => {
    const params = { f0_col: 'priority', f0_op: 'eq', f0_val: 'high', f1_col: 'status_id', f1_op: 'in', f1_val: '(1,2)', f3_col: 'skipped' };
    expect(filtersFromParams(params)).toEqual([
      { column: 'priority', operator: 'eq', value: 'high' },
      { column: 'status_id', operator: 'in', value: '(1,2)' },
    ]);
    expect(listStateFromParams(params, stored).filters).toHaveLength(2);
  });

  it('counts the calendar only when both the view and the date are present', () => {
    expect(listStateFromParams({ cal_view: 'timeGridWeek', cal_date: '2026-10-18' }, stored).calendar)
      .toEqual({ view: 'timeGridWeek', date: '2026-10-18' });
    expect(listStateFromParams({ cal_view: 'timeGridWeek' }, stored).calendar).toBeNull();
    expect(listStateFromParams({ cal_date: '2026-10-18' }, stored).calendar).toBeNull();
  });

  it('does not read storage when the URL has a page size', () => {
    const spy = vi.fn(() => 50);
    listStateFromParams({ pageSize: '25' }, spy);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('storedListPageSize', () => {
  afterEach(() => localStorage.removeItem(LIST_PAGE_SIZE_STORAGE_KEY));

  it('defaults to 25 with nothing stored', () => {
    expect(storedListPageSize()).toBe(25);
  });

  it('reads the stored preference', () => {
    localStorage.setItem(LIST_PAGE_SIZE_STORAGE_KEY, '100');
    expect(storedListPageSize()).toBe(100);
  });

  it('makes a stored value safe', () => {
    localStorage.setItem(LIST_PAGE_SIZE_STORAGE_KEY, '5000');
    expect(storedListPageSize()).toBe(200);
    localStorage.setItem(LIST_PAGE_SIZE_STORAGE_KEY, 'abc');
    expect(storedListPageSize()).toBe(25);
  });
});
