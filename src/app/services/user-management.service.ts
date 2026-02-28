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

import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { getPostgrestUrl } from '../config/runtime';
import { AuthService } from './auth.service';
import { ApiResponse } from '../interfaces/api';

export interface ManagedUser {
  id: string | null;
  display_name: string;
  full_name: string;
  email: string;
  phone: string | null;
  status: string;
  error_message: string | null;
  roles: string[] | null;
  created_at: string;
  provision_id: number | null;
}

export interface ManageableRole {
  role_id: number;
  display_name: string;
  description: string | null;
}

export interface ProvisionUserRequest {
  email: string;
  first_name: string;
  last_name: string;
  phone?: string;
  initial_roles?: string[];
  send_welcome_email?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class UserManagementService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  getManagedUsers(search?: string, statusFilter?: string): Observable<ManagedUser[]> {
    let url = getPostgrestUrl() + 'managed_users?order=created_at.desc';

    if (search) {
      const encoded = encodeURIComponent(search);
      url += `&or=(display_name.ilike.*${encoded}*,full_name.ilike.*${encoded}*,email.ilike.*${encoded}*)`;
    }

    if (statusFilter && statusFilter !== 'all') {
      url += `&status=eq.${statusFilter}`;
    }

    return this.http.get<ManagedUser[]>(url).pipe(
      catchError(error => {
        console.error('Error fetching managed users:', error);
        return of([]);
      })
    );
  }

  importUsers(users: ProvisionUserRequest[]): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/bulk_provision_users',
      { p_users: JSON.stringify(users) }
    ).pipe(
      map(response => {
        if (response?.success === false) {
          const message = response.error || `${response.error_count} user(s) failed to import`;
          return <ApiResponse>{
            success: false,
            error: { message, humanMessage: message }
          };
        }
        return <ApiResponse>{ success: true };
      }),
      catchError(error => {
        const message = error.error?.message || error.error?.details || error.message || 'Import failed';
        return of(<ApiResponse>{
          success: false,
          error: { message, humanMessage: message }
        });
      })
    );
  }

  createUser(user: ProvisionUserRequest): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/create_provisioned_user',
      {
        p_email: user.email,
        p_first_name: user.first_name,
        p_last_name: user.last_name,
        p_phone: user.phone || null,
        p_initial_roles: user.initial_roles || ['user'],
        p_send_welcome_email: user.send_welcome_email ?? true
      }
    ).pipe(
      map(response => {
        if (response?.success === false) {
          return <ApiResponse>{
            success: false,
            error: { message: response.error, humanMessage: response.error }
          };
        }
        return <ApiResponse>{ success: true };
      }),
      catchError(error => {
        const message = error.error?.message || error.error?.details || error.message || 'Failed to create user';
        return of(<ApiResponse>{
          success: false,
          error: { message, humanMessage: message }
        });
      })
    );
  }

  retryProvisioning(id: number): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/retry_user_provisioning',
      { p_provision_id: id }
    ).pipe(
      map(response => {
        if (response?.success === false) {
          return <ApiResponse>{
            success: false,
            error: { message: response.error, humanMessage: response.error }
          };
        }
        return <ApiResponse>{ success: true };
      }),
      catchError(error => {
        const message = error.error?.message || error.message || 'Retry failed';
        return of(<ApiResponse>{
          success: false,
          error: { message, humanMessage: message }
        });
      })
    );
  }

  getManageableRoles(): Observable<ManageableRole[]> {
    return this.http.post<ManageableRole[]>(
      getPostgrestUrl() + 'rpc/get_manageable_roles',
      {}
    ).pipe(
      catchError(error => {
        console.error('Error fetching manageable roles:', error);
        return of([]);
      })
    );
  }

  assignUserRole(userId: string, roleName: string): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/assign_user_role',
      { p_user_id: userId, p_role_name: roleName }
    ).pipe(
      map(response => {
        if (response?.success === false) {
          return <ApiResponse>{
            success: false,
            error: { message: response.error, humanMessage: response.error }
          };
        }
        return <ApiResponse>{ success: true };
      }),
      catchError(error => of(<ApiResponse>{
        success: false,
        error: { message: error.message, humanMessage: 'Failed to assign role' }
      }))
    );
  }

  revokeUserRole(userId: string, roleName: string): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/revoke_user_role',
      { p_user_id: userId, p_role_name: roleName }
    ).pipe(
      map(response => {
        if (response?.success === false) {
          return <ApiResponse>{
            success: false,
            error: { message: response.error, humanMessage: response.error }
          };
        }
        return <ApiResponse>{ success: true };
      }),
      catchError(error => of(<ApiResponse>{
        success: false,
        error: { message: error.message, humanMessage: 'Failed to revoke role' }
      }))
    );
  }

  hasUserManagementAccess(): Observable<boolean> {
    return this.auth.hasPermission('civic_os_users_private', 'read').pipe(
      catchError(() => of(false))
    );
  }
}
