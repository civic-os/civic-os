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
import { UserManagementService } from './user-management.service';
import { AuthService } from './auth.service';

describe('UserManagementService', () => {
    let service: UserManagementService;
    let httpMock: HttpTestingController;
    let mockAuthService: any;
    const testPostgrestUrl = 'http://test-api.example.com/';

    beforeEach(() => {
        (window as any).civicOsConfig = {
            postgrestUrl: testPostgrestUrl
        };

        mockAuthService = {
            hasPermission: vi.fn().mockName("AuthService.hasPermission")
        };
        mockAuthService.hasPermission.mockReturnValue(true);

        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                UserManagementService,
                { provide: AuthService, useValue: mockAuthService }
            ]
        });
        service = TestBed.inject(UserManagementService);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify();
        delete (window as any).civicOsConfig;
    });

    describe('Basic Service Setup', () => {
        it('should be created', () => {
            expect(service).toBeTruthy();
        });
    });

    describe('getManagedUsers()', () => {
        it('should call managed_users endpoint with default ordering', async () => {
            const mockUsers = [
                { id: '1', display_name: 'Test User', email: 'test@example.com', status: 'active', provision_id: null }
            ];

            service.getManagedUsers().subscribe(users => {
                expect(users).toEqual(mockUsers as any);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'managed_users?order=created_at.desc');
            expect(req.request.method).toBe('GET');
            req.flush(mockUsers);
        });

        it('should append search filter when provided', () => {
            service.getManagedUsers('jane').subscribe();

            const req = httpMock.expectOne((r) => r.url.includes('managed_users') && r.url.includes('ilike.*jane*'));
            expect(req.request.method).toBe('GET');
            req.flush([]);
        });

        it('should append status filter when not "all"', () => {
            service.getManagedUsers(undefined, 'active').subscribe();

            const req = httpMock.expectOne((r) => r.url.includes('managed_users') && r.url.includes('status=eq.active'));
            expect(req.request.method).toBe('GET');
            req.flush([]);
        });

        it('should not append status filter when "all"', () => {
            service.getManagedUsers(undefined, 'all').subscribe();

            const req = httpMock.expectOne(testPostgrestUrl + 'managed_users?order=created_at.desc');
            req.flush([]);
        });

        it('should return empty array on error', async () => {
            service.getManagedUsers().subscribe(users => {
                expect(users).toEqual([]);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'managed_users?order=created_at.desc');
            req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
        });
    });

    describe('createUser()', () => {
        it('should POST to create_provisioned_user RPC with p_-prefixed params', async () => {
            const user = { email: 'new@test.com', first_name: 'New', last_name: 'User' };

            service.createUser(user).subscribe(response => {
                expect(response.success).toBe(true);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_provisioned_user');
            expect(req.request.method).toBe('POST');
            expect(req.request.body.p_email).toBe('new@test.com');
            expect(req.request.body.p_first_name).toBe('New');
            expect(req.request.body.p_last_name).toBe('User');
            req.flush({ success: true, provision_id: 1 });
        });

        it('should handle RPC error response', async () => {
            const user = { email: 'bad@test.com', first_name: 'Bad', last_name: 'User', initial_roles: ['nonexistent'] };

            service.createUser(user).subscribe(response => {
                expect(response.success).toBe(false);
                expect(response.error?.humanMessage).toBe('Role "nonexistent" does not exist');
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_provisioned_user');
            req.flush({ success: false, error: 'Role "nonexistent" does not exist' });
        });

        it('should handle HTTP error', async () => {
            const user = { email: 'denied@test.com', first_name: 'Denied', last_name: 'User' };

            service.createUser(user).subscribe(response => {
                expect(response.success).toBe(false);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_provisioned_user');
            req.flush({ message: 'Forbidden' }, { status: 403, statusText: 'Forbidden' });
        });
    });

    describe('importUsers()', () => {
        it('should POST to bulk_provision_users RPC with users array', async () => {
            const users = [
                { email: 'a@test.com', first_name: 'A', last_name: 'User' },
                { email: 'b@test.com', first_name: 'B', last_name: 'User' }
            ];

            service.importUsers(users).subscribe(response => {
                expect(response.success).toBe(true);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/bulk_provision_users');
            expect(req.request.method).toBe('POST');
            expect(req.request.body.p_users).toEqual(users);
            req.flush({ success: true, created_count: 2, error_count: 0, errors: [] });
        });

        it('should handle partial failure response', async () => {
            service.importUsers([{ email: 'a@test.com', first_name: 'A', last_name: 'User' }]).subscribe(response => {
                expect(response.success).toBe(false);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/bulk_provision_users');
            req.flush({ success: false, created_count: 0, error_count: 1, errors: [{ index: 1, email: 'a@test.com', error: 'Duplicate email' }] });
        });

        it('should handle HTTP error', async () => {
            service.importUsers([]).subscribe(response => {
                expect(response.success).toBe(false);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/bulk_provision_users');
            req.flush({ message: 'Bulk import failed' }, { status: 400, statusText: 'Bad Request' });
        });
    });

    describe('importUsersDetailed()', () => {
        it('should POST to rpc/bulk_provision_users with users array', async () => {
            const users = [
                { email: 'a@test.com', first_name: 'A', last_name: 'User' }
            ];

            service.importUsersDetailed(users).subscribe(result => {
                expect(result.success).toBe(true);
                expect(result.created_count).toBe(1);
                expect(result.error_count).toBe(0);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/bulk_provision_users');
            expect(req.request.method).toBe('POST');
            expect(req.request.body.p_users).toEqual(users);
            req.flush({ success: true, created_count: 1, error_count: 0, errors: [] });
        });

        it('should return full BulkProvisionResult on partial failure', async () => {
            const users = [
                { email: 'a@test.com', first_name: 'A', last_name: 'User' },
                { email: 'b@test.com', first_name: 'B', last_name: 'User' }
            ];

            service.importUsersDetailed(users).subscribe(result => {
                expect(result.success).toBe(false);
                expect(result.created_count).toBe(1);
                expect(result.error_count).toBe(1);
                expect(result.errors.length).toBe(1);
                expect(result.errors[0].email).toBe('b@test.com');
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/bulk_provision_users');
            req.flush({
                success: false,
                created_count: 1,
                error_count: 1,
                errors: [{ index: 2, email: 'b@test.com', error: 'Duplicate email' }]
            });
        });

        it('should handle HTTP error with fallback error response', async () => {
            service.importUsersDetailed([{ email: 'a@test.com', first_name: 'A', last_name: 'User' }]).subscribe(result => {
                expect(result.success).toBe(false);
                expect(result.created_count).toBe(0);
                expect(result.error_count).toBe(1);
                expect(result.errors.length).toBe(1);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/bulk_provision_users');
            req.flush({ message: 'Server error' }, { status: 500, statusText: 'Internal Server Error' });
        });
    });

    describe('retryProvisioning()', () => {
        it('should POST to retry_user_provisioning RPC', async () => {
            service.retryProvisioning(42).subscribe(response => {
                expect(response.success).toBe(true);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/retry_user_provisioning');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({ p_provision_id: 42 });
            req.flush({ success: true });
        });

        it('should handle RPC error response', async () => {
            service.retryProvisioning(42).subscribe(response => {
                expect(response.success).toBe(false);
                expect(response.error?.humanMessage).toBe('Only failed requests can be retried');
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/retry_user_provisioning');
            req.flush({ success: false, error: 'Only failed requests can be retried' });
        });

        it('should handle HTTP error', async () => {
            service.retryProvisioning(42).subscribe(response => {
                expect(response.success).toBe(false);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/retry_user_provisioning');
            req.flush({ message: 'Not found' }, { status: 400, statusText: 'Bad Request' });
        });
    });

    describe('getManageableRoles()', () => {
        it('should POST to get_manageable_roles RPC', async () => {
            const mockRoles = [
                { role_id: 1, display_name: 'user', description: 'Basic user', role_key: 'user' },
                { role_id: 2, display_name: 'editor', description: 'Can edit', role_key: 'editor' }
            ];

            service.getManageableRoles().subscribe(roles => {
                expect(roles).toEqual(mockRoles);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_manageable_roles');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({});
            req.flush(mockRoles);
        });

        it('should return empty array on error', async () => {
            service.getManageableRoles().subscribe(roles => {
                expect(roles).toEqual([]);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_manageable_roles');
            req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
        });
    });

    describe('assignUserRole()', () => {
        it('should POST to assign_user_role RPC with correct params', async () => {
            service.assignUserRole('uuid-123', 'editor').subscribe(response => {
                expect(response.success).toBe(true);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/assign_user_role');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({ p_user_id: 'uuid-123', p_role_name: 'editor' });
            req.flush({ success: true, message: 'Role "editor" assigned' });
        });

        it('should handle delegation violation error from API', async () => {
            service.assignUserRole('uuid-123', 'admin').subscribe(response => {
                expect(response.success).toBe(false);
                expect(response.error?.humanMessage).toBe('Your role cannot assign the "admin" role');
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/assign_user_role');
            req.flush({ success: false, error: 'Your role cannot assign the "admin" role' });
        });

        it('should handle HTTP error', async () => {
            service.assignUserRole('uuid-123', 'editor').subscribe(response => {
                expect(response.success).toBe(false);
                expect(response.error?.humanMessage).toBe('Failed to assign role');
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/assign_user_role');
            req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
        });
    });

    describe('revokeUserRole()', () => {
        it('should POST to revoke_user_role RPC with correct params', async () => {
            service.revokeUserRole('uuid-123', 'editor').subscribe(response => {
                expect(response.success).toBe(true);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/revoke_user_role');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({ p_user_id: 'uuid-123', p_role_name: 'editor' });
            req.flush({ success: true, message: 'Role "editor" revoked' });
        });

        it('should handle delegation violation error from API', async () => {
            service.revokeUserRole('uuid-123', 'admin').subscribe(response => {
                expect(response.success).toBe(false);
                expect(response.error?.humanMessage).toBe('Your role cannot revoke the "admin" role');
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/revoke_user_role');
            req.flush({ success: false, error: 'Your role cannot revoke the "admin" role' });
        });

        it('should handle HTTP error', async () => {
            service.revokeUserRole('uuid-123', 'editor').subscribe(response => {
                expect(response.success).toBe(false);
                expect(response.error?.humanMessage).toBe('Failed to revoke role');
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/revoke_user_role');
            req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
        });
    });

    describe('updateUserInfo()', () => {
        it('should POST to update_user_info RPC with p_-prefixed params', async () => {
            service.updateUserInfo({
                user_id: 'uuid-456',
                first_name: 'Jane',
                last_name: 'Doe',
                phone: '5559876543'
            }).subscribe(response => {
                expect(response.success).toBe(true);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/update_user_info');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({
                p_user_id: 'uuid-456',
                p_first_name: 'Jane',
                p_last_name: 'Doe',
                p_phone: '5559876543'
            });
            req.flush({ success: true, message: 'User info updated' });
        });

        it('should send null phone when not provided', () => {
            service.updateUserInfo({
                user_id: 'uuid-456',
                first_name: 'Jane',
                last_name: 'Doe'
            }).subscribe();

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/update_user_info');
            expect(req.request.body.p_phone).toBeNull();
            req.flush({ success: true });
        });

        it('should handle RPC error response', async () => {
            service.updateUserInfo({
                user_id: 'uuid-456', first_name: 'Jane', last_name: 'Doe'
            }).subscribe(response => {
                expect(response.success).toBe(false);
                expect(response.error?.humanMessage).toBe('Permission denied');
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/update_user_info');
            req.flush({ success: false, error: 'Permission denied' });
        });

        it('should handle HTTP error', async () => {
            service.updateUserInfo({
                user_id: 'uuid-456', first_name: 'Jane', last_name: 'Doe'
            }).subscribe(response => {
                expect(response.success).toBe(false);
                expect(response.error?.humanMessage).toBe('Internal error');
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/update_user_info');
            req.flush({ message: 'Internal error' }, { status: 500, statusText: 'Internal Server Error' });
        });
    });

    describe('hasUserManagementAccess()', () => {
        it('should delegate to AuthService.hasPermission', () => {
            mockAuthService.hasPermission.mockReturnValue(true);

            const result = service.hasUserManagementAccess();
            expect(result).toBe(true);
            expect(mockAuthService.hasPermission).toHaveBeenCalledWith('civic_os_users_private', 'update');
        });

        it('should return false when permission denied', () => {
            mockAuthService.hasPermission.mockReturnValue(false);

            const result = service.hasUserManagementAccess();
            expect(result).toBe(false);
        });
    });
});
