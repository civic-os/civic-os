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
import { HttpClient, provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { errorTrackingInterceptor } from './error-tracking.interceptor';
import { AnalyticsService } from '../services/analytics.service';
import { getPostgrestUrl, getKeycloakConfig, getMatomoConfig } from '../config/runtime';

describe('errorTrackingInterceptor', () => {
    let http: HttpClient;
    let httpMock: HttpTestingController;
    let mockAnalytics: any;

    const postgrestUrl = getPostgrestUrl();
    const keycloakUrl = getKeycloakConfig().url;

    beforeEach(() => {
        mockAnalytics = {
            trackError: vi.fn().mockName("AnalyticsService.trackError")
        };

        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr(), withInterceptors([errorTrackingInterceptor])),
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

    it('should NOT track cancelled requests (status 0)', async () => {
        const done = firstValueFrom(http.get(`${postgrestUrl}issues`)).catch(() => undefined);

        const req = httpMock.expectOne(`${postgrestUrl}issues`);
        req.error(new ProgressEvent('abort'), { status: 0, statusText: 'Unknown Error' });
        await done;

        expect(mockAnalytics.trackError).not.toHaveBeenCalled();
    });

    // --- PostgREST (API) errors ---

    it('should track PostgREST 400 errors with API context', async () => {
        const done = firstValueFrom(http.get(`${postgrestUrl}issues`)).catch(() => undefined);

        const req = httpMock.expectOne(`${postgrestUrl}issues`);
        req.flush({ message: 'Bad Request' }, { status: 400, statusText: 'Bad Request' });
        await done;

        expect(mockAnalytics.trackError).toHaveBeenCalledWith('API 400', 400);
    });

    it('should track PostgREST 404 errors with API context', async () => {
        const done = firstValueFrom(http.get(`${postgrestUrl}nonexistent`)).catch(() => undefined);

        const req = httpMock.expectOne(`${postgrestUrl}nonexistent`);
        req.flush({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });
        await done;

        expect(mockAnalytics.trackError).toHaveBeenCalledWith('API 404', 404);
    });

    it('should track PostgREST 500 errors with API context', async () => {
        const done = firstValueFrom(http.get(`${postgrestUrl}schema_entities`)).catch(() => undefined);

        const req = httpMock.expectOne(`${postgrestUrl}schema_entities`);
        req.flush({ message: 'Internal Server Error' }, { status: 500, statusText: 'Internal Server Error' });
        await done;

        expect(mockAnalytics.trackError).toHaveBeenCalledWith('API 500', 500);
    });

    it('should include PostgreSQL error code in label when present', async () => {
        const done = firstValueFrom(http.post(`${postgrestUrl}issues`, {})).catch(() => undefined);

        const req = httpMock.expectOne(`${postgrestUrl}issues`);
        req.flush({ message: 'duplicate key value', code: '23505', details: 'Key already exists' }, { status: 409, statusText: 'Conflict' });
        await done;

        expect(mockAnalytics.trackError).toHaveBeenCalledWith('API 409 (PG 23505)', 409);
    });

    it('should include PG permission error code', async () => {
        const done = firstValueFrom(http.get(`${postgrestUrl}sensitive_table`)).catch(() => undefined);

        const req = httpMock.expectOne(`${postgrestUrl}sensitive_table`);
        req.flush({ message: 'permission denied', code: '42501' }, { status: 403, statusText: 'Forbidden' });
        await done;

        expect(mockAnalytics.trackError).toHaveBeenCalledWith('API 403 (PG 42501)', 403);
    });

    // --- Keycloak (Auth) errors ---

    it('should track Keycloak errors with Auth context', async () => {
        const done = firstValueFrom(http.get(`${keycloakUrl}/realms/civic-os-dev/protocol/openid-connect/token`)).catch(() => undefined);

        const req = httpMock.expectOne(`${keycloakUrl}/realms/civic-os-dev/protocol/openid-connect/token`);
        req.flush({ error: 'invalid_grant' }, { status: 401, statusText: 'Unauthorized' });
        await done;

        expect(mockAnalytics.trackError).toHaveBeenCalledWith('Auth 401', 401);
    });

    // --- External errors ---

    it('should track external URL errors with External context', async () => {
        const done = firstValueFrom(http.get('https://s3.example.com/bucket/file.pdf')).catch(() => undefined);

        const req = httpMock.expectOne('https://s3.example.com/bucket/file.pdf');
        req.flush({ message: 'Forbidden' }, { status: 403, statusText: 'Forbidden' });
        await done;

        expect(mockAnalytics.trackError).toHaveBeenCalledWith('External 403', 403);
    });

    // --- Matomo exclusion ---

    it.skip('should NOT track errors from Matomo URLs', () => {
        const matomoConfig = getMatomoConfig();
        // Only test if Matomo is configured; otherwise skip gracefully
        if (!matomoConfig.url) {
            // Matomo not configured in test environment — test skipped via it.skip
            return;
        }

        http.get(`${matomoConfig.url}/matomo.php?action_name=test`).subscribe({
            error: () => { }
        });

        const req = httpMock.expectOne(`${matomoConfig.url}/matomo.php?action_name=test`);
        req.flush('Server Error', { status: 500, statusText: 'Internal Server Error' });

        expect(mockAnalytics.trackError).not.toHaveBeenCalled();
    });

    // --- Successful requests ---

    it('should NOT track successful requests', async () => {
        const done = firstValueFrom(http.get(`${postgrestUrl}schema_entities`));

        const req = httpMock.expectOne(`${postgrestUrl}schema_entities`);
        req.flush([{ id: 1, name: 'issues' }]);
        await done;

        expect(mockAnalytics.trackError).not.toHaveBeenCalled();
    });

    // --- Error propagation ---

    it('should propagate errors to subscribers (not swallow them)', async () => {
        const done = firstValueFrom(http.get(`${postgrestUrl}issues`)).then(() => false, () => true);

        const req = httpMock.expectOne(`${postgrestUrl}issues`);
        req.flush({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });
        const errorReceived = await done;

        expect(errorReceived).toBe(true);
        expect(mockAnalytics.trackError).toHaveBeenCalled();
    });
});
