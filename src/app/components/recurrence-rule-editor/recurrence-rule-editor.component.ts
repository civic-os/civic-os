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

import { Component, forwardRef, signal, computed, effect, ChangeDetectionStrategy, inject, input } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR, FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { RRuleFrequency, RRuleDayOfWeek, RRuleConfig } from '../../interfaces/entity';
import { RecurringService } from '../../services/recurring.service';
import { parseDatetimeLocal } from '../../utils/date.utils';

/**
 * RRULE Builder Component
 *
 * A visual editor for building RFC 5545 RRULE strings.
 * Outputs RRULE string format (e.g., "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10").
 *
 * Usage:
 * ```html
 * <app-recurrence-rule-editor
 *   formControlName="rrule"
 *   [dtstart]="startDate"
 * ></app-recurrence-rule-editor>
 * ```
 *
 * The optional `dtstart` input helps pre-populate BYSETPOS fields when the user
 * selects Monthly frequency. For example, if dtstart is the 2nd Tuesday of a month,
 * the "Nth weekday" fields will auto-populate with "2nd" and "Tuesday".
 *
 * Added in v0.19.0.
 */
@Component({
  selector: 'app-recurrence-rule-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => RecurrenceRuleEditorComponent),
      multi: true
    }
  ],
  template: `
    <div class="recurrence-editor space-y-4">
      <!-- Frequency -->
      <div class="form-control">
        <label class="label">
          <span class="label-text font-medium">Repeat</span>
        </label>
        <select
          class="select select-bordered w-full"
          [ngModel]="frequency()"
          (ngModelChange)="onFrequencyChange($event)"
          [disabled]="disabled()"
        >
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
          <option value="YEARLY">Yearly</option>
        </select>
      </div>

      <!-- Interval -->
      <div class="form-control">
        <label class="label">
          <span class="label-text">Every</span>
        </label>
        <div class="flex items-center gap-2">
          <input
            type="number"
            class="input input-bordered w-24"
            min="1"
            max="99"
            [ngModel]="interval()"
            (ngModelChange)="onIntervalChange($event)"
            [disabled]="disabled()"
          />
          <span class="text-base-content">{{ intervalUnit() }}</span>
        </div>
      </div>

      <!-- Day of Week (for WEEKLY) -->
      @if (frequency() === 'WEEKLY') {
        <div class="form-control">
          <label class="label">
            <span class="label-text">On these days</span>
          </label>
          <div class="flex flex-wrap gap-2">
            @for (day of daysOfWeek; track day.code) {
              <label class="cursor-pointer">
                <input
                  type="checkbox"
                  class="checkbox checkbox-sm hidden peer"
                  [checked]="isDaySelected(day.code)"
                  (change)="toggleDay(day.code)"
                  [disabled]="disabled()"
                />
                <span class="btn btn-sm peer-checked:btn-primary">
                  {{ day.short }}
                </span>
              </label>
            }
          </div>
        </div>
      }

      <!-- Monthly Type Selector (for MONTHLY) -->
      @if (frequency() === 'MONTHLY') {
        <div class="form-control mb-2">
          <label class="label">
            <span class="label-text">Repeat by</span>
          </label>
          <div class="space-y-2">
            <!-- Day of Month option -->
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                class="radio radio-sm"
                name="monthlyType"
                value="dayOfMonth"
                [checked]="monthlyType() === 'dayOfMonth'"
                (change)="onMonthlyTypeChange('dayOfMonth')"
                [disabled]="disabled()"
              />
              <span>Day</span>
              <input
                type="number"
                class="input input-bordered input-sm w-20"
                min="1"
                max="31"
                [ngModel]="monthDay()"
                (ngModelChange)="onMonthDayChange($event)"
                [disabled]="disabled() || monthlyType() !== 'dayOfMonth'"
              />
              <span>of the month</span>
            </label>
            <!-- Nth Weekday option (BYSETPOS) -->
            <label class="flex items-center gap-2 cursor-pointer flex-wrap">
              <input
                type="radio"
                class="radio radio-sm"
                name="monthlyType"
                value="weekdayPosition"
                [checked]="monthlyType() === 'weekdayPosition'"
                (change)="onMonthlyTypeChange('weekdayPosition')"
                [disabled]="disabled()"
              />
              <span>The</span>
              <select
                class="select select-bordered select-sm w-24"
                [ngModel]="weekPosition()"
                (ngModelChange)="onWeekPositionChange($event)"
                [disabled]="disabled() || monthlyType() !== 'weekdayPosition'"
              >
                @for (pos of positionOptions; track pos.value) {
                  <option [ngValue]="pos.value">{{ pos.label }}</option>
                }
              </select>
              <select
                class="select select-bordered select-sm w-32"
                [ngModel]="weekDay()"
                (ngModelChange)="onWeekDayChange($event)"
                [disabled]="disabled() || monthlyType() !== 'weekdayPosition'"
              >
                @for (day of daysOfWeek; track day.code) {
                  <option [ngValue]="day.code">{{ day.full }}</option>
                }
              </select>
            </label>
          </div>
        </div>
      }

      <!-- End Condition -->
      <div class="form-control">
        <label class="label">
          <span class="label-text font-medium">Ends</span>
        </label>
        <div class="space-y-2">
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              class="radio radio-sm"
              name="endType"
              value="never"
              [checked]="endType() === 'never'"
              (change)="onEndTypeChange('never')"
              [disabled]="disabled()"
            />
            <span>Never</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              class="radio radio-sm"
              name="endType"
              value="count"
              [checked]="endType() === 'count'"
              (change)="onEndTypeChange('count')"
              [disabled]="disabled()"
            />
            <span>After</span>
            <input
              type="number"
              class="input input-bordered input-sm w-20"
              min="1"
              max="999"
              [ngModel]="count()"
              (ngModelChange)="onCountChange($event)"
              [disabled]="disabled() || endType() !== 'count'"
            />
            <span>occurrences</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              class="radio radio-sm"
              name="endType"
              value="until"
              [checked]="endType() === 'until'"
              (change)="onEndTypeChange('until')"
              [disabled]="disabled()"
            />
            <span>On</span>
            <input
              type="date"
              class="input input-bordered input-sm"
              [ngModel]="until()"
              (ngModelChange)="onUntilChange($event)"
              [disabled]="disabled() || endType() !== 'until'"
            />
          </label>
        </div>
      </div>

      <!-- Preview -->
      @if (rrulePreview()) {
        <div class="bg-base-200 rounded-lg p-3">
          <p class="text-sm font-medium text-base-content/70">Schedule</p>
          <p class="text-base-content">{{ rruleDescription() }}</p>
          <p class="text-xs text-base-content/50 mt-1 font-mono">{{ rrulePreview() }}</p>
        </div>
      }
    </div>
  `
})
export class RecurrenceRuleEditorComponent implements ControlValueAccessor {
  private recurringService = inject(RecurringService);

  /**
   * Optional start date to help pre-populate BYSETPOS fields.
   * When user selects Monthly frequency, the weekday position is calculated from this date.
   */
  dtstart = input<Date | string | null>(null);

  // Internal state
  frequency = signal<RRuleFrequency>('WEEKLY');
  interval = signal(1);
  selectedDays = signal<RRuleDayOfWeek[]>([]);
  monthDay = signal(1);
  // For BYSETPOS: "Nth weekday of month" (e.g., 2nd Tuesday)
  monthlyType = signal<'dayOfMonth' | 'weekdayPosition'>('dayOfMonth');
  weekPosition = signal(1);  // 1-5 for 1st-5th, -1 for last
  weekDay = signal<RRuleDayOfWeek>('MO');
  endType = signal<'never' | 'count' | 'until'>('never');
  count = signal(10);
  until = signal('');
  disabled = signal(false);

  // Position options for BYSETPOS dropdown
  positionOptions = [
    { value: 1, label: '1st' },
    { value: 2, label: '2nd' },
    { value: 3, label: '3rd' },
    { value: 4, label: '4th' },
    { value: 5, label: '5th' },
    { value: -1, label: 'Last' }
  ];

  // Days of week options
  daysOfWeek: Array<{ code: RRuleDayOfWeek; short: string; full: string }> = [
    { code: 'SU', short: 'S', full: 'Sunday' },
    { code: 'MO', short: 'M', full: 'Monday' },
    { code: 'TU', short: 'T', full: 'Tuesday' },
    { code: 'WE', short: 'W', full: 'Wednesday' },
    { code: 'TH', short: 'T', full: 'Thursday' },
    { code: 'FR', short: 'F', full: 'Friday' },
    { code: 'SA', short: 'S', full: 'Saturday' }
  ];

  // Computed
  intervalUnit = computed(() => {
    const freq = this.frequency();
    const int = this.interval();
    switch (freq) {
      case 'DAILY': return int === 1 ? 'day' : 'days';
      case 'WEEKLY': return int === 1 ? 'week' : 'weeks';
      case 'MONTHLY': return int === 1 ? 'month' : 'months';
      case 'YEARLY': return int === 1 ? 'year' : 'years';
    }
  });

  rrulePreview = computed(() => {
    return this.buildRRule();
  });

  rruleDescription = computed(() => {
    const rrule = this.buildRRule();
    return rrule ? this.recurringService.describeRRule(rrule) : '';
  });

  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};

  constructor() {
    // Emit RRULE string when any value changes
    effect(() => {
      // Access all signals to create dependency
      this.frequency();
      this.interval();
      this.selectedDays();
      this.monthDay();
      this.monthlyType();
      this.weekPosition();
      this.weekDay();
      this.endType();
      this.count();
      this.until();

      const rrule = this.buildRRule();
      if (rrule) {
        this.onChange(rrule);
      }
    });
  }

  // ControlValueAccessor implementation
  writeValue(value: string): void {
    if (!value) {
      this.setDefaults();
      return;
    }

    const config = this.recurringService.parseRRuleString(value);

    if (config.frequency) {
      this.frequency.set(config.frequency);
    }
    if (config.interval) {
      this.interval.set(config.interval);
    }
    if (config.byDay) {
      this.selectedDays.set(config.byDay);
    }

    // Handle BYSETPOS (Nth weekday pattern) vs BYMONTHDAY for monthly frequency
    if (config.bySetPos && config.bySetPos.length > 0 && config.byDay && config.byDay.length > 0) {
      // BYSETPOS pattern: "Nth weekday of month"
      this.monthlyType.set('weekdayPosition');
      this.weekPosition.set(config.bySetPos[0]);
      this.weekDay.set(config.byDay[0]);
    } else if (config.byMonthDay && config.byMonthDay.length > 0) {
      this.monthlyType.set('dayOfMonth');
      this.monthDay.set(config.byMonthDay[0]);
    }

    if (config.count) {
      this.endType.set('count');
      this.count.set(config.count);
    } else if (config.until) {
      this.endType.set('until');
      this.until.set(config.until);
    } else {
      this.endType.set('never');
    }
  }

  registerOnChange(fn: any): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: any): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  // Event handlers
  onFrequencyChange(freq: RRuleFrequency): void {
    this.frequency.set(freq);

    // Pre-populate BYSETPOS fields from dtstart when switching to Monthly
    if (freq === 'MONTHLY') {
      this.prepopulateFromDtstart();
    }

    this.onTouched();
  }

  /**
   * Pre-populate weekday position fields from dtstart.
   * Called when frequency changes to MONTHLY.
   */
  private prepopulateFromDtstart(): void {
    const dtstartValue = this.dtstart();
    if (!dtstartValue) return;

    // Use Safari-safe parsing for datetime-local strings
    const date = dtstartValue instanceof Date
      ? dtstartValue
      : parseDatetimeLocal(dtstartValue as string);
    if (!date || isNaN(date.getTime())) return;

    const { position, weekday } = this.calculateWeekdayPosition(date);

    // Pre-populate both monthDay and weekday position
    this.monthDay.set(date.getDate());
    this.weekPosition.set(position);
    this.weekDay.set(weekday);
  }

  /**
   * Calculate which occurrence of a weekday a date falls on within its month.
   * For example, January 14, 2025 (Tuesday) is the 2nd Tuesday of the month.
   *
   * @param date The date to analyze
   * @returns Object with position (1-5) and weekday code
   */
  private calculateWeekdayPosition(date: Date): { position: number; weekday: RRuleDayOfWeek } {
    const dayOfMonth = date.getDate();
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, etc.

    // Map JS day index to RRULE day codes
    const dayMap: RRuleDayOfWeek[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const weekday = dayMap[dayOfWeek];

    // Calculate position: which occurrence of this weekday in the month
    // Day 1-7 = 1st occurrence, Day 8-14 = 2nd, Day 15-21 = 3rd, Day 22-28 = 4th, Day 29-31 = 5th
    const position = Math.ceil(dayOfMonth / 7);

    return { position, weekday };
  }

  onIntervalChange(value: number): void {
    this.interval.set(Math.max(1, value || 1));
    this.onTouched();
  }

  toggleDay(code: RRuleDayOfWeek): void {
    const current = this.selectedDays();
    if (current.includes(code)) {
      this.selectedDays.set(current.filter(d => d !== code));
    } else {
      this.selectedDays.set([...current, code]);
    }
    this.onTouched();
  }

  isDaySelected(code: RRuleDayOfWeek): boolean {
    return this.selectedDays().includes(code);
  }

  onMonthDayChange(value: number): void {
    this.monthDay.set(Math.min(31, Math.max(1, value || 1)));
    this.onTouched();
  }

  onMonthlyTypeChange(type: 'dayOfMonth' | 'weekdayPosition'): void {
    this.monthlyType.set(type);
    this.onTouched();
  }

  onWeekPositionChange(value: number): void {
    this.weekPosition.set(value);
    this.onTouched();
  }

  onWeekDayChange(value: RRuleDayOfWeek): void {
    this.weekDay.set(value);
    this.onTouched();
  }

  onEndTypeChange(type: 'never' | 'count' | 'until'): void {
    this.endType.set(type);
    this.onTouched();
  }

  onCountChange(value: number): void {
    this.count.set(Math.max(1, value || 1));
    this.onTouched();
  }

  onUntilChange(value: string): void {
    this.until.set(value);
    this.onTouched();
  }

  // Build RRULE string
  private buildRRule(): string {
    const config: RRuleConfig = {
      frequency: this.frequency(),
      interval: this.interval()
    };

    if (this.frequency() === 'WEEKLY' && this.selectedDays().length > 0) {
      // Sort days in standard order (SU, MO, TU, WE, TH, FR, SA)
      const order: RRuleDayOfWeek[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
      config.byDay = [...this.selectedDays()].sort(
        (a, b) => order.indexOf(a) - order.indexOf(b)
      );
    }

    if (this.frequency() === 'MONTHLY') {
      if (this.monthlyType() === 'weekdayPosition') {
        // BYSETPOS pattern: "Nth weekday of month" (e.g., 2nd Tuesday)
        config.byDay = [this.weekDay()];
        config.bySetPos = [this.weekPosition()];
      } else {
        // BYMONTHDAY pattern: "on day X of month"
        config.byMonthDay = [this.monthDay()];
      }
    }

    if (this.endType() === 'count') {
      config.count = this.count();
    } else if (this.endType() === 'until' && this.until()) {
      config.until = this.until();
    }

    return this.recurringService.buildRRuleString(config);
  }

  private setDefaults(): void {
    this.frequency.set('WEEKLY');
    this.interval.set(1);
    this.selectedDays.set([]);
    this.monthDay.set(1);
    this.monthlyType.set('dayOfMonth');
    this.weekPosition.set(1);
    this.weekDay.set('MO');
    this.endType.set('never');
    this.count.set(10);
    this.until.set('');
  }
}
