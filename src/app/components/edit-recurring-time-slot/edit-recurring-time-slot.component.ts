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
  forwardRef,
  signal,
  computed,
  ChangeDetectionStrategy,
  inject
} from '@angular/core';
import {
  ControlValueAccessor,
  NG_VALUE_ACCESSOR,
  NG_VALIDATORS,
  Validator,
  AbstractControl,
  ValidationErrors,
  FormsModule
} from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ConflictInfo } from '../../interfaces/entity';
import { RecurringService } from '../../services/recurring.service';
import { parseDatetimeLocal } from '../../utils/date.utils';
import { RecurrenceRuleEditorComponent } from '../recurrence-rule-editor/recurrence-rule-editor.component';
import { ConflictPreviewComponent, ConflictPreviewResult } from '../conflict-preview/conflict-preview.component';

/**
 * Value structure for RecurringTimeSlotEditComponent.
 * When not recurring, only time_slot is used.
 * When recurring, includes RRULE configuration.
 */
export interface RecurringTimeSlotValue {
  time_slot: string;           // PostgreSQL tstzrange format: "[start,end)"
  is_recurring: boolean;
  rrule?: string;              // RFC 5545 RRULE string
  series_name?: string;        // Display name for the series group
  series_description?: string; // Optional description
  series_color?: string;       // Optional hex color
}

/**
 * Recurring Time Slot Edit Component
 *
 * Form control for editing time slots with optional recurrence.
 * Combines time slot inputs with RRULE builder and conflict preview.
 *
 * Usage:
 * ```html
 * <app-edit-recurring-time-slot
 *   formControlName="time_slot"
 *   [entityTable]="'reservations'"
 *   [scopeColumn]="'resource_id'"
 *   [scopeValue]="resourceId"
 * ></app-edit-recurring-time-slot>
 * ```
 *
 * Added in v0.19.0.
 */
@Component({
  selector: 'app-edit-recurring-time-slot',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RecurrenceRuleEditorComponent,
    ConflictPreviewComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => EditRecurringTimeSlotComponent),
      multi: true
    },
    {
      provide: NG_VALIDATORS,
      useExisting: forwardRef(() => EditRecurringTimeSlotComponent),
      multi: true
    }
  ],
  template: `
    <div class="recurring-time-slot-editor space-y-4">
      <!-- Time Slot Inputs -->
      <div class="grid grid-cols-2 gap-4">
        <div class="form-control">
          <label class="label">
            <span class="label-text">Start</span>
          </label>
          <input
            type="datetime-local"
            class="input input-bordered w-full"
            [ngModel]="startDateTime()"
            (ngModelChange)="onStartChange($event)"
            [disabled]="disabled()"
          />
        </div>
        <div class="form-control">
          <label class="label">
            <span class="label-text">End</span>
          </label>
          <input
            type="datetime-local"
            class="input input-bordered w-full"
            [ngModel]="endDateTime()"
            (ngModelChange)="onEndChange($event)"
            [disabled]="disabled()"
            [min]="startDateTime()"
          />
        </div>
      </div>

      <!-- Validation Error -->
      @if (timeSlotError()) {
        <div class="text-error text-sm">{{ timeSlotError() }}</div>
      }

      <!-- Recurring Toggle -->
      <div class="form-control">
        <label class="label cursor-pointer justify-start gap-3">
          <input
            type="checkbox"
            class="toggle toggle-primary"
            [ngModel]="isRecurring()"
            (ngModelChange)="onRecurringToggle($event)"
            [disabled]="disabled()"
          />
          <span class="label-text font-medium">Make this a recurring event</span>
        </label>
      </div>

      <!-- Recurring Options (collapsed when not recurring) -->
      @if (isRecurring()) {
        <div class="border rounded-lg p-4 bg-base-200/50 space-y-4">
          <!-- Series Name -->
          <div class="form-control">
            <label class="label">
              <span class="label-text font-medium">Series Name</span>
            </label>
            <input
              type="text"
              class="input input-bordered w-full"
              placeholder="e.g., Weekly Team Meeting"
              [ngModel]="seriesName()"
              (ngModelChange)="onSeriesNameChange($event)"
              [disabled]="disabled()"
            />
          </div>

          <!-- Series Description (optional) -->
          <div class="form-control">
            <label class="label">
              <span class="label-text">Description (optional)</span>
            </label>
            <textarea
              class="textarea textarea-bordered"
              rows="2"
              placeholder="Brief description of this recurring schedule"
              [ngModel]="seriesDescription()"
              (ngModelChange)="onSeriesDescriptionChange($event)"
              [disabled]="disabled()"
            ></textarea>
          </div>

          <!-- Series Color (optional) -->
          <div class="form-control">
            <label class="label">
              <span class="label-text">Color (optional)</span>
            </label>
            <div class="flex items-center gap-2">
              <input
                type="color"
                class="w-10 h-10 rounded cursor-pointer"
                [ngModel]="seriesColor()"
                (ngModelChange)="onSeriesColorChange($event)"
                [disabled]="disabled()"
              />
              <input
                type="text"
                class="input input-bordered input-sm w-28 font-mono"
                placeholder="#3B82F6"
                [ngModel]="seriesColor()"
                (ngModelChange)="onSeriesColorChange($event)"
                [disabled]="disabled()"
              />
            </div>
          </div>

          <!-- RRULE Editor -->
          <app-recurrence-rule-editor
            [ngModel]="rrule()"
            (ngModelChange)="onRRuleChange($event)"
            [disabled]="disabled()"
            [dtstart]="startDateTime()"
          ></app-recurrence-rule-editor>

          <!-- Preview Conflicts Button -->
          @if (entityTable && scopeColumn && scopeValue) {
            <div class="flex justify-end">
              <button
                type="button"
                class="btn btn-outline btn-sm"
                (click)="previewConflicts()"
                [disabled]="disabled() || !canPreview()"
              >
                <span class="material-symbols-outlined text-base">preview</span>
                Preview Schedule
              </button>
            </div>
          }
        </div>
      }

      <!-- Conflict Preview Modal -->
      <app-conflict-preview
        [isOpen]="showConflictPreview()"
        [conflicts]="previewedConflicts()"
        [loading]="loadingPreview()"
        (confirm)="onConflictAction($event)"
        (cancel)="closeConflictPreview()"
      ></app-conflict-preview>
    </div>
  `
})
export class EditRecurringTimeSlotComponent implements ControlValueAccessor, Validator {
  private recurringService = inject(RecurringService);

  // Inputs for conflict preview
  @Input() entityTable?: string;
  @Input() scopeColumn?: string;
  @Input() scopeValue?: string;
  @Input() timeSlotColumn = 'time_slot';

  // Internal state
  startDateTime = signal('');
  endDateTime = signal('');
  isRecurring = signal(false);
  rrule = signal('');
  seriesName = signal('');
  seriesDescription = signal('');
  seriesColor = signal('#3B82F6');
  disabled = signal(false);

  // Conflict preview state
  showConflictPreview = signal(false);
  previewedConflicts = signal<ConflictInfo[]>([]);
  loadingPreview = signal(false);
  skipConflicts = signal(false);

  // Validation
  timeSlotError = computed(() => {
    const start = this.startDateTime();
    const end = this.endDateTime();
    if (!start || !end) return null;
    // Use Safari-safe parsing for datetime-local strings
    const startDate = parseDatetimeLocal(start);
    const endDate = parseDatetimeLocal(end);
    if (!startDate || !endDate) return null;
    if (endDate <= startDate) {
      return 'End time must be after start time';
    }
    return null;
  });

  canPreview = computed(() => {
    return this.startDateTime() && this.endDateTime() && this.rrule() && !this.timeSlotError();
  });

  private onChange: (value: RecurringTimeSlotValue) => void = () => {};
  private onTouched: () => void = () => {};

  // ControlValueAccessor implementation
  writeValue(value: RecurringTimeSlotValue | string): void {
    if (!value) {
      this.resetForm();
      return;
    }

    // Handle string (plain time_slot) or object (recurring config)
    if (typeof value === 'string') {
      this.parseTimeSlot(value);
      this.isRecurring.set(false);
    } else {
      if (value.time_slot) {
        this.parseTimeSlot(value.time_slot);
      }
      this.isRecurring.set(value.is_recurring || false);
      this.rrule.set(value.rrule || '');
      this.seriesName.set(value.series_name || '');
      this.seriesDescription.set(value.series_description || '');
      this.seriesColor.set(value.series_color || '#3B82F6');
    }
  }

  registerOnChange(fn: (value: RecurringTimeSlotValue) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  // Validator implementation
  validate(control: AbstractControl): ValidationErrors | null {
    if (this.timeSlotError()) {
      return { invalidTimeSlot: this.timeSlotError() };
    }
    if (this.isRecurring() && !this.rrule()) {
      return { missingRRule: 'Recurrence rule is required for recurring events' };
    }
    if (this.isRecurring() && !this.seriesName()) {
      return { missingSeriesName: 'Series name is required for recurring events' };
    }
    return null;
  }

  // Event handlers
  onStartChange(value: string): void {
    this.startDateTime.set(value);
    this.emitChange();
    this.onTouched();
  }

  onEndChange(value: string): void {
    this.endDateTime.set(value);
    this.emitChange();
    this.onTouched();
  }

  onRecurringToggle(value: boolean): void {
    this.isRecurring.set(value);
    if (!value) {
      // Clear recurring-specific fields
      this.rrule.set('');
      this.skipConflicts.set(false);
    }
    this.emitChange();
    this.onTouched();
  }

  onRRuleChange(value: string): void {
    this.rrule.set(value);
    this.emitChange();
  }

  onSeriesNameChange(value: string): void {
    this.seriesName.set(value);
    this.emitChange();
  }

  onSeriesDescriptionChange(value: string): void {
    this.seriesDescription.set(value);
    this.emitChange();
  }

  onSeriesColorChange(value: string): void {
    this.seriesColor.set(value);
    this.emitChange();
  }

  // Conflict preview
  previewConflicts(): void {
    if (!this.entityTable || !this.scopeColumn || !this.scopeValue) return;

    this.showConflictPreview.set(true);
    this.loadingPreview.set(true);

    // Generate occurrences from RRULE for preview
    const occurrences = this.generateOccurrencesForPreview();

    this.recurringService.previewConflicts({
      entityTable: this.entityTable,
      scopeColumn: this.scopeColumn,
      scopeValue: this.scopeValue,
      timeSlotColumn: this.timeSlotColumn,
      occurrences
    }).subscribe({
      next: (conflicts) => {
        this.previewedConflicts.set(conflicts);
        this.loadingPreview.set(false);
      },
      error: () => {
        this.previewedConflicts.set([]);
        this.loadingPreview.set(false);
      }
    });
  }

  onConflictAction(result: ConflictPreviewResult): void {
    if (result.action === 'cancel') {
      this.closeConflictPreview();
      return;
    }

    this.skipConflicts.set(result.action === 'create_available');
    this.closeConflictPreview();
    this.emitChange();
  }

  closeConflictPreview(): void {
    this.showConflictPreview.set(false);
  }

  // Helpers
  private parseTimeSlot(slot: string): void {
    // Parse PostgreSQL tstzrange format: "[2025-03-15 14:00:00+00,2025-03-15 16:00:00+00)"
    const match = slot.match(/[\[\(](.+?),(.+?)[\]\)]/);
    if (match) {
      const start = new Date(match[1].trim());
      const end = new Date(match[2].trim());
      this.startDateTime.set(this.formatForInput(start));
      this.endDateTime.set(this.formatForInput(end));
    }
  }

  private formatForInput(date: Date): string {
    // Format as YYYY-MM-DDTHH:mm for datetime-local input
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  private buildTimeSlot(): string {
    const start = this.startDateTime();
    const end = this.endDateTime();
    if (!start || !end) return '';

    // Convert to ISO format for PostgreSQL
    // Use Safari-safe parsing for datetime-local strings
    const startDate = parseDatetimeLocal(start);
    const endDate = parseDatetimeLocal(end);
    if (!startDate || !endDate) return '';
    return `[${startDate.toISOString()},${endDate.toISOString()})`;
  }

  private generateOccurrencesForPreview(): Array<[string, string]> {
    // For preview, generate first 20 occurrences (or until RRULE ends)
    // This is a simplified frontend calculation - actual expansion happens server-side
    // Use Safari-safe parsing for datetime-local strings
    const start = parseDatetimeLocal(this.startDateTime());
    const end = parseDatetimeLocal(this.endDateTime());
    if (!start || !end) return [];
    const duration = end.getTime() - start.getTime();

    const occurrences: Array<[string, string]> = [];
    const rrule = this.rrule();

    // Parse frequency from RRULE
    const freqMatch = rrule.match(/FREQ=(\w+)/);
    const intervalMatch = rrule.match(/INTERVAL=(\d+)/);
    const countMatch = rrule.match(/COUNT=(\d+)/);

    const freq = freqMatch?.[1] || 'WEEKLY';
    const interval = parseInt(intervalMatch?.[1] || '1', 10);
    const count = Math.min(parseInt(countMatch?.[1] || '20', 10), 20);

    let current = new Date(start);
    for (let i = 0; i < count; i++) {
      const occStart = new Date(current);
      const occEnd = new Date(current.getTime() + duration);
      occurrences.push([occStart.toISOString(), occEnd.toISOString()]);

      // Advance based on frequency
      switch (freq) {
        case 'DAILY':
          current.setDate(current.getDate() + interval);
          break;
        case 'WEEKLY':
          current.setDate(current.getDate() + (7 * interval));
          break;
        case 'MONTHLY':
          current.setMonth(current.getMonth() + interval);
          break;
        case 'YEARLY':
          current.setFullYear(current.getFullYear() + interval);
          break;
      }
    }

    return occurrences;
  }

  private emitChange(): void {
    const value: RecurringTimeSlotValue = {
      time_slot: this.buildTimeSlot(),
      is_recurring: this.isRecurring(),
      rrule: this.isRecurring() ? this.rrule() : undefined,
      series_name: this.isRecurring() ? this.seriesName() : undefined,
      series_description: this.isRecurring() ? this.seriesDescription() || undefined : undefined,
      series_color: this.isRecurring() ? this.seriesColor() || undefined : undefined
    };
    this.onChange(value);
  }

  private resetForm(): void {
    this.startDateTime.set('');
    this.endDateTime.set('');
    this.isRecurring.set(false);
    this.rrule.set('');
    this.seriesName.set('');
    this.seriesDescription.set('');
    this.seriesColor.set('#3B82F6');
  }
}
