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
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { interval, of, switchMap, catchError, EMPTY } from 'rxjs';
import { AuthService } from './auth.service';
import { LocaleService } from './locale.service';

/**
 * Hardcoded maintenance UI strings per locale.
 * These are NOT loaded via the translation service because in full maintenance
 * mode the translations RPC is blocked. Strings are baked into the build.
 */
const MAINTENANCE_STRINGS: Record<string, Record<string, string>> = {
  en: {
    readonly_message: 'The system is in read-only mode for scheduled maintenance. You can view data but cannot make changes.',
    full_message: 'The system is temporarily unavailable for scheduled maintenance. Please check back shortly.',
    full_title: 'System Maintenance',
    admin_bypass: 'Admin access active — system is in maintenance mode',
  },
  es: {
    readonly_message: 'El sistema está en modo de solo lectura por mantenimiento programado. Puede ver los datos pero no realizar cambios.',
    full_message: 'El sistema no está disponible temporalmente por mantenimiento programado. Por favor, vuelva a intentarlo en breve.',
    full_title: 'Mantenimiento del sistema',
    admin_bypass: 'Acceso de administrador activo — el sistema está en modo de mantenimiento',
  },
  ar: {
    readonly_message: 'النظام في وضع القراءة فقط للصيانة المجدولة. يمكنك عرض البيانات ولكن لا يمكنك إجراء تغييرات.',
    full_message: 'النظام غير متاح مؤقتًا للصيانة المجدولة. يرجى المحاولة مرة أخرى قريبًا.',
    full_title: 'صيانة النظام',
    admin_bypass: 'وصول المسؤول نشط — النظام في وضع الصيانة',
  },
  fr: {
    readonly_message: 'Le système est en mode lecture seule pour une maintenance planifiée. Vous pouvez consulter les données mais ne pouvez pas effectuer de modifications.',
    full_message: 'Le système est temporairement indisponible pour une maintenance planifiée. Veuillez réessayer sous peu.',
    full_title: 'Maintenance du système',
    admin_bypass: 'Accès administrateur actif — le système est en mode maintenance',
  },
  de: {
    readonly_message: 'Das System befindet sich im Nur-Lese-Modus für geplante Wartungsarbeiten. Sie können Daten einsehen, aber keine Änderungen vornehmen.',
    full_message: 'Das System ist vorübergehend wegen geplanter Wartungsarbeiten nicht verfügbar. Bitte versuchen Sie es in Kürze erneut.',
    full_title: 'Systemwartung',
    admin_bypass: 'Administratorzugang aktiv — System befindet sich im Wartungsmodus',
  },
  ps: {
    readonly_message: 'سیستم د پلان شوي ساتنې لپاره د یوازې لوستلو حالت کې دی. تاسو کولی شئ معلومات وګورئ مګر بدلونونه نشئ کولی.',
    full_message: 'سیستم د پلان شوي ساتنې لپاره په لنډمهاله توګه شتون نلري. مهرباني وکړئ لږ وروسته بیا هڅه وکړئ.',
    full_title: 'د سیستم ساتنه',
    admin_bypass: 'د مدیر لاسرسی فعال دی — سیستم د ساتنې حالت کې دی',
  },
};

/**
 * Tracks application maintenance mode state from two sources:
 * 1. PostgREST response headers / 503 errors (via the maintenance interceptor)
 * 2. Polling /maintenance.json — only while maintenance is active, to detect recovery
 *
 * Detection flow:
 * - Normal operation: zero polling overhead. The interceptor piggybacks on every
 *   PostgREST response to detect the X-Maintenance-Mode header or 503 errors.
 * - Once active: polls /maintenance.json every 30s so idle users learn when it ends.
 * - On recovery: poll returns {"mode":"off"}, polling stops automatically.
 * - On app init: one-shot fetch of /maintenance.json catches the "container restarted
 *   with maintenance mode" case before the first API call completes.
 *
 * UI strings are hardcoded (not fetched via TranslationService) because in
 * full maintenance mode the translations RPC is blocked by check_jwt().
 */
@Injectable({ providedIn: 'root' })
export class MaintenanceService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly locale = inject(LocaleService);
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

  // Hardcoded locale-aware display strings
  readonly fullTitle = computed(() => this.getString('full_title'));
  readonly fullMessage = computed(() => this._message() || this.getString('full_message'));
  readonly readonlyMessage = computed(() => this._message() || this.getString('readonly_message'));
  readonly adminBypassMessage = computed(() => this.getString('admin_bypass'));

  /** Resolve a hardcoded string for the current locale (falls back to English) */
  private getString(key: string): string {
    const lang = this.locale.locale();
    const strings = MAINTENANCE_STRINGS[lang] || MAINTENANCE_STRINGS['en'];
    return strings[key] || MAINTENANCE_STRINGS['en'][key] || key;
  }

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
    // One-shot init check: detect maintenance on fresh page load before the
    // first PostgREST call completes (covers "container restarted in maintenance").
    this.fetchMaintenanceJson().pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(data => this.applyPollData(data));

    // Conditional polling: only poll while maintenance is active to detect recovery.
    // When isActive becomes true (set by interceptor or init check), start polling
    // every 30s. When it becomes false (poll returns mode=off), stop automatically.
    // Normal operation = zero polling overhead.
    toObservable(this.isActive).pipe(
      switchMap(active => active
        ? interval(30_000).pipe(
            switchMap(() => this.fetchMaintenanceJson())
          )
        : EMPTY
      ),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(data => this.applyPollData(data));
  }

  private fetchMaintenanceJson() {
    return this.http.get<{ mode: string; message?: string }>('/maintenance.json', {
      headers: { 'Cache-Control': 'no-cache' }
    }).pipe(
      catchError(() => of(null))  // 404 (local dev) = no-op
    );
  }

  private applyPollData(data: { mode: string; message?: string } | null): void {
    if (data) {
      this._mode.set(data.mode as 'off' | 'readonly' | 'full');
      this._message.set(data.message || null);
    }
  }
}
