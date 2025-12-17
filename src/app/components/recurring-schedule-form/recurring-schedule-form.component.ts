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
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  computed,
  effect,
  OnInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RecurrenceRuleEditorComponent } from '../recurrence-rule-editor/recurrence-rule-editor.component';
import { RecurringService } from '../../services/recurring.service';

/**
 * Value emitted by the RecurringScheduleFormComponent.
 */
export interface RecurringScheduleValue {
  dtstart: string;       // datetime-local string
  dtend: string;         // datetime-local string
  rrule: string;         // RRULE string
  duration: string;      // ISO 8601 duration (e.g., 'PT1H30M')
  isValid: boolean;      // Whether the form is valid
}

/**
 * Shared component for recurring schedule forms.
 * Used by create-series-wizard, series-editor-modal, and series-group-detail.
 *
 * Features:
 * - Start/end datetime inputs with validation
 * - Auto-advance end time when start changes
 * - Duration display
 * - RRULE editor with auto-populated weekday position
 * - Emits complete schedule value on any change
 *
 * Usage:
 * ```html
 * <app-recurring-schedule-form
 *   [dtstart]="initialStart"
 *   [dtend]="initialEnd"
 *   [rrule]="initialRrule"
 *   [disabled]="false"
 *   (valueChange)="onScheduleChange($event)"
 * ></app-recurring-schedule-form>
 * ```
 *
 * Added in v0.19.0.
 */
@Component({
  selector: 'app-recurring-schedule-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RecurrenceRuleEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-6">
      <!-- Time Slot -->
      <div class="border rounded-lg p-4">
        <h4 class="font-medium mb-4">{{ timeSlotLabel() }}</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="form-control">
            <label class="label">
              <span class="label-text">Start</span>
            </label>
            <input
              type="datetime-local"
              class="input input-bordered w-full"
              [ngModel]="dtstartInternal()"
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
              [ngModel]="dtendInternal()"
              (ngModelChange)="onEndChange($event)"
              [disabled]="disabled()"
              [min]="dtstartInternal()"
            />
            @if (timeRangeError()) {
              <p class="text-xs text-error mt-1">{{ timeRangeError() }}</p>
            }
            @if (!timeRangeError() && durationDisplay()) {
              <p class="text-xs text-base-content/60 mt-1">
                Duration: {{ durationDisplay() }}
              </p>
            }
          </div>
        </div>
      </div>

      <!-- Recurrence Pattern -->
      <div class="border rounded-lg p-4">
        <h4 class="font-medium mb-4">{{ recurrenceLabel() }}</h4>
        <app-recurrence-rule-editor
          [ngModel]="rruleInternal()"
          (ngModelChange)="onRruleChange($event)"
          [disabled]="disabled()"
          [dtstart]="dtstartInternal()"
        ></app-recurrence-rule-editor>
      </div>
    </div>
  `
})
export class RecurringScheduleFormComponent implements OnInit {
  // Inputs
  dtstart = input<string>('');
  dtend = input<string>('');
  rrule = input<string>('FREQ=WEEKLY;COUNT=10');
  disabled = input<boolean>(false);
  timeSlotLabel = input<string>('Time Slot');
  recurrenceLabel = input<string>('Recurrence Pattern');

  // Output
  valueChange = output<RecurringScheduleValue>();

  // Internal state (mutable copies of inputs)
  dtstartInternal = signal<string>('');
  dtendInternal = signal<string>('');
  rruleInternal = signal<string>('FREQ=WEEKLY;COUNT=10');

  // Track whether component has been initialized
  private initialized = false;

  // Computed
  timeRangeError = computed(() => {
    const start = this.dtstartInternal();
    const end = this.dtendInternal();
    if (!start || !end) return null;
    if (new Date(end) <= new Date(start)) {
      return 'End must be after start';
    }
    return null;
  });

  durationDisplay = computed(() => {
    const start = this.dtstartInternal();
    const end = this.dtendInternal();
    if (!start || !end) return '';

    const startDate = new Date(start);
    const endDate = new Date(end);
    const diffMs = endDate.getTime() - startDate.getTime();
    if (diffMs <= 0) return '';

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours === 0) return `${minutes} min`;
    if (minutes === 0) return `${hours} hr`;
    return `${hours} hr ${minutes} min`;
  });

  isValid = computed(() => {
    return !!this.dtstartInternal() &&
           !!this.dtendInternal() &&
           !!this.rruleInternal() &&
           !this.timeRangeError();
  });

  constructor(private recurringService: RecurringService) {
    // Sync inputs to internal state ONLY when inputs change from parent
    // The initialized flag prevents user edits from being overwritten
    effect(() => {
      const dtstart = this.dtstart();
      // Always sync on first run, then only when parent explicitly changes input
      if (!this.initialized || (dtstart && dtstart !== this.dtstartInternal())) {
        if (dtstart) {
          this.dtstartInternal.set(dtstart);
        }
      }
    });

    effect(() => {
      const dtend = this.dtend();
      if (!this.initialized || (dtend && dtend !== this.dtendInternal())) {
        if (dtend) {
          this.dtendInternal.set(dtend);
        }
      }
    });

    effect(() => {
      const rrule = this.rrule();
      if (!this.initialized || (rrule && rrule !== this.rruleInternal())) {
        if (rrule) {
          this.rruleInternal.set(rrule);
        }
      }
    });
  }

  ngOnInit(): void {
    // Initialize internal state from inputs on component creation
    const dtstart = this.dtstart();
    const dtend = this.dtend();
    const rrule = this.rrule();

    // Set internal state from inputs
    if (dtstart) this.dtstartInternal.set(dtstart);
    if (dtend) this.dtendInternal.set(dtend);
    if (rrule) this.rruleInternal.set(rrule);

    this.initialized = true;

    // Emit initial value so parent knows the state
    this.emitValue();
  }

  onStartChange(value: string): void {
    this.dtstartInternal.set(value);

    // Auto-advance end if not set or if end is before new start
    const end = this.dtendInternal();
    if (value && (!end || new Date(end) <= new Date(value))) {
      const startDate = new Date(value);
      startDate.setHours(startDate.getHours() + 1);
      this.dtendInternal.set(this.formatDateTimeLocal(startDate.toISOString()));
    }

    this.emitValue();
  }

  onEndChange(value: string): void {
    this.dtendInternal.set(value);
    this.emitValue();
  }

  onRruleChange(value: string): void {
    this.rruleInternal.set(value);
    this.emitValue();
  }

  private emitValue(): void {
    this.valueChange.emit({
      dtstart: this.dtstartInternal(),
      dtend: this.dtendInternal(),
      rrule: this.rruleInternal(),
      duration: this.buildDuration(),
      isValid: this.isValid()
    });
  }

  /**
   * Build ISO 8601 duration string from start/end times.
   */
  private buildDuration(): string {
    const start = this.dtstartInternal();
    const end = this.dtendInternal();
    if (!start || !end) return 'PT1H';

    const startDate = new Date(start);
    const endDate = new Date(end);
    const diffMs = endDate.getTime() - startDate.getTime();
    if (diffMs <= 0) return 'PT1H';

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0 && minutes > 0) {
      return `PT${hours}H${minutes}M`;
    } else if (hours > 0) {
      return `PT${hours}H`;
    } else {
      return `PT${minutes}M`;
    }
  }

  /**
   * Format ISO timestamp for datetime-local input.
   */
  private formatDateTimeLocal(isoString: string): string {
    const date = new Date(isoString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }
}
