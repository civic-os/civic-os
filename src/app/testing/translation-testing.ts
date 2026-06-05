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

import { Provider, signal } from '@angular/core';
import { TranslationService } from '../services/translation.service';
import { LocaleService } from '../services/locale.service';
import { EN_TRANSLATIONS } from '../i18n/en.translations';

/**
 * Provides mock TranslationService and LocaleService for unit tests.
 *
 * Breaks the TranslationService → LocaleService → AuthService → Keycloak
 * dependency chain that would otherwise require providing HttpClient and
 * Keycloak tokens in every component test.
 *
 * The mock TranslationService returns English text from the bundled translations,
 * so tests checking rendered text content continue to pass without changes.
 *
 * Usage:
 * ```typescript
 * TestBed.configureTestingModule({
 *   imports: [MyComponent],
 *   providers: [provideTranslationTesting()]
 * });
 * ```
 */
export function provideTranslationTesting(): Provider[] {
  const mockLocaleService = {
    locale: signal('en'),
    supportedLocales: [{ code: 'en', name: 'English' }],
    setLocale: () => {},
    isSupported: (code: string) => code === 'en',
    getLocaleInfo: () => ({ code: 'en', name: 'English' }),
    initFromJwt: () => {}
  };

  const mockTranslationService = {
    version: signal(1),
    loading: signal(false),
    get: (key: string, params?: Record<string, string | number>): string => {
      let text = EN_TRANSLATIONS[key] || key;
      if (params) {
        text = text.replace(/\{\{(\w+)\}\}/g, (match: string, paramKey: string) => {
          const value = params[paramKey];
          return value !== undefined ? String(value) : match;
        });
      }
      return text;
    },
    clearCache: () => {}
  };

  return [
    { provide: LocaleService, useValue: mockLocaleService },
    { provide: TranslationService, useValue: mockTranslationService }
  ];
}
