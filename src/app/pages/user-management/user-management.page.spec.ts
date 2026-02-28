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
import { UserManagementPage } from './user-management.page';
import { UserManagementService } from '../../services/user-management.service';

describe('UserManagementPage', () => {
  let component: UserManagementPage;
  let fixture: ComponentFixture<UserManagementPage>;
  let mockUserService: jasmine.SpyObj<UserManagementService>;

  beforeEach(async () => {
    mockUserService = jasmine.createSpyObj('UserManagementService', [
      'getManagedUsers',
      'createUser',
      'importUsers',
      'retryProvisioning',
      'getManageableRoles',
      'assignUserRole',
      'revokeUserRole',
      'hasUserManagementAccess'
    ]);

    // Default mocks
    mockUserService.getManagedUsers.and.returnValue(of([]));
    mockUserService.getManageableRoles.and.returnValue(of([
      { role_id: 1, display_name: 'user', description: 'Basic user' },
      { role_id: 2, display_name: 'editor', description: 'Can edit' }
    ]));
    mockUserService.createUser.and.returnValue(of({ success: true }));

    await TestBed.configureTestingModule({
      imports: [UserManagementPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserManagementService, useValue: mockUserService }
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
      const mockUser = {
        id: '1', display_name: 'Failed User', full_name: 'Failed User',
        email: 'fail@test.com', phone: null, status: 'failed',
        error_message: 'Keycloak connection refused', roles: null, created_at: '2025-01-01',
        provision_id: 42
      };

      component.viewError(mockUser);

      expect(component.showErrorModal()).toBe(true);
      expect(component.errorDetailUser()).toEqual(mockUser);
    });
  });
});
