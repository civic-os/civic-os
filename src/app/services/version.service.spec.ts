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
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { VersionService, CacheVersion } from './version.service';
import { firstValueFrom } from 'rxjs';

describe('VersionService', () => {
    let service: VersionService;
    let httpMock: HttpTestingController;
    const testPostgrestUrl = 'http://test-api.example.com/';

    const mockVersions: CacheVersion[] = [
        { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'profile_extensions', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'instance_config', version: '2025-01-01T00:00:00Z' }
    ];

    const updatedEntitiesVersion: CacheVersion[] = [
        { cache_name: 'entities', version: '2025-01-02T00:00:00Z' },
        { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'profile_extensions', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'instance_config', version: '2025-01-01T00:00:00Z' }
    ];

    const updatedPropertiesVersion: CacheVersion[] = [
        { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'properties', version: '2025-01-02T00:00:00Z' },
        { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'profile_extensions', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'instance_config', version: '2025-01-01T00:00:00Z' }
    ];

    const updatedBothVersions: CacheVersion[] = [
        { cache_name: 'entities', version: '2025-01-02T00:00:00Z' },
        { cache_name: 'properties', version: '2025-01-02T00:00:00Z' },
        { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'profile_extensions', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'instance_config', version: '2025-01-01T00:00:00Z' }
    ];

    beforeEach(() => {
        // Mock runtime configuration
        (window as any).civicOsConfig = {
            postgrestUrl: testPostgrestUrl
        };

        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                VersionService,
                provideHttpClient(withXhr()),
                provideHttpClientTesting()
            ]
        });
        service = TestBed.inject(VersionService);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify();
        // Clean up mock
        delete (window as any).civicOsConfig;
    });

    it('should be created', () => {
        expect(service).toBeTruthy();
    });

    describe('init()', () => {
        it('should fetch and store versions from database', async () => {
            const result$ = firstValueFrom(service.init());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            expect(req.request.method).toBe('GET');
            req.flush(mockVersions);
            await result$;
            const currentVersions = service.getCurrentVersions();
            expect(currentVersions.entities).toBe('2025-01-01T00:00:00Z');
            expect(currentVersions.properties).toBe('2025-01-01T00:00:00Z');
        });

        it('should initialize with null versions before init', () => {
            const currentVersions = service.getCurrentVersions();
            expect(currentVersions.entities).toBeNull();
            expect(currentVersions.properties).toBeNull();
        });

        it('should handle init with only 2 cache entries (pre-v0.9.0 database)', async () => {
            // Simulate database that doesn't have constraint_messages table yet
            const versionsWithoutConstraintMessages: CacheVersion[] = [
                { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
                { cache_name: 'properties', version: '2025-01-01T00:00:00Z' }
            ];

            const result$ = firstValueFrom(service.init());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(versionsWithoutConstraintMessages);
            await result$;
            const currentVersions = service.getCurrentVersions();
            // Should successfully store the versions that are present
            expect(currentVersions.entities).toBe('2025-01-01T00:00:00Z');
            expect(currentVersions.properties).toBe('2025-01-01T00:00:00Z');
            // constraintMessagesVersion should remain null (graceful degradation)
        });
    });

    describe('checkForUpdates()', () => {
        beforeEach(() => {
            // Initialize service with baseline versions
            service.init().subscribe();
            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(mockVersions);
        });

        it('should detect when entities cache changed', async () => {
            const result$ = firstValueFrom(service.checkForUpdates());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(updatedEntitiesVersion);
            const result = await result$;
            expect(result.entitiesNeedsRefresh).toBe(true);
            expect(result.propertiesNeedsRefresh).toBe(false);
            expect(result.hasChanges).toBe(true);
        });

        it('should detect when properties cache changed', async () => {
            const result$ = firstValueFrom(service.checkForUpdates());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(updatedPropertiesVersion);
            const result = await result$;
            expect(result.entitiesNeedsRefresh).toBe(false);
            expect(result.propertiesNeedsRefresh).toBe(true);
            expect(result.hasChanges).toBe(true);
        });

        it('should detect when both caches changed', async () => {
            const result$ = firstValueFrom(service.checkForUpdates());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(updatedBothVersions);
            const result = await result$;
            expect(result.entitiesNeedsRefresh).toBe(true);
            expect(result.propertiesNeedsRefresh).toBe(true);
            expect(result.hasChanges).toBe(true);
        });

        it('should return no changes when versions are identical', async () => {
            const result$ = firstValueFrom(service.checkForUpdates());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(mockVersions);
            const result = await result$;
            expect(result.entitiesNeedsRefresh).toBe(false);
            expect(result.propertiesNeedsRefresh).toBe(false);
            expect(result.hasChanges).toBe(false);
        });

        it('should update local versions after check', async () => {
            const result$ = firstValueFrom(service.checkForUpdates());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(updatedBothVersions);
            await result$;
            const currentVersions = service.getCurrentVersions();
            expect(currentVersions.entities).toBe('2025-01-02T00:00:00Z');
            expect(currentVersions.properties).toBe('2025-01-02T00:00:00Z');
        });

        it('should handle missing constraint_messages entry (backward compatibility)', async () => {
            // Simulate pre-v0.9.0 database that only returns entities and properties
            const versionsWithoutConstraintMessages: CacheVersion[] = [
                { cache_name: 'entities', version: '2025-01-02T00:00:00Z' },
                { cache_name: 'properties', version: '2025-01-02T00:00:00Z' }
            ];

            const result$ = firstValueFrom(service.checkForUpdates());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(versionsWithoutConstraintMessages);
            const result = await result$;
            // Should detect entities and properties changes, but not fail on missing constraint_messages
            expect(result.entitiesNeedsRefresh).toBe(true);
            expect(result.propertiesNeedsRefresh).toBe(true);
            expect(result.constraintMessagesNeedsRefresh).toBe(false); // Not present, so no refresh
            expect(result.profileExtensionsNeedsRefresh).toBe(false); // Not present, so no refresh
            expect(result.hasChanges).toBe(true);
        });

        it('should detect when only constraint_messages changed', async () => {
            const constraintMessagesChanged: CacheVersion[] = [
                { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
                { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
                { cache_name: 'constraint_messages', version: '2025-01-02T00:00:00Z' },
                { cache_name: 'profile_extensions', version: '2025-01-01T00:00:00Z' },
                { cache_name: 'instance_config', version: '2025-01-01T00:00:00Z' }
            ];

            const result$ = firstValueFrom(service.checkForUpdates());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(constraintMessagesChanged);
            const result = await result$;
            expect(result.entitiesNeedsRefresh).toBe(false);
            expect(result.propertiesNeedsRefresh).toBe(false);
            expect(result.constraintMessagesNeedsRefresh).toBe(true);
            expect(result.profileExtensionsNeedsRefresh).toBe(false);
            expect(result.hasChanges).toBe(true);
        });

        it('should detect when only profile_extensions changed', async () => {
            const profileExtensionsChanged: CacheVersion[] = [
                { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
                { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
                { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' },
                { cache_name: 'profile_extensions', version: '2025-01-02T00:00:00Z' }
            ];

            const result$ = firstValueFrom(service.checkForUpdates());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(profileExtensionsChanged);
            const result = await result$;
            expect(result.entitiesNeedsRefresh).toBe(false);
            expect(result.propertiesNeedsRefresh).toBe(false);
            expect(result.constraintMessagesNeedsRefresh).toBe(false);
            expect(result.profileExtensionsNeedsRefresh).toBe(true);
            expect(result.hasChanges).toBe(true);
        });
    });

    describe('instance_config tracking', () => {
        it('should detect when only instance_config changed', async () => {
            const init$ = firstValueFrom(service.init());
            httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions').flush(mockVersions);
            await init$;

            const changed = mockVersions.map(v =>
                v.cache_name === 'instance_config' ? { ...v, version: '2025-01-02T00:00:00Z' } : v
            );
            const result$ = firstValueFrom(service.checkForUpdates());
            httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions').flush(changed);
            const result = await result$;

            expect(result.instanceConfigNeedsRefresh).toBe(true);
            expect(result.entitiesNeedsRefresh).toBe(false);
            expect(result.profileExtensionsNeedsRefresh).toBe(false);
            expect(result.hasChanges).toBe(true);
        });

        it('should not flag a refresh when the row is absent (older database)', async () => {
            const init$ = firstValueFrom(service.init());
            httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions').flush(mockVersions);
            await init$;

            const result$ = firstValueFrom(service.checkForUpdates());
            httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions')
                .flush(mockVersions.filter(v => v.cache_name !== 'instance_config'));
            const result = await result$;

            expect(result.instanceConfigNeedsRefresh).toBe(false);
            expect(result.hasChanges).toBe(false);
        });
    });

    describe('reset()', () => {
        it('should clear cached versions', async () => {
            // Initialize first
            const result$ = firstValueFrom(service.init());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(mockVersions);
            await result$;
            // Verify versions are set
            let currentVersions = service.getCurrentVersions();
            expect(currentVersions.entities).toBe('2025-01-01T00:00:00Z');
            expect(currentVersions.properties).toBe('2025-01-01T00:00:00Z');

            // Reset
            service.reset();

            // Verify versions are cleared
            currentVersions = service.getCurrentVersions();
            expect(currentVersions.entities).toBeNull();
            expect(currentVersions.properties).toBeNull();
        });
    });

    describe('getCurrentVersions()', () => {
        it('should return null versions before initialization', () => {
            const versions = service.getCurrentVersions();
            expect(versions.entities).toBeNull();
            expect(versions.properties).toBeNull();
        });

        it('should return stored versions after initialization', async () => {
            const result$ = firstValueFrom(service.init());

            const req = httpMock.expectOne(testPostgrestUrl + 'schema_cache_versions');
            req.flush(mockVersions);
            await result$;
            const versions = service.getCurrentVersions();
            expect(versions.entities).toBe('2025-01-01T00:00:00Z');
            expect(versions.properties).toBe('2025-01-01T00:00:00Z');
        });
    });
});
