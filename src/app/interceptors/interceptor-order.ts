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
import { includeBearerTokenInterceptor } from 'keycloak-angular';
import { impersonationInterceptor } from './impersonation.interceptor';
import { localeInterceptor } from './locale.interceptor';
import { maintenanceInterceptor } from './maintenance.interceptor';
import { authErrorInterceptor } from './auth-error.interceptor';
import { errorTrackingInterceptor } from './error-tracking.interceptor';

/**
 * The HTTP interceptor chain, outermost first. Kept out of app.config.ts so
 * specs can drive real requests through the same chain the app runs without
 * loading the whole app graph (which pulls in markdown-sanitize.ts and binds it
 * to the real dompurify for the rest of the worker under isolate: false).
 */
export const HTTP_INTERCEPTORS_IN_ORDER: readonly HttpInterceptorFn[] = [
  includeBearerTokenInterceptor,
  impersonationInterceptor,   // Adds X-Impersonate-Roles header when admin is impersonating
  localeInterceptor,          // Adds Accept-Language header for i18n translation lookup
  maintenanceInterceptor,     // Detects maintenance mode from PostgREST response headers / 503
  authErrorInterceptor,       // Safety net: redirects to login on 401 for authenticated users
  errorTrackingInterceptor    // Logs all HTTP errors to Matomo analytics
];
