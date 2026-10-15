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

import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { PermissionsService } from './permissions.service';
import { SchemaService } from './schema.service';
import { firstValueFrom } from 'rxjs';

describe('PermissionsService', () => {
    let service: PermissionsService;
    let httpMock: HttpTestingController;
    const testPostgrestUrl = 'http://test-api.example.com/';

    beforeEach(() => {
        // Mock runtime configuration
        (window as any).civicOsConfig = {
            postgrestUrl: testPostgrestUrl
        };

        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                PermissionsService,
                {
                    provide: SchemaService,
                    useValue: {
                        getEntities: () => of([
                            { table_name: 'issues', display_name: 'Issues' },
                            { table_name: 'users', display_name: 'Users' }
                        ])
                    }
                }
            ]
        });
        service = TestBed.inject(PermissionsService);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify();
        // Clean up mock
        delete (window as any).civicOsConfig;
    });

    describe('Basic Service Setup', () => {
        it('should be created', () => {
            expect(service).toBeTruthy();
        });
    });

    describe('getRoles()', () => {
        it('should call get_roles RPC function', async () => {
            const mockRoles = [
                { id: 1, display_name: 'admin', description: 'Administrator', role_key: 'admin' },
                { id: 2, display_name: 'user', description: 'Regular user', role_key: 'user' }
            ];

            const result$ = firstValueFrom(service.getRoles());

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_roles');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({});
            req.flush(mockRoles);
            const roles = await result$;
            expect(roles).toEqual(mockRoles);
        });

        it('should return empty array on error', async () => {
            const result$ = firstValueFrom(service.getRoles());

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_roles');
            req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
            const roles = await result$;
            expect(roles).toEqual([]);
        });
    });

    describe('getTables()', () => {
        it('should get tables from schema service', async () => {
            const result$ = firstValueFrom(service.getTables());
            const tables = await result$;
            expect(tables).toEqual(['issues', 'users']);
        });
    });

    describe('getRolePermissions()', () => {
        it('should call get_role_permissions with role ID', async () => {
            const mockPermissions = [
                { role_id: 1, role_name: 'admin', table_name: 'issues', permission_type: 'read', has_permission: 't' },
                { role_id: 1, role_name: 'admin', table_name: 'issues', permission_type: 'create', has_permission: 't' }
            ];

            const result$ = firstValueFrom(service.getRolePermissions(1));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_role_permissions');
            expect(req.request.body).toEqual({ p_role_id: 1 });
            req.flush(mockPermissions);
            const permissions = await result$;
            expect(permissions.length).toBe(2);
            expect(permissions[0].has_permission).toBe(true); // Converted from 't'
            expect(permissions[1].has_permission).toBe(true);
        });

        it('should convert PostgreSQL boolean strings to JavaScript booleans', async () => {
            const mockPermissions = [
                { role_id: 1, role_name: 'user', table_name: 'issues', permission_type: 'read', has_permission: 't' },
                { role_id: 1, role_name: 'user', table_name: 'issues', permission_type: 'create', has_permission: 'f' }
            ];

            const result$ = firstValueFrom(service.getRolePermissions(1));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_role_permissions');
            req.flush(mockPermissions);
            const permissions = await result$;
            expect(permissions[0].has_permission).toBe(true);
            expect(permissions[1].has_permission).toBe(false);
        });

        it('should return empty array on error', async () => {
            const result$ = firstValueFrom(service.getRolePermissions(1));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_role_permissions');
            req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
            const permissions = await result$;
            expect(permissions).toEqual([]);
        });
    });

    describe('setRolePermission()', () => {
        it('should call set_role_permission RPC function', async () => {
            const result$ = firstValueFrom(service.setRolePermission(1, 'issues', 'read', true));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_permission');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({
                p_role_id: 1,
                p_table_name: 'issues',
                p_permission: 'read',
                p_enabled: true
            });
            req.flush({});
            const response = await result$;
            expect(response.success).toBe(true);
        });

        it('should handle API error responses', async () => {
            const errorResponse = { success: false, error: 'Permission not found' };

            const result$ = firstValueFrom(service.setRolePermission(1, 'issues', 'invalid', true));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_permission');
            req.flush(errorResponse);
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Permission not found');
        });

        it('should handle HTTP errors', async () => {
            const result$ = firstValueFrom(service.setRolePermission(1, 'issues', 'read', true));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_permission');
            req.flush({ message: 'Error' }, { status: 403, statusText: 'Forbidden' });
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Failed to update permission');
        });
    });

    describe('isAdmin()', () => {
        it('should call is_admin RPC function', async () => {
            const result$ = firstValueFrom(service.isAdmin());

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/is_admin');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({});
            req.flush(true);
            const isAdmin = await result$;
            expect(isAdmin).toBe(true);
        });

        it('should return false on error', async () => {
            const result$ = firstValueFrom(service.isAdmin());

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/is_admin');
            req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
            const isAdmin = await result$;
            expect(isAdmin).toBe(false);
        });
    });

    describe('createRole()', () => {
        it('should call create_role RPC function with role name and description', async () => {
            const responseBody = { success: true, role_id: 5 };

            const result$ = firstValueFrom(service.createRole('moderator', 'Moderates content'));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({
                p_display_name: 'moderator',
                p_description: 'Moderates content'
            });
            req.flush(responseBody);
            const response = await result$;
            expect(response.success).toBe(true);
            expect(response.roleId).toBe(5);
        });

        it('should handle role creation without description', async () => {
            const responseBody = { success: true, role_id: 6 };

            const result$ = firstValueFrom(service.createRole('viewer'));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
            expect(req.request.body).toEqual({
                p_display_name: 'viewer',
                p_description: null
            });
            req.flush(responseBody);
            const response = await result$;
            expect(response.success).toBe(true);
            expect(response.roleId).toBe(6);
        });

        it('should handle duplicate role name error', async () => {
            const errorResponse = { success: false, error: 'Role with this name already exists' };

            const result$ = firstValueFrom(service.createRole('admin'));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
            req.flush(errorResponse);
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Role with this name already exists');
        });

        it('should handle empty role name error', async () => {
            const errorResponse = { success: false, error: 'Role name cannot be empty' };

            const result$ = firstValueFrom(service.createRole(''));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
            req.flush(errorResponse);
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Role name cannot be empty');
        });

        it('should handle admin permission error', async () => {
            const errorResponse = { success: false, error: 'Admin access required' };

            const result$ = firstValueFrom(service.createRole('hacker'));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
            req.flush(errorResponse);
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Admin access required');
        });

        it('should handle network errors', async () => {
            const result$ = firstValueFrom(service.createRole('moderator'));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
            req.error(new ProgressEvent('Network error'), { status: 0 });
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Failed to create role');
        });

        it('should handle HTTP 500 errors', async () => {
            const result$ = firstValueFrom(service.createRole('moderator'));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
            req.flush({ message: 'Internal server error' }, { status: 500, statusText: 'Internal Server Error' });
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Failed to create role');
        });
    });

    describe('getRoleCanManage()', () => {
        it('should POST to get_role_can_manage RPC with role ID', async () => {
            const mockDelegations = [
                { managed_role_id: 2, managed_role_name: 'editor', managed_role_key: 'editor' },
                { managed_role_id: 3, managed_role_name: 'user', managed_role_key: 'user' }
            ];

            const result$ = firstValueFrom(service.getRoleCanManage(1));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_role_can_manage');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({ p_manager_role_id: 1 });
            req.flush(mockDelegations);
            const delegations = await result$;
            expect(delegations).toEqual(mockDelegations);
        });

        it('should return empty array on error', async () => {
            const result$ = firstValueFrom(service.getRoleCanManage(1));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_role_can_manage');
            req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
            const delegations = await result$;
            expect(delegations).toEqual([]);
        });
    });

    describe('setRoleCanManage()', () => {
        it('should POST correct params for enabling delegation', async () => {
            const result$ = firstValueFrom(service.setRoleCanManage(1, 2, true));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_can_manage');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({
                p_manager_role_id: 1,
                p_managed_role_id: 2,
                p_enabled: true
            });
            req.flush({ success: true });
            const response = await result$;
            expect(response.success).toBe(true);
        });

        it('should POST correct params for disabling delegation', async () => {
            const result$ = firstValueFrom(service.setRoleCanManage(1, 2, false));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_can_manage');
            expect(req.request.body).toEqual({
                p_manager_role_id: 1,
                p_managed_role_id: 2,
                p_enabled: false
            });
            req.flush({ success: true });
            const response = await result$;
            expect(response.success).toBe(true);
        });

        it('should handle API error response', async () => {
            const result$ = firstValueFrom(service.setRoleCanManage(1, 2, true));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_can_manage');
            req.flush({ success: false, error: 'Admin access required' });
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Admin access required');
        });

        it('should handle HTTP error', async () => {
            const result$ = firstValueFrom(service.setRoleCanManage(1, 2, true));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_can_manage');
            req.flush({ message: 'Error' }, { status: 403, statusText: 'Forbidden' });
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Failed to update role delegation');
        });
    });

    describe('deleteRole()', () => {
        it('should POST to delete_role RPC with role ID and return affected_users', async () => {
            const result$ = firstValueFrom(service.deleteRole(5));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/delete_role');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({ p_role_id: 5 });
            req.flush({ success: true, message: 'Role "volunteer" deleted', affected_users: 3 });
            const response = await result$;
            expect(response.success).toBe(true);
            expect(response.body?.affected_users).toBe(3);
        });

        it('should handle built-in role error', async () => {
            const result$ = firstValueFrom(service.deleteRole(1));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/delete_role');
            req.flush({ success: false, error: 'Cannot delete built-in role "user"' });
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Cannot delete built-in role "user"');
        });

        it('should handle HTTP error', async () => {
            const result$ = firstValueFrom(service.deleteRole(5));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/delete_role');
            req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Failed to delete role');
        });
    });
});
