/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of } from 'rxjs';
import { ProfileService, ProfileExtension, ProfileExtensionMeta } from './profile.service';
import { AuthService } from './auth.service';
import { firstValueFrom } from 'rxjs';
import { awaitRequest } from '../testing/await-http';

describe('ProfileService', () => {
    let service: ProfileService;
    let httpMock: HttpTestingController;
    let mockAuthService: any;

    const mockMetas: ProfileExtensionMeta[] = [
        {
            table_name: 'borrowers',
            sort_order: 1,
            is_required: true,
            display_name: 'Borrower Profile',
            description: 'Library borrower info',
            user_fk_column: 'user_id',
            user_fk_constraint: 'borrowers_user_id_fkey'
        }
    ];

    beforeEach(() => {
        mockAuthService = {
            authenticated: signal(true),
            getCurrentUserId: vi.fn().mockName('getCurrentUserId').mockReturnValue(of('own-user-123')),
            permissionsLoaded: signal(true),
            permissionsCache: signal(new Map())
        };

        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                ProfileService,
                { provide: AuthService, useValue: mockAuthService }
            ]
        });
        service = TestBed.inject(ProfileService);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify();
    });

    describe('getProfileExtensions() — own profile (no userId)', () => {
        it('should fetch metadata from VIEW then check has_record via PostgREST embedding', async () => {
            const result$ = firstValueFrom(service.getProfileExtensions());

            // Step 1: metadata from VIEW
            const metaReq = httpMock.expectOne(r => r.url.includes('user_profile_extensions'));
            expect(metaReq.request.method).toBe('GET');
            metaReq.flush(mockMetas);

            // Step 2: PostgREST embedded query for has_record
            const embedReq = await awaitRequest(httpMock, r => r.url.includes('civic_os_users') &&
                r.url.includes('id=eq.own-user-123') &&
                r.url.includes('borrowers!borrowers_user_id_fkey(id)'));
            expect(embedReq.request.method).toBe('GET');
            embedReq.flush([{ id: 'own-user-123', borrowers: [] }]);
            const extensions = await result$;
            expect(extensions.length).toBe(1);
            expect(extensions[0].table_name).toBe('borrowers');
            expect(extensions[0].has_record).toBe(false);
        });

        it('should detect has_record=true when embedded array has items', async () => {
            const result$ = firstValueFrom(service.getProfileExtensions());

            httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
            (await awaitRequest(httpMock, r => r.url.includes('civic_os_users'))).flush([
                { id: 'own-user-123', borrowers: [{ id: 42 }] }
            ]);
            const extensions = await result$;
            expect(extensions[0].has_record).toBe(true);
        });

        it('should handle one-to-one FK (object instead of array)', async () => {
            const result$ = firstValueFrom(service.getProfileExtensions());

            httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
            (await awaitRequest(httpMock, r => r.url.includes('civic_os_users'))).flush([
                { id: 'own-user-123', borrowers: { id: 42 } }
            ]);
            const extensions = await result$;
            expect(extensions[0].has_record).toBe(true);
        });

        it('should return cached result on second call', async () => {
            // First call — hits HTTP
            const first$ = firstValueFrom(service.getProfileExtensions());
            httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
            (await awaitRequest(httpMock, r => r.url.includes('civic_os_users'))).flush([
                { id: 'own-user-123', borrowers: [] }
            ]);
            await first$;

            // Second call — should return cached result without HTTP
            const second$ = firstValueFrom(service.getProfileExtensions());
            const extensions = await second$;
            expect(extensions.length).toBe(1);
            httpMock.expectNone(r => r.url.includes('user_profile_extensions'));
        });

        it('should return empty array when no extensions configured', async () => {
            const result$ = firstValueFrom(service.getProfileExtensions());

            httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush([]);
            const extensions = await result$;
            expect(extensions).toEqual([]);
        });

        it('should return empty array on metadata fetch error', async () => {
            const result$ = firstValueFrom(service.getProfileExtensions());

            httpMock.expectOne(r => r.url.includes('user_profile_extensions'))
                .flush('error', { status: 500, statusText: 'Server Error' });
            const extensions = await result$;
            expect(extensions).toEqual([]);
        });

        it('should return has_record=false on embedding query error', async () => {
            const result$ = firstValueFrom(service.getProfileExtensions());

            httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
            (await awaitRequest(httpMock, r => r.url.includes('civic_os_users')))
                .flush('error', { status: 500, statusText: 'Server Error' });
            const extensions = await result$;
            expect(extensions.length).toBe(1);
            expect(extensions[0].has_record).toBe(false);
        });
    });

    describe('getProfileExtensions(userId) — other user', () => {
        it('should use provided userId instead of current user', async () => {
            const otherUserId = 'other-user-456';

            const result$ = firstValueFrom(service.getProfileExtensions(otherUserId));

            httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
            const embedReq = await awaitRequest(httpMock, r => r.url.includes('civic_os_users') &&
                r.url.includes(`id=eq.${otherUserId}`));
            embedReq.flush([{ id: otherUserId, borrowers: [{ id: 1 }] }]);
            const extensions = await result$;
            expect(extensions.length).toBe(1);
        });

        it('should not use cache from own profile when querying other user', async () => {
            // First call — own profile
            const first$ = firstValueFrom(service.getProfileExtensions());
            httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
            (await awaitRequest(httpMock, r => r.url.includes('civic_os_users'))).flush([
                { id: 'own-user-123', borrowers: [] }
            ]);
            await first$;

            // Second call — different user should NOT use cache
            const second$ = firstValueFrom(service.getProfileExtensions('other-456'));
            (await awaitRequest(httpMock, r => r.url.includes('user_profile_extensions'))).flush(mockMetas);
            (await awaitRequest(httpMock, r => r.url.includes('id=eq.other-456'))).flush([
                { id: 'other-456', borrowers: [{ id: 1 }] }
            ]);
            const extensions = await second$;
            expect(extensions.length).toBe(1);
            expect(extensions[0].has_record).toBe(true);
        });
    });

    describe('invalidateCache()', () => {
        it('should force fresh HTTP on next call', async () => {
            // First call
            const first$ = firstValueFrom(service.getProfileExtensions());
            httpMock.expectOne(r => r.url.includes('user_profile_extensions')).flush(mockMetas);
            (await awaitRequest(httpMock, r => r.url.includes('civic_os_users'))).flush([
                { id: 'own-user-123', borrowers: [] }
            ]);
            await first$;

            // Invalidate cache
            service.invalidateCache();

            // Next call should hit HTTP again
            const second$ = firstValueFrom(service.getProfileExtensions());
            (await awaitRequest(httpMock, r => r.url.includes('user_profile_extensions'))).flush(mockMetas);
            (await awaitRequest(httpMock, r => r.url.includes('civic_os_users'))).flush([
                { id: 'own-user-123', borrowers: [] }
            ]);
            await second$;
        });

        it('should reset profileComplete flag', () => {
            service.profileComplete = true;
            service.invalidateCache();
            expect(service.profileComplete).toBe(false);
        });
    });

    describe('updateOwnProfile()', () => {
        it('should call RPC with name and phone', async () => {
            const result$ = firstValueFrom(service.updateOwnProfile('John', 'Doe', '555-0100'));

            const req = httpMock.expectOne(r => r.url.includes('rpc/update_own_profile'));
            expect(req.request.method).toBe('POST');
            expect(req.request.body.p_first_name).toBe('John');
            expect(req.request.body.p_last_name).toBe('Doe');
            expect(req.request.body.p_phone).toBe('555-0100');
            req.flush({ success: true, message: 'Profile updated' });
            const result = await result$;
            expect(result.success).toBe(true);
        });

        it('should handle error response', async () => {
            const result$ = firstValueFrom(service.updateOwnProfile('', ''));

            const req = httpMock.expectOne(r => r.url.includes('rpc/update_own_profile'));
            req.flush({ message: 'Validation failed' }, { status: 400, statusText: 'Bad Request' });
            const result = await result$;
            expect(result.success).toBe(false);
        });
    });

    describe('getExtensionRecord()', () => {
        it('should build correct PostgREST URL', async () => {
            const result$ = firstValueFrom(service.getExtensionRecord('borrowers', 'user_id', 'user-123', 'id,name'));

            const req = httpMock.expectOne(r => r.url.includes('borrowers') &&
                r.url.includes('user_id=eq.user-123') &&
                r.url.includes('select=id,name'));
            expect(req.request.method).toBe('GET');
            req.flush([{ id: '1', name: 'Test' }]);
            expect(await result$).toBeDefined();
        });

        it('should use select=* when no fields specified', async () => {
            const result$ = firstValueFrom(service.getExtensionRecord('borrowers', 'user_id', 'user-123'));

            const req = httpMock.expectOne(r => r.url.includes('select=*'));
            req.flush([]);
            expect(await result$).toBeDefined();
        });
    });

    describe('getUserProfileRecord()', () => {
        it('should query civic_os_users VIEW', async () => {
            const result$ = firstValueFrom(service.getUserProfileRecord('target-123'));

            const req = httpMock.expectOne(r => r.url.includes('civic_os_users') &&
                r.url.includes('id=eq.target-123'));
            expect(req.request.method).toBe('GET');
            req.flush([{
                    id: 'target-123',
                    display_name: 'Jane Smith',
                    first_name: 'Jane',
                    last_name: 'Smith',
                    email: 'jane@test.com',
                    phone: '5559876543',
                    locale: 'en'
                }]);
            const result = await result$;
            expect(result).toBeTruthy();
            expect(result!.first_name).toBe('Jane');
            expect(result!.locale).toBe('en');
        });

        it('should return null when user not found', async () => {
            const result$ = firstValueFrom(service.getUserProfileRecord('nonexistent'));

            const req = httpMock.expectOne(r => r.url.includes('civic_os_users'));
            req.flush([]);
            const result = await result$;
            expect(result).toBeNull();
        });

        it('should return null on error', async () => {
            const result$ = firstValueFrom(service.getUserProfileRecord('target-123'));

            const req = httpMock.expectOne(r => r.url.includes('civic_os_users'));
            req.flush('error', { status: 403, statusText: 'Forbidden' });
            const result = await result$;
            expect(result).toBeNull();
        });
    });

    describe('getCurrentUserPrivateRecord()', () => {
        it('should return user record from RPC', async () => {
            const result$ = firstValueFrom(service.getCurrentUserPrivateRecord());

            const req = httpMock.expectOne(r => r.url.includes('rpc/get_own_profile'));
            expect(req.request.method).toBe('POST');
            req.flush({ id: 'user-123', display_name: 'John Doe', first_name: 'John', last_name: 'Doe', email: 'john@test.com', phone: null });
            const result = await result$;
            expect(result).toBeTruthy();
            expect(result!.first_name).toBe('John');
        });

        it('should return null when RPC returns null', async () => {
            const result$ = firstValueFrom(service.getCurrentUserPrivateRecord());

            const req = httpMock.expectOne(r => r.url.includes('rpc/get_own_profile'));
            req.flush(null);
            const result = await result$;
            expect(result).toBeNull();
        });
    });
});
