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

import { computed, effect, inject, Injectable, Injector, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { KEYCLOAK_EVENT_SIGNAL, KeycloakEventType, ReadyArgs, typeEventArgs } from 'keycloak-angular';
import { catchError, defer, EMPTY, Subject, switchMap } from 'rxjs';
import {
  getAppTitle,
  getLocaleConfig,
  getMapConfig,
  getMatomoConfig,
  getPostgrestUrl,
  getPwaAppNameOverride,
  getSmsConfig,
  getStripePublishableKey,
  getThemeConfig,
} from '../config/runtime';
import { isVettedTheme } from '../constants/themes';

/** Row shape of the `public.instance_config` view (only the columns the client reads). */
interface InstanceConfigRow {
  config_key: string;
  config_value: string | null;
}

/** localStorage key holding the last config snapshot, so the first paint already has it. */
const STORAGE_KEY = 'civic-os-config';

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * Resolves Tier 2 runtime configuration (the `metadata.instance_config` store).
 *
 * Every value resolves DB -> ENV -> built-in default. `config/runtime.ts` stays
 * ENV-only; this service layers the database values on top of those helpers.
 *
 * The last successful load is mirrored to localStorage and read back
 * synchronously in the constructor, so consumers that run before the first HTTP
 * response (theme, locale, title) already see the instance's values.
 *
 * An invalid DB value never throws: it falls back to the ENV value.
 */
@Injectable({
  providedIn: 'root'
})
export class ConfigService {
  private readonly injector = inject(Injector);
  private readonly keycloakSignal = inject(KEYCLOAK_EVENT_SIGNAL, { optional: true });

  /** Non-null, non-empty DB values keyed by `config_key`. */
  private readonly values = signal<Record<string, string>>(this.readBlob());

  private readonly _settled = signal(false);

  /**
   * True once the first network load attempt has finished (success or error). Never reset.
   * The localStorage blob does not settle it: consumers that must not act on a possibly stale
   * value (Matomo) wait for this.
   */
  readonly settled = this._settled.asReadonly();

  /** Each emission starts a load; `switchMap` cancels the one still in flight (latest wins). */
  private readonly loadRequests = new Subject<void>();

  // ─── Typed accessors ───────────────────────────────────────────

  readonly appTitle = computed<string>(() => {
    const db = this.values()['app_title']?.trim();
    return db ? db : getAppTitle();
  });

  readonly defaultTheme = computed<string>(() => {
    const db = this.values()['default_theme'];
    return db && isVettedTheme(db) ? db : getThemeConfig().defaultTheme;
  });

  readonly defaultLocale = computed<string>(() => {
    const db = this.values()['default_locale'];
    return db && LOCALE_PATTERN.test(db) ? db : getLocaleConfig().defaultLocale;
  });

  readonly supportedLocales = computed<string[]>(() => {
    const db = this.values()['supported_locales'];
    if (db) {
      const codes = db.split(',').map(c => c.trim()).filter(c => c.length > 0);
      if (codes.length > 0) return codes;
    }
    return getLocaleConfig().supportedLocales;
  });

  readonly smsConfigured = computed<boolean>(() =>
    this.parseBoolean(this.values()['sms_configured']) ?? getSmsConfig().configured
  );

  readonly matomoEnabled = computed<boolean>(() =>
    this.parseBoolean(this.values()['matomo_enabled']) ?? getMatomoConfig().enabled
  );

  /** Lat, lng and zoom resolve independently: DB value, else the ENV (or environment.ts) value. */
  readonly mapDefaults = computed<{ center: [number, number]; zoom: number }>(() => {
    const values = this.values();
    const env = getMapConfig();
    const lat = this.parseNumber(values['map_default_lat']) ?? env.defaultCenter[0];
    const lng = this.parseNumber(values['map_default_lng']) ?? env.defaultCenter[1];
    const zoom = this.parseInteger(values['map_default_zoom']) ?? env.defaultZoom;
    return { center: [lat, lng], zoom };
  });

  readonly stripePublishableKey = computed<string>(() => {
    const db = this.values()['stripe_publishable_key']?.trim();
    return db ? db : (getStripePublishableKey() || '');
  });

  /** Install-banner / manifest name: the ENV `PWA_APP_NAME` if set, else the (DB-resolved) app title. */
  readonly pwaAppName = computed<string>(() => getPwaAppNameOverride() || this.appTitle());

  constructor() {
    this.loadRequests.pipe(
      switchMap(() =>
        // defer: HttpClient is resolved lazily so constructing ConfigService never requires it
        // (many component specs do not provide HttpClient). A throw here is caught like an HTTP error.
        defer(() => this.injector.get(HttpClient).get<InstanceConfigRow[]>(
          `${getPostgrestUrl()}instance_config?select=config_key,config_value`
        )).pipe(
          catchError(err => {
            // Missing table on an older DB, or offline: keep whatever we have.
            console.warn('Failed to load instance config; keeping current values:', err);
            this._settled.set(true);
            return EMPTY;
          })
        )
      )
    ).subscribe(rows => {
      this.applyRows(rows);
      this._settled.set(true);
    });

    // Reload on login (authenticated users see non-public rows) and logout (drop them).
    // AuthService is deliberately not injected here: it would create a dependency cycle.
    effect(() => {
      const event = this.keycloakSignal?.();
      if (!event) return;
      untracked(() => {
        if (event.type === KeycloakEventType.Ready) {
          if (typeEventArgs<ReadyArgs>(event.args)) this.load();
        } else if (event.type === KeycloakEventType.AuthLogout) {
          this.load();
        }
      });
    });
  }

  /**
   * Fetch the config rows visible to the current caller and replace the held values.
   * A newer call cancels one still in flight, so a late anonymous response can never
   * overwrite an authenticated one.
   */
  load(): void {
    this.loadRequests.next();
  }

  /** Called by the schema-version guard when the `instance_config` cache version moves. */
  invalidateCache(): void {
    this.load();
  }

  /** Raw DB value for a key, or null when unset. */
  dbValue(key: string): string | null {
    return this.values()[key] ?? null;
  }

  /**
   * The ENV-resolved value for a key, formatted the way the DB stores it
   * (booleans as 'true'/'false', numbers via String(), locale list joined with ',').
   * Null for a key the framework does not know.
   */
  envValue(key: string): string | null {
    switch (key) {
      case 'app_title': return getAppTitle();
      case 'default_theme': return getThemeConfig().defaultTheme;
      case 'default_locale': return getLocaleConfig().defaultLocale;
      case 'supported_locales': return getLocaleConfig().supportedLocales.join(',');
      case 'sms_configured': return String(getSmsConfig().configured);
      case 'matomo_enabled': return String(getMatomoConfig().enabled);
      case 'map_default_lat': return String(getMapConfig().defaultCenter[0]);
      case 'map_default_lng': return String(getMapConfig().defaultCenter[1]);
      case 'map_default_zoom': return String(getMapConfig().defaultZoom);
      case 'stripe_publishable_key': return getStripePublishableKey() || '';
      default: return null;
    }
  }

  // ─── Internals ─────────────────────────────────────────────────

  private applyRows(rows: unknown): void {
    if (!Array.isArray(rows)) {
      console.warn('Unexpected instance config response; keeping current values');
      return;
    }
    const next: Record<string, string> = {};
    for (const row of rows as Partial<InstanceConfigRow>[]) {
      if (row && typeof row.config_key === 'string' && typeof row.config_value === 'string' && row.config_value !== '') {
        next[row.config_key] = row.config_value;
      }
    }
    this.values.set(next);
    this.writeBlob(next);
  }

  private readBlob(): Record<string, string> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      const values = (parsed as { values?: unknown } | null)?.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        this.discardBlob();
        return {};
      }
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== 'string') {
          this.discardBlob();
          return {};
        }
        if (value !== '') result[key] = value;
      }
      return result;
    } catch {
      this.discardBlob();
      return {};
    }
  }

  private writeBlob(values: Record<string, string>): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ values }));
    } catch { /* storage full or unavailable */ }
  }

  private discardBlob(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* storage unavailable */ }
  }

  private parseBoolean(value: string | undefined): boolean | null {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  }

  private parseNumber(value: string | undefined): number | null {
    if (value === undefined || value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private parseInteger(value: string | undefined): number | null {
    const n = this.parseNumber(value);
    return n !== null && Number.isInteger(n) ? n : null;
  }
}
