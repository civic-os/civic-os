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

import { ApplicationConfig, provideZonelessChangeDetection, provideAppInitializer, inject } from '@angular/core';
import { provideRouter, withRouterConfig } from '@angular/router';

import { routes } from './app.routes';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { createInterceptorCondition, INCLUDE_BEARER_TOKEN_INTERCEPTOR_CONFIG, IncludeBearerTokenCondition, includeBearerTokenInterceptor, provideKeycloak } from 'keycloak-angular';
import { WidgetComponentRegistry } from './services/widget-component-registry.service';
import { MarkdownWidgetComponent } from './components/widgets/markdown-widget/markdown-widget.component';
import { FilteredListWidgetComponent } from './components/widgets/filtered-list-widget/filtered-list-widget.component';
import { MapWidgetComponent } from './components/widgets/map-widget/map-widget.component';
import { provideMarkdown } from 'ngx-markdown';
import { getKeycloakConfig, getPostgrestUrl, getMatomoConfig } from './config/runtime';
import { importProvidersFrom } from '@angular/core';
import { NgxMatomoTrackerModule } from '@ngx-matomo/tracker';
import { MatomoRouterTrackerService } from './services/matomo-router-tracker.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),

    // Keycloak configuration - uses helper that reads window.civicOsConfig (inline script) or environment.ts fallback
    provideKeycloak({
      config: getKeycloakConfig(),
      initOptions: {
        onLoad: 'check-sso',
        silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html'
      }
    }),

    // Bearer token interceptor - uses helper function to get PostgREST URL
    {
      provide: INCLUDE_BEARER_TOKEN_INTERCEPTOR_CONFIG,
      useFactory: () => {
        const escapedUrl = getPostgrestUrl().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const urlCondition = createInterceptorCondition<IncludeBearerTokenCondition>({
          urlPattern: new RegExp(`^(${escapedUrl})(.*)?$`, 'i'),
          bearerPrefix: 'Bearer'
        });
        return [urlCondition];
      }
    },

    provideRouter(routes),
    provideHttpClient(withInterceptors([includeBearerTokenInterceptor])),

    // Matomo analytics - conditionally provided if configured
    ...(() => {
      const matomoConfig = getMatomoConfig();
      if (matomoConfig.url && matomoConfig.siteId && matomoConfig.enabled) {
        return [
          importProvidersFrom(
            NgxMatomoTrackerModule.forRoot({
              siteId: matomoConfig.siteId,
              trackerUrl: `${matomoConfig.url}/matomo.php`,
              scriptUrl: `${matomoConfig.url}/matomo.js`
            })
          )
        ];
      }
      return [];
    })(),

    provideMarkdown(),

    // Register widget components at startup (Phase 1 + Phase 2)
    provideAppInitializer(() => {
      const registry = inject(WidgetComponentRegistry);
      registry.register('markdown', MarkdownWidgetComponent);           // Phase 1
      registry.register('filtered_list', FilteredListWidgetComponent);  // Phase 2
      registry.register('map', MapWidgetComponent);                     // Phase 2
    }),

    // Initialize Matomo router tracking (if analytics enabled)
    provideAppInitializer(() => {
      const matomoConfig = getMatomoConfig();
      if (matomoConfig.url && matomoConfig.siteId && matomoConfig.enabled) {
        // Inject the router tracker service to start listening to navigation events
        inject(MatomoRouterTrackerService);
      }
    })
  ]
};
