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

import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CosModalComponent } from '../../components/cos-modal/cos-modal.component';
import { CategoryAdminService, CategoryGroup, CategoryValue } from '../../services/category-admin.service';
import { SchemaService } from '../../services/schema.service';

@Component({
  selector: 'app-admin-categories',
  standalone: true,
  imports: [CommonModule, FormsModule, CosModalComponent],
  templateUrl: './admin-categories.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminCategoriesPage {
  private categoryAdmin = inject(CategoryAdminService);
  private schema = inject(SchemaService);

  // Data
  categoryGroups = signal<CategoryGroup[]>([]);
  categories = signal<CategoryValue[]>([]);
  selectedEntityType = signal<string | undefined>(undefined);
  loading = signal(true);
  error = signal<string | undefined>(undefined);
  successMessage = signal<string | undefined>(undefined);

  // Group modal
  showGroupModal = signal(false);
  editingGroup = signal<CategoryGroup | null>(null);
  groupForm = signal({ entityType: '', displayName: '', description: '' });
  groupError = signal<string | undefined>(undefined);
  groupSaving = signal(false);

  // Category modal
  showCategoryModal = signal(false);
  editingCategory = signal<CategoryValue | null>(null);
  categoryForm = signal({ displayName: '', description: '', color: '#3B82F6', sortOrder: 0 });
  categoryError = signal<string | undefined>(undefined);
  categorySaving = signal(false);

  // Delete confirmation
  showDeleteGroupModal = signal(false);
  showDeleteCategoryModal = signal(false);
  deletingCategory = signal<CategoryValue | null>(null);
  deleteLoading = signal(false);

  // Computed
  selectedGroup = computed(() => {
    const type = this.selectedEntityType();
    return this.categoryGroups().find(g => g.entity_type === type) || null;
  });

  constructor() {
    this.loadGroups();
  }

  // ── Data Loading ──────────────────────────────

  loadGroups() {
    this.loading.set(true);
    this.error.set(undefined);
    this.categoryAdmin.getCategoryEntityTypes().subscribe(groups => {
      this.categoryGroups.set(groups);
      // Auto-select first if none selected
      if (!this.selectedEntityType() && groups.length > 0) {
        this.selectedEntityType.set(groups[0].entity_type);
        this.loadCategories(groups[0].entity_type);
      } else if (this.selectedEntityType()) {
        this.loadCategories(this.selectedEntityType()!);
      }
      this.loading.set(false);
    });
  }

  loadCategories(entityType: string) {
    this.categoryAdmin.getCategoriesForEntity(entityType).subscribe(categories => {
      this.categories.set(categories);
    });
  }

  onEntityTypeChange(value: string) {
    this.selectedEntityType.set(value);
    this.loadCategories(value);
  }

  // ── Group CRUD ────────────────────────────────

  openCreateGroupModal() {
    this.editingGroup.set(null);
    this.groupForm.set({ entityType: '', displayName: '', description: '' });
    this.groupError.set(undefined);
    this.showGroupModal.set(true);
  }

  openEditGroupModal() {
    const group = this.selectedGroup();
    if (!group) return;
    this.editingGroup.set(group);
    this.groupForm.set({
      entityType: group.entity_type,
      displayName: group.display_name || '',
      description: group.description || ''
    });
    this.groupError.set(undefined);
    this.showGroupModal.set(true);
  }

  closeGroupModal() {
    this.showGroupModal.set(false);
  }

  submitGroup() {
    const form = this.groupForm();
    const entityType = form.entityType.trim();
    if (!entityType) {
      this.groupError.set('Entity type is required');
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(entityType)) {
      this.groupError.set('Entity type must be lowercase letters, numbers, and underscores (start with letter)');
      return;
    }

    this.groupSaving.set(true);
    this.groupError.set(undefined);

    this.categoryAdmin.upsertCategoryGroup(entityType, form.description || undefined, form.displayName.trim() || undefined).subscribe({
      next: (response) => {
        this.groupSaving.set(false);
        if (response.success) {
          this.showGroupModal.set(false);
          this.successMessage.set(this.editingGroup() ? 'Category group updated' : 'Category group created');
          this.selectedEntityType.set(entityType);
          this.loadGroups();
        } else {
          this.groupError.set(response.error?.humanMessage || 'Failed to save category group');
        }
      },
      error: () => {
        this.groupSaving.set(false);
        this.groupError.set('Failed to save category group');
      }
    });
  }

  openDeleteGroupModal() {
    this.showDeleteGroupModal.set(true);
  }

  closeDeleteGroupModal() {
    this.showDeleteGroupModal.set(false);
  }

  submitDeleteGroup() {
    const entityType = this.selectedEntityType();
    if (!entityType) return;

    this.deleteLoading.set(true);
    this.categoryAdmin.deleteCategoryGroup(entityType).subscribe({
      next: (response) => {
        this.deleteLoading.set(false);
        if (response.success) {
          this.showDeleteGroupModal.set(false);
          this.successMessage.set('Category group deleted');
          this.selectedEntityType.set(undefined);
          this.categories.set([]);
          this.loadGroups();
          this.schema.invalidateCategoryCache(entityType);
        } else {
          this.showDeleteGroupModal.set(false);
          this.error.set(response.error?.humanMessage || 'Failed to delete category group');
        }
      },
      error: () => {
        this.deleteLoading.set(false);
        this.showDeleteGroupModal.set(false);
        this.error.set('Failed to delete category group');
      }
    });
  }

  // ── Category CRUD ─────────────────────────────

  openCreateCategoryModal() {
    this.editingCategory.set(null);
    this.categoryForm.set({ displayName: '', description: '', color: '#3B82F6', sortOrder: this.categories().length });
    this.categoryError.set(undefined);
    this.showCategoryModal.set(true);
  }

  openEditCategoryModal(category: CategoryValue) {
    this.editingCategory.set(category);
    this.categoryForm.set({
      displayName: category.display_name,
      description: category.description || '',
      color: category.color || '#3B82F6',
      sortOrder: category.sort_order
    });
    this.categoryError.set(undefined);
    this.showCategoryModal.set(true);
  }

  closeCategoryModal() {
    this.showCategoryModal.set(false);
  }

  submitCategory() {
    const form = this.categoryForm();
    const entityType = this.selectedEntityType();
    if (!entityType) return;

    if (!form.displayName.trim()) {
      this.categoryError.set('Display name is required');
      return;
    }

    this.categorySaving.set(true);
    this.categoryError.set(undefined);
    const editing = this.editingCategory();

    this.categoryAdmin.upsertCategory(
      entityType,
      form.displayName.trim(),
      form.description || undefined,
      form.color,
      form.sortOrder,
      editing?.id
    ).subscribe({
      next: (response) => {
        this.categorySaving.set(false);
        if (response.success) {
          this.showCategoryModal.set(false);
          this.successMessage.set(editing ? 'Category updated' : 'Category created');
          this.loadCategories(entityType);
          this.loadGroups();
          this.schema.invalidateCategoryCache(entityType);
        } else {
          this.categoryError.set(response.error?.humanMessage || 'Failed to save category');
        }
      },
      error: () => {
        this.categorySaving.set(false);
        this.categoryError.set('Failed to save category');
      }
    });
  }

  openDeleteCategoryModal(category: CategoryValue) {
    this.deletingCategory.set(category);
    this.showDeleteCategoryModal.set(true);
  }

  closeDeleteCategoryModal() {
    this.showDeleteCategoryModal.set(false);
    this.deletingCategory.set(null);
  }

  submitDeleteCategory() {
    const category = this.deletingCategory();
    const entityType = this.selectedEntityType();
    if (!category || !entityType) return;

    this.deleteLoading.set(true);
    this.categoryAdmin.deleteCategory(category.id).subscribe({
      next: (response) => {
        this.deleteLoading.set(false);
        if (response.success) {
          this.showDeleteCategoryModal.set(false);
          this.deletingCategory.set(null);
          this.successMessage.set('Category deleted');
          this.loadCategories(entityType);
          this.loadGroups();
          this.schema.invalidateCategoryCache(entityType);
        } else {
          this.showDeleteCategoryModal.set(false);
          this.deletingCategory.set(null);
          this.error.set(response.error?.humanMessage || 'Failed to delete category');
        }
      },
      error: () => {
        this.deleteLoading.set(false);
        this.showDeleteCategoryModal.set(false);
        this.error.set('Failed to delete category');
      }
    });
  }

  // ── Helpers ───────────────────────────────────

  dismissSuccess() {
    this.successMessage.set(undefined);
  }

  dismissError() {
    this.error.set(undefined);
  }

  updateGroupFormField(field: 'entityType' | 'displayName' | 'description', value: string) {
    this.groupForm.update(f => ({ ...f, [field]: value }));
  }

  updateCategoryFormField(field: 'displayName' | 'description' | 'color', value: string) {
    this.categoryForm.update(f => ({ ...f, [field]: value }));
  }

  updateCategorySortOrder(value: number) {
    this.categoryForm.update(f => ({ ...f, sortOrder: value }));
  }
}
