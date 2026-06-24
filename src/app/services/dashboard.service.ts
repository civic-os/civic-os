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
import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { Observable, catchError, map, of, tap } from 'rxjs';
import { Dashboard, DashboardWidget, WidgetType } from '../interfaces/dashboard';
import { ApiResponse } from '../interfaces/api';
import { getPostgrestUrl } from '../config/runtime';
import { LocaleService } from './locale.service';

/**
 * Dashboard Service
 *
 * Handles all API interactions for dashboards and widgets.
 * - Uses RPC functions to access metadata.dashboards tables
 * - Caches dashboard list for performance
 * - Provides CRUD operations (Phase 3)
 * - Error handling with ApiResponse pattern
 */
@Injectable({
  providedIn: 'root'
})
export class DashboardService {
  private http = inject(HttpClient);
  private readonly localeService = inject(LocaleService);

  // Cache dashboard list in signal for reactivity
  private dashboardsCache = signal<Dashboard[] | undefined>(undefined);

  // Re-fetch dashboards when locale changes (preparatory for Phase 3 RPC translation)
  // IMPORTANT: refreshCache() reads dashboardsCache signal internally — must use untracked()
  // to prevent it from becoming a tracked dependency and creating an infinite loop.
  private localeEffect = (() => {
    let initial = true;
    return effect(() => {
      this.localeService.locale(); // Track the signal
      if (initial) {
        initial = false;
        return;
      }
      untracked(() => this.refreshCache());
    });
  })();

  /**
   * Get all visible dashboards (public + user's private).
   * Results are cached after first fetch.
   * Calls RPC function get_dashboards().
   *
   * @returns Observable of dashboard array
   */
  getDashboards(): Observable<Dashboard[]> {
    // Return cached dashboards if available
    if (this.dashboardsCache()) {
      return of(this.dashboardsCache()!);
    }

    // Call RPC function
    return this.http.post<Dashboard[]>(
      getPostgrestUrl() + 'rpc/get_dashboards',
      {}
    ).pipe(
      tap(dashboards => {
        this.dashboardsCache.set(dashboards);
      }),
      catchError(error => {
        console.error('[DashboardService] Error fetching dashboards:', error);
        return of([]);
      })
    );
  }

  /**
   * Get a specific dashboard by ID with embedded widgets.
   * Calls RPC function get_dashboard(id).
   *
   * @param id Dashboard ID
   * @returns Observable of dashboard with widgets
   */
  getDashboard(id: number): Observable<Dashboard | undefined> {
    // Call RPC function with dashboard ID
    return this.http.post<Dashboard | null>(
      getPostgrestUrl() + 'rpc/get_dashboard',
      { p_dashboard_id: id }
    ).pipe(
      map(dashboard => {
        // RPC returns null if not found or not accessible
        if (dashboard === null) {
          return undefined;
        }
        return dashboard;
      }),
      catchError(error => {
        console.error(`[DashboardService] Error fetching dashboard ${id}:`, error);
        return of(undefined);
      })
    );
  }

  /**
   * Get user's default dashboard ID (or system default).
   * Calls RPC function get_user_default_dashboard().
   *
   * @returns Observable of dashboard ID
   */
  getDefaultDashboard(): Observable<number | undefined> {
    // Call RPC function to get default dashboard ID
    return this.http.post<number>(
      getPostgrestUrl() + 'rpc/get_user_default_dashboard',
      {}
    ).pipe(
      map(dashboardId => {
        if (dashboardId) {
          return dashboardId;
        }
        return undefined;
      }),
      catchError(error => {
        console.error('[DashboardService] Error fetching default dashboard:', error);
        return of(undefined);
      })
    );
  }

  /**
   * Get default dashboard ID, then fetch the full dashboard.
   * Helper method that combines getDefaultDashboard + getDashboard.
   *
   * @returns Observable of dashboard with widgets
   */
  loadDefaultDashboard(): Observable<Dashboard | undefined> {
    return this.http.post<number>(
      getPostgrestUrl() + 'rpc/get_user_default_dashboard',
      {}
    ).pipe(
      map(dashboardId => {
        if (!dashboardId) {
          throw new Error('No default dashboard found');
        }
        return dashboardId;
      }),
      // Fetch the dashboard by ID
      map(dashboardId => {
        // Return observable for dashboard fetch
        return this.getDashboard(dashboardId);
      }),
      // Flatten the nested observable
      map(observable => {
        let result: Dashboard | undefined;
        observable.subscribe(dashboard => result = dashboard);
        return result;
      }),
      catchError(error => {
        console.error('[DashboardService] Error loading default dashboard:', error);
        return of(undefined);
      })
    );
  }

  /**
   * Get available widget types from metadata.widget_types table.
   * Used for "Add Widget" menu (Phase 3).
   *
   * @returns Observable of widget type array
   */
  getWidgetTypes(): Observable<WidgetType[]> {
    return this.http.get<WidgetType[]>(
      getPostgrestUrl() + 'widget_types?is_active=eq.true&order=widget_type.asc'
    ).pipe(
      catchError(error => {
        console.error('[DashboardService] Error fetching widget types:', error);
        return of([]);
      })
    );
  }

  /**
   * Save dashboard metadata (Phase 3).
   * Creates new dashboard or updates existing.
   *
   * @param dashboard Dashboard to save
   * @returns Observable of API response
   */
  saveDashboard(dashboard: Partial<Dashboard>): Observable<ApiResponse> {
    // TODO: Implement in Phase 3
    return of({
      success: false,
      error: {
        message: 'Not implemented (Phase 3)',
        httpCode: 501,
        humanMessage: 'This feature is not yet implemented'
      }
    });
  }

  /**
   * Delete dashboard (Phase 3).
   *
   * @param id Dashboard ID to delete
   * @returns Observable of API response
   */
  deleteDashboard(id: number): Observable<ApiResponse> {
    // TODO: Implement in Phase 3
    return of({
      success: false,
      error: {
        message: 'Not implemented (Phase 3)',
        httpCode: 501,
        humanMessage: 'This feature is not yet implemented'
      }
    });
  }

  /**
   * Save widget configuration (Phase 3).
   * Creates new widget or updates existing.
   *
   * @param widget Widget to save
   * @returns Observable of API response
   */
  saveWidget(widget: Partial<DashboardWidget>): Observable<ApiResponse> {
    // TODO: Implement in Phase 3
    return of({
      success: false,
      error: {
        message: 'Not implemented (Phase 3)',
        httpCode: 501,
        humanMessage: 'This feature is not yet implemented'
      }
    });
  }

  /**
   * Delete widget (Phase 3).
   *
   * @param widgetId Widget ID to delete
   * @returns Observable of API response
   */
  deleteWidget(widgetId: number): Observable<ApiResponse> {
    // TODO: Implement in Phase 3
    return of({
      success: false,
      error: {
        message: 'Not implemented (Phase 3)',
        httpCode: 501,
        humanMessage: 'This feature is not yet implemented'
      }
    });
  }

  /**
   * Refresh dashboards cache.
   * Call this after creating/updating/deleting dashboards.
   */
  refreshCache(): void {
    this.dashboardsCache.set(undefined);
    this.getDashboards().subscribe(); // Trigger re-fetch
  }
}
