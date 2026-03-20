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

export interface CategoryGroup {
  entity_type: string;
  display_name: string | null;
  description: string | null;
  category_count: number;
}

export interface CategoryValue {
  id: number;
  entity_type: string;
  category_key: string;
  display_name: string;
  description: string | null;
  color: string | null;
  sort_order: number;
}

@Injectable({
  providedIn: 'root'
})
export class CategoryAdminService {
  private http = inject(HttpClient);

  getCategoryEntityTypes(): Observable<CategoryGroup[]> {
    return this.http.post<CategoryGroup[]>(
      getPostgrestUrl() + 'rpc/get_category_entity_types',
      {}
    ).pipe(
      catchError((error) => {
        console.error('Error fetching category entity types:', error);
        return of([]);
      })
    );
  }

  getCategoriesForEntity(entityType: string): Observable<CategoryValue[]> {
    return this.http.get<CategoryValue[]>(
      getPostgrestUrl() + `categories?entity_type=eq.${encodeURIComponent(entityType)}&order=sort_order,display_name`
    ).pipe(
      catchError((error) => {
        console.error('Error fetching categories:', error);
        return of([]);
      })
    );
  }

  upsertCategoryGroup(entityType: string, description?: string, displayName?: string): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/upsert_category_group',
      {
        p_entity_type: entityType,
        p_description: description || null,
        p_display_name: displayName || null
      }
    ).pipe(
      map((response) => this.mapJsonbResponse(response)),
      catchError((error) => of(this.errorResponse('Failed to save category group', error)))
    );
  }

  deleteCategoryGroup(entityType: string): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/delete_category_group',
      { p_entity_type: entityType }
    ).pipe(
      map((response) => this.mapJsonbResponse(response)),
      catchError((error) => of(this.errorResponse('Failed to delete category group', error)))
    );
  }

  upsertCategory(
    entityType: string,
    displayName: string,
    description?: string,
    color?: string,
    sortOrder?: number,
    categoryId?: number
  ): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/upsert_category',
      {
        p_entity_type: entityType,
        p_display_name: displayName,
        p_description: description || null,
        p_color: color || '#3B82F6',
        p_sort_order: sortOrder ?? 0,
        p_category_id: categoryId || null
      }
    ).pipe(
      map((response) => this.mapJsonbResponse(response)),
      catchError((error) => of(this.errorResponse('Failed to save category', error)))
    );
  }

  deleteCategory(categoryId: number): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/delete_category',
      { p_category_id: categoryId }
    ).pipe(
      map((response) => this.mapJsonbResponse(response)),
      catchError((error) => of(this.errorResponse('Failed to delete category', error)))
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
