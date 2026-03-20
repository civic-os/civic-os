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
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CategoryAdminService, CategoryGroup, CategoryValue } from './category-admin.service';

describe('CategoryAdminService', () => {
  let service: CategoryAdminService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        CategoryAdminService
      ]
    });

    service = TestBed.inject(CategoryAdminService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('getCategoryEntityTypes', () => {
    it('should call the RPC and return category groups', () => {
      const mockGroups: CategoryGroup[] = [
        { entity_type: 'building_type', display_name: 'Building Type', description: 'Building types', category_count: 3 }
      ];

      service.getCategoryEntityTypes().subscribe(groups => {
        expect(groups).toEqual(mockGroups);
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/get_category_entity_types'));
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({});
      req.flush(mockGroups);
    });

    it('should return empty array on error', () => {
      service.getCategoryEntityTypes().subscribe(groups => {
        expect(groups).toEqual([]);
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/get_category_entity_types'));
      req.error(new ProgressEvent('error'));
    });
  });

  describe('getCategoriesForEntity', () => {
    it('should fetch categories with correct query params', () => {
      const mockCategories: CategoryValue[] = [
        { id: 1, entity_type: 'building_type', category_key: 'residential', display_name: 'Residential', description: null, color: '#3B82F6', sort_order: 0 }
      ];

      service.getCategoriesForEntity('building_type').subscribe(categories => {
        expect(categories).toEqual(mockCategories);
      });

      const req = httpMock.expectOne(r =>
        r.url.includes('categories?entity_type=eq.building_type&order=sort_order,display_name')
      );
      expect(req.request.method).toBe('GET');
      req.flush(mockCategories);
    });
  });

  describe('upsertCategoryGroup', () => {
    it('should call RPC with correct params', () => {
      service.upsertCategoryGroup('test_type', 'Test description', 'Test Type').subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_category_group'));
      expect(req.request.body).toEqual({
        p_entity_type: 'test_type',
        p_description: 'Test description',
        p_display_name: 'Test Type'
      });
      req.flush({ success: true });
    });

    it('should handle RPC error response', () => {
      service.upsertCategoryGroup('test_type', undefined, undefined).subscribe(response => {
        expect(response.success).toBeFalse();
        expect(response.error?.humanMessage).toBe('Permission denied');
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_category_group'));
      req.flush({ success: false, error: 'Permission denied' });
    });
  });

  describe('deleteCategoryGroup', () => {
    it('should call RPC with entity type', () => {
      service.deleteCategoryGroup('test_type').subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/delete_category_group'));
      expect(req.request.body).toEqual({ p_entity_type: 'test_type' });
      req.flush({ success: true });
    });
  });

  describe('upsertCategory', () => {
    it('should create a new category (no categoryId)', () => {
      service.upsertCategory('building_type', 'Commercial', 'Commercial buildings', '#EF4444', 1).subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_category'));
      expect(req.request.body).toEqual({
        p_entity_type: 'building_type',
        p_display_name: 'Commercial',
        p_description: 'Commercial buildings',
        p_color: '#EF4444',
        p_sort_order: 1,
        p_category_id: null
      });
      req.flush({ success: true, id: 5 });
    });

    it('should update an existing category (with categoryId)', () => {
      service.upsertCategory('building_type', 'Commercial Updated', undefined, undefined, undefined, 5).subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_category'));
      expect(req.request.body.p_category_id).toBe(5);
      req.flush({ success: true, id: 5 });
    });
  });

  describe('deleteCategory', () => {
    it('should call RPC with category ID', () => {
      service.deleteCategory(5).subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/delete_category'));
      expect(req.request.body).toEqual({ p_category_id: 5 });
      req.flush({ success: true });
    });

    it('should handle reference error', () => {
      service.deleteCategory(5).subscribe(response => {
        expect(response.success).toBeFalse();
        expect(response.error?.humanMessage).toContain('Cannot delete');
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/delete_category'));
      req.flush({ success: false, error: 'Cannot delete: 3 records reference this category' });
    });
  });
});
