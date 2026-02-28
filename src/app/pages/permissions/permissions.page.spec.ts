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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { PermissionsPage } from './permissions.page';
import { PermissionsService } from '../../services/permissions.service';
import { AuthService } from '../../services/auth.service';

describe('PermissionsPage', () => {
  let component: PermissionsPage;
  let fixture: ComponentFixture<PermissionsPage>;
  let mockPermissionsService: jasmine.SpyObj<PermissionsService>;
  let mockAuthService: jasmine.SpyObj<AuthService>;

  beforeEach(async () => {
    mockPermissionsService = jasmine.createSpyObj('PermissionsService', [
      'isAdmin',
      'getRoles',
      'getTables',
      'getRolePermissions',
      'setRolePermission',
      'createRole',
      'getEntityActionPermissions',
      'getEntityActionRoles',
      'setEntityActionPermission',
      'getRoleCanManage',
      'setRoleCanManage',
      'deleteRole'
    ]);
    mockAuthService = jasmine.createSpyObj('AuthService', ['isAdmin']);

    // Default: user is admin
    mockPermissionsService.isAdmin.and.returnValue(of(true));
    mockPermissionsService.getRoles.and.returnValue(of([
      { id: 1, name: 'admin', display_name: 'Admin' },
      { id: 2, name: 'editor', display_name: 'Editor' }
    ]));
    mockPermissionsService.getTables.and.returnValue(of(['issues', 'users', 'reservations:notes']));
    mockPermissionsService.getRolePermissions.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [PermissionsPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: PermissionsService, useValue: mockPermissionsService },
        { provide: AuthService, useValue: mockAuthService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(PermissionsPage);
    component = fixture.componentInstance;
  });

  describe('Component Creation', () => {
    it('should create', () => {
      expect(component).toBeTruthy();
    });
  });

  /**
   * Virtual Permissions Heuristic Tests
   *
   * Virtual permissions (containing ':') have restricted permission sets.
   * For example, ':notes' permissions only support 'read' and 'create',
   * not 'update' or 'delete' (which are handled by RLS at the author level).
   */
  describe('getApplicablePermissions()', () => {
    it('should return full CRUD for regular tables', () => {
      const result = component.getApplicablePermissions('issues');

      expect(result).toEqual(['create', 'read', 'update', 'delete']);
    });

    it('should return only create and read for :notes permissions', () => {
      const result = component.getApplicablePermissions('reservations:notes');

      expect(result).toEqual(['create', 'read']);
    });

    it('should return only create and read for any :notes permission', () => {
      // Test with different entity types
      expect(component.getApplicablePermissions('issues:notes')).toEqual(['create', 'read']);
      expect(component.getApplicablePermissions('workpackages:notes')).toEqual(['create', 'read']);
      expect(component.getApplicablePermissions('projects:notes')).toEqual(['create', 'read']);
    });

    it('should return create and read for unknown virtual permissions', () => {
      // Future virtual permissions default to create/read
      const result = component.getApplicablePermissions('payments:refund');

      expect(result).toEqual(['create', 'read']);
    });

    it('should handle table names without colons as regular tables', () => {
      expect(component.getApplicablePermissions('civic_os_users')).toEqual(['create', 'read', 'update', 'delete']);
      expect(component.getApplicablePermissions('metadata_entities')).toEqual(['create', 'read', 'update', 'delete']);
    });
  });

  describe('isPermissionApplicable()', () => {
    it('should return true for all permissions on regular tables', () => {
      expect(component.isPermissionApplicable('issues', 'create')).toBe(true);
      expect(component.isPermissionApplicable('issues', 'read')).toBe(true);
      expect(component.isPermissionApplicable('issues', 'update')).toBe(true);
      expect(component.isPermissionApplicable('issues', 'delete')).toBe(true);
    });

    it('should return true only for create and read on :notes permissions', () => {
      expect(component.isPermissionApplicable('reservations:notes', 'create')).toBe(true);
      expect(component.isPermissionApplicable('reservations:notes', 'read')).toBe(true);
      expect(component.isPermissionApplicable('reservations:notes', 'update')).toBe(false);
      expect(component.isPermissionApplicable('reservations:notes', 'delete')).toBe(false);
    });

    it('should return false for invalid permission types', () => {
      expect(component.isPermissionApplicable('issues', 'invalid')).toBe(false);
      expect(component.isPermissionApplicable('reservations:notes', 'invalid')).toBe(false);
    });
  });

  describe('Virtual Permission UI Behavior', () => {
    it('should identify notes suffix correctly', () => {
      // The method splits on ':' and checks the last segment
      const tableName = 'complex:nested:notes';
      const result = component.getApplicablePermissions(tableName);

      expect(result).toEqual(['create', 'read']);
    });

    it('should handle edge case of just the suffix', () => {
      // Edge case: just ':notes' without prefix
      const result = component.getApplicablePermissions(':notes');

      expect(result).toEqual(['create', 'read']);
    });
  });

  describe('Role Delegation Tab (v0.31.0)', () => {
    beforeEach(() => {
      // Setup mock for delegation tests
      mockPermissionsService.getRoleCanManage.and.returnValue(of([
        { managed_role_id: 2, managed_role_name: 'Editor' }
      ]));
      mockPermissionsService.setRoleCanManage.and.returnValue(of({ success: true }));
      mockPermissionsService.deleteRole.and.returnValue(of({ success: true, message: 'Role deleted' }));
    });

    it('should switch to delegation tab and load delegation matrix', () => {
      component.selectedRoleId.set(1);

      component.switchTab('delegation');

      expect(component.activeTab()).toBe('delegation');
      expect(mockPermissionsService.getRoleCanManage).toHaveBeenCalledWith(1);
    });

    it('should populate delegationManagedIds from getRoleCanManage', () => {
      component.selectedRoleId.set(1);

      component.loadDelegationMatrix();

      expect(component.delegationManagedIds().has(2)).toBe(true);
      expect(component.delegationManagedIds().size).toBe(1);
    });

    it('should return true for delegated role IDs', () => {
      component.delegationManagedIds.set(new Set([2, 3]));

      expect(component.isDelegated(2)).toBe(true);
      expect(component.isDelegated(3)).toBe(true);
      expect(component.isDelegated(1)).toBe(false);
    });

    it('should call setRoleCanManage when toggling delegation on', () => {
      component.selectedRoleId.set(1);
      component.delegationManagedIds.set(new Set());

      component.toggleDelegation(3);

      expect(mockPermissionsService.setRoleCanManage).toHaveBeenCalledWith(1, 3, true);
    });

    it('should call setRoleCanManage when toggling delegation off', () => {
      component.selectedRoleId.set(1);
      component.delegationManagedIds.set(new Set([3]));

      component.toggleDelegation(3);

      expect(mockPermissionsService.setRoleCanManage).toHaveBeenCalledWith(1, 3, false);
    });

    it('should update local state on successful toggle', () => {
      component.selectedRoleId.set(1);
      component.delegationManagedIds.set(new Set());

      component.toggleDelegation(3);

      expect(component.delegationManagedIds().has(3)).toBe(true);
    });

    it('should open and close delete role modal', () => {
      component.openDeleteRoleModal();
      expect(component.showDeleteModal()).toBe(true);

      component.closeDeleteRoleModal();
      expect(component.showDeleteModal()).toBe(false);
    });

    it('should call deleteRole with selected role ID', () => {
      component.selectedRoleId.set(5);
      // Need to set up roles signal by having data loaded
      // Since roles() comes from computed data signal, we test the service call directly
      mockPermissionsService.deleteRole.and.returnValue(of({ success: true }));
      mockPermissionsService.getRoles.and.returnValue(of([
        { id: 1, display_name: 'admin' }
      ]));

      component.submitDeleteRole();

      expect(mockPermissionsService.deleteRole).toHaveBeenCalledWith(5);
    });
  });
});
