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

import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, map, of, tap } from 'rxjs';
import { getPostgrestUrl } from '../config/runtime';

const STORAGE_KEY = 'civic_os_impersonation';

interface ImpersonationState {
  active: boolean;
  roles: string[];
}

/**
 * Manages admin role impersonation for testing permissions.
 *
 * Only real admins can use impersonation. When active:
 * - The X-Impersonate-Roles header is sent with all HTTP requests
 * - The database returns impersonated roles instead of real JWT roles
 * - Admin UI is hidden (since isAdmin() returns false)
 * - Settings modal still shows impersonation controls (uses isRealAdmin())
 *
 * State is persisted to localStorage so impersonation survives page refresh.
 */
@Injectable({
  providedIn: 'root'
})
export class ImpersonationService {
  private http = inject(HttpClient);

  private _isActive = signal(false);
  private _impersonatedRoles = signal<string[]>([]);

  /** Whether impersonation is currently active */
  readonly isActive = this._isActive.asReadonly();

  /** The roles being impersonated (empty if not active) */
  readonly impersonatedRoles = this._impersonatedRoles.asReadonly();

  /** Computed header value for HTTP interceptor */
  readonly headerValue = computed(() => {
    if (!this._isActive()) return null;
    return this._impersonatedRoles().join(',');
  });

  constructor() {
    this.loadFromStorage();
  }

  /**
   * Start impersonating the given roles.
   * Logs the action to the audit table.
   *
   * @param roles The roles to impersonate (e.g., ['user'] or ['user', 'editor'])
   * @returns Observable that completes when audit log is recorded
   */
  startImpersonation(roles: string[]): Observable<boolean> {
    if (roles.length === 0) {
      console.warn('Cannot start impersonation with empty roles');
      return of(false);
    }

    return this.logImpersonation(roles, 'start').pipe(
      tap(success => {
        if (success) {
          this._impersonatedRoles.set(roles);
          this._isActive.set(true);
          this.saveToStorage();
        }
      })
    );
  }

  /**
   * Stop impersonation and return to real roles.
   * Logs the action to the audit table.
   *
   * @returns Observable that completes when audit log is recorded
   */
  stopImpersonation(): Observable<boolean> {
    const currentRoles = this._impersonatedRoles();
    if (!this._isActive()) {
      return of(true);
    }

    return this.logImpersonation(currentRoles, 'stop').pipe(
      tap(success => {
        if (success) {
          this._isActive.set(false);
          this._impersonatedRoles.set([]);
          this.clearStorage();
        }
      })
    );
  }

  /**
   * Log impersonation event to the database audit table.
   */
  private logImpersonation(roles: string[], action: 'start' | 'stop'): Observable<boolean> {
    return this.http.post<{ success: boolean; message: string }>(
      getPostgrestUrl() + 'rpc/log_impersonation',
      {
        p_impersonated_roles: roles,
        p_action: action
      }
    ).pipe(
      tap(response => {
        if (!response.success) {
          console.error('Impersonation log failed:', response.message);
        }
      }),
      map(response => response.success),
      catchError(error => {
        // Log error but don't block the operation
        // This might fail if user is not a real admin
        console.error('Failed to log impersonation:', error);
        return of(false);
      })
    );
  }

  /**
   * Load impersonation state from localStorage.
   * Called on service initialization.
   */
  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const state: ImpersonationState = JSON.parse(stored);
        if (state.active && state.roles.length > 0) {
          this._isActive.set(true);
          this._impersonatedRoles.set(state.roles);
        }
      }
    } catch (error) {
      console.error('Failed to load impersonation state:', error);
      this.clearStorage();
    }
  }

  /**
   * Save current state to localStorage.
   */
  private saveToStorage(): void {
    const state: ImpersonationState = {
      active: this._isActive(),
      roles: this._impersonatedRoles()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  /**
   * Clear impersonation state from localStorage.
   */
  private clearStorage(): void {
    localStorage.removeItem(STORAGE_KEY);
  }
}
