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
import { errorTrackingInterceptor } from './error-tracking.interceptor';
import { AnalyticsService } from '../services/analytics.service';
import { getPostgrestUrl, getKeycloakConfig, getMatomoConfig } from '../config/runtime';

describe('errorTrackingInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let mockAnalytics: jasmine.SpyObj<AnalyticsService>;

  const postgrestUrl = getPostgrestUrl();
  const keycloakUrl = getKeycloakConfig().url;

  beforeEach(() => {
    mockAnalytics = jasmine.createSpyObj('AnalyticsService', ['trackError']);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([errorTrackingInterceptor])),
        provideHttpClientTesting(),
        { provide: AnalyticsService, useValue: mockAnalytics }
      ]
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  // --- Cancelled/aborted requests ---

  it('should NOT track cancelled requests (status 0)', () => {
    http.get(`${postgrestUrl}issues`).subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne(`${postgrestUrl}issues`);
    req.error(new ProgressEvent('abort'), { status: 0, statusText: 'Unknown Error' });

    expect(mockAnalytics.trackError).not.toHaveBeenCalled();
  });

  // --- PostgREST (API) errors ---

  it('should track PostgREST 400 errors with API context', () => {
    http.get(`${postgrestUrl}issues`).subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne(`${postgrestUrl}issues`);
    req.flush({ message: 'Bad Request' }, { status: 400, statusText: 'Bad Request' });

    expect(mockAnalytics.trackError).toHaveBeenCalledWith('API 400', 400);
  });

  it('should track PostgREST 404 errors with API context', () => {
    http.get(`${postgrestUrl}nonexistent`).subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne(`${postgrestUrl}nonexistent`);
    req.flush({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });

    expect(mockAnalytics.trackError).toHaveBeenCalledWith('API 404', 404);
  });

  it('should track PostgREST 500 errors with API context', () => {
    http.get(`${postgrestUrl}schema_entities`).subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne(`${postgrestUrl}schema_entities`);
    req.flush({ message: 'Internal Server Error' }, { status: 500, statusText: 'Internal Server Error' });

    expect(mockAnalytics.trackError).toHaveBeenCalledWith('API 500', 500);
  });

  it('should include PostgreSQL error code in label when present', () => {
    http.post(`${postgrestUrl}issues`, {}).subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne(`${postgrestUrl}issues`);
    req.flush(
      { message: 'duplicate key value', code: '23505', details: 'Key already exists' },
      { status: 409, statusText: 'Conflict' }
    );

    expect(mockAnalytics.trackError).toHaveBeenCalledWith('API 409 (PG 23505)', 409);
  });

  it('should include PG permission error code', () => {
    http.get(`${postgrestUrl}sensitive_table`).subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne(`${postgrestUrl}sensitive_table`);
    req.flush(
      { message: 'permission denied', code: '42501' },
      { status: 403, statusText: 'Forbidden' }
    );

    expect(mockAnalytics.trackError).toHaveBeenCalledWith('API 403 (PG 42501)', 403);
  });

  // --- Keycloak (Auth) errors ---

  it('should track Keycloak errors with Auth context', () => {
    http.get(`${keycloakUrl}/realms/civic-os-dev/protocol/openid-connect/token`).subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne(`${keycloakUrl}/realms/civic-os-dev/protocol/openid-connect/token`);
    req.flush({ error: 'invalid_grant' }, { status: 401, statusText: 'Unauthorized' });

    expect(mockAnalytics.trackError).toHaveBeenCalledWith('Auth 401', 401);
  });

  // --- External errors ---

  it('should track external URL errors with External context', () => {
    http.get('https://s3.example.com/bucket/file.pdf').subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne('https://s3.example.com/bucket/file.pdf');
    req.flush({ message: 'Forbidden' }, { status: 403, statusText: 'Forbidden' });

    expect(mockAnalytics.trackError).toHaveBeenCalledWith('External 403', 403);
  });

  // --- Matomo exclusion ---

  it('should NOT track errors from Matomo URLs', () => {
    const matomoConfig = getMatomoConfig();
    // Only test if Matomo is configured; otherwise skip gracefully
    if (!matomoConfig.url) {
      pending('Matomo not configured in test environment');
      return;
    }

    http.get(`${matomoConfig.url}/matomo.php?action_name=test`).subscribe({
      error: () => { /* expected */ }
    });

    const req = httpMock.expectOne(`${matomoConfig.url}/matomo.php?action_name=test`);
    req.flush('Server Error', { status: 500, statusText: 'Internal Server Error' });

    expect(mockAnalytics.trackError).not.toHaveBeenCalled();
  });

  // --- Successful requests ---

  it('should NOT track successful requests', () => {
    http.get(`${postgrestUrl}schema_entities`).subscribe();

    const req = httpMock.expectOne(`${postgrestUrl}schema_entities`);
    req.flush([{ id: 1, name: 'issues' }]);

    expect(mockAnalytics.trackError).not.toHaveBeenCalled();
  });

  // --- Error propagation ---

  it('should propagate errors to subscribers (not swallow them)', () => {
    let errorReceived = false;
    http.get(`${postgrestUrl}issues`).subscribe({
      error: () => { errorReceived = true; }
    });

    const req = httpMock.expectOne(`${postgrestUrl}issues`);
    req.flush({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });

    expect(errorReceived).toBeTrue();
    expect(mockAnalytics.trackError).toHaveBeenCalled();
  });
});
