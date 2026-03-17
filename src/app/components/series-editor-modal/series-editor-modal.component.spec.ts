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
import { SeriesEditorModalComponent } from './series-editor-modal.component';
import { SchemaService } from '../../services/schema.service';
import { RecurringService } from '../../services/recurring.service';
import { of } from 'rxjs';

describe('SeriesEditorModalComponent', () => {
  let component: SeriesEditorModalComponent;
  let fixture: ComponentFixture<SeriesEditorModalComponent>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockRecurringService: jasmine.SpyObj<RecurringService>;

  beforeEach(async () => {
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getProperties']);
    mockRecurringService = jasmine.createSpyObj('RecurringService', [
      'updateSeriesGroupInfo',
      'updateSeriesTemplate',
      'updateSeriesSchedule',
      'describeRRule'
    ]);

    mockSchemaService.getProperties.and.returnValue(of([]));
    mockRecurringService.describeRRule.and.returnValue('Weekly');

    await TestBed.configureTestingModule({
      imports: [SeriesEditorModalComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: RecurringService, useValue: mockRecurringService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(SeriesEditorModalComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('initial state', () => {
    it('should have correct default signal values', () => {
      expect(component.loading()).toBe(false);
      expect(component.saving()).toBe(false);
      expect(component.error()).toBeNull();
      expect(component.activeTab()).toBe('info');
    });

    it('should have form with required display_name', () => {
      expect(component.form.get('display_name')).toBeTruthy();
      expect(component.form.get('description')).toBeTruthy();
      expect(component.form.get('color')).toBeTruthy();

      component.form.get('display_name')!.setValue('');
      expect(component.form.get('display_name')!.valid).toBe(false);

      component.form.get('display_name')!.setValue('Test Series');
      expect(component.form.get('display_name')!.valid).toBe(true);
    });

    it('should have description as optional', () => {
      component.form.get('description')!.setValue('');
      expect(component.form.get('description')!.valid).toBe(true);
    });
  });

  describe('form population from inputs', () => {
    it('should populate form when isOpen changes with group and series', () => {
      component.group = {
        id: 1,
        display_name: 'Weekly Yoga',
        description: 'Monday yoga class',
        color: '#FF5733',
        entity_table: 'reservations'
      } as any;

      component.series = {
        id: 1,
        dtstart: '2026-04-28T10:00:00',
        duration: 'PT1H30M',
        rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=20',
        entity_template: { room_id: 5 }
      } as any;

      component.isOpen = true;

      component.ngOnChanges({
        isOpen: { currentValue: true, previousValue: false, firstChange: false, isFirstChange: () => false }
      });

      expect(component.form.get('display_name')!.value).toBe('Weekly Yoga');
      expect(component.form.get('description')!.value).toBe('Monday yoga class');
      expect(component.form.get('color')!.value).toBe('#FF5733');

      const schedule = component.scheduleValue();
      expect(schedule.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;COUNT=20');
      expect(schedule.isValid).toBe(true);
    });
  });

  describe('parseDuration (via formatDuration)', () => {
    it('should format ISO 8601 duration "PT2H30M"', () => {
      expect(component.formatDuration('PT2H30M')).toBe('2h 30m');
    });

    it('should format hours-only duration "PT1H"', () => {
      expect(component.formatDuration('PT1H')).toBe('1h');
    });

    it('should format minutes-only duration "PT45M"', () => {
      expect(component.formatDuration('PT45M')).toBe('45m');
    });

    it('should format PostgreSQL interval "01:30:00"', () => {
      expect(component.formatDuration('01:30:00')).toBe('1h 30m');
    });

    it('should format PostgreSQL interval "02:00:00"', () => {
      expect(component.formatDuration('02:00:00')).toBe('2h');
    });

    it('should handle empty duration with default', () => {
      expect(component.formatDuration('')).toBe('1h');
    });

    it('should handle unrecognized format with default', () => {
      expect(component.formatDuration('invalid')).toBe('1h');
    });
  });

  describe('events', () => {
    it('should emit cancel on onCancel', () => {
      spyOn(component.cancel, 'emit');
      component.onCancel();
      expect(component.cancel.emit).toHaveBeenCalled();
    });
  });

  describe('formatDateTime', () => {
    it('should format a valid date string', () => {
      const result = component.formatDateTime('2026-04-28T10:00:00');
      expect(result).toBeTruthy();
      expect(result).not.toBe('-');
    });

    it('should return dash for empty string', () => {
      expect(component.formatDateTime('')).toBe('-');
    });
  });
});
