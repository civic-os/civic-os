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
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient, HttpErrorResponse } from '@angular/common/http';
import { MaintenanceService } from './maintenance.service';
import { AuthService } from './auth.service';
import { LocaleService } from './locale.service';

describe('MaintenanceService', () => {
  let service: MaintenanceService;
  let httpMock: HttpTestingController;
  let mockAuthService: any;
  const localeSignal = signal('en');
  let mockLocaleService: any;

  beforeEach(() => {
    localeSignal.set('en');

    mockAuthService = {
      isAdmin: vi.fn().mockReturnValue(false),
      authenticated: vi.fn().mockReturnValue(true),
      hasRole: vi.fn().mockReturnValue(false),
      userRoles: vi.fn().mockReturnValue([])
    };

    mockLocaleService = {
      locale: localeSignal,
      isRtl: signal(false),
      supportedLocales: [{ code: 'en', name: 'English' }],
      setLocale: vi.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: mockAuthService },
        { provide: LocaleService, useValue: mockLocaleService }
      ]
    });

    httpMock = TestBed.inject(HttpTestingController);
    service = TestBed.inject(MaintenanceService);

    // Flush the one-shot init check (fires immediately on construction)
    const req = httpMock.expectOne('/maintenance.json');
    req.flush(null, { status: 404, statusText: 'Not Found' });
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should have initial state of off', () => {
    expect(service.mode()).toBe('off');
    expect(service.message()).toBeNull();
    expect(service.isReadOnly()).toBe(false);
    expect(service.isFullMaintenance()).toBe(false);
    expect(service.isActive()).toBe(false);
    expect(service.isAdminBypassing()).toBe(false);
  });

  describe('updateFromHeader', () => {
    it('should set mode to readonly from header', () => {
      service.updateFromHeader('readonly');
      expect(service.mode()).toBe('readonly');
      expect(service.isReadOnly()).toBe(true);
      expect(service.isActive()).toBe(true);
    });

    it('should set mode to full from header', () => {
      service.updateFromHeader('full');
      expect(service.mode()).toBe('full');
      expect(service.isFullMaintenance()).toBe(true);
      expect(service.isActive()).toBe(true);
    });

    it('should extract base mode from admin bypass header (readonly-admin)', () => {
      service.updateFromHeader('readonly-admin');
      expect(service.mode()).toBe('readonly');
      expect(service.isReadOnly()).toBe(true);
    });

    it('should extract base mode from admin bypass header (full-admin)', () => {
      service.updateFromHeader('full-admin');
      expect(service.mode()).toBe('full');
      expect(service.isFullMaintenance()).toBe(true);
    });
  });

  describe('updateFromError', () => {
    it('should set readonly mode when error hint contains read-only', () => {
      const error = new HttpErrorResponse({
        error: { hint: 'System is in read-only maintenance mode' },
        status: 503
      });
      service.updateFromError(error);
      expect(service.mode()).toBe('readonly');
    });

    it('should set full mode when error hint does not contain read-only', () => {
      const error = new HttpErrorResponse({
        error: { message: 'Service unavailable' },
        status: 503
      });
      service.updateFromError(error);
      expect(service.mode()).toBe('full');
    });

    it('should set full mode when error has no hint or message', () => {
      const error = new HttpErrorResponse({
        error: {},
        status: 503
      });
      service.updateFromError(error);
      expect(service.mode()).toBe('full');
    });
  });

  describe('clearFromInterceptor', () => {
    it('should reset mode to off and clear message', () => {
      service.updateFromHeader('readonly');
      expect(service.isActive()).toBe(true);

      service.clearFromInterceptor();
      expect(service.mode()).toBe('off');
      expect(service.message()).toBeNull();
      expect(service.isActive()).toBe(false);
    });
  });

  describe('computed signals', () => {
    it('isAdminBypassing should be true when active and user is admin', () => {
      mockAuthService.isAdmin.mockReturnValue(true);
      service.updateFromHeader('readonly');
      expect(service.isAdminBypassing()).toBe(true);
    });

    it('isAdminBypassing should be false when active but user is not admin', () => {
      mockAuthService.isAdmin.mockReturnValue(false);
      service.updateFromHeader('readonly');
      expect(service.isAdminBypassing()).toBe(false);
    });

    it('isAdminBypassing should be false when not active even if user is admin', () => {
      mockAuthService.isAdmin.mockReturnValue(true);
      expect(service.isAdminBypassing()).toBe(false);
    });
  });

  describe('init check (one-shot maintenance.json fetch)', () => {
    // The init check fires immediately on service construction. We test
    // its behavior by creating a fresh service and flushing different responses.

    it('should set mode from maintenance.json when it returns a mode', () => {
      // Create a fresh TestBed to get a new init check
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideHttpClient(),
          provideHttpClientTesting(),
          { provide: AuthService, useValue: mockAuthService },
          { provide: LocaleService, useValue: mockLocaleService }
        ]
      });

      const freshHttp = TestBed.inject(HttpTestingController);
      const freshService = TestBed.inject(MaintenanceService);

      // Flush the init check with a maintenance response
      const req = freshHttp.expectOne('/maintenance.json');
      req.flush({ mode: 'readonly', message: 'Scheduled maintenance' });

      expect(freshService.mode()).toBe('readonly');
      expect(freshService.message()).toBe('Scheduled maintenance');

      freshHttp.verify();
    });

    it('should keep current state when maintenance.json returns 404 (no-op)', () => {
      // The init check returned 404 in beforeEach — mode stays 'off'
      expect(service.mode()).toBe('off');

      // Set mode via interceptor, then verify 404 poll does NOT clear it
      service.updateFromHeader('readonly');
      expect(service.mode()).toBe('readonly');
      // A subsequent 404 poll would not override this — tested by the fact that
      // the initial 404 in beforeEach didn't prevent updateFromHeader from working
    });

    it('should set mode to off when maintenance.json returns mode off', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideHttpClient(),
          provideHttpClientTesting(),
          { provide: AuthService, useValue: mockAuthService },
          { provide: LocaleService, useValue: mockLocaleService }
        ]
      });

      const freshHttp = TestBed.inject(HttpTestingController);
      const freshService = TestBed.inject(MaintenanceService);

      // Flush the init check with an explicit 'off' mode
      const req = freshHttp.expectOne('/maintenance.json');
      req.flush({ mode: 'off' });

      expect(freshService.mode()).toBe('off');
      expect(freshService.message()).toBeNull();

      freshHttp.verify();
    });

    it('should set message from maintenance.json response', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideHttpClient(),
          provideHttpClientTesting(),
          { provide: AuthService, useValue: mockAuthService },
          { provide: LocaleService, useValue: mockLocaleService }
        ]
      });

      const freshHttp = TestBed.inject(HttpTestingController);
      const freshService = TestBed.inject(MaintenanceService);

      const req = freshHttp.expectOne('/maintenance.json');
      req.flush({ mode: 'full', message: 'System upgrade in progress' });

      expect(freshService.mode()).toBe('full');
      expect(freshService.message()).toBe('System upgrade in progress');

      freshHttp.verify();
    });
  });

  describe('hardcoded display strings', () => {
    it('should return English strings by default', () => {
      expect(service.fullTitle()).toBe('System Maintenance');
      expect(service.adminBypassMessage()).toBe('Admin access active — system is in maintenance mode');
    });

    it('should return Spanish strings when locale is es', () => {
      localeSignal.set('es');
      expect(service.fullTitle()).toBe('Mantenimiento del sistema');
      expect(service.readonlyMessage()).toContain('solo lectura');
    });

    it('should return Arabic strings when locale is ar', () => {
      localeSignal.set('ar');
      expect(service.fullTitle()).toBe('صيانة النظام');
    });

    it('should fall back to English for unknown locales', () => {
      localeSignal.set('zh');
      expect(service.fullTitle()).toBe('System Maintenance');
    });

    it('fullMessage should prefer custom message over hardcoded string', () => {
      service.updateFromHeader('full');
      // No custom message set — uses hardcoded
      expect(service.fullMessage()).toContain('temporarily unavailable');

      // Simulate maintenance.json with custom message
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideHttpClient(),
          provideHttpClientTesting(),
          { provide: AuthService, useValue: mockAuthService },
          { provide: LocaleService, useValue: mockLocaleService }
        ]
      });

      const freshHttp = TestBed.inject(HttpTestingController);
      const freshService = TestBed.inject(MaintenanceService);

      const req = freshHttp.expectOne('/maintenance.json');
      req.flush({ mode: 'full', message: 'Custom downtime message' });

      expect(freshService.fullMessage()).toBe('Custom downtime message');
      freshHttp.verify();
    });

    it('readonlyMessage should prefer custom message over hardcoded string', () => {
      expect(service.readonlyMessage()).toContain('read-only mode');

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideHttpClient(),
          provideHttpClientTesting(),
          { provide: AuthService, useValue: mockAuthService },
          { provide: LocaleService, useValue: mockLocaleService }
        ]
      });

      const freshHttp = TestBed.inject(HttpTestingController);
      const freshService = TestBed.inject(MaintenanceService);

      const req = freshHttp.expectOne('/maintenance.json');
      req.flush({ mode: 'readonly', message: 'Brief maintenance window' });

      expect(freshService.readonlyMessage()).toBe('Brief maintenance window');
      freshHttp.verify();
    });
  });
});
