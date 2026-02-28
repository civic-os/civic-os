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
import { tap } from 'rxjs';
import Keycloak from 'keycloak-js';
import { AuthService } from '../services/auth.service';
import { getPostgrestUrl } from '../config/runtime';

let isRedirecting = false;

/**
 * Safety-net interceptor that catches 401 responses from PostgREST
 * and redirects authenticated users to re-login.
 *
 * This handles the "zombie auth" scenario where the app thinks the user
 * is logged in but the token has silently expired (e.g., after OS sleep).
 * PostgREST returns 401 when web_anon has no access to a protected table.
 *
 * Registered AFTER includeBearerTokenInterceptor and impersonationInterceptor.
 */
export const authErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const keycloak = inject(Keycloak);
  const postgrestUrl = getPostgrestUrl();

  return next(req).pipe(
    tap({
      error: (error) => {
        if (
          error.status === 401 &&
          req.url.startsWith(postgrestUrl) &&
          authService.authenticated() &&
          !isRedirecting
        ) {
          isRedirecting = true;
          keycloak.login().finally(() => {
            isRedirecting = false;
          });
        }
      }
    })
  );
};
