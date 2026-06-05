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

import { Injectable, inject, effect, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { LocaleService } from './locale.service';
import { getPostgrestUrl } from '../config/runtime';
import { EN_TRANSLATIONS } from '../i18n/en.translations';

interface TranslationEntry {
  source_type: string;
  source_key: string;
  translated_text: string;
}

@Injectable({
  providedIn: 'root'
})
export class TranslationService {
  private readonly http = inject(HttpClient);
  private readonly localeService = inject(LocaleService);

  /** Cache: locale → (key → translated text) */
  private readonly cache = new Map<string, Map<string, string>>();

  /** Bundled English fallback strings — loaded synchronously via static import */
  private readonly fallback: Record<string, string> = EN_TRANSLATIONS;

  /** Signal that increments on every successful translation load, so pipes can react */
  private readonly _version = signal(0);
  readonly version = this._version.asReadonly();

  /** Whether translations are currently being loaded */
  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  constructor() {
    // Reload translations whenever locale changes
    effect(() => {
      const locale = this.localeService.locale();
      this.loadTranslations(locale);
    });
  }

  /**
   * Fetch translations for a locale from the database via PostgREST RPC.
   * Results are cached per-locale.
   */
  private loadTranslations(locale: string): void {
    // English uses the bundled fallback — no need to fetch from DB
    if (locale === 'en') {
      this._version.update(v => v + 1);
      return;
    }

    // Check cache
    if (this.cache.has(locale)) {
      this._version.update(v => v + 1);
      return;
    }

    this._loading.set(true);
    this.http.post<TranslationEntry[]>(
      getPostgrestUrl() + 'rpc/get_translations_for_locale',
      { p_locale: locale }
    ).subscribe({
      next: (entries) => {
        const map = new Map<string, string>();
        for (const entry of entries) {
          map.set(entry.source_key, entry.translated_text);
        }
        this.cache.set(locale, map);
        this._loading.set(false);
        this._version.update(v => v + 1);
      },
      error: (err) => {
        console.warn(`Failed to load translations for locale "${locale}":`, err);
        this._loading.set(false);
        // Still bump version so UI doesn't hang waiting
        this._version.update(v => v + 1);
      }
    });
  }

  /**
   * Get a translated string by key.
   *
   * Lookup chain:
   * 1. Cached translations for current locale
   * 2. Bundled English fallback (en.translations.ts)
   * 3. The key itself as a last resort
   *
   * @param key - Translation key (e.g., 'nav.home')
   * @param params - Optional interpolation params (e.g., { count: 5 })
   * @returns Translated string with params interpolated
   */
  get(key: string, params?: Record<string, string | number>): string {
    const locale = this.localeService.locale();
    let text: string | undefined;

    // 1. Try locale-specific cache
    if (locale !== 'en') {
      const localeMap = this.cache.get(locale);
      text = localeMap?.get(key);
    }

    // 2. Try bundled fallback
    if (!text) {
      text = this.fallback[key];
    }

    // 3. Key itself as last resort
    if (!text) {
      text = key;
    }

    // Interpolate params: replace {{param}} with values
    if (params) {
      text = this.interpolate(text, params);
    }

    return text;
  }

  /**
   * Replace {{param}} placeholders in a string with provided values.
   */
  private interpolate(text: string, params: Record<string, string | number>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (match, paramKey) => {
      const value = params[paramKey];
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * Clear cached translations (useful after admin edits translations).
   */
  clearCache(): void {
    this.cache.clear();
    this._version.update(v => v + 1);
  }
}
