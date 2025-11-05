/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { of } from 'rxjs';
import { schemaVersionGuard } from './schema-version.guard';
import { VersionService, CacheUpdateCheck } from '../services/version.service';
import { SchemaService } from '../services/schema.service';

describe('schemaVersionGuard', () => {
  let mockVersionService: jasmine.SpyObj<VersionService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockRoute: ActivatedRouteSnapshot;
  let mockState: RouterStateSnapshot;

  beforeEach(() => {
    mockVersionService = jasmine.createSpyObj('VersionService', ['checkForUpdates']);
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['refreshEntitiesCache', 'refreshPropertiesCache']);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: VersionService, useValue: mockVersionService },
        { provide: SchemaService, useValue: mockSchemaService }
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
