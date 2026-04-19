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
  OnDestroy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, switchMap, of, combineLatest, debounceTime, catchError } from 'rxjs';

import { CosModalComponent } from '../cos-modal/cos-modal.component';
import { PaginationComponent } from '../pagination/pagination.component';
import { FilterBarComponent } from '../filter-bar/filter-bar.component';
import { DisplayPropertyComponent } from '../display-property/display-property.component';
import { DataService } from '../../services/data.service';
import { SchemaService } from '../../services/schema.service';
import { SchemaEntityProperty, EntityData } from '../../interfaces/entity';
import { FilterCriteria } from '../../interfaces/query';

@Component({
  selector: 'app-fk-search-modal',
  imports: [
    CommonModule,
    FormsModule,
    CosModalComponent,
    PaginationComponent,
    FilterBarComponent,
    DisplayPropertyComponent
  ],
  templateUrl: './fk-search-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FkSearchModalComponent implements OnDestroy {
  private data = inject(DataService);
  private schema = inject(SchemaService);
  private destroyRef = inject(DestroyRef);
  private destroyed = false;

  // Inputs
  isOpen = input.required<boolean>();
  joinTable = input.required<string>();
  joinColumn = input<string>('id');
  currentValue = input<number | string | null>(null);
  isNullable = input(false);
  title = input('Select');
  rpcOptions = input<{id: number | string, text: string}[] | null>(null);

  // Outputs
  confirmed = output<{id: number | string, displayName: string} | null>();
  closed = output<void>();

  // State
  loading = signal(false);
  listProperties = signal<SchemaEntityProperty[]>([]);
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
  pendingSelection = signal<{id: number | string, displayName: string} | null>(null);

  // Whether the Confirm button should be enabled
  confirmEnabled = computed(() => {
    const pending = this.pendingSelection();
    const current = this.currentValue();
    if (pending === null) return current !== null && current !== undefined;
    return String(pending.id) !== String(current);
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

  constructor() {
    // When modal opens, load properties and data
    effect(() => {
      const open = this.isOpen();
      const table = this.joinTable();
      if (!open || !table || this.destroyed) return;

      // Reset state on open
      this.searchQuery.set('');
      this.currentPage.set(1);
      this.filters.set([]);
      this.pendingSelection.set(null);

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
  }

  private loadEntityMetadata(tableName: string) {
    this.loading.set(true);

    this.schema.getEntity(tableName).pipe(
      switchMap(entity => {
        if (entity) {
          this.hasSearchFields.set(!!(entity.search_fields && entity.search_fields.length > 0));
          return combineLatest({
            listProps: this.schema.getPropsForList(entity),
            filterProps: this.schema.getPropsForFilter(entity)
          });
        }
        // Fallback: entity not registered in schema_entities
        this.hasSearchFields.set(false);
        return of({ listProps: [] as SchemaEntityProperty[], filterProps: [] as SchemaEntityProperty[] });
      }),
      catchError(() => {
        this.hasSearchFields.set(false);
        return of({ listProps: [] as SchemaEntityProperty[], filterProps: [] as SchemaEntityProperty[] });
      }),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(({ listProps, filterProps }) => {
      this.listProperties.set(listProps);
      this.filterProperties.set(filterProps);
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

    // Merge user filters with RPC ID filter (if any)
    const allFilters: FilterCriteria[] = [...this.filters()];
    const rpcFilter = this.rpcIdFilter();
    if (rpcFilter) {
      allFilters.push(rpcFilter);
    }

    this.data.getDataPaginated({
      key: table,
      fields,
      orderField: this.orderField(),
      orderDirection: this.orderDirection(),
      searchQuery: this.searchQuery() || undefined,
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

      // Auto-highlight current value if found in results
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
    this.reload$.next();
  }

  onPageChange(page: number) {
    this.currentPage.set(page);
    this.reload$.next();
  }

  onPageSizeChange(size: number) {
    this.pageSize.set(size);
    this.currentPage.set(1);
    this.reload$.next();
  }

  onFiltersChange(filters: FilterCriteria[]) {
    this.filters.set(filters);
    this.currentPage.set(1);
    this.reload$.next();
  }

  isSelected(id: number | string | undefined): boolean {
    if (id === undefined) return false;
    const pending = this.pendingSelection();
    return pending !== null && String(pending.id) === String(id);
  }

  getSortIcon(columnName: string): string {
    if (this.orderField() !== columnName) return '';
    return this.orderDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward';
  }
}
