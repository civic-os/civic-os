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

import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import {
  SeriesGroup,
  SeriesInstance,
  SeriesMembership,
  ConflictInfo,
  CreateSeriesResult,
  RRuleConfig
} from '../interfaces/entity';
import { getPostgrestUrl } from '../config/runtime';

/**
 * Parameters for creating a new recurring series.
 */
export interface CreateSeriesParams {
  groupName: string;
  groupDescription?: string;
  groupColor?: string;
  entityTable: string;
  entityTemplate: Record<string, any>;
  rrule: string;
  dtstart: string;  // ISO timestamp
  duration: string; // ISO 8601 duration or PostgreSQL interval
  timezone?: string;
  timeSlotProperty?: string;
  expandNow?: boolean;
  skipConflicts?: boolean;
}

/**
 * Parameters for previewing conflicts before creating a series.
 */
export interface PreviewConflictsParams {
  entityTable: string;
  scopeColumn: string;      // e.g., 'resource_id'
  scopeValue: string;       // e.g., '5'
  timeSlotColumn: string;   // e.g., 'time_slot'
  occurrences: Array<[string, string]>;  // Array of [start, end] ISO timestamps
}

/**
 * Parameters for splitting a series ("edit this and future").
 */
export interface SplitSeriesParams {
  seriesId: number;
  splitDate: string;        // ISO date
  newDtstart: string;       // ISO timestamp
  newDuration?: string;
  newTemplate?: Record<string, any>;
}

/**
 * Service for managing recurring time slot series.
 * Provides API for creating, viewing, and managing recurring schedules.
 *
 * Added in v0.19.0.
 */
@Injectable({
  providedIn: 'root'
})
export class RecurringService {
  private http = inject(HttpClient);

  // ============================================================================
  // SERIES MEMBERSHIP
  // ============================================================================

  /**
   * Check if an entity record is part of a recurring series.
   * Call this on Detail/Edit pages to determine if scope dialogs should appear.
   *
   * @param entityTable Table name (e.g., 'reservations')
   * @param entityId Entity record ID
   * @returns Observable<SeriesMembership> with is_member flag and series info
   */
  getSeriesMembership(entityTable: string, entityId: number | string): Observable<SeriesMembership> {
    return this.http.post<SeriesMembership>(
      `${getPostgrestUrl()}rpc/get_series_membership`,
      {
        p_entity_table: entityTable,
        p_entity_id: entityId
      }
    ).pipe(
      catchError(() => of({ is_member: false }))
    );
  }

  // ============================================================================
  // SERIES GROUP MANAGEMENT
  // ============================================================================

  /**
   * Get all series groups (for management page).
   * Returns summary view with stats.
   *
   * @param filters Optional PostgREST filters
   * @returns Observable<SeriesGroup[]>
   */
  getSeriesGroups(filters?: string): Observable<SeriesGroup[]> {
    let url = `${getPostgrestUrl()}schema_series_groups?order=updated_at.desc`;
    if (filters) {
      url += `&${filters}`;
    }
    return this.http.get<SeriesGroup[]>(url).pipe(
      catchError(() => of([]))
    );
  }

  /**
   * Get a single series group by ID.
   *
   * @param groupId Group ID
   * @returns Observable<SeriesGroup | null>
   */
  getSeriesGroupDetail(groupId: number): Observable<SeriesGroup | null> {
    return this.http.get<SeriesGroup[]>(
      `${getPostgrestUrl()}schema_series_groups?id=eq.${groupId}`
    ).pipe(
      map(groups => groups.length > 0 ? groups[0] : null),
      catchError(() => of(null))
    );
  }

  // ============================================================================
  // CONFLICT PREVIEW
  // ============================================================================

  /**
   * Preview conflicts before creating a recurring series.
   * Shows which occurrences overlap with existing records.
   *
   * @param params Conflict preview parameters
   * @returns Observable<ConflictInfo[]>
   */
  previewConflicts(params: PreviewConflictsParams): Observable<ConflictInfo[]> {
    return this.http.post<ConflictInfo[]>(
      `${getPostgrestUrl()}rpc/preview_recurring_conflicts`,
      {
        p_entity_table: params.entityTable,
        p_scope_column: params.scopeColumn,
        p_scope_value: params.scopeValue,
        p_time_slot_column: params.timeSlotColumn,
        p_occurrences: params.occurrences
      }
    ).pipe(
      catchError(() => of([]))
    );
  }

  // ============================================================================
  // SERIES CREATION
  // ============================================================================

  /**
   * Create a new recurring series with group and initial instances.
   *
   * @param params Series creation parameters
   * @returns Observable<CreateSeriesResult>
   */
  createSeries(params: CreateSeriesParams): Observable<CreateSeriesResult> {
    return this.http.post<CreateSeriesResult>(
      `${getPostgrestUrl()}rpc/create_recurring_series`,
      {
        p_group_name: params.groupName,
        p_group_description: params.groupDescription || null,
        p_group_color: params.groupColor || null,
        p_entity_table: params.entityTable,
        p_entity_template: params.entityTemplate,
        p_rrule: params.rrule,
        p_dtstart: params.dtstart,
        p_duration: params.duration,
        p_timezone: params.timezone || null,
        p_time_slot_property: params.timeSlotProperty || 'time_slot',
        p_expand_now: params.expandNow ?? false,
        p_skip_conflicts: params.skipConflicts ?? false
      }
    ).pipe(
      catchError((error) => of({
        success: false,
        message: error?.error?.message || 'Failed to create recurring series'
      }))
    );
  }

  // ============================================================================
  // SERIES OPERATIONS
  // ============================================================================

  /**
   * Request expansion of series instances up to a date.
   * Actual expansion happens via Go worker.
   *
   * @param seriesId Series ID
   * @param expandUntil Target date (ISO format)
   */
  expandSeriesInstances(seriesId: number, expandUntil: string): Observable<any> {
    return this.http.post(
      `${getPostgrestUrl()}rpc/expand_series_instances`,
      {
        p_series_id: seriesId,
        p_expand_until: expandUntil
      }
    ).pipe(
      catchError(() => of({ success: false, message: 'Failed to expand series' }))
    );
  }

  /**
   * Cancel a single occurrence of a series.
   * Marks junction as cancelled (preserves history) and deletes entity record.
   *
   * @param entityTable Table name
   * @param entityId Entity record ID
   * @param reason Optional cancellation reason
   */
  cancelOccurrence(entityTable: string, entityId: number, reason?: string): Observable<any> {
    return this.http.post(
      `${getPostgrestUrl()}rpc/cancel_series_occurrence`,
      {
        p_entity_table: entityTable,
        p_entity_id: entityId,
        p_reason: reason || null
      }
    ).pipe(
      catchError((error) => of({
        success: false,
        message: error?.error?.message || 'Failed to cancel occurrence'
      }))
    );
  }

  /**
   * Reschedule a single occurrence to a new time slot.
   * Marks junction as rescheduled and stores original time for audit.
   *
   * @param entityTable Table name
   * @param entityId Entity record ID
   * @param newTimeSlot New time slot as tstzrange string (e.g., "[2025-01-15T14:00:00Z,2025-01-15T16:00:00Z)")
   */
  rescheduleOccurrence(entityTable: string, entityId: number, newTimeSlot: string): Observable<any> {
    return this.http.post(
      `${getPostgrestUrl()}rpc/reschedule_occurrence`,
      {
        p_entity_table: entityTable,
        p_entity_id: entityId,
        p_new_time_slot: newTimeSlot
      }
    ).pipe(
      catchError((error) => of({
        success: false,
        message: error?.error?.message || 'Failed to reschedule occurrence'
      }))
    );
  }

  /**
   * Split a series for "edit this and future" operations.
   * Creates new series version in same group, terminates original.
   *
   * @param params Split parameters
   */
  splitSeries(params: SplitSeriesParams): Observable<any> {
    return this.http.post(
      `${getPostgrestUrl()}rpc/split_series_from_date`,
      {
        p_series_id: params.seriesId,
        p_split_date: params.splitDate,
        p_new_dtstart: params.newDtstart,
        p_new_duration: params.newDuration || null,
        p_new_template: params.newTemplate || null
      }
    ).pipe(
      catchError((error) => of({
        success: false,
        message: error?.error?.message || 'Failed to split series'
      }))
    );
  }

  /**
   * Update series template and propagate to non-exception instances.
   * Used for "edit all occurrences" operations.
   *
   * @param seriesId Series ID
   * @param newTemplate New template data
   * @param skipExceptions Whether to skip exception instances (default true)
   */
  updateSeriesTemplate(
    seriesId: number,
    newTemplate: Record<string, any>,
    skipExceptions: boolean = true
  ): Observable<any> {
    return this.http.post(
      `${getPostgrestUrl()}rpc/update_series_template`,
      {
        p_series_id: seriesId,
        p_new_template: newTemplate,
        p_skip_exceptions: skipExceptions
      }
    ).pipe(
      catchError((error) => of({
        success: false,
        message: error?.error?.message || 'Failed to update series template'
      }))
    );
  }

  // ============================================================================
  // GROUP UPDATES
  // ============================================================================

  /**
   * Update series group display info (name, description, color).
   * Does not modify the series RRULE or instances.
   *
   * @param groupId Group ID
   * @param displayName New display name
   * @param description New description (or null)
   * @param color New color (or null)
   */
  updateSeriesGroupInfo(
    groupId: number,
    displayName: string,
    description: string | null,
    color: string | null
  ): Observable<any> {
    return this.http.post(
      `${getPostgrestUrl()}rpc/update_series_group_info`,
      {
        p_group_id: groupId,
        p_display_name: displayName,
        p_description: description,
        p_color: color
      }
    ).pipe(
      catchError((error) => of({
        success: false,
        message: error?.error?.message || 'Failed to update series group'
      }))
    );
  }

  /**
   * Update series schedule (dtstart, duration, rrule).
   * Note: This updates the series record directly. For complex edits that
   * should create a new version, use splitSeries instead.
   *
   * @param seriesId Series ID
   * @param dtstart New start datetime (ISO string)
   * @param duration New duration (ISO 8601 format, e.g., 'PT1H30M')
   * @param rrule New RRULE string
   */
  updateSeriesSchedule(
    seriesId: number,
    dtstart: string,
    duration: string,
    rrule: string
  ): Observable<any> {
    return this.http.post(
      `${getPostgrestUrl()}rpc/update_series_schedule`,
      {
        p_series_id: seriesId,
        p_dtstart: dtstart,
        p_duration: duration,
        p_rrule: rrule
      }
    ).pipe(
      catchError((error) => of({
        success: false,
        message: error?.error?.message || 'Failed to update series schedule'
      }))
    );
  }

  // ============================================================================
  // INSTANCE LISTING
  // ============================================================================

  /**
   * Get all instances for a series group.
   * Returns instances joined with entity data for display.
   *
   * @param groupId Group ID
   * @param filter 'all' | 'upcoming' | 'past' | 'exceptions'
   * @returns Observable<SeriesInstance[]>
   */
  getSeriesInstances(
    groupId: number,
    filter: 'all' | 'upcoming' | 'past' | 'exceptions' = 'all'
  ): Observable<SeriesInstance[]> {
    // Build query to get instances for this group via series
    let url = `${getPostgrestUrl()}time_slot_instances?select=*,series:time_slot_series!inner(group_id)&series.group_id=eq.${groupId}`;

    const now = new Date().toISOString();
    switch (filter) {
      case 'upcoming':
        url += `&occurrence_date=gte.${now}`;
        break;
      case 'past':
        url += `&occurrence_date=lt.${now}`;
        break;
      case 'exceptions':
        url += `&is_exception=eq.true`;
        break;
    }

    url += `&order=occurrence_date.asc`;

    return this.http.get<SeriesInstance[]>(url).pipe(
      catchError(() => of([]))
    );
  }

  /**
   * Get instances for a specific series (not group).
   *
   * @param seriesId Series ID
   * @returns Observable<SeriesInstance[]>
   */
  getSeriesInstancesBySeriesId(seriesId: number): Observable<SeriesInstance[]> {
    return this.http.get<SeriesInstance[]>(
      `${getPostgrestUrl()}time_slot_instances?series_id=eq.${seriesId}&order=occurrence_date.asc`
    ).pipe(
      catchError(() => of([]))
    );
  }

  // ============================================================================
  // DELETION
  // ============================================================================

  /**
   * Delete a series and all its entity records.
   *
   * @param seriesId Series ID
   */
  deleteSeries(seriesId: number): Observable<any> {
    return this.http.post(
      `${getPostgrestUrl()}rpc/delete_series_with_instances`,
      {
        p_series_id: seriesId
      }
    ).pipe(
      catchError((error) => of({
        success: false,
        message: error?.error?.message || 'Failed to delete series'
      }))
    );
  }

  /**
   * Delete an entire series group with all versions and entity records.
   *
   * @param groupId Group ID
   */
  deleteSeriesGroup(groupId: number): Observable<any> {
    return this.http.post(
      `${getPostgrestUrl()}rpc/delete_series_group`,
      {
        p_group_id: groupId
      }
    ).pipe(
      catchError((error) => of({
        success: false,
        message: error?.error?.message || 'Failed to delete series group'
      }))
    );
  }

  // ============================================================================
  // RRULE HELPERS
  // ============================================================================

  /**
   * Build an RRULE string from configuration.
   * Helper method for RecurrenceRuleEditorComponent.
   *
   * @param config RRULE configuration
   * @returns RRULE string (e.g., "FREQ=WEEKLY;BYDAY=MO,WE,FR")
   */
  buildRRuleString(config: RRuleConfig): string {
    const parts: string[] = [`FREQ=${config.frequency}`];

    if (config.interval > 1) {
      parts.push(`INTERVAL=${config.interval}`);
    }

    if (config.byDay && config.byDay.length > 0) {
      parts.push(`BYDAY=${config.byDay.join(',')}`);
    }

    if (config.byMonthDay && config.byMonthDay.length > 0) {
      parts.push(`BYMONTHDAY=${config.byMonthDay.join(',')}`);
    }

    if (config.byMonth && config.byMonth.length > 0) {
      parts.push(`BYMONTH=${config.byMonth.join(',')}`);
    }

    // BYSETPOS for "Nth weekday" patterns (e.g., 2nd Tuesday, last Friday)
    if (config.bySetPos && config.bySetPos.length > 0) {
      parts.push(`BYSETPOS=${config.bySetPos.join(',')}`);
    }

    if (config.count) {
      parts.push(`COUNT=${config.count}`);
    } else if (config.until) {
      // Format as YYYYMMDDTHHMMSSZ
      const date = new Date(config.until);
      const until = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      parts.push(`UNTIL=${until}`);
    }

    return parts.join(';');
  }

  /**
   * Parse an RRULE string to configuration.
   * Helper method for RecurrenceRuleEditorComponent.
   *
   * @param rrule RRULE string
   * @returns Partial RRuleConfig
   */
  parseRRuleString(rrule: string): Partial<RRuleConfig> {
    const config: Partial<RRuleConfig> = {};
    const parts = rrule.split(';');

    for (const part of parts) {
      const [key, value] = part.split('=');

      switch (key) {
        case 'FREQ':
          config.frequency = value as RRuleConfig['frequency'];
          break;
        case 'INTERVAL':
          config.interval = parseInt(value, 10);
          break;
        case 'BYDAY':
          config.byDay = value.split(',') as RRuleConfig['byDay'];
          break;
        case 'BYMONTHDAY':
          config.byMonthDay = value.split(',').map(d => parseInt(d, 10));
          break;
        case 'BYMONTH':
          config.byMonth = value.split(',').map(m => parseInt(m, 10));
          break;
        case 'BYSETPOS':
          config.bySetPos = value.split(',').map(p => parseInt(p, 10));
          break;
        case 'COUNT':
          config.count = parseInt(value, 10);
          break;
        case 'UNTIL':
          // Parse YYYYMMDDTHHMMSSZ format
          const year = value.substring(0, 4);
          const month = value.substring(4, 6);
          const day = value.substring(6, 8);
          config.until = `${year}-${month}-${day}`;
          break;
      }
    }

    // Set defaults
    if (!config.interval) {
      config.interval = 1;
    }

    return config;
  }

  /**
   * Generate human-readable description of an RRULE.
   *
   * @param rrule RRULE string
   * @returns Human-readable description
   */
  describeRRule(rrule: string): string {
    const config = this.parseRRuleString(rrule);

    let description = '';
    const interval = config.interval || 1;

    switch (config.frequency) {
      case 'DAILY':
        description = interval === 1 ? 'Every day' : `Every ${interval} days`;
        break;
      case 'WEEKLY':
        if (config.byDay && config.byDay.length > 0) {
          const days = config.byDay.map(d => this.dayName(d)).join(', ');
          description = interval === 1
            ? `Weekly on ${days}`
            : `Every ${interval} weeks on ${days}`;
        } else {
          description = interval === 1 ? 'Every week' : `Every ${interval} weeks`;
        }
        break;
      case 'MONTHLY':
        if (config.bySetPos && config.bySetPos.length > 0 && config.byDay && config.byDay.length > 0) {
          // "Nth weekday" pattern (e.g., 2nd Tuesday, last Friday)
          const pos = config.bySetPos[0];
          const day = config.byDay[0];
          const posName = this.positionName(pos);
          const dayName = this.dayName(day);
          description = interval === 1
            ? `Monthly on the ${posName} ${dayName}`
            : `Every ${interval} months on the ${posName} ${dayName}`;
        } else if (config.byMonthDay && config.byMonthDay.length > 0) {
          const days = config.byMonthDay.join(', ');
          description = interval === 1
            ? `Monthly on day ${days}`
            : `Every ${interval} months on day ${days}`;
        } else {
          description = interval === 1 ? 'Every month' : `Every ${interval} months`;
        }
        break;
      case 'YEARLY':
        description = interval === 1 ? 'Every year' : `Every ${interval} years`;
        break;
      default:
        description = 'Recurring';
    }

    if (config.count) {
      description += `, ${config.count} times`;
    } else if (config.until) {
      description += `, until ${new Date(config.until).toLocaleDateString()}`;
    }

    return description;
  }

  /**
   * Convert day code to full name.
   */
  private dayName(code: string): string {
    const names: Record<string, string> = {
      'MO': 'Monday',
      'TU': 'Tuesday',
      'WE': 'Wednesday',
      'TH': 'Thursday',
      'FR': 'Friday',
      'SA': 'Saturday',
      'SU': 'Sunday'
    };
    return names[code] || code;
  }

  /**
   * Convert BYSETPOS position to ordinal name.
   * Supports 1-5 for first-fifth, and -1 for last.
   */
  private positionName(pos: number): string {
    switch (pos) {
      case 1: return '1st';
      case 2: return '2nd';
      case 3: return '3rd';
      case 4: return '4th';
      case 5: return '5th';
      case -1: return 'last';
      case -2: return '2nd to last';
      default: return `${pos}th`;
    }
  }
}
