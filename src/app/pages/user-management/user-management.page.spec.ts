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
import { of, Subject } from 'rxjs';
import { UserManagementPage } from './user-management.page';
import { UserManagementService, ManagedUser } from '../../services/user-management.service';
import { ImportExportService } from '../../services/import-export.service';
import { ApiResponse } from '../../interfaces/api';

describe('UserManagementPage', () => {
  let component: UserManagementPage;
  let fixture: ComponentFixture<UserManagementPage>;
  let mockUserService: jasmine.SpyObj<UserManagementService>;
  let mockImportExportService: jasmine.SpyObj<ImportExportService>;

  beforeEach(async () => {
    mockUserService = jasmine.createSpyObj('UserManagementService', [
      'getManagedUsers',
      'createUser',
      'importUsers',
      'importUsersDetailed',
      'retryProvisioning',
      'getManageableRoles',
      'assignUserRole',
      'revokeUserRole',
      'hasUserManagementAccess',
      'updateUserInfo'
    ]);
    mockImportExportService = jasmine.createSpyObj('ImportExportService', [
      'validateFileSize',
      'parseExcelFile',
      'generateUserImportTemplate'
    ]);

    // Default mocks
    mockUserService.getManagedUsers.and.returnValue(of([]));
    mockUserService.getManageableRoles.and.returnValue(of([
      { role_id: 1, display_name: 'user', description: 'Basic user' },
      { role_id: 2, display_name: 'editor', description: 'Can edit' }
    ]));
    mockUserService.createUser.and.returnValue(of({ success: true }));
    mockUserService.updateUserInfo.and.returnValue(of({ success: true }));
    mockUserService.assignUserRole.and.returnValue(of({ success: true }));
    mockUserService.revokeUserRole.and.returnValue(of({ success: true }));

    await TestBed.configureTestingModule({
      imports: [UserManagementPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserManagementService, useValue: mockUserService },
        { provide: ImportExportService, useValue: mockImportExportService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(UserManagementPage);
    component = fixture.componentInstance;
  });

  describe('Component Creation', () => {
    it('should create', () => {
      expect(component).toBeTruthy();
    });
  });

  describe('getStatusClass()', () => {
    it('should return badge-success for active', () => {
      expect(component.getStatusClass('active')).toBe('badge-success');
    });

    it('should return badge-warning for pending', () => {
      expect(component.getStatusClass('pending')).toBe('badge-warning');
    });

    it('should return badge-info for processing', () => {
      expect(component.getStatusClass('processing')).toBe('badge-info');
    });

    it('should return badge-error for failed', () => {
      expect(component.getStatusClass('failed')).toBe('badge-error');
    });

    it('should return badge-ghost for unknown status', () => {
      expect(component.getStatusClass('unknown')).toBe('badge-ghost');
    });
  });

  describe('formatPhone()', () => {
    it('should format 10-digit phone to (XXX) XXX-XXXX', () => {
      expect(component.formatPhone('5551234567')).toBe('(555) 123-4567');
    });

    it('should return unformatted phone if not 10 digits', () => {
      expect(component.formatPhone('12345')).toBe('12345');
    });

    it('should return empty string for empty input', () => {
      expect(component.formatPhone('')).toBe('');
    });
  });

  describe('openCreateModal()', () => {
    it('should reset form state and show modal', () => {
      // Set some pre-existing state
      component.createError.set('some error');
      component.showCreateModal.set(false);

      component.openCreateModal();

      expect(component.showCreateModal()).toBe(true);
      expect(component.createError()).toBeUndefined();
      expect(component.newUser.email).toBe('');
      expect(component.newUser.first_name).toBe('');
      expect(component.newUser.last_name).toBe('');
    });

    it('should reset selectedRoles to default (user)', () => {
      component.selectedRoles.set(new Set(['admin', 'editor']));

      component.openCreateModal();

      expect(component.selectedRoles().has('user')).toBe(true);
      expect(component.selectedRoles().size).toBe(1);
    });
  });

  describe('closeCreateModal()', () => {
    it('should hide the modal', () => {
      component.showCreateModal.set(true);

      component.closeCreateModal();

      expect(component.showCreateModal()).toBe(false);
    });
  });

  describe('submitCreateUser()', () => {
    it('should set error when required fields are empty', () => {
      component.newUser = { email: '', first_name: '', last_name: '' };

      component.submitCreateUser();

      expect(component.createError()).toBe('Email, first name, and last name are required');
      expect(mockUserService.createUser).not.toHaveBeenCalled();
    });

    it('should call service on valid input and close modal on success', () => {
      component.newUser = {
        email: 'test@example.com',
        first_name: 'Test',
        last_name: 'User',
        send_welcome_email: true
      };
      component.selectedRoles.set(new Set(['user', 'editor']));
      component.showCreateModal.set(true);

      component.submitCreateUser();

      expect(mockUserService.createUser).toHaveBeenCalledWith(jasmine.objectContaining({
        email: 'test@example.com',
        first_name: 'Test',
        last_name: 'User',
        initial_roles: jasmine.arrayContaining(['user', 'editor'])
      }));
      expect(component.showCreateModal()).toBe(false);
      expect(component.successMessage()).toContain('Test User');
    });

    it('should show error from API response on failure', () => {
      mockUserService.createUser.and.returnValue(of({
        success: false,
        error: { message: 'Duplicate email', humanMessage: 'This email is already registered' }
      }));

      // Open modal first so we can verify it stays open on error
      component.openCreateModal();
      expect(component.showCreateModal()).toBe(true);

      component.newUser = {
        email: 'dup@example.com',
        first_name: 'Dup',
        last_name: 'User'
      };

      component.submitCreateUser();

      expect(component.createError()).toBe('This email is already registered');
      expect(component.showCreateModal()).toBe(true);
    });
  });

  describe('isRoleSelected() / toggleRole()', () => {
    it('should return true for roles in the selectedRoles set', () => {
      component.selectedRoles.set(new Set(['user', 'editor']));

      expect(component.isRoleSelected('user')).toBe(true);
      expect(component.isRoleSelected('editor')).toBe(true);
      expect(component.isRoleSelected('admin')).toBe(false);
    });

    it('should add a role when toggling an unselected role', () => {
      component.selectedRoles.set(new Set(['user']));

      component.toggleRole('editor');

      expect(component.selectedRoles().has('editor')).toBe(true);
      expect(component.selectedRoles().has('user')).toBe(true);
    });

    it('should remove a role when toggling a selected role', () => {
      component.selectedRoles.set(new Set(['user', 'editor']));

      component.toggleRole('editor');

      expect(component.selectedRoles().has('editor')).toBe(false);
      expect(component.selectedRoles().has('user')).toBe(true);
    });
  });

  describe('viewError()', () => {
    it('should set error detail user and show error modal', () => {
      const mockUser: ManagedUser = {
        id: '1', display_name: 'Failed User', full_name: 'Failed User',
        first_name: 'Failed', last_name: 'User',
        email: 'fail@test.com', phone: null, status: 'failed',
        error_message: 'Keycloak connection refused', roles: null, created_at: '2025-01-01',
        provision_id: 42
      };

      component.viewError(mockUser);

      expect(component.showErrorModal()).toBe(true);
      expect(component.errorDetailUser()).toEqual(mockUser);
    });
  });

  describe('Edit User Modal', () => {
    const mockActiveUser: ManagedUser = {
      id: 'uuid-123',
      display_name: 'John D.',
      full_name: 'John Doe',
      first_name: 'John',
      last_name: 'Doe',
      email: 'john@example.com',
      phone: '5551234567',
      status: 'active',
      error_message: null,
      roles: ['user', 'editor'],
      created_at: '2025-01-01',
      provision_id: null
    };

    const mockPendingUser: ManagedUser = {
      id: null,
      display_name: 'Pending P.',
      full_name: 'Pending Person',
      first_name: 'Pending',
      last_name: 'Person',
      email: 'pending@example.com',
      phone: null,
      status: 'pending',
      error_message: null,
      roles: ['user'],
      created_at: '2025-01-02',
      provision_id: 99
    };

    it('should populate edit signals from user data', () => {
      component.openEditModal(mockActiveUser);

      expect(component.showEditModal()).toBe(true);
      expect(component.editFirstName()).toBe('John');
      expect(component.editLastName()).toBe('Doe');
      expect(component.editPhone()).toBe('5551234567');
      expect(component.editRoles().has('user')).toBe(true);
      expect(component.editRoles().has('editor')).toBe(true);
      expect(component.editUser()).toEqual(mockActiveUser);
      expect(component.editError()).toBeUndefined();
    });

    it('should not open for pending users', () => {
      component.openEditModal(mockPendingUser);
      expect(component.showEditModal()).toBe(false);
    });

    it('should not open for users without id', () => {
      component.openEditModal({ ...mockActiveUser, id: null });
      expect(component.showEditModal()).toBe(false);
    });

    it('should close modal and reload users', () => {
      component.showEditModal.set(true);
      mockUserService.getManagedUsers.calls.reset();

      component.closeEditModal();

      expect(component.showEditModal()).toBe(false);
      expect(mockUserService.getManagedUsers).toHaveBeenCalled();
    });

    it('should reject empty first name', () => {
      component.openEditModal(mockActiveUser);
      component.editFirstName.set('');

      component.submitEditUser();

      expect(component.editError()).toBe('First name and last name are required');
      expect(mockUserService.updateUserInfo).not.toHaveBeenCalled();
    });

    it('should reject empty last name', () => {
      component.openEditModal(mockActiveUser);
      component.editLastName.set('');

      component.submitEditUser();

      expect(component.editError()).toBe('First name and last name are required');
      expect(mockUserService.updateUserInfo).not.toHaveBeenCalled();
    });

    it('should reject whitespace-only first name', () => {
      component.openEditModal(mockActiveUser);
      component.editFirstName.set('   ');

      component.submitEditUser();

      expect(component.editError()).toBe('First name and last name are required');
    });

    it('should call updateUserInfo and close modal on success', () => {
      component.openEditModal(mockActiveUser);
      component.editFirstName.set('Jane');
      component.editLastName.set('Smith');
      component.editPhone.set('5559876543');

      component.submitEditUser();

      expect(mockUserService.updateUserInfo).toHaveBeenCalledWith({
        user_id: 'uuid-123',
        first_name: 'Jane',
        last_name: 'Smith',
        phone: '5559876543'
      });
      expect(component.showEditModal()).toBe(false);
      expect(component.successMessage()).toContain('Jane Smith');
    });

    it('should send undefined phone when cleared', () => {
      component.openEditModal(mockActiveUser);
      component.editPhone.set('');

      component.submitEditUser();

      const calledWith = mockUserService.updateUserInfo.calls.mostRecent().args[0];
      expect(calledWith.phone).toBeUndefined();
    });

    it('should show error and keep modal open on failure', () => {
      mockUserService.updateUserInfo.and.returnValue(of({
        success: false,
        error: { message: 'Permission denied', humanMessage: 'You do not have permission to edit users' }
      }));

      component.openEditModal(mockActiveUser);
      component.submitEditUser();

      expect(component.editError()).toBe('You do not have permission to edit users');
      expect(component.showEditModal()).toBe(true);
    });

    it('should set editLoading during submission', () => {
      const subject = new Subject<ApiResponse>();
      mockUserService.updateUserInfo.and.returnValue(subject.asObservable());

      component.openEditModal(mockActiveUser);
      component.submitEditUser();

      expect(component.editLoading()).toBe(true);

      subject.next({ success: true });
      subject.complete();

      expect(component.editLoading()).toBe(false);
    });
  });

  describe('Edit Role Toggle', () => {
    const mockActiveUser: ManagedUser = {
      id: 'uuid-123',
      display_name: 'John D.',
      full_name: 'John Doe',
      first_name: 'John',
      last_name: 'Doe',
      email: 'john@example.com',
      phone: '5551234567',
      status: 'active',
      error_message: null,
      roles: ['user', 'editor'],
      created_at: '2025-01-01',
      provision_id: null
    };

    it('should assign role when toggling unselected role', () => {
      component.openEditModal(mockActiveUser);

      component.toggleEditRole('admin');

      expect(mockUserService.assignUserRole).toHaveBeenCalledWith('uuid-123', 'admin');
    });

    it('should revoke role when toggling selected role', () => {
      component.openEditModal(mockActiveUser);

      component.toggleEditRole('editor');

      expect(mockUserService.revokeUserRole).toHaveBeenCalledWith('uuid-123', 'editor');
    });

    it('should add role to editRoles set on successful assign', () => {
      component.openEditModal(mockActiveUser);

      component.toggleEditRole('admin');

      expect(component.editRoles().has('admin')).toBe(true);
    });

    it('should remove role from editRoles set on successful revoke', () => {
      component.openEditModal(mockActiveUser);

      component.toggleEditRole('editor');

      expect(component.editRoles().has('editor')).toBe(false);
    });

    it('should show error and not change roles on failure', () => {
      mockUserService.assignUserRole.and.returnValue(of({
        success: false,
        error: { message: 'Delegation error', humanMessage: 'Your role cannot assign the "admin" role' }
      }));

      component.openEditModal(mockActiveUser);
      const rolesBefore = new Set(component.editRoles());

      component.toggleEditRole('admin');

      expect(component.editError()).toContain('cannot assign');
      expect(component.editRoles()).toEqual(rolesBefore);
    });

    it('should track per-role loading state', () => {
      const subject = new Subject<ApiResponse>();
      mockUserService.assignUserRole.and.returnValue(subject.asObservable());

      component.openEditModal(mockActiveUser);
      component.toggleEditRole('admin');

      expect(component.editRolesLoading().has('admin')).toBe(true);

      subject.next({ success: true });
      subject.complete();

      expect(component.editRolesLoading().has('admin')).toBe(false);
    });
  });

  describe('Non-Manageable Roles', () => {
    const mockActiveUser: ManagedUser = {
      id: 'uuid-123',
      display_name: 'John D.',
      full_name: 'John Doe',
      first_name: 'John',
      last_name: 'Doe',
      email: 'john@example.com',
      phone: null,
      status: 'active',
      error_message: null,
      roles: ['user', 'editor'],
      created_at: '2025-01-01',
      provision_id: null
    };

    it('should return roles the current user cannot manage', () => {
      const userWithAdmin = { ...mockActiveUser, roles: ['user', 'editor', 'admin'] as string[] };
      component.openEditModal(userWithAdmin);

      expect(component.getNonManageableRoles()).toEqual(['admin']);
    });

    it('should return empty array when all roles are manageable', () => {
      component.openEditModal(mockActiveUser);

      expect(component.getNonManageableRoles()).toEqual([]);
    });
  });

  describe('Import Users', () => {
    it('should have userImportConfig with 6 columns', () => {
      expect(component.userImportConfig).toBeTruthy();
      expect(component.userImportConfig.columns.length).toBe(6);
      expect(component.userImportConfig.title).toBe('Import Users');
    });

    it('should set showImportModal on openImportModal()', () => {
      component.openImportModal();
      expect(component.showImportModal()).toBe(true);
    });

    it('submitUserImport should transform rows to ProvisionUserRequest format', (done) => {
      const rows = [
        { email: 'a@test.com', first_name: 'A', last_name: 'User', phone: '5551234567', roles: ['editor'], send_welcome_email: false }
      ];

      mockUserService.importUsersDetailed.and.returnValue(of({
        success: true, created_count: 1, error_count: 0, errors: []
      }));

      component.submitUserImport(rows).subscribe(result => {
        expect(mockUserService.importUsersDetailed).toHaveBeenCalledWith([
          jasmine.objectContaining({
            email: 'a@test.com',
            first_name: 'A',
            last_name: 'User',
            phone: '5551234567',
            initial_roles: ['editor'],
            send_welcome_email: false
          })
        ]);
        expect(result.success).toBe(true);
        expect(result.importedCount).toBe(1);
        done();
      });
    });

    it('submitUserImport should default roles to ["user"] when not specified', (done) => {
      const rows = [
        { email: 'a@test.com', first_name: 'A', last_name: 'User', phone: null, roles: null, send_welcome_email: null }
      ];

      mockUserService.importUsersDetailed.and.returnValue(of({
        success: true, created_count: 1, error_count: 0, errors: []
      }));

      component.submitUserImport(rows).subscribe(() => {
        const calledWith = mockUserService.importUsersDetailed.calls.mostRecent().args[0];
        expect(calledWith[0].initial_roles).toEqual(['user']);
        done();
      });
    });

    it('submitUserImport should default send_welcome_email to true when not specified', (done) => {
      const rows = [
        { email: 'a@test.com', first_name: 'A', last_name: 'User', phone: null, roles: null, send_welcome_email: null }
      ];

      mockUserService.importUsersDetailed.and.returnValue(of({
        success: true, created_count: 1, error_count: 0, errors: []
      }));

      component.submitUserImport(rows).subscribe(() => {
        const calledWith = mockUserService.importUsersDetailed.calls.mostRecent().args[0];
        expect(calledWith[0].send_welcome_email).toBe(true);
        done();
      });
    });

    it('onImportSuccess should close modal, show message, and reload users', () => {
      component.showImportModal.set(true);

      component.onImportSuccess(5);

      expect(component.showImportModal()).toBe(false);
      expect(component.successMessage()).toContain('5 users');
      expect(mockUserService.getManagedUsers).toHaveBeenCalled();
    });
  });
});
