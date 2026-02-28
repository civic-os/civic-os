/**
 * Copyright (C) 2023-2026 Civic OS, L3C
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
import { provideZonelessChangeDetection, signal, WritableSignal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService } from './auth.service';
import { DataService } from './data.service';
import { SchemaService } from './schema.service';
import { AnalyticsService } from './analytics.service';
import { ImpersonationService } from './impersonation.service';
import { KEYCLOAK_EVENT_SIGNAL, KeycloakEventType, KeycloakEvent } from 'keycloak-angular';
import Keycloak from 'keycloak-js';
import { of } from 'rxjs';

describe('AuthService', () => {
  let service: AuthService;
  let keycloakEventSignal: WritableSignal<KeycloakEvent>;
  let mockKeycloak: jasmine.SpyObj<Keycloak>;
  let mockAnalytics: jasmine.SpyObj<AnalyticsService>;
  let mockImpersonation: jasmine.SpyObj<ImpersonationService>;

  beforeEach(() => {
    keycloakEventSignal = signal<KeycloakEvent>({ type: KeycloakEventType.KeycloakAngularNotInitialized, args: undefined });

    mockKeycloak = jasmine.createSpyObj('Keycloak', ['login', 'logout', 'updateToken'], {
      tokenParsed: { sub: 'user-123', realm_access: { roles: ['user', 'admin'] } }
    });
    mockKeycloak.updateToken.and.returnValue(Promise.resolve(true));
    mockKeycloak.login.and.returnValue(Promise.resolve());

    mockAnalytics = jasmine.createSpyObj('AnalyticsService', ['trackEvent', 'setUserId', 'resetUserId']);

    mockImpersonation = jasmine.createSpyObj('ImpersonationService', ['stopImpersonation'], {
      isActive: signal(false),
      impersonatedRoles: signal([])
    });
    mockImpersonation.stopImpersonation.and.returnValue(of(true));

    const mockDataService = jasmine.createSpyObj('DataService', ['refreshCurrentUser']);
    mockDataService.refreshCurrentUser.and.returnValue(of({ success: true }));

    const mockSchemaService = jasmine.createSpyObj('SchemaService', ['refreshCache']);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        AuthService,
        { provide: KEYCLOAK_EVENT_SIGNAL, useValue: keycloakEventSignal },
        { provide: Keycloak, useValue: mockKeycloak },
        { provide: DataService, useValue: mockDataService },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: AnalyticsService, useValue: mockAnalytics },
        { provide: ImpersonationService, useValue: mockImpersonation }
      ]
    });

    service = TestBed.inject(AuthService);
    TestBed.flushEffects();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('AuthRefreshError handler', () => {
    beforeEach(() => {
      // Authenticate the user via Ready event
      keycloakEventSignal.set({ type: KeycloakEventType.Ready, args: true });
      TestBed.flushEffects();
      expect(service.authenticated()).toBeTrue();
    });

    it('should set authenticated to false on AuthRefreshError', () => {
      keycloakEventSignal.set({ type: KeycloakEventType.AuthRefreshError, args: undefined });
      TestBed.flushEffects();

      expect(service.authenticated()).toBeFalse();
    });

    it('should clear realUserRoles on AuthRefreshError', () => {
      expect(service.realUserRoles().length).toBeGreaterThan(0);

      keycloakEventSignal.set({ type: KeycloakEventType.AuthRefreshError, args: undefined });
      TestBed.flushEffects();

      expect(service.realUserRoles()).toEqual([]);
    });

    it('should track RefreshError analytics event', () => {
      keycloakEventSignal.set({ type: KeycloakEventType.AuthRefreshError, args: undefined });
      TestBed.flushEffects();

      expect(mockAnalytics.trackEvent).toHaveBeenCalledWith('Auth', 'RefreshError');
    });

    it('should clear impersonation on AuthRefreshError', () => {
      mockImpersonation.stopImpersonation.calls.reset();

      keycloakEventSignal.set({ type: KeycloakEventType.AuthRefreshError, args: undefined });
      TestBed.flushEffects();

      expect(mockImpersonation.stopImpersonation).toHaveBeenCalled();
    });

    it('should NOT call keycloak.login() on AuthRefreshError', () => {
      mockKeycloak.login.calls.reset();

      keycloakEventSignal.set({ type: KeycloakEventType.AuthRefreshError, args: undefined });
      TestBed.flushEffects();

      expect(mockKeycloak.login).not.toHaveBeenCalled();
    });
  });

  describe('visibility change listener', () => {
    beforeEach(() => {
      // Authenticate the user
      keycloakEventSignal.set({ type: KeycloakEventType.Ready, args: true });
      TestBed.flushEffects();
    });

    it('should call updateToken when tab becomes visible and user is authenticated', () => {
      mockKeycloak.updateToken.calls.reset();
      spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');

      document.dispatchEvent(new Event('visibilitychange'));

      expect(mockKeycloak.updateToken).toHaveBeenCalledWith(30);
    });

    it('should not call updateToken when tab is hidden', () => {
      mockKeycloak.updateToken.calls.reset();
      spyOnProperty(document, 'visibilityState', 'get').and.returnValue('hidden');

      document.dispatchEvent(new Event('visibilitychange'));

      expect(mockKeycloak.updateToken).not.toHaveBeenCalled();
    });

    it('should not call updateToken when user is not authenticated', () => {
      service.authenticated.set(false);
      mockKeycloak.updateToken.calls.reset();
      spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');

      document.dispatchEvent(new Event('visibilitychange'));

      expect(mockKeycloak.updateToken).not.toHaveBeenCalled();
    });

    it('should call login() when token refresh fails on visibility change', async () => {
      mockKeycloak.login.calls.reset();
      mockKeycloak.updateToken.and.returnValue(Promise.reject(new Error('refresh failed')));
      spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');

      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockKeycloak.login).toHaveBeenCalled();
    });

    it('should track VisibilityRefreshFailed analytics event on refresh failure', async () => {
      mockKeycloak.updateToken.and.returnValue(Promise.reject(new Error('refresh failed')));
      spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');

      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockAnalytics.trackEvent).toHaveBeenCalledWith('Auth', 'VisibilityRefreshFailed');
    });
  });
});
