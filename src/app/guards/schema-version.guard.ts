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

import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { map } from 'rxjs';
import { VersionService } from '../services/version.service';
import { SchemaService } from '../services/schema.service';
import { ProfileService } from '../services/profile.service';
import { ConfigService } from '../services/config.service';
import { TranslationService } from '../services/translation.service';
import { DashboardService } from '../services/dashboard.service';

/**
 * Navigation guard that checks for schema cache updates before each route activation.
 * Compares database schema versions with locally cached versions and refreshes
 * only the changed caches (entities, properties, menu, profile extensions or instance config).
 *
 * A changed `translations` version (v0.81.1: it moves on every insert, update, delete or
 * truncate of metadata.translations) makes every translated cache stale: UI strings, the
 * locale-dependent schema metadata (entities, properties, constraint messages, static text,
 * statuses, categories, menu nodes), guided form steps, dashboards and profile extensions
 * (instance config is fetched without its labels, so it is left alone). It drops all of them,
 * the same set the translations admin drops in its own tab, and skips the narrower
 * schema refreshes, which `SchemaService.refreshCache()` already covers, so one navigation
 * sends one round of requests.
 *
 * This enables automatic schema updates without page refresh when:
 * - Admins modify entity metadata (display names, sort order)
 * - Admins modify property metadata (labels, visibility)
 * - Admins change validation rules
 * - RBAC permissions are updated
 * - Admins add or change status and category values
 * - Admins add, edit or delete translations
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
  const configService = inject(ConfigService);
  const translationService = inject(TranslationService);
  const dashboardService = inject(DashboardService);

  // Check for version updates
  return versionService.checkForUpdates().pipe(
    map(updateCheck => {
      // If no changes, allow navigation immediately
      if (!updateCheck.hasChanges) {
        return true;
      }

      // A translation change drops every translated cache; refreshCache() covers the
      // entity, property, status, category and menu refreshes below.
      const translationsChanged = updateCheck.translationsNeedsRefresh;
      if (translationsChanged) {
        translationService.clearCache();
        schemaService.refreshCache();
        schemaService.invalidateGuidedFormCache();
        dashboardService.refreshCache();
      }

      // Selective cache refresh based on what changed
      if (updateCheck.entitiesNeedsRefresh && !translationsChanged) {
        schemaService.refreshEntitiesCache();
      }

      if (updateCheck.propertiesNeedsRefresh && !translationsChanged) {
        schemaService.refreshPropertiesCache();
      }

      // Profile extension labels are translated too (metadata.t('entity', ...) in their view)
      if (updateCheck.profileExtensionsNeedsRefresh || translationsChanged) {
        profileService.invalidateCache();
      }

      if (updateCheck.instanceConfigNeedsRefresh) {
        configService.invalidateCache();
      }

      if (updateCheck.statusesNeedsRefresh && !translationsChanged) {
        schemaService.refreshStatusesCache();
      }

      if (updateCheck.categoriesNeedsRefresh && !translationsChanged) {
        schemaService.invalidateCategoryCache();
      }

      if (updateCheck.menuNeedsRefresh && !translationsChanged) {
        schemaService.refreshMenuCache();
      }

      // Allow navigation to proceed (refresh happens in background)
      return true;
    })
  );
};
