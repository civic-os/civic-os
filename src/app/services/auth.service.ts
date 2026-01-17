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

import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { KEYCLOAK_EVENT_SIGNAL, KeycloakEventType, KeycloakService, ReadyArgs, typeEventArgs } from 'keycloak-angular';
import Keycloak from 'keycloak-js';
import { DataService } from './data.service';
import { SchemaService } from './schema.service';
import { AnalyticsService } from './analytics.service';
import { ImpersonationService } from './impersonation.service';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, of } from 'rxjs';
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

        // Track logout and reset user ID
        this.analytics.trackEvent('Auth', 'Logout');
        this.analytics.resetUserId();

        // Refresh schema cache when user logs out
        this.schema.refreshCache();
      }
    });
  }
  private readonly keycloak = inject(Keycloak);

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
   * Calls the PostgreSQL has_permission RPC function.
   *
   * @param tableName The name of the table to check
   * @param permission The permission to check: 'create', 'read', 'update', or 'delete'
   * @returns Observable<boolean> - true if user has the permission, false otherwise
   */
  hasPermission(tableName: string, permission: string): Observable<boolean> {
    return this.http.post<boolean>(
      getPostgrestUrl() + 'rpc/has_permission',
      {
        p_table_name: tableName,
        p_permission: permission
      }
    ).pipe(
      catchError((error) => {
        console.error(`Error checking permission ${permission} on ${tableName}:`, error);
        return of(false);
      })
    );
  }

  login() {
    this.keycloak.login();
  }

  logout() {
    this.keycloak.logout();
  }
}
