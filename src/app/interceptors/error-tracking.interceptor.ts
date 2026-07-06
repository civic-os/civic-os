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

import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { AnalyticsService } from '../services/analytics.service';
import { getPostgrestUrl, getKeycloakConfig, getMatomoConfig } from '../config/runtime';

/**
 * Categorize a request URL into a tracking context.
 *
 * @returns 'API' for PostgREST, 'Auth' for Keycloak, 'External' for everything else
 */
function categorizeRequest(url: string): string {
  if (url.startsWith(getPostgrestUrl())) {
    return 'API';
  }

  const keycloakUrl = getKeycloakConfig().url;
  if (keycloakUrl && url.startsWith(keycloakUrl)) {
    return 'Auth';
  }

  return 'External';
}

/**
 * HTTP interceptor that logs all failed API requests to Matomo analytics.
 *
 * Uses tap({ error }) to observe errors without swallowing them — existing
 * error handling in services (toast messages, redirects) is unaffected.
 *
 * Categorizes requests by URL:
 * - PostgREST → 'API'
 * - Keycloak → 'Auth'
 * - Everything else → 'External'
 *
 * Includes PostgreSQL error codes when present (PostgREST embeds these
 * in the response body as `error.code`).
 *
 * Skips Matomo's own requests to prevent feedback loops.
 *
 * Registered LAST in the interceptor chain so it observes errors after
 * all other interceptors have processed.
 */
export const errorTrackingInterceptor: HttpInterceptorFn = (req, next) => {
  const analytics = inject(AnalyticsService);
  const matomoConfig = getMatomoConfig();

  return next(req).pipe(
    tap({
      error: (error: HttpErrorResponse) => {
        // Skip cancelled/aborted requests (status 0) — normal switchMap behavior, not real errors
        if (error.status === 0) return;

        // Skip Matomo's own requests to avoid feedback loops
        if (matomoConfig.url && req.url.startsWith(matomoConfig.url)) {
          return;
        }

        const context = categorizeRequest(req.url);

        // Include PostgreSQL error code if present (PostgREST errors)
        const pgCode = error.error?.code;
        const label = pgCode
          ? `${context} ${error.status} (PG ${pgCode})`
          : `${context} ${error.status}`;

        analytics.trackError(label, error.status);
      }
    })
  );
};
