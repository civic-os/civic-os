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

import { Injectable, effect, inject, untracked } from '@angular/core';
import { MatomoInitializerService, MatomoTracker } from 'ngx-matomo-client';
import { getMatomoConfig } from '../config/runtime';
import { ConfigService } from './config.service';

/**
 * Analytics service for tracking user interactions and application usage.
 *
 * Wraps Matomo tracker with user opt-out preference support and provides
 * semantic methods for tracking common events.
 *
 * User opt-out preference is stored in localStorage ('analytics_enabled').
 * Defaults to enabled (opt-out model).
 *
 * Configuration is read from runtime environment (see getMatomoConfig()).
 * If MATOMO_URL or MATOMO_SITE_ID is not configured, tracking is disabled.
 *
 * @example
 * // Track a page view
 * analyticsService.trackPageView('Issues List');
 *
 * @example
 * // Track an entity operation
 * analyticsService.trackEvent('Entity', 'Create', 'issues');
 *
 * @example
 * // Track a search query (length only, not content)
 * analyticsService.trackEvent('Search', 'Query', 'issues', queryLength);
 */
@Injectable({
  providedIn: 'root'
})
export class AnalyticsService {
  private readonly tracker = inject(MatomoTracker, { optional: true });
  private readonly initializer = inject(MatomoInitializerService, { optional: true });
  private readonly configService = inject(ConfigService);
  private readonly config = getMatomoConfig();
  private readonly LOCAL_STORAGE_KEY = 'analytics_enabled';
  private trackerInitialized = false;

  constructor() {
    // app.config.ts provides Matomo in deferred mode, so nothing is requested from the
    // Matomo server until this effect initializes the tracker. When matomo_enabled is
    // false, no matomo.js or matomo.php request is ever made.
    // Turning the flag off mid-session stops isEnabled() (and so every track call) at
    // once, but an already loaded matomo.js cannot be unloaded; that takes the next page load.
    effect(() => {
      // Wait for the first network load: a first-visit ENV default or a stale cached blob
      // must never load matomo.js when the DB says analytics is off.
      const enabled = this.configService.settled() && this.configService.matomoEnabled();
      untracked(() => {
        if (!enabled || this.trackerInitialized || !this.config.url || !this.config.siteId) {
          return;
        }
        this.trackerInitialized = true;
        this.initializer?.initializeTracker({
          siteId: this.config.siteId,
          trackerUrl: `${this.config.url}/matomo.php`,
          scriptUrl: `${this.config.url}/matomo.js`
        });
      });
    });
  }

  /**
   * Check if analytics tracking is enabled.
   *
   * Returns true if:
   * - MATOMO_URL and MATOMO_SITE_ID are configured
   * - matomo_enabled is true (instance config, then MATOMO_ENABLED, default true)
   * - User has not opted out (localStorage)
   * - Browser's DNT (Do Not Track) is not set to '1'
   */
  isEnabled(): boolean {
    // Check if Matomo is configured
    if (!this.config.url || !this.config.siteId) {
      return false;
    }

    // Check global enabled flag
    if (!this.configService.matomoEnabled()) {
      return false;
    }

    // Check user opt-out preference (default: true/enabled)
    const userPreference = localStorage.getItem(this.LOCAL_STORAGE_KEY);
    if (userPreference === 'false') {
      return false;
    }

    // Check browser DNT (Do Not Track) setting
    if (navigator.doNotTrack === '1') {
      return false;
    }

    return true;
  }

  /**
   * Set user opt-out preference.
   *
   * Updates localStorage and applies immediately.
   * If disabling, stops tracking and opts out of Matomo.
   * If enabling, opts back in to Matomo.
   *
   * @param enabled - True to enable tracking, false to opt out
   */
  setEnabled(enabled: boolean): void {
    localStorage.setItem(this.LOCAL_STORAGE_KEY, enabled.toString());

    if (!this.tracker) {
      return;
    }

    if (enabled) {
      this.tracker.forgetUserOptOut();
    } else {
      this.tracker.optUserOut();
    }
  }

  /**
   * Get current user preference for analytics.
   *
   * @returns True if user has analytics enabled (default), false if opted out
   */
  getUserPreference(): boolean {
    const userPreference = localStorage.getItem(this.LOCAL_STORAGE_KEY);
    return userPreference !== 'false';  // Default to true
  }

  /**
   * Track a page view with optional custom title.
   *
   * Called automatically by Angular Router if Matomo tracker is enabled.
   * Can also be called manually for custom page views or SPAs.
   *
   * @param customTitle - Optional custom page title (defaults to document.title)
   */
  trackPageView(customTitle?: string): void {
    if (!this.isEnabled() || !this.tracker) {
      return;
    }

    if (customTitle) {
      this.tracker.trackPageView(customTitle);
    } else {
      this.tracker.trackPageView();
    }
  }

  /**
   * Track a custom event.
   *
   * Use for user interactions that aren't page views:
   * - Entity operations (Create, Edit, Delete, List, Detail)
   * - Search queries
   * - Errors
   * - Authentication events
   *
   * @param category - Event category (e.g., 'Entity', 'Search', 'Error', 'Auth')
   * @param action - Action performed (e.g., 'Create', 'Query', 'HTTP', 'Login')
   * @param name - Optional event name (e.g., entity table name, error code)
   * @param value - Optional numeric value (e.g., query length, status code)
   *
   * @example
   * trackEvent('Entity', 'Create', 'issues');
   * trackEvent('Search', 'Query', 'issues', queryLength);
   * trackEvent('Error', 'HTTP', '404');
   */
  trackEvent(category: string, action: string, name?: string, value?: number): void {
    if (!this.isEnabled() || !this.tracker) {
      return;
    }

    this.tracker.trackEvent(category, action, name, value);
  }

  /**
   * Track an error event.
   *
   * Convenience method for tracking errors with consistent category.
   *
   * @param error - Error message or description
   * @param statusCode - Optional HTTP status code or error code
   *
   * @example
   * trackError('Failed to load issues', 500);
   * trackError('Validation failed: email required');
   */
  trackError(error: string, statusCode?: number): void {
    this.trackEvent('Error', 'Application', error, statusCode);
  }

  /**
   * Set the user ID for tracking.
   *
   * Links events to a specific user. Should be called after login.
   * Use Keycloak subject (sub) or database user ID.
   *
   * Note: User ID is anonymized in Matomo if configured properly.
   *
   * @param userId - User identifier (Keycloak sub or database ID)
   */
  setUserId(userId: string): void {
    if (!this.isEnabled() || !this.tracker) {
      return;
    }

    this.tracker.setUserId(userId);
  }

  /**
   * Reset the user ID (e.g., on logout).
   *
   * Should be called when user logs out to prevent tracking
   * events as the previous user.
   */
  resetUserId(): void {
    if (!this.isEnabled() || !this.tracker) {
      return;
    }

    this.tracker.resetUserId();
  }
}
