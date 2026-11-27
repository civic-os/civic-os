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
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { ConfigAdminService, ENV_VAR_NAMES, InstanceConfigRow } from './config-admin.service';
import { ConfigService } from './config.service';

describe('ConfigAdminService', () => {
    let service: ConfigAdminService;
    let httpMock: HttpTestingController;
    let mockConfig: { invalidateCache: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        mockConfig = { invalidateCache: vi.fn().mockName('ConfigService.invalidateCache') };
        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                { provide: ConfigService, useValue: mockConfig },
                ConfigAdminService
            ]
        });
        service = TestBed.inject(ConfigAdminService);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify();
    });

    describe('getConfig', () => {
        it('GETs the instance_config view and returns the rows in API order', async () => {
            const rows = [
                { config_key: 'app_title', config_value: null, config_type: 'string' }
            ] as InstanceConfigRow[];

            const result$ = firstValueFrom(service.getConfig());
            const req = httpMock.expectOne(r => r.url.endsWith('instance_config'));
            expect(req.request.method).toBe('GET');
            req.flush(rows);

            expect(await result$).toEqual(rows);
        });
    });

    describe('setValue', () => {
        it('POSTs the RPC with p_key and p_value', async () => {
            const result$ = firstValueFrom(service.setValue('app_title', 'Pothole Tracker'));
            const req = httpMock.expectOne(r => r.url.includes('rpc/set_instance_config'));
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({ p_key: 'app_title', p_value: 'Pothole Tracker' });
            req.flush({ success: true, config_key: 'app_title', config_value: 'Pothole Tracker' });

            expect(await result$).toEqual({ success: true, config_key: 'app_title', config_value: 'Pothole Tracker' });
        });

        it('sends null to clear a value', async () => {
            const result$ = firstValueFrom(service.setValue('app_title', null));
            const req = httpMock.expectOne(r => r.url.includes('rpc/set_instance_config'));
            expect(req.request.body).toEqual({ p_key: 'app_title', p_value: null });
            req.flush({ success: true, config_key: 'app_title', config_value: null });

            expect((await result$).config_value).toBeNull();
        });

        it('returns the normalized value the RPC stored', async () => {
            const result$ = firstValueFrom(service.setValue('supported_locales', ' en, es '));
            httpMock.expectOne(r => r.url.includes('rpc/set_instance_config'))
                .flush({ success: true, config_key: 'supported_locales', config_value: 'en,es' });

            expect((await result$).config_value).toBe('en,es');
        });

        it('invalidates the ConfigService cache on success', async () => {
            const result$ = firstValueFrom(service.setValue('app_title', 'X'));
            httpMock.expectOne(r => r.url.includes('rpc/set_instance_config'))
                .flush({ success: true, config_key: 'app_title', config_value: 'X' });
            await result$;

            expect(mockConfig.invalidateCache).toHaveBeenCalledTimes(1);
        });

        it('maps a success:false body to an error result without invalidating', async () => {
            const result$ = firstValueFrom(service.setValue('map_default_zoom', 'abc'));
            httpMock.expectOne(r => r.url.includes('rpc/set_instance_config'))
                .flush({ success: false, error: 'Value must be a whole number' });

            expect(await result$).toEqual({ success: false, error: 'Value must be a whole number' });
            expect(mockConfig.invalidateCache).not.toHaveBeenCalled();
        });

        it('maps an HTTP error to an error result without invalidating', async () => {
            const result$ = firstValueFrom(service.setValue('app_title', 'X'));
            httpMock.expectOne(r => r.url.includes('rpc/set_instance_config'))
                .flush({ message: 'permission denied for function set_instance_config', code: '42501' },
                    { status: 403, statusText: 'Forbidden' });

            const result = await result$;
            expect(result.success).toBe(false);
            expect(result.error).toBeTruthy();
            expect(mockConfig.invalidateCache).not.toHaveBeenCalled();
        });
    });

    describe('getSecretStatus', () => {
        it('POSTs the status RPC and returns its rows', async () => {
            const rows = [{ config_key: 's3_bucket', is_set: true, display_value: 'civic-os-files' }];
            const result$ = firstValueFrom(service.getSecretStatus());
            const req = httpMock.expectOne(r => r.url.includes('rpc/get_instance_secret_status'));
            expect(req.request.method).toBe('POST');
            req.flush(rows);
            expect(await result$).toEqual(rows);
        });

        it('returns no rows when the RPC refuses the caller (42501)', async () => {
            const result$ = firstValueFrom(service.getSecretStatus());
            httpMock.expectOne(r => r.url.includes('rpc/get_instance_secret_status'))
                .flush({ code: '42501', message: 'Permission denied' }, { status: 403, statusText: 'Forbidden' });
            expect(await result$).toEqual([]);
        });
    });

    describe('setSecret', () => {
        it('POSTs p_key and p_value and returns only whether a value is set', async () => {
            const result$ = firstValueFrom(service.setSecret('altcha_hmac_key', 'secret'));
            const req = httpMock.expectOne(r => r.url.includes('rpc/set_instance_secret'));
            expect(req.request.body).toEqual({ p_key: 'altcha_hmac_key', p_value: 'secret' });
            req.flush({ success: true, config_key: 'altcha_hmac_key', is_set: true, updated_at: '2026-11-27T00:00:00Z' });
            expect(await result$).toEqual({ success: true, is_set: true, updated_at: '2026-11-27T00:00:00Z' });
            expect(mockConfig.invalidateCache).not.toHaveBeenCalled();
        });

        it('maps success:false and HTTP errors to error results', async () => {
            const refused$ = firstValueFrom(service.setSecret('s3_bucket', 'x'));
            httpMock.expectOne(r => r.url.includes('rpc/set_instance_secret'))
                .flush({ success: false, error: 's3_bucket is set by the deployment' });
            expect(await refused$).toEqual({ success: false, error: 's3_bucket is set by the deployment' });

            const failed$ = firstValueFrom(service.setSecret('altcha_hmac_key', 'x'));
            httpMock.expectOne(r => r.url.includes('rpc/set_instance_secret'))
                .flush({ code: '42501', message: 'permission denied' }, { status: 403, statusText: 'Forbidden' });
            const failed = await failed$;
            expect(failed.success).toBe(false);
            expect(failed.error).toBeTruthy();
        });
    });

    describe('ENV_VAR_NAMES', () => {
        it('maps the ten framework keys to their env vars', () => {
            expect(ENV_VAR_NAMES).toEqual({
                app_title: 'APP_TITLE',
                default_theme: 'DEFAULT_THEME',
                default_locale: 'DEFAULT_LOCALE',
                supported_locales: 'SUPPORTED_LOCALES',
                sms_configured: 'SMS_CONFIGURED',
                matomo_enabled: 'MATOMO_ENABLED',
                map_default_lat: 'MAP_DEFAULT_LAT',
                map_default_lng: 'MAP_DEFAULT_LNG',
                map_default_zoom: 'MAP_DEFAULT_ZOOM',
                stripe_publishable_key: 'STRIPE_PUBLISHABLE_KEY'
            });
        });
    });
});
