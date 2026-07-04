/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { of } from 'rxjs';
import { schemaVersionGuard } from './schema-version.guard';
import { VersionService, CacheUpdateCheck } from '../services/version.service';
import { SchemaService } from '../services/schema.service';
import { ProfileService } from '../services/profile.service';

describe('schemaVersionGuard', () => {
  let mockVersionService: jasmine.SpyObj<VersionService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockProfileService: jasmine.SpyObj<ProfileService>;
  let mockRoute: ActivatedRouteSnapshot;
  let mockState: RouterStateSnapshot;

  beforeEach(() => {
    mockVersionService = jasmine.createSpyObj('VersionService', ['checkForUpdates']);
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['refreshEntitiesCache', 'refreshPropertiesCache']);
    mockProfileService = jasmine.createSpyObj('ProfileService', ['invalidateCache']);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: VersionService, useValue: mockVersionService },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: ProfileService, useValue: mockProfileService }
      ]
    });

    mockRoute = {} as ActivatedRouteSnapshot;
    mockState = { url: '/test' } as RouterStateSnapshot;

    // Spy on console.log
    spyOn(console, 'log');
  });

  it('should allow navigation immediately when no changes detected', (done) => {
    const noChanges: CacheUpdateCheck = {
      entitiesNeedsRefresh: false,
      propertiesNeedsRefresh: false,
      constraintMessagesNeedsRefresh: false,
      profileExtensionsNeedsRefresh: false,
      hasChanges: false
    };
    mockVersionService.checkForUpdates.and.returnValue(of(noChanges));

    TestBed.runInInjectionContext(() => {
      const result$ = schemaVersionGuard(mockRoute, mockState);

      if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
        (result$ as any).subscribe((result: boolean) => {
          expect(result).toBe(true);
          expect(mockSchemaService.refreshEntitiesCache).not.toHaveBeenCalled();
          expect(mockSchemaService.refreshPropertiesCache).not.toHaveBeenCalled();
          expect(mockProfileService.invalidateCache).not.toHaveBeenCalled();
          expect(console.log).not.toHaveBeenCalled();
          done();
        });
      }
    });
  });

  it('should refresh entities cache when entities version changed', (done) => {
    const entitiesChanged: CacheUpdateCheck = {
      entitiesNeedsRefresh: true,
      propertiesNeedsRefresh: false,
      constraintMessagesNeedsRefresh: false,
      profileExtensionsNeedsRefresh: false,
      hasChanges: true
    };
    mockVersionService.checkForUpdates.and.returnValue(of(entitiesChanged));

    TestBed.runInInjectionContext(() => {
      const result$ = schemaVersionGuard(mockRoute, mockState);

      if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
        (result$ as any).subscribe((result: boolean) => {
          expect(result).toBe(true);
          expect(mockSchemaService.refreshEntitiesCache).toHaveBeenCalledTimes(1);
          expect(mockSchemaService.refreshPropertiesCache).not.toHaveBeenCalled();
          expect(mockProfileService.invalidateCache).not.toHaveBeenCalled();
          done();
        });
      }
    });
  });

  it('should refresh properties cache when properties version changed', (done) => {
    const propertiesChanged: CacheUpdateCheck = {
      entitiesNeedsRefresh: false,
      propertiesNeedsRefresh: true,
      constraintMessagesNeedsRefresh: false,
      profileExtensionsNeedsRefresh: false,
      hasChanges: true
    };
    mockVersionService.checkForUpdates.and.returnValue(of(propertiesChanged));

    TestBed.runInInjectionContext(() => {
      const result$ = schemaVersionGuard(mockRoute, mockState);

      if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
        (result$ as any).subscribe((result: boolean) => {
          expect(result).toBe(true);
          expect(mockSchemaService.refreshEntitiesCache).not.toHaveBeenCalled();
          expect(mockSchemaService.refreshPropertiesCache).toHaveBeenCalledTimes(1);
          expect(mockProfileService.invalidateCache).not.toHaveBeenCalled();
          done();
        });
      }
    });
  });

  it('should refresh both caches when both versions changed', (done) => {
    const bothChanged: CacheUpdateCheck = {
      entitiesNeedsRefresh: true,
      propertiesNeedsRefresh: true,
      constraintMessagesNeedsRefresh: false,
      profileExtensionsNeedsRefresh: false,
      hasChanges: true
    };
    mockVersionService.checkForUpdates.and.returnValue(of(bothChanged));

    TestBed.runInInjectionContext(() => {
      const result$ = schemaVersionGuard(mockRoute, mockState);

      if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
        (result$ as any).subscribe((result: boolean) => {
          expect(result).toBe(true);
          expect(mockSchemaService.refreshEntitiesCache).toHaveBeenCalledTimes(1);
          expect(mockSchemaService.refreshPropertiesCache).toHaveBeenCalledTimes(1);
          expect(mockProfileService.invalidateCache).not.toHaveBeenCalled();
          done();
        });
      }
    });
  });

  it('should invalidate profile cache when profile extensions version changed', (done) => {
    const profileChanged: CacheUpdateCheck = {
      entitiesNeedsRefresh: false,
      propertiesNeedsRefresh: false,
      constraintMessagesNeedsRefresh: false,
      profileExtensionsNeedsRefresh: true,
      hasChanges: true
    };
    mockVersionService.checkForUpdates.and.returnValue(of(profileChanged));

    TestBed.runInInjectionContext(() => {
      const result$ = schemaVersionGuard(mockRoute, mockState);

      if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
        (result$ as any).subscribe((result: boolean) => {
          expect(result).toBe(true);
          expect(mockSchemaService.refreshEntitiesCache).not.toHaveBeenCalled();
          expect(mockSchemaService.refreshPropertiesCache).not.toHaveBeenCalled();
          expect(mockProfileService.invalidateCache).toHaveBeenCalledTimes(1);
          done();
        });
      }
    });
  });

  it('should always return true to allow navigation', (done) => {
    const bothChanged: CacheUpdateCheck = {
      entitiesNeedsRefresh: true,
      propertiesNeedsRefresh: true,
      constraintMessagesNeedsRefresh: false,
      profileExtensionsNeedsRefresh: false,
      hasChanges: true
    };
    mockVersionService.checkForUpdates.and.returnValue(of(bothChanged));

    TestBed.runInInjectionContext(() => {
      const result$ = schemaVersionGuard(mockRoute, mockState);

      if (result$ instanceof Promise || typeof (result$ as any).subscribe === 'function') {
        (result$ as any).subscribe((result: boolean) => {
          expect(result).toBe(true);
          done();
        });
      }
    });
  });
});
