/**
 * Copyright (C) 2023-2026 Civic OS, L3C
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
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { EditRecurringTimeSlotComponent, RecurringTimeSlotValue } from './edit-recurring-time-slot.component';
import { RecurringService } from '../../services/recurring.service';
import { of } from 'rxjs';

describe('EditRecurringTimeSlotComponent', () => {
  let component: EditRecurringTimeSlotComponent;
  let fixture: ComponentFixture<EditRecurringTimeSlotComponent>;
  let mockRecurringService: jasmine.SpyObj<RecurringService>;

  beforeEach(async () => {
    mockRecurringService = jasmine.createSpyObj('RecurringService', [
      'previewConflicts',
      'describeRRule',
      'buildRRuleString',
      'parseRRuleString'
    ]);
    mockRecurringService.previewConflicts.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [EditRecurringTimeSlotComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: RecurringService, useValue: mockRecurringService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(EditRecurringTimeSlotComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('generateOccurrencesForPreview', () => {
    it('should generate WEEKLY+BYDAY occurrences on correct days', () => {
      // Tuesday, April 28, 2026 at 10:00 AM
      component.startDateTime.set('2026-04-28T10:00');
      component.endDateTime.set('2026-04-28T11:00');
      component.rrule.set('FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4');

      const occurrences = component.generateOccurrencesForPreview();

      expect(occurrences.length).toBe(4);
      // All occurrences should be on Tuesday (2) or Thursday (4)
      occurrences.forEach(([start]) => {
        const day = new Date(start).getUTCDay();
        expect([2, 4]).toContain(day);
      });
    });

    it('should generate MONTHLY+BYSETPOS occurrences correctly', () => {
      // First Tuesday of month
      component.startDateTime.set('2026-04-07T09:00');
      component.endDateTime.set('2026-04-07T10:00');
      component.rrule.set('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1;COUNT=3');

      const occurrences = component.generateOccurrencesForPreview();

      expect(occurrences.length).toBe(3);
      // All occurrences should be on Tuesday
      occurrences.forEach(([start]) => {
        const day = new Date(start).getUTCDay();
        expect(day).toBe(2);
      });
    });

    it('should return empty array when start/end are missing', () => {
      component.startDateTime.set('');
      component.endDateTime.set('');
      component.rrule.set('FREQ=WEEKLY;COUNT=5');

      expect(component.generateOccurrencesForPreview()).toEqual([]);
    });

    it('should return empty array when rrule is empty', () => {
      component.startDateTime.set('2026-04-28T10:00');
      component.endDateTime.set('2026-04-28T11:00');
      component.rrule.set('');

      expect(component.generateOccurrencesForPreview()).toEqual([]);
    });

    it('should calculate correct duration for each occurrence', () => {
      // 2-hour events
      component.startDateTime.set('2026-04-28T10:00');
      component.endDateTime.set('2026-04-28T12:00');
      component.rrule.set('FREQ=DAILY;COUNT=2');

      const occurrences = component.generateOccurrencesForPreview();

      expect(occurrences.length).toBe(2);
      occurrences.forEach(([start, end]) => {
        const diffMs = new Date(end).getTime() - new Date(start).getTime();
        expect(diffMs).toBe(2 * 60 * 60 * 1000); // 2 hours in ms
      });
    });
  });

  describe('writeValue', () => {
    it('should populate form from RecurringTimeSlotValue object', () => {
      const value: RecurringTimeSlotValue = {
        time_slot: '[2026-04-28 10:00:00+00,2026-04-28 12:00:00+00)',
        is_recurring: true,
        rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=10',
        series_name: 'Weekly Meeting',
        series_description: 'Team standup',
        series_color: '#FF5733'
      };

      component.writeValue(value);

      expect(component.isRecurring()).toBe(true);
      expect(component.rrule()).toBe('FREQ=WEEKLY;BYDAY=TU;COUNT=10');
      expect(component.seriesName()).toBe('Weekly Meeting');
      expect(component.seriesDescription()).toBe('Team standup');
      expect(component.seriesColor()).toBe('#FF5733');
      expect(component.startDateTime()).toBeTruthy();
      expect(component.endDateTime()).toBeTruthy();
    });

    it('should handle plain string time_slot', () => {
      component.writeValue('[2026-04-28 10:00:00+00,2026-04-28 12:00:00+00)');

      expect(component.isRecurring()).toBe(false);
      expect(component.startDateTime()).toBeTruthy();
      expect(component.endDateTime()).toBeTruthy();
    });

    it('should reset form when value is null', () => {
      component.isRecurring.set(true);
      component.rrule.set('FREQ=DAILY');
      component.seriesName.set('Test');

      component.writeValue(null as any);

      expect(component.startDateTime()).toBe('');
      expect(component.endDateTime()).toBe('');
      expect(component.isRecurring()).toBe(false);
      expect(component.rrule()).toBe('');
      expect(component.seriesName()).toBe('');
    });
  });

  describe('onRecurringToggle', () => {
    it('should clear rrule when toggling off', () => {
      component.isRecurring.set(true);
      component.rrule.set('FREQ=WEEKLY;COUNT=10');

      component.onRecurringToggle(false);

      expect(component.isRecurring()).toBe(false);
      expect(component.rrule()).toBe('');
    });

    it('should set recurring flag when toggling on', () => {
      component.rrule.set('');
      component.onRecurringToggle(true);

      expect(component.isRecurring()).toBe(true);
    });
  });

  describe('validate', () => {
    it('should return null when form is valid (not recurring)', () => {
      component.startDateTime.set('2026-04-28T10:00');
      component.endDateTime.set('2026-04-28T12:00');
      component.isRecurring.set(false);

      expect(component.validate({} as any)).toBeNull();
    });

    it('should return error when end before start', () => {
      component.startDateTime.set('2026-04-28T12:00');
      component.endDateTime.set('2026-04-28T10:00');

      const errors = component.validate({} as any);
      expect(errors).toBeTruthy();
      expect(errors!['invalidTimeSlot']).toBeTruthy();
    });

    it('should return error when recurring but no rrule', () => {
      component.startDateTime.set('2026-04-28T10:00');
      component.endDateTime.set('2026-04-28T12:00');
      component.isRecurring.set(true);
      component.rrule.set('');
      component.seriesName.set('Test');

      const errors = component.validate({} as any);
      expect(errors).toBeTruthy();
      expect(errors!['missingRRule']).toBeTruthy();
    });

    it('should return error when recurring but no series name', () => {
      component.startDateTime.set('2026-04-28T10:00');
      component.endDateTime.set('2026-04-28T12:00');
      component.isRecurring.set(true);
      component.rrule.set('FREQ=WEEKLY;COUNT=10');
      component.seriesName.set('');

      const errors = component.validate({} as any);
      expect(errors).toBeTruthy();
      expect(errors!['missingSeriesName']).toBeTruthy();
    });
  });
});
