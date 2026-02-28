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
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { PermissionsService } from './permissions.service';
import { SchemaService } from './schema.service';

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
        provideHttpClient(),
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
    it('should call get_roles RPC function', (done) => {
      const mockRoles = [
        { id: 1, display_name: 'admin', description: 'Administrator' },
        { id: 2, display_name: 'user', description: 'Regular user' }
      ];

      service.getRoles().subscribe(roles => {
        expect(roles).toEqual(mockRoles);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_roles');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({});
      req.flush(mockRoles);
    });

    it('should return empty array on error', (done) => {
      service.getRoles().subscribe(roles => {
        expect(roles).toEqual([]);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_roles');
      req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
    });
  });

  describe('getTables()', () => {
    it('should get tables from schema service', (done) => {
      service.getTables().subscribe(tables => {
        expect(tables).toEqual(['issues', 'users']);
        done();
      });
    });
  });

  describe('getRolePermissions()', () => {
    it('should call get_role_permissions with role ID', (done) => {
      const mockPermissions = [
        { role_id: 1, role_name: 'admin', table_name: 'issues', permission_type: 'read', has_permission: 't' },
        { role_id: 1, role_name: 'admin', table_name: 'issues', permission_type: 'create', has_permission: 't' }
      ];

      service.getRolePermissions(1).subscribe(permissions => {
        expect(permissions.length).toBe(2);
        expect(permissions[0].has_permission).toBe(true); // Converted from 't'
        expect(permissions[1].has_permission).toBe(true);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_role_permissions');
      expect(req.request.body).toEqual({ p_role_id: 1 });
      req.flush(mockPermissions);
    });

    it('should convert PostgreSQL boolean strings to JavaScript booleans', (done) => {
      const mockPermissions = [
        { role_id: 1, role_name: 'user', table_name: 'issues', permission_type: 'read', has_permission: 't' },
        { role_id: 1, role_name: 'user', table_name: 'issues', permission_type: 'create', has_permission: 'f' }
      ];

      service.getRolePermissions(1).subscribe(permissions => {
        expect(permissions[0].has_permission).toBe(true);
        expect(permissions[1].has_permission).toBe(false);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_role_permissions');
      req.flush(mockPermissions);
    });

    it('should return empty array on error', (done) => {
      service.getRolePermissions(1).subscribe(permissions => {
        expect(permissions).toEqual([]);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_role_permissions');
      req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
    });
  });

  describe('setRolePermission()', () => {
    it('should call set_role_permission RPC function', (done) => {
      service.setRolePermission(1, 'issues', 'read', true).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_permission');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_role_id: 1,
        p_table_name: 'issues',
        p_permission: 'read',
        p_enabled: true
      });
      req.flush({});
    });

    it('should handle API error responses', (done) => {
      const errorResponse = { success: false, error: 'Permission not found' };

      service.setRolePermission(1, 'issues', 'invalid', true).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Permission not found');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_permission');
      req.flush(errorResponse);
    });

    it('should handle HTTP errors', (done) => {
      service.setRolePermission(1, 'issues', 'read', true).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Failed to update permission');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_permission');
      req.flush({ message: 'Error' }, { status: 403, statusText: 'Forbidden' });
    });
  });

  describe('isAdmin()', () => {
    it('should call is_admin RPC function', (done) => {
      service.isAdmin().subscribe(isAdmin => {
        expect(isAdmin).toBe(true);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/is_admin');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({});
      req.flush(true);
    });

    it('should return false on error', (done) => {
      service.isAdmin().subscribe(isAdmin => {
        expect(isAdmin).toBe(false);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/is_admin');
      req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
    });
  });

  describe('createRole()', () => {
    it('should call create_role RPC function with role name and description', (done) => {
      const responseBody = { success: true, role_id: 5 };

      service.createRole('moderator', 'Moderates content').subscribe(response => {
        expect(response.success).toBe(true);
        expect(response.roleId).toBe(5);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_display_name: 'moderator',
        p_description: 'Moderates content'
      });
      req.flush(responseBody);
    });

    it('should handle role creation without description', (done) => {
      const responseBody = { success: true, role_id: 6 };

      service.createRole('viewer').subscribe(response => {
        expect(response.success).toBe(true);
        expect(response.roleId).toBe(6);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
      expect(req.request.body).toEqual({
        p_display_name: 'viewer',
        p_description: null
      });
      req.flush(responseBody);
    });

    it('should handle duplicate role name error', (done) => {
      const errorResponse = { success: false, error: 'Role with this name already exists' };

      service.createRole('admin').subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Role with this name already exists');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
      req.flush(errorResponse);
    });

    it('should handle empty role name error', (done) => {
      const errorResponse = { success: false, error: 'Role name cannot be empty' };

      service.createRole('').subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Role name cannot be empty');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
      req.flush(errorResponse);
    });

    it('should handle admin permission error', (done) => {
      const errorResponse = { success: false, error: 'Admin access required' };

      service.createRole('hacker').subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Admin access required');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
      req.flush(errorResponse);
    });

    it('should handle network errors', (done) => {
      service.createRole('moderator').subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Failed to create role');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
      req.error(new ProgressEvent('Network error'), { status: 0 });
    });

    it('should handle HTTP 500 errors', (done) => {
      service.createRole('moderator').subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Failed to create role');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/create_role');
      req.flush({ message: 'Internal server error' }, { status: 500, statusText: 'Internal Server Error' });
    });
  });

  describe('getRoleCanManage()', () => {
    it('should POST to get_role_can_manage RPC with role ID', (done) => {
      const mockDelegations = [
        { managed_role_id: 2, managed_role_name: 'editor' },
        { managed_role_id: 3, managed_role_name: 'user' }
      ];

      service.getRoleCanManage(1).subscribe(delegations => {
        expect(delegations).toEqual(mockDelegations);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_role_can_manage');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ p_manager_role_id: 1 });
      req.flush(mockDelegations);
    });

    it('should return empty array on error', (done) => {
      service.getRoleCanManage(1).subscribe(delegations => {
        expect(delegations).toEqual([]);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_role_can_manage');
      req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
    });
  });

  describe('setRoleCanManage()', () => {
    it('should POST correct params for enabling delegation', (done) => {
      service.setRoleCanManage(1, 2, true).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_can_manage');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_manager_role_id: 1,
        p_managed_role_id: 2,
        p_enabled: true
      });
      req.flush({ success: true });
    });

    it('should POST correct params for disabling delegation', (done) => {
      service.setRoleCanManage(1, 2, false).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_can_manage');
      expect(req.request.body).toEqual({
        p_manager_role_id: 1,
        p_managed_role_id: 2,
        p_enabled: false
      });
      req.flush({ success: true });
    });

    it('should handle API error response', (done) => {
      service.setRoleCanManage(1, 2, true).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Admin access required');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_can_manage');
      req.flush({ success: false, error: 'Admin access required' });
    });

    it('should handle HTTP error', (done) => {
      service.setRoleCanManage(1, 2, true).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Failed to update role delegation');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/set_role_can_manage');
      req.flush({ message: 'Error' }, { status: 403, statusText: 'Forbidden' });
    });
  });

  describe('deleteRole()', () => {
    it('should POST to delete_role RPC with role ID', (done) => {
      service.deleteRole(5).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/delete_role');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ p_role_id: 5 });
      req.flush({ success: true, message: 'Role "volunteer" deleted' });
    });

    it('should handle built-in role error', (done) => {
      service.deleteRole(1).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Cannot delete built-in role "user"');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/delete_role');
      req.flush({ success: false, error: 'Cannot delete built-in role "user"' });
    });

    it('should handle HTTP error', (done) => {
      service.deleteRole(5).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Failed to delete role');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/delete_role');
      req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
    });
  });
});
