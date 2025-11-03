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

import { HttpClient, HttpErrorResponse, HttpEvent, HttpEventType } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, filter, forkJoin, map, of, tap } from 'rxjs';
import { EntityData, InverseRelationshipMeta, InverseRelationshipData, ManyToManyMeta } from '../interfaces/entity';
import { DataQuery, PaginatedResponse } from '../interfaces/query';
import { ApiError, ApiResponse } from '../interfaces/api';
import { ErrorService } from './error.service';
import { AnalyticsService } from './analytics.service';
import { getPostgrestUrl } from '../config/runtime';

@Injectable({
  providedIn: 'root'
})
export class DataService {
  private http = inject(HttpClient);
  private analytics = inject(AnalyticsService);

  private get(url: string): Observable<any> {
    return this.http.get(getPostgrestUrl() + url);
  }

  public getData(query: DataQuery): Observable<EntityData[]> {
    let args: string[] = [];
    if(query.fields) {
      if(!query.fields.includes('id')) {
        query.fields.push('id');
      }
      args.push('select=' + query.fields.join(','));
    }
    if(query.searchQuery && query.searchQuery.trim()) {
      // Use wfts (websearch full-text search) for natural query syntax
      args.push('civic_os_text_search=wfts.' + encodeURIComponent(query.searchQuery.trim()));
      // When searching, order by relevance (no explicit order needed, PostgREST defaults to relevance)
    } else if(query.orderField) {
      args.push('order='+query.orderField+'.'+(query.orderDirection ?? 'asc'))
    }
    if(query.entityId) {
      args.push('id=eq.' + query.entityId);
    }
    // Process filters
    if(query.filters && query.filters.length > 0) {
      query.filters.forEach(filter => {
        if (filter.value !== null && filter.value !== undefined && filter.value !== '') {
          args.push(`${filter.column}=${filter.operator}.${filter.value}`);
        }
      });
    }
    let url = query.key + '?' + args.join('&');
    return this.get(url);
  }

  /**
   * Get paginated data with total count.
   * Uses PostgREST Range headers for pagination and Content-Range for total count.
   *
   * @param query Data query including pagination params
   * @returns Observable of paginated response with data and total count
   */
  public getDataPaginated(query: DataQuery): Observable<PaginatedResponse<EntityData>> {
    let args: string[] = [];
    if(query.fields) {
      if(!query.fields.includes('id')) {
        query.fields.push('id');
      }
      args.push('select=' + query.fields.join(','));
    }
    if(query.searchQuery && query.searchQuery.trim()) {
      // Use wfts (websearch full-text search) for natural query syntax
      args.push('civic_os_text_search=wfts.' + encodeURIComponent(query.searchQuery.trim()));
      // When searching, order by relevance (no explicit order needed, PostgREST defaults to relevance)
    } else if(query.orderField) {
      args.push('order='+query.orderField+'.'+(query.orderDirection ?? 'asc'))
    }
    if(query.entityId) {
      args.push('id=eq.' + query.entityId);
    }
    // Process filters
    if(query.filters && query.filters.length > 0) {
      query.filters.forEach(filter => {
        if (filter.value !== null && filter.value !== undefined && filter.value !== '') {
          args.push(`${filter.column}=${filter.operator}.${filter.value}`);
        }
      });
    }

    const url = query.key + '?' + args.join('&');

    // Calculate range for pagination
    const pagination = query.pagination || { page: 1, pageSize: 25 };
    const offset = (pagination.page - 1) * pagination.pageSize;
    const rangeEnd = offset + pagination.pageSize - 1;

    return this.http.get<EntityData[]>(getPostgrestUrl() + url, {
      observe: 'response',
      headers: {
        'Range-Unit': 'items',
        'Range': `${offset}-${rangeEnd}`,
        'Prefer': 'count=exact'
      }
    }).pipe(
      map(response => {
        const data = response.body || [];

        // Parse count from Content-Range header: "0-24/237" -> 237
        const contentRange = response.headers.get('Content-Range');
        let totalCount = 0;
        if (contentRange) {
          const match = contentRange.match(/\/(\d+|\*)$/);
          if (match && match[1] !== '*') {
            totalCount = parseInt(match[1], 10);
          } else {
            // If count is unknown (*), use data length as fallback
            totalCount = data.length;
          }
        } else {
          totalCount = data.length;
        }

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
  /**
   * Parses EWKB hex string for POINT geometry and returns EWKT.
   * EWKB format for Point with SRID: [byte order][type][SRID][X][Y]
   * Example: 0101000020E6100000... = SRID=4326;POINT(x y)
   */
  private parseEWKBPoint(hexString: string): string | null {
    try {
      // EWKB Point with SRID is 50 hex chars (25 bytes)
      if (hexString.length < 50) {
        return null;
      }

      // Byte order (01 = little-endian)
      const byteOrder = hexString.substring(0, 2);
      if (byteOrder !== '01') {
        return null; // Only support little-endian
      }

      // Geometry type (20000001 for Point with SRID in little-endian)
      const geomType = hexString.substring(2, 10);
      if (geomType !== '01000020') {
        return null; // Only support Point
      }

      // SRID (4 bytes little-endian)
      const sridHex = hexString.substring(10, 18);
      const srid = this.parseLE32(sridHex);

      // X coordinate (8 bytes little-endian double)
      const xHex = hexString.substring(18, 34);
      const x = this.parseLE64Double(xHex);

      // Y coordinate (8 bytes little-endian double)
      const yHex = hexString.substring(34, 50);
      const y = this.parseLE64Double(yHex);

      return `SRID=${srid};POINT(${x} ${y})`;
    } catch (error) {
      console.error('Error parsing EWKB:', error);
      return null;
    }
  }

  /** Parse 32-bit little-endian integer from hex */
  private parseLE32(hex: string): number {
    const bytes = hex.match(/.{2}/g)!.reverse();
    return parseInt(bytes.join(''), 16);
  }

  /** Parse 64-bit little-endian double from hex */
  private parseLE64Double(hex: string): number {
    const bytes = hex.match(/.{2}/g)!.reverse().join('');
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    for (let i = 0; i < 8; i++) {
      view.setUint8(i, parseInt(bytes.substring(i * 2, i * 2 + 2), 16));
    }
    return view.getFloat64(0, false); // false = big-endian (since we reversed bytes)
  }

  /**
   * Compares datetime values, handling timezone differences.
   * Input: "2025-10-31T17:00:00" (may or may not have seconds)
   * Response: "2025-10-31T17:00:00+00:00" (PostgreSQL always includes timezone)
   */
  private compareDateTimeValues(inputValue: any, responseValue: any): { isDateTime: boolean, matches: boolean } {
    if (typeof inputValue !== 'string' || typeof responseValue !== 'string') {
      return { isDateTime: false, matches: false };
    }

    // Check if values look like ISO 8601 datetime strings
    const dateTimePattern = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
    if (!dateTimePattern.test(inputValue) || !dateTimePattern.test(responseValue)) {
      return { isDateTime: false, matches: false };
    }

    try {
      // Normalize both to just date+time, strip timezone and milliseconds
      // Input:    "2025-10-31T17:00:00"
      // Response: "2025-10-31T17:00:00+00:00" or "2025-10-31T17:00:00.000Z"
      const normalizeDateTime = (dt: string) => {
        // Strip timezone suffix and milliseconds, take first 19 chars (YYYY-MM-DDTHH:mm:ss)
        return dt.replace(/(\.\d{3})?([+-]\d{2}:\d{2}|Z)$/, '').substring(0, 19);
      };

      const normalizedInput = normalizeDateTime(inputValue);
      const normalizedResponse = normalizeDateTime(responseValue);

      return { isDateTime: true, matches: normalizedInput === normalizedResponse };
    } catch (error) {
      return { isDateTime: false, matches: false };
    }
  }

  /**
   * Compares money values.
   * Input: 100 (number) or "100" (string)
   * Response: "$100.00" (formatted string from PostgreSQL)
   */
  private compareMoneyValues(inputValue: any, responseValue: any): { isMoney: boolean, matches: boolean } {
    // Response must be a formatted money string (starts with $ or currency symbol)
    if (typeof responseValue !== 'string' || !responseValue.match(/^[\$€£¥]/)) {
      return { isMoney: false, matches: false };
    }

    try {
      // Parse both to numeric values for comparison
      const inputNumeric = typeof inputValue === 'number' ? inputValue : parseFloat(String(inputValue).replace(/[^0-9.-]/g, ''));
      const responseNumeric = parseFloat(responseValue.replace(/[^0-9.-]/g, ''));

      if (isNaN(inputNumeric) || isNaN(responseNumeric)) {
        return { isMoney: false, matches: false };
      }

      // Compare with small epsilon for floating point precision
      const matches = Math.abs(inputNumeric - responseNumeric) < 0.01;

      return { isMoney: true, matches };
    } catch (error) {
      return { isMoney: false, matches: false };
    }
  }

  /**
   * Compares hex color values (case-insensitive).
   * Input: "#3b82f6" or "#3B82F6" (from HTML5 color picker)
   * Response: "#3b82f6" or "#3B82F6" (from database)
   */
  private compareColorValues(inputValue: any, responseValue: any): { isColor: boolean, matches: boolean } {
    if (typeof inputValue !== 'string' || typeof responseValue !== 'string') {
      return { isColor: false, matches: false };
    }

    // Check if both values look like hex colors (#RRGGBB format)
    const hexColorPattern = /^#[0-9A-Fa-f]{6}$/;
    if (!hexColorPattern.test(inputValue) || !hexColorPattern.test(responseValue)) {
      return { isColor: false, matches: false };
    }

    // Compare case-insensitively
    const matches = inputValue.toUpperCase() === responseValue.toUpperCase();
    return { isColor: true, matches };
  }

  /**
   * Compares time_slot (tstzrange) values.
   * Input: [2025-11-07T15:00:00Z,2025-11-07T22:00:00Z) (ISO 8601 format we send)
   * Response: [\"2025-11-07 15:00:00+00\",\"2025-11-07 22:00:00+00\") (PostgreSQL format with escaped quotes)
   */
  private compareTimeSlotValues(inputValue: any, responseValue: any): { isTimeSlot: boolean, matches: boolean } {
    if (typeof inputValue !== 'string' || typeof responseValue !== 'string') {
      return { isTimeSlot: false, matches: false };
    }

    // Check if both values look like tstzrange format: [start,end)
    const tstzrangePattern = /^\[.+,.+\)$/;
    if (!tstzrangePattern.test(inputValue) || !tstzrangePattern.test(responseValue)) {
      return { isTimeSlot: false, matches: false };
    }

    try {
      // Parse both values to extract start and end timestamps
      const parseRange = (range: string): { start: string, end: string } | null => {
        // Handle both formats:
        // - ISO: [2025-11-07T15:00:00Z,2025-11-07T22:00:00Z)
        // - PG:  [\"2025-11-07 15:00:00+00\",\"2025-11-07 22:00:00+00\")
        const match = range.match(/\[\"?([^\",]+)\"?,\s*\"?([^\")]+)\"?\)/);
        if (!match) return null;
        return { start: match[1], end: match[2] };
      };

      const inputParsed = parseRange(inputValue);
      const responseParsed = parseRange(responseValue);

      if (!inputParsed || !responseParsed) {
        return { isTimeSlot: false, matches: false };
      }

      // Normalize timestamps to ISO 8601 for comparison
      const normalizeTimestamp = (ts: string): string => {
        // Convert "2025-11-07 15:00:00+00" to "2025-11-07T15:00:00Z"
        return ts.replace(' ', 'T').replace(/\+00$/, 'Z');
      };

      const inputStartNormalized = normalizeTimestamp(inputParsed.start);
      const inputEndNormalized = normalizeTimestamp(inputParsed.end);
      const responseStartNormalized = normalizeTimestamp(responseParsed.start);
      const responseEndNormalized = normalizeTimestamp(responseParsed.end);

      // Compare as Date objects to handle any remaining format quirks
      const inputStartDate = new Date(inputStartNormalized).getTime();
      const inputEndDate = new Date(inputEndNormalized).getTime();
      const responseStartDate = new Date(responseStartNormalized).getTime();
      const responseEndDate = new Date(responseEndNormalized).getTime();

      const matches = inputStartDate === responseStartDate && inputEndDate === responseEndDate;

      return { isTimeSlot: true, matches };
    } catch (error) {
      // Error parsing - not a time_slot field
      return { isTimeSlot: false, matches: false };
    }
  }

  /**
   * Compares geography/geometry fields by converting EWKB to EWKT.
   * Input: EWKT format like "SRID=4326;POINT(-83 43)"
   * Response: EWKB hex format like "0101000020E6100000..."
   */
  private compareGeographyValues(inputValue: any, responseValue: any): { isGeography: boolean, matches: boolean } {
    if (typeof inputValue !== 'string' || typeof responseValue !== 'string') {
      return { isGeography: false, matches: false };
    }

    // Check if input looks like EWKT (starts with SRID= or is WKT geometry type)
    const isInputEWKT = inputValue.startsWith('SRID=') ||
                        /^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*\(/i.test(inputValue);

    // Check if response looks like EWKB hex (long hex string starting with 01)
    const isResponseEWKB = /^01[0-9A-F]{10,}$/i.test(responseValue);

    if (!isInputEWKT || !isResponseEWKB) {
      return { isGeography: false, matches: false };
    }

    try {
      // Parse EWKB to EWKT
      const responseEWKT = this.parseEWKBPoint(responseValue);

      if (!responseEWKT) {
        // Could not parse EWKB - only POINT geometries are supported
        // Fall back to trusting PostgREST for complex geometries
        return { isGeography: true, matches: true };
      }

      // Normalize: strip SRID, normalize case and whitespace
      const stripSRID = (ewkt: string) => ewkt.replace(/^SRID=\d+;/i, '');
      const normalizedInput = stripSRID(inputValue).toUpperCase().replace(/\s+/g, ' ').trim();
      const normalizedResponse = stripSRID(responseEWKT).toUpperCase().replace(/\s+/g, ' ').trim();

      const matches = normalizedInput === normalizedResponse;

      return { isGeography: true, matches };
    } catch (error) {
      // Error converting EWKB to EWKT - fall back to trusting PostgREST
      return { isGeography: true, matches: true };
    }
  }

  private checkEditResult(input: any, representation: any) {
    // If it's already an error response, return it as-is
    if (representation?.success === false) {
      return representation;
    }

    let identical: boolean;
    if(representation?.body?.[0] === undefined) {
      // Empty response - likely RLS blocking SELECT after UPDATE
      // This could be due to permissions, token expiration, or validation issues
      // Note: Token expiration is handled by explicit refresh in create/edit pages
      identical = false;
    } else {
      identical = (representation !== undefined) && Object.keys(input).every(key => {
        const inputValue = input[key];
        const responseValue = representation.body[0][key];

        // Handle FK fields: PostgREST returns embedded objects {id: 1, display_name: "..."}
        // but we submit primitive IDs
        let match: boolean;
        if (responseValue && typeof responseValue === 'object' && 'id' in responseValue) {
          // FK field returned as embedded object - compare with id property
          match = inputValue == responseValue.id;  // Use == for type coercion
        } else {
          // Check if this is a geography field and compare properly
          const geoComparison = this.compareGeographyValues(inputValue, responseValue);
          if (geoComparison.isGeography) {
            match = geoComparison.matches;
          } else {
            // Check if this is a datetime field and compare properly
            const dateTimeComparison = this.compareDateTimeValues(inputValue, responseValue);
            if (dateTimeComparison.isDateTime) {
              match = dateTimeComparison.matches;
            } else {
              // Check if this is a money field and compare properly
              const moneyComparison = this.compareMoneyValues(inputValue, responseValue);
              if (moneyComparison.isMoney) {
                match = moneyComparison.matches;
              } else {
                // Check if this is a hex color field and compare properly (case-insensitive)
                const colorComparison = this.compareColorValues(inputValue, responseValue);
                if (colorComparison.isColor) {
                  match = colorComparison.matches;
                } else {
                  // Check if this is a time_slot field and compare properly
                  const timeSlotComparison = this.compareTimeSlotValues(inputValue, responseValue);
                  if (timeSlotComparison.isTimeSlot) {
                    match = timeSlotComparison.matches;
                  } else {
                    // Primitive value - use loose equality to handle string vs number (e.g., "4" vs 4)
                    match = inputValue == responseValue;  // Use == for type coercion
                  }
                }
              }
            }
          }
        }

        return match;
      });
    }

    if (identical) {
      return <ApiResponse>{success: true, body: representation.body};
    } else {
      return <ApiResponse>{
        success: false,
        error: {
          httpCode: 400,
          message: "The update was not applied. The returned data does not match the submitted data.",
          humanMessage: "Could not update",
          hint: "Please verify your changes and try again. If the problem persists, contact support."
        }
      };
    }
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

    error.humanMessage = ErrorService.parseToHuman(error);
    let resp: ApiResponse = {success: false, error: error};
    return of(resp);
  }

  /**
   * Get both preview records and total count in a single optimized request.
   * Uses PostgREST's Prefer: count=exact header to get total count in Content-Range
   * while fetching limited preview records - reduces HTTP requests from 2N to N.
   */
  public getInverseRelationshipPreview(
    sourceTable: string,
    filterColumn: string,
    filterValue: any,
    limit: number = 5
  ): Observable<{ records: EntityData[], totalCount: number }> {
    const url = `${sourceTable}?${filterColumn}=eq.${filterValue}&select=id,display_name&limit=${limit}`;

    return this.http.get<EntityData[]>(getPostgrestUrl() + url, {
      observe: 'response',
      headers: {
        'Prefer': 'count=exact'
      }
    }).pipe(
      map(response => {
        const records = response.body || [];

        // Parse count from Content-Range header: "0-4/15" -> 15
        const contentRange = response.headers.get('Content-Range');
        let totalCount = 0;
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)$/);
          totalCount = match ? parseInt(match[1], 10) : records.length;
        }

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
      meta.previewLimit
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
   * Input:  [{Tag: {id: 1, display_name: 'Urgent'}}, {Tag: {id: 2, display_name: 'Road'}}]
   * Output: [{id: 1, display_name: 'Urgent'}, {id: 2, display_name: 'Road'}]
   *
   * @param junctionData Array of junction records with embedded related entities
   * @param relatedTable Name of the related table (used as key in PostgREST embedded resource)
   * @returns Flattened array of related entity objects
   */
  public static transformManyToManyData(junctionData: any[], relatedTable: string): any[] {
    if (!junctionData || !Array.isArray(junctionData)) {
      return [];
    }

    return junctionData
      .map(record => record[relatedTable])
      .filter(item => item !== null && item !== undefined);
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
    targetId: number
  ): Observable<ApiResponse> {
    return this.http.post(
      getPostgrestUrl() + meta.junctionTable,
      {
        [meta.sourceColumn]: entityId,
        [meta.targetColumn]: targetId
      },
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
    targetId: number
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
}
