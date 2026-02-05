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
  ChangeDetectionStrategy,
  OnChanges,
  SimpleChanges
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { SeriesGroup, Series, SchemaEntityProperty, EntityPropertyType } from '../../interfaces/entity';
import { RecurringScheduleFormComponent, RecurringScheduleValue } from '../recurring-schedule-form/recurring-schedule-form.component';
import { EditPropertyComponent } from '../edit-property/edit-property.component';
import { CosModalComponent } from '../cos-modal/cos-modal.component';
import { SchemaService } from '../../services/schema.service';
import { RecurringService } from '../../services/recurring.service';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

/**
 * Series Editor Modal
 *
 * Full-featured modal for editing recurring series including:
 * - Group metadata (name, description, color)
 * - Entity template fields (dynamically loaded based on entity schema)
 * - Recurrence pattern (RRULE)
 *
 * Usage:
 * ```html
 * <app-series-editor-modal
 *   [isOpen]="showEditModal()"
 *   [group]="selectedGroup"
 *   [series]="currentSeries"
 *   (save)="onSave($event)"
 *   (cancel)="closeModal()"
 * ></app-series-editor-modal>
 * ```
 *
 * Added in v0.19.0.
 */
@Component({
  selector: 'app-series-editor-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    RecurringScheduleFormComponent,
    EditPropertyComponent,
    CosModalComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <cos-modal [isOpen]="isOpen" (closed)="onCancel()" size="lg">
      <h3 class="font-bold text-lg mb-4 flex items-center gap-2">
        <span class="material-symbols-outlined">edit</span>
        Edit Recurring Series
      </h3>

      @if (loading()) {
        <div class="flex items-center justify-center py-12">
          <span class="loading loading-spinner loading-lg"></span>
        </div>
      } @else if (error()) {
        <div class="alert alert-error mb-4">
          <span>{{ error() }}</span>
        </div>
      } @else {
        <!-- Tabs -->
        <div class="tabs tabs-box mb-4">
          <button
            class="tab"
            [class.tab-active]="activeTab() === 'info'"
            (click)="activeTab.set('info')"
          >
            Series Info
          </button>
          <button
            class="tab"
            [class.tab-active]="activeTab() === 'template'"
            (click)="activeTab.set('template')"
          >
            {{ group?.entity_table || 'Entity' }} Fields
          </button>
          <button
            class="tab"
            [class.tab-active]="activeTab() === 'schedule'"
            (click)="activeTab.set('schedule')"
          >
            Schedule
          </button>
        </div>

        <form [formGroup]="form">
          <!-- Tab: Series Info -->
          @if (activeTab() === 'info') {
            <div class="space-y-4">
              <div class="form-control">
                <label class="label">
                  <span class="label-text font-medium">Series Name</span>
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
                  <span class="label-text">Description (optional)</span>
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
            </div>
          }

          <!-- Tab: Entity Template Fields -->
          @if (activeTab() === 'template') {
            <div class="space-y-4">
              @if (templateProperties().length === 0) {
                <div class="alert">
                  <span class="material-symbols-outlined">info</span>
                  <span>No editable template fields found.</span>
                </div>
              } @else {
                <p class="text-sm text-base-content/70 mb-4">
                  These values will be applied to all future occurrences in this series.
                </p>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4" formGroupName="template">
                  @for (prop of templateProperties(); track prop.column_name) {
                    <div [class.md:col-span-2]="isWideField(prop)">
                      <app-edit-property
                        [property]="prop"
                        [formGroup]="templateFormGroup"
                      ></app-edit-property>
                    </div>
                  }
                </div>
              }
            </div>
          }

          <!-- Tab: Schedule (RRULE) -->
          @if (activeTab() === 'schedule') {
            <div class="space-y-6">
              <app-recurring-schedule-form
                [dtstart]="scheduleValue().dtstart"
                [dtend]="scheduleValue().dtend"
                [rrule]="scheduleValue().rrule"
                (valueChange)="onScheduleChange($event)"
              ></app-recurring-schedule-form>

              @if (series?.expanded_until) {
                <div class="alert alert-info">
                  <span class="material-symbols-outlined">info</span>
                  <span>Series expanded until {{ formatDateTime(series!.expanded_until!) }}</span>
                </div>
              }
            </div>
          }
        </form>
      }

      <div class="cos-modal-action">
        <button class="btn btn-ghost" (click)="onCancel()" [disabled]="saving()">
          Cancel
        </button>
        <button
          class="btn btn-primary"
          (click)="onSave()"
          [disabled]="saving() || loading() || !form.valid || !scheduleValue().isValid"
        >
          @if (saving()) {
            <span class="loading loading-spinner loading-sm"></span>
          }
          Save Changes
        </button>
      </div>
    </cos-modal>
  `
})
export class SeriesEditorModalComponent implements OnChanges {
  private fb = inject(FormBuilder);
  private schemaService = inject(SchemaService);
  private recurringService = inject(RecurringService);

  @Input() isOpen = false;
  @Input() group?: SeriesGroup;
  @Input() series?: Series;

  @Output() save = new EventEmitter<{ group: Partial<SeriesGroup>; series: Partial<Series> }>();
  @Output() cancel = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  // State
  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  activeTab = signal<'info' | 'template' | 'schedule'>('info');

  // Schema data
  entityProperties = signal<SchemaEntityProperty[]>([]);

  // Schedule state (managed by shared component)
  scheduleValue = signal<RecurringScheduleValue>({
    dtstart: '',
    dtend: '',
    rrule: 'FREQ=WEEKLY;COUNT=10',
    duration: 'PT1H',
    isValid: false
  });

  // Form (info and template only, schedule is signal-based)
  form: FormGroup = this.fb.group({
    display_name: ['', Validators.required],
    description: [''],
    color: ['#3B82F6'],
    template: this.fb.group({})
  });

  get templateFormGroup(): FormGroup {
    return this.form.get('template') as FormGroup;
  }

  templateProperties = computed(() => {
    // Filter to properties that are editable (show_on_edit)
    // Use show_on_edit since this is for manager-edited recurring series templates
    const props = this.entityProperties();
    const timeSlotProp = props.find(p => p.is_recurring === true)?.column_name || 'time_slot';

    return props.filter(p =>
      p.column_name !== 'id' &&
      p.column_name !== timeSlotProp &&
      !p.column_name.endsWith('_at') &&
      p.column_name !== 'display_name' &&
      (p.show_on_edit !== false || p.show_on_create !== false)
    );
  });

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['isOpen'] || changes['group'] || changes['series']) && this.isOpen && this.group) {
      this.loadData();
    }
  }

  private loadData(): void {
    if (!this.group?.entity_table) return;

    this.loading.set(true);
    this.error.set(null);

    // Load entity schema
    const entityTable = this.group.entity_table;
    this.schemaService.getProperties().pipe(
      map(allProps => allProps.filter(p => p.table_name === entityTable)),
      catchError(err => {
        console.error('Failed to load entity schema:', err);
        return of([]);
      })
    ).subscribe(properties => {
      this.entityProperties.set(properties);
      this.initializeForm();
      this.loading.set(false);
    });
  }

  private initializeForm(): void {
    // Set group info
    this.form.patchValue({
      display_name: this.group?.display_name || '',
      description: this.group?.description || '',
      color: this.group?.color || '#3B82F6'
    });

    // Set schedule values via signal
    if (this.series) {
      const dtstart = this.formatDateTimeLocal(this.series.dtstart);
      const duration = this.parseDuration(this.series.duration);
      const dtstartDate = new Date(this.series.dtstart);
      dtstartDate.setHours(dtstartDate.getHours() + duration.hours);
      dtstartDate.setMinutes(dtstartDate.getMinutes() + duration.minutes);
      const dtend = this.formatDateTimeLocal(dtstartDate.toISOString());

      this.scheduleValue.set({
        dtstart,
        dtend,
        rrule: this.series.rrule || 'FREQ=WEEKLY;COUNT=10',
        duration: this.series.duration || 'PT1H',
        isValid: true
      });
    }

    // Build template form controls
    this.buildTemplateForm();
  }

  private buildTemplateForm(): void {
    const templateGroup = this.form.get('template') as FormGroup;
    const template = this.series?.entity_template || {};
    const props = this.templateProperties();

    // Clear existing controls
    Object.keys(templateGroup.controls).forEach(key => {
      templateGroup.removeControl(key);
    });

    // Add controls for each template property (use show_on_edit filtered list)
    props.forEach(prop => {
      const value = template[prop.column_name] ?? null;
      templateGroup.addControl(prop.column_name, this.fb.control(value));
    });
  }

  // Schedule change handler (from shared component)
  onScheduleChange(value: RecurringScheduleValue): void {
    this.scheduleValue.set(value);
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

  describeRRule(rrule: string): string {
    return this.recurringService.describeRRule(rrule);
  }

  formatDuration(duration: string): string {
    const parsed = this.parseDuration(duration);
    const parts: string[] = [];
    if (parsed.hours > 0) parts.push(`${parsed.hours}h`);
    if (parsed.minutes > 0) parts.push(`${parsed.minutes}m`);
    return parts.join(' ') || '0m';
  }

  isWideField(prop: SchemaEntityProperty): boolean {
    return prop.type === EntityPropertyType.TextLong ||
           prop.type === EntityPropertyType.GeoPoint ||
           (prop.column_width !== undefined && prop.column_width > 1);
  }

  private formatDateTimeLocal(isoString: string): string {
    try {
      const date = new Date(isoString);
      const pad = (n: number) => n.toString().padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    } catch {
      return '';
    }
  }

  private parseDuration(isoDuration: string): { hours: number; minutes: number } {
    // Parse ISO 8601 duration like "PT1H" or "PT1H30M"
    const match = isoDuration?.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
    return {
      hours: parseInt(match?.[1] || '1', 10),
      minutes: parseInt(match?.[2] || '0', 10)
    };
  }

  onSave(): void {
    const schedule = this.scheduleValue();
    if (!this.form.valid || !schedule.isValid || !this.group || !this.series) return;

    this.saving.set(true);
    this.error.set(null);

    const formValue = this.form.value;

    // Build group update
    const groupUpdate: Partial<SeriesGroup> = {
      id: this.group.id,
      display_name: formValue.display_name,
      description: formValue.description || null,
      color: formValue.color || null
    };

    // Build series update (schedule values from signal)
    const seriesUpdate: Partial<Series> = {
      id: this.series.id,
      entity_template: formValue.template,
      dtstart: new Date(schedule.dtstart).toISOString(),
      duration: schedule.duration,
      rrule: schedule.rrule
    };

    // Call APIs to update
    forkJoin([
      this.recurringService.updateSeriesGroupInfo(
        this.group.id,
        groupUpdate.display_name!,
        groupUpdate.description || null,
        groupUpdate.color || null
      ),
      this.recurringService.updateSeriesTemplate(
        this.series.id,
        seriesUpdate.entity_template!
      ),
      this.recurringService.updateSeriesSchedule(
        this.series.id,
        seriesUpdate.dtstart!,
        seriesUpdate.duration!,
        seriesUpdate.rrule!
      )
    ]).pipe(
      catchError(err => {
        this.error.set('Failed to save changes: ' + (err?.message || 'Unknown error'));
        return of(null);
      })
    ).subscribe(result => {
      this.saving.set(false);
      if (result) {
        this.saved.emit();
        this.save.emit({ group: groupUpdate, series: seriesUpdate });
      }
    });
  }

  onCancel(): void {
    this.cancel.emit();
  }
}
