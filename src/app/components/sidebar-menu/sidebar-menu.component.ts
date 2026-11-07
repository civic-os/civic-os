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

import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { menuBranchKeys } from '@civic-os/core';
import type { MenuEntry } from '@civic-os/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { SIDEBAR_SECTION_KEYS, SidebarOpenStateService } from './sidebar-open-state.service';

export { MENU_OPEN_STORAGE_KEY } from './sidebar-open-state.service';

/** `/view/:table`, `/view/:table/...`, `/create/:table`, `/edit/:table/...`: the table an entity route belongs to. */
const ENTITY_ROUTE = /^\/(?:view|create|edit)\/([^/?#]+)/;

/**
 * One block of the menu's root level. A root heading is a titled section; a run of root
 * entities is untitled before the first heading, and titled "Data" after a heading (or
 * when the menu has no heading), so it never reads as part of the heading above it.
 */
export type SidebarSection =
  | { kind: 'heading'; key: string; entry: MenuEntry }
  | { kind: 'entities'; key: string; entries: MenuEntry[]; titled: boolean };

/** Splits the root entries into sections (see {@link SidebarSection}). */
export function sidebarSections(entries: readonly MenuEntry[]): SidebarSection[] {
  const hasHeading = entries.some(e => e.kind === 'heading');
  const sections: SidebarSection[] = [];
  let run: MenuEntry[] = [];
  let afterHeading = !hasHeading;
  const flush = (): void => {
    if (run.length === 0) return;
    sections.push({ kind: 'entities', key: '', entries: run, titled: afterHeading });
    run = [];
  };
  for (const entry of entries) {
    if (entry.kind === 'heading') {
      flush();
      sections.push({ kind: 'heading', key: entry.key, entry });
      afterHeading = true;
    } else {
      run.push(entry);
    }
  }
  flush();
  // The trailing titled run (the usual one: unplaced entities) owns the plain Data key; an earlier one is keyed by its first entry
  const titled = sections.filter((s): s is Extract<SidebarSection, { kind: 'entities' }> => s.kind === 'entities' && s.titled);
  for (const s of titled) s.key = `${SIDEBAR_SECTION_KEYS.data}.${s.entries[0].key}`;
  if (titled.length > 0) titled[titled.length - 1].key = SIDEBAR_SECTION_KEYS.data;
  for (const s of sections) if (s.kind === 'entities' && !s.titled) s.key = `@untitled.${s.entries[0].key}`;
  return sections;
}

/** Instance counter: the drawer and the editor preview render the same keys on one page, so ids need a per-instance prefix. */
let nextInstanceId = 0;

function containsTable(entries: readonly MenuEntry[], table: string): boolean {
  return entries.some(e => (e.kind === 'entity' && e.tableName === table) || containsTable(e.children, table));
}

/**
 * The sidebar menu tree (entries from `SchemaService.getMenu()`). The host is the list itself
 * (`<ul appSidebarMenu class="menu">`), so every `<li>` is a direct child of a `<ul>`: a host element
 * between the two breaks list semantics (axe `list`), whatever its role or display. Items the page puts
 * around the tree are projected: `[menuStart]` children go before it, all others after it.
 *
 * - A root heading is a section titled like About and Admin, collapsible, its entries at the root indent.
 * - Root entities after a heading (or all of them, when there is no heading) sit under a "Data" section.
 * - A nested heading is a native `<details><summary>` item.
 * - An entity entry is a link; when it has children, a separate DaisyUI `.menu-dropdown-toggle` button
 *   (`aria-expanded`, `aria-controls`) toggles a nested list.
 * - Open state defaults from `collapsedByDefault` (Data defaults open), is remembered per key through
 *   {@link SidebarOpenStateService}, and is always open for the part that holds the active route.
 */
@Component({
  // The host must be the <ul> itself (see above), which an element selector cannot express.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'ul[appSidebarMenu]',
  imports: [NgTemplateOutlet, RouterLink, TranslatePipe],
  templateUrl: './sidebar-menu.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidebarMenuComponent {
  /** The built, visible menu tree. */
  readonly entries = input.required<readonly MenuEntry[]>();
  /** The current router URL; decides the active link and the forced-open branch. */
  readonly currentUrl = input<string>('');
  /** Emitted when a link is followed, so the host can close the drawer. */
  readonly navigated = output<void>();

  protected readonly openState = inject(SidebarOpenStateService);
  private readonly idPrefix = `menu-${++nextInstanceId}`;

  protected readonly sections = computed(() => sidebarSections(this.entries()));

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
    return this.openState.isOpen(entry.key, !entry.collapsedByDefault, this.activeBranch().has(entry.key));
  }

  /** A Data section is forced open when it holds the active route. */
  protected isSectionForced(entries: readonly MenuEntry[]): boolean {
    const table = this.activeTable();
    return table !== undefined && containsTable(entries, table);
  }

  protected isActive(entry: MenuEntry): boolean {
    return entry.tableName !== undefined && entry.tableName === this.activeTable();
  }

  protected childrenId(entry: MenuEntry): string {
    return `${this.idPrefix}-children-${entry.key}`;
  }

  protected toggle(entry: MenuEntry): void {
    this.openState.toggle(entry.key, !entry.collapsedByDefault, this.activeBranch().has(entry.key));
  }

  protected onDetailsToggle(entry: MenuEntry, event: Event): void {
    this.openState.onDetailsToggle(entry.key, event, !entry.collapsedByDefault, this.activeBranch().has(entry.key));
  }
}
