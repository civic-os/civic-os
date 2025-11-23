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

import { Component, forwardRef, signal, effect, ChangeDetectionStrategy } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR, FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-edit-time-slot',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => EditTimeSlotComponent),
      multi: true
    }
  ],
  template: `
    <div class="time-slot-editor grid grid-cols-1 gap-4">
      <div class="form-control">
        <label class="label">
          <span class="label-text">Start</span>
        </label>
        <input
          type="datetime-local"
          class="input input-bordered w-full"
          [value]="startLocal()"
          (input)="onStartChange($event)"
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
          [value]="endLocal()"
          (input)="onEndChange($event)"
          [disabled]="disabled()"
        />
      </div>

      @if (errorMessage()) {
        <div class="col-span-1">
          <p class="text-error text-sm">{{ errorMessage() }}</p>
        </div>
      }
    </div>
  `
})
export class EditTimeSlotComponent implements ControlValueAccessor {
  startLocal = signal<string>('');
  endLocal = signal<string>('');
  disabled = signal(false);
  errorMessage = signal<string>('');

  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};

  // Emit combined value when either input changes
  constructor() {
    effect(() => {
      const start = this.startLocal();
      const end = this.endLocal();

      if (!start || !end) {
        this.errorMessage.set('');
        return;
      }

      const startDate = new Date(start);
      const endDate = new Date(end);

      if (endDate <= startDate) {
        this.errorMessage.set('End time must be after start time');
        return;
      }

      this.errorMessage.set('');
      const tstzrange = this.buildTstzrange(startDate, endDate);
      this.onChange(tstzrange);
    });
  }

  writeValue(value: string): void {
    if (!value) {
      this.startLocal.set('');
      this.endLocal.set('');
      return;
    }

    const { start, end } = this.parseRange(value);
    if (start && end) {
      this.startLocal.set(this.toDatetimeLocal(start));
      this.endLocal.set(this.toDatetimeLocal(end));
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

  onStartChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.startLocal.set(input.value);

    // Auto-populate end date if empty
    // UX improvement: When user selects start date, pre-fill end with same date
    // This saves clicks for same-day reservations (most common case)
    if (input.value && !this.endLocal()) {
      this.endLocal.set(input.value);
    }

    this.onTouched();
  }

  onEndChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.endLocal.set(input.value);
    this.onTouched();
  }

  private parseRange(tstzrange: string): { start: Date | null, end: Date | null } {
    // Parse: [\"2025-03-15 14:00:00+00\",\"2025-03-15 16:00:00+00\")
    // Note: PostgreSQL returns tstzrange with escaped quotes in JSON
    const match = tstzrange.match(/\[\"?([^\",]+)\"?,\s*\"?([^\")]+)\"?\)/);
    if (!match) return { start: null, end: null };

    // Normalize PostgreSQL timestamp format to ISO 8601 for JavaScript Date parsing
    // Replace space with 'T' and '+00' with 'Z' (or '+00:00')
    const normalizeTimestamp = (ts: string): string => {
      return ts.replace(' ', 'T').replace(/\+00$/, 'Z');
    };

    return {
      start: new Date(normalizeTimestamp(match[1])),
      end: new Date(normalizeTimestamp(match[2]))
    };
  }

  private toDatetimeLocal(date: Date): string {
    // Convert UTC date to local datetime-local format: "YYYY-MM-DDTHH:MM"
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  private buildTstzrange(start: Date, end: Date): string {
    // PostgreSQL tstzrange format: "[2025-03-15T14:00:00.000Z,2025-03-15T16:00:00.000Z)"
    return `[${start.toISOString()},${end.toISOString()})`;
  }
}
