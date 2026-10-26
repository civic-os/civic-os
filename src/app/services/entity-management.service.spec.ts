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
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { EntityManagementService } from './entity-management.service';
import { firstValueFrom } from 'rxjs';

describe('EntityManagementService', () => {
    let service: EntityManagementService;
    let httpMock: HttpTestingController;
    const testPostgrestUrl = 'http://test-api.example.com/';

    beforeEach(() => {
        // Mock runtime configuration
        (window as any).civicOsConfig = {
            postgrestUrl: testPostgrestUrl
        };

        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                EntityManagementService
            ]
        });
        service = TestBed.inject(EntityManagementService);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify();
        // Clean up mock
        delete (window as any).civicOsConfig;
    });

    describe('Basic Service Setup', () => {
        it('should be created', () => {
            expect(service).toBeTruthy();
        });
    });

    describe('upsertEntityMetadata()', () => {
        it('should call RPC function with correct parameters', async () => {
            const result$ = firstValueFrom(service.upsertEntityMetadata('Issue', 'Issues', 'Track issues', 1));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/upsert_entity_metadata');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({
                p_table_name: 'Issue',
                p_display_name: 'Issues',
                p_description: 'Track issues',
                p_sort_order: 1,
                p_show_map: false,
                p_map_property_name: null,
                p_show_calendar: false,
                p_calendar_property_name: null,
                p_calendar_color_property: null,
                p_enable_notes: false,
                p_supports_recurring: false,
                p_recurring_property_name: null,
                p_show_in_sidebar: true
            });
            req.flush({});
            const response = await result$;
            expect(response.success).toBe(true);
        });

        it('should handle null values', async () => {
            const result$ = firstValueFrom(service.upsertEntityMetadata('Issue', null, null, null));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/upsert_entity_metadata');
            expect(req.request.body).toEqual({
                p_table_name: 'Issue',
                p_display_name: null,
                p_description: null,
                p_sort_order: null,
                p_show_map: false,
                p_map_property_name: null,
                p_show_calendar: false,
                p_calendar_property_name: null,
                p_calendar_color_property: null,
                p_enable_notes: false,
                p_supports_recurring: false,
                p_recurring_property_name: null,
                p_show_in_sidebar: true
            });
            req.flush({});
            const response = await result$;
            expect(response.success).toBe(true);
        });

        it('should handle errors', async () => {
            const result$ = firstValueFrom(service.upsertEntityMetadata('Issue', 'Issues', null, 1));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/upsert_entity_metadata');
            req.flush({ message: 'Admin access required' }, { status: 403, statusText: 'Forbidden' });
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Failed to save entity metadata');
        });
    });

    describe('updateEntitiesOrder()', () => {
        it('should call RPC function for each entity', async () => {
            const entities = [
                { table_name: 'Issue', sort_order: 0 },
                { table_name: 'WorkPackage', sort_order: 1 },
                { table_name: 'Bid', sort_order: 2 }
            ];

            const result$ = firstValueFrom(service.updateEntitiesOrder(entities));

            // Expect 3 separate RPC calls - use match to get all requests
            const requests = httpMock.match(testPostgrestUrl + 'rpc/update_entity_sort_order');
            expect(requests.length).toBe(3);

            expect(requests[0].request.body).toEqual({ p_table_name: 'Issue', p_sort_order: 0 });
            expect(requests[1].request.body).toEqual({ p_table_name: 'WorkPackage', p_sort_order: 1 });
            expect(requests[2].request.body).toEqual({ p_table_name: 'Bid', p_sort_order: 2 });

            requests.forEach(req => req.flush({}));
            const response = await result$;
            expect(response.success).toBe(true);
        });

        it('should handle empty array', async () => {
            const result$ = firstValueFrom(service.updateEntitiesOrder([]));

            httpMock.expectNone(testPostgrestUrl + 'rpc/update_entity_sort_order');
            const response = await result$;
            expect(response.success).toBe(true);
        });

        it('should handle errors', async () => {
            const entities = [{ table_name: 'Issue', sort_order: 0 }];

            const result$ = firstValueFrom(service.updateEntitiesOrder(entities));

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/update_entity_sort_order');
            req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Failed to update entities order');
        });
    });

    describe('isAdmin()', () => {
        it('should call RPC function', async () => {
            const result$ = firstValueFrom(service.isAdmin());

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/is_admin');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({});
            req.flush(true);
            const result = await result$;
            expect(result).toBe(true);
        });

        it('should return false on error', async () => {
            const result$ = firstValueFrom(service.isAdmin());

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/is_admin');
            req.flush({}, { status: 401, statusText: 'Unauthorized' });
            const result = await result$;
            expect(result).toBe(false);
        });
    });
});
