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
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TranslationAdminService, Translation, MissingTranslation } from './translation-admin.service';
import { firstValueFrom } from 'rxjs';

describe('TranslationAdminService', () => {
    let service: TranslationAdminService;
    let httpMock: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                TranslationAdminService
            ]
        });
        service = TestBed.inject(TranslationAdminService);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify();
    });

    describe('getTranslations', () => {
        it('should build correct URL with locale filter', async () => {
            const result$ = firstValueFrom(service.getTranslations('es'));
            const req = httpMock.expectOne(r => r.url.includes('translations') && r.url.includes('locale=eq.es'));
            expect(req.request.method).toBe('GET');
            expect(req.request.url).toContain('order=source_type,source_key');
            req.flush([]);
            await result$;

        });

        it('should add source_type filter when provided', async () => {
            const result$ = firstValueFrom(service.getTranslations('es', 'ui'));
            const req = httpMock.expectOne(r => r.url.includes('locale=eq.es') && r.url.includes('source_type=eq.ui'));
            expect(req.request.method).toBe('GET');
            req.flush([]);
            await result$;

        });

        it('should return empty array on error', async () => {
            let result: Translation[] = [];
            const result$ = firstValueFrom(service.getTranslations('es'));
            httpMock.expectOne(r => r.url.includes('translations')).error(new ProgressEvent('error'));
            const t = await result$;
            result = t;
            expect(result).toEqual([]);
        });
    });

    describe('getMissingTranslations', () => {
        it('should call get_missing_translations RPC', async () => {
            const result$ = firstValueFrom(service.getMissingTranslations('es'));
            const req = httpMock.expectOne(r => r.url.includes('rpc/get_missing_translations'));
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({ p_target_locale: 'es' });
            req.flush([]);
            await result$;

        });

        it('should return empty array on error', async () => {
            let result: MissingTranslation[] = [];
            const result$ = firstValueFrom(service.getMissingTranslations('es'));
            httpMock.expectOne(r => r.url.includes('rpc/get_missing_translations')).error(new ProgressEvent('error'));
            const m = await result$;
            result = m;
            expect(result).toEqual([]);
        });
    });

    describe('upsertTranslations', () => {
        it('should call upsert_translations RPC with correct payload', async () => {
            const translations = [
                { source_type: 'ui', source_key: 'nav.home', locale: 'es', translated_text: 'Inicio' }
            ];
            const result$ = firstValueFrom(service.upsertTranslations(translations));
            const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_translations'));
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({ p_translations: translations });
            req.flush(null);
            await result$;

        });

        it('should return success response', async () => {
            let response: any;
            const result$ = firstValueFrom(service.upsertTranslations([]));
            httpMock.expectOne(r => r.url.includes('rpc/upsert_translations')).flush(null);
            const r = await result$;
            response = r;
            expect(response.success).toBe(true);
        });

        it('should return error response on failure', async () => {
            let response: any;
            const result$ = firstValueFrom(service.upsertTranslations([]));
            httpMock.expectOne(r => r.url.includes('rpc/upsert_translations')).error(new ProgressEvent('error'));
            const r = await result$;
            response = r;
            expect(response.success).toBe(false);
        });
    });

    describe('getDefaults', () => {
        it('should call get_translation_defaults RPC and return a Map', async () => {
            let result: Map<string, string> | undefined;
            const result$ = firstValueFrom(service.getDefaults());
            const req = httpMock.expectOne(r => r.url.includes('rpc/get_translation_defaults'));
            expect(req.request.method).toBe('POST');
            req.flush([
                { source_type: 'ui', source_key: 'nav.home', default_text: 'Home' },
                { source_type: 'entity', source_key: 'Pot_Hole.display_name', default_text: 'Pot Hole' },
                { source_type: 'dashboard', source_key: 'dashboard.1.display_name', default_text: 'Welcome' }
            ]);
            const m = await result$;
            result = m;
            expect(result!.get('ui:nav.home')).toBe('Home');
            expect(result!.get('entity:Pot_Hole.display_name')).toBe('Pot Hole');
            expect(result!.get('dashboard:dashboard.1.display_name')).toBe('Welcome');
            expect(result!.size).toBe(3);
        });

        it('should filter out null default_text values', async () => {
            let result: Map<string, string> | undefined;
            const result$ = firstValueFrom(service.getDefaults());
            const req = httpMock.expectOne(r => r.url.includes('rpc/get_translation_defaults'));
            req.flush([
                { source_type: 'ui', source_key: 'nav.home', default_text: 'Home' },
                { source_type: 'entity', source_key: 'Issue.description', default_text: null }
            ]);
            const m = await result$;
            result = m;
            expect(result!.size).toBe(1);
            expect(result!.has('entity:Issue.description')).toBe(false);
        });

        it('should return empty Map on error', async () => {
            let result: Map<string, string> | undefined;
            const result$ = firstValueFrom(service.getDefaults());
            httpMock.expectOne(r => r.url.includes('rpc/get_translation_defaults')).error(new ProgressEvent('error'));
            const m = await result$;
            result = m;
            expect(result!.size).toBe(0);
        });
    });

    describe('deleteTranslation', () => {
        it('should call DELETE with correct filter', async () => {
            const result$ = firstValueFrom(service.deleteTranslation(42));
            const req = httpMock.expectOne(r => r.url.includes('translations?id=eq.42'));
            expect(req.request.method).toBe('DELETE');
            expect(req.request.headers.get('Prefer')).toBe('return=minimal');
            req.flush(null);
            await result$;

        });

        it('should return success on delete', async () => {
            let response: any;
            const result$ = firstValueFrom(service.deleteTranslation(1));
            httpMock.expectOne(r => r.url.includes('translations?id=eq.1')).flush(null);
            const r = await result$;
            response = r;
            expect(response.success).toBe(true);
        });

        it('should return error response on failure', async () => {
            let response: any;
            const result$ = firstValueFrom(service.deleteTranslation(1));
            httpMock.expectOne(r => r.url.includes('translations?id=eq.1')).error(new ProgressEvent('error'));
            const r = await result$;
            response = r;
            expect(response.success).toBe(false);
        });
    });
});
