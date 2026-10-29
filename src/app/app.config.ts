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

import { ApplicationConfig, provideZonelessChangeDetection, provideAppInitializer, inject, isDevMode } from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';

import { routes } from './app.routes';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { AutoRefreshTokenService, createInterceptorCondition, INCLUDE_BEARER_TOKEN_INTERCEPTOR_CONFIG, IncludeBearerTokenCondition, provideKeycloak, UserActivityService, withAutoRefreshToken } from 'keycloak-angular';
import { HTTP_INTERCEPTORS_IN_ORDER } from './interceptors/interceptor-order';
import { WidgetComponentRegistry } from './services/widget-component-registry.service';
import { MarkdownWidgetComponent } from './components/widgets/markdown-widget/markdown-widget.component';
import { FilteredListWidgetComponent } from './components/widgets/filtered-list-widget/filtered-list-widget.component';
import { MapWidgetComponent } from './components/widgets/map-widget/map-widget.component';
import { DashboardNavigationWidgetComponent } from './components/widgets/dashboard-navigation-widget/dashboard-navigation-widget.component';
import { CalendarWidgetComponent } from './components/widgets/calendar-widget/calendar-widget.component';
import { NavButtonsWidgetComponent } from './components/widgets/nav-buttons-widget/nav-buttons-widget.component';
import { ImageWidgetComponent } from './components/widgets/image-widget/image-widget.component';
import { ChartWidgetComponent } from './components/widgets/chart-widget/chart-widget.component';
import { provideMarkdown, MARKED_EXTENSIONS, SANITIZE } from 'ngx-markdown';
import { videoEmbedExtension } from './markdown/video-embed.extension';
import { authButtonExtension } from './markdown/auth-button.extension';
import { markdownSanitize } from './markdown/markdown-sanitize';
import { getKeycloakConfig, getPostgrestUrl, getMatomoConfig, getPwaConfig } from './config/runtime';
import { TranslationService } from './services/translation.service';
import { PwaService } from './services/pwa.service';
import { MaintenanceService } from './services/maintenance.service';
import { provideMatomo, withRouter } from 'ngx-matomo-client';
import { ConfigService } from './services/config.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),

    // Keycloak configuration - uses helper that reads window.civicOsConfig (inline script) or environment.ts fallback
    provideKeycloak({
      config: getKeycloakConfig(),
      initOptions: {
        onLoad: 'check-sso',
        pkceMethod: 'S256',
        checkLoginIframe: false,  // Disabled: uses third-party cookies blocked by Brave/Safari/ITP
        silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html'
      },
      providers: [UserActivityService, AutoRefreshTokenService],  // Bug workaround: keycloak-angular@20 doesn't register these
      features: [
        withAutoRefreshToken({
          onInactivityTimeout: 'none'  // Don't redirect on inactivity — visibility listener + 401 interceptor handle zombie state
        })
      ]
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

    // Route params, data and resolved values bind to same-named inputs; query params do not, so a URL can
    // never set a page input (CreatePage reads its query params itself).
    provideRouter(routes, withComponentInputBinding({ queryParams: false })),
    provideHttpClient(withXhr(), withInterceptors([...HTTP_INTERCEPTORS_IN_ORDER])),

    // Matomo analytics - provided whenever a server URL and site id are configured, in
    // deferred mode: no script is injected here. AnalyticsService calls initializeTracker()
    // once the instance config says matomo_enabled is true (DB -> ENV -> default), so the
    // flag can be flipped at runtime. Until then router page views only queue in _paq.
    ...(() => {
      const matomoConfig = getMatomoConfig();
      if (matomoConfig.url && matomoConfig.siteId) {
        return [
          provideMatomo(
            { mode: 'deferred' },
            withRouter()  // Automatic router tracking (replaces MatomoRouterTrackerService)
          )
        ];
      }
      return [];
    })(),

    provideMarkdown({
      markedExtensions: [
        { provide: MARKED_EXTENSIONS, useValue: videoEmbedExtension, multi: true },
        { provide: MARKED_EXTENSIONS, useValue: authButtonExtension, multi: true },
      ],
      sanitize: { provide: SANITIZE, useValue: markdownSanitize },
    }),

    // Service worker for PWA support (conditionally enabled via runtime config)
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode() && getPwaConfig().enabled,
      registrationStrategy: 'registerWhenStable:30000'
    }),

    // Load instance config (Tier 2 runtime config) without blocking bootstrap:
    // localStorage hydration already gave the constructor a value, this refreshes it.
    provideAppInitializer(() => {
      inject(ConfigService).load();
    }),

    // Eagerly initialize TranslationService so translations load at startup
    provideAppInitializer(() => {
      inject(TranslationService);
    }),

    // Eagerly initialize PwaService for install prompt capture and SW update monitoring
    provideAppInitializer(() => {
      inject(PwaService);
    }),

    // Eagerly initialize MaintenanceService for maintenance.json polling
    provideAppInitializer(() => {
      inject(MaintenanceService);
    }),

    // Register widget components at startup (Phase 1 + Phase 2)
    provideAppInitializer(() => {
      const registry = inject(WidgetComponentRegistry);
      registry.register('markdown', MarkdownWidgetComponent);           // Phase 1
      registry.register('filtered_list', FilteredListWidgetComponent);  // Phase 2
      registry.register('map', MapWidgetComponent);                     // Phase 2
      registry.register('dashboard_navigation', DashboardNavigationWidgetComponent); // Phase 2
      registry.register('calendar', CalendarWidgetComponent);           // Phase 2
      registry.register('nav_buttons', NavButtonsWidgetComponent);      // Phase 2
      registry.register('image', ImageWidgetComponent);                  // v0.38.0
      registry.register('chart', ChartWidgetComponent);                  // v0.61.0
    })
  ]
};
