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

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';
import { ImportExportService } from './import-export.service';
import { DataService } from './data.service';
import { SchemaService } from './schema.service';
import {
  EntityPropertyType,
  SchemaEntityTable,
  SchemaEntityProperty,
  ForeignKeyLookup,
  ValidationErrorSummary,
  ImportError
} from '../interfaces/entity';

describe('ImportExportService', () => {
  let service: ImportExportService;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;

  // Helper function to create mock properties with all required fields
  const createMockProperty = (overrides: Partial<SchemaEntityProperty>): SchemaEntityProperty => ({
    table_catalog: 'civic_os',
    table_schema: 'public',
    table_name: 'issues',
    column_name: 'test_column',
    display_name: 'Test Column',
    sort_order: 1,
    column_default: '',
    is_nullable: false,
    data_type: 'text',
    character_maximum_length: 0,
    udt_schema: 'pg_catalog',
    udt_name: 'text',
    is_self_referencing: false,
    is_identity: false,
    is_generated: false,
    is_updatable: true,
    join_schema: '',
    join_table: '',
    join_column: '',
    geography_type: '',
    type: EntityPropertyType.TextShort,
    validation_rules: [],
    ...overrides
  });

  // Sample test data
  const mockEntity: SchemaEntityTable = {
    table_name: 'issues',
    display_name: 'Issues',
    select: true,
    insert: true,
    update: true,
    delete: true,
    search_fields: ['title', 'description'],
    sort_order: 1,
    description: 'Issue tracking',
    show_map: false,
    map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null
  };

  beforeEach(() => {
    // Create spy objects for dependencies
    mockDataService = jasmine.createSpyObj('DataService', [
      'getData',
      'getDataPaginated'
    ]);
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getPropsForCreate']);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ImportExportService,
        { provide: DataService, useValue: mockDataService },
        { provide: SchemaService, useValue: mockSchemaService }
      ]
    });

    service = TestBed.inject(ImportExportService);
  });

  describe('Service Creation', () => {
    it('should be created', () => {
      expect(service).toBeTruthy();
    });
  });

  describe('validateFileSize()', () => {
    it('should accept files under 10MB', () => {
      const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      Object.defineProperty(file, 'size', { value: 5 * 1024 * 1024 }); // 5MB

      const result = service.validateFileSize(file);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept files exactly at 10MB limit', () => {
      const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024 }); // 10MB

      const result = service.validateFileSize(file);

      expect(result.valid).toBe(true);
    });

    it('should reject files over 10MB', () => {
      const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      Object.defineProperty(file, 'size', { value: 15 * 1024 * 1024 }); // 15MB

      const result = service.validateFileSize(file);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('15.0MB');
      expect(result.error).toContain('10MB');
    });

    it('should reject very large files', () => {
      const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 }); // 100MB

      const result = service.validateFileSize(file);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('100.0MB');
    });

    it('should handle zero-byte files', () => {
      const file = new File([''], 'empty.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      Object.defineProperty(file, 'size', { value: 0 });

      const result = service.validateFileSize(file);

      expect(result.valid).toBe(true);
    });
  });

  describe('fetchForeignKeyLookups() - Observable Tests', () => {
    it('should return empty Map when no FK or User properties', (done) => {
      const propsWithoutFK: SchemaEntityProperty[] = [
        createMockProperty({
          column_name: 'title',
          display_name: 'Title',
          type: EntityPropertyType.TextShort
        })
      ];

      service.fetchForeignKeyLookups(propsWithoutFK).subscribe(result => {
        expect(result.size).toBe(0);
        done();
      });
    });

    it('should fetch FK lookup for ForeignKeyName property', (done) => {
      const fkProp = createMockProperty({
        column_name: 'status_id',
        display_name: 'Status',
        data_type: 'int4',
        type: EntityPropertyType.ForeignKeyName,
        join_table: 'statuses',
        join_column: 'id'
      });

      const mockStatuses = [
        { id: 1, display_name: 'Open', created_at: '2025-01-01', updated_at: '2025-01-01' },
        { id: 2, display_name: 'In Progress', created_at: '2025-01-01', updated_at: '2025-01-01' },
        { id: 3, display_name: 'Closed', created_at: '2025-01-01', updated_at: '2025-01-01' }
      ];

      mockDataService.getData.and.returnValue(of(mockStatuses));

      service.fetchForeignKeyLookups([fkProp]).subscribe(result => {
        expect(result.size).toBe(1);
        expect(result.has('statuses')).toBe(true);

        const lookup = result.get('statuses')!;
        expect(lookup.validIds.has(1)).toBe(true);
        expect(lookup.validIds.has(2)).toBe(true);
        expect(lookup.validIds.has(3)).toBe(true);
        expect(lookup.displayNameToIds.get('open')).toEqual([1]);
        expect(lookup.idsToDisplayName.get(1)).toBe('Open');

        done();
      });
    });

    it('should fetch FK lookup for User property', (done) => {
      const userProp = createMockProperty({
        column_name: 'assigned_to',
        display_name: 'Assigned To',
        data_type: 'uuid',
        type: EntityPropertyType.User
      });

      const mockUsers = [
        { id: 'abc-123', display_name: 'John Doe', created_at: '2025-01-01', updated_at: '2025-01-01' },
        { id: 'def-456', display_name: 'Jane Smith', created_at: '2025-01-01', updated_at: '2025-01-01' }
      ];

      mockDataService.getData.and.returnValue(of(mockUsers as any));

      service.fetchForeignKeyLookups([userProp]).subscribe(result => {
        expect(result.size).toBe(1);
        expect(result.has('civic_os_users')).toBe(true);

        const lookup = result.get('civic_os_users')!;
        expect(lookup.validIds.has('abc-123')).toBe(true);
        expect(lookup.validIds.has('def-456')).toBe(true);
        expect(lookup.displayNameToIds.get('john doe')).toEqual(['abc-123']);

        done();
      });
    });

    it('should handle duplicate display names correctly', (done) => {
      const fkProp = createMockProperty({
        column_name: 'status_id',
        display_name: 'Status',
        data_type: 'int4',
        type: EntityPropertyType.ForeignKeyName,
        join_table: 'statuses',
        join_column: 'id'
      });

      const mockStatuses = [
        { id: 1, display_name: 'Active', created_at: '2025-01-01', updated_at: '2025-01-01' },
        { id: 2, display_name: 'Active', created_at: '2025-01-01', updated_at: '2025-01-01' },
        { id: 3, display_name: 'Inactive', created_at: '2025-01-01', updated_at: '2025-01-01' }
      ];

      mockDataService.getData.and.returnValue(of(mockStatuses));

      service.fetchForeignKeyLookups([fkProp]).subscribe(result => {
        const lookup = result.get('statuses')!;

        // Both IDs should be in the array for 'active'
        expect(lookup.displayNameToIds.get('active')).toEqual([1, 2]);
        expect(lookup.validIds.has(1)).toBe(true);
        expect(lookup.validIds.has(2)).toBe(true);

        done();
      });
    });

    it('should handle case-insensitive display name lookup', (done) => {
      const fkProp = createMockProperty({
        column_name: 'status_id',
        display_name: 'Status',
        data_type: 'int4',
        type: EntityPropertyType.ForeignKeyName,
        join_table: 'statuses',
        join_column: 'id'
      });

      const mockStatuses = [
        { id: 1, display_name: 'UPPERCASE', created_at: '2025-01-01', updated_at: '2025-01-01' },
        { id: 2, display_name: 'lowercase', created_at: '2025-01-01', updated_at: '2025-01-01' },
        { id: 3, display_name: 'MixedCase', created_at: '2025-01-01', updated_at: '2025-01-01' }
      ];

      mockDataService.getData.and.returnValue(of(mockStatuses));

      service.fetchForeignKeyLookups([fkProp]).subscribe(result => {
        const lookup = result.get('statuses')!;

        // All keys should be lowercase
        expect(lookup.displayNameToIds.has('uppercase')).toBe(true);
        expect(lookup.displayNameToIds.has('lowercase')).toBe(true);
        expect(lookup.displayNameToIds.has('mixedcase')).toBe(true);

        // Original case preserved in reverse lookup
        expect(lookup.idsToDisplayName.get(1)).toBe('UPPERCASE');
        expect(lookup.idsToDisplayName.get(2)).toBe('lowercase');
        expect(lookup.idsToDisplayName.get(3)).toBe('MixedCase');

        done();
      });
    });

    it('should handle empty FK reference data', (done) => {
      const fkProp = createMockProperty({
        column_name: 'status_id',
        display_name: 'Status',
        data_type: 'int4',
        type: EntityPropertyType.ForeignKeyName,
        join_table: 'statuses',
        join_column: 'id'
      });

      mockDataService.getData.and.returnValue(of([]));

      service.fetchForeignKeyLookups([fkProp]).subscribe(result => {
        expect(result.size).toBe(1);
        const lookup = result.get('statuses')!;
        expect(lookup.validIds.size).toBe(0);
        expect(lookup.displayNameToIds.size).toBe(0);
        expect(lookup.idsToDisplayName.size).toBe(0);

        done();
      });
    });
  });

  describe('buildForeignKeyLookup() - Direct Method Tests', () => {
    it('should build lookup with integer IDs', () => {
      const referenceData = [
        { id: 1, display_name: 'Open', created_at: '', updated_at: '' },
        { id: 2, display_name: 'Closed', created_at: '', updated_at: '' }
      ];

      const lookup = (service as any).buildForeignKeyLookup(referenceData, false);

      expect(lookup.validIds.has(1)).toBe(true);
      expect(lookup.validIds.has(2)).toBe(true);
      expect(lookup.displayNameToIds.get('open')).toEqual([1]);
      expect(lookup.displayNameToIds.get('closed')).toEqual([2]);
      expect(lookup.idsToDisplayName.get(1)).toBe('Open');
      expect(lookup.idsToDisplayName.get(2)).toBe('Closed');
    });

    it('should build lookup with UUID IDs', () => {
      const referenceData = [
        { id: 'abc-123-uuid', display_name: 'John Doe', created_at: '', updated_at: '' },
        { id: 'def-456-uuid', display_name: 'Jane Smith', created_at: '', updated_at: '' }
      ];

      const lookup = (service as any).buildForeignKeyLookup(referenceData, true);

      expect(lookup.validIds.has('abc-123-uuid')).toBe(true);
      expect(lookup.validIds.has('def-456-uuid')).toBe(true);
      expect(lookup.displayNameToIds.get('john doe')).toEqual(['abc-123-uuid']);
      expect(lookup.idsToDisplayName.get('abc-123-uuid')).toBe('John Doe');
    });

    it('should handle duplicate display names', () => {
      const referenceData = [
        { id: 1, display_name: 'Active', created_at: '', updated_at: '' },
        { id: 2, display_name: 'Active', created_at: '', updated_at: '' },
        { id: 3, display_name: 'Active', created_at: '', updated_at: '' }
      ];

      const lookup = (service as any).buildForeignKeyLookup(referenceData, false);

      expect(lookup.displayNameToIds.get('active')).toEqual([1, 2, 3]);
      expect(lookup.validIds.size).toBe(3);
    });

    it('should trim whitespace from display names', () => {
      const referenceData = [
        { id: 1, display_name: '  Spaced  ', created_at: '', updated_at: '' },
        { id: 2, display_name: 'NoSpaces', created_at: '', updated_at: '' }
      ];

      const lookup = (service as any).buildForeignKeyLookup(referenceData, false);

      expect(lookup.displayNameToIds.has('spaced')).toBe(true);
      expect(lookup.displayNameToIds.has('nospaces')).toBe(true);
      expect(lookup.idsToDisplayName.get(1)).toBe('  Spaced  '); // Preserve original
    });

    it('should handle empty reference data', () => {
      const lookup = (service as any).buildForeignKeyLookup([], false);

      expect(lookup.validIds.size).toBe(0);
      expect(lookup.displayNameToIds.size).toBe(0);
      expect(lookup.idsToDisplayName.size).toBe(0);
    });
  });

  describe('formatAsLatLng() - Direct Method Tests', () => {
    it('should convert WKT POINT to lat,lng format', () => {
      const wkt = 'POINT(-71.0589 42.3601)';
      const result = (service as any).formatAsLatLng(wkt);

      expect(result).toBe('42.3601,-71.0589');
    });

    it('should handle negative coordinates', () => {
      const wkt = 'POINT(-122.4194 37.7749)';
      const result = (service as any).formatAsLatLng(wkt);

      expect(result).toBe('37.7749,-122.4194');
    });

    it('should handle positive coordinates', () => {
      const wkt = 'POINT(139.6917 35.6895)'; // Tokyo
      const result = (service as any).formatAsLatLng(wkt);

      expect(result).toBe('35.6895,139.6917');
    });

    it('should handle zero coordinates', () => {
      const wkt = 'POINT(0 0)';
      const result = (service as any).formatAsLatLng(wkt);

      expect(result).toBe('0,0');
    });

    it('should handle high precision coordinates', () => {
      const wkt = 'POINT(-83.72646331787111 43.016069813188494)';
      const result = (service as any).formatAsLatLng(wkt);

      expect(result).toBe('43.016069813188494,-83.72646331787111');
    });

    it('should return original string for malformed WKT', () => {
      const wkt = 'INVALID FORMAT';
      const result = (service as any).formatAsLatLng(wkt);

      expect(result).toBe('INVALID FORMAT');
    });

    it('should return original string for non-POINT geometry', () => {
      const wkt = 'LINESTRING(-83 43, -84 44)';
      const result = (service as any).formatAsLatLng(wkt);

      expect(result).toBe('LINESTRING(-83 43, -84 44)');
    });
  });

  describe('getHintForProperty() - Direct Method Tests', () => {
    it('should generate hint for TextShort with character limit', () => {
      const prop = createMockProperty({
        type: EntityPropertyType.TextShort,
        character_maximum_length: 100
      });

      const hint = (service as any).getHintForProperty(prop);

      expect(hint).toBe('Text (max 100 chars)');
    });

    it('should generate hint for IntegerNumber with min/max validation', () => {
      const prop = createMockProperty({
        type: EntityPropertyType.IntegerNumber,
        validation_rules: [
          { type: 'min', value: '1', message: 'Min 1' },
          { type: 'max', value: '5', message: 'Max 5' }
        ]
      });

      const hint = (service as any).getHintForProperty(prop);

      expect(hint).toBe('Number between 1-5');
    });

    it('should generate hint for ForeignKeyName', () => {
      const prop = createMockProperty({
        type: EntityPropertyType.ForeignKeyName,
        display_name: 'Status'
      });

      const hint = (service as any).getHintForProperty(prop);

      expect(hint).toBe('Select from "Status Options" sheet or use ID');
    });

    it('should generate hint for Date', () => {
      const prop = createMockProperty({
        type: EntityPropertyType.Date
      });

      const hint = (service as any).getHintForProperty(prop);

      expect(hint).toBe('Format: YYYY-MM-DD');
    });

    it('should generate hint for Boolean', () => {
      const prop = createMockProperty({
        type: EntityPropertyType.Boolean
      });

      const hint = (service as any).getHintForProperty(prop);

      expect(hint).toBe('Enter: true/false or yes/no');
    });

    it('should generate hint for GeoPoint', () => {
      const prop = createMockProperty({
        type: EntityPropertyType.GeoPoint
      });

      const hint = (service as any).getHintForProperty(prop);

      expect(hint).toBe('Format: latitude,longitude (e.g., 42.3601,-71.0589)');
    });

    it('should generate hint for Color', () => {
      const prop = createMockProperty({
        type: EntityPropertyType.Color
      });

      const hint = (service as any).getHintForProperty(prop);

      expect(hint).toBe('Format: #RRGGBB (e.g., #3B82F6)');
    });
  });

  describe('transformForExport() - Direct Method Tests', () => {
    it('should transform data with display names as keys', () => {
      const data = [
        { id: 1, title: 'Test Issue', status_id: 2 }
      ];

      const properties = [
        createMockProperty({
          column_name: 'id',
          display_name: 'ID',
          type: EntityPropertyType.IntegerNumber
        }),
        createMockProperty({
          column_name: 'title',
          display_name: 'Title',
          type: EntityPropertyType.TextShort
        })
      ];

      const result = (service as any).transformForExport(data, properties);

      expect(result[0]['ID']).toBe(1);
      expect(result[0]['Title']).toBe('Test Issue');
    });

    it('should add dual columns for FK fields (ID + Name)', () => {
      const data = [
        {
          id: 1,
          title: 'Test',
          status_id: { id: 2, display_name: 'Open' }
        }
      ];

      const properties = [
        createMockProperty({
          column_name: 'status_id',
          display_name: 'Status',
          type: EntityPropertyType.ForeignKeyName
        })
      ];

      const result = (service as any).transformForExport(data, properties);

      expect(result[0]['Status']).toBe(2);
      expect(result[0]['Status (Name)']).toBe('Open');
    });

    it('should convert GeoPoint WKT to lat,lng format', () => {
      const data = [
        { id: 1, location: 'POINT(-71.0589 42.3601)' }
      ];

      const properties = [
        createMockProperty({
          column_name: 'location',
          display_name: 'Location',
          type: EntityPropertyType.GeoPoint
        })
      ];

      const result = (service as any).transformForExport(data, properties);

      expect(result[0]['Location']).toBe('42.3601,-71.0589');
    });

    it('should handle null GeoPoint values', () => {
      const data = [
        { id: 1, location: null }
      ];

      const properties = [
        createMockProperty({
          column_name: 'location',
          display_name: 'Location',
          type: EntityPropertyType.GeoPoint
        })
      ];

      const result = (service as any).transformForExport(data, properties);

      expect(result[0]['Location']).toBeNull();
    });

    it('should handle empty data array', () => {
      const result = (service as any).transformForExport([], []);

      expect(result).toEqual([]);
    });
  });

  describe('downloadErrorReport()', () => {
    it('should be callable without errors', () => {
      const originalData = [
        { Title: 'Test', Status: 'Open' }
      ];

      const errorSummary: ValidationErrorSummary = {
        totalErrors: 1,
        errorsByType: new Map([['Required field', 1]]),
        errorsByColumn: new Map([['Title', 1]]),
        firstNErrors: [
          { row: 3, column: 'Title', value: '', error: 'Required field', errorType: 'Required' }
        ],
        allErrors: [
          { row: 3, column: 'Title', value: '', error: 'Required field', errorType: 'Required' }
        ]
      };

      // Should not throw
      expect(() => {
        service.downloadErrorReport(originalData, errorSummary);
      }).not.toThrow();
    });
  });

  describe('getTimestamp() - Direct Method Tests', () => {
    it('should generate timestamp in correct format', () => {
      const timestamp = (service as any).getTimestamp();

      // Format: YYYY-MM-DD_HHmmss
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}$/);
    });
  });
});
