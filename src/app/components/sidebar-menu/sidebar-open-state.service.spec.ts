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

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { MENU_OPEN_STORAGE_KEY, SIDEBAR_SECTION_KEYS, SidebarOpenStateService } from './sidebar-open-state.service';

describe('SidebarOpenStateService', () => {
  const create = () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    return TestBed.inject(SidebarOpenStateService);
  };
  const details = (open: boolean) => {
    const el = document.createElement('details');
    el.open = open;
    return el;
  };
  const toggleEvent = (el: HTMLDetailsElement) => ({ target: el }) as unknown as Event;

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps section keys apart from menu node keys', () => {
    for (const key of Object.values(SIDEBAR_SECTION_KEYS)) expect(key).not.toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('reads the default until a choice is stored, then the stored choice', () => {
    const service = create();
    expect(service.isOpen(SIDEBAR_SECTION_KEYS.admin, true)).toBe(true);
    service.toggle(SIDEBAR_SECTION_KEYS.admin, true);
    expect(service.isOpen(SIDEBAR_SECTION_KEYS.admin, true)).toBe(false);
    expect(JSON.parse(localStorage.getItem(MENU_OPEN_STORAGE_KEY)!)).toEqual({ '@admin': false });
  });

  it('restores stored choices on creation and ignores non-boolean values', () => {
    localStorage.setItem(MENU_OPEN_STORAGE_KEY, JSON.stringify({ '@about': false, reports: 'yes' }));
    const service = create();
    expect(service.isOpen('@about', true)).toBe(false);
    expect(service.isOpen('reports', false)).toBe(false);
  });

  it('reads a forced key open and never closes it', () => {
    localStorage.setItem(MENU_OPEN_STORAGE_KEY, JSON.stringify({ '@admin': false }));
    const service = create();
    expect(service.isOpen('@admin', true, true)).toBe(true);
    service.toggle('@admin', true, true);
    const el = details(false);
    service.onDetailsToggle('@admin', toggleEvent(el), true, true);
    expect(el.open).toBe(true);
    expect(JSON.parse(localStorage.getItem(MENU_OPEN_STORAGE_KEY)!)).toEqual({ '@admin': false });
  });

  it('stores a native details toggle and ignores one that matches the state', () => {
    const service = create();
    service.onDetailsToggle('@data', toggleEvent(details(true)), true);
    expect(localStorage.getItem(MENU_OPEN_STORAGE_KEY)).toBeNull();
    service.onDetailsToggle('@data', toggleEvent(details(false)), true);
    expect(service.isOpen('@data', true)).toBe(false);
  });

  it('keeps working when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const service = create();
    expect(() => service.toggle('@about', true)).not.toThrow();
    expect(service.isOpen('@about', true)).toBe(false);
  });
});
