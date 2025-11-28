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
import { FormGroup, FormControl, ReactiveFormsModule } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { EditPropertyComponent } from './edit-property.component';
import { DataService } from '../../services/data.service';
import { EntityPropertyType } from '../../interfaces/entity';
import { MOCK_PROPERTIES, createMockProperty } from '../../testing';
import { GeoPointMapComponent } from '../geo-point-map/geo-point-map.component';

describe('EditPropertyComponent', () => {
  let component: EditPropertyComponent;
  let fixture: ComponentFixture<EditPropertyComponent>;
  let mockDataService: jasmine.SpyObj<DataService>;

  beforeEach(async () => {
    mockDataService = jasmine.createSpyObj('DataService', ['getData', 'callRpc']);

    await TestBed.configureTestingModule({
      imports: [EditPropertyComponent, ReactiveFormsModule],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: DataService, useValue: mockDataService }
      ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(EditPropertyComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('TextShort Type', () => {
    it('should render text input', () => {
      const formGroup = new FormGroup({
        name: new FormControl('')
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const input = fixture.debugElement.query(By.css('input[type="text"]'));
      expect(input).toBeTruthy();
      expect(input.nativeElement.id).toBe('name');
    });

    it('should bind form control to input', () => {
      const formGroup = new FormGroup({
        name: new FormControl('Initial Value')
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const input = fixture.debugElement.query(By.css('input[type="text"]')).nativeElement;
      expect(input.value).toBe('Initial Value');
    });
  });

  describe('TextLong Type', () => {
    it('should render textarea', () => {
      const formGroup = new FormGroup({
        description: new FormControl('')
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textLong);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const textarea = fixture.debugElement.query(By.css('textarea'));
      expect(textarea).toBeTruthy();
      expect(textarea.nativeElement.id).toBe('description');
    });
  });

  describe('Boolean Type', () => {
    it('should render checkbox', () => {
      const formGroup = new FormGroup({
        is_active: new FormControl(false)
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.boolean);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const checkbox = fixture.debugElement.query(By.css('input[type="checkbox"]'));
      expect(checkbox).toBeTruthy();
      expect(checkbox.nativeElement.classList.contains('toggle')).toBe(true);
    });

    it('should reflect checked state from form control', () => {
      const formGroup = new FormGroup({
        is_active: new FormControl(true)
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.boolean);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const checkbox = fixture.debugElement.query(By.css('input[type="checkbox"]')).nativeElement;
      expect(checkbox.checked).toBe(true);
    });
  });

  describe('IntegerNumber Type', () => {
    it('should render number input with step=1', () => {
      const formGroup = new FormGroup({
        count: new FormControl(0)
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.integer);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const input = fixture.debugElement.query(By.css('input[type="number"]'));
      expect(input).toBeTruthy();
      expect(input.nativeElement.getAttribute('step')).toBe('1');
    });
  });

  describe('Money Type', () => {
    it('should render currency input', () => {
      const formGroup = new FormGroup({
        amount: new FormControl(null)
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.money);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const input = fixture.debugElement.query(By.css('input[currencyMask]'));
      expect(input).toBeTruthy();
    });
  });

  describe('Date Type', () => {
    it('should render date input', () => {
      const formGroup = new FormGroup({
        due_date: new FormControl('')
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.date);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const input = fixture.debugElement.query(By.css('input[type="date"]'));
      expect(input).toBeTruthy();
    });
  });

  describe('DateTime Type', () => {
    it('should render datetime input', () => {
      const formGroup = new FormGroup({
        created_at: new FormControl('')
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.dateTime);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const input = fixture.debugElement.query(By.css('input[type="datetime-local"]'));
      expect(input).toBeTruthy();
    });
  });

  describe('DateTimeLocal Type', () => {
    it('should render datetime-local input', () => {
      const formGroup = new FormGroup({
        updated_at: new FormControl('')
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.dateTimeLocal);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const input = fixture.debugElement.query(By.css('input[type="datetime-local"]'));
      expect(input).toBeTruthy();
    });
  });

  describe('ForeignKeyName Type', () => {
    it('should fetch dropdown options on init', (done) => {
      const mockOptions = [
        { id: 1, display_name: 'Option 1', created_at: '', updated_at: '' },
        { id: 2, display_name: 'Option 2', created_at: '', updated_at: '' }
      ];

      mockDataService.getData.and.returnValue(of(mockOptions as any));

      const formGroup = new FormGroup({
        status_id: new FormControl(null)
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.foreignKey);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();

      expect(mockDataService.getData).toHaveBeenCalledWith({
        key: 'Status',
        fields: ['id:id', 'display_name'],
        orderField: 'id'
      });

      component.selectOptions$?.subscribe(options => {
        expect(options.length).toBe(2);
        expect(options[0]).toEqual({ id: 1, text: 'Option 1' });
        expect(options[1]).toEqual({ id: 2, text: 'Option 2' });
        done();
      });
    });

    it('should include null option for nullable foreign keys', async () => {
      mockDataService.getData.and.returnValue(of([{ id: 1, display_name: 'Option', created_at: '', updated_at: '' }] as any));

      const formGroup = new FormGroup({
        status_id: new FormControl(null)
      });
      fixture.componentRef.setInput('property', createMockProperty({
        ...MOCK_PROPERTIES.foreignKey,
        is_nullable: true
      }));
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      await new Promise(resolve => setTimeout(resolve, 10));
      fixture.detectChanges();

      const options = fixture.debugElement.queryAll(By.css('option'));
      expect(options[0].nativeElement.textContent).toContain('Select an Option');
    });

    it('should not include null option for non-nullable foreign keys', async () => {
      mockDataService.getData.and.returnValue(of([{ id: 1, display_name: 'Option', created_at: '', updated_at: '' }] as any));

      const formGroup = new FormGroup({
        status_id: new FormControl(1)
      });
      fixture.componentRef.setInput('property', createMockProperty({
        ...MOCK_PROPERTIES.foreignKey,
        is_nullable: false
      }));
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      await new Promise(resolve => setTimeout(resolve, 10));
      fixture.detectChanges();

      const options = fixture.debugElement.queryAll(By.css('option'));
      // Should only have data options, no "Select an Option"
      expect(options.length).toBe(1);
      expect(options[0].nativeElement.textContent).toContain('Option');
    });
  });

  describe('GeoPoint Type', () => {
    it('should render GeoPointMapComponent in edit mode', () => {
      const formGroup = new FormGroup({
        location: new FormControl(null)
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.geoPoint);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const mapComponent = fixture.debugElement.query(By.directive(GeoPointMapComponent));
      expect(mapComponent).toBeTruthy();

      const mapInstance = mapComponent.componentInstance as GeoPointMapComponent;
      expect(mapInstance.mode()).toBe('edit');
      expect(mapInstance.width()).toBe('100%');
      expect(mapInstance.height()).toBe('250px');
    });

    it('should update form control when map value changes', async () => {
      const formControl = new FormControl<string | null>(null);
      const formGroup = new FormGroup({
        location: formControl
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.geoPoint);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const newValue = 'SRID=4326;POINT(-83.5 43.2)';
      component.onMapValueChange(newValue);

      // onMapValueChange uses setTimeout(0), wait for it
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(formControl.value).toBe(newValue);
      expect(formControl.dirty).toBe(true);
    });
  });

  describe('Email Type', () => {
    it('should render email input with HTML5 email type', () => {
      const emailProp = createMockProperty({
        column_name: 'contact_email',
        display_name: 'Contact Email',
        udt_name: 'email_address',
        type: EntityPropertyType.Email
      });
      const formGroup = new FormGroup({
        contact_email: new FormControl('test@example.com')
      });
      fixture.componentRef.setInput('property', emailProp);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const input = fixture.debugElement.query(By.css('input[type="email"]'));
      expect(input).toBeTruthy();
      expect(input.nativeElement.id).toBe('contact_email');
      expect(input.nativeElement.placeholder).toBe('user@example.com');
    });

    it('should bind form control to email input', () => {
      const emailProp = createMockProperty({
        column_name: 'contact_email',
        udt_name: 'email_address',
        type: EntityPropertyType.Email
      });
      const formGroup = new FormGroup({
        contact_email: new FormControl('john@example.com')
      });
      fixture.componentRef.setInput('property', emailProp);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const input = fixture.debugElement.query(By.css('input[type="email"]')).nativeElement;
      expect(input.value).toBe('john@example.com');
    });
  });

  describe('Telephone Type', () => {
    it('should render tel input with masking', () => {
      const telProp = createMockProperty({
        column_name: 'contact_phone',
        display_name: 'Contact Phone',
        udt_name: 'phone_number',
        type: EntityPropertyType.Telephone
      });
      const formGroup = new FormGroup({
        contact_phone: new FormControl('5551234567')
      });
      fixture.componentRef.setInput('property', telProp);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const input = fixture.debugElement.query(By.css('input[type="tel"]'));
      expect(input).toBeTruthy();
      expect(input.nativeElement.id).toBe('contact_phone');
      expect(input.nativeElement.getAttribute('maxlength')).toBe('14');
      expect(input.nativeElement.placeholder).toBe('(555) 123-4567');
    });

    describe('getFormattedPhone()', () => {
      it('should format empty string', () => {
        const telProp = createMockProperty({
          column_name: 'contact_phone',
          udt_name: 'phone_number',
          type: EntityPropertyType.Telephone
        });
        const formGroup = new FormGroup({
          contact_phone: new FormControl('')
        });
        fixture.componentRef.setInput('property', telProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        expect(component.getFormattedPhone('contact_phone')).toBe('');
      });

      it('should format 1-3 digits with opening parenthesis', () => {
        const telProp = createMockProperty({
          column_name: 'contact_phone',
          udt_name: 'phone_number',
          type: EntityPropertyType.Telephone
        });
        const formGroup = new FormGroup({
          contact_phone: new FormControl('5')
        });
        fixture.componentRef.setInput('property', telProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        expect(component.getFormattedPhone('contact_phone')).toBe('(5');
      });

      it('should format 4-6 digits with closing parenthesis and space', () => {
        const telProp = createMockProperty({
          column_name: 'contact_phone',
          udt_name: 'phone_number',
          type: EntityPropertyType.Telephone
        });
        const formGroup = new FormGroup({
          contact_phone: new FormControl('5551')
        });
        fixture.componentRef.setInput('property', telProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        expect(component.getFormattedPhone('contact_phone')).toBe('(555) 1');
      });

      it('should format 7-10 digits with dash', () => {
        const telProp = createMockProperty({
          column_name: 'contact_phone',
          udt_name: 'phone_number',
          type: EntityPropertyType.Telephone
        });
        const formGroup = new FormGroup({
          contact_phone: new FormControl('5551234567')
        });
        fixture.componentRef.setInput('property', telProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        expect(component.getFormattedPhone('contact_phone')).toBe('(555) 123-4567');
      });

      it('should truncate beyond 10 digits', () => {
        const telProp = createMockProperty({
          column_name: 'contact_phone',
          udt_name: 'phone_number',
          type: EntityPropertyType.Telephone
        });
        const formGroup = new FormGroup({
          contact_phone: new FormControl('55512345678901')
        });
        fixture.componentRef.setInput('property', telProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        expect(component.getFormattedPhone('contact_phone')).toBe('(555) 123-4567');
      });

      it('should handle null value', () => {
        const telProp = createMockProperty({
          column_name: 'contact_phone',
          udt_name: 'phone_number',
          type: EntityPropertyType.Telephone
        });
        const formGroup = new FormGroup({
          contact_phone: new FormControl(null)
        });
        fixture.componentRef.setInput('property', telProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        expect(component.getFormattedPhone('contact_phone')).toBe('');
      });
    });

    describe('onPhoneInput()', () => {
      it('should strip non-digit characters and update form control', () => {
        const telProp = createMockProperty({
          column_name: 'contact_phone',
          udt_name: 'phone_number',
          type: EntityPropertyType.Telephone
        });
        const formControl = new FormControl('');
        const formGroup = new FormGroup({
          contact_phone: formControl
        });
        fixture.componentRef.setInput('property', telProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();
        fixture.detectChanges();

        const input = fixture.debugElement.query(By.css('input[type="tel"]')).nativeElement as HTMLInputElement;

        // Simulate typing "(555) 123-4567"
        input.value = '(555) 123-4567';
        input.setSelectionRange(14, 14); // Cursor at end
        const event = new Event('input', { bubbles: true });
        Object.defineProperty(event, 'target', { value: input, writable: false });

        component.onPhoneInput(event, 'contact_phone');

        // Form control should have raw digits only
        expect(formControl.value).toBe('5551234567');
        // Display should be formatted
        expect(input.value).toBe('(555) 123-4567');
      });

      it('should limit to 10 digits', () => {
        const telProp = createMockProperty({
          column_name: 'contact_phone',
          udt_name: 'phone_number',
          type: EntityPropertyType.Telephone
        });
        const formControl = new FormControl('');
        const formGroup = new FormGroup({
          contact_phone: formControl
        });
        fixture.componentRef.setInput('property', telProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();
        fixture.detectChanges();

        const input = fixture.debugElement.query(By.css('input[type="tel"]')).nativeElement as HTMLInputElement;

        // Try to input more than 10 digits
        input.value = '123456789012345';
        const event = new Event('input', { bubbles: true });
        Object.defineProperty(event, 'target', { value: input, writable: false });

        component.onPhoneInput(event, 'contact_phone');

        // Should truncate to 10 digits
        expect(formControl.value).toBe('1234567890');
      });

      it('should handle empty input', () => {
        const telProp = createMockProperty({
          column_name: 'contact_phone',
          udt_name: 'phone_number',
          type: EntityPropertyType.Telephone
        });
        const formControl = new FormControl('5551234567');
        const formGroup = new FormGroup({
          contact_phone: formControl
        });
        fixture.componentRef.setInput('property', telProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();
        fixture.detectChanges();

        const input = fixture.debugElement.query(By.css('input[type="tel"]')).nativeElement as HTMLInputElement;

        // Clear the input
        input.value = '';
        const event = new Event('input', { bubbles: true });
        Object.defineProperty(event, 'target', { value: input, writable: false });

        component.onPhoneInput(event, 'contact_phone');

        expect(formControl.value).toBe('');
        expect(input.value).toBe('');
      });

      it('should preserve cursor position when typing in middle', () => {
        const telProp = createMockProperty({
          column_name: 'contact_phone',
          udt_name: 'phone_number',
          type: EntityPropertyType.Telephone
        });
        const formControl = new FormControl('5551234');
        const formGroup = new FormGroup({
          contact_phone: formControl
        });
        fixture.componentRef.setInput('property', telProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();
        fixture.detectChanges();

        const input = fixture.debugElement.query(By.css('input[type="tel"]')).nativeElement as HTMLInputElement;

        // Set initial formatted value "(555) 123-4"
        input.value = '(555) 123-4';
        // User inserts a digit in middle: cursor at position 5 (after "555)")
        input.setSelectionRange(5, 5);

        // Simulate typing "9" after area code
        input.value = '(555)9 123-4';
        const event = new Event('input', { bubbles: true });
        Object.defineProperty(event, 'target', { value: input, writable: false });

        component.onPhoneInput(event, 'contact_phone');

        // Form control updated
        expect(formControl.value).toBe('55591234');
        // Cursor position restored (tests that cursor logic runs)
        expect(input.selectionStart).toBeDefined();
      });
    });
  });

  describe('Color Type', () => {
    it('should render both color picker and text input', () => {
      const colorProp = createMockProperty({
        column_name: 'color',
        display_name: 'Color',
        udt_name: 'hex_color',
        type: EntityPropertyType.Color
      });
      const formGroup = new FormGroup({
        color: new FormControl('#3b82f6')
      });
      fixture.componentRef.setInput('property', colorProp);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const colorInput = fixture.debugElement.query(By.css('input[type="color"]'));
      expect(colorInput).toBeTruthy();
      expect(colorInput.nativeElement.classList.contains('cursor-pointer')).toBe(true);

      const textInput = fixture.debugElement.query(By.css('input[type="text"]'));
      expect(textInput).toBeTruthy();
      expect(textInput.nativeElement.classList.contains('font-mono')).toBe(true);
      expect(textInput.nativeElement.placeholder).toBe('#3B82F6');
    });

    it('should bind both inputs to the same form control', () => {
      const colorProp = createMockProperty({
        column_name: 'color',
        udt_name: 'hex_color',
        type: EntityPropertyType.Color
      });
      const formGroup = new FormGroup({
        color: new FormControl('#ff5733')
      });
      fixture.componentRef.setInput('property', colorProp);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const colorInput = fixture.debugElement.query(By.css('input[type="color"]')).nativeElement;
      const textInput = fixture.debugElement.query(By.css('input[type="text"]')).nativeElement;

      expect(colorInput.value).toBe('#ff5733');
      expect(textInput.value).toBe('#ff5733');
    });

    it('should update form control when color picker changes', () => {
      const colorProp = createMockProperty({
        column_name: 'color',
        udt_name: 'hex_color',
        type: EntityPropertyType.Color
      });
      const formControl = new FormControl('#000000');
      const formGroup = new FormGroup({
        color: formControl
      });
      fixture.componentRef.setInput('property', colorProp);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const colorInput = fixture.debugElement.query(By.css('input[type="color"]')).nativeElement;
      colorInput.value = '#3b82f6';
      colorInput.dispatchEvent(new Event('input'));
      fixture.detectChanges();

      expect(formControl.value).toBe('#3b82f6');
    });

    it('should update form control when text input changes', () => {
      const colorProp = createMockProperty({
        column_name: 'color',
        udt_name: 'hex_color',
        type: EntityPropertyType.Color
      });
      const formControl = new FormControl('#000000');
      const formGroup = new FormGroup({
        color: formControl
      });
      fixture.componentRef.setInput('property', colorProp);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const textInput = fixture.debugElement.query(By.css('input[type="text"]')).nativeElement;
      textInput.value = '#FF6B6B';
      textInput.dispatchEvent(new Event('input'));
      fixture.detectChanges();

      expect(formControl.value).toBe('#FF6B6B');
    });

    it('should handle null color value', () => {
      const colorProp = createMockProperty({
        column_name: 'color',
        udt_name: 'hex_color',
        type: EntityPropertyType.Color
      });
      const formGroup = new FormGroup({
        color: new FormControl(null)
      });
      fixture.componentRef.setInput('property', colorProp);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const colorInput = fixture.debugElement.query(By.css('input[type="color"]'));
      const textInput = fixture.debugElement.query(By.css('input[type="text"]'));

      expect(colorInput).toBeTruthy();
      expect(textInput).toBeTruthy();
      // Both inputs should render even with null value
    });
  });

  describe('Unknown Type', () => {
    it('should not render any input for unknown types', () => {
      const formGroup = new FormGroup({
        unknown_field: new FormControl('')
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.unknown);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const inputs = fixture.debugElement.queryAll(By.css('input, select, textarea'));
      // Should only find the label, no actual input elements
      expect(inputs.length).toBe(0);
    });
  });

  describe('Label Rendering', () => {
    it('should render label with display_name', () => {
      const formGroup = new FormGroup({
        name: new FormControl('')
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const label = fixture.debugElement.query(By.css('label'));
      expect(label.nativeElement.textContent).toContain('Name');
    });

    it('should add asterisk for required (non-nullable) fields', () => {
      const formGroup = new FormGroup({
        name: new FormControl('')
      });
      fixture.componentRef.setInput('property', createMockProperty({
        ...MOCK_PROPERTIES.textShort,
        is_nullable: false
      }));
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const label = fixture.debugElement.query(By.css('label'));
      expect(label.nativeElement.textContent).toContain('*');
    });

    it('should not add asterisk for nullable fields', () => {
      const formGroup = new FormGroup({
        name: new FormControl('')
      });
      fixture.componentRef.setInput('property', createMockProperty({
        ...MOCK_PROPERTIES.textShort,
        is_nullable: true
      }));
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const label = fixture.debugElement.query(By.css('label'));
      expect(label.nativeElement.textContent).not.toContain('*');
    });
  });

  describe('Validation Error Display', () => {
    it('should show required error when field is touched and empty', () => {
      const formControl = new FormControl('', { validators: [] });
      const formGroup = new FormGroup({
        name: formControl
      });
      fixture.componentRef.setInput('property', createMockProperty({
        ...MOCK_PROPERTIES.textShort,
        is_nullable: false
      }));
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      // Simulate user interaction
      formControl.markAsTouched();
      formControl.setErrors({ required: true });
      fixture.detectChanges();

      const errorDiv = fixture.debugElement.query(By.css('.text-error'));
      expect(errorDiv).toBeTruthy();
      expect(errorDiv.nativeElement.textContent).toContain('Name is required');
    });

    it('should not show error when field is valid', () => {
      const formControl = new FormControl('Valid Value');
      const formGroup = new FormGroup({
        name: formControl
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const errorDiv = fixture.debugElement.query(By.css('.text-error'));
      expect(errorDiv).toBeFalsy();
    });

    it('should not show error when field is invalid but not touched', () => {
      const formControl = new FormControl('');
      formControl.setErrors({ required: true });
      const formGroup = new FormGroup({
        name: formControl
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      const errorDiv = fixture.debugElement.query(By.css('.text-error'));
      expect(errorDiv).toBeFalsy();
    });

    it('should show error when field is dirty and invalid', () => {
      const formControl = new FormControl('');
      const formGroup = new FormGroup({
        name: formControl
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();
      fixture.detectChanges();

      // Mark as dirty and set errors after initialization
      formControl.markAsDirty();
      formControl.setErrors({ required: true });
      fixture.detectChanges();

      const errorDiv = fixture.debugElement.query(By.css('.text-error'));
      expect(errorDiv).toBeTruthy();
    });
  });

  describe('Component Initialization', () => {
    it('should set propType from property type on init', () => {
      const formGroup = new FormGroup({
        name: new FormControl('')
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();

      expect(component.propType()).toBe(EntityPropertyType.TextShort);
    });

    it('should not call getData for non-ForeignKey types', () => {
      const formGroup = new FormGroup({
        name: new FormControl('')
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('formGroup', formGroup);
      component.ngOnInit();

      expect(mockDataService.getData).not.toHaveBeenCalled();
    });
  });

  describe('onMapValueChange()', () => {
    it('should update form control value and mark as dirty', async () => {
      const formControl = new FormControl('');
      const formGroup = new FormGroup({
        location: formControl
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.geoPoint);
      fixture.componentRef.setInput('formGroup', formGroup);

      const newValue = 'SRID=4326;POINT(-80.5 40.2)';
      component.onMapValueChange(newValue);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(formControl.value).toBe(newValue);
      expect(formControl.dirty).toBe(true);
    });

    it('should handle empty string value from map', async () => {
      const formControl = new FormControl('initial value');
      const formGroup = new FormGroup({
        location: formControl
      });
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.geoPoint);
      fixture.componentRef.setInput('formGroup', formGroup);

      component.onMapValueChange('');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(formControl.value).toBe('');
    });
  });

  describe('Label and Tooltip Display', () => {
    it('should display property label', () => {
      const mockProperty = createMockProperty({
        column_name: 'test_field',
        display_name: 'Test Field'
      });

      const formGroup = new FormGroup({ test_field: new FormControl('') });
      fixture.componentRef.setInput('property', mockProperty);
      fixture.componentRef.setInput('formGroup', formGroup);
      fixture.detectChanges();

      const label = fixture.nativeElement.querySelector('label span');
      expect(label.textContent).toContain('Test Field');
    });

    it('should display tooltip when description exists', () => {
      const mockProperty = createMockProperty({
        column_name: 'test',
        description: 'This is a helpful description'
      });

      const formGroup = new FormGroup({ test: new FormControl('') });
      fixture.componentRef.setInput('property', mockProperty);
      fixture.componentRef.setInput('formGroup', formGroup);
      fixture.detectChanges();

      const tooltip = fixture.nativeElement.querySelector('.tooltip');
      expect(tooltip).toBeTruthy();
      expect(tooltip.getAttribute('data-tip')).toBe('This is a helpful description');
    });

    it('should not display tooltip when description is null', () => {
      const mockProperty = createMockProperty({
        column_name: 'test',
        description: undefined
      });

      const formGroup = new FormGroup({ test: new FormControl('') });
      fixture.componentRef.setInput('property', mockProperty);
      fixture.componentRef.setInput('formGroup', formGroup);
      fixture.detectChanges();

      const tooltip = fixture.nativeElement.querySelector('.tooltip');
      expect(tooltip).toBeFalsy();
    });

    it('should use font-semibold for label', () => {
      const mockProperty = createMockProperty({ column_name: 'test' });

      const formGroup = new FormGroup({ test: new FormControl('') });
      fixture.componentRef.setInput('property', mockProperty);
      fixture.componentRef.setInput('formGroup', formGroup);
      fixture.detectChanges();

      const labelSpan = fixture.nativeElement.querySelector('label span');
      expect(labelSpan.classList.contains('font-semibold')).toBe(true);
    });
  });

  describe('Status Type', () => {
    const mockStatusOptions = [
      { id: 1, text: 'Pending', color: '#F59E0B' },
      { id: 2, text: 'Approved', color: '#22C55E' },
      { id: 3, text: 'Denied', color: '#EF4444' },
      { id: 4, text: 'No Color', color: null }
    ];

    beforeEach(() => {
      // Mock callRpc for Status type tests
      mockDataService.callRpc.and.returnValue(of([
        { id: 1, display_name: 'Pending', color: '#F59E0B' },
        { id: 2, display_name: 'Approved', color: '#22C55E' },
        { id: 3, display_name: 'Denied', color: '#EF4444' },
        { id: 4, display_name: 'No Color', color: null }
      ]));
    });

    describe('getSelectedStatusColor()', () => {
      it('should return color of selected status', () => {
        const statusProp = createMockProperty({
          column_name: 'status_id',
          type: EntityPropertyType.Status,
          status_entity_type: 'test_status'
        });
        const formGroup = new FormGroup({
          status_id: new FormControl(2) // Approved
        });
        fixture.componentRef.setInput('property', statusProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        const color = component.getSelectedStatusColor(mockStatusOptions);
        expect(color).toBe('#22C55E');
      });

      it('should return null when no status selected', () => {
        const statusProp = createMockProperty({
          column_name: 'status_id',
          type: EntityPropertyType.Status,
          status_entity_type: 'test_status'
        });
        const formGroup = new FormGroup({
          status_id: new FormControl(null)
        });
        fixture.componentRef.setInput('property', statusProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        const color = component.getSelectedStatusColor(mockStatusOptions);
        expect(color).toBeNull();
      });

      it('should return null when selected status has no color', () => {
        const statusProp = createMockProperty({
          column_name: 'status_id',
          type: EntityPropertyType.Status,
          status_entity_type: 'test_status'
        });
        const formGroup = new FormGroup({
          status_id: new FormControl(4) // No Color status
        });
        fixture.componentRef.setInput('property', statusProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        const color = component.getSelectedStatusColor(mockStatusOptions);
        expect(color).toBeNull();
      });

      it('should handle string status_id (from select element)', () => {
        const statusProp = createMockProperty({
          column_name: 'status_id',
          type: EntityPropertyType.Status,
          status_entity_type: 'test_status'
        });
        const formGroup = new FormGroup({
          status_id: new FormControl('1') // String value from select
        });
        fixture.componentRef.setInput('property', statusProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        const color = component.getSelectedStatusColor(mockStatusOptions);
        expect(color).toBe('#F59E0B');
      });
    });

    describe('getSelectedStatusBackgroundColor()', () => {
      it('should return rgba color with 15% opacity', () => {
        const statusProp = createMockProperty({
          column_name: 'status_id',
          type: EntityPropertyType.Status,
          status_entity_type: 'test_status'
        });
        const formGroup = new FormGroup({
          status_id: new FormControl(1) // Pending - #F59E0B
        });
        fixture.componentRef.setInput('property', statusProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        const bgColor = component.getSelectedStatusBackgroundColor(mockStatusOptions);
        // #F59E0B = rgb(245, 158, 11)
        expect(bgColor).toBe('rgba(245, 158, 11, 0.15)');
      });

      it('should return null when no status selected', () => {
        const statusProp = createMockProperty({
          column_name: 'status_id',
          type: EntityPropertyType.Status,
          status_entity_type: 'test_status'
        });
        const formGroup = new FormGroup({
          status_id: new FormControl(null)
        });
        fixture.componentRef.setInput('property', statusProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        const bgColor = component.getSelectedStatusBackgroundColor(mockStatusOptions);
        expect(bgColor).toBeNull();
      });

      it('should correctly convert different hex colors', () => {
        const statusProp = createMockProperty({
          column_name: 'status_id',
          type: EntityPropertyType.Status,
          status_entity_type: 'test_status'
        });
        const formGroup = new FormGroup({
          status_id: new FormControl(2) // Approved - #22C55E
        });
        fixture.componentRef.setInput('property', statusProp);
        fixture.componentRef.setInput('formGroup', formGroup);
        component.ngOnInit();

        const bgColor = component.getSelectedStatusBackgroundColor(mockStatusOptions);
        // #22C55E = rgb(34, 197, 94)
        expect(bgColor).toBe('rgba(34, 197, 94, 0.15)');
      });
    });
  });
});
