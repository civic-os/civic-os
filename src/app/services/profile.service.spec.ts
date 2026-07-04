/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of } from 'rxjs';
import { ProfileService, ProfileExtension, ProfileExtensionMeta } from './profile.service';
import { AuthService } from './auth.service';

describe('ProfileService', () => {
  let service: ProfileService;
  let httpMock: HttpTestingController;
  let mockAuthService: any;

  const mockMetas: ProfileExtensionMeta[] = [
    {
      table_name: 'borrowers',
      sort_order: 1,
      is_required: true,
      display_name: 'Borrower Profile',
      description: 'Library borrower info',
      user_fk_column: 'user_id',
      user_fk_constraint: 'borrowers_user_id_fkey'
    }
  ];

  beforeEach(() => {
    mockAuthService = {
      authenticated: signal(true),
      getCurrentUserId: jasmine.createSpy('getCurrentUserId').and.returnValue(of('own-user-123')),
      permissionsLoaded: signal(true),
      permissionsCache: signal(new Map())
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        ProfileService,
        { provide: AuthService, useValue: mockAuthService }
      ]
    });
    service = TestBed.inject(ProfileService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('getProfileExtensions() — own profile (no userId)', () => {
    it('should fetch metadata from VIEW then check has_record via PostgREST embedding', () => {
      service.getProfileExtensions().subscribe(extensions => {
        expect(extensions.length).toBe(1);
        expect(extensions[0].table_name).toBe('borrowers');
        expect(extensions[0].has_record).toBe(false);
      });

      // Step 1: metadata from VIEW
      const metaReq = httpMock.expectOne(r => r.url.includes('user_profile_extensions'));
      expect(metaReq.request.method).toBe('GET');
      metaReq.flush(mockMetas);

      // Step 2: PostgREST embedded query for has_record
      const embedReq = httpMock.expectOne(r =>
        r.url.includes('civic_os_users') &&
        r.url.includes('id=eq.own-user-123') &&
        r.url.includes('borrowers!borrowers_user_id_fkey(id)')
      );
      expect(embedReq.request.method).toBe('GET');
      embedReq.flush([{ id: 'own-user-123', borrowers: [] }]);
    });

    it('should detect has_record=true when embedded array has items', () => {
      service.getProfileExtensions().subscribe(extensions => {
        expect(extensions[0].has_record).toBe(true);
      });

      httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
      httpMock.expectOne(r => r.url.includes('civic_os_users')).flush([
        { id: 'own-user-123', borrowers: [{ id: 42 }] }
      ]);
    });

    it('should handle one-to-one FK (object instead of array)', () => {
      service.getProfileExtensions().subscribe(extensions => {
        expect(extensions[0].has_record).toBe(true);
      });

      httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
      httpMock.expectOne(r => r.url.includes('civic_os_users')).flush([
        { id: 'own-user-123', borrowers: { id: 42 } }
      ]);
    });

    it('should return cached result on second call', () => {
      // First call — hits HTTP
      service.getProfileExtensions().subscribe();
      httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
      httpMock.expectOne(r => r.url.includes('civic_os_users')).flush([
        { id: 'own-user-123', borrowers: [] }
      ]);

      // Second call — should return cached result without HTTP
      service.getProfileExtensions().subscribe(extensions => {
        expect(extensions.length).toBe(1);
      });
      httpMock.expectNone(r => r.url.includes('user_profile_extensions'));
    });

    it('should return empty array when no extensions configured', () => {
      service.getProfileExtensions().subscribe(extensions => {
        expect(extensions).toEqual([]);
      });

      httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush([]);
    });

    it('should return empty array on metadata fetch error', () => {
      service.getProfileExtensions().subscribe(extensions => {
        expect(extensions).toEqual([]);
      });

      httpMock.expectOne(r => r.url.includes('user_profile_extensions'))
        .flush('error', { status: 500, statusText: 'Server Error' });
    });

    it('should return has_record=false on embedding query error', () => {
      service.getProfileExtensions().subscribe(extensions => {
        expect(extensions.length).toBe(1);
        expect(extensions[0].has_record).toBe(false);
      });

      httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
      httpMock.expectOne(r => r.url.includes('civic_os_users'))
        .flush('error', { status: 500, statusText: 'Server Error' });
    });
  });

  describe('getProfileExtensions(userId) — other user', () => {
    it('should use provided userId instead of current user', () => {
      const otherUserId = 'other-user-456';

      service.getProfileExtensions(otherUserId).subscribe(extensions => {
        expect(extensions.length).toBe(1);
      });

      httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
      const embedReq = httpMock.expectOne(r =>
        r.url.includes('civic_os_users') &&
        r.url.includes(`id=eq.${otherUserId}`)
      );
      embedReq.flush([{ id: otherUserId, borrowers: [{ id: 1 }] }]);
    });

    it('should not use cache from own profile when querying other user', () => {
      // First call — own profile
      service.getProfileExtensions().subscribe();
      httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
      httpMock.expectOne(r => r.url.includes('civic_os_users')).flush([
        { id: 'own-user-123', borrowers: [] }
      ]);

      // Second call — different user should NOT use cache
      service.getProfileExtensions('other-456').subscribe();
      httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
      httpMock.expectOne(r => r.url.includes('id=eq.other-456')).flush([
        { id: 'other-456', borrowers: [{ id: 1 }] }
      ]);
    });
  });

  describe('invalidateCache()', () => {
    it('should force fresh HTTP on next call', () => {
      // First call
      service.getProfileExtensions().subscribe();
      httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
      httpMock.expectOne(r => r.url.includes('civic_os_users')).flush([
        { id: 'own-user-123', borrowers: [] }
      ]);

      // Invalidate cache
      service.invalidateCache();

      // Next call should hit HTTP again
      service.getProfileExtensions().subscribe();
      httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
      httpMock.expectOne(r => r.url.includes('civic_os_users')).flush([
        { id: 'own-user-123', borrowers: [] }
      ]);
    });

    it('should reset profileComplete flag', () => {
      service.profileComplete = true;
      service.invalidateCache();
      expect(service.profileComplete).toBe(false);
    });
  });

  describe('updateOwnProfile()', () => {
    it('should call RPC with name and phone', () => {
      service.updateOwnProfile('John', 'Doe', '555-0100').subscribe(result => {
        expect(result.success).toBe(true);
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/update_own_profile'));
      expect(req.request.method).toBe('POST');
      expect(req.request.body.p_first_name).toBe('John');
      expect(req.request.body.p_last_name).toBe('Doe');
      expect(req.request.body.p_phone).toBe('555-0100');
      req.flush({ success: true, message: 'Profile updated' });
    });

    it('should handle error response', () => {
      service.updateOwnProfile('', '').subscribe(result => {
        expect(result.success).toBe(false);
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/update_own_profile'));
      req.flush({ message: 'Validation failed' }, { status: 400, statusText: 'Bad Request' });
    });
  });

  describe('getExtensionRecord()', () => {
    it('should build correct PostgREST URL', () => {
      service.getExtensionRecord('borrowers', 'user_id', 'user-123', 'id,name').subscribe();

      const req = httpMock.expectOne(r =>
        r.url.includes('borrowers') &&
        r.url.includes('user_id=eq.user-123') &&
        r.url.includes('select=id,name')
      );
      expect(req.request.method).toBe('GET');
      req.flush([{ id: '1', name: 'Test' }]);
    });

    it('should use select=* when no fields specified', () => {
      service.getExtensionRecord('borrowers', 'user_id', 'user-123').subscribe();

      const req = httpMock.expectOne(r =>
        r.url.includes('select=*')
      );
      req.flush([]);
    });
  });

  describe('getUserProfileRecord()', () => {
    it('should query civic_os_users VIEW', () => {
      service.getUserProfileRecord('target-123').subscribe(result => {
        expect(result).toBeTruthy();
        expect(result!.first_name).toBe('Jane');
        expect(result!.locale).toBe('en');
      });

      const req = httpMock.expectOne(r =>
        r.url.includes('civic_os_users') &&
        r.url.includes('id=eq.target-123')
      );
      expect(req.request.method).toBe('GET');
      req.flush([{
        id: 'target-123',
        display_name: 'Jane Smith',
        first_name: 'Jane',
        last_name: 'Smith',
        email: 'jane@test.com',
        phone: '5559876543',
        locale: 'en'
      }]);
    });

    it('should return null when user not found', () => {
      service.getUserProfileRecord('nonexistent').subscribe(result => {
        expect(result).toBeNull();
      });

      const req = httpMock.expectOne(r => r.url.includes('civic_os_users'));
      req.flush([]);
    });

    it('should return null on error', () => {
      service.getUserProfileRecord('target-123').subscribe(result => {
        expect(result).toBeNull();
      });

      const req = httpMock.expectOne(r => r.url.includes('civic_os_users'));
      req.flush('error', { status: 403, statusText: 'Forbidden' });
    });
  });

  describe('getCurrentUserPrivateRecord()', () => {
    it('should return user record from RPC', () => {
      service.getCurrentUserPrivateRecord().subscribe(result => {
        expect(result).toBeTruthy();
        expect(result!.first_name).toBe('John');
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/get_own_profile'));
      expect(req.request.method).toBe('POST');
      req.flush({ id: 'user-123', display_name: 'John Doe', first_name: 'John', last_name: 'Doe', email: 'john@test.com', phone: null });
    });

    it('should return null when RPC returns null', () => {
      service.getCurrentUserPrivateRecord().subscribe(result => {
        expect(result).toBeNull();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/get_own_profile'));
      req.flush(null);
    });
  });
});
