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
import { StatusAdminService, StatusType, StatusValue, StatusTransition } from '../../services/status-admin.service';
import { SchemaService } from '../../services/schema.service';

type ActiveTab = 'statuses' | 'transitions';

@Component({
  selector: 'app-admin-statuses',
  standalone: true,
  imports: [CommonModule, FormsModule, CosModalComponent],
  templateUrl: './admin-statuses.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminStatusesPage {
  private statusAdmin = inject(StatusAdminService);
  private schema = inject(SchemaService);

  // Data
  statusTypes = signal<StatusType[]>([]);
  statuses = signal<StatusValue[]>([]);
  transitions = signal<StatusTransition[]>([]);
  selectedEntityType = signal<string | undefined>(undefined);
  activeTab = signal<ActiveTab>('statuses');
  loading = signal(true);
  error = signal<string | undefined>(undefined);
  successMessage = signal<string | undefined>(undefined);

  // Type modal
  showTypeModal = signal(false);
  editingType = signal<StatusType | null>(null);
  typeForm = signal({ entityType: '', displayName: '', description: '' });
  typeError = signal<string | undefined>(undefined);
  typeSaving = signal(false);

  // Status modal
  showStatusModal = signal(false);
  editingStatus = signal<StatusValue | null>(null);
  statusForm = signal({ displayName: '', description: '', color: '#3B82F6', sortOrder: 0, isInitial: false, isTerminal: false });
  statusError = signal<string | undefined>(undefined);
  statusSaving = signal(false);

  // Transition modal
  showTransitionModal = signal(false);
  editingTransition = signal<StatusTransition | null>(null);
  transitionForm = signal({ fromStatusId: 0, toStatusId: 0, displayName: '', description: '', onTransitionRpc: '', sortOrder: 0, isEnabled: true });
  transitionError = signal<string | undefined>(undefined);
  transitionSaving = signal(false);
  nonTerminalStatuses = computed(() => this.statuses().filter(s => !s.is_terminal));

  // Delete modals
  showDeleteTypeModal = signal(false);
  showDeleteStatusModal = signal(false);
  showDeleteTransitionModal = signal(false);
  deletingStatus = signal<StatusValue | null>(null);
  deletingTransition = signal<StatusTransition | null>(null);
  deleteLoading = signal(false);

  // Computed
  selectedType = computed(() => {
    const type = this.selectedEntityType();
    return this.statusTypes().find(t => t.entity_type === type) || null;
  });

  constructor() {
    this.loadTypes();
  }

  // ── Data Loading ──────────────────────────────

  loadTypes() {
    this.loading.set(true);
    this.error.set(undefined);
    this.statusAdmin.getStatusEntityTypes().subscribe(types => {
      this.statusTypes.set(types);
      if (!this.selectedEntityType() && types.length > 0) {
        this.selectedEntityType.set(types[0].entity_type);
        this.loadStatuses(types[0].entity_type);
      } else if (this.selectedEntityType()) {
        this.loadStatuses(this.selectedEntityType()!);
      }
      this.loading.set(false);
    });
  }

  loadStatuses(entityType: string) {
    this.statusAdmin.getStatusesForEntity(entityType).subscribe(statuses => {
      this.statuses.set(statuses);
    });
  }

  loadTransitions(entityType: string) {
    this.statusAdmin.getTransitionsForEntity(entityType).subscribe(transitions => {
      this.transitions.set(transitions);
    });
  }

  onEntityTypeChange(value: string) {
    this.selectedEntityType.set(value);
    this.loadStatuses(value);
    if (this.activeTab() === 'transitions') {
      this.loadTransitions(value);
    }
  }

  switchTab(tab: ActiveTab) {
    this.activeTab.set(tab);
    const entityType = this.selectedEntityType();
    if (tab === 'transitions' && entityType) {
      this.loadTransitions(entityType);
    }
  }

  // ── Type CRUD ─────────────────────────────────

  openCreateTypeModal() {
    this.editingType.set(null);
    this.typeForm.set({ entityType: '', displayName: '', description: '' });
    this.typeError.set(undefined);
    this.showTypeModal.set(true);
  }

  openEditTypeModal() {
    const type = this.selectedType();
    if (!type) return;
    this.editingType.set(type);
    this.typeForm.set({
      entityType: type.entity_type,
      displayName: type.display_name || '',
      description: type.description || ''
    });
    this.typeError.set(undefined);
    this.showTypeModal.set(true);
  }

  closeTypeModal() {
    this.showTypeModal.set(false);
  }

  submitType() {
    const form = this.typeForm();
    const entityType = form.entityType.trim();
    if (!entityType) {
      this.typeError.set('Entity type is required');
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(entityType)) {
      this.typeError.set('Entity type must be lowercase letters, numbers, and underscores (start with letter)');
      return;
    }

    this.typeSaving.set(true);
    this.typeError.set(undefined);

    this.statusAdmin.upsertStatusType(entityType, form.description || undefined, form.displayName.trim() || undefined).subscribe({
      next: (response) => {
        this.typeSaving.set(false);
        if (response.success) {
          this.showTypeModal.set(false);
          this.successMessage.set(this.editingType() ? 'Status type updated' : 'Status type created');
          this.selectedEntityType.set(entityType);
          this.loadTypes();
        } else {
          this.typeError.set(response.error?.humanMessage || 'Failed to save status type');
        }
      },
      error: () => {
        this.typeSaving.set(false);
        this.typeError.set('Failed to save status type');
      }
    });
  }

  openDeleteTypeModal() {
    this.showDeleteTypeModal.set(true);
  }

  closeDeleteTypeModal() {
    this.showDeleteTypeModal.set(false);
  }

  submitDeleteType() {
    const entityType = this.selectedEntityType();
    if (!entityType) return;

    this.deleteLoading.set(true);
    this.statusAdmin.deleteStatusType(entityType).subscribe({
      next: (response) => {
        this.deleteLoading.set(false);
        if (response.success) {
          this.showDeleteTypeModal.set(false);
          this.successMessage.set('Status type deleted');
          this.selectedEntityType.set(undefined);
          this.statuses.set([]);
          this.transitions.set([]);
          this.loadTypes();
          this.schema.invalidateStatusCache(entityType);
        } else {
          this.showDeleteTypeModal.set(false);
          this.error.set(response.error?.humanMessage || 'Failed to delete status type');
        }
      },
      error: () => {
        this.deleteLoading.set(false);
        this.showDeleteTypeModal.set(false);
        this.error.set('Failed to delete status type');
      }
    });
  }

  // ── Status CRUD ───────────────────────────────

  openCreateStatusModal() {
    this.editingStatus.set(null);
    this.statusForm.set({
      displayName: '', description: '', color: '#3B82F6',
      sortOrder: this.statuses().length, isInitial: false, isTerminal: false
    });
    this.statusError.set(undefined);
    this.showStatusModal.set(true);
  }

  openEditStatusModal(status: StatusValue) {
    this.editingStatus.set(status);
    this.statusForm.set({
      displayName: status.display_name,
      description: status.description || '',
      color: status.color || '#3B82F6',
      sortOrder: status.sort_order,
      isInitial: status.is_initial,
      isTerminal: status.is_terminal
    });
    this.statusError.set(undefined);
    this.showStatusModal.set(true);
  }

  closeStatusModal() {
    this.showStatusModal.set(false);
  }

  submitStatus() {
    const form = this.statusForm();
    const entityType = this.selectedEntityType();
    if (!entityType) return;

    if (!form.displayName.trim()) {
      this.statusError.set('Display name is required');
      return;
    }

    this.statusSaving.set(true);
    this.statusError.set(undefined);
    const editing = this.editingStatus();

    this.statusAdmin.upsertStatus(
      entityType,
      form.displayName.trim(),
      form.description || undefined,
      form.color,
      form.sortOrder,
      form.isInitial,
      form.isTerminal,
      editing?.id
    ).subscribe({
      next: (response) => {
        this.statusSaving.set(false);
        if (response.success) {
          this.showStatusModal.set(false);
          this.successMessage.set(editing ? 'Status updated' : 'Status created');
          this.loadStatuses(entityType);
          this.loadTypes();
          this.schema.invalidateStatusCache(entityType);
        } else {
          this.statusError.set(response.error?.humanMessage || 'Failed to save status');
        }
      },
      error: () => {
        this.statusSaving.set(false);
        this.statusError.set('Failed to save status');
      }
    });
  }

  openDeleteStatusModal(status: StatusValue) {
    this.deletingStatus.set(status);
    this.showDeleteStatusModal.set(true);
  }

  closeDeleteStatusModal() {
    this.showDeleteStatusModal.set(false);
    this.deletingStatus.set(null);
  }

  submitDeleteStatus() {
    const status = this.deletingStatus();
    const entityType = this.selectedEntityType();
    if (!status || !entityType) return;

    this.deleteLoading.set(true);
    this.statusAdmin.deleteStatus(status.id).subscribe({
      next: (response) => {
        this.deleteLoading.set(false);
        if (response.success) {
          this.showDeleteStatusModal.set(false);
          this.deletingStatus.set(null);
          this.successMessage.set('Status deleted');
          this.loadStatuses(entityType);
          this.loadTypes();
          this.schema.invalidateStatusCache(entityType);
        } else {
          this.showDeleteStatusModal.set(false);
          this.deletingStatus.set(null);
          this.error.set(response.error?.humanMessage || 'Failed to delete status');
        }
      },
      error: () => {
        this.deleteLoading.set(false);
        this.showDeleteStatusModal.set(false);
        this.error.set('Failed to delete status');
      }
    });
  }

  // ── Transition CRUD ───────────────────────────

  openCreateTransitionModal() {
    const nonTerminal = this.nonTerminalStatuses();
    const allStatuses = this.statuses();
    this.editingTransition.set(null);
    this.transitionForm.set({
      fromStatusId: nonTerminal.length > 0 ? nonTerminal[0].id : 0,
      toStatusId: allStatuses.length > 1 ? allStatuses[1].id : (allStatuses.length > 0 ? allStatuses[0].id : 0),
      displayName: '', description: '', onTransitionRpc: '',
      sortOrder: this.transitions().length, isEnabled: true
    });
    this.transitionError.set(undefined);
    this.showTransitionModal.set(true);
  }

  openEditTransitionModal(transition: StatusTransition) {
    this.editingTransition.set(transition);
    this.transitionForm.set({
      fromStatusId: transition.from_status_id,
      toStatusId: transition.to_status_id,
      displayName: transition.display_name || '',
      description: transition.description || '',
      onTransitionRpc: transition.on_transition_rpc || '',
      sortOrder: transition.sort_order,
      isEnabled: transition.is_enabled
    });
    this.transitionError.set(undefined);
    this.showTransitionModal.set(true);
  }

  closeTransitionModal() {
    this.showTransitionModal.set(false);
  }

  submitTransition() {
    const form = this.transitionForm();
    const entityType = this.selectedEntityType();
    if (!entityType) return;

    if (!form.fromStatusId || !form.toStatusId) {
      this.transitionError.set('From and To statuses are required');
      return;
    }
    if (form.fromStatusId === form.toStatusId) {
      this.transitionError.set('From and To statuses must be different');
      return;
    }

    this.transitionSaving.set(true);
    this.transitionError.set(undefined);
    const editing = this.editingTransition();

    this.statusAdmin.upsertTransition(
      entityType,
      form.fromStatusId,
      form.toStatusId,
      form.onTransitionRpc || undefined,
      form.displayName || undefined,
      form.description || undefined,
      form.sortOrder,
      form.isEnabled,
      editing?.id
    ).subscribe({
      next: (response) => {
        this.transitionSaving.set(false);
        if (response.success) {
          this.showTransitionModal.set(false);
          this.successMessage.set(editing ? 'Transition updated' : 'Transition created');
          this.loadTransitions(entityType);
        } else {
          this.transitionError.set(response.error?.humanMessage || 'Failed to save transition');
        }
      },
      error: () => {
        this.transitionSaving.set(false);
        this.transitionError.set('Failed to save transition');
      }
    });
  }

  openDeleteTransitionModal(transition: StatusTransition) {
    this.deletingTransition.set(transition);
    this.showDeleteTransitionModal.set(true);
  }

  closeDeleteTransitionModal() {
    this.showDeleteTransitionModal.set(false);
    this.deletingTransition.set(null);
  }

  submitDeleteTransition() {
    const transition = this.deletingTransition();
    const entityType = this.selectedEntityType();
    if (!transition || !entityType) return;

    this.deleteLoading.set(true);
    this.statusAdmin.deleteTransition(transition.id).subscribe({
      next: (response) => {
        this.deleteLoading.set(false);
        if (response.success) {
          this.showDeleteTransitionModal.set(false);
          this.deletingTransition.set(null);
          this.successMessage.set('Transition deleted');
          this.loadTransitions(entityType);
        } else {
          this.showDeleteTransitionModal.set(false);
          this.deletingTransition.set(null);
          this.error.set(response.error?.humanMessage || 'Failed to delete transition');
        }
      },
      error: () => {
        this.deleteLoading.set(false);
        this.showDeleteTransitionModal.set(false);
        this.error.set('Failed to delete transition');
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

  updateTypeFormField(field: 'entityType' | 'displayName' | 'description', value: string) {
    this.typeForm.update(f => ({ ...f, [field]: value }));
  }

  updateStatusFormField(field: 'displayName' | 'description' | 'color', value: string) {
    this.statusForm.update(f => ({ ...f, [field]: value }));
  }

  updateStatusSortOrder(value: number) {
    this.statusForm.update(f => ({ ...f, sortOrder: value }));
  }

  updateStatusBool(field: 'isInitial' | 'isTerminal', value: boolean) {
    this.statusForm.update(f => ({ ...f, [field]: value }));
  }

  updateTransitionFormField(field: 'displayName' | 'description' | 'onTransitionRpc', value: string) {
    this.transitionForm.update(f => ({ ...f, [field]: value }));
  }

  updateTransitionStatusId(field: 'fromStatusId' | 'toStatusId', value: number) {
    this.transitionForm.update(f => ({ ...f, [field]: value }));
  }

  updateTransitionSortOrder(value: number) {
    this.transitionForm.update(f => ({ ...f, sortOrder: value }));
  }

  updateTransitionEnabled(value: boolean) {
    this.transitionForm.update(f => ({ ...f, isEnabled: value }));
  }
}
