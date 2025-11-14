/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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

import { Component, inject, ChangeDetectionStrategy, signal, OnInit, OnDestroy, computed, DestroyRef } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { Observable, Subject, map, mergeMap, of, combineLatest, debounceTime, distinctUntilChanged, take, tap, switchMap, from, forkJoin, BehaviorSubject, concat } from 'rxjs';
import { SchemaService } from '../../services/schema.service';
import { CommonModule } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { DataService } from '../../services/data.service';
import { AnalyticsService } from '../../services/analytics.service';
import { EntityPropertyType, SchemaEntityProperty, SchemaEntityTable } from '../../interfaces/entity';
import { DisplayPropertyComponent } from '../../components/display-property/display-property.component';
import { FilterBarComponent } from '../../components/filter-bar/filter-bar.component';
import { PaginationComponent } from '../../components/pagination/pagination.component';
import { GeoPointMapComponent, MapMarker } from '../../components/geo-point-map/geo-point-map.component';
import { TimeSlotCalendarComponent, CalendarEvent } from '../../components/time-slot-calendar/time-slot-calendar.component';
import { ImportExportButtonsComponent } from '../../components/import-export-buttons/import-export-buttons.component';
import { FilterCriteria } from '../../interfaces/query';

interface FilterChip {
  column: string;
  columnLabel: string;
  operator: string;
  value: any;
  displayValue: string;
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
    TimeSlotCalendarComponent,
    ImportExportButtonsComponent
]
})
export class ListPage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private schema = inject(SchemaService);
  private data = inject(DataService);
  private analytics = inject(AnalyticsService);
  private destroyRef = inject(DestroyRef);

  // Pagination constants
  private readonly PAGE_SIZE_STORAGE_KEY = 'civic_os_list_page_size';
  private readonly DEFAULT_PAGE_SIZE = 25;

  public entityKey?: string;
  public searchControl = new FormControl('');
  public isLoading = signal<boolean>(false);

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

  public properties$: Observable<SchemaEntityProperty[]> = this.entity$.pipe(switchMap(e => {
    if(e) {
      let props = this.schema.getPropsForList(e);
      return props;
    } else {
      return of([]);
    }
  }));

  // Properties for display - excludes map property if hidden from list
  public displayProperties$: Observable<SchemaEntityProperty[]> = this.properties$.pipe(
    map(props => props.filter(p => p.show_on_list !== false))
  );

  public filterProperties$: Observable<SchemaEntityProperty[]> = this.entity$.pipe(switchMap(e => {
    if(e) {
      return this.schema.getPropsForFilter(e);
    } else {
      return of([]);
    }
  }));

  // Derive filters from URL query params
  public filters$: Observable<FilterCriteria[]> = this.route.queryParams.pipe(
    map(params => {
      const filters: FilterCriteria[] = [];
      let index = 0;
      while (params[`f${index}_col`]) {
        filters.push({
          column: params[`f${index}_col`],
          operator: params[`f${index}_op`],
          value: params[`f${index}_val`]
        });
        index++;
      }
      return filters;
    })
  );

  // Derive sort state from URL query params
  public sortState$: Observable<{ column: string | null, direction: 'asc' | 'desc' | null }> =
    this.route.queryParams.pipe(
      map(params => ({
        column: params['sort'] || null,
        direction: (params['dir'] as 'asc' | 'desc') || null
      }))
    );

  // Derive search query from URL query params
  public searchQuery$: Observable<string> = this.route.queryParams.pipe(
    map(params => params['q'] || '')
  );

  // Derive pagination from URL query params
  public pagination$: Observable<{ page: number, pageSize: number }> = this.route.queryParams.pipe(
    map(params => ({
      page: params['page'] ? parseInt(params['page'], 10) : 1,
      pageSize: params['pageSize'] ? parseInt(params['pageSize'], 10) : this.getStoredPageSize()
    }))
  );

  // Derive calendar state from URL query params
  // IMPORTANT: Declared before data$ so it's available when data$ references it in combineLatest
  public calendarState$: Observable<{ view: string; date: string } | null> =
    this.route.queryParams.pipe(
      map(params => {
        // Only return state if cal_view and cal_date are present
        if (params['cal_view'] && params['cal_date']) {
          return {
            view: params['cal_view'],
            date: params['cal_date']
          };
        }
        // Default to "this week" if no params (but only if entity shows calendar)
        // We can't check entity here since it's not available yet, so return null
        // and handle default in the template/component
        return null;
      })
    );

  public data$: Observable<any> = this.route.params.pipe(
    // switchMap cancels previous subscription when params change
    switchMap(p => {
      // Wait for query param clearing to complete before proceeding
      if (this.entityKey && this.entityKey !== p['entityKey']) {
        this.entityKey = p['entityKey'];
        // Convert Promise to Observable and wait for navigation to complete
        return from(
          this.router.navigate([], {
            relativeTo: this.route,
            queryParams: {},
            replaceUrl: true
          })
        ).pipe(
          // After navigation completes, return the params
          map(() => p)
        );
      } else {
        this.entityKey = p['entityKey'];
        // No navigation needed, just continue
        return of(p);
      }
    }),
    switchMap(p => {
      if (!p['entityKey']) return of([]);

      // Now derive everything from the current route state
      return combineLatest([
        this.schema.getEntity(p['entityKey']),
        this.schema.getEntity(p['entityKey']).pipe(
          switchMap(e => e ? this.schema.getPropsForList(e) : of([]))
        ),
        this.searchQuery$,
        this.sortState$,
        this.filters$,
        this.pagination$,
        this.calendarState$
      ]).pipe(
        // Batch synchronous emissions during initialization
        debounceTime(0),
        // Skip emissions when values haven't actually changed
        distinctUntilChanged((prev, curr) => {
          const [prevEntity, prevProps, prevSearch, prevSort, prevFilters, prevPagination, prevCalendarState] = prev;
          const [currEntity, currProps, currSearch, currSort, currFilters, currPagination, currCalendarState] = curr;

          return prevEntity?.table_name === currEntity?.table_name &&
                 prevProps?.length === currProps?.length &&
                 prevSearch === currSearch &&
                 prevSort?.column === currSort?.column &&
                 prevSort?.direction === currSort?.direction &&
                 JSON.stringify(prevFilters) === JSON.stringify(currFilters) &&
                 prevPagination?.page === currPagination?.page &&
                 prevPagination?.pageSize === currPagination?.pageSize &&
                 JSON.stringify(prevCalendarState) === JSON.stringify(currCalendarState);
        }),
        tap(() => this.isLoading.set(true)),
        switchMap(([entity, props, search, sortState, filters, pagination, calendarState]) => {
          if (props && props.length > 0 && p['entityKey']) {
            let columns = props
              .map(x => SchemaService.propertyToSelectString(x));

            // Add calendar color property to select fields if configured
            if (entity?.calendar_color_property && !columns.includes(entity.calendar_color_property)) {
              columns.push(entity.calendar_color_property);
            }

            // Build order field for PostgREST
            let orderField: string | undefined = undefined;
            if (sortState.column && sortState.direction) {
              const sortProperty = props.find(p => p.column_name === sortState.column);
              if (sortProperty) {
                orderField = this.buildOrderField(sortProperty);
              }
            }

            // Filter out any filters that don't match current entity's columns
            const validColumnNames = props.map(p => p.column_name);
            let validFilters = filters.filter(f => validColumnNames.includes(f.column));

            // Add calendar date range filter if calendar is shown and state is set
            if (entity?.show_calendar && entity?.calendar_property_name && calendarState) {
              const range = this.calculateDateRange(calendarState.view, calendarState.date);
              validFilters = [
                ...validFilters,
                {
                  column: entity.calendar_property_name,
                  operator: 'ov',
                  value: `[${range.start.toISOString()},${range.end.toISOString()})`
                }
              ];
            }

            // When calendar is active, use larger page size to show all events in range
            const effectivePagination = (entity?.show_calendar && calendarState)
              ? { page: 1, pageSize: 1000 }
              : pagination;

            // Only apply search if entity has search_fields defined
            const validSearch = (entity && entity.search_fields && entity.search_fields.length > 0)
              ? search
              : undefined;

            // CRITICAL: Emit empty dataset first (synchronous), then fetch real data (async)
            // This prevents stale data flash when entity changes by immediately resetting toSignal()
            return concat(
              of({ data: [], totalCount: 0 }),
              this.data.getDataPaginated({
                key: p['entityKey'],
                fields: columns,
                searchQuery: validSearch || undefined,
                orderField: orderField,
                orderDirection: sortState.direction || undefined,
                filters: validFilters && validFilters.length > 0 ? validFilters : undefined,
                pagination: effectivePagination
              })
            );
          } else {
            return of({ data: [], totalCount: 0 });
          }
        }),
        tap(() => this.isLoading.set(false))
      );
    })
  );

  // Convert data$ observable to signal for use in computed
  private dataWithCount = toSignal(this.data$, { initialValue: { data: [], totalCount: 0 } });

  // Derive data and pagination state from observables
  public dataSignal = computed(() => this.dataWithCount().data);
  public totalCount = computed(() => this.dataWithCount().totalCount);

  // Convert observables to signals for template use
  public sortStateSignal = toSignal(this.sortState$, {
    initialValue: { column: null, direction: null }
  });

  public filtersSignal = toSignal(this.filters$, { initialValue: [] });

  // Derive pagination signals from pagination$ observable
  private paginationState = toSignal(this.pagination$, {
    initialValue: { page: 1, pageSize: this.getStoredPageSize() }
  });
  public currentPage = computed(() => this.paginationState().page);
  public pageSize = computed(() => this.paginationState().pageSize);

  // Signal for filterable properties (used in filter preservation logic)
  private filterablePropertiesSignal = toSignal(this.filterProperties$, { initialValue: [] });

  // Extract search terms for highlighting
  private searchTerms$: Observable<string[]> = this.searchQuery$.pipe(
    map(query => {
      if (!query || !query.trim()) return [];
      return query.trim().split(/\s+/).filter(term => term.length > 0);
    })
  );
  public searchTerms = toSignal(this.searchTerms$, { initialValue: [] });

  // Check if any filtering is active (filters or search)
  private isFiltered$ = combineLatest([this.filters$, this.searchQuery$]).pipe(
    map(([filters, search]) => filters.length > 0 || (search && search.trim().length > 0))
  );
  public isFiltered = toSignal(this.isFiltered$, { initialValue: false });

  // Count of search results (use totalCount for paginated results)
  public resultCount = computed(() => this.totalCount());

  // Map-related signals
  public highlightedRecordId = signal<number | null>(null);

  // Convert entity$ to signal for map configuration
  private entitySignal = toSignal(this.entity$);

  // Check if map should be shown
  public showMap = computed(() => {
    const entity = this.entitySignal();
    return entity?.show_map && entity?.map_property_name;
  });

  // Build map markers from current page data
  public mapMarkers = computed(() => {
    const entity = this.entitySignal();
    const data = this.dataSignal();

    if (!entity?.show_map || !entity?.map_property_name || !data || data.length === 0) {
      return [];
    }

    const mapProperty = entity.map_property_name;
    // PostgREST returns geography as 'property:property_text' which aliases to just 'property'
    // So we access row[mapProperty] directly, NOT row[mapProperty + '_text']

    const markers = data
      .filter((row: any) => !!row[mapProperty])
      .map((row: any) => ({
        id: row.id,
        name: row.display_name || `${entity.display_name} #${row.id}`,
        wkt: row[mapProperty]
      } as MapMarker));

    return markers;
  });

  // Calendar-related signals
  // Check if calendar should be shown
  public showCalendar = computed(() => {
    const entity = this.entitySignal();
    return entity?.show_calendar && entity?.calendar_property_name;
  });

  // Build calendar events from main data
  public calendarEvents = computed(() => {
    const entity = this.entitySignal();
    const data = this.dataSignal();

    if (!entity?.show_calendar || !entity?.calendar_property_name || !data || data.length === 0) {
      return [];
    }

    const dateProp = entity.calendar_property_name;
    const colorProp = entity.calendar_color_property;

    const events = data
      .filter((row: any) => !!row[dateProp])
      .map((row: any) => {
        const rawValue = row[dateProp];
        const { start, end } = this.parseTimeSlot(rawValue);

        const colorValue = colorProp && row[colorProp] ? row[colorProp] : '#3B82F6';

        return {
          id: row.id,
          title: row.display_name || `${entity.display_name} #${row.id}`,
          start: start,
          end: end,
          color: colorValue,
          extendedProps: { data: row }
        } as CalendarEvent;
      });

    return events;
  });

  // Build filter chips with compact format
  // Range filters (gte+lte pairs) are merged into single chips
  public filterChips$: Observable<FilterChip[]> = combineLatest([
    this.filters$,
    this.displayProperties$
  ]).pipe(
    map(([filters, props]) => {
      if (filters.length === 0) return [];

      // Group filters by column
      const columnGroups = new Map<string, FilterCriteria[]>();
      filters.forEach(filter => {
        if (!columnGroups.has(filter.column)) {
          columnGroups.set(filter.column, []);
        }
        columnGroups.get(filter.column)!.push(filter);
      });

      // Build chips, merging range filters
      const chips: FilterChip[] = [];

      columnGroups.forEach((filtersForColumn, column) => {
        const prop = props.find(p => p.column_name === column);
        const columnLabel = prop?.display_name || column;

        // Check if this is a range filter (has gte and/or lte)
        const gteFilter = filtersForColumn.find(f => f.operator === 'gte');
        const lteFilter = filtersForColumn.find(f => f.operator === 'lte');

        if (gteFilter && lteFilter) {
          // Both min and max - show as range
          const displayValue = `${gteFilter.value} - ${lteFilter.value}`;
          chips.push({
            column,
            columnLabel,
            operator: 'range',
            value: { min: gteFilter.value, max: lteFilter.value },
            displayValue
          });
        } else if (gteFilter) {
          // Min only
          const displayValue = `≥ ${gteFilter.value}`;
          chips.push({
            column,
            columnLabel,
            operator: 'gte',
            value: gteFilter.value,
            displayValue
          });
        } else if (lteFilter) {
          // Max only
          const displayValue = `≤ ${lteFilter.value}`;
          chips.push({
            column,
            columnLabel,
            operator: 'lte',
            value: lteFilter.value,
            displayValue
          });
        } else {
          // Not range filters - handle each individually
          filtersForColumn.forEach(filter => {
            // For FK and User filters with 'in' operator, show count
            if ((prop?.type === EntityPropertyType.ForeignKeyName || prop?.type === EntityPropertyType.User)
                && filter.operator === 'in') {
              // Parse "(1,2,3)" format to count items
              const match = filter.value.match(/\(([^)]+)\)/);
              const count = match ? match[1].split(',').length : 1;
              const displayValue = count === 1 ? '1 selected' : `${count} selected`;

              chips.push({
                column: filter.column,
                columnLabel,
                operator: filter.operator,
                value: filter.value,
                displayValue
              });
            } else if (prop?.type === EntityPropertyType.Boolean) {
              // Format boolean values
              const displayValue = filter.value === 'true' ? 'Yes' : 'No';
              chips.push({
                column: filter.column,
                columnLabel,
                operator: filter.operator,
                value: filter.value,
                displayValue
              });
            } else {
              // For other types, use the raw value
              chips.push({
                column: filter.column,
                columnLabel,
                operator: filter.operator,
                value: filter.value,
                displayValue: String(filter.value)
              });
            }
          });
        }
      });

      return chips;
    })
  );

  ngOnInit() {
    // Sync searchControl with URL query params (bidirectional)
    // URL → searchControl
    this.searchQuery$
      .pipe(takeUntilDestroyed(this.destroyRef))
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
    // Clean up Subject
    this.rowHover$.complete();
  }

  public onFiltersChange(filters: FilterCriteria[]) {
    // Get current filters from URL
    const currentFilters = this.filtersSignal();

    let allFilters: FilterCriteria[];

    if (filters.length === 0) {
      // FilterBar is clearing all filterable columns
      // Preserve only non-filterable column filters (e.g., from Related Records)
      const filterableProps = this.filterablePropertiesSignal();
      const filterableColumns = new Set(filterableProps.map(p => p.column_name));
      allFilters = currentFilters.filter(f => !filterableColumns.has(f.column));
    } else {
      // FilterBar is updating specific columns
      // Get columns that FilterBar is explicitly updating
      const updatedColumns = new Set(filters.map(f => f.column));

      // Preserve filters for columns NOT being updated by FilterBar
      // This handles filters from Related Records or other sources that FilterBar doesn't know about
      const preservedFilters = currentFilters.filter(f => !updatedColumns.has(f.column));

      // Combine preserved filters with new filters from FilterBar
      allFilters = [...preservedFilters, ...filters];
    }

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

  public removeFilter(columnToRemove: string) {
    const currentFilters = this.filtersSignal();
    const newFilters = currentFilters.filter(f => f.column !== columnToRemove);

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
   * Builds the PostgREST order field string.
   * For FK and User columns, orders by the related entity's display_name.
   * For regular columns, uses the column name directly.
   */
  private buildOrderField(property: SchemaEntityProperty): string {
    // For foreign key columns, order by the embedded resource's display_name
    // The embedded resource name is the column name (without _id suffix for FKs)
    if (property.type === EntityPropertyType.ForeignKeyName) {
      return `${property.column_name}(display_name)`;
    }

    // For user columns, order by the embedded user's display_name
    // User columns are embedded as: column_name:civic_os_users!column_name(...)
    if (property.type === EntityPropertyType.User) {
      return `${property.column_name}(display_name)`;
    }

    // For regular columns, use the column name
    return property.column_name;
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
   * Get stored page size from localStorage
   */
  private getStoredPageSize(): number {
    const stored = localStorage.getItem(this.PAGE_SIZE_STORAGE_KEY);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return this.DEFAULT_PAGE_SIZE;
  }

  /**
   * Store page size to localStorage
   */
  private storePageSize(pageSize: number) {
    localStorage.setItem(this.PAGE_SIZE_STORAGE_KEY, pageSize.toString());
  }

  /**
   * Handle marker click - scroll to and highlight the corresponding row
   */
  public onMarkerClick(recordId: number) {
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
    this.rowHover$.next(recordId);
  }

  /**
   * Handle keyboard navigation on table rows
   */
  public onRowKeyPress(event: KeyboardEvent, recordId: number) {
    // Prevent default scrolling behavior for space key
    event.preventDefault();
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
    if (this.entityKey) {
      this.router.navigate(['/view', this.entityKey, event.id]);
    }
  }

  /**
   * Handle calendar date range changes (prev/next/view change)
   * Updates URL query params which triggers main data$ observable to refetch
   */
  public onCalendarDateRangeChange(range: { start: Date; end: Date }) {

    // Infer calendar view from range duration
    const durationDays = Math.round((range.end.getTime() - range.start.getTime()) / (1000 * 60 * 60 * 24));

    let view: string;
    let focusDate: Date;

    if (durationDays <= 1) {
      view = 'timeGridDay';
      focusDate = range.start;
    } else if (durationDays <= 7) {
      view = 'timeGridWeek';
      focusDate = range.start;
    } else {
      // Month view: range includes overflow days, find the 1st of the featured month
      view = 'dayGridMonth';

      // The featured month is the month containing the midpoint of the range
      const midpoint = new Date((range.start.getTime() + range.end.getTime()) / 2);
      focusDate = new Date(midpoint.getFullYear(), midpoint.getMonth(), 1);
    }

    // Update URL query params with new calendar state
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        cal_view: view,
        cal_date: focusDate.toISOString().split('T')[0], // YYYY-MM-DD
        page: 1  // Reset pagination when calendar navigates
      },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });

    // Data will automatically refetch due to combineLatest observing route.queryParams
  }

  /**
   * Parse tstzrange string to Date objects
   */
  private parseTimeSlot(tstzrange: string): { start: Date; end: Date } {
    // Parse: ["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")
    // Note: PostgreSQL returns tstzrange with escaped quotes in JSON
    const match = tstzrange.match(/\["?([^",]+)"?,\s*"?([^")]+)"?\)/);
    if (!match) {
      // Return empty dates if parsing fails
      return { start: new Date(), end: new Date() };
    }
    return {
      start: new Date(match[1]),
      end: new Date(match[2])
    };
  }

  /**
   * Get ISO date string for the start of this week (Sunday)
   * Used as default when no calendar URL params are present
   */
  private getThisWeekStartDate(): string {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const sunday = new Date(now);
    sunday.setDate(now.getDate() - dayOfWeek);
    return sunday.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  /**
   * Calculate date range from calendar view and focus date
   * Mirrors FullCalendar's range calculation logic
   */
  private calculateDateRange(view: string, dateStr: string): { start: Date; end: Date } {
    const date = new Date(dateStr + 'T00:00:00'); // Ensure consistent parsing in local timezone

    if (view === 'timeGridDay') {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(24, 0, 0, 0);
      return { start, end };
    } else if (view === 'timeGridWeek') {
      const start = new Date(date);
      const dayOfWeek = start.getDay();
      start.setDate(start.getDate() - dayOfWeek); // Go to Sunday
      start.setHours(0, 0, 0, 0);

      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      return { start, end };
    } else if (view === 'dayGridMonth') {
      // For month view, extend to surrounding weeks to show complete weeks
      const start = new Date(date.getFullYear(), date.getMonth(), 1);
      start.setDate(start.getDate() - start.getDay()); // Go back to Sunday
      start.setHours(0, 0, 0, 0);

      const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      const end = new Date(lastDayOfMonth);
      end.setDate(end.getDate() + (6 - end.getDay()) + 1); // Go forward to Saturday + 1

      return { start, end };
    }

    // Fallback
    return { start: date, end: date };
  }
}
