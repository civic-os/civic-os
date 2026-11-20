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
import type { MenuEntry, MenuTarget } from '@civic-os/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { SIDEBAR_SECTION_KEYS, SidebarOpenStateService } from './sidebar-open-state.service';

export { MENU_OPEN_STORAGE_KEY } from './sidebar-open-state.service';

/** `/view/:table`, `/view/:table/...`, `/create/:table`, `/edit/:table/...`: the table an entity route belongs to. */
const ENTITY_ROUTE = /^\/(?:view|create|edit)\/([^/?#]+)/;
/** `/dashboard/:id`: the dashboard a dashboard route shows. */
const DASHBOARD_ROUTE = /^\/dashboard\/(\d+)(?:[/?#]|$)/;

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

/** Whether the entry's link opens `target` (an entity's table, or a dashboard of a dashboard entry or linked heading). */
function opens(entry: MenuEntry, target: MenuTarget): boolean {
  return typeof target === 'string'
    ? entry.kind === 'entity' && entry.tableName === target
    : entry.dashboardId === target.dashboardId;
}

function containsTarget(entries: readonly MenuEntry[], target: MenuTarget): boolean {
  return entries.some(e => opens(e, target) || containsTarget(e.children, target));
}

/** The route an entry's link opens: an entity's list, or a dashboard (a dashboard entry or a linked heading). */
export function menuEntryLink(entry: MenuEntry): (string | number)[] | undefined {
  if (entry.kind === 'entity' && entry.tableName !== undefined) return ['/view', entry.tableName];
  if (entry.dashboardId !== undefined) return ['/dashboard', entry.dashboardId];
  return undefined;
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
 * - An entity or dashboard entry is a link; when it has children, a separate DaisyUI `.menu-dropdown-toggle`
 *   button (`aria-expanded`, `aria-controls`) toggles a nested list.
 * - A heading that opens a dashboard cannot put its link in a `<summary>`, so its title is a link and the
 *   toggle is that same separate button: at the root it keeps the section title style, nested it looks like
 *   a parent entity entry. With no entries below, it is the link alone.
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

  /** What the current route shows: an entity's table, or a dashboard. */
  protected readonly activeTarget = computed<MenuTarget | undefined>(() => {
    const url = this.currentUrl();
    const dashboard = DASHBOARD_ROUTE.exec(url);
    if (dashboard) return { dashboardId: Number(dashboard[1]) };
    const match = ENTITY_ROUTE.exec(url);
    if (!match) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  });

  /**
   * Keys always rendered open: the ancestors of the active entry, and the active entry itself when it is a
   * heading (a linked heading's section holds the pages that belong to its dashboard).
   */
  protected readonly activeBranch = computed<ReadonlySet<string>>(() => {
    const target = this.activeTarget();
    if (target === undefined) return new Set<string>();
    const keys = new Set(menuBranchKeys(this.entries(), target));
    const self = findEntry(this.entries(), target);
    if (self?.kind === 'heading') keys.add(self.key);
    return keys;
  });

  protected isOpen(entry: MenuEntry): boolean {
    return this.openState.isOpen(entry.key, !entry.collapsedByDefault, this.activeBranch().has(entry.key));
  }

  /** A Data section is forced open when it holds the active route. */
  protected isSectionForced(entries: readonly MenuEntry[]): boolean {
    const target = this.activeTarget();
    return target !== undefined && containsTarget(entries, target);
  }

  protected isActive(entry: MenuEntry): boolean {
    const target = this.activeTarget();
    return target !== undefined && opens(entry, target);
  }

  protected link(entry: MenuEntry): (string | number)[] | undefined {
    return menuEntryLink(entry);
  }

  /** A heading whose title opens a dashboard: rendered as a link plus a toggle, never as a `<summary>`. */
  protected isLinkedHeading(entry: MenuEntry): boolean {
    return entry.kind === 'heading' && entry.dashboardId !== undefined;
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

function findEntry(entries: readonly MenuEntry[], target: MenuTarget): MenuEntry | undefined {
  for (const entry of entries) {
    if (opens(entry, target)) return entry;
    const found = findEntry(entry.children, target);
    if (found) return found;
  }
  return undefined;
}
