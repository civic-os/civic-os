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

import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval, of, startWith, switchMap, catchError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Tracks application maintenance mode state from two sources:
 * 1. PostgREST response headers / 503 errors (via the maintenance interceptor)
 * 2. Polling /maintenance.json for idle-user detection
 *
 * Modes: 'off' (normal), 'readonly' (reads allowed, writes blocked),
 * 'full' (all access blocked for non-admins).
 */
@Injectable({ providedIn: 'root' })
export class MaintenanceService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  // Private writable signals
  private readonly _mode = signal<'off' | 'readonly' | 'full'>('off');
  private readonly _message = signal<string | null>(null);

  // Public readonly signals
  readonly mode = this._mode.asReadonly();
  readonly message = this._message.asReadonly();
  readonly isReadOnly = computed(() => this._mode() === 'readonly');
  readonly isFullMaintenance = computed(() => this._mode() === 'full');
  readonly isActive = computed(() => this._mode() !== 'off');
  readonly isAdminBypassing = computed(() => this.isActive() && this.auth.isAdmin());

  /** Called from the maintenance interceptor on response header detection */
  updateFromHeader(headerValue: string): void {
    if (headerValue.endsWith('-admin')) {
      // Admin bypass - extract base mode
      const baseMode = headerValue.replace('-admin', '') as 'readonly' | 'full';
      this._mode.set(baseMode);
    } else {
      this._mode.set(headerValue as 'readonly' | 'full');
    }
  }

  /** Called from the maintenance interceptor when a PostgREST response has no header */
  clearFromInterceptor(): void {
    this._mode.set('off');
    this._message.set(null);
  }

  /** Called from the maintenance interceptor on 503 error */
  updateFromError(error: HttpErrorResponse): void {
    const hint = error.error?.hint || error.error?.message || '';
    if (hint.includes('read-only')) {
      this._mode.set('readonly');
    } else {
      this._mode.set('full');
    }
  }

  constructor() {
    // Poll /maintenance.json every 30 seconds (+ immediate first check)
    interval(30_000).pipe(
      startWith(0),
      switchMap(() => this.http.get<{ mode: string; message?: string }>('/maintenance.json', {
        headers: { 'Cache-Control': 'no-cache' }
      }).pipe(
        catchError(() => of(null))  // 404 = no maintenance file
      )),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(data => {
      if (data) {
        // File exists — update from its contents (could be 'off', 'readonly', or 'full')
        const mode = data.mode as 'off' | 'readonly' | 'full';
        this._mode.set(mode);
        this._message.set(data.message || null);
      }
      // File missing (404) → no-op. Keep current state from interceptor.
      // Only the interceptor or an explicit maintenance.json with mode='off' can clear.
    });
  }
}
