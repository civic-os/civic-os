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

import { Injectable, signal } from '@angular/core';

/** localStorage key holding the open state of sidebar sections, headings and parents: a JSON map of key to boolean. */
export const MENU_OPEN_STORAGE_KEY = 'civic-os.menu.open';

/**
 * Keys of the sidebar's fixed sections. The `@` keeps them apart from menu node keys
 * (heading keys match `^[a-z][a-z0-9_]*$`, entity keys are table names).
 */
export const SIDEBAR_SECTION_KEYS = { about: '@about', admin: '@admin', data: '@data' } as const;

/**
 * Open and closed state of every collapsible part of the sidebar: the fixed sections
 * (About, Admin, Data), menu headings and parent entity entries. One shared map, so
 * the sidebar and the menu editor's preview agree, remembered per key in localStorage.
 * A forced key (the part holding the current page) always reads open and refuses to close.
 */
@Injectable({ providedIn: 'root' })
export class SidebarOpenStateService {
  private readonly stored = signal<Record<string, boolean>>(readStoredOpenState());

  /** The stored choice, else the default; `forced` always reads open. */
  isOpen(key: string, defaultOpen: boolean, forced = false): boolean {
    return forced || (this.stored()[key] ?? defaultOpen);
  }

  /** Flips a key (a toggle button). A forced key stays open. */
  toggle(key: string, defaultOpen: boolean, forced = false): void {
    if (forced) return;
    this.setOpen(key, !this.isOpen(key, defaultOpen));
  }

  /** Follows a native `<details>` toggle (click or keyboard) into the stored state; a forced key reopens. */
  onDetailsToggle(key: string, event: Event, defaultOpen: boolean, forced = false): void {
    const details = event.target as HTMLDetailsElement;
    if (details.open === this.isOpen(key, defaultOpen, forced)) return;
    if (forced) {
      details.open = true;
      return;
    }
    this.setOpen(key, details.open);
  }

  private setOpen(key: string, open: boolean): void {
    const next = { ...this.stored(), [key]: open };
    this.stored.set(next);
    try {
      localStorage.setItem(MENU_OPEN_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable (private window, blocked): the state lasts for this session only.
    }
  }
}

function readStoredOpenState(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MENU_OPEN_STORAGE_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}
