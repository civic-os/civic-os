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
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CategoryAdminService, CategoryGroup, CategoryValue } from './category-admin.service';
import { firstValueFrom } from 'rxjs';

describe('CategoryAdminService', () => {
    let service: CategoryAdminService;
    let httpMock: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
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
        it('should call the RPC and return category groups', async () => {
            const mockGroups: CategoryGroup[] = [
                { entity_type: 'building_type', display_name: 'Building Type', description: 'Building types', category_count: 3 }
            ];

            const result$ = firstValueFrom(service.getCategoryEntityTypes());

            const req = httpMock.expectOne(r => r.url.includes('rpc/get_category_entity_types'));
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({});
            req.flush(mockGroups);
            const groups = await result$;
            expect(groups).toEqual(mockGroups);
        });

        it('should return empty array on error', async () => {
            const result$ = firstValueFrom(service.getCategoryEntityTypes());

            const req = httpMock.expectOne(r => r.url.includes('rpc/get_category_entity_types'));
            req.error(new ProgressEvent('error'));
            const groups = await result$;
            expect(groups).toEqual([]);
        });
    });

    describe('getCategoriesForEntity', () => {
        it('should fetch categories with correct query params', async () => {
            const mockCategories: CategoryValue[] = [
                { id: 1, entity_type: 'building_type', category_key: 'residential', display_name: 'Residential', description: null, color: '#3B82F6', sort_order: 0 }
            ];

            const result$ = firstValueFrom(service.getCategoriesForEntity('building_type'));

            const req = httpMock.expectOne(r => r.url.includes('categories?entity_type=eq.building_type&order=sort_order,display_name'));
            expect(req.request.method).toBe('GET');
            req.flush(mockCategories);
            const categories = await result$;
            expect(categories).toEqual(mockCategories);
        });
    });

    describe('upsertCategoryGroup', () => {
        it('should call RPC with correct params', async () => {
            const result$ = firstValueFrom(service.upsertCategoryGroup('test_type', 'Test description', 'Test Type'));

            const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_category_group'));
            expect(req.request.body).toEqual({
                p_entity_type: 'test_type',
                p_description: 'Test description',
                p_display_name: 'Test Type'
            });
            req.flush({ success: true });
            const response = await result$;
            expect(response.success).toBe(true);
        });

        it('should handle RPC error response', async () => {
            const result$ = firstValueFrom(service.upsertCategoryGroup('test_type', undefined, undefined));

            const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_category_group'));
            req.flush({ success: false, error: 'Permission denied' });
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toBe('Permission denied');
        });
    });

    describe('deleteCategoryGroup', () => {
        it('should call RPC with entity type', async () => {
            const result$ = firstValueFrom(service.deleteCategoryGroup('test_type'));

            const req = httpMock.expectOne(r => r.url.includes('rpc/delete_category_group'));
            expect(req.request.body).toEqual({ p_entity_type: 'test_type' });
            req.flush({ success: true });
            const response = await result$;
            expect(response.success).toBe(true);
        });
    });

    describe('upsertCategory', () => {
        it('should create a new category (no categoryId)', async () => {
            const result$ = firstValueFrom(service.upsertCategory('building_type', 'Commercial', 'Commercial buildings', '#EF4444', 1));

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
            const response = await result$;
            expect(response.success).toBe(true);
        });

        it('should update an existing category (with categoryId)', async () => {
            const result$ = firstValueFrom(service.upsertCategory('building_type', 'Commercial Updated', undefined, undefined, undefined, 5));

            const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_category'));
            expect(req.request.body.p_category_id).toBe(5);
            req.flush({ success: true, id: 5 });
            const response = await result$;
            expect(response.success).toBe(true);
        });
    });

    describe('deleteCategory', () => {
        it('should call RPC with category ID', async () => {
            const result$ = firstValueFrom(service.deleteCategory(5));

            const req = httpMock.expectOne(r => r.url.includes('rpc/delete_category'));
            expect(req.request.body).toEqual({ p_category_id: 5 });
            req.flush({ success: true });
            const response = await result$;
            expect(response.success).toBe(true);
        });

        it('should handle reference error', async () => {
            const result$ = firstValueFrom(service.deleteCategory(5));

            const req = httpMock.expectOne(r => r.url.includes('rpc/delete_category'));
            req.flush({ success: false, error: 'Cannot delete: 3 records reference this category' });
            const response = await result$;
            expect(response.success).toBe(false);
            expect(response.error?.humanMessage).toContain('Cannot delete');
        });
    });
});
