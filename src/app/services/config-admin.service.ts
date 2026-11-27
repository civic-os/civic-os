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

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, map, of, tap } from 'rxjs';
import { ApiError } from '../interfaces/api';
import { getPostgrestUrl } from '../config/runtime';
import { ConfigService } from './config.service';
import { ErrorService } from './error.service';

export type InstanceConfigType =
  'string' | 'integer' | 'number' | 'boolean' | 'json' | 'theme' | 'locale' | 'locale_list';

/** One row of the `public.instance_config` view, ordered by the API (group sort, sort, key). */
export interface InstanceConfigRow {
  config_key: string;
  config_value: string | null;
  /** Used while config_value is NULL. Always NULL for framework keys (their default is the ENV chain). */
  default_value: string | null;
  config_type: InstanceConfigType;
  display_name: string;
  description: string | null;
  group_key: string | null;
  sort_order: number;
  is_public: boolean;
  updated_at: string;
  group_display_name: string | null;
  group_description: string | null;
  group_icon: string | null;
  group_sort_order: number | null;
}

/** Result of `set_instance_config`: the stored (normalized) value, or a readable error. */
export interface SetConfigResult {
  success: boolean;
  config_key?: string;
  config_value?: string | null;
  error?: string;
}

/**
 * One row of `get_instance_secret_status()` (v0.88.0): what /admin/config shows of a secret key.
 * The secret itself never leaves the database; `display_value` follows the key's display rule.
 */
export interface SecretStatusRow {
  config_key: string;
  display_name: string;
  description: string | null;
  group_key: string | null;
  group_display_name: string | null;
  group_description: string | null;
  group_icon: string | null;
  group_sort_order: number | null;
  sort_order: number;
  /** `deployment`: read-only here, set from the worker's environment. `admin`: write-only input. */
  managed_by: 'deployment' | 'admin';
  is_set: boolean;
  display_value: string | null;
  updated_at: string;
}

/** Result of `set_instance_secret`: never the value, only whether one is set. */
export interface SetSecretResult {
  success: boolean;
  is_set?: boolean;
  updated_at?: string;
  error?: string;
}

/** The env var each framework key falls back to. Integrator-defined keys have none. */
export const ENV_VAR_NAMES: Record<string, string> = {
  app_title: 'APP_TITLE',
  default_theme: 'DEFAULT_THEME',
  default_locale: 'DEFAULT_LOCALE',
  supported_locales: 'SUPPORTED_LOCALES',
  sms_configured: 'SMS_CONFIGURED',
  matomo_enabled: 'MATOMO_ENABLED',
  map_default_lat: 'MAP_DEFAULT_LAT',
  map_default_lng: 'MAP_DEFAULT_LNG',
  map_default_zoom: 'MAP_DEFAULT_ZOOM',
  stripe_publishable_key: 'STRIPE_PUBLISHABLE_KEY',
};

@Injectable({
  providedIn: 'root'
})
export class ConfigAdminService {
  private http = inject(HttpClient);
  private config = inject(ConfigService);

  getConfig(): Observable<InstanceConfigRow[]> {
    return this.http.get<InstanceConfigRow[]>(getPostgrestUrl() + 'instance_config');
  }

  /**
   * Writes one value ('' or null stores NULL). Never errors: failures come back as
   * `{ success: false, error }`. A successful write refreshes this tab's ConfigService.
   */
  setValue(key: string, value: string | null): Observable<SetConfigResult> {
    return this.http.post<SetConfigResult>(
      getPostgrestUrl() + 'rpc/set_instance_config',
      { p_key: key, p_value: value }
    ).pipe(
      map((response): SetConfigResult => response?.success === false
        ? { success: false, error: response.error || 'Failed to save setting' }
        : { success: true, config_key: response?.config_key, config_value: response?.config_value ?? null }),
      tap((result) => {
        if (result.success) this.config.invalidateCache();
      }),
      catchError((error) => of<SetConfigResult>({ success: false, error: this.humanize(error) }))
    );
  }

  /**
   * Secret keys for admins (v0.88.0). The RPC refuses anyone else with 42501, so a viewer without
   * the permission gets an empty list rather than an error.
   */
  getSecretStatus(): Observable<SecretStatusRow[]> {
    return this.http.post<SecretStatusRow[]>(getPostgrestUrl() + 'rpc/get_instance_secret_status', {}).pipe(
      catchError(() => of<SecretStatusRow[]>([]))
    );
  }

  /** Writes an admin-managed secret ('' or null clears it). Never errors, like setValue(). */
  setSecret(key: string, value: string | null): Observable<SetSecretResult> {
    return this.http.post<SetSecretResult & { config_key?: string }>(
      getPostgrestUrl() + 'rpc/set_instance_secret',
      { p_key: key, p_value: value }
    ).pipe(
      map((response): SetSecretResult => response?.success === false
        ? { success: false, error: response.error || 'Failed to save setting' }
        : { success: true, is_set: !!response?.is_set, updated_at: response?.updated_at }),
      catchError((error) => of<SetSecretResult>({ success: false, error: this.humanize(error) }))
    );
  }

  private humanize(evt: HttpErrorResponse): string {
    const body = evt?.error && typeof evt.error === 'object' ? evt.error : null;
    const apiError: ApiError = {
      httpCode: evt?.status,
      code: body?.code,
      details: body?.details,
      hint: body?.hint,
      message: body?.message || evt?.statusText || 'Unknown error',
      humanMessage: ''
    };
    return ErrorService.parseToHuman(apiError);
  }
}
