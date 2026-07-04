/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, Subject, BehaviorSubject } from 'rxjs';
import { convertToParamMap, ParamMap } from '@angular/router';
import { ProfilePage } from './profile.page';
import { ProfileService, ProfileExtension, UserPrivateRecord } from '../../services/profile.service';
import { NotificationService, NotificationPreference } from '../../services/notification.service';
import { AuthService } from '../../services/auth.service';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { UserManagementService } from '../../services/user-management.service';
import { LocaleService, LocaleInfo } from '../../services/locale.service';

describe('ProfilePage', () => {
  let component: ProfilePage;
  let fixture: ComponentFixture<ProfilePage>;
  let mockProfileService: jasmine.SpyObj<ProfileService>;
  let mockNotificationService: jasmine.SpyObj<NotificationService>;
  let mockAuthService: any;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockUserManagementService: jasmine.SpyObj<UserManagementService>;
  let mockLocaleService: any;
  let paramMapSubject: BehaviorSubject<ParamMap>;

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
    // Start with empty paramMap (own profile)
    paramMapSubject = new BehaviorSubject<ParamMap>(convertToParamMap({}));

    mockProfileService = jasmine.createSpyObj('ProfileService', [
      'getProfileExtensions',
      'updateOwnProfile',
      'getExtensionRecord',
      'getCurrentUserPrivateRecord',
      'getUserProfileRecord',
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
    mockUserManagementService = jasmine.createSpyObj('UserManagementService', [
      'updateUserInfo'
    ]);

    // Locale service mock
    mockLocaleService = {
      locale: signal('en'),
      supportedLocales: [
        { code: 'en', name: 'English', englishName: 'English' },
        { code: 'es', name: 'Español', englishName: 'Spanish' }
      ] as LocaleInfo[],
      setLocale: jasmine.createSpy('setLocale'),
      isRtl: signal(false),
      getLocaleInfo: jasmine.createSpy('getLocaleInfo').and.returnValue({ code: 'en', name: 'English', englishName: 'English' })
    };

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
      permissionsLoaded: signal(true),
      isRealAdmin: jasmine.createSpy('isRealAdmin').and.returnValue(false),
      realUserRoles: signal([])
    };

    // Default mocks
    mockProfileService.getCurrentUserPrivateRecord.and.returnValue(of(mockUser));
    mockProfileService.getProfileExtensions.and.returnValue(of([]));
    mockProfileService.getUserProfileRecord.and.returnValue(of(mockUser));
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
        { provide: DataService, useValue: mockDataService },
        { provide: UserManagementService, useValue: mockUserManagementService },
        { provide: LocaleService, useValue: mockLocaleService },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: paramMapSubject.asObservable() }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ProfilePage);
    component = fixture.componentInstance;
  });

  describe('Component Creation', () => {
    it('should create', () => {
      expect(component).toBeTruthy();
    });
  });

  describe('Own Profile (no userId param)', () => {
    it('should load user record on init', async () => {
      await fixture.whenStable();
      expect(component.userRecord()).toEqual(mockUser);
      expect(component.loading()).toBe(false);
      expect(component.isOwnProfile()).toBe(true);
      expect(component.canEditCoreInfo()).toBe(true);
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

  describe('Other User Profile (/profile/:userId)', () => {
    it('should load other user profile when userId param is present', async () => {
      mockAuthService.hasPermission.and.returnValue(true);
      paramMapSubject.next(convertToParamMap({ userId: 'other-user-456' }));

      await fixture.whenStable();

      expect(component.isOwnProfile()).toBe(false);
      expect(component.targetUserId()).toBe('other-user-456');
      expect(mockProfileService.getUserProfileRecord).toHaveBeenCalledWith('other-user-456');
    });

    it('should set canEditCoreInfo to true when admin views other user', async () => {
      mockAuthService.hasPermission.and.returnValue(true);
      paramMapSubject.next(convertToParamMap({ userId: 'other-user-456' }));

      await fixture.whenStable();

      expect(component.canEditCoreInfo()).toBe(true);
    });

    it('should set canEditCoreInfo to false when non-admin views other user', async () => {
      mockAuthService.hasPermission.and.returnValue(false);
      paramMapSubject.next(convertToParamMap({ userId: 'other-user-456' }));

      await fixture.whenStable();

      expect(component.canEditCoreInfo()).toBe(false);
    });

    it('should show notFound when user does not exist', async () => {
      mockProfileService.getUserProfileRecord.and.returnValue(of(null));
      paramMapSubject.next(convertToParamMap({ userId: 'nonexistent-uuid' }));

      await fixture.whenStable();

      expect(component.notFound()).toBe(true);
      expect(component.loading()).toBe(false);
    });

    it('should use userManagementService.updateUserInfo when saving other user', async () => {
      mockAuthService.hasPermission.and.returnValue(true);
      mockUserManagementService.updateUserInfo.and.returnValue(of({ success: true }));
      paramMapSubject.next(convertToParamMap({ userId: 'other-user-456' }));

      await fixture.whenStable();

      component.startEditCoreInfo();
      component.editFirstName = 'Updated';
      component.editLastName = 'Name';
      component.editPhone = '';
      component.saveCoreInfo();

      expect(mockUserManagementService.updateUserInfo).toHaveBeenCalledWith({
        user_id: 'other-user-456',
        first_name: 'Updated',
        last_name: 'Name',
        phone: undefined
      });
    });

    it('should load extensions with userId when viewing other user', async () => {
      mockAuthService.hasPermission.and.returnValue(false);
      paramMapSubject.next(convertToParamMap({ userId: 'other-user-456' }));

      await fixture.whenStable();

      expect(mockProfileService.getProfileExtensions).toHaveBeenCalledWith('other-user-456');
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

  describe('Extension Navigation', () => {
    it('should use /profile returnTo for own profile edit', async () => {
      const routerSpy = spyOn(component['router'], 'navigate');
      await fixture.whenStable();

      component.navigateToEditExtension('borrowers', 'rec-1');

      expect(routerSpy).toHaveBeenCalledWith(['edit', 'borrowers', 'rec-1'], {
        queryParams: { returnTo: '/profile' }
      });
    });

    it('should use /profile/:userId returnTo for other user edit', async () => {
      const routerSpy = spyOn(component['router'], 'navigate');
      mockAuthService.hasPermission.and.returnValue(true);
      paramMapSubject.next(convertToParamMap({ userId: 'other-456' }));

      await fixture.whenStable();

      component.navigateToEditExtension('borrowers', 'rec-1');

      expect(routerSpy).toHaveBeenCalledWith(['edit', 'borrowers', 'rec-1'], {
        queryParams: { returnTo: '/profile/other-456' }
      });
    });
  });
});
