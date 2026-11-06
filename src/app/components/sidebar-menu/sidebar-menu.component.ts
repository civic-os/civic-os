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

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { menuBranchKeys } from '@civic-os/core';
import type { MenuEntry } from '@civic-os/core';
import { TranslatePipe } from '../../pipes/translate.pipe';

/** localStorage key holding the open state of menu headings and parents: a JSON map of node key to boolean. */
export const MENU_OPEN_STORAGE_KEY = 'civic-os.menu.open';

/** `/view/:table`, `/view/:table/...`, `/create/:table`, `/edit/:table/...`: the table an entity route belongs to. */
const ENTITY_ROUTE = /^\/(?:view|create|edit)\/([^/?#]+)/;

/**
 * The sidebar menu tree (entries from `SchemaService.getMenu()`). Renders as `<li>` items, so the host
 * sits inside the sidebar's `<ul class="menu">` and does not generate a box of its own.
 *
 * - A heading is a native `<details><summary>`.
 * - An entity entry is a link; when it has children, a separate chevron button (`aria-expanded`,
 *   `aria-controls`) toggles a nested list.
 * - Open state defaults from `collapsedByDefault`, is remembered per key in localStorage, and is always
 *   open for the branch that holds the active route (the stored state is left alone).
 */
@Component({
  selector: 'app-sidebar-menu',
  imports: [NgTemplateOutlet, RouterLink, TranslatePipe],
  templateUrl: './sidebar-menu.component.html',
  host: { class: 'contents', role: 'none' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidebarMenuComponent {
  /** The built, visible menu tree. */
  readonly entries = input.required<readonly MenuEntry[]>();
  /** The current router URL; decides the active link and the forced-open branch. */
  readonly currentUrl = input<string>('');
  /** Emitted when a link is followed, so the host can close the drawer. */
  readonly navigated = output<void>();

  private readonly stored = signal<Record<string, boolean>>(readStoredOpenState());

  /** The table the current route belongs to, if it is an entity route. */
  protected readonly activeTable = computed<string | undefined>(() => {
    const match = ENTITY_ROUTE.exec(this.currentUrl());
    if (!match) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  });

  /** Keys of the ancestors of the active entry; always rendered open. */
  protected readonly activeBranch = computed<ReadonlySet<string>>(() => {
    const table = this.activeTable();
    return new Set(table ? menuBranchKeys(this.entries(), table) : []);
  });

  protected isOpen(entry: MenuEntry): boolean {
    return this.activeBranch().has(entry.key) || (this.stored()[entry.key] ?? !entry.collapsedByDefault);
  }

  protected isActive(entry: MenuEntry): boolean {
    return entry.tableName !== undefined && entry.tableName === this.activeTable();
  }

  protected childrenId(entry: MenuEntry): string {
    return `menu-children-${entry.key}`;
  }

  /** The chevron points down when open, and toward the text direction's end when closed. */
  protected chevronClass(entry: MenuEntry): string {
    return this.isOpen(entry) ? '' : '-rotate-90 rtl:rotate-90';
  }

  protected toggle(entry: MenuEntry): void {
    if (this.activeBranch().has(entry.key)) return;
    this.setOpen(entry.key, !this.isOpen(entry));
  }

  /** Follows the native `<details>` state (user click or keyboard) into the stored state. */
  protected onDetailsToggle(entry: MenuEntry, event: Event): void {
    const details = event.target as HTMLDetailsElement;
    if (details.open === this.isOpen(entry)) return;
    if (this.activeBranch().has(entry.key)) {
      details.open = true;
      return;
    }
    this.setOpen(entry.key, details.open);
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
