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

import { Injectable, Injector, signal, Signal, computed, effect, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { getLocaleConfig, getPostgrestUrl } from '../config/runtime';
import { AuthService } from './auth.service';

/** Locale metadata for display in settings UI */
export interface LocaleInfo {
  code: string;
  name: string;        // Native name (e.g., "Español")
  englishName: string;  // English name (e.g., "Spanish")
}

/** Locales that use right-to-left script direction */
const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'prs']);

/** Map of supported locales to their display info */
const LOCALE_DISPLAY_NAMES: Record<string, LocaleInfo> = {
  'en': { code: 'en', name: 'English', englishName: 'English' },
  'es': { code: 'es', name: 'Español', englishName: 'Spanish' },
  'fr': { code: 'fr', name: 'Français', englishName: 'French' },
  'de': { code: 'de', name: 'Deutsch', englishName: 'German' },
  'pt': { code: 'pt', name: 'Português', englishName: 'Portuguese' },
  'zh': { code: 'zh', name: '中文', englishName: 'Chinese' },
  'ko': { code: 'ko', name: '한국어', englishName: 'Korean' },
  'ja': { code: 'ja', name: '日本語', englishName: 'Japanese' },
  'ar': { code: 'ar', name: 'العربية', englishName: 'Arabic' },
  'he': { code: 'he', name: 'עברית', englishName: 'Hebrew' },
  'fa': { code: 'fa', name: 'فارسی', englishName: 'Persian' },
  'ur': { code: 'ur', name: 'اردو', englishName: 'Urdu' },
  'ps': { code: 'ps', name: 'پښتو', englishName: 'Pashto' },
  'prs': { code: 'prs', name: 'دری', englishName: 'Dari' },
  'hi': { code: 'hi', name: 'हिन्दी', englishName: 'Hindi' },
  'vi': { code: 'vi', name: 'Tiếng Việt', englishName: 'Vietnamese' },
};

@Injectable({
  providedIn: 'root'
})
export class LocaleService {
  private readonly http = inject(HttpClient);
  private readonly injector = inject(Injector);
  private readonly config = getLocaleConfig();

  private readonly STORAGE_KEY = 'civic-os-locale';

  // Writable locale signal
  private readonly _locale = signal<string>(this.resolveInitialLocale());

  /** Current locale (readonly signal) */
  readonly locale: Signal<string> = this._locale.asReadonly();

  /** Whether the current locale uses right-to-left script direction */
  readonly isRtl = computed(() => RTL_LOCALES.has(this._locale()));

  /** Supported locales for this instance */
  readonly supportedLocales: LocaleInfo[];

  constructor() {
    // Build supported locales list from config
    this.supportedLocales = this.config.supportedLocales.map(code =>
      LOCALE_DISPLAY_NAMES[code] || { code, name: code, englishName: code }
    );

    // Apply locale to document whenever it changes
    effect(() => {
      const loc = this._locale();
      if (typeof document !== 'undefined') {
        document.documentElement.lang = loc;
        document.documentElement.dir = RTL_LOCALES.has(loc) ? 'rtl' : 'ltr';
      }
    });
  }

  /**
   * Resolve initial locale from available sources.
   * Priority: localStorage > navigator.language > instance default > 'en'
   *
   * JWT locale claim would be higher priority, but at service init time
   * the JWT may not be available yet. The app can call setLocale() later
   * once the JWT is decoded.
   */
  private resolveInitialLocale(): string {
    // 1. Check localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        const saved = localStorage.getItem(this.STORAGE_KEY);
        if (saved && this.isSupported(saved)) {
          return saved;
        }
      } catch { /* localStorage unavailable */ }
    }

    // 2. Check browser language
    if (typeof navigator !== 'undefined' && navigator.language) {
      const browserLocale = navigator.language.split('-')[0];
      if (this.isSupported(browserLocale)) {
        return browserLocale;
      }
    }

    // 3. Instance default
    return this.config.defaultLocale;
  }

  /**
   * Check if a locale code is in the supported list
   */
  isSupported(locale: string): boolean {
    return this.config.supportedLocales.includes(locale);
  }

  /**
   * Set the active locale.
   * Updates signal, persists to localStorage, and patches user profile if authenticated.
   */
  setLocale(locale: string): void {
    if (!this.isSupported(locale)) {
      console.warn(`Locale "${locale}" is not in supportedLocales:`, this.config.supportedLocales);
      return;
    }

    this._locale.set(locale);

    // Persist to localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(this.STORAGE_KEY, locale);
      } catch { /* localStorage full or unavailable */ }
    }

    // Persist to user profile if authenticated via RPC
    // (civic_os_users VIEW is non-updatable; RPC writes to civic_os_users_private directly)
    // Lazy-resolve AuthService to avoid circular dependency:
    // SchemaService → LocaleService → AuthService → SchemaService
    const auth = this.injector.get(AuthService);
    if (auth.authenticated()) {
      this.http.post(
        getPostgrestUrl() + 'rpc/set_user_locale',
        { p_locale: locale },
        { headers: { 'Prefer': 'return=minimal' } }
      ).subscribe({
        error: (err) => console.warn('Failed to persist locale to user profile:', err)
      });
    }
  }

  /**
   * Initialize locale from JWT claim (called after auth is ready).
   * Only overrides if JWT has a locale and it's supported.
   */
  initFromJwt(jwtLocale: string | undefined): void {
    if (jwtLocale && this.isSupported(jwtLocale)) {
      this._locale.set(jwtLocale);
      // Also update localStorage to stay in sync
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(this.STORAGE_KEY, jwtLocale);
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Get display info for a locale code
   */
  getLocaleInfo(code: string): LocaleInfo {
    return LOCALE_DISPLAY_NAMES[code] || { code, name: code, englishName: code };
  }
}
