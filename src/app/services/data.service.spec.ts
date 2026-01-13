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
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { DataService } from './data.service';
import { AnalyticsService } from './analytics.service';

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
  let mockAnalytics: jasmine.SpyObj<AnalyticsService>;
  const testPostgrestUrl = 'http://test-api.example.com/';

  beforeEach(() => {
    // Mock AnalyticsService
    mockAnalytics = jasmine.createSpyObj('AnalyticsService', ['trackEvent']);

    // Mock runtime configuration
    (window as any).civicOsConfig = {
      postgrestUrl: testPostgrestUrl
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
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

  describe('getData() - Query Building', () => {
    it('should construct basic GET request', (done) => {
      const mockData = [{ id: 1, name: 'Test', created_at: '', updated_at: '', display_name: 'Test' }];

      service.getData({ key: 'Issue', fields: [] }).subscribe(data => {
        expect(data).toEqual(mockData);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      expect(req.request.method).toBe('GET');
      req.flush(mockData);
    });

    it('should auto-add id field to select if not present', (done) => {
      service.getData({
        key: 'Issue',
        fields: ['name', 'description']
      }).subscribe();

      const req = httpMock.expectOne(req =>
        req.url.includes('select=name,description,id')
      );
      expect(req.request.url).toContain('id');
      req.flush([]);
      done();
    });

    it('should not duplicate id field if already present', (done) => {
      service.getData({
        key: 'Issue',
        fields: ['id', 'name']
      }).subscribe();

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      const url = req.request.url;
      const selectParam = url.split('select=')[1];

      // Count occurrences of 'id'
      const idCount = (selectParam?.match(/\bid\b/g) || []).length;
      expect(idCount).toBe(1);

      req.flush([]);
      done();
    });

    it('should build select parameter with multiple fields', (done) => {
      service.getData({
        key: 'Issue',
        fields: ['name', 'status_id', 'created_at']
      }).subscribe();

      const req = httpMock.expectOne(req =>
        req.url.includes('select=name,status_id,created_at,id')
      );
      expect(req.request.url).toContain('select=');
      req.flush([]);
      done();
    });

    it('should build order parameter with default ascending direction', (done) => {
      service.getData({
        key: 'Issue',
        fields: [],
        orderField: 'created_at'
      }).subscribe();

      const req = httpMock.expectOne(req =>
        req.url.includes('order=created_at.asc')
      );
      expect(req.request.url).toContain('order=created_at.asc');
      req.flush([]);
      done();
    });

    it('should build order parameter with descending direction', (done) => {
      service.getData({
        key: 'Issue',
        fields: [],
        orderField: 'created_at',
        orderDirection: 'desc'
      }).subscribe();

      const req = httpMock.expectOne(req =>
        req.url.includes('order=created_at.desc')
      );
      expect(req.request.url).toContain('order=created_at.desc');
      req.flush([]);
      done();
    });

    it('should build entityId filter', (done) => {
      service.getData({
        key: 'Issue',
        fields: [],
        entityId: '42'
      }).subscribe();

      const req = httpMock.expectOne(req =>
        req.url.includes('id=eq.42')
      );
      expect(req.request.url).toContain('id=eq.42');
      req.flush([]);
      done();
    });

    it('should combine multiple query parameters', (done) => {
      service.getData({
        key: 'Issue',
        fields: ['name', 'status_id'],
        orderField: 'name',
        orderDirection: 'asc',
        entityId: '10'
      }).subscribe();

      const req = httpMock.expectOne(req => {
        const url = req.url;
        return url.includes('Issue') &&
               url.includes('select=name,status_id,id') &&
               url.includes('order=name.asc') &&
               url.includes('id=eq.10');
      });

      expect(req.request.url).toContain('&');
      req.flush([]);
      done();
    });

    it('should construct correct PostgREST URL', (done) => {
      service.getData({
        key: 'Issue',
        fields: ['name']
      }).subscribe();

      const req = httpMock.expectOne(req =>
        req.url.startsWith(testPostgrestUrl)
      );
      expect(req.request.url).toContain(testPostgrestUrl);
      req.flush([]);
      done();
    });
  });

  describe('getDataPaginated() - Request Construction', () => {
    it('should construct paginated GET request with Range headers', (done) => {
      const mockData = [
        { id: 1, name: 'Test 1', created_at: '', updated_at: '', display_name: 'Test 1' },
        { id: 2, name: 'Test 2', created_at: '', updated_at: '', display_name: 'Test 2' }
      ];

      service.getDataPaginated({
        key: 'Issue',
        fields: ['name'],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe();

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      expect(req.request.method).toBe('GET');
      expect(req.request.headers.get('Range-Unit')).toBe('items');
      expect(req.request.headers.get('Range')).toBe('0-24');
      expect(req.request.headers.get('Prefer')).toBe('count=exact');

      req.flush(mockData, {
        headers: { 'Content-Range': '0-1/237' }
      });
      done();
    });

    it('should use default pagination when not specified', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: []
      }).subscribe();

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      expect(req.request.headers.get('Range')).toBe('0-24'); // Default: page 1, pageSize 25
      req.flush([], { headers: { 'Content-Range': '0-0/0' } });
      done();
    });

    it('should calculate Range header for page 1', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe();

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      expect(req.request.headers.get('Range')).toBe('0-24'); // offset 0, end 24
      req.flush([], { headers: { 'Content-Range': '0-24/100' } });
      done();
    });

    it('should calculate Range header for page 5', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 5, pageSize: 25 }
      }).subscribe();

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      expect(req.request.headers.get('Range')).toBe('100-124'); // offset 100, end 124
      req.flush([], { headers: { 'Content-Range': '100-124/237' } });
      done();
    });

    it('should calculate Range header with pageSize 50', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 3, pageSize: 50 }
      }).subscribe();

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      expect(req.request.headers.get('Range')).toBe('100-149'); // (3-1)*50 = 100, end = 149
      req.flush([], { headers: { 'Content-Range': '100-149/500' } });
      done();
    });

    it('should calculate Range header with pageSize 100', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 2, pageSize: 100 }
      }).subscribe();

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      expect(req.request.headers.get('Range')).toBe('100-199'); // (2-1)*100 = 100, end = 199
      req.flush([], { headers: { 'Content-Range': '100-199/350' } });
      done();
    });
  });

  describe('getDataPaginated() - Content-Range Parsing', () => {
    it('should parse Content-Range header correctly', (done) => {
      const mockData = [{ id: 1, name: 'Test', created_at: '', updated_at: '', display_name: 'Test' }];

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.data).toEqual(mockData);
        expect(response.totalCount).toBe(237);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(mockData, {
        headers: { 'Content-Range': '0-24/237' }
      });
    });

    it('should parse Content-Range with single result', (done) => {
      const mockData = [{ id: 5, name: 'Single' }];

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.totalCount).toBe(1);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(mockData, {
        headers: { 'Content-Range': '0-0/1' }
      });
    });

    it('should parse Content-Range for middle page', (done) => {
      const mockData = Array(25).fill(null).map((_, i) => ({ id: i + 101, name: `Test ${i}` }));

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 5, pageSize: 25 }
      }).subscribe(response => {
        expect(response.totalCount).toBe(10000);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(mockData, {
        headers: { 'Content-Range': '100-124/10000' }
      });
    });

    it('should parse Content-Range for last partial page', (done) => {
      const mockData = Array(12).fill(null).map((_, i) => ({ id: i + 226, name: `Test ${i}` }));

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 10, pageSize: 25 }
      }).subscribe(response => {
        expect(response.data.length).toBe(12);
        expect(response.totalCount).toBe(237);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(mockData, {
        headers: { 'Content-Range': '225-236/237' }
      });
    });

    it('should handle missing Content-Range header', (done) => {
      const mockData = [{ id: 1, name: 'Test' }];

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.totalCount).toBe(1); // Fallback to data.length
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(mockData); // No Content-Range header
    });

    it('should handle Content-Range with wildcard total (*)', (done) => {
      const mockData = [{ id: 1, name: 'Test' }];

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.totalCount).toBe(1); // Fallback to data.length when wildcard
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(mockData, {
        headers: { 'Content-Range': '0-0/*' }
      });
    });

    it('should handle empty results', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.data).toEqual([]);
        expect(response.totalCount).toBe(0);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush([], {
        headers: { 'Content-Range': '0-0/0' }
      });
    });
  });

  describe('getDataPaginated() - Query Integration', () => {
    it('should combine pagination with select fields', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: ['name', 'status_id', 'created_at'],
        pagination: { page: 2, pageSize: 50 }
      }).subscribe();

      const req = httpMock.expectOne(req => {
        const url = req.url;
        return url.includes('select=name,status_id,created_at,id') &&
               req.headers.get('Range') === '50-99';
      });
      expect(req.request.url).toContain('select=');
      req.flush([], { headers: { 'Content-Range': '50-99/237' } });
      done();
    });

    it('should combine pagination with order parameters', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        orderField: 'created_at',
        orderDirection: 'desc',
        pagination: { page: 1, pageSize: 25 }
      }).subscribe();

      const req = httpMock.expectOne(req => {
        const url = req.url;
        return url.includes('order=created_at.desc') &&
               req.headers.get('Range') === '0-24';
      });
      expect(req.request.url).toContain('order=created_at.desc');
      req.flush([], { headers: { 'Content-Range': '0-24/100' } });
      done();
    });

    it('should combine pagination with entityId filter', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        entityId: '42',
        pagination: { page: 1, pageSize: 25 }
      }).subscribe();

      const req = httpMock.expectOne(req => {
        const url = req.url;
        return url.includes('id=eq.42') &&
               req.headers.get('Range') === '0-24';
      });
      expect(req.request.url).toContain('id=eq.42');
      req.flush([], { headers: { 'Content-Range': '0-0/1' } });
      done();
    });

    it('should combine pagination with search query', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        searchQuery: 'test search',
        pagination: { page: 1, pageSize: 25 }
      }).subscribe();

      const req = httpMock.expectOne(req => {
        const url = req.url;
        return url.includes('civic_os_text_search=') &&
               req.headers.get('Range') === '0-24';
      });
      expect(req.request.url).toContain('civic_os_text_search=');
      req.flush([], { headers: { 'Content-Range': '0-10/11' } });
      done();
    });

    it('should combine pagination with filters', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        filters: [
          { column: 'status_id', operator: 'eq', value: '2' }
        ],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe();

      const req = httpMock.expectOne(req => {
        const url = req.url;
        return url.includes('status_id=eq.2') &&
               req.headers.get('Range') === '0-24';
      });
      expect(req.request.url).toContain('status_id=eq.2');
      req.flush([], { headers: { 'Content-Range': '0-15/16' } });
      done();
    });

    it('should combine all query parameters with pagination', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: ['name', 'status_id'],
        searchQuery: 'pothole',
        filters: [
          { column: 'status_id', operator: 'eq', value: '1' }
        ],
        pagination: { page: 3, pageSize: 50 }
      }).subscribe();

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
      done();
    });
  });

  describe('getDataPaginated() - Response Structure', () => {
    it('should return PaginatedResponse with data and totalCount', (done) => {
      const mockData = [
        { id: 1, name: 'Test 1' },
        { id: 2, name: 'Test 2' }
      ];

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response).toBeDefined();
        expect(response.data).toBeDefined();
        expect(response.totalCount).toBeDefined();
        expect(Array.isArray(response.data)).toBe(true);
        expect(typeof response.totalCount).toBe('number');
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(mockData, {
        headers: { 'Content-Range': '0-1/237' }
      });
    });

    it('should preserve data array structure', (done) => {
      const mockData = [
        { id: 1, name: 'Test 1', status_id: 2, created_at: '2024-01-01', updated_at: '2024-01-01', display_name: 'Test 1' },
        { id: 2, name: 'Test 2', status_id: 3, created_at: '2024-01-02', updated_at: '2024-01-02', display_name: 'Test 2' }
      ];

      service.getDataPaginated({
        key: 'Issue',
        fields: ['name', 'status_id', 'created_at'],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.data).toEqual(mockData);
        expect(response.data.length).toBe(2);
        expect((response.data[0] as any).name).toBe('Test 1');
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(mockData, {
        headers: { 'Content-Range': '0-1/2' }
      });
    });
  });

  describe('getDataPaginated() - Error Handling', () => {
    it('should handle HTTP errors gracefully', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.data).toEqual([]);
        expect(response.totalCount).toBe(0);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(
        { message: 'Internal server error' },
        { status: 500, statusText: 'Internal Server Error' }
      );
    });

    it('should handle network errors', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.data).toEqual([]);
        expect(response.totalCount).toBe(0);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.error(new ProgressEvent('Network error'), { status: 0 });
    });

    it('should handle permission errors', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.data).toEqual([]);
        expect(response.totalCount).toBe(0);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(
        { message: 'permission denied for table Issue', code: '42501' },
        { status: 403, statusText: 'Forbidden' }
      );
    });

    it('should handle null response body', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.data).toEqual([]);
        expect(response.totalCount).toBe(0);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(null, {
        headers: { 'Content-Range': '0-0/0' }
      });
    });
  });

  describe('getDataPaginated() - Edge Cases', () => {
    it('should handle page beyond available data', (done) => {
      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 100, pageSize: 25 }
      }).subscribe(response => {
        expect(response.data).toEqual([]);
        expect(response.totalCount).toBe(237);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      expect(req.request.headers.get('Range')).toBe('2475-2499'); // (100-1)*25 = 2475
      req.flush([], {
        headers: { 'Content-Range': '*/237' } // PostgREST format for out-of-range
      });
    });

    it('should handle very large page sizes', (done) => {
      const mockData = Array(200).fill(null).map((_, i) => ({ id: i + 1, name: `Test ${i}` }));

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 200 }
      }).subscribe(response => {
        expect(response.data.length).toBe(200);
        expect(response.totalCount).toBe(237);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      expect(req.request.headers.get('Range')).toBe('0-199');
      req.flush(mockData, {
        headers: { 'Content-Range': '0-199/237' }
      });
    });

    it('should handle page size 10 (minimum)', (done) => {
      const mockData = Array(10).fill(null).map((_, i) => ({ id: i + 1, name: `Test ${i}` }));

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 10 }
      }).subscribe(response => {
        expect(response.data.length).toBe(10);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      expect(req.request.headers.get('Range')).toBe('0-9');
      req.flush(mockData, {
        headers: { 'Content-Range': '0-9/237' }
      });
    });

    it('should handle single record total', (done) => {
      const mockData = [{ id: 1, name: 'Only One' }];

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.data.length).toBe(1);
        expect(response.totalCount).toBe(1);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(mockData, {
        headers: { 'Content-Range': '0-0/1' }
      });
    });

    it('should handle large datasets (10000+ records)', (done) => {
      const mockData = Array(25).fill(null).map((_, i) => ({ id: i + 1, name: `Test ${i}` }));

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.totalCount).toBe(10537);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(mockData, {
        headers: { 'Content-Range': '0-24/10537' }
      });
    });

    it('should handle malformed Content-Range header gracefully', (done) => {
      const mockData = [{ id: 1, name: 'Test' }];

      service.getDataPaginated({
        key: 'Issue',
        fields: [],
        pagination: { page: 1, pageSize: 25 }
      }).subscribe(response => {
        expect(response.totalCount).toBe(1); // Fallback to data.length
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue'));
      req.flush(mockData, {
        headers: { 'Content-Range': 'invalid-format' }
      });
    });
  });

  describe('createData()', () => {
    it('should POST data to correct endpoint', (done) => {
      const newData = { name: 'New Issue', status_id: 1 };
      const createdData = { id: 1, ...newData };

      service.createData('Issue', newData).subscribe(response => {
        expect(response.success).toBe(true);
        expect(response.body).toEqual(createdData);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'Issue');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(newData);
      expect(req.request.headers.get('Prefer')).toBe('return=representation');
      req.flush(createdData);
    });

    it('should handle successful creation', (done) => {
      const newData = { name: 'Test' };

      service.createData('Issue', newData).subscribe(response => {
        expect(response.success).toBe(true);
        expect(response.error).toBeUndefined();
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'Issue');
      req.flush({ id: 1, name: 'Test' });
    });

    it('should handle API errors', (done) => {
      const newData = { name: 'Test' };
      const errorResponse = {
        message: 'Duplicate key violation',
        details: 'Key (name)=(Test) already exists',
        hint: null,
        code: '23505'
      };

      service.createData('Issue', newData).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
        expect(response.error?.message).toBe('Duplicate key violation');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'Issue');
      req.flush(errorResponse, { status: 409, statusText: 'Conflict' });
    });
  });

  describe('editData()', () => {
    it('should PATCH data to correct endpoint with id filter', (done) => {
      const updatedData = { name: 'Updated Issue' };
      const returnedData = { id: 1, name: 'Updated Issue', status_id: 2 };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req =>
        req.url.includes('Issue?id=eq.1')
      );
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual(updatedData);
      expect(req.request.headers.get('Prefer')).toBe('return=representation');
      req.flush([returnedData]);
    });

    it('should handle string IDs', (done) => {
      const updatedData = { name: 'Updated' };

      service.editData('Issue', 'abc-123', updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req =>
        req.url.includes('Issue?id=eq.abc-123')
      );
      expect(req.request.method).toBe('PATCH');
      expect(req.request.url).toContain('id=eq.abc-123');
      req.flush([{ id: 'abc-123', name: 'Updated' }]);
    });

    it('should validate update success by comparing returned data', (done) => {
      const updatedData = { name: 'Updated Name', status_id: 3 };
      const returnedData = { id: 1, name: 'Updated Name', status_id: 3 };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        expect(response.error).toBeUndefined();
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should detect failed update when returned data does not match', (done) => {
      const updatedData = { name: 'New Name' };
      const returnedData = { id: 1, name: 'Old Name' }; // Different from input

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
        expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should handle empty response as failure', (done) => {
      const updatedData = { name: 'Test' };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([]); // Empty array indicates no rows updated
    });

    it('should handle HTTP errors', (done) => {
      const updatedData = { name: 'Test' };
      const errorResponse = {
        message: 'permission denied for table Issue',
        code: '42501'
      };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush(errorResponse, { status: 403, statusText: 'Forbidden' });
    });
  });

  describe('deleteData()', () => {
    it('should DELETE record with id filter', (done) => {
      service.deleteData('Issue', 5).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req =>
        req.url.includes('Issue?id=eq.5')
      );
      expect(req.request.method).toBe('DELETE');
      req.flush({});
    });

    it('should handle string IDs', (done) => {
      service.deleteData('Issue', 'abc-123').subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req =>
        req.url.includes('Issue?id=eq.abc-123')
      );
      expect(req.request.method).toBe('DELETE');
      expect(req.request.url).toContain('id=eq.abc-123');
      req.flush({});
    });

    it('should handle successful deletion', (done) => {
      service.deleteData('Issue', 1).subscribe(response => {
        expect(response.success).toBe(true);
        expect(response.error).toBeUndefined();
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush({});
    });

    it('should handle foreign key constraint errors', (done) => {
      const errorResponse = {
        message: 'update or delete on table "Issue" violates foreign key constraint',
        details: 'Key (id)=(5) is still referenced from table "comments"',
        hint: 'Delete the referencing rows first',
        code: '23503'
      };

      service.deleteData('Issue', 5).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe('23503');
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.5'));
      req.flush(errorResponse, { status: 409, statusText: 'Conflict' });
    });

    it('should handle permission errors', (done) => {
      const errorResponse = {
        message: 'permission denied for table Issue',
        code: '42501'
      };

      service.deleteData('Issue', 1).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush(errorResponse, { status: 403, statusText: 'Forbidden' });
    });

    it('should handle record not found (returns success per PostgREST behavior)', (done) => {
      service.deleteData('Issue', 999).subscribe(response => {
        // PostgREST returns 200 even if no rows deleted, which is standard REST behavior
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.999'));
      req.flush({}, { status: 200, statusText: 'OK' });
    });

    it('should handle network errors', (done) => {
      service.deleteData('Issue', 1).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
        expect(response.error?.httpCode).toBe(0);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.error(new ProgressEvent('Network error'), { status: 0 });
    });
  });

  describe('refreshCurrentUser()', () => {
    it('should call RPC function', (done) => {
      service.refreshCurrentUser().subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req =>
        req.url.includes('rpc/refresh_current_user')
      );
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({});
      req.flush({ success: true });
    });

    it('should handle RPC errors', (done) => {
      service.refreshCurrentUser().subscribe(response => {
        expect(response.success).toBe(false);
        done();
      });

      const req = httpMock.expectOne(req =>
        req.url.includes('rpc/refresh_current_user')
      );
      req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', (done) => {
      const newData = { name: 'Test' };

      service.createData('Issue', newData).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
        expect(response.error?.httpCode).toBe(0);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'Issue');
      req.error(new ProgressEvent('Network error'), { status: 0 });
    });
  });

  describe('Edit Data Validation - FK Fields', () => {
    it('should validate FK field returned as embedded object (match)', (done) => {
      const updatedData = { status_id: 3 };
      const returnedData = { id: 1, status_id: { id: 3, display_name: 'Open' } };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        expect(response.error).toBeUndefined();
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should detect FK field mismatch with embedded object', (done) => {
      const updatedData = { status_id: 3 };
      const returnedData = { id: 1, status_id: { id: 5, display_name: 'Closed' } };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
        expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should handle null FK values', (done) => {
      const updatedData = { status_id: null };
      const returnedData = { id: 1, status_id: null };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should validate mixed FK and primitive fields', (done) => {
      const updatedData = { status_id: 2, name: 'Big hole' };
      const returnedData = {
        id: 1,
        status_id: { id: 2, display_name: 'In Progress' },
        name: 'Big hole'
      };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });
  });

  describe('Edit Data Validation - Type Coercion', () => {
    it('should match string vs number with type coercion', (done) => {
      const updatedData = { status_id: '4' };
      const returnedData = { id: 1, status_id: 4 };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should match number vs string with type coercion', (done) => {
      const updatedData = { status_id: 4 };
      const returnedData = { id: 1, status_id: '4' };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should coerce string ID in FK embedded object', (done) => {
      const updatedData = { status_id: 'abc-123' };
      const returnedData = { id: 1, status_id: { id: 'abc-123', display_name: 'Custom' } };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should handle boolean type coercion (1 vs true)', (done) => {
      const updatedData = { active: 1 };
      const returnedData = { id: 1, active: true };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });
  });

  describe('Edit Data Validation - Geography Fields', () => {
    it('should validate EWKT input vs EWKB response (match)', (done) => {
      const updatedData = { location: 'SRID=4326;POINT(-83.6875 43.0125)' };
      const returnedData = { id: 1, location: EWKB_SAMPLES.downtown_flint };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should validate WKT input without SRID', (done) => {
      const updatedData = { location: 'POINT(-83.6875 43.0125)' };
      const returnedData = { id: 1, location: EWKB_SAMPLES.downtown_flint };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should validate high precision coordinates', (done) => {
      const updatedData = { location: 'SRID=4326;POINT(-83.72646331787111 43.016069813188494)' };
      const returnedData = { id: 1, location: EWKB_SAMPLES.flint_high_precision };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should validate negative coordinates', (done) => {
      const updatedData = { location: 'POINT(-83.5 43.2)' };
      const returnedData = { id: 1, location: EWKB_SAMPLES.north_of_flint };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should detect geography coordinate mismatch', (done) => {
      const updatedData = { location: 'POINT(-83.6875 43.0125)' };
      const returnedData = { id: 1, location: EWKB_SAMPLES.north_of_flint }; // Different coords

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should fallback on non-Point geometry (unsupported)', (done) => {
      const updatedData = { location: 'LINESTRING(-83 43, -84 44)' };
      const returnedData = { id: 1, location: EWKB_SAMPLES.invalid_type };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true); // Fallback for unsupported types
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should detect mismatch when response format is invalid (too short)', (done) => {
      const updatedData = { location: 'POINT(-83.6875 43.0125)' };
      const returnedData = { id: 1, location: EWKB_SAMPLES.invalid_short };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(false); // Not detected as EWKB, compared as string
        expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should detect mismatch when response has wrong byte order', (done) => {
      const updatedData = { location: 'POINT(-83.6875 43.0125)' };
      const returnedData = { id: 1, location: EWKB_SAMPLES.invalid_byte_order };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(false); // Not detected as EWKB, compared as string
        expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should not treat string field as geography', (done) => {
      const updatedData = { name: 'POINT(-83 43)' };
      const returnedData = { id: 1, name: 'POINT(-83 43)' };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should handle null geography values', (done) => {
      const updatedData = { location: null };
      const returnedData = { id: 1, location: null };

      service.editData('Issue', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('Issue?id=eq.1'));
      req.flush([returnedData]);
    });
  });

  describe('Edit Data Validation - Color Fields', () => {
    it('should validate color with case-insensitive comparison (lowercase input, uppercase response)', (done) => {
      const updatedData = { color: '#3b82f6' };
      const returnedData = { id: 1, color: '#3B82F6' };

      service.editData('tags', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should validate color with case-insensitive comparison (uppercase input, lowercase response)', (done) => {
      const updatedData = { color: '#FF5733' };
      const returnedData = { id: 1, color: '#ff5733' };

      service.editData('tags', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should validate color with mixed case (input and response differ in case)', (done) => {
      const updatedData = { color: '#aAbBcC' };
      const returnedData = { id: 1, color: '#AABBCC' };

      service.editData('tags', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should detect color value mismatch (different colors)', (done) => {
      const updatedData = { color: '#3b82f6' };
      const returnedData = { id: 1, color: '#FF0000' }; // Different color

      service.editData('tags', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
        expect(response.error?.humanMessage).toBe('Changes may not have been saved');
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should handle null color values', (done) => {
      const updatedData = { color: null };
      const returnedData = { id: 1, color: null };

      service.editData('tags', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should not treat non-hex-color strings as colors', (done) => {
      const updatedData = { name: '#NOTCOLOR' }; // Not a valid hex color
      const returnedData = { id: 1, name: '#NOTCOLOR' };

      service.editData('tags', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should validate valid 6-digit hex colors only', (done) => {
      const updatedData = { color: '#123' }; // Too short
      const returnedData = { id: 1, color: '#123456' };

      service.editData('tags', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(false); // Mismatch because #123 is not valid format
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should validate hex colors with all same digits', (done) => {
      const updatedData = { color: '#ffffff' };
      const returnedData = { id: 1, color: '#FFFFFF' };

      service.editData('tags', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should validate hex colors with all zeros', (done) => {
      const updatedData = { color: '#000000' };
      const returnedData = { id: 1, color: '#000000' };

      service.editData('tags', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
      req.flush([returnedData]);
    });

    it('should combine color validation with other fields', (done) => {
      const updatedData = { color: '#3b82f6', display_name: 'Blue Tag' };
      const returnedData = { id: 1, color: '#3B82F6', display_name: 'Blue Tag' };

      service.editData('tags', 1, updatedData).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('tags?id=eq.1'));
      req.flush([returnedData]);
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
      it('should POST junction record with correct columns', (done) => {
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
          relatedTableHasColor: true
        };

        service.addManyToManyRelation(5, meta, 3).subscribe(response => {
          expect(response.success).toBe(true);
          done();
        });

        const req = httpMock.expectOne(testPostgrestUrl + 'issue_tags');
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({
          issue_id: 5,
          tag_id: 3
        });
        req.flush({});
      });

      it('should handle string entity IDs', (done) => {
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
          relatedTableHasColor: false
        };

        service.addManyToManyRelation('abc-123-uuid', meta, 2).subscribe(response => {
          expect(response.success).toBe(true);
          done();
        });

        const req = httpMock.expectOne(testPostgrestUrl + 'user_roles');
        expect(req.request.body).toEqual({
          user_id: 'abc-123-uuid',
          role_id: 2
        });
        req.flush({});
      });

      it('should return success=false on duplicate key error', (done) => {
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
          relatedTableHasColor: true
        };

        service.addManyToManyRelation(5, meta, 3).subscribe(response => {
          expect(response.success).toBe(false);
          expect(response.error).toBeDefined();
          done();
        });

        const req = httpMock.expectOne(testPostgrestUrl + 'issue_tags');
        req.flush(
          { message: 'duplicate key value violates unique constraint', code: '23505' },
          { status: 409, statusText: 'Conflict' }
        );
      });

      it('should handle permission errors', (done) => {
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
          relatedTableHasColor: true
        };

        service.addManyToManyRelation(5, meta, 3).subscribe(response => {
          expect(response.success).toBe(false);
          expect(response.error).toBeDefined();
          done();
        });

        const req = httpMock.expectOne(testPostgrestUrl + 'issue_tags');
        req.flush(
          { message: 'permission denied for table issue_tags', code: '42501' },
          { status: 403, statusText: 'Forbidden' }
        );
      });
    });

    describe('removeManyToManyRelation()', () => {
      it('should DELETE junction record with composite key filter', (done) => {
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
          relatedTableHasColor: true
        };

        service.removeManyToManyRelation(5, meta, 3).subscribe(response => {
          expect(response.success).toBe(true);
          done();
        });

        const req = httpMock.expectOne(req =>
          req.url.includes('issue_tags?issue_id=eq.5&tag_id=eq.3')
        );
        expect(req.request.method).toBe('DELETE');
        req.flush({});
      });

      it('should handle string entity IDs in filter', (done) => {
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
          relatedTableHasColor: false
        };

        service.removeManyToManyRelation('abc-123-uuid', meta, 2).subscribe(response => {
          expect(response.success).toBe(true);
          done();
        });

        const req = httpMock.expectOne(req =>
          req.url.includes('user_roles?user_id=eq.abc-123-uuid&role_id=eq.2')
        );
        expect(req.request.method).toBe('DELETE');
        req.flush({});
      });

      it('should return success even when no rows deleted (PostgREST behavior)', (done) => {
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
          relatedTableHasColor: true
        };

        service.removeManyToManyRelation(5, meta, 999).subscribe(response => {
          // PostgREST returns 200 even if no rows matched, which is standard REST behavior
          expect(response.success).toBe(true);
          done();
        });

        const req = httpMock.expectOne(req =>
          req.url.includes('issue_tags?issue_id=eq.5&tag_id=eq.999')
        );
        req.flush([], { status: 200, statusText: 'OK' }); // Empty response but still success
      });

      it('should handle permission errors', (done) => {
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
          relatedTableHasColor: true
        };

        service.removeManyToManyRelation(5, meta, 3).subscribe(response => {
          expect(response.success).toBe(false);
          expect(response.error).toBeDefined();
          done();
        });

        const req = httpMock.expectOne(req =>
          req.url.includes('issue_tags?issue_id=eq.5&tag_id=eq.3')
        );
        req.flush(
          { message: 'permission denied for table issue_tags', code: '42501' },
          { status: 403, statusText: 'Forbidden' }
        );
      });

      it('should handle network errors', (done) => {
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
          relatedTableHasColor: true
        };

        service.removeManyToManyRelation(5, meta, 3).subscribe(response => {
          expect(response.success).toBe(false);
          expect(response.error).toBeDefined();
          done();
        });

        const req = httpMock.expectOne(req =>
          req.url.includes('issue_tags?issue_id=eq.5&tag_id=eq.3')
        );
        req.error(new ProgressEvent('Network error'), { status: 0 });
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
          time_slot: '[\"2025-11-04 21:00:00+00\",\"2025-11-04 23:00:00+00\")'  // Different time
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
});
