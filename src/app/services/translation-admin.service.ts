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

export interface Translation {
  id: number;
  source_type: string;
  source_key: string;
  locale: string;
  translated_text: string;
  created_at: string;
  updated_at: string;
}

export interface MissingTranslation {
  source_type: string;
  source_key: string;
  default_text: string;
}

export interface UpsertTranslation {
  source_type: string;
  source_key: string;
  locale: string;
  translated_text: string;
}

@Injectable({
  providedIn: 'root'
})
export class TranslationAdminService {
  private http = inject(HttpClient);

  /**
   * Get translations for a locale, optionally filtered by source type.
   * Uses PostgREST REST on the public.translations VIEW.
   */
  getTranslations(locale: string, sourceType?: string): Observable<Translation[]> {
    let url = getPostgrestUrl() + `translations?locale=eq.${encodeURIComponent(locale)}&order=source_type,source_key`;
    if (sourceType) {
      // 'dashboard' filter includes 'widget_config' (grouped in UI)
      if (sourceType === 'dashboard') {
        url += `&source_type=in.(dashboard,widget_config)`;
      } else {
        url += `&source_type=eq.${encodeURIComponent(sourceType)}`;
      }
    }
    return this.http.get<Translation[]>(url).pipe(
      catchError((error) => {
        console.error('Error fetching translations:', error);
        return of([]);
      })
    );
  }

  /**
   * Get translations that exist in English but are missing for the target locale.
   * Uses the get_missing_translations RPC.
   */
  getMissingTranslations(targetLocale: string): Observable<MissingTranslation[]> {
    return this.http.post<MissingTranslation[]>(
      getPostgrestUrl() + 'rpc/get_missing_translations',
      { p_target_locale: targetLocale }
    ).pipe(
      catchError((error) => {
        console.error('Error fetching missing translations:', error);
        return of([]);
      })
    );
  }

  /**
   * Bulk upsert translations using the upsert_translations RPC.
   */
  upsertTranslations(translations: UpsertTranslation[]): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/upsert_translations',
      { p_translations: translations }
    ).pipe(
      map(() => ({ success: true } as ApiResponse)),
      catchError((error) => of({
        success: false,
        error: { message: error.message, humanMessage: 'Failed to save translations' }
      } as ApiResponse))
    );
  }

  /**
   * Get all English defaults as a lookup map for displaying in the admin UI.
   * Calls get_translation_defaults() RPC which UNIONs English text from
   * metadata.translations (UI strings) AND source metadata tables (entities,
   * properties, statuses, etc.) where English text lives in the original columns.
   * Returns Map keyed by "source_type:source_key" → default_text.
   */
  getDefaults(): Observable<Map<string, string>> {
    return this.http.post<{ source_type: string; source_key: string; default_text: string }[]>(
      getPostgrestUrl() + 'rpc/get_translation_defaults', {}
    ).pipe(
      map(rows => {
        const m = new Map<string, string>();
        for (const row of rows) {
          if (row.default_text) {
            m.set(`${row.source_type}:${row.source_key}`, row.default_text);
          }
        }
        return m;
      }),
      catchError((error) => {
        console.error('Error fetching English defaults:', error);
        return of(new Map<string, string>());
      })
    );
  }

  /**
   * Delete a single translation by ID via PostgREST REST.
   */
  deleteTranslation(id: number): Observable<ApiResponse> {
    return this.http.delete(
      getPostgrestUrl() + `translations?id=eq.${id}`,
      { headers: { 'Prefer': 'return=minimal' } }
    ).pipe(
      map(() => ({ success: true } as ApiResponse)),
      catchError((error) => of({
        success: false,
        error: { message: error.message, humanMessage: 'Failed to delete translation' }
      } as ApiResponse))
    );
  }
}
