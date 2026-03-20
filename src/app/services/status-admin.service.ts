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

import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { ApiResponse } from '../interfaces/api';
import { getPostgrestUrl } from '../config/runtime';

export interface StatusType {
  entity_type: string;
  display_name: string | null;
  description: string | null;
  status_count: number;
}

export interface StatusValue {
  id: number;
  entity_type: string;
  status_key: string;
  display_name: string;
  description: string | null;
  color: string | null;
  sort_order: number;
  is_initial: boolean;
  is_terminal: boolean;
}

export interface StatusTransition {
  id: number;
  entity_type: string;
  from_status_id: number;
  from_display_name: string;
  from_color: string | null;
  to_status_id: number;
  to_display_name: string;
  to_color: string | null;
  on_transition_rpc: string | null;
  display_name: string | null;
  description: string | null;
  sort_order: number;
  is_enabled: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class StatusAdminService {
  private http = inject(HttpClient);

  getStatusEntityTypes(): Observable<StatusType[]> {
    return this.http.post<StatusType[]>(
      getPostgrestUrl() + 'rpc/get_status_entity_types',
      {}
    ).pipe(
      catchError((error) => {
        console.error('Error fetching status entity types:', error);
        return of([]);
      })
    );
  }

  getStatusesForEntity(entityType: string): Observable<StatusValue[]> {
    return this.http.get<StatusValue[]>(
      getPostgrestUrl() + `statuses?entity_type=eq.${encodeURIComponent(entityType)}&order=sort_order,display_name`
    ).pipe(
      catchError((error) => {
        console.error('Error fetching statuses:', error);
        return of([]);
      })
    );
  }

  upsertStatusType(entityType: string, description?: string, displayName?: string): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/upsert_status_type',
      {
        p_entity_type: entityType,
        p_description: description || null,
        p_display_name: displayName || null
      }
    ).pipe(
      map((response) => this.mapJsonbResponse(response)),
      catchError((error) => of(this.errorResponse('Failed to save status type', error)))
    );
  }

  deleteStatusType(entityType: string): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/delete_status_type',
      { p_entity_type: entityType }
    ).pipe(
      map((response) => this.mapJsonbResponse(response)),
      catchError((error) => of(this.errorResponse('Failed to delete status type', error)))
    );
  }

  upsertStatus(
    entityType: string,
    displayName: string,
    description?: string,
    color?: string,
    sortOrder?: number,
    isInitial?: boolean,
    isTerminal?: boolean,
    statusId?: number
  ): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/upsert_status',
      {
        p_entity_type: entityType,
        p_display_name: displayName,
        p_description: description || null,
        p_color: color || '#3B82F6',
        p_sort_order: sortOrder ?? 0,
        p_is_initial: isInitial ?? false,
        p_is_terminal: isTerminal ?? false,
        p_status_id: statusId || null
      }
    ).pipe(
      map((response) => this.mapJsonbResponse(response)),
      catchError((error) => of(this.errorResponse('Failed to save status', error)))
    );
  }

  deleteStatus(statusId: number): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/delete_status',
      { p_status_id: statusId }
    ).pipe(
      map((response) => this.mapJsonbResponse(response)),
      catchError((error) => of(this.errorResponse('Failed to delete status', error)))
    );
  }

  getTransitionsForEntity(entityType: string): Observable<StatusTransition[]> {
    return this.http.post<StatusTransition[]>(
      getPostgrestUrl() + 'rpc/get_status_transitions_for_entity',
      { p_entity_type: entityType }
    ).pipe(
      catchError((error) => {
        console.error('Error fetching transitions:', error);
        return of([]);
      })
    );
  }

  upsertTransition(
    entityType: string,
    fromStatusId: number,
    toStatusId: number,
    onTransitionRpc?: string,
    displayName?: string,
    description?: string,
    sortOrder?: number,
    isEnabled?: boolean,
    transitionId?: number
  ): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/upsert_status_transition',
      {
        p_entity_type: entityType,
        p_from_status_id: fromStatusId,
        p_to_status_id: toStatusId,
        p_on_transition_rpc: onTransitionRpc || null,
        p_display_name: displayName || null,
        p_description: description || null,
        p_sort_order: sortOrder ?? 0,
        p_is_enabled: isEnabled ?? true,
        p_transition_id: transitionId || null
      }
    ).pipe(
      map((response) => this.mapJsonbResponse(response)),
      catchError((error) => of(this.errorResponse('Failed to save transition', error)))
    );
  }

  deleteTransition(transitionId: number): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/delete_status_transition',
      { p_transition_id: transitionId }
    ).pipe(
      map((response) => this.mapJsonbResponse(response)),
      catchError((error) => of(this.errorResponse('Failed to delete transition', error)))
    );
  }

  private mapJsonbResponse(response: any): ApiResponse {
    if (response?.success === false) {
      return {
        success: false,
        error: { message: response.error, humanMessage: response.error }
      };
    }
    return { success: true, body: response };
  }

  private errorResponse(humanMessage: string, error: any): ApiResponse {
    return {
      success: false,
      error: { message: error.message, humanMessage }
    };
  }
}
