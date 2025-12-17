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
import { PropertyManagementService } from './property-management.service';

describe('PropertyManagementService', () => {
  let service: PropertyManagementService;
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
        provideHttpClient(),
        provideHttpClientTesting(),
        PropertyManagementService
      ]
    });
    service = TestBed.inject(PropertyManagementService);
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

  describe('upsertPropertyMetadata()', () => {
    it('should call RPC function with correct parameters', (done) => {
      service.upsertPropertyMetadata(
        'Issue',
        'title',
        'Issue Title',
        'The title of the issue',
        1,
        200,
        true,
        true,
        true,
        true,
        true,
        true
      ).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/upsert_property_metadata');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_table_name: 'Issue',
        p_column_name: 'title',
        p_display_name: 'Issue Title',
        p_description: 'The title of the issue',
        p_sort_order: 1,
        p_column_width: 200,
        p_sortable: true,
        p_filterable: true,
        p_show_on_list: true,
        p_show_on_create: true,
        p_show_on_edit: true,
        p_show_on_detail: true,
        p_is_recurring: null
      });
      req.flush({});
    });

    it('should handle null values', (done) => {
      service.upsertPropertyMetadata(
        'Issue',
        'title',
        null,
        null,
        null,
        null,
        false,
        false,
        false,
        false,
        false,
        false
      ).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/upsert_property_metadata');
      expect(req.request.body).toEqual({
        p_table_name: 'Issue',
        p_column_name: 'title',
        p_display_name: null,
        p_description: null,
        p_sort_order: null,
        p_column_width: null,
        p_sortable: false,
        p_filterable: false,
        p_show_on_list: false,
        p_show_on_create: false,
        p_show_on_edit: false,
        p_show_on_detail: false,
        p_is_recurring: null
      });
      req.flush({});
    });

    it('should handle errors', (done) => {
      service.upsertPropertyMetadata(
        'Issue',
        'title',
        'Issue Title',
        null,
        1,
        null,
        true,
        true,
        true,
        true,
        true,
        true
      ).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Failed to save property metadata');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/upsert_property_metadata');
      req.flush({ message: 'Admin access required' }, { status: 403, statusText: 'Forbidden' });
    });
  });

  describe('updatePropertiesOrder()', () => {
    /**
     * REGRESSION TEST CONTEXT:
     * This tests the drag-and-drop reordering functionality. A critical bug was fixed where
     * the database function was creating metadata rows with table defaults (show_on_list=true)
     * instead of smart defaults (show_on_list=false for system fields like 'id').
     *
     * Bug scenario:
     * 1. User drags to reorder properties (even non-system fields)
     * 2. Frontend calls update_property_sort_order for ALL properties including 'id', 'created_at', etc.
     * 3. If 'id' has no metadata row, function creates one
     * 4. OLD BUG: PostgreSQL filled missing columns with table defaults (show_on_list=true)
     * 5. Result: System fields appeared everywhere despite smart defaults in view
     *
     * Fix: The database function now explicitly sets visibility flags with smart defaults
     * matching the view logic, preventing table defaults from overriding intended behavior.
     */
    it('should call RPC function for each property', (done) => {
      const properties = [
        { table_name: 'Issue', column_name: 'title', sort_order: 0 },
        { table_name: 'Issue', column_name: 'description', sort_order: 1 },
        { table_name: 'Issue', column_name: 'status', sort_order: 2 }
      ];

      service.updatePropertiesOrder(properties).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      // Expect 3 separate RPC calls - use match to get all requests
      const requests = httpMock.match(testPostgrestUrl + 'rpc/update_property_sort_order');
      expect(requests.length).toBe(3);

      expect(requests[0].request.body).toEqual({ p_table_name: 'Issue', p_column_name: 'title', p_sort_order: 0 });
      expect(requests[1].request.body).toEqual({ p_table_name: 'Issue', p_column_name: 'description', p_sort_order: 1 });
      expect(requests[2].request.body).toEqual({ p_table_name: 'Issue', p_column_name: 'status', p_sort_order: 2 });

      requests.forEach(req => req.flush({}));
    });

    it('should handle reordering system fields without breaking visibility (regression test)', (done) => {
      // This test documents the expected behavior when system fields are included in reordering.
      // The database function must use smart defaults, not table defaults.
      const properties = [
        { table_name: 'Issue', column_name: 'id', sort_order: 0 },  // System field
        { table_name: 'Issue', column_name: 'title', sort_order: 1 },
        { table_name: 'Issue', column_name: 'created_at', sort_order: 2 }  // System field
      ];

      service.updatePropertiesOrder(properties).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      const requests = httpMock.match(testPostgrestUrl + 'rpc/update_property_sort_order');
      expect(requests.length).toBe(3);

      // Verify all properties are sent for reordering, including system fields
      expect(requests[0].request.body).toEqual({ p_table_name: 'Issue', p_column_name: 'id', p_sort_order: 0 });
      expect(requests[1].request.body).toEqual({ p_table_name: 'Issue', p_column_name: 'title', p_sort_order: 1 });
      expect(requests[2].request.body).toEqual({ p_table_name: 'Issue', p_column_name: 'created_at', p_sort_order: 2 });

      // Note: The actual smart defaults are enforced by the database function, not the frontend.
      // This test serves as documentation that system fields SHOULD be included in reordering
      // operations, and the database must handle them correctly with smart defaults.
      requests.forEach(req => req.flush({}));
    });

    it('should handle empty array', (done) => {
      service.updatePropertiesOrder([]).subscribe(response => {
        expect(response.success).toBe(true);
        done();
      });

      httpMock.expectNone(testPostgrestUrl + 'rpc/update_property_sort_order');
    });

    it('should handle errors', (done) => {
      const properties = [{ table_name: 'Issue', column_name: 'title', sort_order: 0 }];

      service.updatePropertiesOrder(properties).subscribe(response => {
        expect(response.success).toBe(false);
        expect(response.error?.humanMessage).toBe('Failed to update properties order');
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/update_property_sort_order');
      req.flush({ message: 'Error' }, { status: 500, statusText: 'Internal Server Error' });
    });
  });

  describe('isAdmin()', () => {
    it('should call RPC function', (done) => {
      service.isAdmin().subscribe(result => {
        expect(result).toBe(true);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/is_admin');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({});
      req.flush(true);
    });

    it('should return false on error', (done) => {
      service.isAdmin().subscribe(result => {
        expect(result).toBe(false);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/is_admin');
      req.flush({}, { status: 401, statusText: 'Unauthorized' });
    });
  });
});
