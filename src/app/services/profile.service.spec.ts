/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ProfileService, ProfileExtension } from './profile.service';

describe('ProfileService', () => {
  let service: ProfileService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        ProfileService
      ]
    });
    service = TestBed.inject(ProfileService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('getProfileExtensions()', () => {
    it('should fetch extensions from RPC', () => {
      const mockExtensions: ProfileExtension[] = [
        {
          table_name: 'borrowers',
          sort_order: 1,
          is_required: true,
          display_name: 'Borrower Profile',
          description: 'Library borrower info',
          user_fk_column: 'user_id',
          has_record: false
        }
      ];

      service.getProfileExtensions().subscribe(extensions => {
        expect(extensions).toEqual(mockExtensions);
        expect(extensions.length).toBe(1);
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/get_user_profile_extensions'));
      expect(req.request.method).toBe('POST');
      req.flush(mockExtensions);
    });

    it('should return cached result on second call', () => {
      const mockExtensions: ProfileExtension[] = [
        {
          table_name: 'borrowers',
          sort_order: 1,
          is_required: false,
          display_name: 'Borrower',
          description: null,
          user_fk_column: 'user_id',
          has_record: true
        }
      ];

      // First call — hits HTTP
      service.getProfileExtensions().subscribe();
      const req = httpMock.expectOne(r => r.url.includes('rpc/get_user_profile_extensions'));
      req.flush(mockExtensions);

      // Second call — should return cached result without HTTP
      service.getProfileExtensions().subscribe(extensions => {
        expect(extensions).toEqual(mockExtensions);
      });

      httpMock.expectNone(r => r.url.includes('rpc/get_user_profile_extensions'));
    });

    it('should return empty array on error', () => {
      service.getProfileExtensions().subscribe(extensions => {
        expect(extensions).toEqual([]);
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/get_user_profile_extensions'));
      req.flush('error', { status: 500, statusText: 'Server Error' });
    });
  });

  describe('invalidateCache()', () => {
    it('should force fresh HTTP on next call', () => {
      const mockExtensions: ProfileExtension[] = [];

      // First call
      service.getProfileExtensions().subscribe();
      httpMock.expectOne(r => r.url.includes('rpc/get_user_profile_extensions')).flush(mockExtensions);

      // Invalidate cache
      service.invalidateCache();

      // Next call should hit HTTP again
      service.getProfileExtensions().subscribe();
      const req = httpMock.expectOne(r => r.url.includes('rpc/get_user_profile_extensions'));
      req.flush(mockExtensions);
    });
  });

  describe('getProfileExtensionsAdmin()', () => {
    it('should call admin RPC with user ID', () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';

      service.getProfileExtensionsAdmin(userId).subscribe();

      const req = httpMock.expectOne(r => r.url.includes('rpc/get_user_profile_extensions_admin'));
      expect(req.request.method).toBe('POST');
      expect(req.request.body.p_user_id).toBe(userId);
      req.flush([]);
    });

    it('should return empty array on error', () => {
      service.getProfileExtensionsAdmin('test-id').subscribe(result => {
        expect(result).toEqual([]);
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/get_user_profile_extensions_admin'));
      req.flush('error', { status: 403, statusText: 'Forbidden' });
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
