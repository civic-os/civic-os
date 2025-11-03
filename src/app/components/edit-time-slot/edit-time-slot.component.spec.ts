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
import { FormsModule } from '@angular/forms';
import { provideZonelessChangeDetection } from '@angular/core';
import { By } from '@angular/platform-browser';
import { EditTimeSlotComponent } from './edit-time-slot.component';

describe('EditTimeSlotComponent', () => {
  let component: EditTimeSlotComponent;
  let fixture: ComponentFixture<EditTimeSlotComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EditTimeSlotComponent, FormsModule],
      providers: [provideZonelessChangeDetection()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(EditTimeSlotComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('Component Initialization', () => {
    it('should initialize with empty signals', () => {
      expect(component.startLocal()).toBe('');
      expect(component.endLocal()).toBe('');
      expect(component.disabled()).toBe(false);
      expect(component.errorMessage()).toBe('');
    });

    it('should render start and end datetime-local inputs', () => {
      const inputs = fixture.debugElement.queryAll(By.css('input[type="datetime-local"]'));
      expect(inputs.length).toBe(2);
      expect(inputs[0].nativeElement.disabled).toBe(false);
      expect(inputs[1].nativeElement.disabled).toBe(false);
    });
  });

  describe('Parsing PostgreSQL tstzrange Format', () => {
    it('should parse tstzrange with escaped quotes', () => {
      const tstzrange = '[\"2025-11-07 15:00:00+00\",\"2025-11-07 22:00:00+00\")';
      component.writeValue(tstzrange);

      expect(component.startLocal()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(component.endLocal()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });

    it('should parse tstzrange without escaped quotes', () => {
      const tstzrange = '[2025-11-07 15:00:00+00,2025-11-07 22:00:00+00)';
      component.writeValue(tstzrange);

      expect(component.startLocal()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(component.endLocal()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });

    it('should parse tstzrange with Z format timestamps', () => {
      const tstzrange = '[2025-03-15T14:00:00.000Z,2025-03-15T16:00:00.000Z)';
      component.writeValue(tstzrange);

      expect(component.startLocal()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(component.endLocal()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });

    it('should handle empty/null value gracefully', () => {
      component.writeValue('');
      expect(component.startLocal()).toBe('');
      expect(component.endLocal()).toBe('');

      component.writeValue(null as any);
      expect(component.startLocal()).toBe('');
      expect(component.endLocal()).toBe('');
    });

    it('should handle malformed tstzrange gracefully', () => {
      component.writeValue('invalid data');
      expect(component.startLocal()).toBe('');
      expect(component.endLocal()).toBe('');
    });
  });

  describe('Timestamp Normalization', () => {
    it('should normalize PostgreSQL timestamp format to ISO 8601', () => {
      // PostgreSQL format: "2025-11-07 15:00:00+00"
      // Should convert to: "2025-11-07T15:00:00Z"
      const tstzrange = '[2025-11-07 15:00:00+00,2025-11-07 22:00:00+00)';
      component.writeValue(tstzrange);

      // The component should successfully parse and convert to datetime-local format
      expect(component.startLocal()).toBeTruthy();
      expect(component.endLocal()).toBeTruthy();
      expect(component.startLocal().length).toBe(16); // YYYY-MM-DDTHH:MM
      expect(component.endLocal().length).toBe(16);
    });
  });

  describe('UTC to Local Datetime Conversion', () => {
    it('should convert UTC timestamps to local datetime-local format', () => {
      // Input: UTC timestamps
      const tstzrange = '[2025-03-15T14:00:00Z,2025-03-15T16:00:00Z)';
      component.writeValue(tstzrange);

      // Output: Local datetime-local format (YYYY-MM-DDTHH:MM)
      const startLocal = component.startLocal();
      const endLocal = component.endLocal();

      expect(startLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(endLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

      // Verify times are properly converted (will vary based on local timezone)
      const startDate = new Date(startLocal);
      const endDate = new Date(endLocal);
      expect(startDate.getTime()).toBeLessThan(endDate.getTime());
    });

    it('should preserve date and time values through conversion', () => {
      // Use a specific UTC timestamp
      const tstzrange = '[2025-01-15T10:30:00Z,2025-01-15T14:30:00Z)';
      component.writeValue(tstzrange);

      const startLocal = component.startLocal();
      const endLocal = component.endLocal();

      // Parse back to verify round-trip conversion
      const startDate = new Date(startLocal);
      const endDate = new Date(endLocal);

      // The dates should be valid
      expect(isNaN(startDate.getTime())).toBe(false);
      expect(isNaN(endDate.getTime())).toBe(false);

      // End should be after start
      expect(endDate.getTime() - startDate.getTime()).toBe(4 * 60 * 60 * 1000); // 4 hours
    });
  });

  describe('Building tstzrange Output Format', () => {
    it('should build correct tstzrange format when times change', () => {
      let emittedValue = '';
      component.registerOnChange((value: string) => {
        emittedValue = value;
      });

      // Set start time
      component.startLocal.set('2025-03-15T14:00');

      // Set end time (effect runs synchronously)
      component.endLocal.set('2025-03-15T16:00');
      fixture.detectChanges();

      // Should emit tstzrange format: [ISO8601,ISO8601)
      expect(emittedValue).toMatch(/^\[.+,.+\)$/);
      expect(emittedValue).toContain('2025-03-15T');
      expect(emittedValue).toContain('.000Z');
    });

    it('should emit ISO 8601 timestamps with Z suffix', () => {
      let emittedValue = '';
      component.registerOnChange((value: string) => {
        emittedValue = value;
      });

      component.startLocal.set('2025-03-15T14:00');
      component.endLocal.set('2025-03-15T16:00');
      fixture.detectChanges();

      // Format should be: [2025-03-15T14:00:00.000Z,2025-03-15T16:00:00.000Z)
      expect(emittedValue).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\)$/);
    });
  });

  describe('Validation', () => {
    it('should show error when end time is before start time', () => {
      component.startLocal.set('2025-03-15T16:00');
      component.endLocal.set('2025-03-15T14:00');
      fixture.detectChanges();

      expect(component.errorMessage()).toBe('End time must be after start time');
    });

    it('should show error when end time equals start time', () => {
      component.startLocal.set('2025-03-15T14:00');
      component.endLocal.set('2025-03-15T14:00');
      fixture.detectChanges();

      expect(component.errorMessage()).toBe('End time must be after start time');
    });

    it('should clear error when times become valid', () => {
      // Set invalid times
      component.startLocal.set('2025-03-15T16:00');
      component.endLocal.set('2025-03-15T14:00');
      fixture.detectChanges();
      expect(component.errorMessage()).toBe('End time must be after start time');

      // Fix the times
      component.endLocal.set('2025-03-15T18:00');
      fixture.detectChanges();

      expect(component.errorMessage()).toBe('');
    });

    it('should not show error when only start time is set', () => {
      component.startLocal.set('2025-03-15T14:00');
      fixture.detectChanges();

      expect(component.errorMessage()).toBe('');
    });

    it('should not show error when only end time is set', () => {
      component.endLocal.set('2025-03-15T16:00');
      fixture.detectChanges();

      expect(component.errorMessage()).toBe('');
    });

    it('should not emit value when validation fails', () => {
      let emittedValue = '';
      let emitCount = 0;
      component.registerOnChange((value: string) => {
        emittedValue = value;
        emitCount++;
      });

      // Set invalid times (end before start)
      component.startLocal.set('2025-03-15T16:00');
      component.endLocal.set('2025-03-15T14:00');
      fixture.detectChanges();

      // onChange should not have been called due to validation error
      expect(emitCount).toBe(0);
      expect(emittedValue).toBe('');
    });
  });

  describe('ControlValueAccessor Implementation', () => {
    it('should implement writeValue', () => {
      const tstzrange = '[2025-03-15T14:00:00Z,2025-03-15T16:00:00Z)';
      component.writeValue(tstzrange);

      expect(component.startLocal()).toBeTruthy();
      expect(component.endLocal()).toBeTruthy();
    });

    it('should implement registerOnChange', () => {
      let changedValue = '';
      component.registerOnChange((value: string) => {
        changedValue = value;
      });

      component.startLocal.set('2025-03-15T14:00');
      component.endLocal.set('2025-03-15T16:00');
      fixture.detectChanges();

      expect(changedValue).toBeTruthy();
      expect(changedValue).toContain('[');
      expect(changedValue).toContain(')');
    });

    it('should implement registerOnTouched', () => {
      let touched = false;
      component.registerOnTouched(() => {
        touched = true;
      });

      const startInput = fixture.debugElement.queryAll(By.css('input[type="datetime-local"]'))[0];
      startInput.nativeElement.value = '2025-03-15T14:00';
      startInput.nativeElement.dispatchEvent(new Event('input'));
      fixture.detectChanges();

      expect(touched).toBe(true);
    });

    it('should implement setDisabledState', () => {
      component.setDisabledState(true);
      expect(component.disabled()).toBe(true);

      fixture.detectChanges();
      const inputs = fixture.debugElement.queryAll(By.css('input[type="datetime-local"]'));
      expect(inputs[0].nativeElement.disabled).toBe(true);
      expect(inputs[1].nativeElement.disabled).toBe(true);

      component.setDisabledState(false);
      expect(component.disabled()).toBe(false);

      fixture.detectChanges();
      expect(inputs[0].nativeElement.disabled).toBe(false);
      expect(inputs[1].nativeElement.disabled).toBe(false);
    });
  });

  describe('User Interaction', () => {
    it('should update startLocal when start input changes', () => {
      const startInput = fixture.debugElement.queryAll(By.css('input[type="datetime-local"]'))[0];
      startInput.nativeElement.value = '2025-03-15T14:00';
      startInput.nativeElement.dispatchEvent(new Event('input'));
      fixture.detectChanges();

      expect(component.startLocal()).toBe('2025-03-15T14:00');
    });

    it('should update endLocal when end input changes', () => {
      const endInput = fixture.debugElement.queryAll(By.css('input[type="datetime-local"]'))[1];
      endInput.nativeElement.value = '2025-03-15T16:00';
      endInput.nativeElement.dispatchEvent(new Event('input'));
      fixture.detectChanges();

      expect(component.endLocal()).toBe('2025-03-15T16:00');
    });

    it('should display error message in template when validation fails', () => {
      component.startLocal.set('2025-03-15T16:00');
      component.endLocal.set('2025-03-15T14:00');
      fixture.detectChanges();

      const errorElement = fixture.debugElement.query(By.css('.text-error'));
      expect(errorElement).toBeTruthy();
      expect(errorElement.nativeElement.textContent).toContain('End time must be after start time');
    });

    it('should not display error message when times are valid', () => {
      component.startLocal.set('2025-03-15T14:00');
      component.endLocal.set('2025-03-15T16:00');
      fixture.detectChanges();

      const errorElement = fixture.debugElement.query(By.css('.text-error'));
      expect(errorElement).toBeFalsy();
    });
  });

  describe('Edge Cases', () => {
    it('should handle midnight timestamps', () => {
      const tstzrange = '[2025-03-15T00:00:00Z,2025-03-15T23:59:00Z)';
      component.writeValue(tstzrange);

      expect(component.startLocal()).toBeTruthy();
      expect(component.endLocal()).toBeTruthy();
    });

    it('should handle year boundaries', () => {
      const tstzrange = '[2024-12-31T23:00:00Z,2025-01-01T01:00:00Z)';
      component.writeValue(tstzrange);

      expect(component.startLocal()).toBeTruthy();
      expect(component.endLocal()).toBeTruthy();
    });

    it('should handle very long time ranges', () => {
      const tstzrange = '[2025-01-01T00:00:00Z,2025-12-31T23:59:00Z)';
      component.writeValue(tstzrange);

      expect(component.startLocal()).toBeTruthy();
      expect(component.endLocal()).toBeTruthy();

      const startDate = new Date(component.startLocal());
      const endDate = new Date(component.endLocal());
      expect(endDate.getTime()).toBeGreaterThan(startDate.getTime());
    });

    it('should handle multiple writeValue calls', () => {
      component.writeValue('[2025-03-15T14:00:00Z,2025-03-15T16:00:00Z)');
      expect(component.startLocal()).toBeTruthy();
      expect(component.endLocal()).toBeTruthy();

      component.writeValue('[2025-04-20T10:00:00Z,2025-04-20T12:00:00Z)');
      expect(component.startLocal()).toBeTruthy();
      expect(component.endLocal()).toBeTruthy();
      expect(component.startLocal()).toContain('2025-04-20');
    });
  });
});
