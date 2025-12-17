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
  inject,
  OnChanges,
  SimpleChanges,
  ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { SchemaService } from '../../services/schema.service';
import { RecurringService, CreateSeriesParams } from '../../services/recurring.service';
import { SchemaEntityTable, SchemaEntityProperty, ConflictInfo, CreateSeriesResult } from '../../interfaces/entity';
import { RecurringScheduleFormComponent, RecurringScheduleValue } from '../recurring-schedule-form/recurring-schedule-form.component';
import { EditPropertyComponent } from '../edit-property/edit-property.component';
import { catchError, of, forkJoin, map } from 'rxjs';
import { RRule } from 'rrule';

/**
 * Create Series Wizard Component
 *
 * Multi-step wizard for creating new recurring series from the admin page.
 * Steps:
 * 1. Series Info - Name, description, color, entity type
 * 2. Entity Template - Configure default values for generated entities
 * 3. Schedule - RRULE pattern, start time, duration
 * 4. Preview & Create - Conflict check and confirmation
 *
 * Usage:
 * ```html
 * <app-create-series-wizard
 *   [isOpen]="showWizard"
 *   [availableEntities]="recurringEntities"
 *   (created)="onSeriesCreated($event)"
 *   (cancel)="closeWizard()"
 * ></app-create-series-wizard>
 * ```
 *
 * Added in v0.19.0.
 */
@Component({
  selector: 'app-create-series-wizard',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    RecurringScheduleFormComponent,
    EditPropertyComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isOpen) {
      <div class="modal modal-open">
        <div class="modal-box max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <!-- Header with Steps -->
          <div class="flex items-center justify-between mb-6">
            <h3 class="font-bold text-lg">Create Recurring Series</h3>
            <button class="btn btn-ghost btn-sm btn-circle" (click)="onCancel()">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>

          <!-- Step Indicator -->
          <ul class="steps steps-horizontal w-full mb-6 text-xs">
            @for (s of steps; track s.id; let i = $index) {
              <li
                class="step"
                [class.step-primary]="currentStep() >= i + 1"
              >
                <span class="hidden sm:inline">{{ s.title }}</span>
                <span class="sm:hidden">{{ s.short }}</span>
              </li>
            }
          </ul>

          <!-- Step Content -->
          <div class="flex-1 overflow-y-auto">
            <!-- Step 1: Series Info -->
            @if (currentStep() === 1) {
              <form [formGroup]="infoForm" class="space-y-4">
                <div class="form-control">
                  <label class="label">
                    <span class="label-text font-medium">Entity Type *</span>
                  </label>
                  <select
                    class="select select-bordered w-full"
                    formControlName="entity_table"
                    (change)="onEntityTypeChange()"
                  >
                    <option value="">Select entity type...</option>
                    @for (entity of availableEntities; track entity.table_name) {
                      <option [value]="entity.table_name">{{ entity.display_name }}</option>
                    }
                  </select>
                  @if (availableEntities.length === 0) {
                    <p class="text-sm text-warning mt-1">
                      No entities with recurring time slots found. Enable recurring on a TimeSlot property first.
                    </p>
                  }
                </div>

                <div class="form-control">
                  <label class="label">
                    <span class="label-text font-medium">Series Name *</span>
                  </label>
                  <input
                    type="text"
                    class="input input-bordered w-full"
                    formControlName="display_name"
                    placeholder="e.g., Weekly Yoga Class"
                  />
                </div>

                <div class="form-control">
                  <label class="label">
                    <span class="label-text">Description</span>
                  </label>
                  <textarea
                    class="textarea textarea-bordered w-full"
                    rows="3"
                    formControlName="description"
                    placeholder="Brief description of this recurring schedule"
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
                      formControlName="color"
                    />
                    <input
                      type="text"
                      class="input input-bordered flex-1"
                      formControlName="color"
                      placeholder="#3B82F6"
                    />
                  </div>
                </div>
              </form>
            }

            <!-- Step 2: Entity Template -->
            @if (currentStep() === 2) {
              <div class="space-y-4">
                @if (loadingSchema()) {
                  <div class="flex items-center justify-center py-12">
                    <span class="loading loading-spinner loading-lg"></span>
                  </div>
                } @else if (templateProperties().length === 0) {
                  <div class="alert alert-info">
                    <span class="material-symbols-outlined">info</span>
                    <span>No configurable template fields found for this entity.</span>
                  </div>
                } @else {
                  <p class="text-sm text-base-content/70 mb-4">
                    Configure default values for each occurrence. These fields will be applied to all generated records.
                  </p>
                  <form [formGroup]="templateForm">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      @for (prop of templateProperties(); track prop.column_name) {
                        <div [class.md:col-span-2]="isWideField(prop)">
                          <app-edit-property
                            [property]="prop"
                            [formGroup]="templateForm"
                          ></app-edit-property>
                        </div>
                      }
                    </div>
                  </form>
                }
              </div>
            }

            <!-- Step 3: Schedule -->
            @if (currentStep() === 3) {
              <app-recurring-schedule-form
                [dtstart]="scheduleValue().dtstart"
                [dtend]="scheduleValue().dtend"
                [rrule]="scheduleValue().rrule"
                timeSlotLabel="First Occurrence Time Slot"
                recurrenceLabel="Recurrence Pattern"
                (valueChange)="onScheduleChange($event)"
              ></app-recurring-schedule-form>
            }

            <!-- Step 4: Preview & Create -->
            @if (currentStep() === 4) {
              <div class="space-y-4">
                @if (loadingPreview()) {
                  <div class="flex items-center justify-center py-12">
                    <span class="loading loading-spinner loading-lg"></span>
                    <span class="ml-3">Generating preview...</span>
                  </div>
                } @else if (previewError()) {
                  <div class="alert alert-error">
                    <span class="material-symbols-outlined">error</span>
                    <span>{{ previewError() }}</span>
                  </div>
                } @else {
                  <!-- Summary Card -->
                  <div class="card bg-base-200">
                    <div class="card-body">
                      <h4 class="card-title text-base">
                        @if (infoForm.value.color) {
                          <div
                            class="w-4 h-4 rounded-full"
                            [style.background-color]="infoForm.value.color"
                          ></div>
                        }
                        {{ infoForm.value.display_name }}
                      </h4>
                      @if (infoForm.value.description) {
                        <p class="text-sm text-base-content/70">{{ infoForm.value.description }}</p>
                      }

                      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                        <div>
                          <p class="text-xs text-base-content/60">Entity Type</p>
                          <p class="font-medium">{{ getEntityDisplayName() }}</p>
                        </div>
                        <div>
                          <p class="text-xs text-base-content/60">First Occurrence</p>
                          <p class="font-medium">{{ formatDateTime(scheduleValue().dtstart) }}</p>
                        </div>
                        <div>
                          <p class="text-xs text-base-content/60">Duration</p>
                          <p class="font-medium">{{ formatDuration() }}</p>
                        </div>
                        <div>
                          <p class="text-xs text-base-content/60">Occurrences</p>
                          <p class="font-medium">{{ previewOccurrences().length }}</p>
                        </div>
                      </div>

                      <div class="mt-4">
                        <p class="text-xs text-base-content/60">Schedule</p>
                        <p class="font-medium">{{ getRRuleDescription() }}</p>
                        <p class="text-xs text-base-content/50 font-mono mt-1">{{ scheduleValue().rrule }}</p>
                      </div>
                    </div>
                  </div>

                  <!-- Occurrences Preview -->
                  <div class="border rounded-lg">
                    <div class="p-3 bg-base-200 border-b flex items-center justify-between">
                      <span class="font-medium">Upcoming Occurrences</span>
                      @if (conflictCount() > 0) {
                        <span class="badge badge-warning">{{ conflictCount() }} conflicts</span>
                      }
                    </div>
                    <div class="max-h-48 overflow-y-auto">
                      @for (occ of previewOccurrences().slice(0, 20); track occ.start) {
                        <div class="flex items-center gap-3 p-3 border-b last:border-b-0"
                             [class.bg-error/5]="occ.hasConflict">
                          @if (occ.hasConflict) {
                            <span class="material-symbols-outlined text-error text-sm">cancel</span>
                          } @else {
                            <span class="material-symbols-outlined text-success text-sm">check_circle</span>
                          }
                          <span class="text-sm flex-1">{{ formatDateTime(occ.start) }}</span>
                          @if (occ.hasConflict) {
                            <span class="badge badge-error badge-sm">Conflict</span>
                          }
                        </div>
                      }
                      @if (previewOccurrences().length > 20) {
                        <div class="p-3 text-center text-sm text-base-content/50">
                          +{{ previewOccurrences().length - 20 }} more occurrences
                        </div>
                      }
                    </div>
                  </div>

                  @if (conflictCount() > 0) {
                    <div class="alert alert-warning">
                      <span class="material-symbols-outlined">warning</span>
                      <div>
                        <p class="font-medium">{{ conflictCount() }} conflicts detected</p>
                        <p class="text-sm">Conflicting occurrences will be skipped during creation.</p>
                      </div>
                    </div>
                  }

                  @if (createError()) {
                    <div class="alert alert-error">
                      <span class="material-symbols-outlined">error</span>
                      <span>{{ createError() }}</span>
                    </div>
                  }
                }
              </div>
            }
          </div>

          <!-- Footer with Navigation -->
          <div class="modal-action border-t pt-4 mt-4">
            <button class="btn btn-ghost" (click)="onCancel()" [disabled]="creating()">
              Cancel
            </button>

            <div class="flex-1"></div>

            @if (currentStep() > 1) {
              <button class="btn btn-outline" (click)="prevStep()" [disabled]="creating()">
                <span class="material-symbols-outlined">chevron_left</span>
                Back
              </button>
            }

            @if (currentStep() < 4) {
              <button
                class="btn btn-primary"
                (click)="nextStep()"
                [disabled]="!canProceed()"
              >
                Next
                <span class="material-symbols-outlined">chevron_right</span>
              </button>
            } @else {
              <button
                class="btn btn-primary"
                (click)="createSeries()"
                [disabled]="creating() || loadingPreview() || previewOccurrences().length === 0"
              >
                @if (creating()) {
                  <span class="loading loading-spinner loading-sm"></span>
                }
                Create Series
              </button>
            }
          </div>
        </div>
        <div class="modal-backdrop" (click)="onCancel()"></div>
      </div>
    }
  `
})
export class CreateSeriesWizardComponent implements OnChanges {
  private fb = inject(FormBuilder);
  private schemaService = inject(SchemaService);
  private recurringService = inject(RecurringService);

  @Input() isOpen = false;
  @Input() availableEntities: SchemaEntityTable[] = [];

  @Output() created = new EventEmitter<CreateSeriesResult>();
  @Output() cancel = new EventEmitter<void>();

  // Wizard state
  currentStep = signal(1);
  steps = [
    { id: 1, title: 'Series Info', short: 'Info' },
    { id: 2, title: 'Template', short: 'Fields' },
    { id: 3, title: 'Schedule', short: 'Time' },
    { id: 4, title: 'Preview', short: 'Done' }
  ];

  // Forms
  infoForm: FormGroup = this.fb.group({
    entity_table: ['', Validators.required],
    display_name: ['', Validators.required],
    description: [''],
    color: ['#3B82F6']
  });

  templateForm: FormGroup = this.fb.group({});

  // Schedule state (managed by shared component)
  scheduleValue = signal<RecurringScheduleValue>({
    dtstart: '',
    dtend: '',
    rrule: 'FREQ=WEEKLY;COUNT=10',
    duration: 'PT1H',
    isValid: false
  });

  // Schema loading
  loadingSchema = signal(false);
  entityProperties = signal<SchemaEntityProperty[]>([]);
  timeSlotPropertyName = signal<string>('time_slot');

  // Preview state
  loadingPreview = signal(false);
  previewError = signal<string | null>(null);
  previewOccurrences = signal<Array<{ start: string; end: string; hasConflict: boolean }>>([]);
  conflictCount = computed(() => this.previewOccurrences().filter(o => o.hasConflict).length);

  // Creation state
  creating = signal(false);
  createError = signal<string | null>(null);

  // Computed template properties - filter by show_on_edit (metadata-driven)
  // No hardcoded _at suffix filter - rely on show_on_edit configuration
  templateProperties = computed(() => {
    const props = this.entityProperties();
    const timeSlotProp = this.timeSlotPropertyName();

    return props.filter(p =>
      p.column_name !== timeSlotProp &&  // Time slot managed by recurrence system
      p.show_on_edit !== false           // Respects metadata configuration
    );
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen'] && this.isOpen) {
      this.resetWizard();
    }
  }

  private resetWizard(): void {
    this.currentStep.set(1);
    this.infoForm.reset({ color: '#3B82F6' });
    this.templateForm = this.fb.group({});
    this.scheduleValue.set({
      dtstart: '',
      dtend: '',
      rrule: 'FREQ=WEEKLY;COUNT=10',
      duration: 'PT1H',
      isValid: false
    });
    this.entityProperties.set([]);
    this.previewOccurrences.set([]);
    this.previewError.set(null);
    this.createError.set(null);
  }

  onEntityTypeChange(): void {
    const entityTable = this.infoForm.value.entity_table;
    if (!entityTable) return;

    // Get the time slot property name from the selected entity's metadata
    const selectedEntity = this.availableEntities.find(e => e.table_name === entityTable);
    if (selectedEntity?.recurring_property_name) {
      this.timeSlotPropertyName.set(selectedEntity.recurring_property_name);
    }

    this.loadingSchema.set(true);
    this.schemaService.getProperties().pipe(
      map(allProps => allProps.filter(p => p.table_name === entityTable)),
      catchError(() => of([]))
    ).subscribe(properties => {
      this.entityProperties.set(properties);

      // Build template form
      this.buildTemplateForm(properties);
      this.loadingSchema.set(false);
    });
  }

  private buildTemplateForm(properties: SchemaEntityProperty[]): void {
    this.templateForm = this.fb.group({});
    const timeSlotProp = this.timeSlotPropertyName();

    properties.forEach(prop => {
      // Skip fields that shouldn't be in template
      // Only filter by time_slot and show_on_edit - no hardcoded _at suffix filter
      if (
        prop.column_name === timeSlotProp ||  // Time slot managed by recurrence system
        prop.show_on_edit === false           // Respects metadata configuration
      ) {
        return;
      }

      // Add control with default value
      const validators = prop.is_nullable === false ? [Validators.required] : [];
      this.templateForm.addControl(prop.column_name, this.fb.control(null, validators));
    });
  }

  isWideField(prop: SchemaEntityProperty): boolean {
    // Wide fields span full width
    return prop.column_width === 2 ||
           prop.type === 16 || // TextLong
           prop.type === 7;    // GeoPoint
  }

  canProceed(): boolean {
    switch (this.currentStep()) {
      case 1:
        return this.infoForm.valid;
      case 2:
        return this.templateForm.valid;
      case 3:
        return this.scheduleValue().isValid;
      default:
        return true;
    }
  }

  onScheduleChange(value: RecurringScheduleValue): void {
    this.scheduleValue.set(value);
  }

  nextStep(): void {
    if (!this.canProceed()) return;

    const next = this.currentStep() + 1;
    if (next <= 4) {
      this.currentStep.set(next);

      // Load preview when entering step 4
      if (next === 4) {
        this.loadPreview();
      }
    }
  }

  prevStep(): void {
    const prev = this.currentStep() - 1;
    if (prev >= 1) {
      this.currentStep.set(prev);
    }
  }

  private loadPreview(): void {
    this.loadingPreview.set(true);
    this.previewError.set(null);
    this.previewOccurrences.set([]);

    try {
      // Generate occurrences using rrule.js
      const schedule = this.scheduleValue();
      const rruleStr = schedule.rrule;
      const dtstart = new Date(schedule.dtstart);
      const durationMs = this.getDurationMs();

      // Parse RRULE and generate occurrences
      const rule = RRule.fromString(`DTSTART:${this.formatRRuleDate(dtstart)}\n${rruleStr}`);
      const dates = rule.all((date, i) => i < 100); // Limit to 100

      const occurrences = dates.map(d => {
        const start = d.toISOString();
        const end = new Date(d.getTime() + durationMs).toISOString();
        return { start, end, hasConflict: false };
      });

      // TODO: Check for conflicts via API
      // For now, just show the occurrences without conflict check
      this.previewOccurrences.set(occurrences);
      this.loadingPreview.set(false);

    } catch (error) {
      this.previewError.set('Failed to generate preview. Please check your schedule settings.');
      this.loadingPreview.set(false);
    }
  }

  private formatRRuleDate(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  private getDurationMs(): number {
    const schedule = this.scheduleValue();
    if (!schedule.dtstart || !schedule.dtend) return 60 * 60 * 1000; // Default 1 hour
    return new Date(schedule.dtend).getTime() - new Date(schedule.dtstart).getTime();
  }

  createSeries(): void {
    const schedule = this.scheduleValue();
    if (!this.infoForm.valid || !schedule.isValid) return;

    this.creating.set(true);
    this.createError.set(null);

    const params: CreateSeriesParams = {
      groupName: this.infoForm.value.display_name,
      groupDescription: this.infoForm.value.description || undefined,
      groupColor: this.infoForm.value.color || undefined,
      entityTable: this.infoForm.value.entity_table,
      entityTemplate: this.templateForm.value,
      rrule: schedule.rrule,
      dtstart: new Date(schedule.dtstart).toISOString(),
      duration: schedule.duration,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timeSlotProperty: this.timeSlotPropertyName(),
      expandNow: true,
      skipConflicts: true
    };

    this.recurringService.createSeries(params).subscribe({
      next: (result) => {
        this.creating.set(false);
        if (result.success) {
          this.created.emit(result);
        } else {
          this.createError.set(result.message || 'Failed to create series');
        }
      },
      error: (err) => {
        this.creating.set(false);
        this.createError.set(err?.error?.message || 'Failed to create series');
      }
    });
  }

  getEntityDisplayName(): string {
    const table = this.infoForm.value.entity_table;
    const entity = this.availableEntities.find(e => e.table_name === table);
    return entity?.display_name || table;
  }

  formatDateTime(dateStr: string): string {
    if (!dateStr) return '-';
    try {
      return new Date(dateStr).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    } catch {
      return dateStr;
    }
  }

  formatDuration(): string {
    const schedule = this.scheduleValue();
    if (!schedule.dtstart || !schedule.dtend) return '0m';

    const diffMs = new Date(schedule.dtend).getTime() - new Date(schedule.dtstart).getTime();
    if (diffMs <= 0) return '0m';

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    return parts.join(' ') || '0m';
  }

  getRRuleDescription(): string {
    const rrule = this.scheduleValue().rrule;
    if (!rrule) return '';
    return this.recurringService.describeRRule(rrule);
  }

  onCancel(): void {
    this.cancel.emit();
  }
}
