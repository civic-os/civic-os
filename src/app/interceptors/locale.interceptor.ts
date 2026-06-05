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

import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { LocaleService } from '../services/locale.service';
import { getPostgrestUrl } from '../config/runtime';

/**
 * HTTP interceptor that adds the Accept-Language header to PostgREST requests.
 *
 * PostgREST forwards custom headers as PostgreSQL session settings
 * (request.header.accept-language), which metadata.t() reads to determine
 * which locale's translations to return.
 *
 * Only applies to PostgREST requests — other requests (Keycloak, S3, etc.)
 * are passed through unchanged.
 */
export const localeInterceptor: HttpInterceptorFn = (req, next) => {
  const localeService = inject(LocaleService);

  // Only add header to PostgREST requests
  const postgrestUrl = getPostgrestUrl();
  if (!req.url.startsWith(postgrestUrl)) {
    return next(req);
  }

  const locale = localeService.locale();

  // Skip header for English (the default) — reduces request overhead
  if (locale === 'en') {
    return next(req);
  }

  return next(req.clone({
    setHeaders: { 'Accept-Language': locale }
  }));
};
