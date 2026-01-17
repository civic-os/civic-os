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
import { impersonationInterceptor } from './interceptors/impersonation.interceptor';
import { WidgetComponentRegistry } from './services/widget-component-registry.service';
import { MarkdownWidgetComponent } from './components/widgets/markdown-widget/markdown-widget.component';
import { FilteredListWidgetComponent } from './components/widgets/filtered-list-widget/filtered-list-widget.component';
import { MapWidgetComponent } from './components/widgets/map-widget/map-widget.component';
import { DashboardNavigationWidgetComponent } from './components/widgets/dashboard-navigation-widget/dashboard-navigation-widget.component';
import { CalendarWidgetComponent } from './components/widgets/calendar-widget/calendar-widget.component';
import { NavButtonsWidgetComponent } from './components/widgets/nav-buttons-widget/nav-buttons-widget.component';
import { provideMarkdown } from 'ngx-markdown';
import { getKeycloakConfig, getPostgrestUrl, getMatomoConfig } from './config/runtime';
import { provideMatomo, withRouter } from 'ngx-matomo-client';

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
    provideHttpClient(withInterceptors([
      includeBearerTokenInterceptor,
      impersonationInterceptor  // Adds X-Impersonate-Roles header when admin is impersonating
    ])),

    // Matomo analytics - conditionally provided if configured
    ...(() => {
      const matomoConfig = getMatomoConfig();
      if (matomoConfig.url && matomoConfig.siteId && matomoConfig.enabled) {
        return [
          provideMatomo(
            {
              siteId: matomoConfig.siteId,
              trackerUrl: `${matomoConfig.url}/matomo.php`,
              scriptUrl: `${matomoConfig.url}/matomo.js`
            },
            withRouter()  // Automatic router tracking (replaces MatomoRouterTrackerService)
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
      registry.register('dashboard_navigation', DashboardNavigationWidgetComponent); // Phase 2
      registry.register('calendar', CalendarWidgetComponent);           // Phase 2
      registry.register('nav_buttons', NavButtonsWidgetComponent);      // Phase 2
    })
  ]
};
