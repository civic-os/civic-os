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
  input,
  output,
  signal,
  computed,
  effect,
  inject,
  ChangeDetectionStrategy,
  ViewChild,
  AfterViewInit,
  untracked
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FullCalendarComponent, FullCalendarModule } from '@fullcalendar/angular';
import { CalendarOptions, EventClickArg, DateSelectArg, EventInput, DatesSetArg } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { ThemeService } from '../../services/theme.service';

export interface CalendarEvent {
  id: string | number;
  title: string;
  start: Date;
  end: Date;
  color?: string;
  extendedProps?: any;
}

/**
 * TimeSlotCalendarComponent - Calendar view for time_slot property type
 *
 * Three modes:
 * - display: Read-only calendar, click events for navigation
 * - edit: Interactive (drag, resize) for single event editing
 * - list: Multi-event timeline with date range filters (List page)
 *
 * Features:
 * - FullCalendar integration with day/week/month views
 * - Theme-aware color scheme (light/dark mode)
 * - Event click navigation
 * - Date selection for creating new events
 * - Drag and resize support in edit mode
 *
 * KNOWN ISSUE: Events may display with a ~1 hour vertical offset in timeGrid views.
 * Root cause is unclear - we pass correct ISO strings to FullCalendar, but rendering
 * positions events incorrectly. Event times are correct in detail views and database.
 * TODO: Consider alternative calendar library (angular-calendar, PrimeNG, or custom solution)
 */
@Component({
  selector: 'app-time-slot-calendar',
  standalone: true,
  imports: [CommonModule, FullCalendarModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './time-slot-calendar.component.html',
  styleUrl: './time-slot-calendar.component.css'
})
export class TimeSlotCalendarComponent implements AfterViewInit {
  @ViewChild('calendar') calendarComponent?: FullCalendarComponent;

  private themeService = inject(ThemeService);

  // Inputs
  mode = input<'display' | 'edit' | 'list'>('display');
  value = input<string>(); // tstzrange for edit mode
  events = input<CalendarEvent[]>([]); // For list/display modes
  defaultColor = input<string>('#3B82F6'); // Default event color
  loading = input<boolean>(false); // Loading state
  initialView = input<string>('timeGridWeek'); // Initial calendar view from URL
  initialDate = input<string | undefined>(undefined); // Initial date from URL (YYYY-MM-DD)

  // Month view configuration (configurable via dashboard widget)
  dayMaxEvents = input<number | boolean>(2); // Events per day before "+more" (default: 2)
  eventDisplay = input<'auto' | 'block' | 'list-item' | 'background'>('block'); // Event style
  moreLinkClick = input<'popover' | 'day' | 'week'>('day'); // "+more" click behavior

  // Outputs
  valueChange = output<string>(); // tstzrange
  eventClick = output<CalendarEvent>();
  dateSelect = output<{ start: Date; end: Date }>();
  dateRangeChange = output<{ start: Date; end: Date }>(); // Emitted when visible range changes

  // State
  isDark = this.themeService.isDark;
  private viewInitialized = signal(false); // Track whether ngAfterViewInit has run

  constructor() {
    // Update FullCalendar when events change (bridge between reactive signals and imperative API)
    // CRITICAL: Only update after view is initialized to avoid ViewChild timing issues
    effect(() => {
      const events = this.calendarEventsComputed();
      const isInitialized = this.viewInitialized();

      // Skip if view hasn't been initialized yet (ViewChild not ready)
      if (!isInitialized) {
        return;
      }

      // Use untracked() to access ViewChild without creating signal dependency
      const calendar = untracked(() => this.calendarComponent?.getApi());

      if (calendar) {
        // Remove all event sources (not just events) to prevent accumulation on navigation
        // Each addEventSource() call creates a NEW source, so we must remove old sources first
        calendar.getEventSources().forEach(source => source.remove());

        // Add fresh event source with new data
        calendar.addEventSource(events);
      }
    });
  }

  // Computed calendar events based on mode
  private calendarEventsComputed = computed(() => {
    const events = this.events();
    const mode = this.mode();
    const value = this.value();

    let calendarEvents: EventInput[] = [];

    try {
      if (mode === 'edit' && value) {
        // Edit mode: single event from value input
        const { start, end } = this.parseTimeSlot(value);
        if (start && end) {
          calendarEvents = [{
            id: 'edit-event',
            title: 'Time Slot',
            start: start.toISOString(),  // UTC ISO string
            end: end.toISOString(),
            color: this.defaultColor()
          }];
        }
      } else {
        // Display/list mode: transform events input
        calendarEvents = this.transformEvents(events);
      }
    } catch (error) {
      console.error('[TimeSlotCalendar] Error building calendar events:', error);
      calendarEvents = [];
    }

    return calendarEvents;
  });

  // Calendar options as static property (stable object reference)
  // CRITICAL: Don't include reactive inputs (view, date, events) - those are updated imperatively via effects
  // This prevents calendar recreation on change detection
  calendarOptions: CalendarOptions = {
    plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay'
    },
    selectMirror: true,
    weekends: true,
    fixedWeekCount: false, // Show only the weeks needed (4-6), not always 6

    // Month view readability improvements
    displayEventEnd: true, // Show end time in month view (e.g., "4p - 7p")
    eventTimeFormat: {
      hour: 'numeric',
      minute: '2-digit',
      omitZeroMinute: true,
      meridiem: 'narrow' // Compact format: "p" instead of "PM"
    },
    // Note: dayMaxEvents, moreLinkClick, eventDisplay are set imperatively in ngAfterViewInit
    // to support configuration via inputs

    eventClick: (arg: EventClickArg) => this.handleEventClick(arg),
    select: (arg: DateSelectArg) => this.handleDateSelect(arg),
    datesSet: (arg) => this.handleDatesSet(arg),
    height: '600px', // Fixed height to prevent resize loops
    allDaySlot: false,
    slotDuration: '01:00:00', // 1-hour slots (clear visual alignment for display mode)
    slotLabelInterval: '01:00:00', // Show hourly labels
    slotMinTime: '00:00:00', // Start at midnight (ensures accurate positioning calculations)
    slotMaxTime: '24:00:00', // End at midnight next day (full 24-hour range)
    eventMinHeight: 20, // Minimum event height in pixels for visibility
    expandRows: false, // Consistent slot heights (no dynamic stretching)
    scrollTime: '08:00:00', // Start scroll at 8am
    nowIndicator: true, // Show current time indicator
    slotLabelFormat: {
      hour: 'numeric',
      minute: '2-digit',
      omitZeroMinute: false,
      meridiem: 'short'
    }
  };

  ngAfterViewInit() {
    // Calendar is ready - set initial view/date and mode-based options
    const calendar = this.calendarComponent?.getApi();
    if (calendar) {
      // Set mode-based options (edit vs display/list)
      const mode = this.mode();
      calendar.setOption('editable', mode === 'edit');
      calendar.setOption('selectable', mode === 'edit');

      // Set configurable month view options from inputs
      calendar.setOption('dayMaxEvents', this.dayMaxEvents());
      calendar.setOption('eventDisplay', this.eventDisplay());
      calendar.setOption('moreLinkClick', this.moreLinkClick());

      // Set initial view if provided
      const view = this.initialView();
      if (view && calendar.view.type !== view) {
        calendar.changeView(view);
      }

      // Set initial date if provided
      // IMPORTANT: Parse with explicit time to avoid UTC vs local timezone confusion
      // "2025-11-28" alone is interpreted as UTC midnight, which in EST becomes Nov 27 7pm (previous day!)
      const date = this.initialDate();
      if (date) {
        calendar.gotoDate(new Date(date + 'T00:00:00'));
      }

      // Add initial events manually (effect will handle subsequent updates)
      const events = this.calendarEventsComputed();
      if (events.length > 0) {
        calendar.addEventSource(events);
      }
    }

    // Mark view as initialized - effect can now update events reactively
    this.viewInitialized.set(true);
  }

  private transformEvents(events: CalendarEvent[]): EventInput[] {
    return events.map(e => ({
      id: String(e.id),
      title: e.title,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
      color: e.color || this.defaultColor(),
      extendedProps: e.extendedProps
    }));
  }

  private handleEventClick(arg: EventClickArg) {
    const id = arg.event.id;
    const event: CalendarEvent = {
      id: id,
      title: arg.event.title,
      start: arg.event.start!,
      end: arg.event.end!,
      color: arg.event.backgroundColor,
      extendedProps: arg.event.extendedProps
    };

    this.eventClick.emit(event);
  }

  private handleDateSelect(arg: DateSelectArg) {
    const start = arg.start;
    const end = arg.end;

    this.dateSelect.emit({ start, end });

    // In edit mode, update the value
    if (this.mode() === 'edit') {
      const tstzrange = this.buildTstzrange(start, end);
      this.valueChange.emit(tstzrange);
    }
  }

  private handleDatesSet(arg: DatesSetArg) {
    // Called when the visible date range changes (initial load, prev/next, view change)
    // CRITICAL: Check if this was triggered by our own URL update to prevent infinite loop

    const actualStart = new Date(arg.start);
    const actualEnd = new Date(arg.end);

    // Detect programmatic navigation (from URL update) vs user navigation
    const expectedDate = this.initialDate();
    const expectedView = this.initialView();

    if (expectedDate && expectedView && this.mode() === 'list') {
      // Calculate what the range SHOULD be based on URL params
      const expectedRange = this.calculateExpectedRange(expectedView, expectedDate);

      // Compare with tolerance for timezone quirks (1 second)
      const startMatches = Math.abs(expectedRange.start.getTime() - actualStart.getTime()) < 1000;
      const endMatches = Math.abs(expectedRange.end.getTime() - actualEnd.getTime()) < 1000;

      if (startMatches && endMatches) {
        return; // Don't emit, this was our own URL update
      }
    }

    // Only emit for list mode (not edit/display modes) and user-initiated navigation
    if (this.mode() === 'list') {
      this.dateRangeChange.emit({ start: actualStart, end: actualEnd });
    }
  }

  private parseTimeSlot(tstzrange: string): { start: Date | null; end: Date | null } {
    // Parse: ["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")
    // Note: PostgreSQL returns tstzrange with escaped quotes in JSON
    const match = tstzrange.match(/\["?([^",]+)"?,\s*"?([^")]+)"?\)/);
    if (!match) return { start: null, end: null };
    return {
      start: new Date(match[1]),
      end: new Date(match[2])
    };
  }

  private buildTstzrange(start: Date, end: Date): string {
    return `[${start.toISOString()},${end.toISOString()})`;
  }

  /**
   * Calculate expected date range from calendar view and focus date
   * Used to detect programmatic navigation vs user navigation
   */
  private calculateExpectedRange(view: string, dateStr: string): { start: Date; end: Date } {
    const date = new Date(dateStr + 'T00:00:00'); // Parse in local timezone

    if (view === 'timeGridDay') {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(24, 0, 0, 0);
      return { start, end };
    } else if (view === 'timeGridWeek') {
      // FullCalendar's week starts on Sunday by default
      const start = new Date(date);
      const dayOfWeek = start.getDay();
      start.setDate(start.getDate() - dayOfWeek); // Go to Sunday
      start.setHours(0, 0, 0, 0);

      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      return { start, end };
    } else if (view === 'dayGridMonth') {
      // For month view, extend to surrounding weeks to show complete weeks
      const start = new Date(date.getFullYear(), date.getMonth(), 1);
      start.setDate(start.getDate() - start.getDay()); // Go back to Sunday
      start.setHours(0, 0, 0, 0);

      const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      const end = new Date(lastDayOfMonth);
      end.setDate(end.getDate() + (6 - end.getDay()) + 1); // Go forward to Saturday + 1

      return { start, end };
    }

    // Fallback
    return { start: date, end: date };
  }
}
