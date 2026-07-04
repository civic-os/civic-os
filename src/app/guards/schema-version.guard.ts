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

import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { map } from 'rxjs';
import { VersionService } from '../services/version.service';
import { SchemaService } from '../services/schema.service';
import { ProfileService } from '../services/profile.service';

/**
 * Navigation guard that checks for schema cache updates before each route activation.
 * Compares database schema versions with locally cached versions and refreshes
 * only the changed caches (entities or properties).
 *
 * This enables automatic schema updates without page refresh when:
 * - Admins modify entity metadata (display names, sort order)
 * - Admins modify property metadata (labels, visibility)
 * - Admins change validation rules
 * - RBAC permissions are updated
 *
 * Usage: Add to route configuration:
 *   { path: 'some-route', component: SomeComponent, canActivate: [schemaVersionGuard] }
 *
 * Or apply globally in app.config.ts routes.
 */
export const schemaVersionGuard: CanActivateFn = (route, state) => {
  const versionService = inject(VersionService);
  const schemaService = inject(SchemaService);
  const profileService = inject(ProfileService);

  // Check for version updates
  return versionService.checkForUpdates().pipe(
    map(updateCheck => {
      // If no changes, allow navigation immediately
      if (!updateCheck.hasChanges) {
        return true;
      }

      // Selective cache refresh based on what changed
      if (updateCheck.entitiesNeedsRefresh) {
        schemaService.refreshEntitiesCache();
      }

      if (updateCheck.propertiesNeedsRefresh) {
        schemaService.refreshPropertiesCache();
      }

      if (updateCheck.profileExtensionsNeedsRefresh) {
        profileService.invalidateCache();
      }

      // Allow navigation to proceed (refresh happens in background)
      return true;
    })
  );
};
