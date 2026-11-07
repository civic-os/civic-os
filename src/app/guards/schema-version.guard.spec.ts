/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { firstValueFrom, Observable, of } from 'rxjs';
import { schemaVersionGuard } from './schema-version.guard';
import { VersionService, CacheUpdateCheck } from '../services/version.service';
import { SchemaService } from '../services/schema.service';
import { ProfileService } from '../services/profile.service';
import { ConfigService } from '../services/config.service';
import { TranslationService } from '../services/translation.service';
import { DashboardService } from '../services/dashboard.service';

describe('schemaVersionGuard', () => {
    let mockVersionService: any;
    let mockSchemaService: any;
    let mockProfileService: any;
    let mockConfigService: any;
    let mockTranslationService: any;
    let mockDashboardService: any;
    let mockRoute: ActivatedRouteSnapshot;
    let mockState: RouterStateSnapshot;

    beforeEach(() => {
        mockVersionService = {
            checkForUpdates: vi.fn().mockName("VersionService.checkForUpdates")
        };
        mockSchemaService = {
            refreshEntitiesCache: vi.fn().mockName("SchemaService.refreshEntitiesCache"),
            refreshPropertiesCache: vi.fn().mockName("SchemaService.refreshPropertiesCache"),
            refreshStatusesCache: vi.fn().mockName("SchemaService.refreshStatusesCache"),
            invalidateCategoryCache: vi.fn().mockName("SchemaService.invalidateCategoryCache"),
            refreshMenuCache: vi.fn().mockName("SchemaService.refreshMenuCache"),
            refreshCache: vi.fn().mockName("SchemaService.refreshCache"),
            invalidateGuidedFormCache: vi.fn().mockName("SchemaService.invalidateGuidedFormCache")
        };
        mockProfileService = {
            invalidateCache: vi.fn().mockName("ProfileService.invalidateCache")
        };

        mockConfigService = {
            invalidateCache: vi.fn().mockName("ConfigService.invalidateCache")
        };

        mockTranslationService = {
            clearCache: vi.fn().mockName("TranslationService.clearCache")
        };

        mockDashboardService = {
            refreshCache: vi.fn().mockName("DashboardService.refreshCache")
        };

        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                { provide: VersionService, useValue: mockVersionService },
                { provide: SchemaService, useValue: mockSchemaService },
                { provide: ProfileService, useValue: mockProfileService },
                { provide: ConfigService, useValue: mockConfigService },
                { provide: TranslationService, useValue: mockTranslationService },
                { provide: DashboardService, useValue: mockDashboardService }
            ]
        });

        mockRoute = {} as ActivatedRouteSnapshot;
        mockState = { url: '/test' } as RouterStateSnapshot;

        // Spy on console.log
        vi.spyOn(console, 'log').mockReturnValue(undefined);
    });

    it('should allow navigation immediately when no changes detected', async () => {
        const noChanges: CacheUpdateCheck = {
            entitiesNeedsRefresh: false,
            propertiesNeedsRefresh: false,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: false,
            instanceConfigNeedsRefresh: false,
            statusesNeedsRefresh: false,
            categoriesNeedsRefresh: false,
            menuNeedsRefresh: false,
            translationsNeedsRefresh: false,
            hasChanges: false
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(noChanges));

        TestBed.runInInjectionContext(() => {
            const result$ = schemaVersionGuard(mockRoute, mockState);

            if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
                (result$ as any).subscribe((result: boolean) => {
                    expect(result).toBe(true);
                    expect(mockSchemaService.refreshEntitiesCache).not.toHaveBeenCalled();
                    expect(mockSchemaService.refreshPropertiesCache).not.toHaveBeenCalled();
                    expect(mockProfileService.invalidateCache).not.toHaveBeenCalled();
                    expect(console.log).not.toHaveBeenCalled();
                });
            }
        });
    });

    it('should refresh entities cache when entities version changed', async () => {
        const entitiesChanged: CacheUpdateCheck = {
            entitiesNeedsRefresh: true,
            propertiesNeedsRefresh: false,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: false,
            instanceConfigNeedsRefresh: false,
            statusesNeedsRefresh: false,
            categoriesNeedsRefresh: false,
            menuNeedsRefresh: false,
            translationsNeedsRefresh: false,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(entitiesChanged));

        TestBed.runInInjectionContext(() => {
            const result$ = schemaVersionGuard(mockRoute, mockState);

            if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
                (result$ as any).subscribe((result: boolean) => {
                    expect(result).toBe(true);
                    expect(mockSchemaService.refreshEntitiesCache).toHaveBeenCalledTimes(1);
                    expect(mockSchemaService.refreshPropertiesCache).not.toHaveBeenCalled();
                    expect(mockProfileService.invalidateCache).not.toHaveBeenCalled();
                });
            }
        });
    });

    it('should refresh properties cache when properties version changed', async () => {
        const propertiesChanged: CacheUpdateCheck = {
            entitiesNeedsRefresh: false,
            propertiesNeedsRefresh: true,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: false,
            instanceConfigNeedsRefresh: false,
            statusesNeedsRefresh: false,
            categoriesNeedsRefresh: false,
            menuNeedsRefresh: false,
            translationsNeedsRefresh: false,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(propertiesChanged));

        TestBed.runInInjectionContext(() => {
            const result$ = schemaVersionGuard(mockRoute, mockState);

            if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
                (result$ as any).subscribe((result: boolean) => {
                    expect(result).toBe(true);
                    expect(mockSchemaService.refreshEntitiesCache).not.toHaveBeenCalled();
                    expect(mockSchemaService.refreshPropertiesCache).toHaveBeenCalledTimes(1);
                    expect(mockProfileService.invalidateCache).not.toHaveBeenCalled();
                });
            }
        });
    });

    it('should refresh both caches when both versions changed', async () => {
        const bothChanged: CacheUpdateCheck = {
            entitiesNeedsRefresh: true,
            propertiesNeedsRefresh: true,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: false,
            instanceConfigNeedsRefresh: false,
            statusesNeedsRefresh: false,
            categoriesNeedsRefresh: false,
            menuNeedsRefresh: false,
            translationsNeedsRefresh: false,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(bothChanged));

        TestBed.runInInjectionContext(() => {
            const result$ = schemaVersionGuard(mockRoute, mockState);

            if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
                (result$ as any).subscribe((result: boolean) => {
                    expect(result).toBe(true);
                    expect(mockSchemaService.refreshEntitiesCache).toHaveBeenCalledTimes(1);
                    expect(mockSchemaService.refreshPropertiesCache).toHaveBeenCalledTimes(1);
                    expect(mockProfileService.invalidateCache).not.toHaveBeenCalled();
                });
            }
        });
    });

    it('should invalidate profile cache when profile extensions version changed', async () => {
        const profileChanged: CacheUpdateCheck = {
            entitiesNeedsRefresh: false,
            propertiesNeedsRefresh: false,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: true,
            instanceConfigNeedsRefresh: false,
            statusesNeedsRefresh: false,
            categoriesNeedsRefresh: false,
            menuNeedsRefresh: false,
            translationsNeedsRefresh: false,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(profileChanged));

        TestBed.runInInjectionContext(() => {
            const result$ = schemaVersionGuard(mockRoute, mockState);

            if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
                (result$ as any).subscribe((result: boolean) => {
                    expect(result).toBe(true);
                    expect(mockSchemaService.refreshEntitiesCache).not.toHaveBeenCalled();
                    expect(mockSchemaService.refreshPropertiesCache).not.toHaveBeenCalled();
                    expect(mockProfileService.invalidateCache).toHaveBeenCalledTimes(1);
                });
            }
        });
    });

    it('should invalidate the config cache only when the instance_config version changed', async () => {
        const configChanged: CacheUpdateCheck = {
            entitiesNeedsRefresh: false,
            propertiesNeedsRefresh: false,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: false,
            instanceConfigNeedsRefresh: true,
            statusesNeedsRefresh: false,
            categoriesNeedsRefresh: false,
            menuNeedsRefresh: false,
            translationsNeedsRefresh: false,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(configChanged));

        TestBed.runInInjectionContext(() => {
            const result$ = schemaVersionGuard(mockRoute, mockState);
            (result$ as any).subscribe((result: boolean) => {
                expect(result).toBe(true);
                expect(mockConfigService.invalidateCache).toHaveBeenCalledTimes(1);
                expect(mockSchemaService.refreshEntitiesCache).not.toHaveBeenCalled();
                expect(mockProfileService.invalidateCache).not.toHaveBeenCalled();
            });
        });
    });

    it('should clear cached statuses when the statuses version changed', async () => {
        const statusesChanged: CacheUpdateCheck = {
            entitiesNeedsRefresh: false,
            propertiesNeedsRefresh: false,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: false,
            instanceConfigNeedsRefresh: false,
            statusesNeedsRefresh: true,
            categoriesNeedsRefresh: false,
            menuNeedsRefresh: false,
            translationsNeedsRefresh: false,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(statusesChanged));

        const result = await TestBed.runInInjectionContext(() =>
            firstValueFrom(schemaVersionGuard(mockRoute, mockState) as Observable<boolean>));

        expect(result).toBe(true);
        expect(mockSchemaService.refreshStatusesCache).toHaveBeenCalledTimes(1);
        expect(mockSchemaService.invalidateCategoryCache).not.toHaveBeenCalled();
    });

    it('should clear cached categories for every type when the categories version changed', async () => {
        const categoriesChanged: CacheUpdateCheck = {
            entitiesNeedsRefresh: false,
            propertiesNeedsRefresh: false,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: false,
            instanceConfigNeedsRefresh: false,
            statusesNeedsRefresh: false,
            categoriesNeedsRefresh: true,
            menuNeedsRefresh: false,
            translationsNeedsRefresh: false,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(categoriesChanged));

        const result = await TestBed.runInInjectionContext(() =>
            firstValueFrom(schemaVersionGuard(mockRoute, mockState) as Observable<boolean>));

        expect(result).toBe(true);
        expect(mockSchemaService.invalidateCategoryCache).toHaveBeenCalledTimes(1);
        expect(mockSchemaService.invalidateCategoryCache).toHaveBeenCalledWith();
        expect(mockSchemaService.refreshStatusesCache).not.toHaveBeenCalled();
    });

    it('should refetch only the menu when the menu version changed', async () => {
        const menuChanged: CacheUpdateCheck = {
            entitiesNeedsRefresh: false,
            propertiesNeedsRefresh: false,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: false,
            instanceConfigNeedsRefresh: false,
            statusesNeedsRefresh: false,
            categoriesNeedsRefresh: false,
            menuNeedsRefresh: true,
            translationsNeedsRefresh: false,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(menuChanged));

        const result = await TestBed.runInInjectionContext(() =>
            firstValueFrom(schemaVersionGuard(mockRoute, mockState) as Observable<boolean>));

        expect(result).toBe(true);
        expect(mockSchemaService.refreshMenuCache).toHaveBeenCalledTimes(1);
        expect(mockSchemaService.refreshEntitiesCache).not.toHaveBeenCalled();
        expect(mockSchemaService.refreshPropertiesCache).not.toHaveBeenCalled();
    });

    it('should drop every translated cache once when the translations version changed', async () => {
        const translationsChanged: CacheUpdateCheck = {
            entitiesNeedsRefresh: true,
            propertiesNeedsRefresh: true,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: false,
            instanceConfigNeedsRefresh: false,
            statusesNeedsRefresh: true,
            categoriesNeedsRefresh: true,
            menuNeedsRefresh: true,
            translationsNeedsRefresh: true,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(translationsChanged));

        const result = await TestBed.runInInjectionContext(() =>
            firstValueFrom(schemaVersionGuard(mockRoute, mockState) as Observable<boolean>));

        expect(result).toBe(true);
        expect(mockTranslationService.clearCache).toHaveBeenCalledTimes(1);
        expect(mockSchemaService.refreshCache).toHaveBeenCalledTimes(1);
        expect(mockSchemaService.invalidateGuidedFormCache).toHaveBeenCalledTimes(1);
        expect(mockDashboardService.refreshCache).toHaveBeenCalledTimes(1);
        // refreshCache() covers these; calling them too would send a second round of requests
        expect(mockSchemaService.refreshEntitiesCache).not.toHaveBeenCalled();
        expect(mockSchemaService.refreshPropertiesCache).not.toHaveBeenCalled();
        expect(mockSchemaService.refreshStatusesCache).not.toHaveBeenCalled();
        expect(mockSchemaService.invalidateCategoryCache).not.toHaveBeenCalled();
        expect(mockSchemaService.refreshMenuCache).not.toHaveBeenCalled();
    });

    it('should still refresh profile extensions and instance config with a translations change', async () => {
        const mixed: CacheUpdateCheck = {
            entitiesNeedsRefresh: false,
            propertiesNeedsRefresh: false,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: true,
            instanceConfigNeedsRefresh: true,
            statusesNeedsRefresh: false,
            categoriesNeedsRefresh: false,
            menuNeedsRefresh: false,
            translationsNeedsRefresh: true,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(mixed));

        await TestBed.runInInjectionContext(() =>
            firstValueFrom(schemaVersionGuard(mockRoute, mockState) as Observable<boolean>));

        expect(mockProfileService.invalidateCache).toHaveBeenCalledTimes(1);
        expect(mockConfigService.invalidateCache).toHaveBeenCalledTimes(1);
        expect(mockSchemaService.refreshCache).toHaveBeenCalledTimes(1);
    });

    it('should not drop translated caches when only the menu changed', async () => {
        const menuOnly: CacheUpdateCheck = {
            entitiesNeedsRefresh: false,
            propertiesNeedsRefresh: false,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: false,
            instanceConfigNeedsRefresh: false,
            statusesNeedsRefresh: false,
            categoriesNeedsRefresh: false,
            menuNeedsRefresh: true,
            translationsNeedsRefresh: false,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(menuOnly));

        await TestBed.runInInjectionContext(() =>
            firstValueFrom(schemaVersionGuard(mockRoute, mockState) as Observable<boolean>));

        expect(mockTranslationService.clearCache).not.toHaveBeenCalled();
        expect(mockSchemaService.refreshCache).not.toHaveBeenCalled();
        expect(mockDashboardService.refreshCache).not.toHaveBeenCalled();
    });

    it('should always return true to allow navigation', async () => {
        const bothChanged: CacheUpdateCheck = {
            entitiesNeedsRefresh: true,
            propertiesNeedsRefresh: true,
            constraintMessagesNeedsRefresh: false,
            profileExtensionsNeedsRefresh: false,
            instanceConfigNeedsRefresh: false,
            statusesNeedsRefresh: false,
            categoriesNeedsRefresh: false,
            menuNeedsRefresh: false,
            translationsNeedsRefresh: false,
            hasChanges: true
        };
        mockVersionService.checkForUpdates.mockReturnValue(of(bothChanged));

        TestBed.runInInjectionContext(() => {
            const result$ = schemaVersionGuard(mockRoute, mockState);

            if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
                (result$ as any).subscribe((result: boolean) => {
                    expect(result).toBe(true);
                });
            }
        });
    });
});
