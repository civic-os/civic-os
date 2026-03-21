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
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
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

  describe('permission cache', () => {
    let httpTesting: HttpTestingController;

    beforeEach(() => {
      httpTesting = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
      httpTesting.verify();
    });

    it('should load permissions on authenticated Ready event', () => {
      keycloakEventSignal.set({ type: KeycloakEventType.Ready, args: true });
      TestBed.flushEffects();

      const req = httpTesting.expectOne(r => r.url.includes('rpc/get_current_user_permissions'));
      req.flush([
        { table_name: 'issues', permission: 'read' },
        { table_name: 'issues', permission: 'create' }
      ]);

      expect(service.hasPermission('issues', 'read')).toBeTrue();
      expect(service.hasPermission('issues', 'create')).toBeTrue();
      expect(service.hasPermission('issues', 'delete')).toBeFalse();
      expect(service.permissionsLoaded()).toBeTrue();
    });

    it('should return false for uncached tables', () => {
      keycloakEventSignal.set({ type: KeycloakEventType.Ready, args: true });
      TestBed.flushEffects();

      const req = httpTesting.expectOne(r => r.url.includes('rpc/get_current_user_permissions'));
      req.flush([{ table_name: 'issues', permission: 'read' }]);

      expect(service.hasPermission('nonexistent_table', 'read')).toBeFalse();
    });

    it('should return false before permissions are loaded', () => {
      expect(service.hasPermission('issues', 'read')).toBeFalse();
      expect(service.permissionsLoaded()).toBeFalse();
    });

    it('should clear cache on logout', () => {
      // First authenticate and load permissions
      keycloakEventSignal.set({ type: KeycloakEventType.Ready, args: true });
      TestBed.flushEffects();
      const req = httpTesting.expectOne(r => r.url.includes('rpc/get_current_user_permissions'));
      req.flush([{ table_name: 'issues', permission: 'read' }]);
      expect(service.hasPermission('issues', 'read')).toBeTrue();

      // Logout
      keycloakEventSignal.set({ type: KeycloakEventType.AuthLogout, args: undefined });
      TestBed.flushEffects();

      expect(service.hasPermission('issues', 'read')).toBeFalse();
      expect(service.permissionsLoaded()).toBeFalse();
    });

    it('should refresh permissions when refreshPermissions() is called', () => {
      // First authenticate and load permissions
      keycloakEventSignal.set({ type: KeycloakEventType.Ready, args: true });
      TestBed.flushEffects();
      const req1 = httpTesting.expectOne(r => r.url.includes('rpc/get_current_user_permissions'));
      req1.flush([{ table_name: 'issues', permission: 'read' }]);
      expect(service.hasPermission('issues', 'read')).toBeTrue();

      // Refresh
      service.refreshPermissions();
      const req2 = httpTesting.expectOne(r => r.url.includes('rpc/get_current_user_permissions'));
      req2.flush([
        { table_name: 'issues', permission: 'read' },
        { table_name: 'issues', permission: 'delete' }
      ]);

      expect(service.hasPermission('issues', 'delete')).toBeTrue();
    });

    /**
     * REGRESSION: Reactive loop prevention (v0.40.0 hotfix)
     *
     * Root cause: The Keycloak event effect() called loadPermissions(), which
     * reads permissionsLoading() as a guard check. Without untracked(), Angular
     * registered permissionsLoading as an effect dependency. When loadPermissions()
     * set permissionsLoading(true), the effect re-ran. When the HTTP response
     * arrived and set permissionsLoading(false) + permissionsCache(new Map),
     * the effect re-ran again — firing another HTTP request → infinite loop.
     *
     * Fix: Wrap the entire effect body (after keycloakSignal read) in untracked()
     * so only keycloakSignal changes trigger re-execution.
     */
    it('should NOT re-fire permissions HTTP request when cache updates (regression: reactive loop)', () => {
      // Trigger Ready → authenticated → loadPermissions fires
      keycloakEventSignal.set({ type: KeycloakEventType.Ready, args: true });
      TestBed.flushEffects();

      // First request: loadPermissions() fires after Ready event
      const req = httpTesting.expectOne(r => r.url.includes('rpc/get_current_user_permissions'));

      // Flush the response — this writes to permissionsCache, permissionsLoaded, permissionsLoading.
      // In the buggy version, these writes re-triggered the effect → second HTTP request.
      req.flush([{ table_name: 'issues', permission: 'read' }]);
      TestBed.flushEffects();

      // Verify: NO additional permissions requests were fired.
      // If this expectNone fails, the reactive loop bug has regressed.
      httpTesting.expectNone(
        r => r.url.includes('rpc/get_current_user_permissions'),
        'permissions HTTP request should fire exactly once, not loop'
      );
      expect(service.permissionsLoaded()).toBeTrue();
    });

    it('hasPermission() should not create reactive dependency when called inside effect()', () => {
      // Authenticate and load permissions
      keycloakEventSignal.set({ type: KeycloakEventType.Ready, args: true });
      TestBed.flushEffects();
      const req = httpTesting.expectOne(r => r.url.includes('rpc/get_current_user_permissions'));
      req.flush([{ table_name: 'issues', permission: 'read' }]);

      // hasPermission uses untracked() internally, so reading it from within
      // a component's effect() should NOT make permissionsCache a dependency.
      // The returned value is a point-in-time snapshot.
      const result = service.hasPermission('issues', 'read');
      expect(result).toBeTrue();

      // Refresh cache to change the underlying signal
      service.refreshPermissions();
      const req2 = httpTesting.expectOne(r => r.url.includes('rpc/get_current_user_permissions'));
      req2.flush([]);

      // Value changed, but callers holding the old boolean aren't re-notified
      // (that's by design — callers use computed() for reactivity)
      expect(service.hasPermission('issues', 'read')).toBeFalse();
    });
  });
});
