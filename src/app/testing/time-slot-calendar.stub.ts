/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Test double for TimeSlotCalendarComponent, for specs of components that host
 * it (CalendarWidgetComponent). The real component renders a full FullCalendar
 * view (a Preact tree) on every change detection, which costs a few hundred ms
 * of CPU per test under happy-dom and pushed those tests past Vitest's 5 s
 * timeout when the machine was starved of CPU, although nothing in them waits
 * on time. FullCalendar itself is covered by time-slot-calendar.component.spec.ts.
 *
 *   TestBed.overrideComponent(CalendarWidgetComponent, {
 *     remove: { imports: [TimeSlotCalendarComponent] },
 *     add: { imports: [TimeSlotCalendarStubComponent] },
 *   });
 *
 * Same selector, inputs and outputs as the real component, so templates bind
 * unchanged; it renders nothing and never emits on its own (specs call the
 * host's handlers, e.g. onDateRangeChange, directly).
 */
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CalendarEvent } from '../components/time-slot-calendar/time-slot-calendar.component';

@Component({
  selector: 'app-time-slot-calendar',
  template: '<div class="time-slot-calendar-stub"></div>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimeSlotCalendarStubComponent {
  mode = input<'display' | 'edit' | 'list'>('display');
  value = input<string>();
  events = input<CalendarEvent[]>([]);
  defaultColor = input<string>('#3B82F6');
  loading = input<boolean>(false);
  initialView = input<string>('timeGridWeek');
  initialDate = input<string | undefined>(undefined);
  dayMaxEvents = input<number | boolean>(2);
  eventDisplay = input<'auto' | 'block' | 'list-item' | 'background'>('block');
  moreLinkClick = input<'popover' | 'day' | 'week'>('day');

  valueChange = output<string>();
  eventClick = output<CalendarEvent>();
  dateSelect = output<{ start: Date; end: Date }>();
  dateRangeChange = output<{ start: Date; end: Date }>();
}
