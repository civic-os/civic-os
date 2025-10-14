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

import { Component, inject, signal, computed, effect, ChangeDetectionStrategy } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';

import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { PermissionsService, Role, RolePermission } from '../../services/permissions.service';
import { AuthService } from '../../services/auth.service';
import { forkJoin, of, switchMap, map, catchError, BehaviorSubject, take } from 'rxjs';
import { environment } from '../../../environments/environment';

interface PermissionMatrix {
  tableName: string;
  create: boolean;
  read: boolean;
  update: boolean;
  delete: boolean;
}

interface PermissionsData {
  roles: Role[];
  permissionMatrix: PermissionMatrix[];
  loading: boolean;
  error?: string;
}

@Component({
  selector: 'app-permissions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './permissions.page.html',
  styleUrl: './permissions.page.css'
})
export class PermissionsPage {
  private permissionsService = inject(PermissionsService);
  public auth = inject(AuthService);

  permissionTypes = ['create', 'read', 'update', 'delete'];

  // Modal state for creating roles
  showCreateModal = signal(false);
  newRoleName = signal('');
  newRoleDescription = signal('');
  createLoading = signal(false);
  createError = signal<string | undefined>(undefined);
  successMessage = signal<string | undefined>(undefined);
  newlyCreatedRoleName = signal<string | undefined>(undefined);

  // Keycloak admin URL (master is the admin realm, target realm comes after the hash)
  keycloakRolesUrl = `${environment.keycloak.url}/admin/master/console/#/${environment.keycloak.realm}/roles`;

  // Check if user is admin
  isAdmin = toSignal(
    this.permissionsService.isAdmin().pipe(
      catchError(() => of(false))
    ),
    { initialValue: false }
  );

  // Track selected role ID (user input)
  selectedRoleId = signal<number | undefined>(undefined);

  // Create a subject to trigger permission reloads
  private selectedRoleIdSubject = new BehaviorSubject<number | undefined>(undefined);

  // Load all data reactively
  private data = toSignal(
    this.permissionsService.isAdmin().pipe(
      switchMap(isAdmin => {
        if (!isAdmin) {
          return of({
            roles: [],
            permissionMatrix: [],
            loading: false,
            error: 'Admin access required'
          } as PermissionsData);
        }

        // Load roles first
        return this.permissionsService.getRoles().pipe(
          switchMap(roles => {
            if (roles.length === 0) {
              return of({
                roles: [],
                permissionMatrix: [],
                loading: false
              } as PermissionsData);
            }

            // Auto-select first role
            const firstRoleId = roles[0].id;
            this.selectedRoleId.set(firstRoleId);
            this.selectedRoleIdSubject.next(firstRoleId);

            // Load permissions for selected role
            return this.selectedRoleIdSubject.pipe(
              switchMap(roleId => {
                if (roleId === undefined) {
                  return of({ roles, permissionMatrix: [], loading: false } as PermissionsData);
                }

                return forkJoin({
                  tables: this.permissionsService.getTables().pipe(take(1)),
                  permissions: this.permissionsService.getRolePermissions(roleId).pipe(take(1))
                }).pipe(
                  map(({ tables, permissions }) => {
                    const matrix = this.buildPermissionMatrix(tables, permissions);
                    return {
                      roles,
                      permissionMatrix: matrix,
                      loading: false
                    } as PermissionsData;
                  }),
                  catchError(() => of({
                    roles,
                    permissionMatrix: [],
                    loading: false,
                    error: 'Failed to load permissions'
                  } as PermissionsData))
                );
              })
            );
          }),
          catchError(() => of({
            roles: [],
            permissionMatrix: [],
            loading: false,
            error: 'Failed to load roles'
          } as PermissionsData))
        );
      }),
      catchError(() => of({
        roles: [],
        permissionMatrix: [],
        loading: false,
        error: 'Failed to verify admin access'
      } as PermissionsData))
    ),
    { initialValue: { roles: [], permissionMatrix: [], loading: true } as PermissionsData }
  );

  // Expose computed signals for template
  roles = computed(() => this.data()?.roles || []);
  permissionMatrix = computed(() => this.data()?.permissionMatrix || []);
  loading = computed(() => this.data()?.loading ?? true);
  error = computed(() => this.data()?.error);

  onRoleChange(newRoleId: number) {
    this.selectedRoleId.set(newRoleId);
    this.selectedRoleIdSubject.next(newRoleId);
  }

  private buildPermissionMatrix(tables: string[], permissions: RolePermission[]): PermissionMatrix[] {
    return tables.map(tableName => {
      const tablePerms = permissions.filter(p => p.table_name === tableName);
      return {
        tableName,
        create: tablePerms.find(p => p.permission_type === 'create')?.has_permission || false,
        read: tablePerms.find(p => p.permission_type === 'read')?.has_permission || false,
        update: tablePerms.find(p => p.permission_type === 'update')?.has_permission || false,
        delete: tablePerms.find(p => p.permission_type === 'delete')?.has_permission || false
      };
    });
  }

  togglePermission(tableName: string, permission: string, currentValue: boolean) {
    const roleId = this.selectedRoleId();
    if (roleId === undefined) return;

    const newValue = !currentValue;

    this.permissionsService.setRolePermission(
      roleId,
      tableName,
      permission,
      newValue
    ).subscribe({
      next: (response) => {
        if (response.success) {
          // Reload permissions to get fresh data
          this.selectedRoleIdSubject.next(roleId);
        } else {
          // Could use a separate error signal here
          console.error('Failed to update permission:', response.error);
        }
      },
      error: (err) => {
        console.error('Failed to update permission:', err);
      }
    });
  }

  openCreateRoleModal() {
    // Reset form state
    this.newRoleName.set('');
    this.newRoleDescription.set('');
    this.createError.set(undefined);
    this.successMessage.set(undefined);
    this.newlyCreatedRoleName.set(undefined);
    this.showCreateModal.set(true);
  }

  closeCreateRoleModal() {
    this.showCreateModal.set(false);
  }

  validateRoleName(name: string): string | undefined {
    if (!name || name.trim() === '') {
      return 'Role name is required';
    }
    // Allow alphanumeric, underscore, hyphen
    if (!/^[a-zA-Z0-9_-]+$/.test(name.trim())) {
      return 'Role name can only contain letters, numbers, underscores, and hyphens';
    }
    return undefined;
  }

  submitCreateRole() {
    const roleName = this.newRoleName().trim();
    const description = this.newRoleDescription().trim();

    // Validate
    const validationError = this.validateRoleName(roleName);
    if (validationError) {
      this.createError.set(validationError);
      return;
    }

    // Clear errors and start loading
    this.createError.set(undefined);
    this.createLoading.set(true);

    this.permissionsService.createRole(roleName, description || undefined).subscribe({
      next: (response) => {
        this.createLoading.set(false);
        if (response.success && response.roleId) {
          // Success! Close modal and show success message
          this.showCreateModal.set(false);
          this.successMessage.set(`Role '${roleName}' created successfully!`);
          this.newlyCreatedRoleName.set(roleName);

          // Reload roles and auto-select the new role
          this.permissionsService.getRoles().subscribe({
            next: (roles) => {
              const newRole = roles.find(r => r.id === response.roleId);
              if (newRole) {
                this.selectedRoleId.set(newRole.id);
                this.selectedRoleIdSubject.next(newRole.id);
              }
            }
          });
        } else {
          this.createError.set(response.error?.humanMessage || 'Failed to create role');
        }
      },
      error: (err) => {
        this.createLoading.set(false);
        this.createError.set('Failed to create role. Please try again.');
      }
    });
  }

  dismissSuccess() {
    this.successMessage.set(undefined);
    this.newlyCreatedRoleName.set(undefined);
  }
}
