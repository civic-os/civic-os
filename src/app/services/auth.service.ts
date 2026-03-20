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

import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { KEYCLOAK_EVENT_SIGNAL, KeycloakEventType, KeycloakService, ReadyArgs, typeEventArgs } from 'keycloak-angular';
import Keycloak from 'keycloak-js';
import { DataService } from './data.service';
import { SchemaService } from './schema.service';
import { AnalyticsService } from './analytics.service';
import { ImpersonationService } from './impersonation.service';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { getPostgrestUrl } from '../config/runtime';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private data = inject(DataService);
  private schema = inject(SchemaService);
  private keycloakSignal = inject(KEYCLOAK_EVENT_SIGNAL);
  private http = inject(HttpClient);
  private analytics = inject(AnalyticsService);
  private impersonation = inject(ImpersonationService);

  authenticated = signal(false);

  /**
   * The actual roles from the JWT token.
   * Use this when you need the real user identity (e.g., checking if user can access impersonation UI).
   */
  realUserRoles = signal<string[]>([]);

  /**
   * Cached permissions from the database.
   * Map key is table_name, value is a Set of permission strings ('create', 'read', 'update', 'delete').
   * Populated on login via loadPermissions(), cleared on logout/auth error.
   */
  private permissionsCache = signal<Map<string, Set<string>>>(new Map());

  /** Whether permissions have been loaded from the database. */
  permissionsLoaded = signal(false);

  /** Whether permissions are currently being fetched. */
  private permissionsLoading = signal(false);

  /**
   * Effective roles - returns impersonated roles if impersonation is active, otherwise real JWT roles.
   * Use this for all permission checks in the UI.
   */
  userRoles = computed(() => {
    if (this.impersonation.isActive()) {
      return this.impersonation.impersonatedRoles();
    }
    return this.realUserRoles();
  });

  constructor() {
    effect(() => {
      const keycloakEvent = this.keycloakSignal();

      if (keycloakEvent.type === KeycloakEventType.Ready) {
        this.authenticated.set(typeEventArgs<ReadyArgs>(keycloakEvent.args));

        if (this.authenticated()) {
          this.loadUserRoles();
          this.loadPermissions();
          this.data.refreshCurrentUser().subscribe({
            next: (result) => {
              if (!result.success) {
                console.error('Failed to refresh user data:', result.error);
              }
            },
            error: (err) => console.error('Error refreshing user data:', err)
          });

          // Track login and set user ID for analytics
          const tokenParsed = this.keycloak.tokenParsed;
          if (tokenParsed?.sub) {
            this.analytics.setUserId(tokenParsed.sub);
          }
          this.analytics.trackEvent('Auth', 'Login');
        } else {
          // Not authenticated - clear any stale impersonation state
          // This handles: browser closed while impersonating, token expired, etc.
          // Impersonation requires a valid session, so clear it when there isn't one
          this.impersonation.stopImpersonation().subscribe();
        }

        // IMPORTANT: Do NOT call schema.refreshCache() here
        // Calling refreshCache() on Ready event causes duplicate HTTP requests:
        //   1. App init → SchemaService loads schema (first request)
        //   2. Keycloak Ready → refreshCache() clears cache (happens almost immediately)
        //   3. Components re-subscribe → SchemaService loads schema again (duplicate request)
        // Schema cache is loaded on-demand when components first request it.
        // The schemaVersionGuard handles subsequent updates when RBAC permissions change.
      }

      if (keycloakEvent.type === KeycloakEventType.AuthLogout) {
        this.authenticated.set(false);
        this.realUserRoles.set([]);
        this.clearPermissionsCache();

        // Clear impersonation state on logout
        // State is cleared immediately; audit logging is best-effort
        this.impersonation.stopImpersonation().subscribe();

        // Track logout and reset user ID
        this.analytics.trackEvent('Auth', 'Logout');
        this.analytics.resetUserId();

        // Refresh schema cache when user logs out
        this.schema.refreshCache();
      }

      if (keycloakEvent.type === KeycloakEventType.AuthRefreshError) {
        // Token refresh failed - update auth state and clear impersonation.
        // withAutoRefreshToken handles the login redirect, so we don't call keycloak.login() here.
        this.authenticated.set(false);
        this.realUserRoles.set([]);
        this.clearPermissionsCache();
        this.impersonation.stopImpersonation().subscribe();
        this.analytics.trackEvent('Auth', 'RefreshError');
      }
    });

    this.setupVisibilityChangeListener();
  }
  private readonly keycloak = inject(Keycloak);

  /**
   * Detect tab reactivation after sleep/wake and validate the token.
   * visibilitychange fires reliably when the OS wakes, unlike setTimeout-based timers.
   */
  private setupVisibilityChangeListener() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !this.authenticated()) {
        return;
      }
      // Request a token valid for at least 30 more seconds
      this.keycloak.updateToken(30).catch(() => {
        // Refresh token is also expired — force re-authentication
        this.analytics.trackEvent('Auth', 'VisibilityRefreshFailed');
        this.keycloak.login();
      });
    });
  }

  private loadUserRoles() {
    try {
      const tokenParsed = this.keycloak.tokenParsed;
      if (tokenParsed) {
        // Keycloak stores roles in different places depending on configuration
        // Try realm_access.roles first, then resource_access, then a custom 'roles' claim
        const roles = tokenParsed['realm_access']?.['roles'] ||
                        tokenParsed['resource_access']?.['myclient']?.['roles'] ||
                        tokenParsed['roles'] ||
                        [];
        this.realUserRoles.set(roles);
      }
    } catch (error) {
      console.error('Error loading user roles:', error);
      this.realUserRoles.set([]);
    }
  }

  /**
   * Check if effective roles include the given role.
   * Uses impersonated roles if impersonation is active.
   */
  hasRole(roleName: string): boolean {
    return this.userRoles().includes(roleName);
  }

  /**
   * Check if effective roles include 'admin'.
   * Returns false when impersonating as non-admin role.
   * Use this for hiding/showing admin UI elements.
   */
  isAdmin(): boolean {
    return this.hasRole('admin');
  }

  /**
   * Check if the REAL user (from JWT) has the given role.
   * Ignores impersonation.
   */
  hasRealRole(roleName: string): boolean {
    return this.realUserRoles().includes(roleName);
  }

  /**
   * Check if the REAL user (from JWT) is an admin.
   * Ignores impersonation - always returns true for real admins.
   * Use this for showing impersonation controls.
   */
  isRealAdmin(): boolean {
    return this.hasRealRole('admin');
  }

  /**
   * Get the current user's ID from the Keycloak token.
   *
   * @returns Observable<string | null> - The user's UUID or null if not authenticated
   */
  getCurrentUserId(): Observable<string | null> {
    const tokenParsed = this.keycloak.tokenParsed;
    return of(tokenParsed?.sub || null);
  }

  /**
   * Check if the current user has a specific permission on a table.
   * Performs a synchronous lookup against the cached permissions loaded at login.
   *
   * Returns false (safe default) when permissions have not yet been loaded.
   * Security note: this is purely UI gating — RLS at the database layer is the real enforcement.
   *
   * @param tableName The name of the table to check
   * @param permission The permission to check: 'create', 'read', 'update', or 'delete'
   * @returns boolean - true if user has the permission, false otherwise
   */
  hasPermission(tableName: string, permission: string): boolean {
    const perms = this.permissionsCache().get(tableName);
    return perms?.has(permission) ?? false;
  }

  /**
   * Load all permissions for the current user from the database.
   * Calls the get_current_user_permissions RPC and populates the cache.
   * Called automatically on Keycloak Ready event after loadUserRoles().
   */
  private loadPermissions(): void {
    if (this.permissionsLoading()) return;
    this.permissionsLoading.set(true);

    this.http.post<{ table_name: string; permission: string }[]>(
      getPostgrestUrl() + 'rpc/get_current_user_permissions',
      {}
    ).subscribe({
      next: (rows) => {
        const cache = new Map<string, Set<string>>();
        for (const row of rows) {
          let perms = cache.get(row.table_name);
          if (!perms) {
            perms = new Set<string>();
            cache.set(row.table_name, perms);
          }
          perms.add(row.permission);
        }
        this.permissionsCache.set(cache);
        this.permissionsLoaded.set(true);
        this.permissionsLoading.set(false);
      },
      error: (err) => {
        console.error('Error loading permissions:', err);
        this.permissionsLoaded.set(true);
        this.permissionsLoading.set(false);
      }
    });
  }

  /**
   * Clear the permissions cache. Called on logout and auth errors.
   */
  private clearPermissionsCache(): void {
    this.permissionsCache.set(new Map());
    this.permissionsLoaded.set(false);
    this.permissionsLoading.set(false);
  }

  /**
   * Refresh the permissions cache by clearing it and re-fetching from the database.
   * Exposed publicly for PermissionsPage to call after mutations.
   */
  refreshPermissions(): void {
    this.clearPermissionsCache();
    if (this.authenticated()) {
      this.loadPermissions();
    }
  }

  login() {
    this.keycloak.login();
  }

  logout() {
    // Clear impersonation state synchronously BEFORE redirect
    // The AuthLogout event won't fire in time since keycloak.logout() redirects immediately
    this.impersonation.stopImpersonation().subscribe();
    this.keycloak.logout();
  }
}
