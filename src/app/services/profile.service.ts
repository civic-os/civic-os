/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, switchMap, take, tap } from 'rxjs/operators';
import { getPostgrestUrl } from '../config/runtime';
import { AuthService } from './auth.service';

// ============================================================================
// Interfaces
// ============================================================================

/** Raw metadata from the user_profile_extensions VIEW (no has_record). */
export interface ProfileExtensionMeta {
  table_name: string;
  sort_order: number;
  is_required: boolean;
  display_name: string;
  description: string | null;
  user_fk_column: string;
  user_fk_constraint: string;
}

/** Full extension data with has_record resolved via PostgREST embedding. */
export interface ProfileExtension {
  table_name: string;
  sort_order: number;
  is_required: boolean;
  display_name: string;
  description: string | null;
  user_fk_column: string;
  has_record: boolean;
}

export interface ProfileUpdateResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface UserPrivateRecord {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  locale?: string | null;
}

// ============================================================================
// Service
// ============================================================================

@Injectable({
  providedIn: 'root'
})
export class ProfileService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private baseUrl = getPostgrestUrl();

  /** Cached profile extensions (used by guard + page) */
  private cachedExtensions = signal<ProfileExtension[] | null>(null);
  private cachedUserId: string | undefined;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 60_000; // 60 seconds

  /**
   * Missing required extensions detected by the guard.
   * AppComponent watches this to show a global prompt modal.
   */
  incompleteRequired = signal<ProfileExtension[]>([]);

  /**
   * Once all required extensions are complete, skip guard checks
   * for the rest of the session. Resets on page reload (new login).
   */
  profileComplete = false;

  // ==========================================================================
  // Profile Extensions
  // ==========================================================================

  /**
   * Get profile extensions for a user (own profile or other user).
   * Two-step: fetch metadata from VIEW (cached), then build a single
   * PostgREST query with embedded resources for has_record checks.
   *
   * @param userId - Target user ID. If omitted, uses current user.
   */
  getProfileExtensions(userId?: string): Observable<ProfileExtension[]> {
    const cached = this.cachedExtensions();
    const now = Date.now();
    if (cached !== null && this.cachedUserId === userId && (now - this.cacheTimestamp) < this.CACHE_TTL_MS) {
      return of(cached);
    }

    return this.fetchExtensionMetadata().pipe(
      switchMap(metas => {
        if (metas.length === 0) return of([]);
        const userId$ = userId ? of(userId) : this.auth.getCurrentUserId().pipe(take(1));
        return userId$.pipe(
          switchMap(resolvedId => {
            if (!resolvedId) return of(metas.map(m => ({ ...m, has_record: false })));
            return this.checkHasRecords(metas, resolvedId);
          })
        );
      }),
      tap(extensions => {
        this.cachedExtensions.set(extensions);
        this.cachedUserId = userId;
        this.cacheTimestamp = Date.now();
      }),
      catchError(() => of([]))
    );
  }

  /**
   * Fetch extension metadata from the user_profile_extensions VIEW.
   */
  private fetchExtensionMetadata(): Observable<ProfileExtensionMeta[]> {
    return this.http.get<ProfileExtensionMeta[]>(
      `${this.baseUrl}user_profile_extensions?order=sort_order,table_name`
    );
  }

  /**
   * Single PostgREST query with resource embedding for has_record checks.
   *
   * Builds a select string that embeds each extension table through
   * civic_os_users, using the FK constraint name from the VIEW
   * (pre-resolved with COALESCE default) to disambiguate when a table
   * has multiple FKs to civic_os_users.
   *
   * Example query:
   *   GET /civic_os_users?id=eq.{userId}&select=id,clients!clients_user_id_fkey(id)
   *
   * RLS naturally gates results:
   * - Own profile: user_id = current_user_id() → extension embeds populated
   * - Admin: table-level read permission → embeds populated
   * - No permission: embed returns [] → has_record = false (correct)
   */
  private checkHasRecords(metas: ProfileExtensionMeta[], userId: string): Observable<ProfileExtension[]> {
    const embeds = metas.map(m => `${m.table_name}!${m.user_fk_constraint}(id)`);
    const select = ['id', ...embeds].join(',');

    return this.http.get<any[]>(
      `${this.baseUrl}civic_os_users?id=eq.${userId}&select=${select}`
    ).pipe(
      map(rows => {
        if (rows.length === 0) return metas.map(m => ({ ...m, has_record: false }));
        const user = rows[0];
        return metas.map(m => ({
          ...m,
          // One-to-one FK (UNIQUE constraint): PostgREST returns object or null
          // One-to-many FK: PostgREST returns array
          has_record: user[m.table_name] != null &&
            (Array.isArray(user[m.table_name]) ? user[m.table_name].length > 0 : true)
        }));
      }),
      catchError(() => of(metas.map(m => ({ ...m, has_record: false }))))
    );
  }

  // ==========================================================================
  // Self-Service Profile Update
  // ==========================================================================

  /**
   * Update the current user's profile (name, phone).
   * Calls the update_own_profile RPC and invalidates cache.
   */
  updateOwnProfile(firstName: string, lastName: string, phone?: string): Observable<ProfileUpdateResponse> {
    return this.http.post<ProfileUpdateResponse>(
      `${this.baseUrl}rpc/update_own_profile`,
      {
        p_first_name: firstName,
        p_last_name: lastName,
        ...(phone !== undefined ? { p_phone: phone } : {})
      }
    ).pipe(
      catchError(error => {
        console.error('Error updating profile:', error);
        return of({
          success: false,
          error: error.error?.message || 'An unexpected error occurred'
        });
      })
    );
  }

  // ==========================================================================
  // Other User Profile Access
  // ==========================================================================

  /**
   * Get another user's profile record via the civic_os_users VIEW.
   * The VIEW's permission-gated CASE expressions control field visibility:
   * - Self or has civic_os_users_private:read → full data
   * - Otherwise → NULLs for private fields
   */
  getUserProfileRecord(userId: string): Observable<UserPrivateRecord | null> {
    return this.http.get<any[]>(
      `${this.baseUrl}civic_os_users?id=eq.${userId}&select=id,display_name,first_name,last_name,email,phone,locale`
    ).pipe(
      map(rows => rows.length > 0 ? rows[0] as UserPrivateRecord : null),
      catchError(error => {
        console.error('Error fetching user profile record:', error);
        return of(null);
      })
    );
  }

  // ==========================================================================
  // Extension Record Access
  // ==========================================================================

  /**
   * Get a user's record in an extension table via PostgREST.
   */
  getExtensionRecord(tableName: string, fkColumn: string, userId: string, selectFields?: string): Observable<any[]> {
    const select = selectFields || '*';
    return this.http.get<any[]>(
      `${this.baseUrl}${tableName}?${fkColumn}=eq.${userId}&select=${select}`
    ).pipe(
      catchError(error => {
        console.error(`Error fetching extension record from ${tableName}:`, error);
        return of([]);
      })
    );
  }

  /**
   * Get the current user's private record via get_own_profile() RPC.
   * Uses SECURITY DEFINER + current_user_id() so users can only read their own data.
   */
  getCurrentUserPrivateRecord(): Observable<UserPrivateRecord | null> {
    return this.http.post<UserPrivateRecord>(
      `${this.baseUrl}rpc/get_own_profile`, {}
    ).pipe(
      map(record => record ?? null),
      catchError(error => {
        console.error('Error fetching user private record:', error);
        return of(null);
      })
    );
  }

  // ==========================================================================
  // Cache Management
  // ==========================================================================

  /**
   * Invalidate the cached extensions (e.g., after creating/editing an extension record,
   * or when schema_cache_versions detects a profile_extensions version change).
   */
  invalidateCache(): void {
    this.cachedExtensions.set(null);
    this.cachedUserId = undefined;
    this.cacheTimestamp = 0;
    this.profileComplete = false;
  }
}
