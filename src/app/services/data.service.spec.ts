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
import { firstValueFrom } from 'rxjs';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { DataService } from './data.service';
import { AnalyticsService } from './analytics.service';
import { provideTranslationTesting } from '../testing/translation-testing';

// EWKB test data constants - All using Downtown Flint, MI area coordinates
// Format: [byte order][type][SRID][X coord][Y coord]
// Downtown Flint is at approximately 43.0125° N, -83.6875° W
const EWKB_SAMPLES = {
    // POINT(-83.6875, 43.0125) - Downtown Flint, MI
    downtown_flint: '0101000020e61000000000000000ec54c09a99999999814540',
    // POINT(-83.72646331787111, 43.016069813188494) - Near Flint (high precision)
    flint_high_precision: '0101000020e6100000010000607eee54c0780c5d930e824540',
    // POINT(-83.5, 43.2) - North of Flint
    north_of_flint: '0101000020e61000000000000000e054c09a99999999994540',
    // POINT(-83.8, 42.9) - Southwest of Flint
    southwest_of_flint: '0101000020e61000003333333333f354c03333333333734540',
    // POINT(0, 0) - For edge case testing
    point_zero: '0101000020e610000000000000000000000000000000000000',
    // Invalid: too short
    invalid_short: '01010000',
    // Invalid: LINESTRING type (02) instead of POINT (01)
    invalid_type: '0102000020e61000003333333333f354c03333333333734540',
    // Invalid: big-endian byte order (00) instead of little-endian (01)
    invalid_byte_order: '0001000020e61000003333333333f354c03333333333734540',
};

describe('DataService', () => {
    let service: DataService;
    let httpMock: HttpTestingController;
    let mockAnalytics: any;
    const testPostgrestUrl = 'http://test-api.example.com/';

    beforeEach(() => {
        // Mock AnalyticsService
        mockAnalytics = {
            trackEvent: vi.fn().mockName("AnalyticsService.trackEvent")
        };

        // Mock runtime configuration
        (window as any).civicOsConfig = {
            postgrestUrl: testPostgrestUrl
        };

        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                provideTranslationTesting(),
                { provide: AnalyticsService, useValue: mockAnalytics },
                DataService
            ]
        });
        service = TestBed.inject(DataService);
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

    describe('getInverseRelationshipPreview() - Preview Modes', () => {
        it('should select id,display_name in display_name mode (default)', async () => {
            const result$ = firstValueFrom(service.getInverseRelationshipPreview('WorkPackage', 'issue_id', 7, 5));

            const req = httpMock.expectOne(`${testPostgrestUrl}WorkPackage?issue_id=eq.7&select=id,display_name&limit=5`);
            expect(req.request.headers.get('Prefer')).toBe('count=exact');
            req.flush([{ id: 1, display_name: 'WP 1' }], {
                headers: { 'Content-Range': '0-0/12' }
            });

            const result = await result$;
            expect(result.records.length).toBe(1);
            expect(result.totalCount).toBe(12);
        });

        it('should select only id in id mode (table without display_name)', async () => {
            const result$ = firstValueFrom(service.getInverseRelationshipPreview('step_records', 'parent_id', 7, 5, 'id'));

            const req = httpMock.expectOne(`${testPostgrestUrl}step_records?parent_id=eq.7&select=id&limit=5`);
            req.flush([{ id: 3 }], { headers: { 'Content-Range': '0-0/1' } });

            const result = await result$;
            expect(result.records).toEqual([{ id: 3 } as any]);
            expect(result.totalCount).toBe(1);
        });

        it('should fetch count only in count mode (composite-PK table without id/display_name)', async () => {
            const result$ = firstValueFrom(service.getInverseRelationshipPreview('team_rosters', 'team_id', 7, 5, 'count'));

            // Selects the (known to exist) filter column with limit=0 so no row data
            // is transferred; the count arrives via the Content-Range header.
            const req = httpMock.expectOne(`${testPostgrestUrl}team_rosters?team_id=eq.7&select=team_id&limit=0`);
            expect(req.request.headers.get('Prefer')).toBe('count=exact');
            req.flush([], { headers: { 'Content-Range': '*/9' } });

            const result = await result$;
            expect(result.records).toEqual([]);
            expect(result.totalCount).toBe(9);
        });
    });

    describe('getData() - Query Building', () => {
        it('should construct basic GET request', async () => {
            const mockData = [{ id: 1, name: 'Test', created_at: '', updated_at: '', display_name: 'Test' }];

            const data$ = firstValueFrom(service.getData({ key: 'Issue', fields: [] }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            expect(req.request.method).toBe('GET');
            req.flush(mockData);

            const data = await data$;
            expect(data).toEqual(mockData);
        });

        it('should auto-add id field to select if not present', async () => {
            const result$ = firstValueFrom(service.getData({
                key: 'Issue',
                fields: ['name', 'description']
            }));

            const req = httpMock.expectOne(req => req.url.includes('select=name,description,id'));
            expect(req.request.url).toContain('id');
            req.flush([]);

            await result$;
        });

        it('should not duplicate id field if already present', async () => {
            const result$ = firstValueFrom(service.getData({
                key: 'Issue',
                fields: ['id', 'name']
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            const url = req.request.url;
            const selectParam = url.split('select=')[1];

            // Count occurrences of 'id'
            const idCount = (selectParam?.match(/\bid\b/g) || []).length;
            expect(idCount).toBe(1);

            req.flush([]);

            await result$;
        });

        it('should NOT inject id when isSummaryView is true', async () => {
            const result$ = firstValueFrom(service.getData({
                key: 'issue_status_summary',
                fields: ['display_name', 'issue_count'],
                isSummaryView: true
            }));

            const req = httpMock.expectOne(req => req.url.includes('issue_status_summary'));
            expect(req.request.url).toContain('select=display_name,issue_count');
            expect(req.request.url).not.toContain(',id');
            req.flush([]);

            await result$;
        });

        it('should still inject id when isSummaryView is false', async () => {
            const result$ = firstValueFrom(service.getData({
                key: 'Issue',
                fields: ['name'],
                isSummaryView: false
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            expect(req.request.url).toContain('select=name,id');
            req.flush([]);

            await result$;
        });

        it('should build select parameter with multiple fields', async () => {
            const result$ = firstValueFrom(service.getData({
                key: 'Issue',
                fields: ['name', 'status_id', 'created_at']
            }));

            const req = httpMock.expectOne(req => req.url.includes('select=name,status_id,created_at,id'));
            expect(req.request.url).toContain('select=');
            req.flush([]);

            await result$;
        });

        it('should build order parameter with default ascending direction', async () => {
            const result$ = firstValueFrom(service.getData({
                key: 'Issue',
                fields: [],
                orderField: 'created_at'
            }));

            const req = httpMock.expectOne(req => req.url.includes('order=created_at.asc'));
            expect(req.request.url).toContain('order=created_at.asc');
            req.flush([]);

            await result$;
        });

        it('should build order parameter with descending direction', async () => {
            const result$ = firstValueFrom(service.getData({
                key: 'Issue',
                fields: [],
                orderField: 'created_at',
                orderDirection: 'desc'
            }));

            const req = httpMock.expectOne(req => req.url.includes('order=created_at.desc'));
            expect(req.request.url).toContain('order=created_at.desc');
            req.flush([]);

            await result$;
        });

        it('should build entityId filter', async () => {
            const result$ = firstValueFrom(service.getData({
                key: 'Issue',
                fields: [],
                entityId: '42'
            }));

            const req = httpMock.expectOne(req => req.url.includes('id=eq.42'));
            expect(req.request.url).toContain('id=eq.42');
            req.flush([]);

            await result$;
        });

        it('should combine multiple query parameters', async () => {
            const result$ = firstValueFrom(service.getData({
                key: 'Issue',
                fields: ['name', 'status_id'],
                orderField: 'name',
                orderDirection: 'asc',
                entityId: '10'
            }));

            const req = httpMock.expectOne(req => {
                const url = req.url;
                return url.includes('Issue') &&
                    url.includes('select=name,status_id,id') &&
                    url.includes('order=name.asc') &&
                    url.includes('id=eq.10');
            });

            expect(req.request.url).toContain('&');
            req.flush([]);

            await result$;
        });

        it('should construct correct PostgREST URL', async () => {
            const result$ = firstValueFrom(service.getData({
                key: 'Issue',
                fields: ['name']
            }));

            const req = httpMock.expectOne(req => req.url.startsWith(testPostgrestUrl));
            expect(req.request.url).toContain(testPostgrestUrl);
            req.flush([]);

            await result$;
        });
    });

    describe('getDataPaginated() - Request Construction', () => {
        it('should construct paginated GET request with Range headers', async () => {
            const mockData = [
                { id: 1, name: 'Test 1', created_at: '', updated_at: '', display_name: 'Test 1' },
                { id: 2, name: 'Test 2', created_at: '', updated_at: '', display_name: 'Test 2' }
            ];

            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: ['name'],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            expect(req.request.method).toBe('GET');
            expect(req.request.headers.get('Range-Unit')).toBe('items');
            expect(req.request.headers.get('Range')).toBe('0-24');
            expect(req.request.headers.get('Prefer')).toBe('count=exact');

            req.flush(mockData, {
                headers: { 'Content-Range': '0-1/237' }
            });

            await result$;
        });

        it('should use default pagination when not specified', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: []
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            expect(req.request.headers.get('Range')).toBe('0-24'); // Default: page 1, pageSize 25
            req.flush([], { headers: { 'Content-Range': '0-0/0' } });

            await result$;
        });

        it('should calculate Range header for page 1', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            expect(req.request.headers.get('Range')).toBe('0-24'); // offset 0, end 24
            req.flush([], { headers: { 'Content-Range': '0-24/100' } });

            await result$;
        });

        it('should calculate Range header for page 5', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 5, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            expect(req.request.headers.get('Range')).toBe('100-124'); // offset 100, end 124
            req.flush([], { headers: { 'Content-Range': '100-124/237' } });

            await result$;
        });

        it('should calculate Range header with pageSize 50', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 3, pageSize: 50 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            expect(req.request.headers.get('Range')).toBe('100-149'); // (3-1)*50 = 100, end = 149
            req.flush([], { headers: { 'Content-Range': '100-149/500' } });

            await result$;
        });

        it('should calculate Range header with pageSize 100', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 2, pageSize: 100 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            expect(req.request.headers.get('Range')).toBe('100-199'); // (2-1)*100 = 100, end = 199
            req.flush([], { headers: { 'Content-Range': '100-199/350' } });

            await result$;
        });

        it('should NOT inject id when isSummaryView is true', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'issue_status_summary',
                fields: ['display_name', 'issue_count'],
                isSummaryView: true,
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('issue_status_summary'));
            expect(req.request.url).toContain('select=display_name,issue_count');
            expect(req.request.url).not.toContain(',id');
            req.flush([], { headers: { 'Content-Range': '0-0/3' } });

            await result$;
        });
    });

    describe('getDataPaginated() - Content-Range Parsing', () => {
        it('should parse Content-Range header correctly', async () => {
            const mockData = [{ id: 1, name: 'Test', created_at: '', updated_at: '', display_name: 'Test' }];

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(mockData, {
                headers: { 'Content-Range': '0-24/237' }
            });

            const response = await response$;
            expect(response.data).toEqual(mockData);
            expect(response.totalCount).toBe(237);
        });

        it('should parse Content-Range with single result', async () => {
            const mockData = [{ id: 5, name: 'Single' }];

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(mockData, {
                headers: { 'Content-Range': '0-0/1' }
            });

            const response = await response$;
            expect(response.totalCount).toBe(1);
        });

        it('should parse Content-Range for middle page', async () => {
            const mockData = Array(25).fill(null).map((_, i) => ({ id: i + 101, name: `Test ${i}` }));

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 5, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(mockData, {
                headers: { 'Content-Range': '100-124/10000' }
            });

            const response = await response$;
            expect(response.totalCount).toBe(10000);
        });

        it('should parse Content-Range for last partial page', async () => {
            const mockData = Array(12).fill(null).map((_, i) => ({ id: i + 226, name: `Test ${i}` }));

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 10, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(mockData, {
                headers: { 'Content-Range': '225-236/237' }
            });

            const response = await response$;
            expect(response.data.length).toBe(12);
            expect(response.totalCount).toBe(237);
        });

        it('should handle missing Content-Range header', async () => {
            const mockData = [{ id: 1, name: 'Test' }];

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(mockData); // No Content-Range header

            const response = await response$;
            expect(response.totalCount).toBe(1); // Fallback to data.length
        });

        it('should handle Content-Range with wildcard total (*)', async () => {
            const mockData = [{ id: 1, name: 'Test' }];

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(mockData, {
                headers: { 'Content-Range': '0-0/*' }
            });

            const response = await response$;
            expect(response.totalCount).toBe(1); // Fallback to data.length when wildcard
        });

        it('should handle empty results', async () => {
            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush([], {
                headers: { 'Content-Range': '0-0/0' }
            });

            const response = await response$;
            expect(response.data).toEqual([]);
            expect(response.totalCount).toBe(0);
        });
    });

    describe('getDataPaginated() - Query Integration', () => {
        it('should combine pagination with select fields', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: ['name', 'status_id', 'created_at'],
                pagination: { page: 2, pageSize: 50 }
            }));

            const req = httpMock.expectOne(req => {
                const url = req.url;
                return url.includes('select=name,status_id,created_at,id') &&
                    req.headers.get('Range') === '50-99';
            });
            expect(req.request.url).toContain('select=');
            req.flush([], { headers: { 'Content-Range': '50-99/237' } });

            await result$;
        });

        it('should combine pagination with order parameters', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                orderField: 'created_at',
                orderDirection: 'desc',
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => {
                const url = req.url;
                return url.includes('order=created_at.desc') &&
                    req.headers.get('Range') === '0-24';
            });
            expect(req.request.url).toContain('order=created_at.desc');
            req.flush([], { headers: { 'Content-Range': '0-24/100' } });

            await result$;
        });

        it('should combine pagination with entityId filter', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                entityId: '42',
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => {
                const url = req.url;
                return url.includes('id=eq.42') &&
                    req.headers.get('Range') === '0-24';
            });
            expect(req.request.url).toContain('id=eq.42');
            req.flush([], { headers: { 'Content-Range': '0-0/1' } });

            await result$;
        });

        it('should combine pagination with search query', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                searchQuery: 'test search',
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => {
                const url = req.url;
                return url.includes('civic_os_text_search=') &&
                    req.headers.get('Range') === '0-24';
            });
            expect(req.request.url).toContain('civic_os_text_search=');
            req.flush([], { headers: { 'Content-Range': '0-10/11' } });

            await result$;
        });

        it('should combine pagination with filters', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                filters: [
                    { column: 'status_id', operator: 'eq', value: '2' }
                ],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => {
                const url = req.url;
                return url.includes('status_id=eq.2') &&
                    req.headers.get('Range') === '0-24';
            });
            expect(req.request.url).toContain('status_id=eq.2');
            req.flush([], { headers: { 'Content-Range': '0-15/16' } });

            await result$;
        });

        it('should combine all query parameters with pagination', async () => {
            const result$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: ['name', 'status_id'],
                searchQuery: 'pothole',
                filters: [
                    { column: 'status_id', operator: 'eq', value: '1' }
                ],
                pagination: { page: 3, pageSize: 50 }
            }));

            const req = httpMock.expectOne(req => {
                const url = req.url;
                return url.includes('Issue') &&
                    url.includes('select=name,status_id,id') &&
                    url.includes('civic_os_text_search=') &&
                    url.includes('status_id=eq.1') &&
                    req.headers.get('Range') === '100-149';
            });

            expect(req.request.url).toContain('&');
            req.flush([], { headers: { 'Content-Range': '100-125/126' } });

            await result$;
        });
    });

    describe('getDataPaginated() - Response Structure', () => {
        it('should return PaginatedResponse with data and totalCount', async () => {
            const mockData = [
                { id: 1, name: 'Test 1' },
                { id: 2, name: 'Test 2' }
            ];

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(mockData, {
                headers: { 'Content-Range': '0-1/237' }
            });

            const response = await response$;
            expect(response).toBeDefined();
            expect(response.data).toBeDefined();
            expect(response.totalCount).toBeDefined();
            expect(Array.isArray(response.data)).toBe(true);
            expect(typeof response.totalCount).toBe('number');
        });

        it('should preserve data array structure', async () => {
            const mockData = [
                { id: 1, name: 'Test 1', status_id: 2, created_at: '2024-01-01', updated_at: '2024-01-01', display_name: 'Test 1' },
                { id: 2, name: 'Test 2', status_id: 3, created_at: '2024-01-02', updated_at: '2024-01-02', display_name: 'Test 2' }
            ];

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: ['name', 'status_id', 'created_at'],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(mockData, {
                headers: { 'Content-Range': '0-1/2' }
            });

            const response = await response$;
            expect(response.data).toEqual(mockData);
            expect(response.data.length).toBe(2);
            expect((response.data[0] as any).name).toBe('Test 1');
        });
    });

    describe('getDataPaginated() - Error Handling', () => {
        it('should handle HTTP errors gracefully', async () => {
            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush({ message: 'Internal server error' }, { status: 500, statusText: 'Internal Server Error' });

            const response = await response$;
            expect(response.data).toEqual([]);
            expect(response.totalCount).toBe(0);
        });

        it('should handle network errors', async () => {
            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.error(new ProgressEvent('Network error'), { status: 0 });

            const response = await response$;
            expect(response.data).toEqual([]);
            expect(response.totalCount).toBe(0);
        });

        it('should handle permission errors', async () => {
            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush({ message: 'permission denied for table Issue', code: '42501' }, { status: 403, statusText: 'Forbidden' });

            const response = await response$;
            expect(response.data).toEqual([]);
            expect(response.totalCount).toBe(0);
        });

        it('should handle null response body', async () => {
            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(null, {
                headers: { 'Content-Range': '0-0/0' }
            });

            const response = await response$;
            expect(response.data).toEqual([]);
            expect(response.totalCount).toBe(0);
        });
    });

    describe('getDataPaginated() - Edge Cases', () => {
        it('should handle page beyond available data', async () => {
            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 100, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            expect(req.request.headers.get('Range')).toBe('2475-2499'); // (100-1)*25 = 2475
            req.flush([], {
                headers: { 'Content-Range': '*/237' } // PostgREST format for out-of-range
            });

            const response = await response$;
            expect(response.data).toEqual([]);
            expect(response.totalCount).toBe(237);
        });

        it('should handle very large page sizes', async () => {
            const mockData = Array(200).fill(null).map((_, i) => ({ id: i + 1, name: `Test ${i}` }));

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 200 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            expect(req.request.headers.get('Range')).toBe('0-199');
            req.flush(mockData, {
                headers: { 'Content-Range': '0-199/237' }
            });

            const response = await response$;
            expect(response.data.length).toBe(200);
            expect(response.totalCount).toBe(237);
        });

        it('should handle page size 10 (minimum)', async () => {
            const mockData = Array(10).fill(null).map((_, i) => ({ id: i + 1, name: `Test ${i}` }));

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 10 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            expect(req.request.headers.get('Range')).toBe('0-9');
            req.flush(mockData, {
                headers: { 'Content-Range': '0-9/237' }
            });

            const response = await response$;
            expect(response.data.length).toBe(10);
        });

        it('should handle single record total', async () => {
            const mockData = [{ id: 1, name: 'Only One' }];

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(mockData, {
                headers: { 'Content-Range': '0-0/1' }
            });

            const response = await response$;
            expect(response.data.length).toBe(1);
            expect(response.totalCount).toBe(1);
        });

        it('should handle large datasets (10000+ records)', async () => {
            const mockData = Array(25).fill(null).map((_, i) => ({ id: i + 1, name: `Test ${i}` }));

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(mockData, {
                headers: { 'Content-Range': '0-24/10537' }
            });

            const response = await response$;
            expect(response.totalCount).toBe(10537);
        });

        it('should handle malformed Content-Range header gracefully', async () => {
            const mockData = [{ id: 1, name: 'Test' }];

            const response$ = firstValueFrom(service.getDataPaginated({
                key: 'Issue',
                fields: [],
                pagination: { page: 1, pageSize: 25 }
            }));

            const req = httpMock.expectOne(req => req.url.includes('Issue'));
            req.flush(mockData, {
                headers: { 'Content-Range': 'invalid-format' }
            });

            const response = await response$;
            expect(response.totalCount).toBe(1); // Fallback to data.length
        });
    });

    describe('createData()', () => {
        it('should POST data to correct endpoint', async () => {
            const newData = { name: 'New Issue', status_id: 1 };
            const createdData = { id: 1, ...newData };

            const response$ = firstValueFrom(service.createData('Issue', newData));

            const req = httpMock.expectOne(testPostgrestUrl + 'Issue');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual(newData);
            expect(req.request.headers.get('Prefer')).toBe('return=representation');
            req.flush(createdData);

            const response = await response$;
            expect(response.success).toBe(true);
            expect(response.body).toEqual(createdData);
        });

        it('should handle successful creation', async () => {
            const newData = { name: 'Test' };

            const response$ = firstValueFrom(service.createData('Issue', newData));

            const req = httpMock.expectOne(testPostgrestUrl + 'Issue');
            req.flush({ id: 1, name: 'Test' });

            const response = await response$;
            expect(response.success).toBe(true);
            expect(response.error).toBeUndefined();
        });

        it('should handle API errors', async () => {
            const newData = { name: 'Test' };
            const errorResponse = {
                message: 'Duplicate key violation',
                details: 'Key (name)=(Test) already exists',
                hint: null,
                code: '23505'
            };

            const response$ = firstValueFrom(service.createData('Issue', newData));

            const req = httpMock.expectOne(testPostgrestUrl + 'Issue');
            req.flush(errorResponse, { status: 409, statusText: 'Conflict' });

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error).toBeDefined();
            expect(response.error?.message).toBe('Duplicate key violation');
        });
    });

    describe('editData()', () => {
        it('should PATCH data to correct endpoint with id filter', async () => {
            const updatedData = { name: 'Updated Issue' };
            const returnedData = { id: 1, name: 'Updated Issue', status_id: 2 };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            expect(req.request.method).toBe('PATCH');
            expect(req.request.body).toEqual(updatedData);
            expect(req.request.headers.get('Prefer')).toBe('return=representation');
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should handle string IDs', async () => {
            const updatedData = { name: 'Updated' };

            const response$ = firstValueFrom(service.editData('Issue', 'abc-123', updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.abc-123'));
            expect(req.request.method).toBe('PATCH');
            expect(req.request.url).toContain('id=eq.abc-123');
            req.flush([{ id: 'abc-123', name: 'Updated' }]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should validate update success by comparing returned data', async () => {
            const updatedData = { name: 'Updated Name', status_id: 3 };
            const returnedData = { id: 1, name: 'Updated Name', status_id: 3 };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
            expect(response.error).toBeUndefined();
        });

        it('should detect failed update when returned data does not match', async () => {
            const updatedData = { name: 'New Name' };
            const returnedData = { id: 1, name: 'Old Name' }; // Different from input

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error).toBeDefined();
            expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        });

        it('should handle empty response as failure', async () => {
            const updatedData = { name: 'Test' };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([]); // Empty array indicates no rows updated

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        });

        it('should handle HTTP errors', async () => {
            const updatedData = { name: 'Test' };
            const errorResponse = {
                message: 'permission denied for table Issue',
                code: '42501'
            };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush(errorResponse, { status: 403, statusText: 'Forbidden' });

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error).toBeDefined();
        });
    });

    describe('deleteData()', () => {
        it('should DELETE record with id filter', async () => {
            const response$ = firstValueFrom(service.deleteData('Issue', 5));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.5'));
            expect(req.request.method).toBe('DELETE');
            req.flush({});

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should handle string IDs', async () => {
            const response$ = firstValueFrom(service.deleteData('Issue', 'abc-123'));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.abc-123'));
            expect(req.request.method).toBe('DELETE');
            expect(req.request.url).toContain('id=eq.abc-123');
            req.flush({});

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should handle successful deletion', async () => {
            const response$ = firstValueFrom(service.deleteData('Issue', 1));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush({});

            const response = await response$;
            expect(response.success).toBe(true);
            expect(response.error).toBeUndefined();
        });

        it('should handle foreign key constraint errors', async () => {
            const errorResponse = {
                message: 'update or delete on table "Issue" violates foreign key constraint',
                details: 'Key (id)=(5) is still referenced from table "comments"',
                hint: 'Delete the referencing rows first',
                code: '23503'
            };

            const response$ = firstValueFrom(service.deleteData('Issue', 5));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.5'));
            req.flush(errorResponse, { status: 409, statusText: 'Conflict' });

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error).toBeDefined();
            expect(response.error?.code).toBe('23503');
        });

        it('should handle permission errors', async () => {
            const errorResponse = {
                message: 'permission denied for table Issue',
                code: '42501'
            };

            const response$ = firstValueFrom(service.deleteData('Issue', 1));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush(errorResponse, { status: 403, statusText: 'Forbidden' });

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error).toBeDefined();
        });

        it('should handle record not found (returns success per PostgREST behavior)', async () => {
            const response$ = firstValueFrom(service.deleteData('Issue', 999));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.999'));
            req.flush({}, { status: 200, statusText: 'OK' });

            const response = await response$;
            // PostgREST returns 200 even if no rows deleted, which is standard REST behavior
            expect(response.success).toBe(true);
        });

        it('should handle network errors', async () => {
            const response$ = firstValueFrom(service.deleteData('Issue', 1));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.error(new ProgressEvent('Network error'), { status: 0 });

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error).toBeDefined();
            expect(response.error?.httpCode).toBe(0);
        });
    });

    describe('refreshCurrentUser()', () => {
        it('should call RPC function', async () => {
            const response$ = firstValueFrom(service.refreshCurrentUser());

            const req = httpMock.expectOne(req => req.url.includes('rpc/refresh_current_user'));
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({});
            req.flush({ success: true });

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should handle RPC errors', async () => {
            const response$ = firstValueFrom(service.refreshCurrentUser());

            const req = httpMock.expectOne(req => req.url.includes('rpc/refresh_current_user'));
            req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });

            const response = await response$;
            expect(response.success).toBe(false);
        });
    });

    describe('Error Handling', () => {
        it('should handle network errors gracefully', async () => {
            const newData = { name: 'Test' };

            const response$ = firstValueFrom(service.createData('Issue', newData));

            const req = httpMock.expectOne(testPostgrestUrl + 'Issue');
            req.error(new ProgressEvent('Network error'), { status: 0 });

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error).toBeDefined();
            expect(response.error?.httpCode).toBe(0);
        });
    });

    describe('Edit Data Validation - FK Fields', () => {
        it('should validate FK field returned as embedded object (match)', async () => {
            const updatedData = { status_id: 3 };
            const returnedData = { id: 1, status_id: { id: 3, display_name: 'Open' } };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
            expect(response.error).toBeUndefined();
        });

        it('should detect FK field mismatch with embedded object', async () => {
            const updatedData = { status_id: 3 };
            const returnedData = { id: 1, status_id: { id: 5, display_name: 'Closed' } };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error).toBeDefined();
            expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        });

        it('should handle null FK values', async () => {
            const updatedData = { status_id: null };
            const returnedData = { id: 1, status_id: null };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should validate mixed FK and primitive fields', async () => {
            const updatedData = { status_id: 2, name: 'Big hole' };
            const returnedData = {
                id: 1,
                status_id: { id: 2, display_name: 'In Progress' },
                name: 'Big hole'
            };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });
    });

    describe('Edit Data Validation - Type Coercion', () => {
        it('should match string vs number with type coercion', async () => {
            const updatedData = { status_id: '4' };
            const returnedData = { id: 1, status_id: 4 };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should match number vs string with type coercion', async () => {
            const updatedData = { status_id: 4 };
            const returnedData = { id: 1, status_id: '4' };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should coerce string ID in FK embedded object', async () => {
            const updatedData = { status_id: 'abc-123' };
            const returnedData = { id: 1, status_id: { id: 'abc-123', display_name: 'Custom' } };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should handle boolean type coercion (1 vs true)', async () => {
            const updatedData = { active: 1 };
            const returnedData = { id: 1, active: true };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });
    });

    describe('Edit Data Validation - Geography Fields', () => {
        it('should validate EWKT input vs EWKB response (match)', async () => {
            const updatedData = { location: 'SRID=4326;POINT(-83.6875 43.0125)' };
            const returnedData = { id: 1, location: EWKB_SAMPLES.downtown_flint };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should validate WKT input without SRID', async () => {
            const updatedData = { location: 'POINT(-83.6875 43.0125)' };
            const returnedData = { id: 1, location: EWKB_SAMPLES.downtown_flint };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should validate high precision coordinates', async () => {
            const updatedData = { location: 'SRID=4326;POINT(-83.72646331787111 43.016069813188494)' };
            const returnedData = { id: 1, location: EWKB_SAMPLES.flint_high_precision };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should validate negative coordinates', async () => {
            const updatedData = { location: 'POINT(-83.5 43.2)' };
            const returnedData = { id: 1, location: EWKB_SAMPLES.north_of_flint };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should detect geography coordinate mismatch', async () => {
            const updatedData = { location: 'POINT(-83.6875 43.0125)' };
            const returnedData = { id: 1, location: EWKB_SAMPLES.north_of_flint }; // Different coords

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        });

        it('should fallback on non-Point geometry (unsupported)', async () => {
            const updatedData = { location: 'LINESTRING(-83 43, -84 44)' };
            const returnedData = { id: 1, location: EWKB_SAMPLES.invalid_type };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true); // Fallback for unsupported types
        });

        it('should detect mismatch when response format is invalid (too short)', async () => {
            const updatedData = { location: 'POINT(-83.6875 43.0125)' };
            const returnedData = { id: 1, location: EWKB_SAMPLES.invalid_short };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(false); // Not detected as EWKB, compared as string
            expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        });

        it('should detect mismatch when response has wrong byte order', async () => {
            const updatedData = { location: 'POINT(-83.6875 43.0125)' };
            const returnedData = { id: 1, location: EWKB_SAMPLES.invalid_byte_order };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(false); // Not detected as EWKB, compared as string
            expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        });

        it('should not treat string field as geography', async () => {
            const updatedData = { name: 'POINT(-83 43)' };
            const returnedData = { id: 1, name: 'POINT(-83 43)' };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should handle null geography values', async () => {
            const updatedData = { location: null };
            const returnedData = { id: 1, location: null };

            const response$ = firstValueFrom(service.editData('Issue', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });
    });

    describe('Edit Data Validation - Color Fields', () => {
        it('should validate color with case-insensitive comparison (lowercase input, uppercase response)', async () => {
            const updatedData = { color: '#3b82f6' };
            const returnedData = { id: 1, color: '#3B82F6' };

            const response$ = firstValueFrom(service.editData('tags', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should validate color with case-insensitive comparison (uppercase input, lowercase response)', async () => {
            const updatedData = { color: '#FF5733' };
            const returnedData = { id: 1, color: '#ff5733' };

            const response$ = firstValueFrom(service.editData('tags', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should validate color with mixed case (input and response differ in case)', async () => {
            const updatedData = { color: '#aAbBcC' };
            const returnedData = { id: 1, color: '#AABBCC' };

            const response$ = firstValueFrom(service.editData('tags', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should detect color value mismatch (different colors)', async () => {
            const updatedData = { color: '#3b82f6' };
            const returnedData = { id: 1, color: '#FF0000' }; // Different color

            const response$ = firstValueFrom(service.editData('tags', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error).toBeDefined();
            expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        });

        it('should handle null color values', async () => {
            const updatedData = { color: null };
            const returnedData = { id: 1, color: null };

            const response$ = firstValueFrom(service.editData('tags', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should not treat non-hex-color strings as colors', async () => {
            const updatedData = { name: '#NOTCOLOR' }; // Not a valid hex color
            const returnedData = { id: 1, name: '#NOTCOLOR' };

            const response$ = firstValueFrom(service.editData('tags', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should validate valid 6-digit hex colors only', async () => {
            const updatedData = { color: '#123' }; // Too short
            const returnedData = { id: 1, color: '#123456' };

            const response$ = firstValueFrom(service.editData('tags', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(false); // Mismatch because #123 is not valid format
        });

        it('should validate hex colors with all same digits', async () => {
            const updatedData = { color: '#ffffff' };
            const returnedData = { id: 1, color: '#FFFFFF' };

            const response$ = firstValueFrom(service.editData('tags', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should validate hex colors with all zeros', async () => {
            const updatedData = { color: '#000000' };
            const returnedData = { id: 1, color: '#000000' };

            const response$ = firstValueFrom(service.editData('tags', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should combine color validation with other fields', async () => {
            const updatedData = { color: '#3b82f6', display_name: 'Blue Tag' };
            const returnedData = { id: 1, color: '#3B82F6', display_name: 'Blue Tag' };

            const response$ = firstValueFrom(service.editData('tags', 1, updatedData));

            const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
            req.flush([returnedData]);

            const response = await response$;
            expect(response.success).toBe(true);
        });
    });

    describe('compareColorValues() - Direct Method Tests', () => {
        it('should return isColor=true and matches=true for case-insensitive match', () => {
            const result = (service as any).compareColorValues('#3b82f6', '#3B82F6');
            expect(result.isColor).toBe(true);
            expect(result.matches).toBe(true);
        });

        it('should return isColor=true and matches=false for different colors', () => {
            const result = (service as any).compareColorValues('#3b82f6', '#FF0000');
            expect(result.isColor).toBe(true);
            expect(result.matches).toBe(false);
        });

        it('should return isColor=false for non-string input value', () => {
            const result = (service as any).compareColorValues(123, '#3B82F6');
            expect(result.isColor).toBe(false);
            expect(result.matches).toBe(false);
        });

        it('should return isColor=false for non-string response value', () => {
            const result = (service as any).compareColorValues('#3b82f6', 456);
            expect(result.isColor).toBe(false);
            expect(result.matches).toBe(false);
        });

        it('should return isColor=false for invalid hex format (too short)', () => {
            const result = (service as any).compareColorValues('#123', '#123456');
            expect(result.isColor).toBe(false);
        });

        it('should return isColor=false for invalid hex format (too long)', () => {
            const result = (service as any).compareColorValues('#1234567', '#123456');
            expect(result.isColor).toBe(false);
        });

        it('should return isColor=false for invalid hex format (missing #)', () => {
            const result = (service as any).compareColorValues('3b82f6', '#3B82F6');
            expect(result.isColor).toBe(false);
        });

        it('should return isColor=false for invalid hex characters', () => {
            const result = (service as any).compareColorValues('#GGGGGG', '#3B82F6');
            expect(result.isColor).toBe(false);
        });

        it('should handle uppercase hex colors', () => {
            const result = (service as any).compareColorValues('#ABCDEF', '#abcdef');
            expect(result.isColor).toBe(true);
            expect(result.matches).toBe(true);
        });

        it('should handle lowercase hex colors', () => {
            const result = (service as any).compareColorValues('#abcdef', '#abcdef');
            expect(result.isColor).toBe(true);
            expect(result.matches).toBe(true);
        });

        it('should handle mixed case hex colors', () => {
            const result = (service as any).compareColorValues('#AbCdEf', '#aBcDeF');
            expect(result.isColor).toBe(true);
            expect(result.matches).toBe(true);
        });
    });

    describe('compareDateValues() - Date-only field comparison', () => {
        // PostgreSQL 'date' columns return ISO 8601 datetime strings via JSON serialization,
        // but HTML date inputs submit YYYY-MM-DD format

        it('should match date-only input with datetime response (same date)', () => {
            // Input: HTML date input format
            // Response: PostgreSQL JSON serialization adds time component (midnight in server TZ)
            const result = (service as any).compareDateValues('2025-01-15', '2025-01-15T05:00:00.000Z');
            expect(result.isDate).toBe(true);
            expect(result.matches).toBe(true);
        });

        it('should not match when dates differ', () => {
            const result = (service as any).compareDateValues('2025-01-15', '2025-01-16T05:00:00.000Z');
            expect(result.isDate).toBe(true);
            expect(result.matches).toBe(false);
        });

        it('should match date-only input with date-only response', () => {
            const result = (service as any).compareDateValues('2025-01-15', '2025-01-15');
            expect(result.isDate).toBe(true);
            expect(result.matches).toBe(true);
        });

        it('should handle different timezone offsets in response', () => {
            // PostgreSQL might return different timezone formats
            const result = (service as any).compareDateValues('2025-01-15', '2025-01-15T00:00:00+00:00');
            expect(result.isDate).toBe(true);
            expect(result.matches).toBe(true);
        });

        it('should handle datetime with space separator', () => {
            // Some PostgreSQL JSON encoders use space instead of T
            const result = (service as any).compareDateValues('2025-01-15', '2025-01-15 00:00:00+00');
            expect(result.isDate).toBe(true);
            expect(result.matches).toBe(true);
        });

        it('should return isDate=false for non-string input', () => {
            const result = (service as any).compareDateValues(20250115, '2025-01-15T05:00:00.000Z');
            expect(result.isDate).toBe(false);
        });

        it('should return isDate=false for non-string response', () => {
            const result = (service as any).compareDateValues('2025-01-15', 20250115);
            expect(result.isDate).toBe(false);
        });

        it('should return isDate=false if input is not date-only format', () => {
            // DateTime format has time component - not handled by compareDateValues
            const result = (service as any).compareDateValues('2025-01-15T10:30:00', '2025-01-15T05:00:00.000Z');
            expect(result.isDate).toBe(false);
        });

        it('should return isDate=false for invalid date format', () => {
            const result = (service as any).compareDateValues('01-15-2025', '2025-01-15T05:00:00.000Z');
            expect(result.isDate).toBe(false);
        });

        it('should return isDate=false for partial date string', () => {
            const result = (service as any).compareDateValues('2025-01', '2025-01-15T05:00:00.000Z');
            expect(result.isDate).toBe(false);
        });
    });

    describe('EWKB Parsing Logic', () => {
        it('should parse valid EWKB Point (Downtown Flint)', () => {
            const result = (service as any).parseEWKBPoint(EWKB_SAMPLES.downtown_flint);
            expect(result).toBeTruthy();
            expect(result).toContain('SRID=4326');
            expect(result).toContain('POINT');
            expect(result).toContain('-83.6875');
            expect(result).toContain('43.0125');
        });

        it('should parse high precision coordinates', () => {
            const result = (service as any).parseEWKBPoint(EWKB_SAMPLES.flint_high_precision);
            expect(result).toBeTruthy();
            expect(result).toContain('SRID=4326');
            expect(result).toContain('-83.72646331787111');
            expect(result).toContain('43.016069813188494');
        });

        it('should parse POINT(0, 0)', () => {
            const result = (service as any).parseEWKBPoint(EWKB_SAMPLES.point_zero);
            expect(result).toBeTruthy();
            expect(result).toContain('POINT(0 0)');
        });

        it('should return null for too short EWKB', () => {
            const result = (service as any).parseEWKBPoint(EWKB_SAMPLES.invalid_short);
            expect(result).toBeNull();
        });

        it('should return null for wrong geometry type (LINESTRING)', () => {
            const result = (service as any).parseEWKBPoint(EWKB_SAMPLES.invalid_type);
            expect(result).toBeNull();
        });

        it('should return null for wrong byte order', () => {
            const result = (service as any).parseEWKBPoint(EWKB_SAMPLES.invalid_byte_order);
            expect(result).toBeNull();
        });

        it('should handle invalid hex characters gracefully', () => {
            const result = (service as any).parseEWKBPoint('01GGGG0020E610000000000000000000');
            expect(result).toBeNull();
        });
    });

    describe('Many-to-Many Relationships', () => {
        describe('addManyToManyRelation()', () => {
            it('should POST junction record with correct columns', async () => {
                const meta = {
                    junctionTable: 'issue_tags',
                    sourceColumn: 'issue_id',
                    targetColumn: 'tag_id',
                    sourceTable: 'Issue',
                    targetTable: 'tags',
                    relatedTable: 'tags',
                    relatedTableDisplayName: 'Tags',
                    showOnSource: true,
                    showOnTarget: true,
                    displayOrder: 100,
                    relatedTableHasColor: true,
                    extraColumns: []
                };

                const response$ = firstValueFrom(service.addManyToManyRelation(5, meta, 3));

                const req = httpMock.expectOne(testPostgrestUrl + 'issue_tags');
                expect(req.request.method).toBe('POST');
                expect(req.request.body).toEqual({
                    issue_id: 5,
                    tag_id: 3
                });
                req.flush({});

                const response = await response$;
                expect(response.success).toBe(true);
            });

            it('should handle string entity IDs', async () => {
                const meta = {
                    junctionTable: 'user_roles',
                    sourceColumn: 'user_id',
                    targetColumn: 'role_id',
                    sourceTable: 'civic_os_users',
                    targetTable: 'roles',
                    relatedTable: 'roles',
                    relatedTableDisplayName: 'Roles',
                    showOnSource: true,
                    showOnTarget: true,
                    displayOrder: 100,
                    relatedTableHasColor: false,
                    extraColumns: []
                };

                const response$ = firstValueFrom(service.addManyToManyRelation('abc-123-uuid', meta, 2));

                const req = httpMock.expectOne(testPostgrestUrl + 'user_roles');
                expect(req.request.body).toEqual({
                    user_id: 'abc-123-uuid',
                    role_id: 2
                });
                req.flush({});

                const response = await response$;
                expect(response.success).toBe(true);
            });

            it('should return success=false on duplicate key error', async () => {
                const meta = {
                    junctionTable: 'issue_tags',
                    sourceColumn: 'issue_id',
                    targetColumn: 'tag_id',
                    sourceTable: 'Issue',
                    targetTable: 'tags',
                    relatedTable: 'tags',
                    relatedTableDisplayName: 'Tags',
                    showOnSource: true,
                    showOnTarget: true,
                    displayOrder: 100,
                    relatedTableHasColor: true,
                    extraColumns: []
                };

                const response$ = firstValueFrom(service.addManyToManyRelation(5, meta, 3));

                const req = httpMock.expectOne(testPostgrestUrl + 'issue_tags');
                req.flush({ message: 'duplicate key value violates unique constraint', code: '23505' }, { status: 409, statusText: 'Conflict' });

                const response = await response$;
                expect(response.success).toBe(false);
                expect(response.error).toBeDefined();
            });

            it('should handle permission errors', async () => {
                const meta = {
                    junctionTable: 'issue_tags',
                    sourceColumn: 'issue_id',
                    targetColumn: 'tag_id',
                    sourceTable: 'Issue',
                    targetTable: 'tags',
                    relatedTable: 'tags',
                    relatedTableDisplayName: 'Tags',
                    showOnSource: true,
                    showOnTarget: true,
                    displayOrder: 100,
                    relatedTableHasColor: true,
                    extraColumns: []
                };

                const response$ = firstValueFrom(service.addManyToManyRelation(5, meta, 3));

                const req = httpMock.expectOne(testPostgrestUrl + 'issue_tags');
                req.flush({ message: 'permission denied for table issue_tags', code: '42501' }, { status: 403, statusText: 'Forbidden' });

                const response = await response$;
                expect(response.success).toBe(false);
                expect(response.error).toBeDefined();
            });
        });

        describe('removeManyToManyRelation()', () => {
            it('should DELETE junction record with composite key filter', async () => {
                const meta = {
                    junctionTable: 'issue_tags',
                    sourceColumn: 'issue_id',
                    targetColumn: 'tag_id',
                    sourceTable: 'Issue',
                    targetTable: 'tags',
                    relatedTable: 'tags',
                    relatedTableDisplayName: 'Tags',
                    showOnSource: true,
                    showOnTarget: true,
                    displayOrder: 100,
                    relatedTableHasColor: true,
                    extraColumns: []
                };

                const response$ = firstValueFrom(service.removeManyToManyRelation(5, meta, 3));

                const req = httpMock.expectOne(req => req.url.includes('issue_tags?issue_id=eq.5&tag_id=eq.3'));
                expect(req.request.method).toBe('DELETE');
                req.flush({});

                const response = await response$;
                expect(response.success).toBe(true);
            });

            it('should handle string entity IDs in filter', async () => {
                const meta = {
                    junctionTable: 'user_roles',
                    sourceColumn: 'user_id',
                    targetColumn: 'role_id',
                    sourceTable: 'civic_os_users',
                    targetTable: 'roles',
                    relatedTable: 'roles',
                    relatedTableDisplayName: 'Roles',
                    showOnSource: true,
                    showOnTarget: true,
                    displayOrder: 100,
                    relatedTableHasColor: false,
                    extraColumns: []
                };

                const response$ = firstValueFrom(service.removeManyToManyRelation('abc-123-uuid', meta, 2));

                const req = httpMock.expectOne(req => req.url.includes('user_roles?user_id=eq.abc-123-uuid&role_id=eq.2'));
                expect(req.request.method).toBe('DELETE');
                req.flush({});

                const response = await response$;
                expect(response.success).toBe(true);
            });

            it('should return success even when no rows deleted (PostgREST behavior)', async () => {
                const meta = {
                    junctionTable: 'issue_tags',
                    sourceColumn: 'issue_id',
                    targetColumn: 'tag_id',
                    sourceTable: 'Issue',
                    targetTable: 'tags',
                    relatedTable: 'tags',
                    relatedTableDisplayName: 'Tags',
                    showOnSource: true,
                    showOnTarget: true,
                    displayOrder: 100,
                    relatedTableHasColor: true,
                    extraColumns: []
                };

                const response$ = firstValueFrom(service.removeManyToManyRelation(5, meta, 999));

                const req = httpMock.expectOne(req => req.url.includes('issue_tags?issue_id=eq.5&tag_id=eq.999'));
                req.flush([], { status: 200, statusText: 'OK' }); // Empty response but still success

                const response = await response$;
                // PostgREST returns 200 even if no rows matched, which is standard REST behavior
                expect(response.success).toBe(true);
            });

            it('should handle permission errors', async () => {
                const meta = {
                    junctionTable: 'issue_tags',
                    sourceColumn: 'issue_id',
                    targetColumn: 'tag_id',
                    sourceTable: 'Issue',
                    targetTable: 'tags',
                    relatedTable: 'tags',
                    relatedTableDisplayName: 'Tags',
                    showOnSource: true,
                    showOnTarget: true,
                    displayOrder: 100,
                    relatedTableHasColor: true,
                    extraColumns: []
                };

                const response$ = firstValueFrom(service.removeManyToManyRelation(5, meta, 3));

                const req = httpMock.expectOne(req => req.url.includes('issue_tags?issue_id=eq.5&tag_id=eq.3'));
                req.flush({ message: 'permission denied for table issue_tags', code: '42501' }, { status: 403, statusText: 'Forbidden' });

                const response = await response$;
                expect(response.success).toBe(false);
                expect(response.error).toBeDefined();
            });

            it('should handle network errors', async () => {
                const meta = {
                    junctionTable: 'issue_tags',
                    sourceColumn: 'issue_id',
                    targetColumn: 'tag_id',
                    sourceTable: 'Issue',
                    targetTable: 'tags',
                    relatedTable: 'tags',
                    relatedTableDisplayName: 'Tags',
                    showOnSource: true,
                    showOnTarget: true,
                    displayOrder: 100,
                    relatedTableHasColor: true,
                    extraColumns: []
                };

                const response$ = firstValueFrom(service.removeManyToManyRelation(5, meta, 3));

                const req = httpMock.expectOne(req => req.url.includes('issue_tags?issue_id=eq.5&tag_id=eq.3'));
                req.error(new ProgressEvent('Network error'), { status: 0 });

                const response = await response$;
                expect(response.success).toBe(false);
                expect(response.error).toBeDefined();
            });
        });

        describe('transformManyToManyData() with parent hops', () => {
            it('should traverse parent hops to extract grandparent entities', () => {
                const junctionData = [
                    { tool_reservation_tools: { tool_reservations: { id: 1, display_name: 'Reservation A' } } },
                    { tool_reservation_tools: { tool_reservations: { id: 2, display_name: 'Reservation B' } } },
                ];

                const result = DataService.transformManyToManyData(junctionData, 'tool_reservations', // relatedTable (grandparent)
                undefined, [{ table: 'tool_reservations', fkColumn: 'tool_reservation_id' }], // parentHops
                'tool_reservation_tools' // targetTable (intermediate)
                );

                expect(result).toEqual([
                    { id: 1, display_name: 'Reservation A' },
                    { id: 2, display_name: 'Reservation B' },
                ]);
            });

            it('should deduplicate by ID when multiple junction rows collapse to same grandparent', () => {
                // Two tool items on the same reservation
                const junctionData = [
                    { tool_reservation_tools: { tool_reservations: { id: 1, display_name: 'Reservation A' } } },
                    { tool_reservation_tools: { tool_reservations: { id: 1, display_name: 'Reservation A' } } },
                    { tool_reservation_tools: { tool_reservations: { id: 2, display_name: 'Reservation B' } } },
                ];

                const result = DataService.transformManyToManyData(junctionData, 'tool_reservations', undefined, [{ table: 'tool_reservations', fkColumn: 'tool_reservation_id' }], 'tool_reservation_tools');

                expect(result.length).toBe(2);
                expect(result[0].id).toBe(1);
                expect(result[1].id).toBe(2);
            });

            it('should handle null intermediate gracefully', () => {
                const junctionData = [
                    { tool_reservation_tools: null },
                    { tool_reservation_tools: { tool_reservations: { id: 1, display_name: 'Reservation A' } } },
                ];

                const result = DataService.transformManyToManyData(junctionData, 'tool_reservations', undefined, [{ table: 'tool_reservations', fkColumn: 'tool_reservation_id' }], 'tool_reservation_tools');

                expect(result.length).toBe(1);
                expect(result[0].id).toBe(1);
            });

            it('should fall back to standard path when no parentHops provided', () => {
                const junctionData = [
                    { tags: { id: 1, display_name: 'Urgent' } },
                    { tags: { id: 2, display_name: 'Bug' } },
                ];

                const result = DataService.transformManyToManyData(junctionData, 'tags');

                expect(result).toEqual([
                    { id: 1, display_name: 'Urgent' },
                    { id: 2, display_name: 'Bug' },
                ]);
            });
        });
    });

    describe('Edit Integrity - TimeSlot Comparison (Cross-Browser)', () => {
        it('should match TimeSlot values without milliseconds (Firefox format)', () => {
            const input = {
                time_slot: '[2025-11-04T20:00:00Z,2025-11-04T22:00:00Z)'
            };
            const response = {
                success: true,
                body: [{
                        time_slot: '[\"2025-11-04 20:00:00+00\",\"2025-11-04 22:00:00+00\")'
                    }]
            };

            // Use a private method via type assertion to test
            const result = (service as any).checkEditResult(input, response);
            expect(result.success).toBe(true);
        });

        it('should match TimeSlot values with milliseconds (Chrome format)', () => {
            const input = {
                time_slot: '[2025-11-04T20:00:00.000Z,2025-11-04T22:00:00.000Z)'
            };
            const response = {
                success: true,
                body: [{
                        time_slot: '[\"2025-11-04 20:00:00+00\",\"2025-11-04 22:00:00+00\")'
                    }]
            };

            const result = (service as any).checkEditResult(input, response);
            expect(result.success).toBe(true);
        });

        it('should match TimeSlot values with different millisecond precision', () => {
            const input = {
                time_slot: '[2025-11-04T14:30:00.123Z,2025-11-04T16:30:00.456Z)'
            };
            const response = {
                success: true,
                body: [{
                        time_slot: '[\"2025-11-04 14:30:00+00\",\"2025-11-04 16:30:00+00\")'
                    }]
            };

            const result = (service as any).checkEditResult(input, response);
            expect(result.success).toBe(true);
        });

        it('should not match TimeSlot values with different times', () => {
            const input = {
                time_slot: '[2025-11-04T20:00:00.000Z,2025-11-04T22:00:00.000Z)'
            };
            const response = {
                success: true,
                body: [{
                        time_slot: '[\"2025-11-04 21:00:00+00\",\"2025-11-04 23:00:00+00\")' // Different time
                    }]
            };

            const result = (service as any).checkEditResult(input, response);
            expect(result.success).toBe(false);
        });

        it('should handle timezone conversions correctly', () => {
            const input = {
                time_slot: '[2025-11-04T20:00:00Z,2025-11-04T22:00:00Z)'
            };
            const response = {
                success: true,
                body: [{
                        // PostgreSQL returns UTC (+00)
                        time_slot: '[\"2025-11-04 20:00:00+00\",\"2025-11-04 22:00:00+00\")'
                    }]
            };

            const result = (service as any).checkEditResult(input, response);
            expect(result.success).toBe(true);
        });
    });

    describe('bulkInsertJunctions()', () => {
        it('should POST junction records with return=minimal', async () => {
            const records = [
                { partner_id: 1, service_category_id: 2 },
                { partner_id: 1, service_category_id: 5 }
            ];

            const response$ = firstValueFrom(service.bulkInsertJunctions('partner_service_categories', records));

            const req = httpMock.expectOne(testPostgrestUrl + 'partner_service_categories');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual(records);
            expect(req.request.headers.get('Prefer')).toBe('return=minimal');
            expect(req.request.headers.get('Content-Type')).toBe('application/json');
            req.flush(null, { status: 201, statusText: 'Created' });

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should return success for empty records array', async () => {
            const response$ = firstValueFrom(service.bulkInsertJunctions('partner_service_categories', []));

            // No HTTP request should be made
            httpMock.expectNone(testPostgrestUrl + 'partner_service_categories');

            const response = await response$;
            expect(response.success).toBe(true);
        });

        it('should handle conflict errors (duplicate junction records)', async () => {
            const records = [
                { partner_id: 1, service_category_id: 2 }
            ];

            const response$ = firstValueFrom(service.bulkInsertJunctions('partner_service_categories', records));

            const req = httpMock.expectOne(testPostgrestUrl + 'partner_service_categories');
            req.flush({ code: '23505', message: 'duplicate key value violates unique constraint', details: '', hint: '' }, { status: 409, statusText: 'Conflict' });

            const response = await response$;
            expect(response.success).toBe(false);
            expect(response.error).toBeDefined();
        });
    });
});
