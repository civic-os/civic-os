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
import { Observable, catchError, forkJoin, map, of } from 'rxjs';
import { ApiResponse } from '../interfaces/api';
import { getPostgrestUrl } from '../config/runtime';

export interface EntityMetadata {
  table_name: string;
  display_name: string | null;
  description: string | null;
  sort_order: number | null;
}

@Injectable({
  providedIn: 'root'
})
export class EntityManagementService {
  private http = inject(HttpClient);

  /**
   * Upsert entity metadata (insert or update)
   * Uses RPC function in public schema
   */
  upsertEntityMetadata(
    tableName: string,
    displayName: string | null,
    description: string | null,
    sortOrder: number | null,
    showMap: boolean = false,
    mapPropertyName: string | null = null,
    showCalendar: boolean = false,
    calendarPropertyName: string | null = null,
    calendarColorProperty: string | null = null,
    enableNotes: boolean = false
  ): Observable<ApiResponse> {
    return this.http.post(
      getPostgrestUrl() + 'rpc/upsert_entity_metadata',
      {
        p_table_name: tableName,
        p_display_name: displayName,
        p_description: description,
        p_sort_order: sortOrder,
        p_show_map: showMap,
        p_map_property_name: mapPropertyName,
        p_show_calendar: showCalendar,
        p_calendar_property_name: calendarPropertyName,
        p_calendar_color_property: calendarColorProperty,
        p_enable_notes: enableNotes
      }
    ).pipe(
      map((response: any) => <ApiResponse>{ success: true, body: response }),
      catchError((error) => {
        console.error('Error upserting entity metadata:', error);
        return of(<ApiResponse>{
          success: false,
          error: { message: error.message, humanMessage: 'Failed to save entity metadata' }
        });
      })
    );
  }

  /**
   * Batch update entities order after drag-drop
   * Updates sort_order for multiple entities using RPC
   */
  updateEntitiesOrder(entities: { table_name: string, sort_order: number }[]): Observable<ApiResponse> {
    // Call RPC function for each entity and use forkJoin to wait for all
    const updates = entities.map(entity =>
      this.http.post(
        getPostgrestUrl() + 'rpc/update_entity_sort_order',
        {
          p_table_name: entity.table_name,
          p_sort_order: entity.sort_order
        }
      )
    );

    if (updates.length === 0) {
      return of(<ApiResponse>{ success: true });
    }

    return forkJoin(updates).pipe(
      map(() => <ApiResponse>{ success: true }),
      catchError((error) => {
        console.error('Error updating entities order:', error);
        return of(<ApiResponse>{
          success: false,
          error: { message: error.message, humanMessage: 'Failed to update entities order' }
        });
      })
    );
  }

  /**
   * Check if current user is admin (reuse from PermissionsService pattern)
   */
  isAdmin(): Observable<boolean> {
    return this.http.post<boolean>(
      getPostgrestUrl() + 'rpc/is_admin',
      {}
    ).pipe(
      catchError(() => of(false))
    );
  }
}
