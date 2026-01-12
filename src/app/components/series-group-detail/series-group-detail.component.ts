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

import {
  Component,
  Input,
  Output,
  EventEmitter,
  signal,
  computed,
  ChangeDetectionStrategy,
  inject,
  OnChanges,
  SimpleChanges
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, FormControl } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin, of, Observable } from 'rxjs';
import { switchMap, catchError, tap, map, take } from 'rxjs/operators';
import { SeriesGroup, SeriesVersionSummary, SeriesInstanceSummary, SchemaEntityProperty, EntityPropertyType } from '../../interfaces/entity';
import { SeriesVersionTimelineComponent } from '../series-version-timeline/series-version-timeline.component';
import { RecurringScheduleFormComponent, RecurringScheduleValue } from '../recurring-schedule-form/recurring-schedule-form.component';
import { EditPropertyComponent } from '../edit-property/edit-property.component';
import { CosModalComponent } from '../cos-modal/cos-modal.component';
import { RecurringService } from '../../services/recurring.service';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';

/** Resolved template value with display info */
interface ResolvedValue {
  raw: any;
  display: string;
  type: EntityPropertyType;
  color?: string;  // For status badges
}

type EditTab = 'info' | 'schedule' | 'template';

/**
 * Series Group Detail Component
 *
 * Displays detailed information about a series group including:
 * - Group metadata (name, description, color)
 * - Current schedule (RRULE, start time, duration)
 * - Current template values
 * - Version timeline
 * - Full instance listing with tabs (Upcoming/Past/Exceptions/All)
 * - Unified edit experience with optional "effective from" for series splitting
 *
 * Usage:
 * ```html
 * <app-series-group-detail
 *   [group]="selectedGroup"
 *   [loading]="loadingGroup"
 *   (edit)="onEditGroup($event)"
 *   (delete)="onDeleteGroup($event)"
 *   (close)="onCloseDetail()"
 * ></app-series-group-detail>
 * ```
 *
 * Added in v0.19.0.
 */
@Component({
  selector: 'app-series-group-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    SeriesVersionTimelineComponent,
    RecurringScheduleFormComponent,
    EditPropertyComponent,
    CosModalComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading) {
      <div class="flex items-center justify-center py-12">
        <span class="loading loading-spinner loading-lg"></span>
      </div>
    } @else if (group) {
      <div class="space-y-6">
        <!-- Header -->
        <div class="flex items-start justify-between">
          <div class="flex items-start gap-3">
            @if (group.color) {
              <div
                class="w-4 h-4 rounded-full mt-1 flex-shrink-0"
                [style.background-color]="group.color"
              ></div>
            }
            <div>
              <h2 class="text-xl font-bold">{{ group.display_name }}</h2>
              @if (group.description) {
                <p class="text-base-content/70 mt-1">{{ group.description }}</p>
              }
            </div>
          </div>

          <button class="btn btn-ghost btn-sm btn-circle" (click)="onClose()">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>

        <!-- Stats -->
        <div class="grid grid-cols-3 gap-3">
          <div class="bg-base-200 rounded-lg p-3">
            <div class="text-xs text-base-content/60 mb-1">Entity Type</div>
            <div class="font-semibold text-sm truncate" [title]="group.entity_table">{{ group.entity_table }}</div>
          </div>
          <div class="bg-base-200 rounded-lg p-3">
            <div class="text-xs text-base-content/60 mb-1">Versions</div>
            <div class="font-bold text-xl">{{ group.version_count || group.versions?.length || 0 }}</div>
          </div>
          <div class="bg-base-200 rounded-lg p-3">
            <div class="text-xs text-base-content/60 mb-1">Total Instances</div>
            <div class="font-bold text-xl">{{ group.active_instance_count || 0 }}</div>
          </div>
        </div>

        <!-- Current Schedule Section -->
        @if (currentVersion()) {
          <div class="bg-base-200 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-semibold flex items-center gap-2">
                <span class="material-symbols-outlined text-base">schedule</span>
                Schedule
              </h3>
              <button class="btn btn-ghost btn-xs" (click)="openEditModal('schedule')">
                <span class="material-symbols-outlined text-sm">edit</span>
              </button>
            </div>
            <table class="table table-xs w-full">
              <tbody>
                <tr>
                  <td class="text-base-content/60 whitespace-nowrap w-1/3 align-middle py-1">Recurrence</td>
                  <td class="text-right py-1">{{ rruleDescription() }}</td>
                </tr>
                <tr>
                  <td class="text-base-content/60 whitespace-nowrap w-1/3 align-middle py-1">Start</td>
                  <td class="text-right py-1">{{ formatDateTime(currentVersion()!.dtstart) }}</td>
                </tr>
                <tr>
                  <td class="text-base-content/60 whitespace-nowrap w-1/3 align-middle py-1">Duration</td>
                  <td class="text-right py-1">{{ formatDuration(currentVersion()!.duration) }}</td>
                </tr>
                <tr>
                  <td class="text-base-content/60 whitespace-nowrap w-1/3 align-middle py-1">Status</td>
                  <td class="text-right py-1">
                    <span class="badge badge-sm"
                      [class.badge-success]="currentVersion()!.status === 'active'"
                      [class.badge-warning]="currentVersion()!.status === 'needs_attention'"
                      [class.badge-ghost]="currentVersion()!.status === 'ended'"
                    >{{ currentVersion()!.status }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        }

        <!-- Current Template Section -->
        @if (currentVersion()?.entity_template && templateProperties().length > 0) {
          <div class="bg-base-200 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-semibold flex items-center gap-2">
                <span class="material-symbols-outlined text-base">description</span>
                Template
              </h3>
              <button class="btn btn-ghost btn-xs" (click)="openEditModal('template')">
                <span class="material-symbols-outlined text-sm">edit</span>
              </button>
            </div>
            @if (loadingTemplate()) {
              <div class="flex items-center gap-2 text-sm text-base-content/60">
                <span class="loading loading-spinner loading-xs"></span>
                Loading template values...
              </div>
            } @else {
              <table class="table table-xs w-full">
                <tbody>
                  @for (prop of templateProperties(); track prop.column_name) {
                    @let resolved = getResolvedValue(prop.column_name);
                    <tr>
                      <td class="text-base-content/60 whitespace-nowrap w-1/3 align-middle py-1">
                        {{ prop.display_name || prop.column_name }}
                      </td>
                      <td class="text-right py-1">
                        @if (!resolved || !resolved.display) {
                          <span class="text-base-content/40">—</span>
                        } @else if (resolved.type === EntityPropertyType.Status) {
                          <span
                            class="badge badge-sm text-white"
                            [style.background-color]="resolved.color || '#3B82F6'">
                            {{ resolved.display }}
                          </span>
                        } @else if (resolved.type === EntityPropertyType.User) {
                          <span class="inline-flex items-center gap-1">
                            <span class="material-symbols-outlined text-sm">person</span>
                            {{ resolved.display }}
                          </span>
                        } @else if (resolved.type === EntityPropertyType.ForeignKeyName) {
                          <span class="link link-hover text-primary">{{ resolved.display }}</span>
                        } @else if (resolved.type === EntityPropertyType.Boolean) {
                          @if (resolved.raw) {
                            <span class="material-symbols-outlined text-success text-base">check_circle</span>
                          } @else {
                            <span class="material-symbols-outlined text-base-content/40 text-base">cancel</span>
                          }
                        } @else if (resolved.type === EntityPropertyType.Color) {
                          <span class="badge badge-sm gap-1 font-mono">
                            <span
                              class="w-3 h-3 rounded border border-base-300"
                              [style.background-color]="resolved.raw">
                            </span>
                            {{ resolved.display }}
                          </span>
                        } @else {
                          <span class="inline-block max-w-[180px] truncate align-middle" [title]="resolved.display">
                            {{ resolved.display }}
                          </span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </div>
        }

        <!-- Version Timeline -->
        @if (group.versions && group.versions.length > 0) {
          <div>
            <h3 class="font-semibold mb-3 flex items-center gap-2">
              <span class="material-symbols-outlined text-base">timeline</span>
              Version History
            </h3>
            <app-series-version-timeline
              [versions]="group.versions"
              [currentVersionId]="selectedVersionId()"
              (versionSelect)="onVersionSelect($event)"
            ></app-series-version-timeline>
          </div>
        }

        <!-- Instances Section with Tabs -->
        <div>
          <h3 class="font-semibold mb-3 flex items-center gap-2">
            <span class="material-symbols-outlined text-base">event</span>
            Occurrences
          </h3>

          <!-- Instance Filter Tabs -->
          <div class="tabs tabs-box mb-3 text-sm">
            <button
              class="tab tab-sm"
              [class.tab-active]="instanceFilter() === 'upcoming'"
              (click)="setInstanceFilter('upcoming')"
            >
              Upcoming
            </button>
            <button
              class="tab tab-sm"
              [class.tab-active]="instanceFilter() === 'past'"
              (click)="setInstanceFilter('past')"
            >
              Past
            </button>
            <button
              class="tab tab-sm"
              [class.tab-active]="instanceFilter() === 'exceptions'"
              (click)="setInstanceFilter('exceptions')"
            >
              Exceptions
            </button>
            <button
              class="tab tab-sm"
              [class.tab-active]="instanceFilter() === 'all'"
              (click)="setInstanceFilter('all')"
            >
              All
            </button>
          </div>

          <!-- Instance List -->
          @if (loadingInstances()) {
            <div class="flex items-center justify-center py-6">
              <span class="loading loading-spinner loading-sm"></span>
            </div>
          } @else if (instances().length === 0) {
            <div class="text-center py-6 text-base-content/50">
              <span class="material-symbols-outlined text-2xl mb-2">event_busy</span>
              <p class="text-sm">No {{ instanceFilter() }} occurrences found</p>
            </div>
          } @else {
            <div class="max-h-64 overflow-y-auto space-y-1">
              @for (instance of instances(); track instance.id) {
                <div
                  class="flex items-center gap-3 p-2 rounded-lg hover:bg-base-200 cursor-pointer transition-colors"
                  (click)="navigateToInstance(instance)"
                >
                  <span
                    class="material-symbols-outlined text-base"
                    [class.text-warning]="instance.is_exception"
                    [class.text-base-content/50]="!instance.is_exception"
                  >
                    {{ getInstanceIcon(instance) }}
                  </span>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm truncate">{{ formatOccurrenceDate(instance.occurrence_date) }}</p>
                    <div class="flex items-center gap-1 flex-wrap">
                      @if (instance.is_exception) {
                        <span class="badge badge-warning badge-xs">
                          {{ getExceptionLabel(instance) }}
                        </span>
                      }
                      @if (!instance.entity_id) {
                        <span class="badge badge-ghost badge-xs">Not created</span>
                      }
                    </div>
                  </div>
                  @if (instance.entity_id) {
                    <span class="material-symbols-outlined text-base-content/30 text-sm">chevron_right</span>
                  }
                </div>
              }
            </div>
            @if (instances().length >= 50) {
              <p class="text-xs text-base-content/50 text-center pt-2">
                Showing first 50 results
              </p>
            }
          }
        </div>

        <!-- Actions -->
        <div class="flex gap-2 pt-4 border-t">
          <button class="btn btn-outline btn-primary flex-1" (click)="openEditModal('info')">
            <span class="material-symbols-outlined">edit</span>
            Edit
          </button>
          <button class="btn btn-outline btn-error flex-1" (click)="onDeleteClick()">
            <span class="material-symbols-outlined">delete</span>
            Delete
          </button>
        </div>

        <!-- Delete Confirmation -->
        @if (showDeleteConfirm()) {
          <div class="alert alert-warning">
            <span class="material-symbols-outlined">warning</span>
            <div>
              <p class="font-medium">Delete this entire series?</p>
              <p class="text-sm">This will delete all {{ group.active_instance_count || 0 }} occurrences. This cannot be undone.</p>
            </div>
            <div class="flex gap-2">
              <button class="btn btn-sm btn-ghost" (click)="showDeleteConfirm.set(false)">Cancel</button>
              <button class="btn btn-sm btn-error" (click)="confirmDelete()">Delete</button>
            </div>
          </div>
        }
      </div>
    } @else {
      <div class="text-center py-12 text-base-content/50">
        <span class="material-symbols-outlined text-4xl mb-2">select</span>
        <p>Select a series to view details</p>
      </div>
    }

    <!-- Unified Edit Modal -->
    <cos-modal [isOpen]="showEditModal()" (closed)="cancelEdit()" size="lg">
      <h3 class="font-bold text-lg mb-4">Edit Series</h3>

          <!-- Tab Navigation (DaisyUI 5 lift style) -->
          <div role="tablist" class="tabs tabs-lift mb-4">
            <button
              role="tab"
              class="tab"
              [class.tab-active]="editTab() === 'info'"
              (click)="editTab.set('info')"
            >
              Info
            </button>
            <button
              role="tab"
              class="tab"
              [class.tab-active]="editTab() === 'schedule'"
              (click)="editTab.set('schedule')"
            >
              Schedule
            </button>
            <button
              role="tab"
              class="tab"
              [class.tab-active]="editTab() === 'template'"
              (click)="editTab.set('template')"
              [disabled]="allEditableProperties().length === 0"
            >
              Template
            </button>
          </div>

          <!-- Info Tab -->
          @if (editTab() === 'info') {
            <div class="space-y-4">
              <div class="form-control">
                <label class="label">
                  <span class="label-text">Display Name</span>
                </label>
                <input
                  type="text"
                  class="input input-bordered w-full"
                  [(ngModel)]="editForm.display_name"
                  placeholder="Series name"
                />
              </div>

              <div class="form-control">
                <label class="label">
                  <span class="label-text">Description</span>
                </label>
                <textarea
                  class="textarea textarea-bordered w-full"
                  rows="3"
                  [(ngModel)]="editForm.description"
                  placeholder="Optional description"
                ></textarea>
              </div>

              <div class="form-control">
                <label class="label">
                  <span class="label-text">Color</span>
                </label>
                <div class="flex items-center gap-3">
                  <input
                    type="color"
                    class="w-12 h-10 cursor-pointer rounded border border-base-300"
                    [(ngModel)]="editForm.color"
                  />
                  <input
                    type="text"
                    class="input input-bordered flex-1"
                    [(ngModel)]="editForm.color"
                    placeholder="#3B82F6"
                    pattern="^#[0-9A-Fa-f]{6}$"
                  />
                </div>
              </div>
            </div>
          }

          <!-- Schedule Tab -->
          @if (editTab() === 'schedule') {
            <app-recurring-schedule-form
              [dtstart]="editScheduleValue().dtstart"
              [dtend]="editScheduleValue().dtend"
              [rrule]="editScheduleValue().rrule"
              (valueChange)="onScheduleChange($event)"
            ></app-recurring-schedule-form>
          }

          <!-- Template Tab -->
          @if (editTab() === 'template') {
            <div class="space-y-4">
              <p class="text-sm text-base-content/70">
                Check properties to include in template. Unchecked properties use database defaults.
              </p>
              @for (prop of allEditableProperties(); track prop.column_name) {
                <div class="flex items-start gap-3">
                  <label class="cursor-pointer mt-8">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      [checked]="isPropertyIncluded(prop.column_name)"
                      (change)="togglePropertyInclusion(prop.column_name)"
                    />
                  </label>
                  <div class="flex-1" [class.opacity-50]="!isPropertyIncluded(prop.column_name)">
                    <app-edit-property
                      [property]="prop"
                      [formGroup]="templateFormGroup()"
                      [class.pointer-events-none]="!isPropertyIncluded(prop.column_name)"
                    ></app-edit-property>
                  </div>
                </div>
              }
            </div>
          }

          <!-- Effective From Date (for schedule/template changes) -->
          @if (editTab() !== 'info') {
            <div class="divider">Apply Changes</div>
            <div class="flex flex-col gap-2">
              <label class="label cursor-pointer justify-start gap-3 py-1">
                <input
                  type="radio"
                  class="radio radio-sm"
                  name="applyScope"
                  [checked]="!editForm.effectiveFrom"
                  (change)="editForm.effectiveFrom = ''"
                />
                <span>Update all future occurrences</span>
              </label>
              <label class="label cursor-pointer justify-start gap-3 py-1">
                <input
                  type="radio"
                  class="radio radio-sm"
                  name="applyScope"
                  [checked]="!!editForm.effectiveFrom"
                  (change)="editForm.effectiveFrom = getMinEffectiveDate()"
                />
                <span>Create new version starting from date:</span>
              </label>
              @if (editForm.effectiveFrom) {
                <div class="mt-1">
                  <input
                    type="date"
                    class="input input-bordered w-full"
                    [(ngModel)]="editForm.effectiveFrom"
                    [min]="getMinEffectiveDate()"
                  />
                  <p class="text-xs text-base-content/60 mt-1">
                    This will create a new series version. Occurrences before this date remain unchanged.
                  </p>
                </div>
              }
            </div>
          }

          <!-- Error Display -->
          @if (editError()) {
            <div class="alert alert-error mt-4">
              <span class="material-symbols-outlined">error</span>
              <span>{{ editError() }}</span>
            </div>
          }

      <div class="cos-modal-action">
        <button class="btn btn-ghost" (click)="cancelEdit()">Cancel</button>
        <button class="btn btn-primary" (click)="saveEdit()" [disabled]="saving()">
          @if (saving()) {
            <span class="loading loading-spinner loading-sm"></span>
          }
          Save Changes
        </button>
      </div>
    </cos-modal>
  `
})
export class SeriesGroupDetailComponent implements OnChanges {
  private router = inject(Router);
  private fb = inject(FormBuilder);
  private recurringService = inject(RecurringService);
  private schemaService = inject(SchemaService);
  private dataService = inject(DataService);

  @Input() group?: SeriesGroup;
  @Input() loading = false;

  @Output() edit = new EventEmitter<SeriesGroup>();
  @Output() delete = new EventEmitter<SeriesGroup>();
  @Output() close = new EventEmitter<void>();
  @Output() updated = new EventEmitter<SeriesGroup>();

  selectedVersionId = signal<number | undefined>(undefined);
  showDeleteConfirm = signal(false);

  // Instance listing state
  instanceFilter = signal<'all' | 'upcoming' | 'past' | 'exceptions'>('upcoming');
  instances = signal<SeriesInstanceSummary[]>([]);
  loadingInstances = signal(false);

  // Template properties for display and editing
  templateProperties = signal<SchemaEntityProperty[]>([]);

  // All editable properties for the entity (for edit modal)
  allEditableProperties = signal<SchemaEntityProperty[]>([]);

  // Track which properties are included in the template (checked in edit modal)
  includedInTemplate = signal<Set<string>>(new Set());

  // Resolved template values with display names for FK/User/Status types
  resolvedTemplateValues = signal<Map<string, ResolvedValue>>(new Map());
  loadingTemplate = signal(false);

  // Expose EntityPropertyType for template
  EntityPropertyType = EntityPropertyType;

  // Computed values
  currentVersion = computed(() => this.group?.current_version);

  rruleDescription = computed(() => {
    const cv = this.currentVersion();
    return cv?.rrule ? this.recurringService.describeRRule(cv.rrule) : 'Not configured';
  });

  // Edit modal state
  showEditModal = signal(false);
  editTab = signal<EditTab>('info');
  saving = signal(false);
  editError = signal<string | null>(null);
  editForm = {
    display_name: '',
    description: '',
    color: '#3B82F6',
    effectiveFrom: ''
  };

  // Schedule state for edit modal (managed by shared component)
  editScheduleValue = signal<RecurringScheduleValue>({
    dtstart: '',
    dtend: '',
    rrule: 'FREQ=WEEKLY;COUNT=10',
    duration: 'PT1H',
    isValid: false
  });

  // Reactive FormGroup for template editing (used by EditPropertyComponent)
  templateFormGroup = signal<FormGroup>(new FormGroup({}));

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['group'] && this.group) {
      // Reset to upcoming tab when group changes
      this.instanceFilter.set('upcoming');
      this.loadInstances();
      this.loadTemplateProperties();
    }
  }

  private loadTemplateProperties(): void {
    if (!this.group?.entity_table) {
      this.templateProperties.set([]);
      this.allEditableProperties.set([]);
      this.includedInTemplate.set(new Set());
      this.resolvedTemplateValues.set(new Map());
      return;
    }

    const entityTable = this.group.entity_table;
    this.loadingTemplate.set(true);

    // First get the entity metadata to find the recurring_property_name
    // Then load properties for the entity type
    // Note: getEntities() returns a signal-derived observable that never completes,
    // so we use take(1) to complete after first emission for forkJoin compatibility
    forkJoin({
      entities: this.schemaService.getEntities().pipe(take(1)),
      properties: this.schemaService.getProperties()
    }).subscribe(({ entities, properties }) => {
      // Find the entity to get its recurring_property_name
      const entity = entities.find(e => e.table_name === entityTable);
      // Use recurring_property_name from metadata (excludes this field since it's managed by recurrence)
      const timeSlotProp = entity?.recurring_property_name || null;
      const template = this.currentVersion()?.entity_template || {};
      const templateKeys = new Set(Object.keys(template));

      // All editable properties for this entity (for edit modal)
      // Only filter by show_on_edit - no hardcoded _at suffix filter
      const allEditable = properties.filter((p: SchemaEntityProperty) =>
        p.table_name === entityTable &&
        p.column_name !== timeSlotProp &&  // Time slot managed by recurrence system
        p.show_on_edit !== false
      );
      this.allEditableProperties.set(allEditable);

      // Track which properties are currently in the template
      this.includedInTemplate.set(templateKeys);

      // For read-only display, only show properties that ARE in the template
      const inTemplate = allEditable.filter(p => templateKeys.has(p.column_name));
      this.templateProperties.set(inTemplate);

      // Resolve embedded types (FK, User, Status)
      this.resolveTemplateValues(inTemplate, template);
    });
  }

  /**
   * Resolve foreign key, user, and status values to their display names.
   * Fetches related records and caches the results.
   */
  private resolveTemplateValues(properties: SchemaEntityProperty[], template: Record<string, any>): void {
    const resolved = new Map<string, ResolvedValue>();
    const fetchObservables: Observable<void>[] = [];

    properties.forEach(prop => {
      const rawValue = template[prop.column_name];
      if (rawValue === null || rawValue === undefined) {
        resolved.set(prop.column_name, {
          raw: rawValue,
          display: '',
          type: prop.type
        });
        return;
      }

      const propType = prop.type;

      // Handle Status type - fetch from statuses table
      if (propType === EntityPropertyType.Status && prop.status_entity_type) {
        fetchObservables.push(
          this.dataService.getData({
            key: 'statuses',
            fields: ['id', 'display_name', 'color'],
            filters: [{ column: 'id', operator: 'eq', value: rawValue }]
          }).pipe(
            map((statuses: any[]) => {
              const status = statuses[0];
              resolved.set(prop.column_name, {
                raw: rawValue,
                display: status?.display_name || `Status #${rawValue}`,
                type: propType,
                color: status?.color
              });
            }),
            catchError(() => {
              resolved.set(prop.column_name, {
                raw: rawValue,
                display: `Status #${rawValue}`,
                type: propType
              });
              return of(undefined);
            })
          )
        );
      }
      // Handle User type - fetch from civic_os_users view
      else if (propType === EntityPropertyType.User) {
        fetchObservables.push(
          this.dataService.getData({
            key: 'civic_os_users',
            fields: ['id', 'display_name', 'full_name'],
            filters: [{ column: 'id', operator: 'eq', value: rawValue }]
          }).pipe(
            map((users: any[]) => {
              const user = users[0];
              resolved.set(prop.column_name, {
                raw: rawValue,
                display: user?.full_name || user?.display_name || 'Unknown User',
                type: propType
              });
            }),
            catchError(() => {
              resolved.set(prop.column_name, {
                raw: rawValue,
                display: 'Unknown User',
                type: propType
              });
              return of(undefined);
            })
          )
        );
      }
      // Handle ForeignKeyName type - fetch display_name from related table
      else if (propType === EntityPropertyType.ForeignKeyName && prop.join_table) {
        fetchObservables.push(
          this.dataService.getData({
            key: prop.join_table,
            fields: ['id', 'display_name'],
            filters: [{ column: 'id', operator: 'eq', value: rawValue }]
          }).pipe(
            map((records: any[]) => {
              const record = records[0];
              resolved.set(prop.column_name, {
                raw: rawValue,
                display: record?.display_name || `#${rawValue}`,
                type: propType
              });
            }),
            catchError(() => {
              resolved.set(prop.column_name, {
                raw: rawValue,
                display: `#${rawValue}`,
                type: propType
              });
              return of(undefined);
            })
          )
        );
      }
      // Handle simple types - just format the value
      else {
        resolved.set(prop.column_name, {
          raw: rawValue,
          display: this.formatSimpleValue(rawValue, propType),
          type: propType
        });
      }
    });

    // Execute all fetch operations in parallel
    if (fetchObservables.length > 0) {
      forkJoin(fetchObservables).subscribe({
        next: () => {
          this.resolvedTemplateValues.set(resolved);
          this.loadingTemplate.set(false);
        },
        error: () => {
          this.resolvedTemplateValues.set(resolved);
          this.loadingTemplate.set(false);
        }
      });
    } else {
      this.resolvedTemplateValues.set(resolved);
      this.loadingTemplate.set(false);
    }
  }

  /**
   * Format simple (non-embedded) values for display.
   */
  private formatSimpleValue(value: any, type: EntityPropertyType): string {
    if (value === null || value === undefined) return '';

    switch (type) {
      case EntityPropertyType.Boolean:
        return value ? 'Yes' : 'No';
      case EntityPropertyType.Money:
        return typeof value === 'number' ? `$${value.toFixed(2)}` : String(value);
      case EntityPropertyType.Date:
        try {
          return new Date(value).toLocaleDateString();
        } catch {
          return String(value);
        }
      case EntityPropertyType.DateTime:
      case EntityPropertyType.DateTimeLocal:
        try {
          return new Date(value).toLocaleString();
        } catch {
          return String(value);
        }
      case EntityPropertyType.Color:
        return String(value).toUpperCase();
      default:
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    }
  }

  /**
   * Get resolved display value for a template property.
   */
  getResolvedValue(columnName: string): ResolvedValue | undefined {
    return this.resolvedTemplateValues().get(columnName);
  }

  setInstanceFilter(filter: 'all' | 'upcoming' | 'past' | 'exceptions'): void {
    this.instanceFilter.set(filter);
    this.loadInstances();
  }

  private loadInstances(): void {
    if (!this.group || !this.group.instances) {
      this.instances.set([]);
      return;
    }

    // Filter instances client-side using embedded data from view
    const now = new Date();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD format
    let filtered = [...this.group.instances];

    switch (this.instanceFilter()) {
      case 'upcoming':
        filtered = filtered.filter(i => i.occurrence_date >= today);
        break;
      case 'past':
        filtered = filtered.filter(i => i.occurrence_date < today);
        break;
      case 'exceptions':
        filtered = filtered.filter(i => i.is_exception);
        break;
      // 'all' - no filtering needed
    }

    // Sort and limit to 50 for performance
    filtered.sort((a, b) => a.occurrence_date.localeCompare(b.occurrence_date));
    this.instances.set(filtered.slice(0, 50));
  }

  getInstanceIcon(instance: SeriesInstanceSummary): string {
    if (instance.exception_type === 'cancelled') return 'event_busy';
    if (instance.exception_type === 'rescheduled') return 'event_repeat';
    if (instance.is_exception) return 'edit_calendar';
    return 'event';
  }

  getExceptionLabel(instance: SeriesInstanceSummary): string {
    switch (instance.exception_type) {
      case 'cancelled': return 'Cancelled';
      case 'rescheduled': return 'Rescheduled';
      case 'modified': return 'Modified';
      case 'conflict_skipped': return 'Skipped';
      default: return 'Exception';
    }
  }

  formatDateTime(isoStr: string): string {
    if (!isoStr) return '—';
    try {
      return new Date(isoStr).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    } catch {
      return isoStr;
    }
  }

  formatDuration(duration: string): string {
    if (!duration) return '—';
    // Parse ISO 8601 duration (e.g., PT1H30M)
    const match = duration.match(/PT(\d+H)?(\d+M)?/);
    if (!match) return duration;
    const hours = match[1] ? parseInt(match[1]) : 0;
    const minutes = match[2] ? parseInt(match[2]) : 0;
    if (hours && minutes) return `${hours}h ${minutes}m`;
    if (hours) return `${hours} hour${hours > 1 ? 's' : ''}`;
    if (minutes) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    return duration;
  }

  formatOccurrenceDate(dateStr: string): string {
    try {
      // occurrence_date is just a DATE (no time), so parse as local date
      // by appending T00:00:00 to avoid UTC interpretation
      const localDate = dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00`;
      return new Date(localDate).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    } catch {
      return dateStr;
    }
  }

  getMinEffectiveDate(): string {
    // Minimum date is tomorrow (can't split in the past)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }

  onVersionSelect(version: SeriesVersionSummary): void {
    this.selectedVersionId.set(version.series_id);
  }

  onClose(): void {
    this.close.emit();
  }

  /**
   * Check if a property is included in the template.
   */
  isPropertyIncluded(columnName: string): boolean {
    return this.includedInTemplate().has(columnName);
  }

  /**
   * Toggle whether a property is included in the template.
   */
  togglePropertyInclusion(columnName: string): void {
    const current = this.includedInTemplate();
    const updated = new Set(current);
    if (updated.has(columnName)) {
      updated.delete(columnName);
    } else {
      updated.add(columnName);
    }
    this.includedInTemplate.set(updated);
  }

  /**
   * Get template values, filtered to only include checked properties.
   * Unchecked properties are excluded from the template (will use DB defaults).
   */
  private getFilteredTemplateValue(): Record<string, any> {
    const allValues = this.templateFormGroup().value;
    const included = this.includedInTemplate();
    const filtered: Record<string, any> = {};

    for (const [key, value] of Object.entries(allValues)) {
      if (included.has(key)) {
        filtered[key] = value;
      }
    }

    return filtered;
  }

  openEditModal(tab: EditTab): void {
    if (this.group) {
      const cv = this.currentVersion();

      // Initialize form with current values
      this.editForm.display_name = this.group.display_name;
      this.editForm.description = this.group.description || '';
      this.editForm.color = this.group.color || '#3B82F6';
      this.editForm.effectiveFrom = '';
      this.editError.set(null);

      // Initialize schedule values via signal
      let dtstart = '';
      let dtend = '';
      if (cv?.dtstart) {
        dtstart = this.formatDateTimeLocal(new Date(cv.dtstart).toISOString());
      }
      if (cv?.dtstart && cv?.duration) {
        const startDate = new Date(cv.dtstart);
        const durationMs = this.parseDurationToMs(cv.duration);
        const endDate = new Date(startDate.getTime() + durationMs);
        dtend = this.formatDateTimeLocal(endDate.toISOString());
      }
      this.editScheduleValue.set({
        dtstart,
        dtend,
        rrule: cv?.rrule || 'FREQ=WEEKLY;COUNT=10',
        duration: cv?.duration || 'PT1H',
        isValid: !!dtstart && !!dtend
      });

      // Build reactive FormGroup for ALL editable properties
      // Pre-populate with existing template values where they exist
      const template = cv?.entity_template || {};
      const templateKeys = new Set(Object.keys(template));
      const group: Record<string, FormControl> = {};
      for (const prop of this.allEditableProperties()) {
        group[prop.column_name] = new FormControl(template[prop.column_name] ?? null);
      }
      this.templateFormGroup.set(new FormGroup(group));

      // Initialize inclusion state from existing template
      this.includedInTemplate.set(templateKeys);

      this.editTab.set(tab);
      this.showEditModal.set(true);
    }
  }

  onScheduleChange(value: RecurringScheduleValue): void {
    this.editScheduleValue.set(value);
  }

  /**
   * Format ISO string for datetime-local input (YYYY-MM-DDTHH:MM)
   */
  private formatDateTimeLocal(isoStr: string): string {
    return isoStr.slice(0, 16);
  }

  /**
   * Parse ISO 8601 duration to milliseconds
   */
  private parseDurationToMs(duration: string): number {
    const match = duration.match(/PT(\d+)H?(\d*)M?/);
    if (!match) return 60 * 60 * 1000; // Default 1 hour
    const hours = match[1] ? parseInt(match[1]) : 0;
    const minutes = match[2] ? parseInt(match[2]) : 0;
    return (hours * 60 + minutes) * 60 * 1000;
  }

  cancelEdit(): void {
    this.showEditModal.set(false);
    this.editError.set(null);
  }

  saveEdit(): void {
    if (!this.group) return;

    this.saving.set(true);
    this.editError.set(null);

    const cv = this.currentVersion();
    const seriesId = cv?.series_id;
    const schedule = this.editScheduleValue();

    // Determine what needs updating
    const tab = this.editTab();
    const effectiveFrom = this.editForm.effectiveFrom;

    // Check if we need to split the series
    if (effectiveFrom && seriesId && (tab === 'schedule' || tab === 'template')) {
      // Use split_series_from_date for dated changes
      // Get template values from reactive FormGroup (used by EditPropertyComponent)
      const newTemplate = tab === 'template' ? this.getFilteredTemplateValue() : undefined;
      const dtstart = schedule.dtstart ? new Date(schedule.dtstart).toISOString() : cv?.dtstart || '';

      this.recurringService.splitSeries({
        seriesId,
        splitDate: effectiveFrom,
        newDtstart: dtstart,
        newDuration: schedule.duration,
        newTemplate
      }).pipe(
        tap(result => {
          if (!result.success) {
            throw new Error(result.message || 'Failed to split series');
          }
        }),
        // Also update group info if on info tab
        switchMap(() => {
          return this.recurringService.updateSeriesGroupInfo(
            this.group!.id,
            this.editForm.display_name.trim(),
            this.editForm.description.trim() || null,
            this.editForm.color || null
          );
        }),
        catchError(err => {
          this.editError.set(err?.message || 'Failed to save changes');
          return of(null);
        })
      ).subscribe({
        next: (result) => {
          this.saving.set(false);
          if (result !== null) {
            this.showEditModal.set(false);
            this.emitUpdated();
          }
        },
        error: () => {
          this.saving.set(false);
        }
      });
      return;
    }

    // Non-split updates
    const updates: any[] = [];

    // Always update group info
    updates.push(
      this.recurringService.updateSeriesGroupInfo(
        this.group.id,
        this.editForm.display_name.trim(),
        this.editForm.description.trim() || null,
        this.editForm.color || null
      )
    );

    // Update schedule if on schedule tab
    if (tab === 'schedule' && seriesId) {
      const dtstart = schedule.dtstart ? new Date(schedule.dtstart).toISOString() : cv?.dtstart;
      updates.push(
        this.recurringService.updateSeriesSchedule(
          seriesId,
          dtstart || '',
          schedule.duration,
          schedule.rrule
        )
      );
    }

    // Update template if on template tab
    // Get filtered template values (only checked properties)
    if (tab === 'template' && seriesId) {
      updates.push(
        this.recurringService.updateSeriesTemplate(seriesId, this.getFilteredTemplateValue())
      );
    }

    forkJoin(updates).pipe(
      catchError(err => {
        this.editError.set(err?.message || 'Failed to save changes');
        return of(null);
      })
    ).subscribe({
      next: (results) => {
        this.saving.set(false);
        if (results !== null) {
          this.showEditModal.set(false);
          this.emitUpdated();
        }
      },
      error: () => {
        this.saving.set(false);
      }
    });
  }

  private emitUpdated(): void {
    // Emit updated event so parent can reload
    if (this.group) {
      this.updated.emit({
        ...this.group,
        display_name: this.editForm.display_name.trim(),
        description: this.editForm.description.trim() || null,
        color: this.editForm.color || null
      });
    }
  }

  onDeleteClick(): void {
    this.showDeleteConfirm.set(true);
  }

  confirmDelete(): void {
    if (this.group) {
      this.delete.emit(this.group);
    }
    this.showDeleteConfirm.set(false);
  }

  navigateToInstance(instance: SeriesInstanceSummary): void {
    if (instance.entity_table && instance.entity_id) {
      this.router.navigate(['/view', instance.entity_table, instance.entity_id]);
    }
  }
}
