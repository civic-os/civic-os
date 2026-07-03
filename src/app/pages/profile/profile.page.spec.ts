/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { ProfilePage } from './profile.page';
import { ProfileService, ProfileExtension, UserPrivateRecord } from '../../services/profile.service';
import { NotificationService, NotificationPreference } from '../../services/notification.service';
import { AuthService } from '../../services/auth.service';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';

describe('ProfilePage', () => {
  let component: ProfilePage;
  let fixture: ComponentFixture<ProfilePage>;
  let mockProfileService: jasmine.SpyObj<ProfileService>;
  let mockNotificationService: jasmine.SpyObj<NotificationService>;
  let mockAuthService: any;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockDataService: jasmine.SpyObj<DataService>;

  const mockUser: UserPrivateRecord = {
    id: 'user-123',
    display_name: 'John Doe',
    first_name: 'John',
    last_name: 'Doe',
    email: 'john@example.com',
    phone: '5551230100'
  };

  const mockExtension: ProfileExtension = {
    table_name: 'borrowers',
    sort_order: 1,
    is_required: true,
    display_name: 'Borrower Profile',
    description: 'Library borrower info',
    user_fk_column: 'user_id',
    has_record: false
  };

  const mockEmailPref: NotificationPreference = {
    user_id: 'user-123',
    channel: 'email',
    enabled: true,
    email_address: 'john@example.com',
    created_at: '2024-01-01',
    updated_at: '2024-01-01'
  };

  beforeEach(async () => {
    mockProfileService = jasmine.createSpyObj('ProfileService', [
      'getProfileExtensions',
      'getProfileExtensionsAdmin',
      'updateOwnProfile',
      'getExtensionRecord',
      'getCurrentUserPrivateRecord',
      'invalidateCache'
    ]);
    mockNotificationService = jasmine.createSpyObj('NotificationService', [
      'getUserPreferences',
      'updatePreference'
    ]);
    mockSchemaService = jasmine.createSpyObj('SchemaService', [
      'getEntity',
      'getPropsForDetail',
      'init',
      'getEntities',
      'getEntitiesForMenu',
      'refreshEntitiesCache',
      'refreshPropertiesCache',
      'getPropertiesForEntity',
      'getInverseRelationships'
    ]);
    mockDataService = jasmine.createSpyObj('DataService', [
      'getInverseRelationshipData'
    ]);

    // Auth service mock with signal
    mockAuthService = {
      authenticated: signal(true),
      getCurrentUserId: jasmine.createSpy('getCurrentUserId').and.returnValue(of('user-123')),
      isAdmin: jasmine.createSpy('isAdmin').and.returnValue(false),
      userRoles: signal(['user']),
      hasPermission: jasmine.createSpy('hasPermission').and.returnValue(false),
      login: jasmine.createSpy('login'),
      logout: jasmine.createSpy('logout'),
      keycloak: { tokenParsed: { sub: 'user-123' } },
      permissionsCache: signal(new Map()),
      isRealAdmin: jasmine.createSpy('isRealAdmin').and.returnValue(false),
      realUserRoles: signal([])
    };

    // Default mocks
    mockProfileService.getCurrentUserPrivateRecord.and.returnValue(of(mockUser));
    mockProfileService.getProfileExtensions.and.returnValue(of([]));
    mockNotificationService.getUserPreferences.and.returnValue(of([mockEmailPref]));
    mockNotificationService.updatePreference.and.returnValue(of({ success: true }));
    mockSchemaService.getEntities.and.returnValue(of([]));
    mockSchemaService.getEntitiesForMenu.and.returnValue(of([]));
    mockSchemaService.getInverseRelationships.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [ProfilePage],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ProfileService, useValue: mockProfileService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: DataService, useValue: mockDataService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ProfilePage);
    component = fixture.componentInstance;
  });

  describe('Component Creation', () => {
    it('should create', () => {
      expect(component).toBeTruthy();
    });

    it('should start in loading state', () => {
      expect(component.loading()).toBe(true);
    });
  });

  describe('Core User Info', () => {
    it('should load user record on init', async () => {
      await fixture.whenStable();
      expect(component.userRecord()).toEqual(mockUser);
      expect(component.loading()).toBe(false);
    });

    it('should populate edit form when editing', async () => {
      await fixture.whenStable();
      component.startEditCoreInfo();
      expect(component.editingCoreInfo()).toBe(true);
      expect(component.editFirstName).toBe('John');
      expect(component.editLastName).toBe('Doe');
    });

    it('should cancel editing without saving', async () => {
      await fixture.whenStable();
      component.startEditCoreInfo();
      component.editFirstName = 'Changed';
      component.cancelEditCoreInfo();
      expect(component.editingCoreInfo()).toBe(false);
      expect(component.userRecord()!.first_name).toBe('John');
    });

    it('should call updateOwnProfile on save', async () => {
      mockProfileService.updateOwnProfile.and.returnValue(of({
        success: true,
        message: 'Profile updated'
      }));

      await fixture.whenStable();
      component.startEditCoreInfo();
      component.editFirstName = 'Jane';
      component.editLastName = 'Smith';
      component.saveCoreInfo();

      expect(mockProfileService.updateOwnProfile).toHaveBeenCalledWith('Jane', 'Smith', '5551230100');
    });

    it('should not save if first name is empty', async () => {
      await fixture.whenStable();
      component.startEditCoreInfo();
      component.editFirstName = '';
      component.editLastName = 'Doe';
      component.saveCoreInfo();

      expect(mockProfileService.updateOwnProfile).not.toHaveBeenCalled();
    });
  });

  describe('Notification Preferences', () => {
    it('should load email preference', async () => {
      await fixture.whenStable();
      expect(component.emailPreference()).toEqual(mockEmailPref);
    });

    it('should toggle email preference', async () => {
      await fixture.whenStable();
      component.onEmailToggle(false);
      expect(mockNotificationService.updatePreference).toHaveBeenCalledWith('email', false);
    });
  });

  describe('Profile Extensions', () => {
    it('should load extensions', async () => {
      mockProfileService.getProfileExtensions.and.returnValue(of([mockExtension]));

      fixture = TestBed.createComponent(ProfilePage);
      component = fixture.componentInstance;
      await fixture.whenStable();

      expect(component.extensions().length).toBe(1);
      expect(component.extensions()[0].table_name).toBe('borrowers');
    });

    it('should show correct badge for required incomplete extension', async () => {
      mockProfileService.getProfileExtensions.and.returnValue(of([mockExtension]));

      fixture = TestBed.createComponent(ProfilePage);
      component = fixture.componentInstance;
      await fixture.whenStable();

      const ext = component.extensions()[0];
      expect(ext.is_required).toBe(true);
      expect(ext.has_record).toBe(false);
    });
  });

  describe('Phone Formatting', () => {
    it('should format phone digits as (XXX) XXX-XXXX', () => {
      expect(component.getFormattedPhone('5551234567')).toBe('(555) 123-4567');
    });

    it('should return empty string for empty phone', () => {
      expect(component.getFormattedPhone('')).toBe('');
      expect(component.getFormattedPhone(null)).toBe('');
    });

    it('should detect invalid phone (too short)', () => {
      component.editPhone = '555';
      expect(component.isPhoneInvalid()).toBe(true);
    });

    it('should accept valid 10-digit phone', () => {
      component.editPhone = '5551234567';
      expect(component.isPhoneInvalid()).toBe(false);
    });

    it('should accept empty phone (optional)', () => {
      component.editPhone = '';
      expect(component.isPhoneInvalid()).toBe(false);
    });
  });
});
