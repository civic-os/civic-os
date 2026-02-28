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
import { Observable } from 'rxjs';
import { SchemaService } from './schema.service';
import { ApiResponse } from '../interfaces/api';
import { catchError, map, of } from 'rxjs';
import { getPostgrestUrl } from '../config/runtime';

export interface Role {
  id: number;
  display_name: string;
  description?: string;
}

export interface RolePermission {
  role_id: number;
  role_name: string;
  table_name: string;
  permission_type: string;
  has_permission: boolean;
}

/**
 * Entity action with permission info for a specific role
 */
export interface EntityActionPermission {
  id: number;
  table_name: string;
  action_name: string;
  display_name: string;
  description?: string;
  has_permission: boolean;
}

export interface RoleDelegation {
  managed_role_id: number;
  managed_role_name: string;
}

@Injectable({
  providedIn: 'root'
})
export class PermissionsService {
  private http = inject(HttpClient);
  private schema = inject(SchemaService);

  getRoles(): Observable<Role[]> {
    return this.http.post<Role[]>(
      getPostgrestUrl() + 'rpc/get_roles',
      {}
    ).pipe(
      catchError((error) => {
        console.error('Error fetching roles:', error);
        return of([]);
      })
    );
  }

  getTables(): Observable<string[]> {
    return this.schema.getEntities().pipe(
      map(entities => entities ? entities.map(e => e.table_name) : [])
    );
  }

  getRolePermissions(roleId?: number): Observable<RolePermission[]> {
    const body = roleId !== undefined ? { p_role_id: roleId } : {};
    return this.http.post<any[]>(
      getPostgrestUrl() + 'rpc/get_role_permissions',
      body
    ).pipe(
      map(permissions => permissions.map(p => ({
        ...p,
        // Convert PostgreSQL boolean (t/f string) to JavaScript boolean
        has_permission: p.has_permission === true || p.has_permission === 't' || p.has_permission === 'true'
      }))),
      catchError((error) => {
        console.error('Error fetching role permissions:', error);
        return of([]);
      })
    );
  }

  setRolePermission(roleId: number, tableName: string, permission: string, enabled: boolean): Observable<ApiResponse> {
    return this.http.post(
      getPostgrestUrl() + 'rpc/set_role_permission',
      {
        p_role_id: roleId,
        p_table_name: tableName,
        p_permission: permission,
        p_enabled: enabled
      }
    ).pipe(
      map((response: any) => {
        if (response?.success === false) {
          return <ApiResponse>{
            success: false,
            error: { message: response.error, humanMessage: response.error }
          };
        }
        return <ApiResponse>{ success: true };
      }),
      catchError((error) => {
        return of(<ApiResponse>{
          success: false,
          error: { message: error.message, humanMessage: 'Failed to update permission' }
        });
      })
    );
  }

  isAdmin(): Observable<boolean> {
    return this.http.post<boolean>(
      getPostgrestUrl() + 'rpc/is_admin',
      {}
    ).pipe(
      catchError(() => of(false))
    );
  }

  createRole(displayName: string, description?: string): Observable<ApiResponse & { roleId?: number }> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/create_role',
      {
        p_display_name: displayName,
        p_description: description || null
      }
    ).pipe(
      map((response) => {
        if (response?.success === false) {
          return {
            success: false,
            error: { message: response.error, humanMessage: response.error }
          };
        }
        return {
          success: true,
          roleId: response.role_id
        };
      }),
      catchError((error) => {
        return of({
          success: false,
          error: { message: error.message, humanMessage: 'Failed to create role' }
        });
      })
    );
  }

  // =========================================================================
  // ENTITY ACTION PERMISSIONS (v0.18.1)
  // =========================================================================

  /**
   * Get all entity actions with permission status for a specific role.
   * Uses the schema_entity_actions view (public schema) which is accessible via PostgREST.
   */
  getEntityActionPermissions(roleId: number): Observable<EntityActionPermission[]> {
    // Fetch all entity actions from the public view
    return this.http.get<any[]>(
      getPostgrestUrl() + 'schema_entity_actions?select=id,table_name,action_name,display_name,description&order=table_name,sort_order'
    ).pipe(
      map(actions => {
        // We'll check permissions in a separate call and merge
        return actions.map(a => ({
          id: a.id,
          table_name: a.table_name,
          action_name: a.action_name,
          display_name: a.display_name,
          description: a.description,
          has_permission: false // Will be updated by getEntityActionRoles
        }));
      }),
      catchError((error) => {
        console.error('Error fetching entity actions:', error);
        return of([]);
      })
    );
  }

  /**
   * Get entity action role assignments for a specific role.
   * Returns action IDs that the role has permission to execute.
   * Uses RPC function since entity_action_roles is in metadata schema.
   */
  getEntityActionRoles(roleId: number): Observable<number[]> {
    return this.http.post<any[]>(
      getPostgrestUrl() + 'rpc/get_entity_action_roles',
      { p_role_id: roleId }
    ).pipe(
      map(rows => rows.map(r => r.entity_action_id)),
      catchError((error) => {
        console.error('Error fetching entity action roles:', error);
        return of([]);
      })
    );
  }

  /**
   * Grant or revoke entity action permission for a role.
   * Uses RPC functions since entity_action_roles is in metadata schema.
   */
  setEntityActionPermission(actionId: number, roleId: number, enabled: boolean): Observable<ApiResponse> {
    const rpcName = enabled ? 'grant_entity_action_permission' : 'revoke_entity_action_permission';

    return this.http.post<any>(
      getPostgrestUrl() + `rpc/${rpcName}`,
      { p_action_id: actionId, p_role_id: roleId }
    ).pipe(
      map((response) => {
        if (response?.success === false) {
          return <ApiResponse>{
            success: false,
            error: { message: response.error, humanMessage: response.error }
          };
        }
        return <ApiResponse>{ success: true };
      }),
      catchError((error) => {
        return of(<ApiResponse>{
          success: false,
          error: { message: error.message, humanMessage: enabled ? 'Failed to grant permission' : 'Failed to revoke permission' }
        });
      })
    );
  }

  // =========================================================================
  // ROLE DELEGATION (v0.31.0)
  // =========================================================================

  getRoleCanManage(roleId: number): Observable<RoleDelegation[]> {
    return this.http.post<RoleDelegation[]>(
      getPostgrestUrl() + 'rpc/get_role_can_manage',
      { p_manager_role_id: roleId }
    ).pipe(
      catchError((error) => {
        console.error('Error fetching role delegation:', error);
        return of([]);
      })
    );
  }

  setRoleCanManage(managerRoleId: number, managedRoleId: number, enabled: boolean): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/set_role_can_manage',
      {
        p_manager_role_id: managerRoleId,
        p_managed_role_id: managedRoleId,
        p_enabled: enabled
      }
    ).pipe(
      map((response) => {
        if (response?.success === false) {
          return <ApiResponse>{
            success: false,
            error: { message: response.error, humanMessage: response.error }
          };
        }
        return <ApiResponse>{ success: true };
      }),
      catchError((error) => {
        return of(<ApiResponse>{
          success: false,
          error: { message: error.message, humanMessage: 'Failed to update role delegation' }
        });
      })
    );
  }

  deleteRole(roleId: number): Observable<ApiResponse> {
    return this.http.post<any>(
      getPostgrestUrl() + 'rpc/delete_role',
      { p_role_id: roleId }
    ).pipe(
      map((response) => {
        if (response?.success === false) {
          return <ApiResponse>{
            success: false,
            error: { message: response.error, humanMessage: response.error }
          };
        }
        return <ApiResponse>{ success: true };
      }),
      catchError((error) => {
        return of(<ApiResponse>{
          success: false,
          error: { message: error.message, humanMessage: 'Failed to delete role' }
        });
      })
    );
  }
}
