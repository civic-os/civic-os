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

import {
  ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, signal, untracked
} from '@angular/core';
import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { forkJoin, take } from 'rxjs';
import { buildMenu, menuDashboardKey, validateMenuTree } from '@civic-os/core';
import { SidebarMenuComponent } from '../../components/sidebar-menu/sidebar-menu.component';
import { SchemaEntityTable } from '../../interfaces/entity';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AuthService } from '../../services/auth.service';
import { MenuAdminService, type MenuDashboard } from '../../services/menu-admin.service';
import { SchemaService } from '../../services/schema.service';
import { TranslationService } from '../../services/translation.service';
import {
  DraftRow, appendRoot, canIndent, canMoveDown, canMoveUp, canOutdent, describePosition, dropReorder,
  headingKeyFromLabel, indent, moveDown, moveUp, nodesToRows, outdent, removeRow, rowsToNodes,
} from './admin-menu.tree';

/** A validation problem ready to show: the code picks the message, `name` is the row it concerns. */
export interface MenuIssue {
  code: string;
  name: string;
}

/**
 * Admin editor for the sidebar menu (`/admin/menu`): arrange headings, entities and dashboards in a tree of
 * up to three levels, link a heading to a dashboard, rename, set icons, hide or collapse entries, then save
 * the whole tree in one call.
 * Tree operations are pure functions in `admin-menu.tree.ts`; this page holds the draft and the I/O.
 */
@Component({
  selector: 'app-admin-menu',
  imports: [DragDropModule, SidebarMenuComponent, TranslatePipe],
  templateUrl: './admin-menu.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminMenuPage {
  private menuAdmin = inject(MenuAdminService);
  private schema = inject(SchemaService);
  private translation = inject(TranslationService);
  protected auth = inject(AuthService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private injector = inject(Injector);

  /** Admins, and roles granted metadata.menu_nodes:update (the database checks the same rule). */
  protected readonly canManage = computed(() =>
    this.auth.isAdmin() || this.auth.permission('metadata.menu_nodes', 'update')()
  );

  loading = signal(true);
  loadError = signal(false);
  saving = signal(false);
  saveError = signal<string | undefined>(undefined);
  saved = signal(false);
  /** Someone else saved the menu after this draft was loaded: the draft can only be reloaded or kept. */
  conflict = signal(false);
  /** The menu version the draft is based on, sent with the save. */
  private version = signal<string | null>(null);

  /** The draft: flattened rows in display order. */
  rows = signal<DraftRow[]>([]);
  private baseline = signal<DraftRow[]>([]);
  entities = signal<SchemaEntityTable[]>([]);
  /** The dashboards this editor can see (every one, for an admin), with translated titles. */
  dashboards = signal<MenuDashboard[]>([]);

  /** Shared aria-live announcement for keyboard moves and drops. */
  announcement = signal('');
  newHeadingLabel = signal('');

  private entityByTable = computed(() => new Map(this.entities().map(e => [e.table_name, e])));
  private dashboardById = computed(() => new Map(this.dashboards().map(d => [d.id, d])));

  /** Dashboards some row already holds: a dashboard row or a heading's link (one place per dashboard). */
  private usedDashboards = computed(() => new Set(this.rows().flatMap(r => (r.dashboardId != null ? [r.dashboardId] : []))));

  /** Every dashboard the editor can see that no row holds. */
  unplacedDashboards = computed(() => this.dashboards().filter(d => !this.usedDashboards().has(d.id)));

  dirty = computed(() => JSON.stringify(this.rows()) !== JSON.stringify(this.baseline()));

  /** Every non-junction entity without a row, tables and registered views alike. */
  unplaced = computed(() => {
    const placed = new Set(this.rows().filter(r => r.kind === 'entity').map(r => r.targetKey));
    return this.entities().filter(e => !placed.has(e.table_name));
  });

  private draftNodes = computed(() => rowsToNodes(this.rows()));

  // Structure only, no target check: the menu trigger decides eligibility, and the editor cannot see
  // every eligible target (junction tables are not in entities(), and schema_entities hides tables the
  // caller cannot read), so a check here blocked saving trees the database accepts.
  issues = computed<MenuIssue[]>(() =>
    validateMenuTree(this.draftNodes()).map(error => ({
      code: error.code,
      name: this.rowName(error.nodeKey)
    }))
  );

  // The preview shows a dashboard entry or a heading link only when the editor can see the dashboard,
  // as the sidebar does for every caller: the title comes from the editor's dashboards.
  preview = computed(() => buildMenu(this.entities(), this.draftNodes().map(n => ({
    ...n,
    dashboard_display_name: n.dashboard_id != null ? this.dashboardById().get(n.dashboard_id)?.display_name ?? null : null,
  }))));

  private loaded = false;

  constructor() {
    effect(() => {
      if (this.canManage() && !this.loaded) {
        this.loaded = true;
        untracked(() => this.load());
      }
    });
  }

  /** Loads the stored tree. `savedNotice` keeps the "Menu saved." message, for the reload after a save. */
  load(savedNotice = false): void {
    this.loading.set(true);
    this.loadError.set(false);
    forkJoin([
      this.menuAdmin.getNodes(), this.schema.getEntitiesForManagement().pipe(take(1)), this.menuAdmin.getDashboards()
    ]).subscribe({
      next: ([{ nodes, version }, entities, dashboards]) => {
        const rows = nodesToRows(nodes);
        this.version.set(version);
        this.conflict.set(false);
        this.saveError.set(undefined);
        this.entities.set(entities);
        this.dashboards.set(dashboards);
        this.rows.set(rows);
        this.baseline.set(rows);
        this.saved.set(savedNotice);
        this.loading.set(false);
      },
      error: err => {
        console.error('Failed to load the menu editor:', err);
        this.loadError.set(true);
        this.loading.set(false);
      }
    });
  }

  // ── Row display ──────────────────────────────

  /** What the menu shows for a row: its label, else the entity's display name or the dashboard's title, else its key. */
  rowName(key: string): string {
    const row = this.rows().find(r => r.key === key);
    if (!row) return key;
    if (row.label != null && row.label.trim() !== '') return row.label;
    return this.targetName(row) || row.key;
  }

  /** The dashboard's title, for a dashboard id the editor can see. */
  dashboardName(id: number | null): string | undefined {
    return id != null ? this.dashboardById().get(id)?.display_name : undefined;
  }

  /**
   * An entity row the sidebar drops for this user: a junction table, a table the caller cannot read
   * (schema_entities lists only readable tables), or a table or view that no longer exists. The first two
   * save and still show to users who can read them; the last is dropped by the next save. All are flagged
   * rather than blocked.
   */
  notShown(row: DraftRow): boolean {
    if (row.kind === 'entity') return row.targetKey != null && !this.entityByTable().has(row.targetKey);
    return this.dashboardNotShown(row);
  }

  /**
   * A dashboard row, or a heading's link, to a dashboard this editor cannot see (a non-admin menu editor).
   * The sidebar shows it to the people who can see the dashboard; the editor's preview leaves it out.
   */
  dashboardNotShown(row: DraftRow): boolean {
    return row.kind !== 'entity' && row.dashboardId != null && !this.dashboardById().has(row.dashboardId);
  }

  /** The name a row falls back to without a label: its entity's name or its dashboard's title. */
  targetName(row: DraftRow): string {
    if (row.kind === 'entity') return row.targetKey != null ? this.entityByTable().get(row.targetKey)?.display_name ?? row.key : '';
    if (row.kind === 'dashboard') return this.dashboardName(row.dashboardId) ?? row.key;
    return '';
  }

  /** The dashboards a heading may open: those no other row holds, plus its current one. */
  linkOptions(row: DraftRow): MenuDashboard[] {
    return this.dashboards().filter(d => d.id === row.dashboardId || !this.usedDashboards().has(d.id));
  }

  hasChildren(index: number): boolean {
    const rows = this.rows();
    return index + 1 < rows.length && rows[index + 1].depth > rows[index].depth;
  }

  canMoveUp(index: number): boolean { return canMoveUp(this.rows(), index); }
  canMoveDown(index: number): boolean { return canMoveDown(this.rows(), index); }
  canIndent(index: number): boolean { return canIndent(this.rows(), index); }
  canOutdent(index: number): boolean { return canOutdent(this.rows(), index); }

  // ── Editing ──────────────────────────────

  private apply(rows: DraftRow[], key: string | undefined): void {
    this.rows.set(rows);
    this.saved.set(false);
    if (key !== undefined) this.announceMove(key);
  }

  moveUp(index: number): void { this.move(index, moveUp, 'up'); }
  moveDown(index: number): void { this.move(index, moveDown, 'down'); }
  indent(index: number): void { this.move(index, indent, 'indent'); }
  outdent(index: number): void { this.move(index, outdent, 'outdent'); }

  private move(index: number, op: (rows: DraftRow[], index: number) => DraftRow[], action: string): void {
    const key = this.rows()[index].key;
    this.apply(op(this.rows(), index), key);
    this.restoreFocus(() => this.rowAction(key, action) ?? this.rowAction(key));
  }

  /**
   * The keyed @for re-inserts a moved row's element and drops a removed one, which blurs the button a
   * keyboard user just pressed. After the next render, focus goes to `pick()` (if it finds an element).
   */
  private restoreFocus(pick: () => HTMLElement | null | undefined): void {
    afterNextRender({ read: () => pick()?.focus() }, { injector: this.injector });
  }

  /** A row's enabled action button: the named one, or the first enabled one when no name is given. */
  private rowAction(key: string, action?: string): HTMLButtonElement | null {
    const sel = `[data-row-key="${CSS.escape(key)}"] button[data-action${action ? `="${action}"` : ''}]:not(:disabled)`;
    return this.host.nativeElement.querySelector<HTMLButtonElement>(sel);
  }

  onDrop(event: CdkDragDrop<DraftRow[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    const key = this.rows()[event.previousIndex].key;
    this.apply(dropReorder(this.rows(), event.previousIndex, event.currentIndex), key);
  }

  remove(index: number): void {
    const name = this.rowName(this.rows()[index].key);
    this.apply(removeRow(this.rows(), index), undefined);
    this.announcement.set(this.translation.get('a11y.admin_menu.removed', { name }));
    // The row that took its place, else the new last row, else the entity it went back to in the tray
    const rows = this.rows();
    const next = rows[Math.min(index, rows.length - 1)]?.key;
    this.restoreFocus(() => (next !== undefined ? this.rowAction(next, 'remove') : null)
      ?? this.host.nativeElement.querySelector<HTMLElement>('[data-unplaced-key] button'));
  }

  update(key: string, patch: Partial<Pick<DraftRow, 'label' | 'icon' | 'hidden' | 'collapsed' | 'dashboardId'>>): void {
    this.rows.update(rows => rows.map(r => (r.key === key ? { ...r, ...patch } : r)));
    this.saved.set(false);
  }

  addEntity(table: SchemaEntityTable): void {
    const tray = this.unplaced();
    const at = tray.findIndex(e => e.table_name === table.table_name);
    const next = (tray[at + 1] ?? tray[at - 1])?.table_name;
    this.apply(
      appendRoot(this.rows(), {
        key: table.table_name, kind: 'entity', targetKey: table.table_name, dashboardId: null,
        label: null, icon: null, hidden: false, collapsed: false
      }),
      undefined
    );
    this.announcement.set(this.translation.get('a11y.admin_menu.added', { name: table.display_name }));
    // The tray button just pressed is gone: its neighbor in the tray, else the new heading field
    this.restoreFocus(() => (next !== undefined
      ? this.host.nativeElement.querySelector<HTMLElement>(`[data-unplaced-key="${CSS.escape(next)}"] button`)
      : null) ?? this.host.nativeElement.querySelector<HTMLElement>('#menu-new-heading'));
  }

  addDashboard(dashboard: MenuDashboard): void {
    const tray = this.unplacedDashboards();
    const at = tray.findIndex(d => d.id === dashboard.id);
    const next = (tray[at + 1] ?? tray[at - 1])?.id;
    this.apply(
      appendRoot(this.rows(), {
        key: menuDashboardKey(dashboard.id), kind: 'dashboard', targetKey: null, dashboardId: dashboard.id,
        label: null, icon: null, hidden: false, collapsed: false
      }),
      undefined
    );
    this.announcement.set(this.translation.get('a11y.admin_menu.added', { name: dashboard.display_name }));
    // The tray button just pressed is gone: its neighbor in the dashboards tray, else the new heading field
    this.restoreFocus(() => (next !== undefined
      ? this.host.nativeElement.querySelector<HTMLElement>(`[data-unplaced-dashboard="${next}"] button`)
      : null) ?? this.host.nativeElement.querySelector<HTMLElement>('#menu-new-heading'));
  }

  /** Adds a heading at the root, last. Its key is an immutable slug of the label. */
  addHeading(): void {
    const label = this.newHeadingLabel().trim();
    if (label === '') return;
    const taken = new Set(this.rows().map(r => r.key));
    for (const e of this.entities()) taken.add(e.table_name);
    const key = headingKeyFromLabel(label, taken);
    this.apply(
      appendRoot(this.rows(), { key, kind: 'heading', targetKey: null, dashboardId: null, label, icon: null, hidden: false, collapsed: false }),
      undefined
    );
    this.newHeadingLabel.set('');
    this.announcement.set(this.translation.get('a11y.admin_menu.added', { name: label }));
  }

  private announceMove(key: string): void {
    const position = describePosition(this.rows(), key);
    if (!position) return;
    const name = this.rowName(key);
    this.announcement.set(
      position.parentKey === null
        ? this.translation.get('a11y.admin_menu.moved_root', { name, i: position.position, n: position.count })
        : this.translation.get('a11y.admin_menu.moved_into', {
            name, parent: this.rowName(position.parentKey), i: position.position, n: position.count
          })
    );
  }

  // ── Save / discard ──────────────────────────────

  save(): void {
    if (!this.dirty() || this.issues().length > 0 || this.saving() || this.conflict()) return;
    this.saving.set(true);
    this.saveError.set(undefined);
    this.saved.set(false);
    const rows = this.rows();
    this.menuAdmin.saveTree(rowsToNodes(rows), this.version()).subscribe(result => {
      this.saving.set(false);
      if (result.success) {
        if (result.version !== undefined) this.version.set(result.version);
        this.baseline.set(rows);
        this.saved.set(true);
        this.schema.refreshMenuCache();
        // The save dropped nodes whose table no longer exists (and lifted their children): reload, so
        // the draft shows what was stored rather than what was sent.
        if (result.skipped?.length) this.load(true);
      } else if (result.conflict) {
        this.conflict.set(true);
        this.restoreFocus(() => this.host.nativeElement.querySelector<HTMLElement>('[data-testid="menu-conflict"]'));
      } else {
        this.saveError.set(result.error ?? 'Failed to save the menu');
      }
    });
  }

  /** After a conflict: load the stored tree, dropping the draft. */
  reload(): void {
    this.announcement.set('');
    this.load();
  }

  discard(): void {
    this.rows.set(this.baseline());
    this.saveError.set(undefined);
    this.saved.set(false);
    this.announcement.set('');
  }

  onLabelInput(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.update(key, { label: value === '' ? null : value });
  }

  onIconInput(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    this.update(key, { icon: value === '' ? null : value });
  }

  onHeadingInput(event: Event): void {
    this.newHeadingLabel.set((event.target as HTMLInputElement).value);
  }

  /** The heading's "Opens dashboard" select: a dashboard id, or empty for none. */
  onLinkChange(key: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.update(key, { dashboardId: value === '' ? null : Number(value) });
  }

  onCheck(key: string, field: 'collapsed', event: Event): void {
    this.update(key, { [field]: (event.target as HTMLInputElement).checked });
  }

  /** The eye button: hides or shows a row. Focus stays on the button, whose label flips. */
  toggleHidden(key: string): void {
    const row = this.rows().find(r => r.key === key);
    if (row) this.update(key, { hidden: !row.hidden });
  }
}
