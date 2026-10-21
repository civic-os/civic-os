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

import { HttpClient, HttpErrorResponse, HttpEvent, HttpEventType } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, filter, forkJoin, map, of, tap } from 'rxjs';
import { EntityData, InverseRelationshipMeta, InverseRelationshipData, ManyToManyMeta, ParentHop } from '../interfaces/entity';
import { DataQuery, PaginatedResponse } from '../interfaces/query';
import { ApiError, ApiResponse } from '../interfaces/api';
import { ErrorService } from './error.service';
import { AnalyticsService } from './analytics.service';
import { getPostgrestUrl } from '../config/runtime';
import {
  checkEditResult,
  compareColorValues,
  compareDateTimeValues,
  compareDateValues,
  compareGeographyValues,
  compareMoneyValues,
  compareTimeSlotValues,
  compileDataQuery,
  parseContentRangeCount,
  parseContentRangeTotal,
  parseEWKBPoint,
  transformManyToManyData,
} from '@civic-os/core';

@Injectable({
  providedIn: 'root'
})
export class DataService {
  private http = inject(HttpClient);
  private analytics = inject(AnalyticsService);
  private errorService = inject(ErrorService);

  private get(url: string): Observable<any> {
    return this.http.get(getPostgrestUrl() + url);
  }

  public getData(query: DataQuery): Observable<EntityData[]> {
    this.ensureIdField(query);
    return this.get(compileDataQuery(query).path);
  }

  /**
   * Appends `id` to the caller's `fields` array in place (long-standing side
   * effect that callers may observe); the compiler itself is pure.
   */
  private ensureIdField(query: DataQuery): void {
    if (query.fields && !query.isSummaryView && !query.fields.includes('id')) {
      query.fields.push('id');
    }
  }

  /**
   * Get paginated data with total count.
   * Uses PostgREST Range headers for pagination and Content-Range for total count.
   *
   * @param query Data query including pagination params
   * @returns Observable of paginated response with data and total count
   */
  public getDataPaginated(query: DataQuery): Observable<PaginatedResponse<EntityData>> {
    this.ensureIdField(query);
    const compiled = compileDataQuery(query, { paginated: true });

    return this.http.get<EntityData[]>(getPostgrestUrl() + compiled.path, {
      observe: 'response',
      headers: compiled.headers
    }).pipe(
      map(response => {
        const data = response.body || [];

        // Parse count from Content-Range header: "0-24/237" -> 237
        const totalCount = parseContentRangeTotal(response.headers.get('Content-Range'), data.length);

        return { data, totalCount };
      }),
      catchError(err => {
        console.error('Error fetching paginated data:', err);
        return of({ data: [], totalCount: 0 });
      })
    );
  }

  public createData(entity: string, data: any): Observable<ApiResponse> {
    return this.http.post(getPostgrestUrl() + entity, data, {
      headers: {
        Prefer: 'return=representation'
      }
    })
      .pipe(
        catchError((err) => this.parseApiError(err)),
        map((response: any) => {
          // If it's already an error response from catchError, return as-is
          if (response && typeof response === 'object' && 'success' in response && response.success === false) {
            return response as ApiResponse;
          }
          // Otherwise, it's a successful HTTP response
          return <ApiResponse>{success: true, body: response};
        }),
      );
  }
  public editData(entity: string, id: string | number, data: any): Observable<ApiResponse> {
    return this.http.patch(getPostgrestUrl() + entity + '?id=eq.' + id, data, {
      headers: {
        Prefer: 'return=representation'
      }
    })
      .pipe(
        catchError((err) => this.parseApiError(err)),
        map((response) => {
          // If it's already an error response from catchError, return as-is
          if (response && typeof response === 'object' && 'success' in response && response.success === false) {
            return response as ApiResponse;
          }
          // Otherwise, it's a successful HTTP response - wrap it
          return this.checkEditResult(data, {success: true, body: response});
        }),
      );
  }

  public deleteData(entity: string, id: string | number): Observable<ApiResponse> {
    return this.http.delete(getPostgrestUrl() + entity + '?id=eq.' + id)
      .pipe(
        catchError((err) => this.parseApiError(err)),
        map((response) => {
          // If it's already an error response from catchError, return as-is
          if (response && typeof response === 'object' && 'success' in response && response.success === false) {
            return response as ApiResponse;
          }
          // Otherwise, it's a successful HTTP delete
          return <ApiResponse>{success: true, body: response};
        }),
        tap((response) => {
          // Track successful deletions
          if (response.success === true) {
            this.analytics.trackEvent('Entity', 'Delete', entity);
          }
        })
      );
  }

  public refreshCurrentUser(): Observable<ApiResponse> {
    return this.http.post(getPostgrestUrl() + 'rpc/refresh_current_user', {})
      .pipe(
        catchError((err) => this.parseApiError(err)),
        map((response) => {
          // If it's already an error response from catchError, return as-is
          if (response && typeof response === 'object' && 'success' in response && response.success === false) {
            return response as ApiResponse;
          }
          // Otherwise, it's a successful response
          return <ApiResponse>{success: true, body: response};
        }),
      );
  }

  private parseApiResponse(body: any) {
    // Check if it's already an error response with strict equality
    if(body && typeof body === 'object' && 'success' in body && body.success === false) {
      return body;
    } else {
      return <ApiResponse>{success: true, body: body};
    }
  }
  /** Parses EWKB hex for a POINT into EWKT; delegates to `@civic-os/core`. */
  private parseEWKBPoint(hexString: string): string | null {
    return parseEWKBPoint(hexString);
  }

  /** Compares datetime values, handling timezone differences; delegates to `@civic-os/core`. */
  private compareDateTimeValues(inputValue: any, responseValue: any): { isDateTime: boolean, matches: boolean } {
    return compareDateTimeValues(inputValue, responseValue);
  }

  /** Compares date-only values (PostgreSQL 'date' type); delegates to `@civic-os/core`. */
  private compareDateValues(inputValue: any, responseValue: any): { isDate: boolean, matches: boolean } {
    return compareDateValues(inputValue, responseValue);
  }

  /** Compares money values; delegates to `@civic-os/core`. */
  private compareMoneyValues(inputValue: any, responseValue: any): { isMoney: boolean, matches: boolean } {
    return compareMoneyValues(inputValue, responseValue);
  }

  /** Compares hex color values (case-insensitive); delegates to `@civic-os/core`. */
  private compareColorValues(inputValue: any, responseValue: any): { isColor: boolean, matches: boolean } {
    return compareColorValues(inputValue, responseValue);
  }

  /** Compares time_slot (tstzrange) values; delegates to `@civic-os/core`. */
  private compareTimeSlotValues(inputValue: any, responseValue: any): { isTimeSlot: boolean, matches: boolean } {
    return compareTimeSlotValues(inputValue, responseValue);
  }

  /** Compares geography/geometry fields by converting EWKB to EWKT; delegates to `@civic-os/core`. */
  private compareGeographyValues(inputValue: any, responseValue: any): { isGeography: boolean, matches: boolean } {
    return compareGeographyValues(inputValue, responseValue);
  }

  private checkEditResult(input: any, representation: any) {
    return checkEditResult(input, representation);
  }
  private parseApiError(evt: HttpErrorResponse): Observable<ApiResponse> {
    // Safely handle various error response formats
    let error: ApiError;

    if (evt.error && typeof evt.error === 'object') {
      // PostgREST or structured error response
      error = {
        httpCode: evt.status,
        code: evt.error.code,
        details: evt.error.details,
        hint: evt.error.hint,
        message: evt.error.message || evt.statusText || 'Unknown error',
        humanMessage: '' // Will be set below
      };
    } else {
      // Unstructured error (string, null, undefined, network error, etc.)
      error = {
        httpCode: evt.status,
        message: typeof evt.error === 'string' ? evt.error : (evt.statusText || 'Unknown error'),
        humanMessage: '' // Will be set below
      };
    }

    error.humanMessage = this.errorService.parseToHumanWithLookup(error);
    let resp: ApiResponse = {success: false, error: error};
    return of(resp);
  }

  /**
   * Get both preview records and total count in a single optimized request.
   * Uses PostgREST's Prefer: count=exact header to get total count in Content-Range
   * while fetching limited preview records - reduces HTTP requests from 2N to N.
   *
   * The select list adapts to the source table's columns (previewMode): tables
   * without display_name select only id, and tables without either (composite-PK
   * junctions) fetch a count-only response via limit=0 - selecting a column the
   * table does not have would 400 the whole request.
   */
  public getInverseRelationshipPreview(
    sourceTable: string,
    filterColumn: string,
    filterValue: any,
    limit: number = 5,
    previewMode: 'display_name' | 'id' | 'count' = 'display_name'
  ): Observable<{ records: EntityData[], totalCount: number }> {
    const select = previewMode === 'display_name' ? 'id,display_name'
      : previewMode === 'id' ? 'id'
      : filterColumn;
    const effectiveLimit = previewMode === 'count' ? 0 : limit;
    const url = `${sourceTable}?${filterColumn}=eq.${filterValue}&select=${select}&limit=${effectiveLimit}`;

    return this.http.get<EntityData[]>(getPostgrestUrl() + url, {
      observe: 'response',
      headers: {
        'Prefer': 'count=exact'
      }
    }).pipe(
      map(response => {
        const records = response.body || [];

        // Parse count from Content-Range header: "0-4/15" -> 15
        const totalCount = parseContentRangeCount(response.headers.get('Content-Range'), records.length);

        return { records, totalCount };
      }),
      catchError(err => {
        console.error('Error fetching inverse relationship preview:', err);
        return of({ records: [], totalCount: 0 });
      })
    );
  }

  /**
   * Get complete inverse relationship data for display
   */
  public getInverseRelationshipData(
    meta: InverseRelationshipMeta,
    targetId: string | number
  ): Observable<InverseRelationshipData> {
    return this.getInverseRelationshipPreview(
      meta.sourceTable,
      meta.sourceColumn,
      targetId,
      meta.previewLimit,
      meta.previewMode
    ).pipe(
      map(({ records, totalCount }) => ({
        meta,
        totalCount,
        previewRecords: records,
        targetId
      }))
    );
  }

  /**
   * Transform M:M data from PostgREST response.
   * Flattens junction records to just the related entities.
   *
   * Pure junction:
   *   Input:  [{Tag: {id: 1, display_name: 'Urgent'}}, {Tag: {id: 2, display_name: 'Road'}}]
   *   Output: [{id: 1, display_name: 'Urgent'}, {id: 2, display_name: 'Road'}]
   *
   * Rich junction (v0.51.0):
   *   Input:  [{tool_types: {id: 1, display_name: 'Push Mower'}, quantity: 3}]
   *   Output: [{id: 1, display_name: 'Push Mower', _junction: {quantity: 3}}]
   *
   * @param junctionData Array of junction records with embedded related entities
   * @param relatedTable Name of the related table (used as key in PostgREST embedded resource)
   * @param extraColumnNames Optional extra column names for rich junctions (v0.51.0)
   * @returns Flattened array of related entity objects (with _junction for rich junctions)
   */
  public static transformManyToManyData(
    junctionData: any[],
    relatedTable: string,
    extraColumnNames?: string[],
    parentHops?: ParentHop[],
    targetTable?: string
  ): any[] {
    return transformManyToManyData(junctionData, relatedTable, extraColumnNames, parentHops, targetTable);
  }

  /**
   * Add a single many-to-many relationship (immediate save).
   * Used by ManyToManyEditorComponent on Detail page.
   *
   * @param entityId The source entity ID
   * @param meta M:M relationship metadata
   * @param targetId The related entity ID to add
   * @returns Observable of API response
   */
  public addManyToManyRelation(
    entityId: number | string,
    meta: ManyToManyMeta,
    targetId: number | string,
    extraData?: Record<string, unknown>
  ): Observable<ApiResponse> {
    return this.http.post(
      getPostgrestUrl() + meta.junctionTable,
      {
        [meta.sourceColumn]: entityId,
        [meta.targetColumn]: targetId,
        ...extraData
      },
      { headers: { Prefer: 'return=minimal' } }
    ).pipe(
      map(() => ({ success: true, body: null })),
      catchError(err => this.parseApiError(err))
    );
  }

  /**
   * Update extra column values on an existing many-to-many junction row (v0.51.0).
   * Used by rich junctions (e.g., quantity on tool_reservation_tool_items).
   *
   * @param entityId The source entity ID
   * @param meta M:M relationship metadata
   * @param targetId The related entity ID
   * @param patchData Extra column values to update
   * @returns Observable of API response
   */
  public updateManyToManyRelation(
    entityId: number | string,
    meta: ManyToManyMeta,
    targetId: number | string,
    patchData: Record<string, unknown>
  ): Observable<ApiResponse> {
    const filter = `${meta.sourceColumn}=eq.${entityId}&${meta.targetColumn}=eq.${targetId}`;
    return this.http.patch(
      getPostgrestUrl() + meta.junctionTable + '?' + filter,
      patchData,
      { headers: { Prefer: 'return=minimal' } }
    ).pipe(
      map(() => ({ success: true, body: null })),
      catchError(err => this.parseApiError(err))
    );
  }

  /**
   * Remove a single many-to-many relationship (immediate save).
   * Used by ManyToManyEditorComponent on Detail page.
   *
   * @param entityId The source entity ID
   * @param meta M:M relationship metadata
   * @param targetId The related entity ID to remove
   * @returns Observable of API response
   */
  public removeManyToManyRelation(
    entityId: number | string,
    meta: ManyToManyMeta,
    targetId: number | string
  ): Observable<ApiResponse> {
    // Delete by composite key (issue_id, tag_id)
    const filter = `${meta.sourceColumn}=eq.${entityId}&${meta.targetColumn}=eq.${targetId}`;

    return this.http.delete(
      getPostgrestUrl() + meta.junctionTable + '?' + filter
    ).pipe(
      map(() => ({ success: true, body: null })),
      catchError(err => this.parseApiError(err))
    );
  }

  /**
   * Bulk insert records via PostgREST.
   * Posts array of objects as JSON.
   * IMPORTANT: This is an all-or-nothing transaction.
   * If any row fails database constraints, the entire import will be rejected.
   *
   * @param entity Table name
   * @param data Array of records to insert
   * @returns Observable of API response with progress events
   */
  public bulkInsert(entity: string, data: any[]): Observable<ApiResponse> {
    return this.http.post(
      getPostgrestUrl() + entity,
      data,
      {
        headers: {
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        // Track upload progress for large datasets
        reportProgress: true,
        observe: 'events'
      }
    ).pipe(
      // Filter for UploadProgress and Response events
      filter((event: HttpEvent<any>) =>
        event.type === HttpEventType.UploadProgress ||
        event.type === HttpEventType.Response
      ),
      map((event: HttpEvent<any>) => {
        if (event.type === HttpEventType.UploadProgress) {
          // Emit progress event
          const progress = Math.round(
            (event.loaded / (event.total || event.loaded)) * 100
          );
          // Return interim response with progress
          return { success: false, progress, body: null } as ApiResponse;
        } else if (event.type === HttpEventType.Response) {
          // Final response
          return { success: true, body: event.body } as ApiResponse;
        }
        // Should never reach here due to filter, but TypeScript needs return
        return { success: false, body: null } as ApiResponse;
      }),
      catchError(err => this.parseApiError(err))
    );
  }

  /**
   * Bulk insert junction table records for M:M relationships.
   * Uses Prefer: return=minimal since junction rows don't need to be returned.
   * Simpler than bulkInsert() — no progress tracking needed for junction records.
   *
   * @param junctionTable Junction table name (e.g., 'partner_service_categories')
   * @param records Array of junction records to insert
   * @returns Observable of API response
   */
  public bulkInsertJunctions(junctionTable: string, records: Record<string, any>[]): Observable<ApiResponse> {
    if (records.length === 0) {
      return of({ success: true, body: null } as ApiResponse);
    }

    return this.http.post(
      getPostgrestUrl() + junctionTable,
      records,
      {
        headers: {
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        }
      }
    ).pipe(
      map(() => ({ success: true, body: null } as ApiResponse)),
      catchError(err => this.parseApiError(err))
    );
  }

  /**
   * Call a PostgREST RPC function
   *
   * @param functionName - Name of the PostgreSQL function to call
   * @param params - Parameters to pass to the function
   * @returns Observable of the RPC result
   */
  public callRpc(functionName: string, params: Record<string, any>): Observable<any> {
    return this.http.post(getPostgrestUrl() + 'rpc/' + functionName, params);
  }

  /**
   * Execute an RPC function with ApiResponse wrapping for Entity Actions.
   *
   * Unlike callRpc(), this method:
   * - Wraps successful responses in ApiResponse format
   * - Handles RPC-level success/error indicators in the response body
   * - Parses HTTP errors into friendly messages
   *
   * Entity action RPCs should return JSONB with:
   * - success: boolean
   * - message: string (optional)
   * - navigate_to: string (optional)
   * - refresh: boolean (optional)
   *
   * @param functionName - Name of the PostgreSQL function to call
   * @param params - Parameters to pass to the function
   * @returns Observable of ApiResponse
   */
  public executeRpc(functionName: string, params: Record<string, any>): Observable<ApiResponse> {
    return this.http.post(getPostgrestUrl() + 'rpc/' + functionName, params).pipe(
      catchError((err) => this.parseApiError(err)),
      map((response: any) => {
        // If parseApiError already converted to error response, return as-is
        if (response && typeof response === 'object' && 'success' in response && response.success === false && 'error' in response) {
          return response as ApiResponse;
        }

        // Check if RPC returned an explicit failure indicator in its response body
        // Entity action RPCs return {success: false, message: "..."} when they fail
        if (response && typeof response === 'object' && 'success' in response && response.success === false) {
          const rpcMessage = response.message || 'Action failed';
          return {
            success: false,
            error: {
              httpCode: 400,
              message: rpcMessage,
              humanMessage: rpcMessage
            }
          } as ApiResponse;
        }

        // Successful response - wrap in ApiResponse
        return { success: true, body: response } as ApiResponse;
      })
    );
  }
}
