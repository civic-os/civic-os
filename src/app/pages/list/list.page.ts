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

import { Component, inject, ChangeDetectionStrategy, signal, OnInit, OnDestroy, computed, effect, DestroyRef, input, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, Params, Router, RouterModule } from '@angular/router';
import { Observable, Subject, map, of, debounceTime, distinctUntilChanged, switchMap } from 'rxjs';
import { SchemaService } from '../../services/schema.service';
import { CommonModule } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { AnalyticsService } from '../../services/analytics.service';
import { AuthService } from '../../services/auth.service';
import { MaintenanceService } from '../../services/maintenance.service';
import { GuidedFormService } from '../../services/guided-form.service';
import { TranslationService } from '../../services/translation.service';
import { FACADE_DEPS } from '../../sdk/facade-deps';
import { listStateFromParams, LIST_PAGE_SIZE_STORAGE_KEY } from '../../sdk/list-url';
import { switchingStore } from '../../sdk/switching-store';
import { MapPolygon, SchemaEntityProperty, SchemaEntityTable } from '../../interfaces/entity';
import { DisplayPropertyComponent } from '../../components/display-property/display-property.component';
import { FilterBarComponent } from '../../components/filter-bar/filter-bar.component';
import { PaginationComponent } from '../../components/pagination/pagination.component';
import { GeoPointMapComponent, MapMarker } from '../../components/geo-point-map/geo-point-map.component';
import { GeoPolygonMapComponent, resolveColor } from '../../components/geo-polygon-map/geo-polygon-map.component';
import { TimeSlotCalendarComponent, CalendarEvent } from '../../components/time-slot-calendar/time-slot-calendar.component';
import { ImportExportButtonsComponent } from '../../components/import-export-buttons/import-export-buttons.component';
import { EmptyStateComponent } from '../../components/empty-state/empty-state.component';
import { CosModalComponent } from '../../components/cos-modal/cos-modal.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { FilterCriteria } from '../../interfaces/query';
import { ConfigService } from '../../services/config.service';
import { recordList, type EntityHandle, type ListFilterChip, type ListState, type RecordList, type RecordListSnapshot } from '@civic-os/core';

/** A filter chip as the template shows it: the facade's chip with the value worded. */
interface FilterChip {
  column: string;
  columnLabel: string;
  displayValue: string;
}

const NO_ITEMS: readonly never[] = [];

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** The chip's wording; the facade decides the kind, the page words it. */
function toFilterChip(chip: ListFilterChip): FilterChip {
  switch (chip.kind) {
    case 'range':
      return { column: chip.column, columnLabel: chip.label, displayValue: `${chip.min} - ${chip.max}` };
    case 'gte':
      return { column: chip.column, columnLabel: chip.label, displayValue: `≥ ${chip.value}` };
    case 'lte':
      return { column: chip.column, columnLabel: chip.label, displayValue: `≤ ${chip.value}` };
    case 'selected':
      return { column: chip.column, columnLabel: chip.label, displayValue: chip.count === 1 ? '1 selected' : `${chip.count} selected` };
    case 'boolean':
      return { column: chip.column, columnLabel: chip.label, displayValue: chip.yes ? 'Yes' : 'No' };
    default:
      return { column: chip.column, columnLabel: chip.label, displayValue: String(chip.value) };
  }
}

@Component({
    selector: 'app-view',
    templateUrl: './list.page.html',
    styleUrl: './list.page.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
    CommonModule,
    RouterModule,
    ReactiveFormsModule,
    DisplayPropertyComponent,
    FilterBarComponent,
    PaginationComponent,
    GeoPointMapComponent,
    GeoPolygonMapComponent,
    TimeSlotCalendarComponent,
    ImportExportButtonsComponent,
    EmptyStateComponent,
    CosModalComponent,
    TranslatePipe
]
})
export class ListPage implements OnInit, OnDestroy {
  /** The route entity's core handle, from `entityResolver` through route input binding. The `recordList` facade is made from it. */
  readonly entityHandle = input<EntityHandle | undefined>();

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private schema = inject(SchemaService);
  private analytics = inject(AnalyticsService);
  private destroyRef = inject(DestroyRef);
  private guidedForm = inject(GuidedFormService);
  private titleService = inject(Title);
  private configService = inject(ConfigService);
  private translation = inject(TranslationService);
  private facadeDeps = inject(FACADE_DEPS);

  /** Polite announcement for sort changes (aria-sort changes alone are not reliably spoken). */
  public listAnnouncement = signal('');
  public auth = inject(AuthService);
  public maintenance = inject(MaintenanceService);

  // Set the document title once entity metadata resolves (e.g. "Issues – Civic OS").
  private _titleEffect = effect(() => {
    const entity = this.entitySignal();
    if (entity?.display_name) {
      this.titleService.setTitle(`${entity.display_name} - ${this.configService.appTitle()}`);
    }
  });

  public entityKey?: string;
  public searchControl = new FormControl('');

  // Deduplication key for list view analytics (prevents re-tracking when the list re-publishes the same state)
  private lastListTrackingKey = '';

  // Row hover stream for debouncing map interactions
  private rowHover$ = new Subject<number | null>();

  public entity$: Observable<SchemaEntityTable | undefined> = this.route.params.pipe(
    switchMap(p => {
      if(p['entityKey']) {
        return this.schema.getEntity(p['entityKey']);
      } else {
        return of(undefined);
      }
    })
  );

  // The list: one `recordList` facade per entity handle, read as a signal. The URL stays the source of truth;
  // the route's query params are mapped to `set` and the handlers below navigate (see `applyParams`).
  private list?: RecordList;
  private listBinding = switchingStore<RecordListSnapshot>();
  private snapshot = this.listBinding.value;
  /** The newest query params, for the facade made after them. */
  private latestParams: Params = {};
  /** The entity the current facade lists; the URL's state reaches the facade only while it is the route's entity. */
  private listEntity?: string;
  /** True from an entity switch until the query params are cleared; no state reaches the facade meanwhile. */
  private clearing = false;
  private paramsPending = false;
  private clearToken = 0;


  // One facade per entity handle; the previous one is aborted and disposed.
  private _bindList = effect(() => {
    const handle = this.entityHandle();
    untracked(() => {
      this.list?.dispose();
      this.list = undefined;
      this.listEntity = undefined;
      if (!handle) {
        this.listBinding.bind(undefined);
        return;
      }
      // An entity switch clears the URL's params before loading, so the new entity never loads with the old ones.
      const list = recordList(this.facadeDeps, handle, { initial: listStateFromParams(this.clearing ? {} : this.latestParams) });
      this.list = list;
      this.listEntity = handle.name;
      this.listBinding.bind(list);
    });
  });

  // Track the list view once a load has settled (declared after _bindList, so a switch rebinds first).
  private _trackEffect = effect(() => {
    const snap = this.snapshot();
    if (!snap || snap.loading || !snap.loadedState) return;
    untracked(() => this.trackListView(snap.loadedState!, snap.totalCount));
  });

  // The list's state and rows, for the template
  public isLoading = computed(() => this.snapshot()?.loading ?? true);
  public dataSignal = computed(() => (this.snapshot()?.rows ?? NO_ITEMS) as any[]);
  public totalCount = computed(() => this.snapshot()?.totalCount ?? 0);
  public currentPage = computed(() => this.snapshot()?.state.page ?? 1);
  public pageSize = computed(() => this.snapshot()?.state.pageSize ?? 25);
  public sortStateSignal = computed(() => this.snapshot()?.state.sort ?? { column: null, direction: null });

  // Properties for display - excludes map property if hidden from list
  public displayProperties = computed<SchemaEntityProperty[]>(
    () => (this.snapshot()?.displayColumns ?? NO_ITEMS) as SchemaEntityProperty[], { equal: sameItems });
  public filterProperties = computed<SchemaEntityProperty[]>(
    () => (this.snapshot()?.filterColumns ?? NO_ITEMS) as SchemaEntityProperty[], { equal: sameItems });
  /** Whether the list's columns have loaded (the table is not drawn before). */
  public columnsReady = computed(() => (this.snapshot()?.columns.length ?? 0) > 0);

  private filterCriteria = computed(() => this.snapshot()?.state.filters);
  public filtersSignal = computed<FilterCriteria[]>(() => [...(this.filterCriteria() ?? [])]);

  public searchTerms = computed<string[]>(
    () => [...(this.snapshot()?.searchTerms ?? [])],
    { equal: (a, b) => sameItems(a, b) });
  public isFiltered = computed(() => this.snapshot()?.filtered ?? false);
  public filterChips = computed<FilterChip[]>(() => (this.snapshot()?.chips ?? []).map(toFilterChip));
  /** The calendar's view and focus date, which the calendar component starts from. */
  public calendarState = computed(() => this.snapshot()?.state.calendar ?? null);

  // Convert entity$ to signal for the title
  private entitySignal = toSignal(this.entity$);

  // Guided form error state
  public showGuidedFormError = signal(false);
  public guidedFormErrorMessage = signal<string | undefined>(undefined);

  // Map-related signals
  public highlightedRecordId = signal<number | null>(null);

  // Summary VIEWs are read-only aggregates without id/created_at/updated_at.
  // Rows are non-clickable (no detail page navigation).
  public isSummaryView = computed(() => this.snapshot()?.views.summary ?? false);
  public showMap = computed(() => (this.snapshot()?.views.map ?? null) !== null);
  public mapKind = computed(() => this.snapshot()?.views.map ?? null);
  public showCalendar = computed(() => this.snapshot()?.views.calendar ?? false);

  // Map markers (GeoPoint) from the current page of rows; rebuilt only when a marker changes
  public mapMarkers = computed<MapMarker[]>(
    () => (this.snapshot()?.markers ?? []).map(m => ({ id: m.id, name: m.name, wkt: m.wkt })),
    { equal: (a, b) => a.length === b.length && a.every((m, i) => m.id === b[i].id && m.name === b[i].name && m.wkt === b[i].wkt) });

  // Map polygons (GeoPolygon) from the current page of rows
  public mapPolygons = computed<MapPolygon[]>(
    () => (this.snapshot()?.polygons ?? []).map(p => ({
      id: p.id,
      name: p.name,
      wkt: p.wkt,
      color: p.color ? resolveColor(p.color) : undefined
    } as MapPolygon)),
    { equal: (a, b) => a.length === b.length && a.every((p, i) => p.id === b[i].id && p.name === b[i].name && p.wkt === b[i].wkt && p.color === b[i].color) });

  // Calendar events from the current page of rows
  public calendarEvents = computed<CalendarEvent[]>(
    () => (this.snapshot()?.events ?? []).map(e => ({
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      color: e.color,
      extendedProps: { data: e.row }
    } as CalendarEvent)),
    { equal: (a, b) => a.length === b.length && a.every((e, i) =>
      e.id === b[i].id && e.title === b[i].title && e.start.getTime() === b[i].start.getTime() &&
      e.end.getTime() === b[i].end.getTime() && e.color === b[i].color && e.extendedProps.data === b[i].extendedProps.data) });

  constructor() {
    this.syncRoute();
  }

  /**
   * Follows the route: the entity key (an entity switch clears the query params before the new entity loads,
   * as the page always did) and the query params (mapped to the facade's `set`).
   */
  private syncRoute(): void {
    this.route.params.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(p => {
      if (this.entityKey && this.entityKey !== p['entityKey']) {
        this.entityKey = p['entityKey'];
        this.lastListTrackingKey = ''; // Reset so first load of new entity always tracks
        this.clearing = true;
        const token = ++this.clearToken;
        const done = () => {
          if (token !== this.clearToken) return;
          this.clearing = false;
          this.applyParams();
        };
        this.router.navigate([], {
          relativeTo: this.route,
          queryParams: {},
          replaceUrl: true
        }).then(done, done);
      } else {
        this.entityKey = p['entityKey'];
      }
    });

    this.route.queryParams.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      this.latestParams = params;
      // Applied in a microtask: an entity switch emits the query params before the entity key, and the old
      // entity's list must not see them.
      if (!this.paramsPending) {
        this.paramsPending = true;
        queueMicrotask(() => {
          this.paramsPending = false;
          this.applyParams();
        });
      }
    });
  }

  /**
   * Hands the URL's state to the facade, which sends a request only when the state changed. After an entity
   * switch the old entity's facade lives on until the new handle arrives, and it must not load the cleared state.
   */
  private applyParams(): void {
    if (this.clearing || this.listEntity !== this.entityKey) return;
    this.list?.set(listStateFromParams(this.latestParams));
  }

  /** Track list view — unified event for every distinct view state. */
  private trackListView(state: ListState, totalCount: number): void {
    if (!this.entityKey) return;
    const filterColumns = state.filters
      .map(f => f.column)
      .filter((col, i, arr) => arr.indexOf(col) === i)
      .sort()
      .join(',');
    const hasSearch = state.search.trim().length > 0;
    const page = state.page || 1;
    const trackingKey = `${this.entityKey}|${filterColumns}|${hasSearch}|${page}`;

    if (trackingKey !== this.lastListTrackingKey) {
      this.lastListTrackingKey = trackingKey;

      const parts = [this.entityKey];
      if (filterColumns) parts.push(filterColumns);
      if (hasSearch) parts.push('search');
      if (page > 1) parts.push(`p${page}`);
      this.analytics.trackEvent('Entity', 'List', parts.join(':'), totalCount);
    }
  }

  ngOnInit() {
    // Sync searchControl with URL query params (bidirectional)
    // URL → searchControl
    this.route.queryParams
      .pipe(
        map(params => params['q'] || ''),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(query => {
        if (this.searchControl.value !== query) {
          this.searchControl.setValue(query, { emitEvent: false });
        }
      });

    // searchControl → URL (debounced, reset to page 1)
    this.searchControl.valueChanges
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(value => {
        // Track search queries (length only, not content for privacy)
        if (value && value.trim().length > 0 && this.entityKey) {
          this.analytics.trackEvent('Search', 'Query', this.entityKey, value.trim().length);
        }

        // Navigate to update URL with new search value (reset to page 1)
        this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { q: value || null, page: 1 },
          queryParamsHandling: 'merge',
          replaceUrl: true
        });
      });

    // Debounce row hover events to prevent jerky map behavior during scrolling
    this.rowHover$
      .pipe(
        debounceTime(150), // Wait 150ms before updating map
        distinctUntilChanged(), // Skip if same value
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(recordId => {
        this.highlightedRecordId.set(recordId);
      });
  }

  ngOnDestroy() {
    // Clean up Subject, and stop the list's load in flight
    this.rowHover$.complete();
    this.list?.dispose();
    this.list = undefined;
  }

  public onFiltersChange(filters: FilterCriteria[]) {
    // Get current filters from URL
    const currentFilters = this.filtersSignal();

    let allFilters: FilterCriteria[];

    if (filters.length === 0) {
      // FilterBar is clearing all filterable columns
      // Preserve only non-filterable column filters (e.g., from Related Records)
      const filterableProps = this.filterProperties();
      const filterableColumns = new Set(filterableProps.map(p => p.column_name));
      allFilters = currentFilters.filter(f => !filterableColumns.has(f.column));
    } else {
      // FilterBar is updating — all filterable columns are managed by FilterBar
      // Preserve only filters for non-filterable columns (e.g., from Related Records)
      const filterableProps = this.filterProperties();
      const filterableColumns = new Set(filterableProps.map(p => p.column_name));
      const preservedFilters = currentFilters.filter(f => !filterableColumns.has(f.column));

      // Combine preserved filters with new filters from FilterBar
      allFilters = [...preservedFilters, ...filters];
    }

    // Announce: a filter change that yields the same result count would
    // otherwise be silent (the results-count live region only fires on change).
    this.listAnnouncement.set(this.translation.get(
      allFilters.length > 0 ? 'a11y.filters_applied' : 'a11y.filters_cleared'
    ));

    // Build filter query params
    const filterParams: any = {};

    // First, clear all existing filter params by setting them to null
    const currentParams = this.route.snapshot.queryParams;
    Object.keys(currentParams).forEach(key => {
      if (key.match(/^f\d+_(col|op|val)$/)) {
        filterParams[key] = null;
      }
    });

    // Then set all filter params (preserved + new)
    allFilters.forEach((filter, index) => {
      filterParams[`f${index}_col`] = filter.column;
      filterParams[`f${index}_op`] = filter.operator;
      filterParams[`f${index}_val`] = filter.value;
    });

    // Reset to page 1 when filters change
    filterParams['page'] = 1;

    // Navigate with new filter params (preserves search and sort)
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: filterParams,
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  public isColumnFiltered(columnName: string): boolean {
    const filters = this.filtersSignal();
    return filters.some(f => f.column === columnName);
  }

  public clearSearch() {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: null, page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  /**
   * Clear all filters and search query
   */
  public onClearAllFilters() {
    // Build params to clear all filter-related query params
    const clearParams: any = { q: null, page: 1 };

    // Clear all existing filter params
    const currentParams = this.route.snapshot.queryParams;
    Object.keys(currentParams).forEach(key => {
      if (key.match(/^f\d+_(col|op|val)$/)) {
        clearParams[key] = null;
      }
    });

    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: clearParams,
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  public removeFilter(columnToRemove: string) {
    const currentFilters = this.filtersSignal();
    const newFilters = currentFilters.filter(f => f.column !== columnToRemove);
    this.listAnnouncement.set(this.translation.get('a11y.filter_removed'));

    // Build filter query params directly (bypass onFiltersChange preservation logic)
    const filterParams: any = {};

    // First, clear all existing filter params by setting them to null
    const currentParams = this.route.snapshot.queryParams;
    Object.keys(currentParams).forEach(key => {
      if (key.match(/^f\d+_(col|op|val)$/)) {
        filterParams[key] = null;
      }
    });

    // Then set the new filter params
    newFilters.forEach((filter, index) => {
      filterParams[`f${index}_col`] = filter.column;
      filterParams[`f${index}_op`] = filter.operator;
      filterParams[`f${index}_val`] = filter.value;
    });

    // Reset to page 1 when filters change
    filterParams['page'] = 1;

    // Navigate with new filter params (preserves search and sort)
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: filterParams,
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  /**
   * Handles table header clicks to cycle through sort states.
   * Triple-state toggle: unsorted → asc → desc → unsorted
   */
  public onHeaderClick(property: SchemaEntityProperty) {
    // Only sortable columns can be clicked
    if (property.sortable === false) {
      return;
    }

    const currentState = this.sortStateSignal();

    let newSort: string | null = null;
    let newDir: 'asc' | 'desc' | null = null;

    // Clicking a different column - start with asc
    if (currentState.column !== property.column_name) {
      newSort = property.column_name;
      newDir = 'asc';
    } else {
      // Clicking the same column - cycle through states
      if (currentState.direction === 'asc') {
        newSort = property.column_name;
        newDir = 'desc';
      } else if (currentState.direction === 'desc') {
        // Reset to unsorted
        newSort = null;
        newDir = null;
      }
    }

    // Announce the sort change: aria-sort alone is not reliably spoken by
    // screen readers when the attribute changes (observed with VoiceOver).
    if (newSort && newDir) {
      this.listAnnouncement.set(this.translation.get('a11y.sorted_by', {
        column: property.display_name,
        direction: this.translation.get(newDir === 'asc' ? 'a11y.ascending' : 'a11y.descending')
      }));
    } else {
      this.listAnnouncement.set(this.translation.get('a11y.sort_cleared'));
    }

    // Navigate with new sort params (reset to page 1)
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        sort: newSort,
        dir: newDir,
        page: 1
      },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  /**
   * Handle page change from pagination component
   */
  public onPageChange(page: number) {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });

    // Scroll to top of page
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Handle page size change from pagination component
   */
  public onPageSizeChange(pageSize: number) {
    // Store preference
    this.storePageSize(pageSize);

    // Navigate with new page size (will be reset to page 1 by pagination component)
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { pageSize, page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }
  /**
   * Store page size to localStorage
   */
  private storePageSize(pageSize: number) {
    localStorage.setItem(LIST_PAGE_SIZE_STORAGE_KEY, pageSize.toString());
  }

  /**
   * Handle marker click - scroll to and highlight the corresponding row
   */
  public onMarkerClick(recordId: number) {
    if (this.isSummaryView()) return;
    // Always highlight the clicked marker record
    this.highlightedRecordId.set(recordId);

    // Find the row element by data attribute and scroll to it if it exists
    const rowElement = document.querySelector(`tr[data-record-id="${recordId}"]`);
    if (rowElement) {
      // Scroll to row with offset for sticky header
      const yOffset = -100; // Account for sticky header
      const y = rowElement.getBoundingClientRect().top + window.pageYOffset + yOffset;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
  }

  /**
   * Handle row hover - push to stream for debounced map updates
   */
  public onRowHover(recordId: number | null) {
    if (this.isSummaryView()) return;
    this.rowHover$.next(recordId);
  }

  /**
   * Handle row click - navigate to the record's detail page (mouse convenience).
   * Keyboard users use the real first-cell link instead of the row.
   */
  public onRowClick(recordId: number) {
    if (this.isSummaryView()) return;
    if (this.entityKey) {
      this.router.navigate(['/view', this.entityKey, recordId]);
    }
  }

  /**
   * Handle map reset button click - clear highlighted record and reset map view
   */
  public onResetView() {
    // Clear immediately without debounce
    this.rowHover$.next(null);
    this.highlightedRecordId.set(null);
  }

  /**
   * Handle import completion - refresh data to show newly imported records
   */
  public onImportComplete(count: number) {
    // The data$ observable will automatically refresh when the route params change
    // For now, we can manually trigger a reload by navigating to the same route
    // This will cause the data$ observable to re-fetch
    window.location.reload();
  }

  /**
   * Navigate to detail page when calendar event is clicked
   */
  public onCalendarEventClick(event: CalendarEvent) {
    if (this.isSummaryView()) return;
    if (this.entityKey) {
      this.router.navigate(['/view', this.entityKey, event.id]);
    }
  }
  /**
   * Handle calendar date range changes (prev/next/view change)
   * The facade works out the view and focus date and shows the spinner at once; the URL then follows, and
   * the route maps it back to the same state, so one request goes out.
   */
  public onCalendarDateRangeChange(range: { start: Date; end: Date }) {
    const calendar = this.list?.setCalendarRange(range).calendar;
    if (!calendar) return;

    // Update URL query params with new calendar state (the date is the local date, not UTC)
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        cal_view: calendar.view,
        cal_date: calendar.date,
        page: 1  // Reset pagination when calendar navigates
      },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  /**
   * Start a new guidedForm instance.
   * Calls the start_guidedForm RPC and redirects to the edit page for the new parent record.
   * @since v0-48-0
   */
  public startGuidedForm(entity: SchemaEntityTable): void {
    const key = entity.guided_form_key;
    if (!key) {
      // Fallback to standard create
      this.router.navigate(['/create', entity.table_name]);
      return;
    }

    this.guidedForm.startGuidedForm(key).subscribe({
      next: (result) => {
        const parentId = result.parent_id;
        this.router.navigate(['/edit', entity.table_name, parentId]);
      },
      error: (err) => {
        const message = err?.error?.message || err?.message || 'An unexpected error occurred.';
        this.guidedFormErrorMessage.set(message);
        this.showGuidedFormError.set(true);
      }
    });
  }

  public closeGuidedFormError(): void {
    this.showGuidedFormError.set(false);
    this.guidedFormErrorMessage.set(undefined);
  }
}
