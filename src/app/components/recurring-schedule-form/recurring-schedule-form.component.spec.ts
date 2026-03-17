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
import { RecurringScheduleFormComponent, RecurringScheduleValue } from './recurring-schedule-form.component';
import { RecurringService } from '../../services/recurring.service';

describe('RecurringScheduleFormComponent', () => {
  let component: RecurringScheduleFormComponent;
  let fixture: ComponentFixture<RecurringScheduleFormComponent>;
  let mockRecurringService: jasmine.SpyObj<RecurringService>;

  beforeEach(async () => {
    mockRecurringService = jasmine.createSpyObj('RecurringService', [
      'buildRRuleString',
      'parseRRuleString',
      'describeRRule'
    ]);
    mockRecurringService.describeRRule.and.returnValue('Weekly');

    await TestBed.configureTestingModule({
      imports: [RecurringScheduleFormComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: RecurringService, useValue: mockRecurringService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(RecurringScheduleFormComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('durationDisplay', () => {
    it('should show hours and minutes', () => {
      component.dtstartInternal.set('2026-04-28T10:00');
      component.dtendInternal.set('2026-04-28T12:30');

      expect(component.durationDisplay()).toBe('2 hr 30 min');
    });

    it('should show hours only when no minutes', () => {
      component.dtstartInternal.set('2026-04-28T10:00');
      component.dtendInternal.set('2026-04-28T12:00');

      expect(component.durationDisplay()).toBe('2 hr');
    });

    it('should show minutes only when less than 1 hour', () => {
      component.dtstartInternal.set('2026-04-28T10:00');
      component.dtendInternal.set('2026-04-28T10:45');

      expect(component.durationDisplay()).toBe('45 min');
    });

    it('should return empty string when start or end is missing', () => {
      component.dtstartInternal.set('');
      component.dtendInternal.set('');

      expect(component.durationDisplay()).toBe('');
    });

    it('should return empty string when end is before start', () => {
      component.dtstartInternal.set('2026-04-28T12:00');
      component.dtendInternal.set('2026-04-28T10:00');

      expect(component.durationDisplay()).toBe('');
    });
  });

  describe('onStartChange', () => {
    it('should auto-advance end time when end is empty', () => {
      component.dtendInternal.set('');

      component.onStartChange('2026-04-28T10:00');

      expect(component.dtstartInternal()).toBe('2026-04-28T10:00');
      expect(component.dtendInternal()).toBe('2026-04-28T11:00');
    });

    it('should auto-advance end time when end is before new start', () => {
      component.dtendInternal.set('2026-04-28T09:00');

      component.onStartChange('2026-04-28T10:00');

      expect(component.dtstartInternal()).toBe('2026-04-28T10:00');
      expect(component.dtendInternal()).toBe('2026-04-28T11:00');
    });

    it('should preserve end time when end is after start', () => {
      component.dtendInternal.set('2026-04-28T15:00');

      component.onStartChange('2026-04-28T10:00');

      expect(component.dtstartInternal()).toBe('2026-04-28T10:00');
      expect(component.dtendInternal()).toBe('2026-04-28T15:00');
    });
  });

  describe('timeRangeError', () => {
    it('should return null for valid range', () => {
      component.dtstartInternal.set('2026-04-28T10:00');
      component.dtendInternal.set('2026-04-28T12:00');

      expect(component.timeRangeError()).toBeNull();
    });

    it('should return error when end equals start', () => {
      component.dtstartInternal.set('2026-04-28T10:00');
      component.dtendInternal.set('2026-04-28T10:00');

      expect(component.timeRangeError()).toBe('End must be after start');
    });

    it('should return error when end is before start', () => {
      component.dtstartInternal.set('2026-04-28T12:00');
      component.dtendInternal.set('2026-04-28T10:00');

      expect(component.timeRangeError()).toBe('End must be after start');
    });

    it('should return null when fields are empty', () => {
      component.dtstartInternal.set('');
      component.dtendInternal.set('');

      expect(component.timeRangeError()).toBeNull();
    });
  });

  describe('isValid', () => {
    it('should be true when all fields are valid', () => {
      component.dtstartInternal.set('2026-04-28T10:00');
      component.dtendInternal.set('2026-04-28T12:00');
      component.rruleInternal.set('FREQ=WEEKLY;COUNT=10');

      expect(component.isValid()).toBe(true);
    });

    it('should be false when rrule is missing', () => {
      component.dtstartInternal.set('2026-04-28T10:00');
      component.dtendInternal.set('2026-04-28T12:00');
      component.rruleInternal.set('');

      expect(component.isValid()).toBe(false);
    });

    it('should be false when time range is invalid', () => {
      component.dtstartInternal.set('2026-04-28T12:00');
      component.dtendInternal.set('2026-04-28T10:00');
      component.rruleInternal.set('FREQ=WEEKLY;COUNT=10');

      expect(component.isValid()).toBe(false);
    });
  });

  describe('valueChange output', () => {
    it('should emit value with correct duration on start change', () => {
      const emitted: RecurringScheduleValue[] = [];
      component.valueChange.subscribe(v => emitted.push(v));

      component.dtstartInternal.set('2026-04-28T10:00');
      component.dtendInternal.set('2026-04-28T12:30');
      component.rruleInternal.set('FREQ=WEEKLY;COUNT=10');

      component.onStartChange('2026-04-28T10:00');

      expect(emitted.length).toBeGreaterThan(0);
      const last = emitted[emitted.length - 1];
      expect(last.duration).toBe('PT2H30M');
      expect(last.isValid).toBe(true);
    });
  });
});
