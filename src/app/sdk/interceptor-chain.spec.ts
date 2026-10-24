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
import { provideZonelessChangeDetection } from '@angular/core';
import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import Keycloak from 'keycloak-js';
import { createInterceptorCondition, INCLUDE_BEARER_TOKEN_INTERCEPTOR_CONFIG, IncludeBearerTokenCondition } from 'keycloak-angular';
import { HTTP_INTERCEPTORS_IN_ORDER } from '../app.config';
import { DataService } from '../services/data.service';
import { AnalyticsService } from '../services/analytics.service';
import { AuthService } from '../services/auth.service';
import { ImpersonationService } from '../services/impersonation.service';
import { LocaleService } from '../services/locale.service';
import { MaintenanceService } from '../services/maintenance.service';
import { provideTranslationTesting } from '../testing/translation-testing';

vi.mock('@unovis/angular', () => import('../testing/unovis-angular.stub'));

const API = 'http://test-api.example.com/';

/**
 * Real `DataService` calls through the real interceptors, in the order the app
 * registers them. The core's requests travel over `HttpClient`, so each
 * interceptor must see them exactly as it saw a direct `HttpClient` call.
 */
describe('DataService through the app interceptor chain', () => {
  let service: DataService;
  let httpMock: HttpTestingController;
  let keycloak: { authenticated: boolean; token: string; updateToken: ReturnType<typeof vi.fn>; login: ReturnType<typeof vi.fn> };
  let analytics: { trackEvent: ReturnType<typeof vi.fn>; trackError: ReturnType<typeof vi.fn> };
  let maintenance: { updateFromHeader: ReturnType<typeof vi.fn>; updateFromError: ReturnType<typeof vi.fn>; clearFromInterceptor: ReturnType<typeof vi.fn>; isActive: ReturnType<typeof vi.fn> };
  let impersonationHeader: string | null;
  let locale: string;
  let authenticated: boolean;

  beforeEach(() => {
    (window as any).civicOsConfig = { postgrestUrl: API };
    impersonationHeader = null;
    locale = 'en';
    authenticated = true;
    keycloak = {
      authenticated: true,
      token: 'tok-123',
      updateToken: vi.fn().mockResolvedValue(true),
      login: vi.fn().mockResolvedValue(undefined),
    };
    analytics = { trackEvent: vi.fn(), trackError: vi.fn() };
    maintenance = {
      updateFromHeader: vi.fn(),
      updateFromError: vi.fn(),
      clearFromInterceptor: vi.fn(),
      isActive: vi.fn().mockReturnValue(false),
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr(), withInterceptors([...HTTP_INTERCEPTORS_IN_ORDER])),
        provideHttpClientTesting(),
        provideTranslationTesting(),
        {
          provide: INCLUDE_BEARER_TOKEN_INTERCEPTOR_CONFIG,
          useValue: [
            createInterceptorCondition<IncludeBearerTokenCondition>({
              urlPattern: new RegExp(`^(${API.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(.*)?$`, 'i'),
              bearerPrefix: 'Bearer',
            }),
          ],
        },
        { provide: Keycloak, useValue: keycloak },
        { provide: AnalyticsService, useValue: analytics },
        { provide: AuthService, useValue: { authenticated: () => authenticated } },
        { provide: ImpersonationService, useValue: { headerValue: () => impersonationHeader } },
        { provide: LocaleService, useValue: { locale: () => locale } },
        { provide: MaintenanceService, useValue: maintenance },
        DataService,
      ],
    });
    service = TestBed.inject(DataService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  /** The interceptors that run before the request is issued are async (bearer token), so wait for it. */
  async function nextRequest(url: string) {
    for (let i = 0; i < 50; i++) {
      const found = httpMock.match(url);
      if (found.length === 1) return found[0];
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return httpMock.expectOne(url);
  }

  it('exports the interceptors in the order the app registers them', () => {
    expect(HTTP_INTERCEPTORS_IN_ORDER.length).toBe(6);
    expect(HTTP_INTERCEPTORS_IN_ORDER.map(i => i.name)).toEqual([
      'includeBearerTokenInterceptor',
      'impersonationInterceptor',
      'localeInterceptor',
      'maintenanceInterceptor',
      'authErrorInterceptor',
      'errorTrackingInterceptor',
    ]);
  });

  it('adds the bearer token to PostgREST requests', async () => {
    const done = firstValueFrom(service.createData('issues', { n: 1 }));
    const req = await nextRequest(API + 'issues');
    expect(req.request.headers.get('Authorization')).toBe('Bearer tok-123');
    req.flush([{ id: 1 }]);
    await done;
  });

  it('sends no bearer token to a URL outside the PostgREST API', async () => {
    const client = TestBed.inject(HttpClient);
    const done = firstValueFrom(client.get('http://elsewhere.example.com/x'));
    const req = await nextRequest('http://elsewhere.example.com/x');
    expect(req.request.headers.has('Authorization')).toBe(false);
    expect(req.request.headers.has('Accept-Language')).toBe(false);
    expect(req.request.headers.has('X-Impersonate-Roles')).toBe(false);
    req.flush({});
    await done;
  });

  it('adds Accept-Language for a non-English locale and omits it for English', async () => {
    locale = 'es';
    const es = firstValueFrom(service.deleteData('issues', 1));
    const esReq = await nextRequest(API + 'issues?id=eq.1');
    expect(esReq.request.headers.get('Accept-Language')).toBe('es');
    esReq.flush(null, { status: 204, statusText: 'No Content' });
    await es;

    locale = 'en';
    const en = firstValueFrom(service.deleteData('issues', 2));
    const enReq = await nextRequest(API + 'issues?id=eq.2');
    expect(enReq.request.headers.has('Accept-Language')).toBe(false);
    enReq.flush(null, { status: 204, statusText: 'No Content' });
    await en;
  });

  it('adds X-Impersonate-Roles when impersonating, but never on refresh_current_user', async () => {
    impersonationHeader = 'editor,user';
    const edit = firstValueFrom(service.deleteData('issues', 1));
    const editReq = await nextRequest(API + 'issues?id=eq.1');
    expect(editReq.request.headers.get('X-Impersonate-Roles')).toBe('editor,user');
    editReq.flush(null, { status: 204, statusText: 'No Content' });
    await edit;

    const refresh = firstValueFrom(service.refreshCurrentUser());
    const refreshReq = await nextRequest(API + 'rpc/refresh_current_user');
    expect(refreshReq.request.headers.has('X-Impersonate-Roles')).toBe(false);
    refreshReq.flush({});
    await refresh;
  });

  it('redirects an authenticated user to login on a 401 and still returns the mapped error', async () => {
    const done = firstValueFrom(service.createData('issues', {}));
    const req = await nextRequest(API + 'issues');
    req.flush({ message: 'JWT expired' }, { status: 401, statusText: 'Unauthorized' });
    const result = await done;
    expect(keycloak.login).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error!.httpCode).toBe(401);
  });

  it('does not redirect on a 401 when the user is not authenticated', async () => {
    authenticated = false;
    const done = firstValueFrom(service.createData('issues', {}));
    const req = await nextRequest(API + 'issues');
    req.flush({ message: 'nope' }, { status: 401, statusText: 'Unauthorized' });
    await done;
    expect(keycloak.login).not.toHaveBeenCalled();
  });

  it('reports the maintenance header of a successful response', async () => {
    const done = firstValueFrom(service.createData('issues', {}));
    const req = await nextRequest(API + 'issues');
    req.flush([], { headers: { 'X-Maintenance-Mode': 'readonly' } });
    await done;
    expect(maintenance.updateFromHeader).toHaveBeenCalledWith('readonly');
  });

  it('detects maintenance on a 503 and hands it the parsed error body', async () => {
    const done = firstValueFrom(service.createData('issues', {}));
    const req = await nextRequest(API + 'issues');
    req.flush({ hint: 'System is read-only', message: 'Service Unavailable' }, { status: 503, statusText: 'Service Unavailable' });
    const result = await done;
    expect(maintenance.updateFromError).toHaveBeenCalledTimes(1);
    const err = maintenance.updateFromError.mock.calls[0][0] as HttpErrorResponse;
    expect(err.status).toBe(503);
    expect(err.error).toEqual({ hint: 'System is read-only', message: 'Service Unavailable' });
    expect(result.success).toBe(false);
    expect(result.error!.httpCode).toBe(503);
  });

  it('tracks an HTTP error with its PostgreSQL code from the parsed body', async () => {
    const done = firstValueFrom(service.createData('issues', {}));
    const req = await nextRequest(API + 'issues');
    req.flush({ code: '23505', message: 'duplicate' }, { status: 409, statusText: 'Conflict' });
    await done;
    expect(analytics.trackError).toHaveBeenCalledWith('API 409 (PG 23505)', 409);
  });

  it('does not track a cancelled request', async () => {
    const sub = service.createData('issues', {}).subscribe();
    const req = await nextRequest(API + 'issues');
    sub.unsubscribe();
    expect(req.cancelled).toBe(true);
    expect(analytics.trackError).not.toHaveBeenCalled();
  });
});
