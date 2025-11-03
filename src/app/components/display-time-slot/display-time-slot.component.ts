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

import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-display-time-slot',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="time-slot-display">{{ formattedValue() }}</span>
  `,
  styles: [`
    .time-slot-display {
      @apply text-base-content;
    }
  `]
})
export class DisplayTimeSlotComponent {
  datum = input<string>(); // tstzrange string from database

  formattedValue = computed(() => {
    const raw = this.datum();
    if (!raw) return '';

    const { start, end } = this.parseRange(raw);
    if (!start || !end) return raw; // Fallback to raw if parse fails

    return this.formatRange(start, end);
  });

  private parseRange(tstzrange: string): { start: Date | null, end: Date | null } {
    // Parse: ["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")
    // Note: PostgreSQL returns tstzrange with escaped quotes in JSON
    const match = tstzrange.match(/\["?([^",]+)"?,\s*"?([^")]+)"?\)/);
    if (!match) return { start: null, end: null };

    return {
      start: new Date(match[1]),
      end: new Date(match[2])
    };
  }

  private formatRange(start: Date, end: Date): string {
    const sameDay = start.toDateString() === end.toDateString();

    const dateFormat: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    };
    const timeFormat: Intl.DateTimeFormatOptions = {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    };

    if (sameDay) {
      // "Mar 15, 2025 2:00 PM - 4:00 PM"
      const dateStr = start.toLocaleDateString('en-US', dateFormat);
      const startTime = start.toLocaleTimeString('en-US', timeFormat);
      const endTime = end.toLocaleTimeString('en-US', timeFormat);
      return `${dateStr} ${startTime} - ${endTime}`;
    } else {
      // "Mar 15, 2025 2:00 PM - Mar 17, 2025 11:00 AM"
      const startFull = start.toLocaleString('en-US', { ...dateFormat, ...timeFormat });
      const endFull = end.toLocaleString('en-US', { ...dateFormat, ...timeFormat });
      return `${startFull} - ${endFull}`;
    }
  }
}
