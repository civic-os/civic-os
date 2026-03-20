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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { AdminCategoriesPage } from './admin-categories.page';
import { CategoryAdminService, CategoryGroup, CategoryValue } from '../../services/category-admin.service';
import { SchemaService } from '../../services/schema.service';

describe('AdminCategoriesPage', () => {
  let component: AdminCategoriesPage;
  let fixture: ComponentFixture<AdminCategoriesPage>;
  let mockCategoryAdmin: jasmine.SpyObj<CategoryAdminService>;
  let mockSchema: jasmine.SpyObj<SchemaService>;

  const mockGroups: CategoryGroup[] = [
    { entity_type: 'building_type', display_name: 'Building Type', description: 'Building types', category_count: 3 },
    { entity_type: 'issue_priority', display_name: 'Issue Priority', description: 'Issue priorities', category_count: 4 }
  ];

  const mockCategories: CategoryValue[] = [
    { id: 1, entity_type: 'building_type', category_key: 'residential', display_name: 'Residential', description: null, color: '#3B82F6', sort_order: 0 },
    { id: 2, entity_type: 'building_type', category_key: 'commercial', display_name: 'Commercial', description: 'Commercial buildings', color: '#EF4444', sort_order: 1 }
  ];

  beforeEach(async () => {
    mockCategoryAdmin = jasmine.createSpyObj('CategoryAdminService', [
      'getCategoryEntityTypes', 'getCategoriesForEntity',
      'upsertCategoryGroup', 'deleteCategoryGroup',
      'upsertCategory', 'deleteCategory'
    ]);
    mockSchema = jasmine.createSpyObj('SchemaService', ['invalidateCategoryCache']);

    mockCategoryAdmin.getCategoryEntityTypes.and.returnValue(of(mockGroups));
    mockCategoryAdmin.getCategoriesForEntity.and.returnValue(of(mockCategories));

    await TestBed.configureTestingModule({
      imports: [AdminCategoriesPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: CategoryAdminService, useValue: mockCategoryAdmin },
        { provide: SchemaService, useValue: mockSchema }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(AdminCategoriesPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should load category groups on init', () => {
    expect(mockCategoryAdmin.getCategoryEntityTypes).toHaveBeenCalled();
    expect(component.categoryGroups()).toEqual(mockGroups);
  });

  it('should auto-select first group and load categories', () => {
    expect(component.selectedEntityType()).toBe('building_type');
    expect(mockCategoryAdmin.getCategoriesForEntity).toHaveBeenCalledWith('building_type');
    expect(component.categories()).toEqual(mockCategories);
  });

  it('should switch entity type and reload categories', () => {
    component.onEntityTypeChange('issue_priority');
    expect(component.selectedEntityType()).toBe('issue_priority');
    expect(mockCategoryAdmin.getCategoriesForEntity).toHaveBeenCalledWith('issue_priority');
  });

  it('should compute selectedGroup from selectedEntityType', () => {
    expect(component.selectedGroup()?.entity_type).toBe('building_type');
    component.selectedEntityType.set('issue_priority');
    expect(component.selectedGroup()?.entity_type).toBe('issue_priority');
  });

  describe('Group CRUD', () => {
    it('should open create group modal with empty form', () => {
      component.openCreateGroupModal();
      expect(component.showGroupModal()).toBeTrue();
      expect(component.editingGroup()).toBeNull();
      expect(component.groupForm().entityType).toBe('');
    });

    it('should open edit group modal with selected group data', () => {
      component.openEditGroupModal();
      expect(component.showGroupModal()).toBeTrue();
      expect(component.editingGroup()).toEqual(mockGroups[0]);
      expect(component.groupForm().entityType).toBe('building_type');
    });

    it('should validate entity type format', () => {
      component.openCreateGroupModal();
      component.updateGroupFormField('entityType', 'Invalid-Type');
      component.submitGroup();
      expect(component.groupError()).toContain('lowercase');
    });

    it('should submit group successfully', () => {
      mockCategoryAdmin.upsertCategoryGroup.and.returnValue(of({ success: true }));
      component.openCreateGroupModal();
      component.updateGroupFormField('entityType', 'new_type');
      component.submitGroup();
      expect(mockCategoryAdmin.upsertCategoryGroup).toHaveBeenCalledWith('new_type', undefined, undefined);
      expect(component.showGroupModal()).toBeFalse();
    });
  });

  describe('Category CRUD', () => {
    it('should open create category modal with defaults', () => {
      component.openCreateCategoryModal();
      expect(component.showCategoryModal()).toBeTrue();
      expect(component.editingCategory()).toBeNull();
      expect(component.categoryForm().color).toBe('#3B82F6');
    });

    it('should open edit category modal with category data', () => {
      component.openEditCategoryModal(mockCategories[0]);
      expect(component.showCategoryModal()).toBeTrue();
      expect(component.editingCategory()).toEqual(mockCategories[0]);
      expect(component.categoryForm().displayName).toBe('Residential');
    });

    it('should validate display name required', () => {
      component.openCreateCategoryModal();
      component.submitCategory();
      expect(component.categoryError()).toContain('Display name');
    });

    it('should submit category successfully', () => {
      mockCategoryAdmin.upsertCategory.and.returnValue(of({ success: true, body: { id: 3 } }));
      component.openCreateCategoryModal();
      component.updateCategoryFormField('displayName', 'Industrial');
      component.submitCategory();
      expect(mockCategoryAdmin.upsertCategory).toHaveBeenCalledWith(
        'building_type', 'Industrial', undefined, '#3B82F6', 2, undefined
      );
      expect(component.showCategoryModal()).toBeFalse();
      expect(mockSchema.invalidateCategoryCache).toHaveBeenCalledWith('building_type');
    });

    it('should handle delete category with error response', () => {
      mockCategoryAdmin.deleteCategory.and.returnValue(of({
        success: false,
        error: { message: 'Cannot delete', humanMessage: 'Cannot delete: 3 records reference this category' }
      }));
      component.openDeleteCategoryModal(mockCategories[0]);
      component.submitDeleteCategory();
      expect(component.error()).toContain('Cannot delete');
    });
  });

  describe('Delete Group', () => {
    it('should open and close delete group modal', () => {
      component.openDeleteGroupModal();
      expect(component.showDeleteGroupModal()).toBeTrue();
      component.closeDeleteGroupModal();
      expect(component.showDeleteGroupModal()).toBeFalse();
    });

    it('should delete group and invalidate cache', () => {
      mockCategoryAdmin.deleteCategoryGroup.and.returnValue(of({ success: true }));
      // After delete, loadGroups returns empty so selectedEntityType stays undefined
      mockCategoryAdmin.getCategoryEntityTypes.and.returnValue(of([]));
      component.openDeleteGroupModal();
      component.submitDeleteGroup();
      expect(mockCategoryAdmin.deleteCategoryGroup).toHaveBeenCalledWith('building_type');
      expect(mockSchema.invalidateCategoryCache).toHaveBeenCalledWith('building_type');
      expect(component.selectedEntityType()).toBeUndefined();
    });
  });
});
