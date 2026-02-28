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
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import Keycloak from 'keycloak-js';
import { authErrorInterceptor } from './auth-error.interceptor';
import { AuthService } from '../services/auth.service';
import { getPostgrestUrl } from '../config/runtime';

describe('authErrorInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let mockKeycloak: jasmine.SpyObj<Keycloak>;
  let mockAuthService: jasmine.SpyObj<AuthService>;

  beforeEach(() => {
    mockKeycloak = jasmine.createSpyObj('Keycloak', ['login']);
    mockKeycloak.login.and.returnValue(Promise.resolve());

    mockAuthService = jasmine.createSpyObj('AuthService', ['authenticated']);
    mockAuthService.authenticated.and.returnValue(true);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([authErrorInterceptor])),
        provideHttpClientTesting(),
        { provide: Keycloak, useValue: mockKeycloak },
        { provide: AuthService, useValue: mockAuthService }
      ]
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should redirect to login on 401 from PostgREST when authenticated', () => {
    http.get(`${getPostgrestUrl()}schema_entities`).subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush({ message: 'JWT expired' }, { status: 401, statusText: 'Unauthorized' });

    expect(mockKeycloak.login).toHaveBeenCalled();
  });

  it('should not redirect on 401 when not authenticated', () => {
    mockAuthService.authenticated.and.returnValue(false);

    http.get(`${getPostgrestUrl()}schema_entities`).subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush({ message: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });

    expect(mockKeycloak.login).not.toHaveBeenCalled();
  });

  it('should not redirect on non-401 errors', () => {
    http.get(`${getPostgrestUrl()}schema_entities`).subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush({ message: 'Server Error' }, { status: 500, statusText: 'Internal Server Error' });

    expect(mockKeycloak.login).not.toHaveBeenCalled();
  });

  it('should not redirect on 401 from non-PostgREST URLs', () => {
    http.get('https://api.example.com/data').subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne('https://api.example.com/data');
    req.flush({ message: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });

    expect(mockKeycloak.login).not.toHaveBeenCalled();
  });

  it('should pass through successful responses', () => {
    let responseData: unknown;
    http.get(`${getPostgrestUrl()}schema_entities`).subscribe({
      next: (data) => { responseData = data; }
    });

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush([{ id: 1, name: 'test' }]);

    expect(responseData).toEqual([{ id: 1, name: 'test' }]);
    expect(mockKeycloak.login).not.toHaveBeenCalled();
  });
});
