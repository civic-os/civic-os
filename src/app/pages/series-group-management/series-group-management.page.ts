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

import { Component, signal, inject, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { SeriesGroup, SchemaEntityTable, CreateSeriesResult } from '../../interfaces/entity';
import { RecurringService } from '../../services/recurring.service';
import { SchemaService } from '../../services/schema.service';
import { AuthService } from '../../services/auth.service';
import { SeriesGroupDetailComponent } from '../../components/series-group-detail/series-group-detail.component';
import { CreateSeriesWizardComponent } from '../../components/create-series-wizard/create-series-wizard.component';
import { CosModalComponent } from '../../components/cos-modal/cos-modal.component';
import { of, forkJoin } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

/**
 * Series Group Management Page
 *
 * Admin page for managing recurring schedules (series groups).
 * Provides list view with filters, detail panel, and create wizard.
 *
 * Route: /admin/recurring-schedules
 * Permission: time_slot_series_groups:read
 *
 * Added in v0.19.0.
 */
@Component({
  selector: 'app-series-group-management-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SeriesGroupDetailComponent,
    CreateSeriesWizardComponent,
    CosModalComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="container mx-auto px-4 py-6">
      <!-- Header -->
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold">Recurring Schedules</h1>
          <p class="text-base-content/70">Manage recurring time slot series</p>
        </div>
        @if (hasPermission() && hasCreatePermission()) {
          <button class="btn btn-primary" (click)="openCreateWizard()">
            <span class="material-symbols-outlined">add</span>
            Create Series
          </button>
        }
      </div>

      @if (!hasPermission()) {
        <div class="alert alert-warning">
          <span class="material-symbols-outlined">lock</span>
          <span>You don't have permission to view recurring schedules.</span>
        </div>
      } @else {
        <!-- Filters -->
        <div class="bg-base-200 rounded-lg p-4 mb-6">
          <div class="flex flex-wrap gap-4">
            <!-- Search -->
            <div class="form-control flex-1 min-w-[200px]">
              <label class="input input-bordered flex items-center gap-2 w-full">
                <span class="material-symbols-outlined text-base-content/50">search</span>
                <input
                  type="text"
                  class="grow"
                  placeholder="Search by name..."
                  [ngModel]="searchQuery()"
                  (ngModelChange)="onSearchChange($event)"
                />
              </label>
            </div>

            <!-- Entity Type Filter -->
            <div class="form-control w-48">
              <select
                class="select select-bordered w-full"
                [ngModel]="entityTypeFilter()"
                (ngModelChange)="onEntityTypeChange($event)"
              >
                <option value="">All Entity Types</option>
                @for (type of entityTypes(); track type) {
                  <option [value]="type">{{ type }}</option>
                }
              </select>
            </div>

            <!-- Status Filter -->
            <div class="form-control w-40">
              <select
                class="select select-bordered w-full"
                [ngModel]="statusFilter()"
                (ngModelChange)="onStatusChange($event)"
              >
                <option value="">All Status</option>
                <option value="active">Active</option>
                <option value="terminated">Terminated</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Main Content: List + Detail Panel -->
        <div class="flex gap-6">
          <!-- Groups List -->
          <div class="flex-1">
            @if (loading()) {
              <div class="flex items-center justify-center py-12">
                <span class="loading loading-spinner loading-lg"></span>
              </div>
            } @else if (filteredGroups().length === 0) {
              <div class="text-center py-12">
                <span class="material-symbols-outlined text-6xl text-base-content/30 mb-4">event_repeat</span>
                <p class="text-lg text-base-content/70">No recurring schedules found</p>
                @if (searchQuery() || entityTypeFilter() || statusFilter()) {
                  <button class="btn btn-ghost btn-sm mt-4" (click)="clearFilters()">
                    Clear Filters
                  </button>
                } @else if (hasCreatePermission()) {
                  <button class="btn btn-primary btn-sm mt-4" (click)="openCreateWizard()">
                    <span class="material-symbols-outlined">add</span>
                    Create your first series
                  </button>
                }
              </div>
            } @else {
              <div class="space-y-3">
                @for (group of filteredGroups(); track group.id) {
                  <div
                    class="card bg-base-100 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                    [class.ring-2]="selectedGroupId() === group.id"
                    [class.ring-primary]="selectedGroupId() === group.id"
                    (click)="selectGroup(group)"
                  >
                    <div class="card-body p-4">
                      <div class="flex items-start gap-3">
                        <!-- Color indicator -->
                        @if (group.color) {
                          <div
                            class="w-3 h-3 rounded-full mt-1.5 flex-shrink-0"
                            [style.background-color]="group.color"
                          ></div>
                        }

                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2 flex-wrap">
                            <h3 class="font-semibold truncate">{{ group.display_name }}</h3>
                            <span class="badge badge-ghost badge-sm">{{ group.entity_table }}</span>
                            @if (isGroupActive(group)) {
                              <span class="badge badge-success badge-sm">Active</span>
                            } @else {
                              <span class="badge badge-ghost badge-sm">Terminated</span>
                            }
                          </div>

                          @if (group.description) {
                            <p class="text-sm text-base-content/70 truncate mt-1">{{ group.description }}</p>
                          }

                          <div class="flex items-center gap-4 mt-2 text-sm text-base-content/60">
                            <span class="flex items-center gap-1">
                              <span class="material-symbols-outlined text-sm">schedule</span>
                              {{ group.version_count || 1 }} version(s)
                            </span>
                            <span class="flex items-center gap-1">
                              <span class="material-symbols-outlined text-sm">event</span>
                              {{ group.active_instance_count || 0 }} occurrences
                            </span>
                            <span class="flex items-center gap-1">
                              <span class="material-symbols-outlined text-sm">date_range</span>
                              {{ getFirstInstanceDate(group) }} – {{ getEndDateDisplay(group) }}
                            </span>
                          </div>
                        </div>

                        <span class="material-symbols-outlined text-base-content/30">chevron_right</span>
                      </div>
                    </div>
                  </div>
                }
              </div>
            }
          </div>

          <!-- Detail Panel -->
          @if (selectedGroupId()) {
            <div class="w-96 flex-shrink-0">
              <div class="card bg-base-100 shadow-lg sticky top-4">
                <div class="card-body">
                  <app-series-group-detail
                    [group]="selectedGroup()"
                    [loading]="loadingDetail()"
                    (delete)="onDeleteGroup($event)"
                    (updated)="onGroupUpdated($event)"
                    (close)="closeDetail()"
                  ></app-series-group-detail>
                </div>
              </div>
            </div>
          }
        </div>
      }
    </div>

    <!-- Delete Confirmation Modal -->
    <cos-modal [isOpen]="showDeleteModal()" (closed)="cancelDelete()" size="sm">
      <h3 class="font-bold text-lg">Delete Recurring Series?</h3>
      <p class="py-4">
        This will permanently delete the series "{{ groupToDelete()?.display_name }}"
        and all {{ groupToDelete()?.active_instance_count || 0 }} occurrences.
        This action cannot be undone.
      </p>
      <div class="cos-modal-action">
        <button class="btn btn-ghost" (click)="cancelDelete()">Cancel</button>
        <button class="btn btn-error" (click)="confirmDelete()" [disabled]="deleting()">
          @if (deleting()) {
            <span class="loading loading-spinner loading-sm"></span>
          }
          Delete Series
        </button>
      </div>
    </cos-modal>

    <!-- Create Series Wizard -->
    <app-create-series-wizard
      [isOpen]="showCreateWizard()"
      [availableEntities]="recurringEntities()"
      (created)="onSeriesCreated($event)"
      (cancel)="closeCreateWizard()"
    ></app-create-series-wizard>
  `
})
export class SeriesGroupManagementPage implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private recurringService = inject(RecurringService);
  private schemaService = inject(SchemaService);
  private authService = inject(AuthService);

  // State
  groups = signal<SeriesGroup[]>([]);
  loading = signal(true);
  hasPermission = signal(true);
  hasCreatePermission = signal(false);

  // Filters
  searchQuery = signal('');
  entityTypeFilter = signal('');
  statusFilter = signal('');
  entityTypes = signal<string[]>([]);

  // Selection
  selectedGroupId = signal<number | undefined>(undefined);
  selectedGroup = signal<SeriesGroup | undefined>(undefined);
  loadingDetail = signal(false);

  // Delete modal
  showDeleteModal = signal(false);
  groupToDelete = signal<SeriesGroup | undefined>(undefined);
  deleting = signal(false);

  // Create wizard
  showCreateWizard = signal(false);
  recurringEntities = signal<SchemaEntityTable[]>([]);

  // Computed filtered list
  filteredGroups = signal<SeriesGroup[]>([]);

  ngOnInit(): void {
    // Check permissions
    forkJoin([
      this.authService.hasPermission('time_slot_series_groups', 'read'),
      this.authService.hasPermission('time_slot_series_groups', 'create')
    ]).subscribe(([hasRead, hasCreate]: [boolean, boolean]) => {
      this.hasPermission.set(hasRead);
      this.hasCreatePermission.set(hasCreate);

      if (hasRead) {
        this.loadGroups();
        this.loadRecurringEntities();
      } else {
        this.loading.set(false);
      }
    });

    // Check for groupId in route
    this.route.params.subscribe(params => {
      if (params['groupId']) {
        this.selectGroupById(parseInt(params['groupId'], 10));
      }
    });
  }

  private loadGroups(): void {
    this.loading.set(true);
    this.recurringService.getSeriesGroups().subscribe({
      next: (groups) => {
        this.groups.set(groups);
        this.updateFilteredGroups();
        this.extractEntityTypes(groups);
        this.loading.set(false);
      },
      error: () => {
        this.groups.set([]);
        this.loading.set(false);
      }
    });
  }

  private loadRecurringEntities(): void {
    // Get entities that have supports_recurring = true (entity-level config)
    this.schemaService.getEntities().pipe(
      map(entities => entities.filter(e => e.supports_recurring === true)),
      catchError(() => of([]))
    ).subscribe(entities => {
      this.recurringEntities.set(entities);
    });
  }

  private extractEntityTypes(groups: SeriesGroup[]): void {
    const types = [...new Set(groups.map(g => g.entity_table).filter((t): t is string => !!t))].sort();
    this.entityTypes.set(types);
  }

  private updateFilteredGroups(): void {
    let filtered = this.groups();

    // Search filter
    const search = this.searchQuery().toLowerCase();
    if (search) {
      filtered = filtered.filter(g =>
        g.display_name.toLowerCase().includes(search) ||
        g.description?.toLowerCase().includes(search)
      );
    }

    // Entity type filter
    const entityType = this.entityTypeFilter();
    if (entityType) {
      filtered = filtered.filter(g => g.entity_table === entityType);
    }

    // Status filter
    const status = this.statusFilter();
    if (status === 'active') {
      filtered = filtered.filter(g => this.isGroupActive(g));
    } else if (status === 'terminated') {
      filtered = filtered.filter(g => !this.isGroupActive(g));
    }

    this.filteredGroups.set(filtered);
  }

  isGroupActive(group: SeriesGroup): boolean {
    // A group is active if any of its versions is not terminated
    if (group.versions) {
      return group.versions.some(v => !v.terminated_at);
    }
    return true;
  }

  onSearchChange(value: string): void {
    this.searchQuery.set(value);
    this.updateFilteredGroups();
  }

  onEntityTypeChange(value: string): void {
    this.entityTypeFilter.set(value);
    this.updateFilteredGroups();
  }

  onStatusChange(value: string): void {
    this.statusFilter.set(value);
    this.updateFilteredGroups();
  }

  clearFilters(): void {
    this.searchQuery.set('');
    this.entityTypeFilter.set('');
    this.statusFilter.set('');
    this.updateFilteredGroups();
  }

  selectGroup(group: SeriesGroup): void {
    this.selectedGroupId.set(group.id);
    this.loadGroupDetail(group.id);

    // Update URL
    this.router.navigate(['/admin/recurring-schedules', group.id], { replaceUrl: true });
  }

  selectGroupById(id: number): void {
    this.selectedGroupId.set(id);
    this.loadGroupDetail(id);
  }

  private loadGroupDetail(id: number): void {
    this.loadingDetail.set(true);
    this.recurringService.getSeriesGroupDetail(id).subscribe({
      next: (group) => {
        this.selectedGroup.set(group ?? undefined);
        this.loadingDetail.set(false);
      },
      error: () => {
        this.selectedGroup.set(undefined);
        this.loadingDetail.set(false);
      }
    });
  }

  closeDetail(): void {
    this.selectedGroupId.set(undefined);
    this.selectedGroup.set(undefined);
    this.router.navigate(['/admin/recurring-schedules'], { replaceUrl: true });
  }

  onGroupUpdated(group: SeriesGroup): void {
    // Update local state with new group info
    this.selectedGroup.set(group);

    // Update in the groups list
    const groups = this.groups();
    const index = groups.findIndex(g => g.id === group.id);
    if (index >= 0) {
      const updatedGroups = [...groups];
      updatedGroups[index] = { ...groups[index], ...group };
      this.groups.set(updatedGroups);
      this.updateFilteredGroups();
    }
  }

  onDeleteGroup(group: SeriesGroup): void {
    this.groupToDelete.set(group);
    this.showDeleteModal.set(true);
  }

  cancelDelete(): void {
    this.showDeleteModal.set(false);
    this.groupToDelete.set(undefined);
  }

  confirmDelete(): void {
    const group = this.groupToDelete();
    if (!group) return;

    this.deleting.set(true);
    this.recurringService.deleteSeriesGroup(group.id).subscribe({
      next: () => {
        this.deleting.set(false);
        this.showDeleteModal.set(false);
        this.groupToDelete.set(undefined);
        this.closeDetail();
        this.loadGroups();
      },
      error: () => {
        this.deleting.set(false);
      }
    });
  }

  // Create wizard methods
  openCreateWizard(): void {
    this.showCreateWizard.set(true);
  }

  closeCreateWizard(): void {
    this.showCreateWizard.set(false);
  }

  onSeriesCreated(result: CreateSeriesResult): void {
    this.showCreateWizard.set(false);
    this.loadGroups();

    // Navigate to the new series if we have a group_id
    if (result.group_id) {
      this.selectGroupById(result.group_id);
      this.router.navigate(['/admin/recurring-schedules', result.group_id], { replaceUrl: true });
    }
  }

  formatDate(dateStr: string | undefined): string {
    if (!dateStr) return '—';
    try {
      // Handle date-only strings by appending time to avoid UTC interpretation
      const localDate = dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00`;
      return new Date(localDate).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    } catch {
      return dateStr;
    }
  }

  getFirstInstanceDate(group: SeriesGroup): string {
    // Use first actual instance date instead of dtstart anchor
    if (group.instances && group.instances.length > 0) {
      return this.formatDate(group.instances[0].occurrence_date);
    }
    // Fallback to started_on if no instances
    return this.formatDate(group.started_on);
  }

  getEndDateDisplay(group: SeriesGroup): string {
    // If group has a terminated status or all versions are terminated, show end date
    if (group.status === 'ended') {
      // Try to get the last expanded_until from current_version
      const expandedUntil = (group.current_version as any)?.expanded_until;
      if (expandedUntil) {
        return this.formatDate(expandedUntil);
      }
      return 'Ended';
    }

    // If active, show expanded_until or "Ongoing"
    const expandedUntil = (group.current_version as any)?.expanded_until;
    if (expandedUntil) {
      return this.formatDate(expandedUntil);
    }

    return 'Ongoing';
  }
}
