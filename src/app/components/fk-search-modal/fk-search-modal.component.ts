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
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  output,
  signal,
  computed,
  effect,
  DestroyRef,
  OnDestroy,
  Type,
  ElementRef
} from '@angular/core';
import { CommonModule, NgComponentOutlet } from '@angular/common';
import { FormsModule, FormGroup, FormControl, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, Subscription, merge, switchMap, of, combineLatest, debounceTime, catchError } from 'rxjs';

import { CosModalComponent } from '../cos-modal/cos-modal.component';
import { TranslationService } from '../../services/translation.service';
import { buildHybridSearchParams } from '../../utils/search.utils';
import { PaginationComponent } from '../pagination/pagination.component';
import { FilterBarComponent } from '../filter-bar/filter-bar.component';
import { DisplayPropertyComponent } from '../display-property/display-property.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { DataService } from '../../services/data.service';
import { SchemaService } from '../../services/schema.service';
import { SchemaEntityProperty, EntityData, EntityPropertyType } from '../../interfaces/entity';
import { FilterCriteria } from '../../interfaces/query';
import { SYSTEM_TYPE_MODAL_CONFIGS } from '../../constants/system-types';

/** Shape of persisted FK search modal preferences in localStorage. */
interface FkModalStoredState {
  pageSize: number;
  orderField: string;
  orderDirection: 'asc' | 'desc';
  filters: FilterCriteria[];
}

/**
 * Extended diff output for rich junction M:M (v0.51.0).
 * Includes extra column data for added and updated junction rows.
 */
export interface RichM2mDiff {
  toAdd: { id: number | string; extraData: Record<string, unknown> }[];
  toRemove: (number | string)[];
  toUpdate: { id: number | string; extraData: Record<string, unknown> }[];
  addedItems?: { id: number | string; display_name: string; color?: string }[];
}

@Component({
  selector: 'app-fk-search-modal',
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    NgComponentOutlet,
    CosModalComponent,
    PaginationComponent,
    FilterBarComponent,
    DisplayPropertyComponent,
    TranslatePipe
  ],
  templateUrl: './fk-search-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FkSearchModalComponent implements OnDestroy {
  private data = inject(DataService);
  private translationSvc = inject(TranslationService);
  private hostEl = inject(ElementRef<HTMLElement>);
  private schema = inject(SchemaService);
  private destroyRef = inject(DestroyRef);
  private destroyed = false;

  // Inputs — single-select (FK)
  isOpen = input.required<boolean>();
  joinTable = input.required<string>();
  joinColumn = input<string>('id');
  currentValue = input<number | string | null>(null);
  isNullable = input(false);
  title = input('Select');
  rpcOptions = input<{id: number | string, text: string}[] | null>(null);

  // Inputs — multi-select (M:M, v0.46.0)
  multiSelect = input(false);
  currentValueIds = input<(number | string)[]>([]);
  currentValueItems = input<{id: number | string, display_name: string, color?: string}[]>([]);

  // Input — server-side computed column filter (v0.53.0)
  // When provided, adds this filter to all queries instead of using rpcIdFilter
  serverFilter = input<FilterCriteria | null>(null);

  // Inputs — rich junction (v0.51.0)
  extraColumns = input<SchemaEntityProperty[]>([]);
  currentJunctionData = input<Map<number | string, Record<string, unknown>>>(new Map());

  // Input — localStorage persistence key (v0.56.0)
  // Format: 'fk_modal:{sourceEntity}.{columnName}' — empty string disables persistence
  storageKey = input<string>('');

  // Outputs — single-select (FK)
  confirmed = output<{id: number | string, displayName: string} | null>();
  closed = output<void>();

  // Output — multi-select (M:M) — pure junctions
  applied = output<{ toAdd: (number | string)[], toRemove: (number | string)[], addedItems?: {id: number | string, display_name: string, color?: string}[] }>();

  // Output — rich junction M:M (v0.51.0)
  richApplied = output<RichM2mDiff>();

  // State — shared
  loading = signal(false);
  listProperties = signal<SchemaEntityProperty[]>([]);

  /** Polite announcement for sort changes (aria-sort changes alone are not reliably spoken). */
  sortAnnouncement = signal('');
  filterProperties = signal<SchemaEntityProperty[]>([]);
  rows = signal<EntityData[]>([]);
  totalCount = signal(0);
  searchQuery = signal('');
  currentPage = signal(1);
  pageSize = signal(10);
  orderField = signal('id');
  orderDirection = signal<'asc' | 'desc'>('asc');
  filters = signal<FilterCriteria[]>([]);
  hasSearchFields = signal(false);
  private ilikeSearchColumns = signal<string[]>([]);

  /** tsvector column for wfts search, combined with ilikeSearchColumns via or=() */
  private fulltextSearchColumn = signal<string | null>(null);

  // State — single-select
  pendingSelection = signal<{id: number | string, displayName: string} | null>(null);

  // State — multi-select (v0.46.0)
  workingSelection = signal<Set<number | string>>(new Set());
  chipCache = signal<Map<number | string, {display_name: string, color?: string}>>(new Map());

  // Computed — single-select: whether the Confirm button should be enabled
  confirmEnabled = computed(() => {
    const pending = this.pendingSelection();
    const current = this.currentValue();
    if (pending === null) return current !== null && current !== undefined;
    return String(pending.id) !== String(current);
  });

  // Computed — multi-select: chips for the right panel (sorted alphabetically)
  selectedChips = computed(() => {
    const selection = this.workingSelection();
    const cache = this.chipCache();
    return [...selection]
      .map(id => ({ id, ...(cache.get(id) || { display_name: `#${id}` }) }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  });

  // Computed — multi-select: diff from original for Apply button
  pendingDiff = computed(() => {
    const original = new Set(this.currentValueIds());
    const working = this.workingSelection();
    return {
      toAdd: [...working].filter(id => !original.has(id)),
      toRemove: [...original].filter(id => !working.has(id))
    };
  });

  // Computed — multi-select: Apply enabled only when diff is non-empty
  applyEnabled = computed(() => {
    const diff = this.pendingDiff();
    return diff.toAdd.length > 0 || diff.toRemove.length > 0;
  });

  // --- Rich junction state (v0.51.0) ---
  isRichJunction = computed(() => this.extraColumns().length > 0);
  richPage = signal<1 | 2>(1);  // Current page in two-page flow
  extraColumnValues = signal<Map<number | string, Record<string, unknown>>>(new Map());
  page2FormGroups = signal<Map<number | string, FormGroup>>(new Map());
  private page2FormsValid = signal(true);
  private page2Subscriptions: Subscription[] = [];
  // Dynamically loaded to break circular dependency (EditProperty ↔ FkSearchModal)
  editPropertyComponent = signal<Type<any> | null>(null);

  // Page 2: items to configure (selected items that aren't being removed)
  page2Items = computed(() => {
    const selection = this.workingSelection();
    const cache = this.chipCache();
    const original = new Set(this.currentValueIds());

    return [...selection]
      .map(id => {
        const cached = cache.get(id) || { display_name: `#${id}` };
        return {
          id,
          display_name: cached.display_name,
          color: cached.color,
          isExisting: original.has(id)
        };
      })
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  });

  // Whether page 2 "Apply" can be clicked (all FormGroups valid)
  page2Valid = computed(() => this.page2FormsValid());

  // Computed — rich junction: whether Apply is enabled on page 2
  richApplyEnabled = computed(() => {
    if (!this.page2Valid()) return false;
    // Must have at least some change (add, remove, or update)
    const diff = this.pendingDiff();
    const hasSelectionChanges = diff.toAdd.length > 0 || diff.toRemove.length > 0;
    const hasExtraDataChanges = this.hasExtraColumnChanges();
    return hasSelectionChanges || hasExtraDataChanges;
  });

  // RPC options provide an ID filter, not a separate rendering path.
  // When rpcOptions is set, eligible IDs are injected as an `in` filter
  // into the standard table query so the modal always shows full entity columns.
  private rpcIdFilter = computed<FilterCriteria | null>(() => {
    const options = this.rpcOptions();
    if (!options || options.length === 0) return null;
    const ids = options.map(o => o.id);
    return { column: this.joinColumn(), operator: 'in', value: `(${ids.join(',')})` };
  });

  // Trigger for reloading data in table mode
  private reload$ = new Subject<void>();
  private lastOpenTable: string | null = null;  // Guard against effect re-triggering

  constructor() {
    // Focus retention: when a search/filter/sort re-renders the results while
    // the modal is open, the previously-focused element (a result row control)
    // may be destroyed, dropping DOM focus to <body> — which strands screen
    // readers on the page BEHIND the dialog. Pull focus back into the modal.
    effect(() => {
      this.rows();
      if (!this.isOpen()) return;
      setTimeout(() => {
        const host = this.hostEl.nativeElement as HTMLElement;
        if (!this.isOpen() || host.contains(document.activeElement)) return;
        const target = host.querySelector<HTMLElement>('input[type="text"], input[type="search"]')
          || host.closest<HTMLElement>('[role="dialog"]');
        target?.focus();
      }, 60);
    });

    // When modal opens, load properties and data.
    // Guard: only initialize once per open (isOpen transitions false→true).
    // Without this guard, signal writes (chipCache.set, workingSelection.set)
    // would re-trigger this effect, causing an infinite load loop.
    effect(() => {
      const open = this.isOpen();
      const table = this.joinTable();

      if (!open || !table || this.destroyed) {
        // Modal closed — reset guard so next open re-initializes
        if (!open) this.lastOpenTable = null;
        return;
      }

      // Skip if already initialized for this table (effect re-triggered by signal writes)
      if (this.lastOpenTable === table) return;
      this.lastOpenTable = table;

      // Reset ALL state to defaults, then overlay stored preferences
      this.searchQuery.set('');
      this.currentPage.set(1);
      this.pageSize.set(10);
      this.orderField.set('id');
      this.orderDirection.set('asc');
      this.filters.set([]);
      this.pendingSelection.set(null);

      // Overlay stored preferences if available
      const stored = this.loadStoredState();
      if (stored) {
        this.pageSize.set(stored.pageSize);
        this.orderField.set(stored.orderField);
        this.orderDirection.set(stored.orderDirection);
        this.filters.set(stored.filters);
      }

      // Multi-select: initialize workingSelection and chipCache from inputs
      if (this.multiSelect()) {
        this.workingSelection.set(new Set(this.currentValueIds()));
        const cache = new Map<number | string, {display_name: string, color?: string}>();
        this.currentValueItems().forEach(item => {
          cache.set(item.id, { display_name: item.display_name, color: item.color });
        });
        this.chipCache.set(cache);

        // v0.51.0: Reset rich junction page and initialize extra column values
        this.richPage.set(1);
        if (this.isRichJunction()) {
          this.extraColumnValues.set(new Map(this.currentJunctionData()));
        }
      }

      // Always load entity metadata and query the table.
      // RPC options (if any) are injected as an ID filter, not a separate path.
      this.loadEntityMetadata(table);
    });

    // Table mode: subscribe to reload triggers
    this.reload$.pipe(
      debounceTime(50),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => {
      this.loadTableData();
    });
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.reload$.complete();
    this.cleanupPage2Subscriptions();
  }

  private cleanupPage2Subscriptions() {
    this.page2Subscriptions.forEach(s => s.unsubscribe());
    this.page2Subscriptions = [];
  }

  private loadEntityMetadata(tableName: string) {
    this.loading.set(true);

    this.schema.getEntity(tableName).pipe(
      switchMap(entity => {
        if (entity) {
          this.hasSearchFields.set(!!(
            (entity.search_fields && entity.search_fields.length > 0) ||
            entity.fulltext_search_column ||
            entity.substring_search_column
          ));
          // Hybrid search columns (v0.55.2) so the modal matches list-page search
          this.fulltextSearchColumn.set(entity.fulltext_search_column ?? null);
          this.ilikeSearchColumns.set(
            entity.substring_search_column ? [entity.substring_search_column] : []
          );
          return combineLatest({
            listProps: this.schema.getPropsForList(entity),
            filterProps: this.schema.getPropsForFilter(entity)
          });
        }

        // System type config: rich modal for types not in schema_entities (e.g., civic_os_users)
        const systemConfig = SYSTEM_TYPE_MODAL_CONFIGS[tableName];
        if (systemConfig) {
          this.hasSearchFields.set(
            systemConfig.searchFields.length > 0 || !!systemConfig.fulltextColumn
          );
          this.fulltextSearchColumn.set(systemConfig.fulltextColumn ?? null);
          this.ilikeSearchColumns.set(systemConfig.searchFields);
          return of({
            listProps: systemConfig.listProperties as SchemaEntityProperty[],
            filterProps: [] as SchemaEntityProperty[]
          });
        }

        // Fallback: entity not registered in schema_entities
        this.hasSearchFields.set(false);
        this.fulltextSearchColumn.set(null);
        this.ilikeSearchColumns.set([]);
        return of({ listProps: [] as SchemaEntityProperty[], filterProps: [] as SchemaEntityProperty[] });
      }),
      catchError(() => {
        this.hasSearchFields.set(false);
        this.fulltextSearchColumn.set(null);
        this.ilikeSearchColumns.set([]);
        return of({ listProps: [] as SchemaEntityProperty[], filterProps: [] as SchemaEntityProperty[] });
      }),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(({ listProps, filterProps }) => {
      this.listProperties.set(listProps);
      this.filterProperties.set(filterProps);

      // Validate stored filters against available filter columns
      this.validateAndCleanStoredFilters(filterProps);

      this.reload$.next();
    });
  }

  private loadTableData() {
    const table = this.joinTable();
    const props = this.listProperties();
    if (!table) return;

    this.loading.set(true);

    // Build select fields from list properties
    const fields = props.length > 0
      ? props.map(p => SchemaService.propertyToSelectString(p))
      : ['id', 'display_name'];

    // Merge user filters with server-side filter (v0.53.0) or RPC ID filter
    // serverFilter takes precedence: it's a lightweight server-side WHERE clause
    // that scales to any dataset size, vs rpcIdFilter which embeds all IDs in the URL.
    const allFilters: FilterCriteria[] = [...this.filters()];
    const sf = this.serverFilter();
    if (sf) {
      allFilters.push(sf);
    } else {
      const rpcFilter = this.rpcIdFilter();
      if (rpcFilter) {
        allFilters.push(rpcFilter);
      }
    }

    // Build search with the same hybrid semantics as the List page: wfts on
    // the fulltext column combined with ILIKE substring matching via or=().
    // Entities with neither column fall back to the legacy searchQuery path
    // (civic_os_text_search wfts in DataService).
    const searchTerm = this.searchQuery()?.trim();
    let searchQuery: string | undefined;
    let rawQueryParams: string[] | undefined;

    if (searchTerm) {
      const params = buildHybridSearchParams(
        searchTerm,
        this.fulltextSearchColumn(),
        this.ilikeSearchColumns()
      );
      if (params.length > 0) {
        rawQueryParams = params;
      } else {
        searchQuery = searchTerm;
      }
    }

    this.data.getDataPaginated({
      key: table,
      fields,
      orderField: this.orderField(),
      orderDirection: this.orderDirection(),
      searchQuery,
      rawQueryParams,
      filters: allFilters.length > 0 ? allFilters : undefined,
      pagination: {
        page: this.currentPage(),
        pageSize: this.pageSize()
      }
    }).pipe(
      catchError(() => of({ data: [], totalCount: 0 })),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(result => {
      this.rows.set(result.data);
      this.totalCount.set(result.totalCount);
      this.loading.set(false);

      // Multi-select: cache display data from page rows for right panel chips
      if (this.multiSelect()) {
        this.chipCache.update(m => {
          const next = new Map(m);
          result.data.forEach(row => {
            if (row.id != null) {
              next.set(row.id, {
                display_name: row.display_name,
                color: (row as any).color
              });
            }
          });
          return next;
        });
      }

      // Single-select: auto-highlight current value if found in results
      this.preHighlightCurrent();
    });
  }

  private preHighlightCurrent() {
    const current = this.currentValue();
    if (current === null || current === undefined || this.pendingSelection() !== null) return;

    const match = this.rows().find(r => String(r.id) === String(current));
    if (match) {
      this.pendingSelection.set({
        id: match.id!,
        displayName: match.display_name
      });
    }
  }

  // --- User interaction handlers ---

  onRowClick(row: EntityData) {
    this.pendingSelection.set({
      id: row.id!,
      displayName: row.display_name
    });
  }

  onConfirm() {
    this.confirmed.emit(this.pendingSelection());
  }

  onClear() {
    this.confirmed.emit(null);
  }

  onCancel() {
    this.closed.emit();
  }

  onSearchInput(query: string) {
    this.searchQuery.set(query);
    this.currentPage.set(1);
    this.reload$.next();
  }

  onSort(columnName: string) {
    if (this.orderField() === columnName) {
      this.orderDirection.set(this.orderDirection() === 'asc' ? 'desc' : 'asc');
    } else {
      this.orderField.set(columnName);
      this.orderDirection.set('asc');
    }
    this.currentPage.set(1);
    const prop = this.listProperties().find(p => p.column_name === columnName);
    this.sortAnnouncement.set(this.translationSvc.get('a11y.sorted_by', {
      column: prop?.display_name || columnName,
      direction: this.translationSvc.get(this.orderDirection() === 'asc' ? 'a11y.ascending' : 'a11y.descending')
    }));
    this.saveState();
    this.reload$.next();
  }

  onPageChange(page: number) {
    this.currentPage.set(page);
    this.reload$.next();
  }

  onPageSizeChange(size: number) {
    this.pageSize.set(size);
    this.currentPage.set(1);
    this.saveState();
    this.reload$.next();
  }

  onFiltersChange(filters: FilterCriteria[]) {
    this.filters.set(filters);
    this.currentPage.set(1);
    this.saveState();
    this.reload$.next();
  }

  isSelected(id: number | string | undefined): boolean {
    if (id === undefined) return false;
    const pending = this.pendingSelection();
    return pending !== null && String(pending.id) === String(id);
  }

  // --- Multi-select interaction handlers (v0.46.0) ---

  isInWorkingSelection(id: number | string | undefined): boolean {
    if (id === undefined) return false;
    // Use string comparison to handle mixed number/string IDs from PostgREST
    const selection = this.workingSelection();
    return selection.has(id) || selection.has(String(id)) || selection.has(Number(id));
  }

  toggleSelection(id: number | string, displayName: string, color?: string) {
    this.workingSelection.update(set => {
      const next = new Set(set);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
    this.chipCache.update(m => new Map(m).set(id, { display_name: displayName, color }));
  }

  removeChip(id: number | string) {
    this.workingSelection.update(set => {
      const next = new Set(set);
      next.delete(id);
      return next;
    });
  }

  onApply() {
    const diff = this.pendingDiff();
    const cache = this.chipCache();
    // Include display data for added items so the caller can show names (not just IDs)
    const addedItems = diff.toAdd.map(id => ({
      id,
      ...(cache.get(id) || { display_name: `#${id}` })
    }));
    this.applied.emit({ ...diff, addedItems });
  }

  getSortIcon(columnName: string): string {
    if (this.orderField() !== columnName) return '';
    return this.orderDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward';
  }

  // --- Rich junction methods (v0.51.0) ---

  goToPage2() {
    this.buildPage2FormGroups();
    // Dynamic import breaks the circular dependency with EditPropertyComponent
    if (!this.editPropertyComponent()) {
      import('../edit-property/edit-property.component').then(m => {
        this.editPropertyComponent.set(m.EditPropertyComponent);
      });
    }
    this.richPage.set(2);
  }

  goToPage1() {
    this.richPage.set(1);
  }

  getExtraValue(itemId: number | string, columnName: string): unknown {
    const values = this.extraColumnValues();
    const itemValues = values.get(itemId);
    return itemValues?.[columnName] ?? null;
  }

  setExtraValue(itemId: number | string, columnName: string, value: unknown) {
    this.extraColumnValues.update(m => {
      const next = new Map(m);
      const itemValues = { ...(next.get(itemId) || {}) };
      itemValues[columnName] = value;
      next.set(itemId, itemValues);
      return next;
    });
  }

  /** Build a FormGroup per selected item with validators from SchemaService */
  private buildPage2FormGroups() {
    this.cleanupPage2Subscriptions();
    const items = this.page2Items();
    const extras = this.extraColumns();
    const currentValues = this.extraColumnValues();
    const groups = new Map<number | string, FormGroup>();

    for (const item of items) {
      const controls: Record<string, FormControl> = {};
      const itemValues = currentValues.get(item.id) || {};

      for (const col of extras) {
        const defaultValue = itemValues[col.column_name] ??
          SchemaService.getDefaultValueForProperty(col);
        const validators = SchemaService.getFormValidatorsForProperty(col);
        controls[col.column_name] = new FormControl(defaultValue, validators);
      }

      const fg = new FormGroup(controls);
      groups.set(item.id, fg);

      // Sync FormGroup value changes back to extraColumnValues signal
      const valueSub = fg.valueChanges.subscribe(values => {
        this.extraColumnValues.update(m => {
          const next = new Map(m);
          next.set(item.id, { ...(next.get(item.id) || {}), ...values });
          return next;
        });
      });
      this.page2Subscriptions.push(valueSub);
    }

    this.page2FormGroups.set(groups);

    // Monitor validity of all FormGroups
    const allGroups = [...groups.values()];
    if (allGroups.length > 0) {
      const statusSub = merge(...allGroups.map(g => g.statusChanges)).pipe(
        debounceTime(50)
      ).subscribe(() => this.checkPage2Validity());
      this.page2Subscriptions.push(statusSub);
    }

    // Initial validity check
    this.checkPage2Validity();
  }

  private checkPage2Validity() {
    const groups = this.page2FormGroups();
    const allValid = [...groups.values()].every(g => g.valid);
    this.page2FormsValid.set(allValid);
  }

  /** Get the FormGroup for a given item ID (used by template) */
  getItemFormGroup(itemId: number | string): FormGroup {
    return this.page2FormGroups().get(itemId) || new FormGroup({});
  }

  /** Build inputs object for NgComponentOutlet rendering of EditPropertyComponent */
  getEditPropertyInputs(col: SchemaEntityProperty, itemId: number | string): Record<string, unknown> {
    return {
      property: col,
      formGroup: this.getItemFormGroup(itemId),
      compact: true
    };
  }

  /** Check if any extra column values changed from their original values */
  private hasExtraColumnChanges(): boolean {
    const original = this.currentJunctionData();
    const current = this.extraColumnValues();
    const extras = this.extraColumns();

    for (const [id, currentValues] of current) {
      const originalValues = original.get(id);
      if (!originalValues) continue; // New item, handled by toAdd
      for (const col of extras) {
        if (currentValues[col.column_name] !== originalValues[col.column_name]) {
          return true;
        }
      }
    }
    return false;
  }

  onRichApply() {
    const diff = this.pendingDiff();
    const cache = this.chipCache();
    const originalJunction = this.currentJunctionData();
    const currentValues = this.extraColumnValues();
    const extras = this.extraColumns();

    // Build toAdd with extra data
    const toAdd = diff.toAdd.map(id => ({
      id,
      extraData: currentValues.get(id) || {}
    }));

    // Build toUpdate: existing items whose extra column values changed
    const toUpdate: { id: number | string; extraData: Record<string, unknown> }[] = [];
    const originalIds = new Set(this.currentValueIds());
    const working = this.workingSelection();

    for (const id of working) {
      if (!originalIds.has(id)) continue; // New item — in toAdd, not toUpdate
      const origValues = originalJunction.get(id);
      const currValues = currentValues.get(id);
      if (!origValues || !currValues) continue;

      const changed: Record<string, unknown> = {};
      let hasChange = false;
      for (const col of extras) {
        if (currValues[col.column_name] !== origValues[col.column_name]) {
          changed[col.column_name] = currValues[col.column_name];
          hasChange = true;
        }
      }
      if (hasChange) {
        toUpdate.push({ id, extraData: changed });
      }
    }

    // addedItems for display cache
    const addedItems = diff.toAdd.map(id => ({
      id,
      ...(cache.get(id) || { display_name: `#${id}` })
    }));

    this.richApplied.emit({
      toAdd,
      toRemove: diff.toRemove,
      toUpdate,
      addedItems
    });
  }

  // --- localStorage persistence (v0.56.0) ---

  /** Read and validate stored state from localStorage. Returns null on any error. */
  private loadStoredState(): FkModalStoredState | null {
    const key = this.storageKey();
    if (!key || typeof window === 'undefined') return null;

    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw);

      // Coerce pageSize to number — Angular <select> emits strings via [value]
      const pageSize = Number(parsed.pageSize);

      // Validate shape
      if (
        typeof parsed !== 'object' || parsed === null ||
        isNaN(pageSize) || pageSize <= 0 ||
        typeof parsed.orderField !== 'string' ||
        (parsed.orderDirection !== 'asc' && parsed.orderDirection !== 'desc') ||
        !Array.isArray(parsed.filters)
      ) {
        return null;
      }

      // Validate each filter has required fields
      const validFilters = parsed.filters.filter(
        (f: any) => typeof f?.column === 'string' && typeof f?.operator === 'string'
      );

      return {
        pageSize,
        orderField: parsed.orderField,
        orderDirection: parsed.orderDirection,
        filters: validFilters
      };
    } catch {
      return null;
    }
  }

  /** Persist current pageSize, sort, and filters to localStorage. No-op when storageKey is empty. */
  private saveState(): void {
    const key = this.storageKey();
    if (!key || typeof window === 'undefined') return;

    try {
      const state: FkModalStoredState = {
        pageSize: Number(this.pageSize()),  // Coerce: <select> may emit strings
        orderField: this.orderField(),
        orderDirection: this.orderDirection(),
        filters: this.filters()
      };
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // localStorage full or unavailable — silent no-op
    }
  }

  /** Strip stored filters referencing columns not in available filterProperties, and re-persist. */
  private validateAndCleanStoredFilters(filterProps: SchemaEntityProperty[]): void {
    const currentFilters = this.filters();
    if (currentFilters.length === 0) return;

    const validColumns = new Set(filterProps.map(p => p.column_name));
    const cleaned = currentFilters.filter(f => validColumns.has(f.column));

    if (cleaned.length !== currentFilters.length) {
      this.filters.set(cleaned);
      this.saveState();
    }
  }
}
