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
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { impersonationInterceptor } from './impersonation.interceptor';
import { ImpersonationService } from '../services/impersonation.service';
import { getPostgrestUrl } from '../config/runtime';

describe('impersonationInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let impersonationService: ImpersonationService;

  const STORAGE_KEY = 'civic_os_impersonation';

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([impersonationInterceptor])),
        provideHttpClientTesting(),
        ImpersonationService
      ]
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    impersonationService = TestBed.inject(ImpersonationService);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.removeItem(STORAGE_KEY);
  });

  it('should not add header when impersonation is not active', () => {
    http.get(`${getPostgrestUrl()}test`).subscribe();

    const req = httpMock.expectOne(`${getPostgrestUrl()}test`);
    expect(req.request.headers.has('X-Impersonate-Roles')).toBeFalse();
    req.flush({});
  });

  it('should add header when impersonation is active', () => {
    // Manually set localStorage to simulate active impersonation
    // (avoiding the audit log HTTP call for simplicity)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      active: true,
      roles: ['user', 'editor']
    }));

    // Create a fresh instance that reads from localStorage
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([impersonationInterceptor])),
        provideHttpClientTesting(),
        ImpersonationService
      ]
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);

    http.get(`${getPostgrestUrl()}schema_entities`).subscribe();

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    expect(req.request.headers.get('X-Impersonate-Roles')).toBe('user,editor');
    req.flush({});
  });

  it('should not add header for non-PostgREST requests', () => {
    // Set up active impersonation
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      active: true,
      roles: ['user']
    }));

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([impersonationInterceptor])),
        provideHttpClientTesting(),
        ImpersonationService
      ]
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);

    // Request to a different URL (not PostgREST)
    http.get('https://api.example.com/data').subscribe();

    const req = httpMock.expectOne('https://api.example.com/data');
    expect(req.request.headers.has('X-Impersonate-Roles')).toBeFalse();
    req.flush({});
  });
});
