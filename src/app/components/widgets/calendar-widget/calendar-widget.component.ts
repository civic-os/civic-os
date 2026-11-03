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

import { Component, input, computed, inject, ChangeDetectionStrategy, signal, effect, DestroyRef, untracked } from '@angular/core';

import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval, map, Subscription, switchMap } from 'rxjs';
import { DashboardWidget, CalendarWidgetConfig } from '../../../interfaces/dashboard';
import { TimeSlotCalendarComponent, CalendarEvent } from '../../time-slot-calendar/time-slot-calendar.component';
import { DataService } from '../../../services/data.service';
import { SchemaService } from '../../../services/schema.service';
import { AuthService } from '../../../services/auth.service';
import { TranslationService } from '../../../services/translation.service';
import { EntityData, SchemaEntityProperty } from '../../../interfaces/entity';
import { DataQuery, FilterCriteria } from '../../../interfaces/query';
import { clampLimit } from '../../../utils/query-limits';
import { keyFilterMessage } from '../../../utils/key-filter-message';

/**
 * Calendar Widget Component
 *
 * Displays filtered entity records with time_slot columns on an interactive calendar.
 * Supports month/week/day views, filtering, color coding, and navigation to detail pages.
 *
 * Phase 2 implementation with auto-refresh and empty state handling.
 */
@Component({
  selector: 'app-calendar-widget',
  imports: [TimeSlotCalendarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './calendar-widget.component.html',
  styleUrl: './calendar-widget.component.css'
})
export class CalendarWidgetComponent {
  // Widget configuration from parent dashboard
  widget = input.required<DashboardWidget>();

  // Typed configuration (extract from JSONB config)
  config = computed<CalendarWidgetConfig>(() => {
    const cfg = this.widget().config as CalendarWidgetConfig;

    // Provide defaults for optional fields
    return {
      ...cfg,
      defaultColor: cfg.defaultColor ?? '#3B82F6',
      initialView: cfg.initialView ?? 'timeGridWeek',
      maxEvents: cfg.maxEvents ?? 1000,
      showCreateButton: cfg.showCreateButton ?? false,
      filters: cfg.filters ?? [],
      showColumns: cfg.showColumns ?? ['display_name']
    };
  });

  private dataService = inject(DataService);
  private schemaService = inject(SchemaService);
  private authService = inject(AuthService);
  private router = inject(Router);
  private translation = inject(TranslationService);
  private destroyRef = inject(DestroyRef);

  // Signals for component state
  events = signal<CalendarEvent[]>([]);
  isLoading = signal(true);
  initialLoading = signal(true); // True until first fetch completes, and again after a key filter failure (shows the error panel)
  error = signal<string | null>(null);
  dateRange = signal<{ start: Date; end: Date } | null>(null);
  hasCreatePermission = signal(false);

  // Track last fetch to prevent duplicate requests
  private lastFetchParams: string | null = null;
  // The fetch in flight. A newer fetch or destroy cancels it, so a stale response cannot
  // overwrite the events of a newer date range.
  private fetchSub: Subscription | null = null;

  // Whether to show the create button (config + permission check)
  canShowCreateButton = computed(() => {
    const config = this.config();
    return config.showCreateButton && this.hasCreatePermission();
  });

  // Computed signal for entity metadata
  private entityMetadata = computed(() => {
    const entityKey = this.widget().entity_key || this.config().entityKey;
    return { entityKey };
  });

  // Effect to fetch data when config or date range changes
  constructor() {
    this.destroyRef.onDestroy(() => this.fetchSub?.unsubscribe());

    effect(() => {
      const cfg = this.config();
      const metadata = this.entityMetadata();
      const range = this.dateRange();

      if (!metadata.entityKey || !cfg.timeSlotPropertyName) {
        this.fetchSub?.unsubscribe();
        this.lastFetchParams = null;
        this.events.set([]);
        this.isLoading.set(false);
        this.error.set('Missing required configuration: entityKey or timeSlotPropertyName');
        return;
      }

      // untracked: the effect depends on the three signals read above, not on the signals the
      // services read inside the fetch (getProperties() reads the entities signal while its cache
      // is cold, which would otherwise repeat the fetch when the schema finishes loading).
      untracked(() => this.fetchEvents());
    });

    // Setup auto-refresh if configured
    // CRITICAL: Use onCleanup to prevent multiple intervals running simultaneously
    effect((onCleanup) => {
      const refreshInterval = this.widget().refresh_interval_seconds;

      if (refreshInterval && refreshInterval > 0) {
        const subscription = interval(refreshInterval * 1000)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(() => {
            // A refresh repeats the current fetch on purpose, so it bypasses the duplicate check
            this.fetchEvents(true);
          });

        // Cleanup previous subscription when effect re-runs
        onCleanup(() => subscription.unsubscribe());
      }
    });

    // Check CREATE permission when entity changes
    effect(() => {
      const entityKey = this.widget().entity_key || this.config().entityKey;

      if (!entityKey) {
        this.hasCreatePermission.set(false);
        return;
      }

      // Check permission asynchronously
      this.checkCreatePermission(entityKey);
    });
  }

  /**
   * Check if user has CREATE permission on the entity
   */
  private checkCreatePermission(entityKey: string): void {
    this.hasCreatePermission.set(this.authService.hasPermission(entityKey, 'create'));
  }

  /**
   * Fetch events from the database based on current configuration and date range
   */
  private fetchEvents(force = false): void {
    const cfg = this.config();
    const metadata = this.entityMetadata();
    const range = this.dateRange();

    // The calendar reports its visible range once it renders. Fetching before that would load up
    // to maxEvents rows from any date, only to be replaced by the ranged fetch moments later.
    if (!range) {
      return;
    }

    // Create a unique key for this fetch to prevent duplicate requests
    const fetchKey = JSON.stringify({
      entity: metadata.entityKey,
      timeSlot: cfg.timeSlotPropertyName,
      range: { start: range.start.toISOString(), end: range.end.toISOString() },
      filters: cfg.filters
    });

    // Skip if we're already fetching with these exact parameters
    if (!force && this.lastFetchParams === fetchKey) {
      return;
    }

    this.lastFetchParams = fetchKey;
    this.fetchSub?.unsubscribe();
    const load = new Subscription();
    this.fetchSub = load;
    this.isLoading.set(true);
    this.error.set(null);

    // First fetch properties to build proper select strings and resolve key filters
    load.add(this.schemaService.getProperties().pipe(
      switchMap((allProps: SchemaEntityProperty[]) => {
        const entityProps = allProps.filter(p => p.table_name === metadata.entityKey);
        return this.schemaService.resolveWidgetFilters(cfg.filters, entityProps).pipe(
          map(resolvedFilters => ({ entityProps, resolvedFilters }))
        );
      })
    ).subscribe({
      next: ({ entityProps, resolvedFilters }) => {
        // Build columns to fetch: id, display_name, time_slot, color (if configured), show columns
        const columnNames = [
          'id',
          'display_name',
          cfg.timeSlotPropertyName,
          ...(cfg.colorProperty ? [cfg.colorProperty] : []),
          ...(cfg.showColumns || [])
        ];
        const uniqueColumns = [...new Set(columnNames)];

        // Filter properties and build select strings
        const propsToSelect = entityProps.filter(p => uniqueColumns.includes(p.column_name));
        const columns = propsToSelect.map(p => SchemaService.propertyToSelectString(p));

        // Build filters: combine static filters + date range filter
        const filters: FilterCriteria[] = [...resolvedFilters];

        // Date range filter (overlap operator for tstzrange), format [start,end) in ISO
        filters.push({
          column: cfg.timeSlotPropertyName,
          operator: 'ov',
          value: `[${range.start.toISOString()},${range.end.toISOString()})`
        });

        // Build query with proper select strings
        const query: DataQuery = {
          key: metadata.entityKey,
          fields: columns,
          filters,
          limit: clampLimit(cfg.maxEvents)
        };

        // Fetch filtered data
        load.add(this.dataService.getData(query).subscribe({
          next: (response: EntityData[]) => {
            this.events.set(this.transformToEvents(response, cfg));
            this.isLoading.set(false);
            this.initialLoading.set(false);
          },
          error: (err: any) => {
            console.error('Calendar widget error:', err);
            this.error.set(err.message || 'Failed to load calendar events');
            this.events.set([]);
            this.isLoading.set(false);
            this.initialLoading.set(false);
          }
        }));
      },
      error: (err: any) => {
        console.error('Error loading properties:', err);
        const keyFilterError = keyFilterMessage(err, this.translation);
        this.error.set(keyFilterError ?? 'Failed to load schema');
        this.isLoading.set(false);
        if (keyFilterError) {
          // The template shows an error only in the initial loading state, so return to it. A later
          // fetch must not be skipped as a duplicate, or a failed lookup would stay until the date
          // range changes.
          this.events.set([]);
          this.initialLoading.set(true);
          this.lastFetchParams = null;
        } else {
          this.initialLoading.set(false);
        }
      }
    }));
  }

  /**
   * Transform entity records to CalendarEvent format
   */
  private transformToEvents(records: any[], config: CalendarWidgetConfig): CalendarEvent[] {
    if (!records || records.length === 0) {
      return [];
    }

    const timeSlotField = config.timeSlotPropertyName;
    const colorField = config.colorProperty;

    return records
      .filter(record => record[timeSlotField]) // Filter out records without time_slot
      .map(record => {
        const { start, end } = this.parseTimeSlot(record[timeSlotField]);

        return {
          id: record.id,
          title: record.display_name || `Record ${record.id}`,
          start,
          end,
          color: (colorField && record[colorField] != null) ? record[colorField] : config.defaultColor,
          extendedProps: { data: record }
        };
      });
  }

  /**
   * Parse PostgreSQL tstzrange to start/end dates
   * Format: ["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")
   */
  private parseTimeSlot(tstzrange: string): { start: Date; end: Date } {
    try {
      const match = tstzrange.match(/\["?(.+?)"?,"?(.+?)"?\)/);
      if (!match) {
        throw new Error(`Invalid tstzrange format: ${tstzrange}`);
      }

      return {
        start: new Date(match[1]),
        end: new Date(match[2])
      };
    } catch (err) {
      console.error('Error parsing time slot:', err);
      // Return placeholder dates to prevent crash
      return {
        start: new Date(),
        end: new Date()
      };
    }
  }

  /**
   * Handle event click - open detail page in new tab
   */
  onEventClick(event: CalendarEvent): void {
    const entityKey = this.widget().entity_key || this.config().entityKey;
    const url = this.router.serializeUrl(
      this.router.createUrlTree(['/view', entityKey, event.id])
    );
    window.open(url, '_blank');
  }

  /**
   * Handle date range change - update filter and refetch
   */
  onDateRangeChange(range: { start: Date; end: Date }): void {
    // Show loading spinner and clear old events immediately to prevent visual glitch
    // (prevents showing old events in new date range during fetch)
    this.isLoading.set(true);
    this.events.set([]);
    this.dateRange.set(range);
  }

  /**
   * Handle create button click - navigate to create page
   */
  onCreateClick(): void {
    const entityKey = this.widget().entity_key || this.config().entityKey;
    this.router.navigate(['/create', entityKey]);
  }

  /**
   * Get display name for entity (for create button label)
   */
  getEntityDisplayName(): string {
    const entityKey = this.widget().entity_key || this.config().entityKey;
    // Capitalize and convert underscores to spaces
    return entityKey
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
