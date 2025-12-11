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

      // Flexible format hint showing examples
      expect(hint).toContain('Date');
      expect(hint).toContain('2025-11-30');
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

    it('should prefer full_name over display_name for User columns', () => {
      const data = [
        {
          id: 1,
          assigned_to: {
            id: 'abc-123',
            display_name: 'jdoe',
            full_name: 'John Doe'
          }
        }
      ];

      const properties = [
        createMockProperty({
          column_name: 'assigned_to',
          display_name: 'Assigned To',
          type: EntityPropertyType.User
        })
      ];

      const result = (service as any).transformForExport(data, properties);

      expect(result[0]['Assigned To']).toBe('abc-123');
      expect(result[0]['Assigned To (Name)']).toBe('John Doe'); // full_name preferred
    });

    it('should fall back to display_name when full_name is null for User columns', () => {
      const data = [
        {
          id: 1,
          assigned_to: {
            id: 'abc-123',
            display_name: 'jdoe',
            full_name: null
          }
        }
      ];

      const properties = [
        createMockProperty({
          column_name: 'assigned_to',
          display_name: 'Assigned To',
          type: EntityPropertyType.User
        })
      ];

      const result = (service as any).transformForExport(data, properties);

      expect(result[0]['Assigned To (Name)']).toBe('jdoe'); // falls back to display_name
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

  /**
   * EntityPropertyType Enum Synchronization Tests
   *
   * These tests ensure the EntityPropertyType enum in entity.ts stays in sync with
   * the duplicated enum in import-validation.worker.ts.
   *
   * Web Workers run in isolated contexts and cannot import TypeScript enums, so
   * the worker has a manual copy. If someone adds a new type to EntityPropertyType
   * and forgets to update the worker, these tests will fail.
   *
   * When adding a new EntityPropertyType:
   * 1. Add it to src/app/interfaces/entity.ts (source of truth)
   * 2. Add it to src/app/workers/import-validation.worker.ts (worker copy)
   * 3. Update EXPECTED_WORKER_ENUM_VALUES below to match
   *
   * @see src/app/workers/import-validation.worker.ts
   */
  describe('EntityPropertyType Worker Sync', () => {
    /**
     * Expected values that MUST exist in both:
     * - EntityPropertyType enum (entity.ts)
     * - Worker's EntityPropertyType const (import-validation.worker.ts)
     *
     * UPDATE THIS when adding new property types!
     */
    const EXPECTED_WORKER_ENUM_VALUES: { [key: string]: number } = {
      Unknown: 0,
      TextShort: 1,
      TextLong: 2,
      Boolean: 3,
      Date: 4,
      DateTime: 5,
      DateTimeLocal: 6,
      Money: 7,
      IntegerNumber: 8,
      DecimalNumber: 9,
      ForeignKeyName: 10,
      User: 11,
      GeoPoint: 12,
      Color: 13,
      Email: 14,
      Telephone: 15,
      TimeSlot: 16,
      ManyToMany: 17,
      File: 18,
      FileImage: 19,
      FilePDF: 20,
      Payment: 21,
      Status: 22
    };

    it('should have matching enum keys', () => {
      const enumKeys = Object.keys(EntityPropertyType)
        .filter(key => isNaN(Number(key))); // Filter out reverse mappings

      const expectedKeys = Object.keys(EXPECTED_WORKER_ENUM_VALUES);

      expect(enumKeys.sort()).toEqual(expectedKeys.sort());
    });

    it('should have matching enum values', () => {
      const enumKeys = Object.keys(EntityPropertyType)
        .filter(key => isNaN(Number(key)));

      for (const key of enumKeys) {
        const enumValue = EntityPropertyType[key as keyof typeof EntityPropertyType];
        const expectedValue = EXPECTED_WORKER_ENUM_VALUES[key];

        expect(enumValue)
          .withContext(`EntityPropertyType.${key} should equal ${expectedValue} (worker expects this value)`)
          .toBe(expectedValue);
      }
    });

    it('should fail if a new type is added without updating worker', () => {
      // This test documents the expected count - update when adding types
      const enumKeys = Object.keys(EntityPropertyType)
        .filter(key => isNaN(Number(key)));

      expect(enumKeys.length)
        .withContext(
          'New EntityPropertyType detected! Update:\n' +
          '  1. import-validation.worker.ts\n' +
          '  2. EXPECTED_WORKER_ENUM_VALUES in this test'
        )
        .toBe(23); // Unknown(0) through Status(22) = 23 types
    });
  });

  /**
   * Excel Serial Date Conversion Tests
   *
   * These tests document the expected behavior for Excel serial date handling
   * in the import validation worker. Excel stores dates as floating-point numbers
   * representing days since January 1, 1900.
   *
   * IMPORTANT: When Excel formats a cell as a date/time, the xlsx library returns
   * the raw serial number (e.g., 45991.729166666664) instead of a string.
   * The worker must detect and convert these values correctly.
   *
   * @see src/app/workers/import-validation.worker.ts - excelSerialToDate()
   */
  describe('Excel Serial Date Format Documentation', () => {
    /**
     * Helper to convert Excel serial date to JavaScript Date.
     * This mirrors the worker's excelSerialToDate() function for testing.
     */
    function excelSerialToDate(serial: number): Date {
      const excelEpoch = new Date(Date.UTC(1899, 11, 30)); // Dec 30, 1899 (Excel day 0)
      const days = Math.floor(serial);
      const timeFraction = serial - days;
      const date = new Date(excelEpoch.getTime() + days * 24 * 60 * 60 * 1000);
      const timeMs = Math.round(timeFraction * 24 * 60 * 60 * 1000);
      date.setTime(date.getTime() + timeMs);
      return date;
    }

    /**
     * Helper to check if a string looks like an Excel serial date.
     * Mirrors the worker's isExcelSerialDate() function.
     */
    function isExcelSerialDate(value: string): boolean {
      const num = parseFloat(value);
      if (isNaN(num)) return false;
      if (!/^\d+(\.\d+)?$/.test(value.trim())) return false;
      return num >= 1 && num <= 100000;
    }

    describe('isExcelSerialDate() detection', () => {
      it('should detect valid Excel serial dates', () => {
        expect(isExcelSerialDate('45991.729166666664')).toBe(true); // Nov 30, 2025 5:30 PM
        expect(isExcelSerialDate('45991')).toBe(true); // Nov 30, 2025 midnight
        expect(isExcelSerialDate('44197')).toBe(true); // Jan 1, 2021
        expect(isExcelSerialDate('1')).toBe(true); // Jan 1, 1900
      });

      it('should reject non-serial date values', () => {
        expect(isExcelSerialDate('11/30/25 5:30PM')).toBe(false); // Date string
        expect(isExcelSerialDate('2025-11-30')).toBe(false); // ISO date
        expect(isExcelSerialDate('Nov 30, 2025')).toBe(false); // Natural language
        expect(isExcelSerialDate('hello')).toBe(false); // Text
        expect(isExcelSerialDate('')).toBe(false); // Empty
      });

      it('should reject out-of-range numbers', () => {
        expect(isExcelSerialDate('0')).toBe(false); // Before Excel epoch
        expect(isExcelSerialDate('-1')).toBe(false); // Negative
        expect(isExcelSerialDate('100001')).toBe(false); // Too far in future
      });
    });

    describe('excelSerialToDate() conversion', () => {
      it('should convert Nov 30, 2025 5:30 PM correctly', () => {
        // This is the exact value from the user's bug report
        const serial = 45991.729166666664;
        const date = excelSerialToDate(serial);

        // Should be Nov 30, 2025 at 5:30 PM UTC
        expect(date.getUTCFullYear()).toBe(2025);
        expect(date.getUTCMonth()).toBe(10); // November (0-indexed)
        expect(date.getUTCDate()).toBe(30);
        expect(date.getUTCHours()).toBe(17); // 5 PM
        expect(date.getUTCMinutes()).toBe(30);
      });

      it('should convert Nov 30, 2025 8:00 PM correctly', () => {
        // 8 PM = 20/24 = 0.833... of a day
        const serial = 45991 + (20 / 24);
        const date = excelSerialToDate(serial);

        expect(date.getUTCFullYear()).toBe(2025);
        expect(date.getUTCMonth()).toBe(10);
        expect(date.getUTCDate()).toBe(30);
        expect(date.getUTCHours()).toBe(20); // 8 PM
        expect(date.getUTCMinutes()).toBe(0);
      });

      it('should convert Jan 1, 2021 midnight correctly', () => {
        const serial = 44197; // Known reference date
        const date = excelSerialToDate(serial);

        expect(date.getUTCFullYear()).toBe(2021);
        expect(date.getUTCMonth()).toBe(0); // January
        expect(date.getUTCDate()).toBe(1);
        expect(date.getUTCHours()).toBe(0);
      });

      it('should handle dates near Excel epoch correctly', () => {
        // Serial 1 = Jan 1, 1900
        const date = excelSerialToDate(1);

        expect(date.getUTCFullYear()).toBe(1899);
        expect(date.getUTCMonth()).toBe(11); // December
        expect(date.getUTCDate()).toBe(31);
      });

      it('should preserve time ordering for TimeSlot validation', () => {
        // This was the core bug: start time appeared after end time due to parsing
        const startSerial = 45991.729166666664; // 5:30 PM
        const endSerial = 45991 + (20 / 24); // 8:00 PM

        const startDate = excelSerialToDate(startSerial);
        const endDate = excelSerialToDate(endSerial);

        // End should be AFTER start (this was failing before the fix)
        expect(endDate.getTime()).toBeGreaterThan(startDate.getTime());
      });
    });
  });

  /**
   * transformNotesForExport() Tests
   *
   * Tests for the notes export transformation added in v0.16.0.
   * Verifies that notes are properly formatted for Excel export.
   */
  describe('transformNotesForExport() - Direct Method Tests', () => {
    it('should transform notes with correct column names', () => {
      const notes = [
        {
          id: 1,
          entity_type: 'reservations',
          entity_id: '5',
          author_id: 'abc-123',
          author: { id: 'abc-123', display_name: 'jdoe', full_name: 'John Doe' },
          content: 'Test note content',
          note_type: 'note' as const,
          is_internal: true,
          created_at: '2025-01-15T10:30:00Z',
          updated_at: '2025-01-15T10:30:00Z'
        }
      ];

      const result = service.transformNotesForExport(notes);

      expect(result.length).toBe(1);
      expect(result[0]['Record ID']).toBe('5'); // Renamed from Entity ID
      expect(result[0]['Note ID']).toBe(1);
      expect(result[0]['Author']).toBe('John Doe'); // full_name preferred
      expect(result[0]['Type']).toBe('Note');
      expect(result[0]['Content']).toBe('Test note content');
    });

    it('should prefer full_name over display_name for author', () => {
      const notes = [
        {
          id: 1,
          entity_type: 'reservations',
          entity_id: '5',
          author_id: 'abc-123',
          author: { id: 'abc-123', display_name: 'jdoe', full_name: 'John Doe' },
          content: 'Test',
          note_type: 'note' as const,
          is_internal: true,
          created_at: '2025-01-15T10:30:00Z',
          updated_at: '2025-01-15T10:30:00Z'
        }
      ];

      const result = service.transformNotesForExport(notes);

      expect(result[0]['Author']).toBe('John Doe');
    });

    it('should fall back to display_name when full_name is null', () => {
      const notes = [
        {
          id: 1,
          entity_type: 'reservations',
          entity_id: '5',
          author_id: 'abc-123',
          author: { id: 'abc-123', display_name: 'jdoe', full_name: null },
          content: 'Test',
          note_type: 'note' as const,
          is_internal: true,
          created_at: '2025-01-15T10:30:00Z',
          updated_at: '2025-01-15T10:30:00Z'
        }
      ];

      const result = service.transformNotesForExport(notes);

      expect(result[0]['Author']).toBe('jdoe');
    });

    it('should show System for notes without author', () => {
      const notes = [
        {
          id: 1,
          entity_type: 'reservations',
          entity_id: '5',
          author_id: 'abc-123',
          author: undefined,
          content: 'System generated note',
          note_type: 'system' as const,
          is_internal: true,
          created_at: '2025-01-15T10:30:00Z',
          updated_at: '2025-01-15T10:30:00Z'
        }
      ];

      const result = service.transformNotesForExport(notes);

      expect(result[0]['Author']).toBe('System');
    });

    it('should label system notes as System type', () => {
      const notes = [
        {
          id: 1,
          entity_type: 'reservations',
          entity_id: '5',
          author_id: 'abc-123',
          author: { id: 'abc-123', display_name: 'system', full_name: null },
          content: 'Status changed',
          note_type: 'system' as const,
          is_internal: true,
          created_at: '2025-01-15T10:30:00Z',
          updated_at: '2025-01-15T10:30:00Z'
        }
      ];

      const result = service.transformNotesForExport(notes);

      expect(result[0]['Type']).toBe('System');
    });

    it('should strip markdown from content', () => {
      const notes = [
        {
          id: 1,
          entity_type: 'reservations',
          entity_id: '5',
          author_id: 'abc-123',
          author: { id: 'abc-123', display_name: 'jdoe', full_name: 'John Doe' },
          content: 'Status changed from **Pending** to **Approved**',
          note_type: 'system' as const,
          is_internal: true,
          created_at: '2025-01-15T10:30:00Z',
          updated_at: '2025-01-15T10:30:00Z'
        }
      ];

      const result = service.transformNotesForExport(notes);

      // stripMarkdown should remove ** formatting
      expect(result[0]['Content']).toBe('Status changed from Pending to Approved');
    });

    it('should handle empty notes array', () => {
      const result = service.transformNotesForExport([]);

      expect(result).toEqual([]);
    });
  });
});
