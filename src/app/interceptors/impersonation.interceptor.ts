/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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
import { ImpersonationService } from '../services/impersonation.service';
import { getPostgrestUrl } from '../config/runtime';

/**
 * HTTP interceptor that adds the X-Impersonate-Roles header when impersonation is active.
 *
 * Only adds the header to requests going to the PostgREST API.
 * The database's get_user_roles() function checks this header (only for real admins)
 * and returns the impersonated roles instead of the actual JWT roles.
 */
export const impersonationInterceptor: HttpInterceptorFn = (req, next) => {
  const impersonationService = inject(ImpersonationService);

  // Only add header to PostgREST requests
  const postgrestUrl = getPostgrestUrl();
  if (!req.url.startsWith(postgrestUrl)) {
    return next(req);
  }

  // Get the header value (null if not impersonating)
  const headerValue = impersonationService.headerValue();
  if (!headerValue) {
    return next(req);
  }

  // Clone request and add impersonation header
  const clonedReq = req.clone({
    setHeaders: {
      'X-Impersonate-Roles': headerValue
    }
  });

  return next(clonedReq);
};
