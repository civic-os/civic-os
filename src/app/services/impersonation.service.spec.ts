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

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ImpersonationService } from './impersonation.service';
import { getPostgrestUrl } from '../config/runtime';

describe('ImpersonationService', () => {
  let service: ImpersonationService;
  let httpMock: HttpTestingController;

  const STORAGE_KEY = 'civic_os_impersonation';

  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.removeItem(STORAGE_KEY);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        ImpersonationService
      ]
    });
    service = TestBed.inject(ImpersonationService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.removeItem(STORAGE_KEY);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('initial state', () => {
    it('should start inactive with no roles', () => {
      expect(service.isActive()).toBeFalse();
      expect(service.impersonatedRoles()).toEqual([]);
      expect(service.headerValue()).toBeNull();
    });
  });

  describe('startImpersonation', () => {
    it('should set active state and roles on success', () => {
      const roles = ['user', 'editor'];

      service.startImpersonation(roles).subscribe(success => {
        expect(success).toBeTrue();
      });

      // Respond to the audit log request
      const req = httpMock.expectOne(`${getPostgrestUrl()}rpc/log_impersonation`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_impersonated_roles: roles,
        p_action: 'start'
      });
      req.flush({ success: true, message: 'Impersonation start logged' });

      // Verify state
      expect(service.isActive()).toBeTrue();
      expect(service.impersonatedRoles()).toEqual(roles);
      expect(service.headerValue()).toBe('user,editor');
    });

    it('should persist to localStorage', () => {
      service.startImpersonation(['user']).subscribe();

      const req = httpMock.expectOne(`${getPostgrestUrl()}rpc/log_impersonation`);
      req.flush({ success: true, message: '' });

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      expect(stored.active).toBeTrue();
      expect(stored.roles).toEqual(['user']);
    });

    it('should not start with empty roles', () => {
      service.startImpersonation([]).subscribe(success => {
        expect(success).toBeFalse();
      });

      // No HTTP request should be made
      httpMock.expectNone(`${getPostgrestUrl()}rpc/log_impersonation`);

      expect(service.isActive()).toBeFalse();
    });
  });

  describe('stopImpersonation', () => {
    it('should clear state on stop', () => {
      // First start impersonation
      service.startImpersonation(['user']).subscribe();
      httpMock.expectOne(`${getPostgrestUrl()}rpc/log_impersonation`).flush({ success: true, message: '' });

      expect(service.isActive()).toBeTrue();

      // Now stop
      service.stopImpersonation().subscribe(success => {
        expect(success).toBeTrue();
      });

      const req = httpMock.expectOne(`${getPostgrestUrl()}rpc/log_impersonation`);
      expect(req.request.body.p_action).toBe('stop');
      req.flush({ success: true, message: '' });

      expect(service.isActive()).toBeFalse();
      expect(service.impersonatedRoles()).toEqual([]);
      expect(service.headerValue()).toBeNull();
    });

    it('should clear localStorage on stop', () => {
      service.startImpersonation(['user']).subscribe();
      httpMock.expectOne(`${getPostgrestUrl()}rpc/log_impersonation`).flush({ success: true, message: '' });

      service.stopImpersonation().subscribe();
      httpMock.expectOne(`${getPostgrestUrl()}rpc/log_impersonation`).flush({ success: true, message: '' });

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('should succeed immediately if not active', () => {
      service.stopImpersonation().subscribe(success => {
        expect(success).toBeTrue();
      });

      // No HTTP request for stop when not active
      httpMock.expectNone(`${getPostgrestUrl()}rpc/log_impersonation`);
    });

    it('should clear state even when audit logging fails', () => {
      // First start impersonation
      service.startImpersonation(['user', 'editor']).subscribe();
      httpMock.expectOne(`${getPostgrestUrl()}rpc/log_impersonation`).flush({ success: true, message: '' });

      expect(service.isActive()).toBeTrue();
      expect(service.impersonatedRoles()).toEqual(['user', 'editor']);

      // Now stop - but make audit logging fail
      service.stopImpersonation().subscribe();

      const req = httpMock.expectOne(`${getPostgrestUrl()}rpc/log_impersonation`);
      expect(req.request.body.p_action).toBe('stop');
      // Simulate HTTP error (e.g., token expired, 401)
      req.error(new ProgressEvent('error'), { status: 401, statusText: 'Unauthorized' });

      // State should still be cleared despite audit failure
      expect(service.isActive()).toBeFalse();
      expect(service.impersonatedRoles()).toEqual([]);
      expect(service.headerValue()).toBeNull();
      expect(localStorage.getItem('civic_os_impersonation')).toBeNull();
    });
  });

  describe('headerValue', () => {
    it('should return comma-separated roles when active', () => {
      service.startImpersonation(['user', 'editor', 'manager']).subscribe();
      httpMock.expectOne(`${getPostgrestUrl()}rpc/log_impersonation`).flush({ success: true, message: '' });

      expect(service.headerValue()).toBe('user,editor,manager');
    });

    it('should return null when not active', () => {
      expect(service.headerValue()).toBeNull();
    });
  });

  describe('localStorage persistence', () => {
    it('should restore state from localStorage on init', () => {
      // Pre-set localStorage
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        active: true,
        roles: ['editor']
      }));

      // Reconfigure TestBed to create a fresh service that reads from localStorage
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideHttpClient(),
          provideHttpClientTesting(),
          ImpersonationService
        ]
      });
      const newService = TestBed.inject(ImpersonationService);

      expect(newService.isActive()).toBeTrue();
      expect(newService.impersonatedRoles()).toEqual(['editor']);
    });

    it('should handle corrupted localStorage gracefully', () => {
      localStorage.setItem(STORAGE_KEY, 'not valid json');

      // Reconfigure TestBed to create a fresh service
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideHttpClient(),
          provideHttpClientTesting(),
          ImpersonationService
        ]
      });
      const newService = TestBed.inject(ImpersonationService);

      expect(newService.isActive()).toBeFalse();
      expect(newService.impersonatedRoles()).toEqual([]);
    });
  });
});
