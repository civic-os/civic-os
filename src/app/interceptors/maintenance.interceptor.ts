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

import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { MaintenanceService } from '../services/maintenance.service';
import { getPostgrestUrl } from '../config/runtime';

/**
 * Detects maintenance mode from PostgREST responses:
 * - X-Maintenance-Mode response header (e.g., 'readonly', 'full', 'readonly-admin')
 * - 503 Service Unavailable errors (full maintenance for non-admins)
 *
 * Registered BEFORE authErrorInterceptor so maintenance state is set
 * before auth redirect logic runs.
 */
export const maintenanceInterceptor: HttpInterceptorFn = (req, next) => {
  const maintenanceService = inject(MaintenanceService);
  const postgrestUrl = getPostgrestUrl();

  // Only inspect PostgREST responses
  if (!req.url.startsWith(postgrestUrl)) {
    return next(req);
  }

  return next(req).pipe(
    tap({
      next: (event) => {
        if (event instanceof HttpResponse) {
          const header = event.headers.get('X-Maintenance-Mode');
          if (header) {
            maintenanceService.updateFromHeader(header);
          } else if (maintenanceService.isActive()) {
            // Successful PostgREST response without header = maintenance ended
            maintenanceService.clearFromInterceptor();
          }
        }
      },
      error: (error: HttpErrorResponse) => {
        if (error.status === 503) {
          maintenanceService.updateFromError(error);
        }
      }
    })
  );
};
