/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { getPostgrestUrl } from '../config/runtime';

// ============================================================================
// Interfaces
// ============================================================================

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
}

// ============================================================================
// Service
// ============================================================================

@Injectable({
  providedIn: 'root'
})
export class ProfileService {
  private http = inject(HttpClient);
  private baseUrl = getPostgrestUrl();

  /** Cached profile extensions for the current user (used by guard + page) */
  private cachedExtensions = signal<ProfileExtension[] | null>(null);
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
   * Get profile extensions for the current user.
   * Returns cached result if available and fresh; otherwise fetches from RPC.
   */
  getProfileExtensions(): Observable<ProfileExtension[]> {
    const cached = this.cachedExtensions();
    const now = Date.now();
    if (cached !== null && (now - this.cacheTimestamp) < this.CACHE_TTL_MS) {
      return of(cached);
    }

    return this.http.post<ProfileExtension[]>(
      `${this.baseUrl}rpc/get_user_profile_extensions`,
      {}
    ).pipe(
      tap(extensions => {
        this.cachedExtensions.set(extensions);
        this.cacheTimestamp = Date.now();
      }),
      catchError(error => {
        console.error('Error fetching profile extensions:', error);
        return of([]);
      })
    );
  }

  /**
   * Get profile extensions for a specific user (admin only).
   */
  getProfileExtensionsAdmin(userId: string): Observable<ProfileExtension[]> {
    return this.http.post<ProfileExtension[]>(
      `${this.baseUrl}rpc/get_user_profile_extensions_admin`,
      { p_user_id: userId }
    ).pipe(
      catchError(error => {
        console.error('Error fetching admin profile extensions:', error);
        return of([]);
      })
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
   * Invalidate the cached extensions (e.g., after creating/editing an extension record).
   */
  invalidateCache(): void {
    this.cachedExtensions.set(null);
    this.cacheTimestamp = 0;
    this.profileComplete = false;
  }
}
