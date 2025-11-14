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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TimeSlotCalendarComponent, CalendarEvent } from './time-slot-calendar.component';
import { FullCalendarComponent } from '@fullcalendar/angular';
import { ThemeService } from '../../services/theme.service';

describe('TimeSlotCalendarComponent', () => {
  let component: TimeSlotCalendarComponent;
  let fixture: ComponentFixture<TimeSlotCalendarComponent>;
  let mockThemeService: jasmine.SpyObj<ThemeService>;

  beforeEach(async () => {
    mockThemeService = jasmine.createSpyObj('ThemeService', ['toggleTheme', 'getMapTileConfig'], {
      isDark: signal(false)
    });

    await TestBed.configureTestingModule({
      imports: [TimeSlotCalendarComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ThemeService, useValue: mockThemeService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(TimeSlotCalendarComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    // Clean up component - suppress FullCalendar DOM errors in test environment
    // FullCalendar expects real DOM nodes, which don't exist in tests
    try {
      fixture.destroy();
    } catch (e) {
      // Suppress FullCalendar cleanup errors (NotFoundError: removeChild on non-existent node)
      // These errors are expected in test environment where FullCalendar doesn't have real DOM
    }
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should initialize with empty events in list mode', () => {
    fixture.componentRef.setInput('mode', 'list');
    fixture.componentRef.setInput('events', []);
    fixture.detectChanges();

    const calendarOptions = component.calendarOptions();
    expect(calendarOptions.events).toEqual([]);
  });

  it('should transform events correctly', () => {
    const mockEvents: CalendarEvent[] = [
      {
        id: 1,
        title: 'Test Event',
        start: new Date('2025-03-15T14:00:00Z'),
        end: new Date('2025-03-15T16:00:00Z'),
        color: '#FF0000'
      }
    ];

    fixture.componentRef.setInput('mode', 'list');
    fixture.componentRef.setInput('events', mockEvents);
    fixture.detectChanges();

    const calendarOptions = component.calendarOptions();
    const events = calendarOptions.events as any[];

    expect(events.length).toBe(1);
    expect(events[0].id).toBe('1');
    expect(events[0].title).toBe('Test Event');
    expect(events[0].color).toBe('#FF0000');
  });

  it('should update FullCalendar when events change', (done) => {
    // Mock event source with remove method
    const mockEventSource = {
      remove: jasmine.createSpy('remove')
    };

    // Mock FullCalendar API
    const mockCalendarApi = {
      getEventSources: jasmine.createSpy('getEventSources').and.returnValue([mockEventSource]),
      addEventSource: jasmine.createSpy('addEventSource'),
      render: jasmine.createSpy('render')
    };

    // Initial events
    const initialEvents: CalendarEvent[] = [
      {
        id: 1,
        title: 'Initial Event',
        start: new Date('2025-03-15T14:00:00Z'),
        end: new Date('2025-03-15T16:00:00Z')
      }
    ];

    fixture.componentRef.setInput('mode', 'list');
    fixture.componentRef.setInput('events', initialEvents);
    fixture.detectChanges();

    // Simulate ViewChild being set after view init
    component.calendarComponent = {
      getApi: () => mockCalendarApi
    } as any;

    // Change events (this triggers the effect)
    const newEvents: CalendarEvent[] = [
      {
        id: 2,
        title: 'New Event',
        start: new Date('2025-03-16T10:00:00Z'),
        end: new Date('2025-03-16T12:00:00Z')
      }
    ];

    fixture.componentRef.setInput('events', newEvents);
    fixture.detectChanges();

    // Give effect time to run (effects are microtasks)
    setTimeout(() => {
      expect(mockCalendarApi.getEventSources).toHaveBeenCalled();
      expect(mockEventSource.remove).toHaveBeenCalled();
      expect(mockCalendarApi.addEventSource).toHaveBeenCalled();
      done();
    }, 0);
  });

  it('should handle edit mode with time slot value', () => {
    const timeSlotValue = '["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")';

    fixture.componentRef.setInput('mode', 'edit');
    fixture.componentRef.setInput('value', timeSlotValue);
    fixture.detectChanges();

    const calendarOptions = component.calendarOptions();
    const events = calendarOptions.events as any[];

    expect(events.length).toBe(1);
    expect(events[0].id).toBe('edit-event');
    expect(events[0].title).toBe('Time Slot');
    expect(calendarOptions.editable).toBe(true);
    expect(calendarOptions.selectable).toBe(true);
  });

  it('should set calendar to read-only in display mode', () => {
    fixture.componentRef.setInput('mode', 'display');
    fixture.detectChanges();

    const calendarOptions = component.calendarOptions();
    expect(calendarOptions.editable).toBe(false);
    expect(calendarOptions.selectable).toBe(false);
  });

  it('should respect initial view and date from inputs', () => {
    fixture.componentRef.setInput('initialView', 'dayGridMonth');
    fixture.componentRef.setInput('initialDate', '2025-03-15');
    fixture.detectChanges();

    const calendarOptions = component.calendarOptions();
    expect(calendarOptions.initialView).toBe('dayGridMonth');
    expect(calendarOptions.initialDate).toBe('2025-03-15');
  });

  it('should emit eventClick when calendar event is clicked', () => {
    spyOn(component.eventClick, 'emit');

    const mockEvent = {
      id: '1',
      title: 'Test Event',
      start: new Date('2025-03-15T14:00:00Z'),
      end: new Date('2025-03-15T16:00:00Z'),
      backgroundColor: '#FF0000',
      extendedProps: { customData: 'test' }
    };

    const mockArg = {
      event: mockEvent,
      el: document.createElement('div'),
      jsEvent: new MouseEvent('click'),
      view: {} as any
    };

    // Access private method for testing
    (component as any).handleEventClick(mockArg);

    expect(component.eventClick.emit).toHaveBeenCalledWith({
      id: '1',
      title: 'Test Event',
      start: mockEvent.start,
      end: mockEvent.end,
      color: '#FF0000',
      extendedProps: { customData: 'test' }
    });
  });

  it('should emit dateSelect and valueChange in edit mode', () => {
    fixture.componentRef.setInput('mode', 'edit');
    fixture.detectChanges();

    spyOn(component.dateSelect, 'emit');
    spyOn(component.valueChange, 'emit');

    const start = new Date('2025-03-15T14:00:00Z');
    const end = new Date('2025-03-15T16:00:00Z');

    const mockArg = {
      start,
      end,
      allDay: false,
      jsEvent: new MouseEvent('click'),
      view: {} as any
    };

    (component as any).handleDateSelect(mockArg);

    expect(component.dateSelect.emit).toHaveBeenCalledWith({ start, end });
    expect(component.valueChange.emit).toHaveBeenCalledWith(
      jasmine.stringMatching(/\[2025-03-15T14:00:00.*,2025-03-15T16:00:00.*\)/)
    );
  });
});
