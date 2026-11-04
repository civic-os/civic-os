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

import { Component, input, computed, inject, ChangeDetectionStrategy, signal, effect, untracked } from '@angular/core';

import { Router, RouterLink } from '@angular/router';
import { DashboardWidget, FilteredListWidgetConfig } from '../../../interfaces/dashboard';
import { DisplayPropertyComponent } from '../../display-property/display-property.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { DataService } from '../../../services/data.service';
import { SchemaService } from '../../../services/schema.service';
import { SchemaEntityProperty, EntityData } from '../../../interfaces/entity';
import { DataQuery } from '../../../interfaces/query';
import { clampLimit, MAX_LIMIT } from '../../../utils/query-limits';
import { listQueryParams } from '../../../sdk/list-url';
import { FilterCriteria } from '@civic-os/core';
import { TranslationService } from '../../../services/translation.service';
import { keyFilterMessage } from '../../../utils/key-filter-message';
import { map, Subscription, switchMap } from 'rxjs';

/**
 * Filtered List Widget Component
 *
 * Displays filtered entity records in a compact table format.
 * Clicking a row navigates to the detail page.
 *
 * Phase 2 implementation - basic functionality without auto-refresh.
 */
import { LoadingIndicatorComponent } from '../../loading-indicator/loading-indicator.component';
@Component({
  selector: 'app-filtered-list-widget',
  imports: [LoadingIndicatorComponent, DisplayPropertyComponent, RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './filtered-list-widget.component.html',
  styleUrl: './filtered-list-widget.component.css'
})
export class FilteredListWidgetComponent {
  // Widget configuration from parent dashboard
  widget = input.required<DashboardWidget>();

  // Typed configuration (extract from JSONB config)
  config = computed<FilteredListWidgetConfig>(() => {
    const cfg = this.widget().config as FilteredListWidgetConfig;

    // Provide defaults for optional fields
    return {
      ...cfg,
      filters: cfg.filters ?? [],
      orderBy: cfg.orderBy ?? 'id',
      orderDirection: cfg.orderDirection ?? 'desc',
      limit: cfg.limit ?? 10,
      showColumns: cfg.showColumns ?? ['display_name'],
      showSeeMore: cfg.showSeeMore ?? true
    };
  });

  private dataService = inject(DataService);
  private schemaService = inject(SchemaService);
  private router = inject(Router);
  private translation = inject(TranslationService);

  // Signals for component state
  isLoading = signal(true);
  error = signal<string | null>(null);
  properties = signal<SchemaEntityProperty[]>([]);
  records = signal<any[]>([]);
  /** A row beyond `limit` came back, so the list page holds more than the widget shows. */
  hasMore = signal(false);
  /** The filters as sent to the API (key filters resolved to ids), for the "See more" link. */
  private resolvedFilters = signal<FilterCriteria[]>([]);

  /** Text for the empty state: the integrator's `emptyMessage` (translated by the database) or the neutral default. */
  emptyText = computed<string>(() => this.config().emptyMessage?.trim() || this.translation.get('dashboard.empty_default'));

  resultCountText = computed<string>(() => {
    const count = this.records().length;
    return this.translation.get(count === 1 ? 'dashboard.results_one' : 'dashboard.results_other', { count });
  });

  /** Router target of the "See more" link, or null when it is off or nothing is hidden. */
  seeMoreLink = computed<{ commands: string[]; queryParams: Record<string, any> } | null>(() => {
    const cfg = this.config();
    const key = this.entityKey();
    if (!cfg.showSeeMore || !this.hasMore() || !key) return null;
    return {
      commands: ['/view', key],
      queryParams: listQueryParams({ filters: this.resolvedFilters(), orderBy: cfg.orderBy, orderDirection: cfg.orderDirection })
    };
  });

  // Computed signal for query parameters (derives from input signals)
  // Note: fields will be populated in the effect after fetching properties
  private queryParams = computed(() => {
    const cfg = this.config();
    const entityKey = this.widget().entity_key;

    if (!entityKey) {
      return null;
    }

    // Build query object (fields added in effect)
    return {
      key: entityKey,
      fields: [], // Populated in effect using propertyToSelectString
      filters: cfg.filters,
      orderField: cfg.orderBy,
      orderDirection: cfg.orderDirection as 'asc' | 'desc' | undefined
    } as DataQuery;
  });

  // Effect to fetch data and properties when query params change
  constructor() {
    effect((onCleanup) => {
      const params = this.queryParams();
      const cfg = this.config();

      if (!params) {
        this.records.set([]);
        this.hasMore.set(false);
        this.isLoading.set(false);
        return;
      }

      this.isLoading.set(true);
      this.error.set(null);

      // Holds this run's requests: a re-run or destroy cancels them, so a stale response
      // can never overwrite the rows of a newer load.
      const load = new Subscription();
      onCleanup(() => load.unsubscribe());

      // untracked: the services read signals of their own (getProperties() reads the entities
      // signal while its cache is cold). Tracked, they would re-run this effect when the schema
      // finishes loading and send every widget's request twice.
      // First fetch properties to build proper select strings and resolve key filters
      untracked(() => load.add(this.schemaService.getProperties().pipe(
        switchMap((allProps: SchemaEntityProperty[]) => {
          const entityProps = allProps.filter(p => p.table_name === params.key);
          return this.schemaService.resolveWidgetFilters(cfg.filters, entityProps).pipe(
            map(filters => ({ entityProps, filters }))
          );
        })
      ).subscribe({
        next: ({ entityProps, filters }) => {
          this.properties.set(entityProps);

          // Build select strings using propertyToSelectString for proper foreign key expansion
          const showCols = cfg.showColumns || [];
          const propsToSelect = entityProps.filter(p =>
            p.column_name === 'id' || showCols.includes(p.column_name)
          );
          const columns = propsToSelect.map(p => SchemaService.propertyToSelectString(p));

          // Ask for one row more than is shown: the extra row is the only overflow signal needed (no count query).
          // The API caps a request at MAX_LIMIT, so a limit at the cap cannot detect overflow and shows no link.
          const displayLimit = clampLimit(cfg.limit);
          const fetchLimit = displayLimit === undefined ? undefined : Math.min(displayLimit + 1, MAX_LIMIT);
          this.resolvedFilters.set(filters);

          const query: DataQuery = {
            ...params,
            fields: columns,
            filters,
            limit: fetchLimit
          };

          // Fetch filtered data with proper column expansion
          load.add(this.dataService.getData(query).subscribe({
            next: (response: EntityData[]) => {
              const overflow = displayLimit !== undefined && response.length > displayLimit;
              this.records.set(overflow ? response.slice(0, displayLimit) : response);
              this.hasMore.set(overflow);
              this.isLoading.set(false);
            },
            error: (err: any) => {
              console.error('Filtered list widget error:', err);
              this.error.set(this.translation.get('dashboard.error_load_data'));
              this.records.set([]);
              this.hasMore.set(false);
              this.isLoading.set(false);
            }
          }));
        },
        error: (err: any) => {
          console.error('Error loading properties:', err);
          this.error.set(keyFilterMessage(err, this.translation) ?? this.translation.get('dashboard.error_load_schema'));
          this.records.set([]);
          this.hasMore.set(false);
          this.isLoading.set(false);
        }
      })));
    });
  }

  /**
   * Get property metadata for a column
   */
  getProperty(columnName: string): SchemaEntityProperty | undefined {
    return this.properties().find(p => p.column_name === columnName);
  }

  /**
   * Entity key used for detail-page navigation (from widget or config).
   */
  entityKey = computed<string>(() => this.widget().entity_key || (this.config() as any).entityKey);

  /**
   * Navigate to detail page when row is clicked (mouse convenience).
   * Keyboard users use the real first-cell link instead of the row.
   */
  onRowClick(recordId: number): void {
    this.router.navigate(['/view', this.entityKey(), recordId]);
  }

  /**
   * Get display label for column
   */
  getColumnLabel(columnName: string): string {
    const property = this.getProperty(columnName);
    return property?.display_name || columnName;
  }
}
