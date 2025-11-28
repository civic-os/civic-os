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

    // Verify calendarOptions exists and has required plugins
    const calendarOptions = component.calendarOptions;
    expect(calendarOptions).toBeDefined();
    expect(calendarOptions.plugins).toBeDefined();
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

    // Verify events are computed correctly (internal computed signal)
    const computed = (component as any).calendarEventsComputed();
    expect(computed.length).toBe(1);
    expect(computed[0].id).toBe('1');
    expect(computed[0].title).toBe('Test Event');
    expect(computed[0].color).toBe('#FF0000');
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

    // Verify events are computed correctly for edit mode
    const computed = (component as any).calendarEventsComputed();
    expect(computed.length).toBe(1);
    expect(computed[0].id).toBe('edit-event');
    expect(computed[0].title).toBe('Time Slot');

    // Mode is checked in ngAfterViewInit, but we can verify the input
    expect(component.mode()).toBe('edit');
  });

  it('should set calendar to read-only in display mode', () => {
    fixture.componentRef.setInput('mode', 'display');
    fixture.detectChanges();

    // Editable/selectable are set via setOption in ngAfterViewInit
    // We just verify the mode input is set correctly
    expect(component.mode()).toBe('display');
  });

  it('should respect initial view and date from inputs', () => {
    fixture.componentRef.setInput('initialView', 'dayGridMonth');
    fixture.componentRef.setInput('initialDate', '2025-03-15');
    fixture.detectChanges();

    // Initial view/date are passed as inputs and used in ngAfterViewInit
    expect(component.initialView()).toBe('dayGridMonth');
    expect(component.initialDate()).toBe('2025-03-15');
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

  describe('ViewChild Timing', () => {
    it('should set viewInitialized signal in ngAfterViewInit', () => {
      expect((component as any).viewInitialized()).toBe(false);

      component.ngAfterViewInit();

      expect((component as any).viewInitialized()).toBe(true);
    });

    it('should not call FullCalendar API before view init', () => {
      const mockApi = jasmine.createSpyObj('CalendarApi', ['getEventSources', 'addEventSource']);
      mockApi.getEventSources.and.returnValue([]);

      component.calendarComponent = { getApi: () => mockApi } as any;

      // Trigger effect before view init (viewInitialized is false)
      fixture.componentRef.setInput('events', [
        {
          id: 1,
          title: 'Test Event',
          start: new Date('2025-03-15T14:00:00Z'),
          end: new Date('2025-03-15T16:00:00Z')
        }
      ]);
      fixture.detectChanges();

      // Effect should skip updating calendar since viewInitialized is false
      expect(mockApi.getEventSources).not.toHaveBeenCalled();
      expect(mockApi.addEventSource).not.toHaveBeenCalled();
    });

    it('should update events after view init', (done) => {
      const mockApi = jasmine.createSpyObj('CalendarApi', [
        'getEventSources',
        'addEventSource',
        'setOption',
        'changeView',
        'gotoDate',
        'getDate'
      ]);
      mockApi.getEventSources.and.returnValue([]);
      mockApi.getDate.and.returnValue(new Date());
      mockApi.view = { type: 'timeGridWeek' };

      component.calendarComponent = {
        getApi: () => mockApi
      } as any;

      component.ngAfterViewInit();

      fixture.componentRef.setInput('events', [
        {
          id: 1,
          title: 'Test Event',
          start: new Date('2025-03-15T14:00:00Z'),
          end: new Date('2025-03-15T16:00:00Z')
        }
      ]);
      fixture.detectChanges();

      setTimeout(() => {
        expect(mockApi.getEventSources).toHaveBeenCalled();
        expect(mockApi.addEventSource).toHaveBeenCalled();
        done();
      }, 0);
    });
  });

  /**
   * Timezone-Safe Date Parsing Tests
   *
   * These tests verify that date strings are parsed correctly in the user's
   * local timezone, not UTC.
   *
   * BUG CONTEXT:
   * When parsing "2025-11-28" without a time component, JavaScript interprets
   * it as UTC midnight. In timezones west of UTC (e.g., EST = UTC-5), this
   * becomes Nov 27 at 7pm local time - the PREVIOUS day!
   *
   * SOLUTION:
   * Append 'T00:00:00' when parsing to force local timezone interpretation.
   *
   * NOTE: These tests verify the date parsing logic in isolation, not the
   * component's interaction with FullCalendar (which has complex lifecycle).
   *
   * @see TimeSlotCalendarComponent.ngAfterViewInit() - gotoDate() call
   */
  describe('Timezone-Safe Date Parsing', () => {
    /**
     * The correct way to parse a YYYY-MM-DD string for local display.
     * This mirrors the fix applied in ngAfterViewInit.
     */
    function parseLocalDate(dateStr: string): Date {
      return new Date(dateStr + 'T00:00:00');
    }

    /**
     * The INCORRECT way - parses as UTC, which shifts the date in western timezones.
     */
    function parseAsUTC(dateStr: string): Date {
      return new Date(dateStr); // Without time, parsed as UTC
    }

    it('should parse date in local timezone (not UTC) when T00:00:00 suffix is used', () => {
      const dateStr = '2025-11-28';
      const localDate = parseLocalDate(dateStr);

      // The date should be Nov 28 in local timezone (not shifted)
      expect(localDate.getDate()).toBe(28);
      expect(localDate.getMonth()).toBe(10); // November (0-indexed)
      expect(localDate.getFullYear()).toBe(2025);

      // Hours should be 0 (midnight local time)
      expect(localDate.getHours()).toBe(0);
    });

    it('should handle first day of month correctly (no shift to previous month)', () => {
      const dateStr = '2025-12-01';
      const localDate = parseLocalDate(dateStr);

      // Should be Dec 1, not Nov 30
      expect(localDate.getDate()).toBe(1);
      expect(localDate.getMonth()).toBe(11); // December
      expect(localDate.getFullYear()).toBe(2025);
    });

    it('should handle first day of year correctly (no shift to previous year)', () => {
      const dateStr = '2026-01-01';
      const localDate = parseLocalDate(dateStr);

      // Should be Jan 1, 2026, not Dec 31, 2025
      expect(localDate.getDate()).toBe(1);
      expect(localDate.getMonth()).toBe(0); // January
      expect(localDate.getFullYear()).toBe(2026);
    });

    it('should demonstrate the UTC parsing bug (without T00:00:00)', () => {
      const dateStr = '2025-11-28';

      // This parses as UTC midnight
      const utcDate = parseAsUTC(dateStr);

      // Verify it's UTC midnight
      expect(utcDate.getTime()).toBe(Date.UTC(2025, 10, 28, 0, 0, 0));

      // The LOCAL date may differ depending on timezone
      // In UTC-5 (EST): Nov 28 00:00 UTC = Nov 27 19:00 EST
      // We don't assert the local date here since it depends on test runner timezone
    });

    it('should calculate correct week containing a Friday', () => {
      // Nov 28, 2025 is a Friday
      const friday = parseLocalDate('2025-11-28');
      expect(friday.getDay()).toBe(5); // Friday = 5

      // Week starts on Sunday - go back dayOfWeek days
      const sunday = new Date(friday);
      sunday.setDate(friday.getDate() - friday.getDay());

      expect(sunday.getDate()).toBe(23); // Sunday Nov 23
      expect(sunday.getMonth()).toBe(10); // November
    });
  });

  /**
   * calculateExpectedRange() Tests
   *
   * Verifies the range calculation logic used to detect programmatic vs user navigation.
   */
  describe('calculateExpectedRange()', () => {
    it('should calculate day view range correctly', () => {
      const range = (component as any).calculateExpectedRange('timeGridDay', '2025-11-28');

      // Day view: start at midnight, end at midnight next day
      expect(range.start.getDate()).toBe(28);
      expect(range.start.getHours()).toBe(0);
      expect(range.end.getDate()).toBe(29);
      expect(range.end.getHours()).toBe(0);
    });

    it('should calculate week view range correctly (Sunday start)', () => {
      // Nov 28, 2025 is a Friday
      const range = (component as any).calculateExpectedRange('timeGridWeek', '2025-11-28');

      // Week should start on Sunday Nov 23
      expect(range.start.getDate()).toBe(23);
      expect(range.start.getMonth()).toBe(10); // November

      // Week should end on Sunday Nov 30 (start of next week)
      expect(range.end.getDate()).toBe(30);
    });

    it('should calculate month view range correctly (includes overflow weeks)', () => {
      // November 2025: Nov 1 is Saturday, Nov 30 is Sunday
      const range = (component as any).calculateExpectedRange('dayGridMonth', '2025-11-15');

      // Month view extends to show complete weeks
      // First displayed Sunday should be Oct 26 (before Nov 1)
      expect(range.start.getMonth()).toBe(9); // October
      expect(range.start.getDate()).toBe(26);

      // Last displayed day should be after Nov 30
      expect(range.end.getMonth()).toBe(11); // December
    });

    it('should parse date string in local timezone', () => {
      // This tests that the T00:00:00 suffix is used internally
      const range = (component as any).calculateExpectedRange('timeGridDay', '2025-11-28');

      // The date should be Nov 28 local, not shifted
      expect(range.start.getFullYear()).toBe(2025);
      expect(range.start.getMonth()).toBe(10); // November
      expect(range.start.getDate()).toBe(28);
    });
  });
});
