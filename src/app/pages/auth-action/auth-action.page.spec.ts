/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal, WritableSignal } from '@angular/core';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { AuthActionPage } from './auth-action.page';
import { AuthService } from '../../services/auth.service';
import { TranslationService } from '../../services/translation.service';

describe('AuthActionPage', () => {
  let mockRouter: jasmine.SpyObj<Router>;
  let routeData: Record<string, string>;
  let queryParams: Record<string, string>;
  let authenticatedSignal: WritableSignal<boolean>;

  function createMockAuth(authenticated: boolean) {
    authenticatedSignal = signal(authenticated);
    return {
      authenticated: authenticatedSignal,
      login: jasmine.createSpy('login'),
      loginWithRedirect: jasmine.createSpy('loginWithRedirect'),
      logout: jasmine.createSpy('logout'),
    };
  }

  function createComponent(authenticated = false) {
    const mockAuth = createMockAuth(authenticated);
    TestBed.configureTestingModule({
      imports: [AuthActionPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: AuthService, useValue: mockAuth },
        { provide: Router, useValue: mockRouter },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              data: routeData,
              queryParamMap: convertToParamMap(queryParams),
            },
          },
        },
        {
          provide: TranslationService,
          useValue: { get: (key: string) => key },
        },
      ],
    });
    const fixture = TestBed.createComponent(AuthActionPage);
    fixture.detectChanges();
    return { fixture, mockAuth };
  }

  beforeEach(() => {
    mockRouter = jasmine.createSpyObj('Router', ['navigateByUrl']);
    routeData = { mode: 'login' };
    queryParams = {};
  });

  it('should call loginWithRedirect when unauthenticated', () => {
    queryParams = { returnUrl: '/view/issues' };
    const { mockAuth } = createComponent(false);
    expect(mockAuth.loginWithRedirect).toHaveBeenCalledWith(
      window.location.origin + '/view/issues'
    );
  });

  it('should navigate to returnUrl when already authenticated', () => {
    queryParams = { returnUrl: '/view/issues' };
    createComponent(true);
    expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/view/issues');
  });

  it('should navigate to / when authenticated with no returnUrl', () => {
    createComponent(true);
    expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('should call logout for logout mode', () => {
    routeData = { mode: 'logout' };
    const { mockAuth } = createComponent(false);
    expect(mockAuth.logout).toHaveBeenCalled();
  });

  it('should sanitize returnUrl that does not start with /', () => {
    queryParams = { returnUrl: 'https://evil.com' };
    createComponent(true);
    expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('should sanitize protocol-relative returnUrl (//evil.com)', () => {
    queryParams = { returnUrl: '//evil.com' };
    createComponent(true);
    expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/');
  });
});
