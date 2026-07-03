/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { profileCompletionGuard } from './profile-completion.guard';
import { ProfileService, ProfileExtension } from '../services/profile.service';
import { AuthService } from '../services/auth.service';

describe('profileCompletionGuard', () => {
  let mockProfileService: any;
  let mockAuthService: jasmine.SpyObj<AuthService>;

  const makeExtension = (overrides: Partial<ProfileExtension> = {}): ProfileExtension => ({
    table_name: 'test_ext',
    sort_order: 1,
    is_required: false,
    display_name: 'Test Extension',
    description: null,
    user_fk_column: 'user_id',
    has_record: false,
    ...overrides
  });

  beforeEach(() => {
    mockProfileService = {
      getProfileExtensions: jasmine.createSpy('getProfileExtensions'),
      incompleteRequired: signal<ProfileExtension[]>([]),
      profileComplete: false
    };
    mockAuthService = jasmine.createSpyObj('AuthService', ['authenticated']);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ProfileService, useValue: mockProfileService },
        { provide: AuthService, useValue: mockAuthService },
      ]
    });
  });

  function runGuard(url: string): any {
    const childRoute = {} as any;
    const state = { url } as any;
    return TestBed.runInInjectionContext(() =>
      profileCompletionGuard(childRoute, state)
    );
  }

  it('should return true for unauthenticated users', () => {
    mockAuthService.authenticated.and.returnValue(false);

    const result = runGuard('/view/issues');
    expect(result).toBe(true);
  });

  it('should return true when navigating to /profile', () => {
    mockAuthService.authenticated.and.returnValue(true);

    const result = runGuard('/profile');
    expect(result).toBe(true);
  });

  it('should return true when navigating to /profile sub-route', () => {
    mockAuthService.authenticated.and.returnValue(true);

    const result = runGuard('/profile?incomplete=true');
    expect(result).toBe(true);
  });

  it('should return true when navigating to /create/ route', () => {
    mockAuthService.authenticated.and.returnValue(true);

    const result = runGuard('/create/clients?user_id=abc-123');
    expect(result).toBe(true);
  });

  it('should return true when navigating to /edit/ route', () => {
    mockAuthService.authenticated.and.returnValue(true);

    const result = runGuard('/edit/clients/record-456');
    expect(result).toBe(true);
  });

  it('should skip RPC when profileComplete is true', () => {
    mockAuthService.authenticated.and.returnValue(true);
    mockProfileService.profileComplete = true;

    const result = runGuard('/view/issues');
    expect(result).toBe(true);
    expect(mockProfileService.getProfileExtensions).not.toHaveBeenCalled();
  });

  it('should set incompleteRequired signal when required extension is missing', (done) => {
    mockAuthService.authenticated.and.returnValue(true);
    const missing = makeExtension({ is_required: true, has_record: false });
    mockProfileService.getProfileExtensions.and.returnValue(of([missing]));

    const result$ = runGuard('/view/issues');
    result$.subscribe((result: boolean) => {
      expect(result).toBe(true); // Always allows navigation
      expect(mockProfileService.incompleteRequired()).toEqual([missing]);
      expect(mockProfileService.profileComplete).toBe(false);
      done();
    });
  });

  it('should set profileComplete when all extensions are satisfied', (done) => {
    mockAuthService.authenticated.and.returnValue(true);
    mockProfileService.getProfileExtensions.and.returnValue(of([
      makeExtension({ is_required: true, has_record: true })
    ]));

    const result$ = runGuard('/view/issues');
    result$.subscribe((result: boolean) => {
      expect(result).toBe(true);
      expect(mockProfileService.incompleteRequired()).toEqual([]);
      expect(mockProfileService.profileComplete).toBe(true);
      done();
    });
  });

  it('should clear incompleteRequired when no extensions configured', (done) => {
    mockAuthService.authenticated.and.returnValue(true);
    mockProfileService.getProfileExtensions.and.returnValue(of([]));

    const result$ = runGuard('/view/issues');
    result$.subscribe((result: boolean) => {
      expect(result).toBe(true);
      expect(mockProfileService.profileComplete).toBe(true);
      done();
    });
  });

  it('should return true on RPC error (fail open)', (done) => {
    mockAuthService.authenticated.and.returnValue(true);
    mockProfileService.getProfileExtensions.and.returnValue(throwError(() => new Error('Network error')));

    const result$ = runGuard('/view/issues');
    result$.subscribe((result: boolean) => {
      expect(result).toBe(true);
      done();
    });
  });
});
