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
import { By } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { DisplayPropertyComponent } from './display-property.component';
import { EntityPropertyType } from '../../interfaces/entity';
import { MOCK_PROPERTIES, MOCK_DATA, createMockProperty } from '../../testing';
import { provideTranslationTesting } from '../../testing/translation-testing';
import { GeoPointMapComponent } from '../geo-point-map/geo-point-map.component';
import { DebugElement } from '@angular/core';

describe('DisplayPropertyComponent', () => {
  let component: DisplayPropertyComponent;
  let fixture: ComponentFixture<DisplayPropertyComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DisplayPropertyComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideTranslationTesting()
      ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(DisplayPropertyComponent);
    component = fixture.componentInstance;
    // Don't call detectChanges here - let each test control when it runs
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('TextShort Type', () => {
    it('should render plain text value', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('datum', 'Test Issue');  // Pass string directly, not wrapped in object
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('Test Issue');
    });

    it('should show "Not Set" for null TextShort values', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('datum', null);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('Not Set');
    });
  });

  describe('TextLong Type', () => {
    it('should render long text value', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textLong);
      fixture.componentRef.setInput('datum', 'This is a long description with many details');
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('long description');
    });
  });

  describe('Boolean Type', () => {
    it('should render checked icon for true value', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.boolean);
      fixture.componentRef.setInput('datum', true);  // Boolean value directly, not wrapped in object
      fixture.detectChanges();

      const icon = fixture.debugElement.query(By.css('.material-symbols-outlined'));
      expect(icon).toBeTruthy();
      expect(icon.nativeElement.textContent.trim()).toBe('check_box');
      expect(icon.nativeElement.classList.contains('text-primary')).toBe(true);
    });

    it('should render unchecked icon for false value', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.boolean);
      fixture.componentRef.setInput('datum', false);  // Boolean value directly, not wrapped in object
      fixture.detectChanges();

      const icon = fixture.debugElement.query(By.css('.material-symbols-outlined'));
      expect(icon).toBeTruthy();
      expect(icon.nativeElement.textContent.trim()).toBe('disabled_by_default');
      expect(icon.nativeElement.classList.contains('text-error')).toBe(true);
    });
  });

  describe('IntegerNumber Type', () => {
    it('should render formatted number', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.integer);
      fixture.componentRef.setInput('datum', 42);  // Number directly, not wrapped in object
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      // Angular number pipe formats 42 as "42"
      expect(textContent).toContain('42');
    });
  });

  describe('Money Type', () => {
    it('should render PostgREST formatted money value', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.money);
      fixture.componentRef.setInput('datum', '$1,234.56');
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      // PostgREST already formats money with dollar sign
      expect(textContent).toContain('$1,234.56');
    });
  });

  describe('Date Type', () => {
    it('should render formatted date', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.date);
      fixture.componentRef.setInput('datum', '2025-12-31');
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      // Angular date pipe formats dates
      expect(textContent.length).toBeGreaterThan(0);
      expect(textContent).not.toBe('Not Set');
    });
  });

  describe('DateTime Type', () => {
    it('should render formatted datetime with medium format', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.dateTime);
      fixture.componentRef.setInput('datum', '2025-10-04T12:00:00');
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent.length).toBeGreaterThan(0);
      expect(textContent).not.toBe('Not Set');
    });
  });

  describe('DateTimeLocal Type', () => {
    it('should render formatted datetime with full format', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.dateTimeLocal);
      fixture.componentRef.setInput('datum', '2025-10-04T15:30:00-04:00');
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent.length).toBeGreaterThan(0);
      expect(textContent).not.toBe('Not Set');
    });

    it('should display timezone in short format (GMT-4 not GMT-04:00)', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.dateTimeLocal);
      fixture.componentRef.setInput('datum', '2025-10-10T08:10:30-04:00');
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      // Using 'MMM d, y, h:mm:ss a z' format should produce short timezone like "GMT-4", "GMT+0", etc.
      // This is more readable than the long format "GMT-04:00"
      // Test is timezone-agnostic to work in different CI environments (local dev vs GitHub Actions UTC)
      expect(textContent).toMatch(/GMT[+-]\d/);  // Short format: GMT-4, GMT+0, GMT+11
      expect(textContent).not.toMatch(/GMT[+-]\d{2}:\d{2}/);  // Not long format: GMT-04:00
    });
  });

  describe('ForeignKeyName Type', () => {
    it('should render linked display_name when linkRelated is true', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.foreignKey);
      fixture.componentRef.setInput('datum', { id: 1, display_name: 'Open' });  // ForeignKey data directly, not nested
      fixture.componentRef.setInput('linkRelated', true);
      fixture.detectChanges();

      const link = fixture.debugElement.query(By.css('a'));
      expect(link).toBeTruthy();
      expect(link.nativeElement.textContent.trim()).toBe('Open');
      expect(link.nativeElement.getAttribute('href')).toContain('/view/Status/1');
    });

    it('should render plain display_name when linkRelated is false', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.foreignKey);
      fixture.componentRef.setInput('datum', { id: 1, display_name: 'Open' });  // ForeignKey data directly, not nested
      fixture.componentRef.setInput('linkRelated', false);
      fixture.detectChanges();

      // Check that there's no RouterLink in the main content (excluding modal viewers)
      const mainDiv = fixture.debugElement.query(By.css('div > div'));
      const link = mainDiv.query(By.css('a[routerLink]'));
      expect(link).toBeFalsy(); // No RouterLink should exist for foreign key when linkRelated is false

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('Open');
    });

    it('should handle null foreign key value', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.foreignKey);
      fixture.componentRef.setInput('datum', null);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('Not Set');
    });
  });

  describe('User Type', () => {
    it('should render user with private information', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.user);
      fixture.componentRef.setInput('datum', {
        display_name: 'John D.',  // Public shortened name
        full_name: 'John Doe',    // Private full name (visible if authorized)
        email: 'john@example.com',
        phone: '555-1234'
      });
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('John Doe');
      expect(textContent).toContain('john@example.com');
    });

    it('should render user without private information', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.user);
      fixture.componentRef.setInput('datum', { display_name: 'Jane Smith' });
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('Jane Smith');
      expect(textContent).not.toContain('@');
    });

    it('should handle null user value', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.user);
      fixture.componentRef.setInput('datum', null);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('Not Set');
    });
  });

  describe('GeoPoint Type', () => {
    it('should render GeoPointMapComponent with WKT value', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.geoPoint);
      fixture.componentRef.setInput('datum', MOCK_DATA.geoPoint.location);
      fixture.detectChanges();

      const mapComponent = fixture.debugElement.query(By.directive(GeoPointMapComponent));
      expect(mapComponent).toBeTruthy();

      const mapInstance = mapComponent.componentInstance as GeoPointMapComponent;
      expect(mapInstance.mode()).toBe('display');
      expect(mapInstance.initialValue()).toBe('POINT(-83.6875 43.0125)');
      expect(mapInstance.width()).toBe('100%');
      expect(mapInstance.height()).toBe('150px');
    });

    it('should show "Not Set" for null GeoPoint', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.geoPoint);
      fixture.componentRef.setInput('datum', null);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('Not Set');
    });
  });

  describe('Email Type', () => {
    it('should render email as clickable mailto link', () => {
      const emailProp = createMockProperty({
        column_name: 'contact_email',
        display_name: 'Contact Email',
        udt_name: 'email_address',
        type: EntityPropertyType.Email
      });

      fixture.componentRef.setInput('property', emailProp);
      fixture.componentRef.setInput('datum', 'test@example.com');
      fixture.detectChanges();

      const link = fixture.debugElement.query(By.css('a'));
      expect(link).toBeTruthy();
      expect(link.nativeElement.getAttribute('href')).toBe('mailto:test@example.com');
      expect(link.nativeElement.textContent.trim()).toBe('test@example.com');
      expect(link.nativeElement.classList.contains('link')).toBe(true);
      expect(link.nativeElement.classList.contains('link-primary')).toBe(true);
    });

    it('should show "Not Set" for null email value', () => {
      const emailProp = createMockProperty({
        column_name: 'contact_email',
        udt_name: 'email_address',
        type: EntityPropertyType.Email
      });

      fixture.componentRef.setInput('property', emailProp);
      fixture.componentRef.setInput('datum', null);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('Not Set');
    });
  });

  describe('Telephone Type', () => {
    it('should render telephone as clickable tel link with formatted display', () => {
      const telProp = createMockProperty({
        column_name: 'contact_phone',
        display_name: 'Contact Phone',
        udt_name: 'phone_number',
        type: EntityPropertyType.Telephone
      });

      fixture.componentRef.setInput('property', telProp);
      fixture.componentRef.setInput('datum', '5551234567');
      fixture.detectChanges();

      const link = fixture.debugElement.query(By.css('a'));
      expect(link).toBeTruthy();
      expect(link.nativeElement.getAttribute('href')).toBe('tel:+15551234567');
      expect(link.nativeElement.textContent.trim()).toBe('(555) 123-4567');
      expect(link.nativeElement.classList.contains('link')).toBe(true);
      expect(link.nativeElement.classList.contains('link-primary')).toBe(true);
    });

    it('should show "Not Set" for null telephone value', () => {
      const telProp = createMockProperty({
        column_name: 'contact_phone',
        udt_name: 'phone_number',
        type: EntityPropertyType.Telephone
      });

      fixture.componentRef.setInput('property', telProp);
      fixture.componentRef.setInput('datum', null);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('Not Set');
    });

    describe('formatPhoneNumber()', () => {
      it('should format 10-digit phone number', () => {
        expect(component.formatPhoneNumber('5551234567')).toBe('(555) 123-4567');
      });

      it('should return original value for non-10-digit input', () => {
        expect(component.formatPhoneNumber('123')).toBe('123');
        expect(component.formatPhoneNumber('12345')).toBe('12345');
        expect(component.formatPhoneNumber('123456789012')).toBe('123456789012');
      });

      it('should handle null and undefined gracefully', () => {
        expect(component.formatPhoneNumber(null as any)).toBeNull();
        expect(component.formatPhoneNumber(undefined as any)).toBeUndefined();
      });

      it('should handle empty string', () => {
        expect(component.formatPhoneNumber('')).toBe('');
      });
    });
  });

  describe('Color Type', () => {
    it('should render color badge with swatch and uppercase hex value', () => {
      const colorProp = createMockProperty({
        column_name: 'color',
        display_name: 'Color',
        udt_name: 'hex_color',
        type: EntityPropertyType.Color
      });

      fixture.componentRef.setInput('property', colorProp);
      fixture.componentRef.setInput('datum', '#3b82f6');
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge).toBeTruthy();
      expect(badge.nativeElement.classList.contains('font-mono')).toBe(true);

      const colorSwatch = badge.query(By.css('span[class*="w-5"]'));
      expect(colorSwatch).toBeTruthy();
      expect(colorSwatch.nativeElement.style.backgroundColor).toBe('rgb(59, 130, 246)'); // Browsers convert hex to rgb

      const textContent = badge.nativeElement.textContent.trim();
      expect(textContent).toBe('#3B82F6');
    });

    it('should handle lowercase hex color input', () => {
      const colorProp = createMockProperty({
        column_name: 'color',
        udt_name: 'hex_color',
        type: EntityPropertyType.Color
      });

      fixture.componentRef.setInput('property', colorProp);
      fixture.componentRef.setInput('datum', '#ff5733');
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      const textContent = badge.nativeElement.textContent.trim();
      expect(textContent).toBe('#FF5733');
    });

    it('should show "Not Set" for null color value', () => {
      const colorProp = createMockProperty({
        column_name: 'color',
        udt_name: 'hex_color',
        type: EntityPropertyType.Color
      });

      fixture.componentRef.setInput('property', colorProp);
      fixture.componentRef.setInput('datum', null);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('Not Set');
    });

    it('should render border around color swatch', () => {
      const colorProp = createMockProperty({
        column_name: 'color',
        udt_name: 'hex_color',
        type: EntityPropertyType.Color
      });

      fixture.componentRef.setInput('property', colorProp);
      fixture.componentRef.setInput('datum', '#000000');
      fixture.detectChanges();

      const colorSwatch = fixture.debugElement.query(By.css('span.rounded'));
      expect(colorSwatch).toBeTruthy();
      expect(colorSwatch.nativeElement.classList.contains('border')).toBe(true);
      expect(colorSwatch.nativeElement.classList.contains('border-base-300')).toBe(true);
    });
  });

  describe('Unknown Type', () => {
    it('should render raw datum value for unknown types', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.unknown);
      fixture.componentRef.setInput('datum', 'Unknown value');
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('Unknown value');
    });
  });

  describe('Null Handling', () => {
    it('should show "Not Set" for null datum across all types', () => {
      const types = [
        MOCK_PROPERTIES.textShort,
        MOCK_PROPERTIES.integer,
        MOCK_PROPERTIES.money,
        MOCK_PROPERTIES.date
      ];

      types.forEach(prop => {
        fixture.componentRef.setInput('property', prop);
        fixture.componentRef.setInput('datum', null);
        fixture.detectChanges();

        const textContent = fixture.nativeElement.textContent.trim();
        expect(textContent).toContain('Not Set');
      });
    });
  });

  describe('Component Initialization', () => {
    it('should set propType from property type on init', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);

      expect(component.propType()).toBe(EntityPropertyType.TextShort);
    });

    it('should default linkRelated to true', () => {
      expect(component.linkRelated()).toBe(true);
    });
  });

  describe('Label and Tooltip Display', () => {
    it('should display property label', () => {
      const mockProperty = createMockProperty({
        display_name: 'Field Name'
      });

      fixture.componentRef.setInput('property', mockProperty);
      fixture.componentRef.setInput('datum', 'test value');
      fixture.detectChanges();

      const label = fixture.nativeElement.querySelector('label span');
      expect(label.textContent).toContain('Field Name');
    });

    it('should display tooltip when description exists', () => {
      const mockProperty = createMockProperty({
        description: 'Detailed information about this field'
      });

      fixture.componentRef.setInput('property', mockProperty);
      fixture.componentRef.setInput('datum', 'value');
      fixture.detectChanges();

      const tooltip = fixture.nativeElement.querySelector('.tooltip');
      expect(tooltip).toBeTruthy();
      expect(tooltip.getAttribute('data-tip')).toBe('Detailed information about this field');
    });

    it('should not display tooltip when description is null', () => {
      const mockProperty = createMockProperty({
        description: undefined
      });

      fixture.componentRef.setInput('property', mockProperty);
      fixture.componentRef.setInput('datum', 'value');
      fixture.detectChanges();

      const tooltip = fixture.nativeElement.querySelector('.tooltip');
      expect(tooltip).toBeFalsy();
    });
  });

  describe('Search Term Highlighting', () => {
    it('should highlight search terms in TextShort fields', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('datum', 'pothole on main street');
      fixture.componentRef.setInput('highlightTerms', ['pothole', 'main']);
      fixture.detectChanges();

      const innerHTML = fixture.nativeElement.innerHTML;
      expect(innerHTML).toContain('<mark');
      expect(innerHTML).toContain('pothole');
      expect(innerHTML).toContain('main');
    });

    it('should highlight search terms in TextLong fields', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textLong);
      fixture.componentRef.setInput('datum', 'Large pothole discovered on Main Street causing traffic issues');
      fixture.componentRef.setInput('highlightTerms', ['pothole', 'traffic']);
      fixture.detectChanges();

      const innerHTML = fixture.nativeElement.innerHTML;
      expect(innerHTML).toContain('<mark');
      expect(innerHTML).toContain('pothole');
      expect(innerHTML).toContain('traffic');
    });

    it('should not highlight when highlightTerms is empty array', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('datum', 'test value');
      fixture.componentRef.setInput('highlightTerms', []);
      fixture.detectChanges();

      const innerHTML = fixture.nativeElement.innerHTML;
      expect(innerHTML).not.toContain('<mark');
      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('test value');
    });

    it('should not highlight non-text fields', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.integer);
      fixture.componentRef.setInput('datum', 42);
      fixture.componentRef.setInput('highlightTerms', ['42']);
      fixture.detectChanges();

      const innerHTML = fixture.nativeElement.innerHTML;
      // Number fields should not use highlighting
      expect(innerHTML).not.toContain('<mark');
    });

    it('should handle highlighting with special characters safely', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('datum', 'Cost is $100');
      fixture.componentRef.setInput('highlightTerms', ['$100']);
      fixture.detectChanges();

      const innerHTML = fixture.nativeElement.innerHTML;
      expect(innerHTML).toContain('<mark');
      expect(innerHTML).toContain('$100');
    });

    it('should escape HTML in datum to prevent XSS when highlighting', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('datum', '<script>alert("xss")</script>');
      fixture.componentRef.setInput('highlightTerms', ['script']);
      fixture.detectChanges();

      const innerHTML = fixture.nativeElement.innerHTML;
      // Should not contain unescaped script tags
      expect(innerHTML).not.toContain('<script>alert');
      // Should contain escaped HTML entities
      expect(innerHTML).toContain('&lt;');
      expect(innerHTML).toContain('&gt;');
      // Should still highlight the word "script" within escaped HTML
      expect(innerHTML).toContain('<mark');
    });

    it('should highlight case-insensitively', () => {
      fixture.componentRef.setInput('property', MOCK_PROPERTIES.textShort);
      fixture.componentRef.setInput('datum', 'Pothole on Main Street');
      fixture.componentRef.setInput('highlightTerms', ['pothole', 'main']);
      fixture.detectChanges();

      const innerHTML = fixture.nativeElement.innerHTML;
      expect(innerHTML).toContain('<mark');
      // Should highlight despite case difference
      expect(innerHTML).toContain('Pothole');
      expect(innerHTML).toContain('Main');
    });
  });
});
