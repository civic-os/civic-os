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
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SchemaService } from './schema.service';
import { EntityPropertyType, SchemaEntityProperty, SchemaEntityTable } from '../interfaces/entity';
import { createMockEntity, createMockProperty, MOCK_PROPERTIES, MOCK_ENTITIES, expectPostgrestRequest } from '../testing';
import { environment } from '../../environments/environment';
import { Validators } from '@angular/forms';

describe('SchemaService', () => {
  let service: SchemaService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        SchemaService
      ]
    });
    service = TestBed.inject(SchemaService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify(); // Ensure no outstanding HTTP requests
  });

  describe('Basic Service Setup', () => {
    it('should be created', () => {
      expect(service).toBeTruthy();
    });
  });

  describe('getEntities()', () => {
    it('should fetch entities from PostgREST on first call', (done) => {
      const mockEntities: SchemaEntityTable[] = [
        MOCK_ENTITIES.issue,
        MOCK_ENTITIES.status
      ];

      service.getEntities().subscribe(entities => {
        expect(entities).toEqual(mockEntities);
        expect(entities.length).toBe(2);
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', mockEntities);
    });

    it('should cache entities and return from memory on subsequent calls', (done) => {
      const mockEntities: SchemaEntityTable[] = [MOCK_ENTITIES.issue];

      // First call - fetches from HTTP
      service.getEntities().subscribe(() => {
        // Second call - should return from cache without HTTP request
        service.getEntities().subscribe(cachedEntities => {
          expect(cachedEntities).toEqual(mockEntities);
          done();
        });
        // No HTTP request should be made for the second call
      });

      expectPostgrestRequest(httpMock, 'schema_entities', mockEntities);
    });
  });

  describe('getEntity()', () => {
    it('should return entity matching the key', (done) => {
      const mockEntities: SchemaEntityTable[] = [
        MOCK_ENTITIES.issue,
        MOCK_ENTITIES.status
      ];

      service.getEntity('Issue').subscribe(entity => {
        expect(entity).toBeDefined();
        expect(entity?.table_name).toBe('Issue');
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', mockEntities);
    });

    it('should return undefined for non-existent entity', (done) => {
      service.getEntity('NonExistent').subscribe(entity => {
        expect(entity).toBeUndefined();
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', []);
    });
  });

  describe('getProperties()', () => {
    it('should fetch properties from PostgREST', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ column_name: 'name', udt_name: 'varchar' }),
        createMockProperty({ column_name: 'count', udt_name: 'int4' })
      ];

      service.getProperties().subscribe(props => {
        expect(props.length).toBe(2);
        expect(props[0].column_name).toBe('name');
        // Should have type calculated
        expect(props[0].type).toBe(EntityPropertyType.TextShort);
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', []);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should cache properties on first call', (done) => {
      const mockProps = [MOCK_PROPERTIES.textShort];

      service.getProperties().subscribe(() => {
        service.getProperties().subscribe(cachedProps => {
          expect(cachedProps).toEqual(jasmine.arrayContaining([
            jasmine.objectContaining({ column_name: 'name' })
          ]));
          done();
        });
      });

      expectPostgrestRequest(httpMock, 'schema_entities', []);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });
  });

  describe('getPropertyType() - Type Detection Logic', () => {
    it('should detect TextShort for varchar', () => {
      const prop = createMockProperty({ udt_name: 'varchar' });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.TextShort);
    });

    it('should detect TextLong for text', () => {
      const prop = createMockProperty({ udt_name: 'text' });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.TextLong);
    });

    it('should detect Boolean for bool', () => {
      const prop = createMockProperty({ udt_name: 'bool' });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.Boolean);
    });

    it('should detect IntegerNumber for int4', () => {
      const prop = createMockProperty({ udt_name: 'int4', join_column: null as any });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.IntegerNumber);
    });

    it('should detect IntegerNumber for int8', () => {
      const prop = createMockProperty({ udt_name: 'int8', join_column: null as any });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.IntegerNumber);
    });

    it('should detect Money for money', () => {
      const prop = createMockProperty({ udt_name: 'money' });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.Money);
    });

    it('should detect Date for date', () => {
      const prop = createMockProperty({ udt_name: 'date' });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.Date);
    });

    it('should detect DateTime for timestamp', () => {
      const prop = createMockProperty({ udt_name: 'timestamp' });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.DateTime);
    });

    it('should detect DateTimeLocal for timestamptz', () => {
      const prop = createMockProperty({ udt_name: 'timestamptz' });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.DateTimeLocal);
    });

    it('should detect ForeignKeyName for int4 with join_column', () => {
      const prop = createMockProperty({
        udt_name: 'int4',
        join_column: 'id'
      });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.ForeignKeyName);
    });

    it('should detect ForeignKeyName for int8 with join_column', () => {
      const prop = createMockProperty({
        udt_name: 'int8',
        join_column: 'id'
      });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.ForeignKeyName);
    });

    it('should detect User for uuid with civic_os_users join_table', () => {
      const prop = createMockProperty({
        udt_name: 'uuid',
        join_table: 'civic_os_users'
      });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.User);
    });

    it('should detect GeoPoint for geography Point', () => {
      const prop = createMockProperty({
        udt_name: 'geography',
        geography_type: 'Point'
      });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.GeoPoint);
    });

    it('should detect Color for hex_color', () => {
      const prop = createMockProperty({ udt_name: 'hex_color' });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.Color);
    });

    it('should detect Email for email_address domain', () => {
      const prop = createMockProperty({ udt_name: 'email_address' });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.Email);
    });

    it('should detect Telephone for phone_number domain', () => {
      const prop = createMockProperty({ udt_name: 'phone_number' });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.Telephone);
    });

    it('should return Unknown for unrecognized types', () => {
      const prop = createMockProperty({ udt_name: 'unknown_type' });
      expect(service['getPropertyType'](prop)).toBe(EntityPropertyType.Unknown);
    });

    it('should prioritize ForeignKeyName over IntegerNumber', () => {
      // int4 alone should be IntegerNumber
      const intProp = createMockProperty({ udt_name: 'int4', join_column: null as any });
      expect(service['getPropertyType'](intProp)).toBe(EntityPropertyType.IntegerNumber);

      // int4 with join_column should be ForeignKeyName
      const fkProp = createMockProperty({ udt_name: 'int4', join_column: 'id' });
      expect(service['getPropertyType'](fkProp)).toBe(EntityPropertyType.ForeignKeyName);
    });

    it('should prioritize Color over TextShort', () => {
      // hex_color domain should be Color (even though it's based on varchar)
      const colorProp = createMockProperty({ udt_name: 'hex_color' });
      expect(service['getPropertyType'](colorProp)).toBe(EntityPropertyType.Color);

      // varchar alone should be TextShort
      const varcharProp = createMockProperty({ udt_name: 'varchar' });
      expect(service['getPropertyType'](varcharProp)).toBe(EntityPropertyType.TextShort);
    });
  });

  describe('propertyToSelectString() - PostgREST Query Building', () => {
    it('should return column_name for simple types', () => {
      expect(SchemaService.propertyToSelectString(MOCK_PROPERTIES.textShort))
        .toBe('name');
      expect(SchemaService.propertyToSelectString(MOCK_PROPERTIES.integer))
        .toBe('count');
      expect(SchemaService.propertyToSelectString(MOCK_PROPERTIES.boolean))
        .toBe('is_active');
    });

    it('should build embedded select for ForeignKeyName', () => {
      const result = SchemaService.propertyToSelectString(MOCK_PROPERTIES.foreignKey);
      expect(result).toBe('status_id:Status(id,display_name)');
    });

    it('should build special select for User type', () => {
      const result = SchemaService.propertyToSelectString(MOCK_PROPERTIES.user);
      expect(result).toBe('assigned_to:civic_os_users!assigned_to(id,display_name,full_name,phone,email)');
    });

    it('should build computed field select for GeoPoint', () => {
      const result = SchemaService.propertyToSelectString(MOCK_PROPERTIES.geoPoint);
      expect(result).toBe('location:location_text');
    });

    it('should handle properties without join_schema gracefully', () => {
      const prop = createMockProperty({
        type: EntityPropertyType.ForeignKeyName,
        column_name: 'status_id',
        join_schema: '',
        join_table: 'Status',
        join_column: 'id'
      });
      const result = SchemaService.propertyToSelectString(prop);
      // Should not build embedded select if join_schema is not 'public'
      expect(result).toBe('status_id');
    });
  });

  describe('propertyToSelectStringForEdit() - Edit Form Query Building', () => {
    it('should return column_name for ForeignKeyName types', () => {
      const result = SchemaService.propertyToSelectStringForEdit(MOCK_PROPERTIES.foreignKey);
      expect(result).toBe('status_id');
    });

    it('should return column_name for User types', () => {
      const result = SchemaService.propertyToSelectStringForEdit(MOCK_PROPERTIES.user);
      expect(result).toBe('assigned_to');
    });

    it('should return computed field select for GeoPoint', () => {
      const result = SchemaService.propertyToSelectStringForEdit(MOCK_PROPERTIES.geoPoint);
      expect(result).toBe('location:location_text');
    });

    it('should return column_name for simple types', () => {
      expect(SchemaService.propertyToSelectStringForEdit(MOCK_PROPERTIES.textShort))
        .toBe('name');
      expect(SchemaService.propertyToSelectStringForEdit(MOCK_PROPERTIES.integer))
        .toBe('count');
      expect(SchemaService.propertyToSelectStringForEdit(MOCK_PROPERTIES.boolean))
        .toBe('is_active');
    });
  });

  describe('getPropsForList()', () => {
    it('should filter out hidden fields based on show_on_list flag', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'id', udt_name: 'int4', show_on_list: false }),
        createMockProperty({ table_name: 'Issue', column_name: 'name', udt_name: 'varchar', show_on_list: true }),
        createMockProperty({ table_name: 'Issue', column_name: 'created_at', udt_name: 'timestamp', show_on_list: false }),
        createMockProperty({ table_name: 'Issue', column_name: 'updated_at', udt_name: 'timestamp', show_on_list: false })
      ];

      service.getPropsForList(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(1);
        expect(props[0].column_name).toBe('name');
        expect(props.find(p => p.column_name === 'id')).toBeUndefined();
        expect(props.find(p => p.column_name === 'created_at')).toBeUndefined();
        expect(props.find(p => p.column_name === 'updated_at')).toBeUndefined();
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should only return properties for the specified table', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'issue_name', udt_name: 'varchar' }),
        createMockProperty({ table_name: 'Status', column_name: 'status_name', udt_name: 'varchar' })
      ];

      service.getPropsForList(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(1);
        expect(props[0].column_name).toBe('issue_name');
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should include map property even if hidden from list when map is enabled', (done) => {
      const entityWithMap: SchemaEntityTable = {
        ...MOCK_ENTITIES.issue,
        show_map: true,
        map_property_name: 'location'
      };

      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'name', udt_name: 'varchar', show_on_list: true }),
        createMockProperty({
          table_name: 'Issue',
          column_name: 'location',
          udt_name: 'geography',
          geography_type: 'Point',
          show_on_list: false  // Hidden from list view
        })
      ];

      service.getPropsForList(entityWithMap).subscribe(props => {
        expect(props.length).toBe(2);
        expect(props.find(p => p.column_name === 'name')).toBeDefined();
        expect(props.find(p => p.column_name === 'location')).toBeDefined();
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', [entityWithMap]);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should not duplicate map property if already visible in list', (done) => {
      const entityWithMap: SchemaEntityTable = {
        ...MOCK_ENTITIES.issue,
        show_map: true,
        map_property_name: 'location'
      };

      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'name', udt_name: 'varchar', show_on_list: true }),
        createMockProperty({
          table_name: 'Issue',
          column_name: 'location',
          udt_name: 'geography',
          geography_type: 'Point',
          show_on_list: true  // Already visible
        })
      ];

      service.getPropsForList(entityWithMap).subscribe(props => {
        expect(props.length).toBe(2);
        expect(props.filter(p => p.column_name === 'location').length).toBe(1);
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', [entityWithMap]);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });
  });

  describe('getPropsForCreate()', () => {
    it('should filter out generated and identity columns', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'id', is_identity: true }),
        createMockProperty({ table_name: 'Issue', column_name: 'name', is_updatable: true }),
        createMockProperty({ table_name: 'Issue', column_name: 'computed', is_generated: true })
      ];

      service.getPropsForCreate(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(1);
        expect(props[0].column_name).toBe('name');
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should filter out non-updatable columns', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'name', is_updatable: true }),
        createMockProperty({ table_name: 'Issue', column_name: 'readonly', is_updatable: false })
      ];

      service.getPropsForCreate(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(1);
        expect(props[0].column_name).toBe('name');
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should filter out hidden fields (id, created_at, updated_at)', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'name', is_updatable: true }),
        createMockProperty({ table_name: 'Issue', column_name: 'created_at', is_updatable: false }),
        createMockProperty({ table_name: 'Issue', column_name: 'updated_at', is_updatable: false })
      ];

      service.getPropsForCreate(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(1);
        expect(props[0].column_name).toBe('name');
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should filter based on show_on_create flag', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'name', udt_name: 'varchar', is_updatable: true, show_on_create: true }),
        createMockProperty({ table_name: 'Issue', column_name: 'internal_notes', udt_name: 'text', is_updatable: true, show_on_create: false }),
        createMockProperty({ table_name: 'Issue', column_name: 'status', udt_name: 'varchar', is_updatable: true, show_on_create: true })
      ];

      service.getPropsForCreate(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(2);
        expect(props[0].column_name).toBe('name');
        expect(props[1].column_name).toBe('status');
        expect(props.find(p => p.column_name === 'internal_notes')).toBeUndefined();
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });
  });

  describe('getPropsForEdit()', () => {
    it('should use same logic as getPropsForCreate', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'name', is_updatable: true }),
        createMockProperty({ table_name: 'Issue', column_name: 'id', is_identity: true })
      ];

      service.getPropsForEdit(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(1);
        expect(props[0].column_name).toBe('name');
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should filter based on show_on_edit flag', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'title', udt_name: 'varchar', is_updatable: true, show_on_edit: true }),
        createMockProperty({ table_name: 'Issue', column_name: 'calculated_field', udt_name: 'varchar', is_updatable: true, show_on_edit: false }),
        createMockProperty({ table_name: 'Issue', column_name: 'description', udt_name: 'text', is_updatable: true, show_on_edit: true })
      ];

      service.getPropsForEdit(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(2);
        expect(props[0].column_name).toBe('title');
        expect(props[1].column_name).toBe('description');
        expect(props.find(p => p.column_name === 'calculated_field')).toBeUndefined();
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });
  });

  describe('Property Sorting', () => {
    describe('getPropsForList()', () => {
      it('should return properties sorted by sort_order', (done) => {
        const mockProps: SchemaEntityProperty[] = [
          createMockProperty({ table_name: 'Issue', column_name: 'name', sort_order: 2 }),
          createMockProperty({ table_name: 'Issue', column_name: 'status', sort_order: 0 }),
          createMockProperty({ table_name: 'Issue', column_name: 'count', sort_order: 1 })
        ];

        service.getPropsForList(MOCK_ENTITIES.issue).subscribe(props => {
          expect(props.length).toBe(3);
          expect(props[0].column_name).toBe('status');  // sort_order: 0
          expect(props[1].column_name).toBe('count');   // sort_order: 1
          expect(props[2].column_name).toBe('name');    // sort_order: 2
          done();
        });

        expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
        expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
      });
    });

    describe('getPropsForDetail()', () => {
      it('should return properties sorted by sort_order', (done) => {
        const mockProps: SchemaEntityProperty[] = [
          createMockProperty({ table_name: 'Issue', column_name: 'description', sort_order: 5 }),
          createMockProperty({ table_name: 'Issue', column_name: 'title', sort_order: 3 })
        ];

        service.getPropsForDetail(MOCK_ENTITIES.issue).subscribe(props => {
          expect(props[0].column_name).toBe('title');       // sort_order: 3
          expect(props[1].column_name).toBe('description'); // sort_order: 5
          done();
        });

        expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
        expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
      });

      it('should filter based on show_on_detail flag', (done) => {
        const mockProps: SchemaEntityProperty[] = [
          createMockProperty({ table_name: 'Issue', column_name: 'title', udt_name: 'varchar', show_on_detail: true }),
          createMockProperty({ table_name: 'Issue', column_name: 'internal_id', udt_name: 'int4', show_on_detail: false }),
          createMockProperty({ table_name: 'Issue', column_name: 'created_at', udt_name: 'timestamptz', show_on_detail: true }),
          createMockProperty({ table_name: 'Issue', column_name: 'updated_at', udt_name: 'timestamptz', show_on_detail: true })
        ];

        service.getPropsForDetail(MOCK_ENTITIES.issue).subscribe(props => {
          expect(props.length).toBe(3);
          expect(props.find(p => p.column_name === 'title')).toBeDefined();
          expect(props.find(p => p.column_name === 'created_at')).toBeDefined();
          expect(props.find(p => p.column_name === 'updated_at')).toBeDefined();
          expect(props.find(p => p.column_name === 'internal_id')).toBeUndefined();
          done();
        });

        expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
        expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
      });
    });

    describe('getPropsForCreate()', () => {
      it('should return properties sorted by sort_order', (done) => {
        const mockProps: SchemaEntityProperty[] = [
          createMockProperty({ table_name: 'Issue', column_name: 'field_a', sort_order: 10, is_updatable: true }),
          createMockProperty({ table_name: 'Issue', column_name: 'field_b', sort_order: 5, is_updatable: true }),
          createMockProperty({ table_name: 'Issue', column_name: 'field_c', sort_order: 7, is_updatable: true })
        ];

        service.getPropsForCreate(MOCK_ENTITIES.issue).subscribe(props => {
          expect(props[0].column_name).toBe('field_b');  // sort_order: 5
          expect(props[1].column_name).toBe('field_c');  // sort_order: 7
          expect(props[2].column_name).toBe('field_a');  // sort_order: 10
          done();
        });

        expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
        expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
      });
    });

    describe('getPropsForEdit()', () => {
      it('should return properties sorted by sort_order (inherits from getPropsForCreate)', (done) => {
        const mockProps: SchemaEntityProperty[] = [
          createMockProperty({ table_name: 'Issue', column_name: 'last', sort_order: 99, is_updatable: true }),
          createMockProperty({ table_name: 'Issue', column_name: 'first', sort_order: 1, is_updatable: true })
        ];

        service.getPropsForEdit(MOCK_ENTITIES.issue).subscribe(props => {
          expect(props[0].column_name).toBe('first');  // sort_order: 1
          expect(props[1].column_name).toBe('last');   // sort_order: 99
          done();
        });

        expectPostgrestRequest(httpMock, 'schema_entities', [MOCK_ENTITIES.issue]);
        expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
      });
    });
  });

  describe('getFormValidatorsForProperty()', () => {
    it('should add required validator for non-nullable columns', () => {
      const prop = createMockProperty({ is_nullable: false });
      const validators = SchemaService.getFormValidatorsForProperty(prop);

      expect(validators.length).toBe(1);
      expect(validators).toContain(Validators.required);
    });

    it('should not add validators for nullable columns', () => {
      const prop = createMockProperty({ is_nullable: true });
      const validators = SchemaService.getFormValidatorsForProperty(prop);

      expect(validators.length).toBe(0);
    });
  });

  describe('getDefaultValueForProperty()', () => {
    it('should return false for Boolean type', () => {
      const result = SchemaService.getDefaultValueForProperty(MOCK_PROPERTIES.boolean);
      expect(result).toBe(false);
    });

    it('should return null for all other types', () => {
      expect(SchemaService.getDefaultValueForProperty(MOCK_PROPERTIES.textShort)).toBeNull();
      expect(SchemaService.getDefaultValueForProperty(MOCK_PROPERTIES.integer)).toBeNull();
      expect(SchemaService.getDefaultValueForProperty(MOCK_PROPERTIES.foreignKey)).toBeNull();
      expect(SchemaService.getDefaultValueForProperty(MOCK_PROPERTIES.geoPoint)).toBeNull();
    });
  });

  describe('getColumnSpan()', () => {
    it('should return custom column_width when set', () => {
      const property = createMockProperty({ column_width: 4 });
      expect(SchemaService.getColumnSpan(property)).toBe(4);
    });

    it('should return 2 for TextLong type', () => {
      const property = createMockProperty({
        type: EntityPropertyType.TextLong,
        column_width: undefined
      });
      expect(SchemaService.getColumnSpan(property)).toBe(2);
    });

    it('should return 2 for GeoPoint type', () => {
      const property = createMockProperty({
        type: EntityPropertyType.GeoPoint,
        column_width: undefined
      });
      expect(SchemaService.getColumnSpan(property)).toBe(2);
    });

    it('should return 1 for other types by default', () => {
      const property = createMockProperty({
        type: EntityPropertyType.TextShort,
        column_width: undefined
      });
      expect(SchemaService.getColumnSpan(property)).toBe(1);
    });

    it('should prefer custom column_width over type defaults', () => {
      const property = createMockProperty({
        type: EntityPropertyType.TextLong,
        column_width: 3
      });
      expect(SchemaService.getColumnSpan(property)).toBe(3);
    });
  });

  describe('getPropertiesForEntityFresh()', () => {
    it('should fetch fresh properties from PostgREST, bypassing cache', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'title', udt_name: 'varchar' }),
        createMockProperty({ table_name: 'Issue', column_name: 'description', udt_name: 'text' })
      ];

      service.getPropertiesForEntityFresh(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(2);
        expect(props[0].column_name).toBe('title');
        expect(props[0].type).toBe(EntityPropertyType.TextShort);
        expect(props[1].type).toBe(EntityPropertyType.TextLong);
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should filter properties by table name', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'title', udt_name: 'varchar' }),
        createMockProperty({ table_name: 'Status', column_name: 'name', udt_name: 'varchar' })
      ];

      service.getPropertiesForEntityFresh(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(1);
        expect(props[0].table_name).toBe('Issue');
        expect(props[0].column_name).toBe('title');
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should make HTTP request every time (not use cache)', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'title', udt_name: 'varchar' })
      ];

      // First call
      service.getPropertiesForEntityFresh(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(1);

        // Second call - should make another HTTP request
        service.getPropertiesForEntityFresh(MOCK_ENTITIES.issue).subscribe(props2 => {
          expect(props2.length).toBe(1);
          done();
        });

        // Expect second HTTP request
        expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
      });

      // Expect first HTTP request
      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should return empty array for entity with no properties', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'OtherTable', column_name: 'name', udt_name: 'varchar' })
      ];

      service.getPropertiesForEntityFresh(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props.length).toBe(0);
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });

    it('should calculate property types for all properties', (done) => {
      const mockProps: SchemaEntityProperty[] = [
        createMockProperty({ table_name: 'Issue', column_name: 'name', udt_name: 'varchar' }),
        createMockProperty({ table_name: 'Issue', column_name: 'count', udt_name: 'int4', join_column: null as any }),
        createMockProperty({ table_name: 'Issue', column_name: 'active', udt_name: 'bool' })
      ];

      service.getPropertiesForEntityFresh(MOCK_ENTITIES.issue).subscribe(props => {
        expect(props[0].type).toBe(EntityPropertyType.TextShort);
        expect(props[1].type).toBe(EntityPropertyType.IntegerNumber);
        expect(props[2].type).toBe(EntityPropertyType.Boolean);
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_properties', mockProps);
    });
  });

  describe('refreshCache()', () => {
    it('should trigger background refresh of schema and properties', () => {
      service.refreshCache();

      // refreshCache() calls getSchema(), getProperties(), and getConstraintMessages()
      // getProperties() internally calls getEntities() which may trigger another getSchema()
      // So we may get 2 schema_entities requests (race condition), 1 schema_properties request, and 1 constraint_messages request
      const requests = httpMock.match(req => req.url.includes('schema_entities'));
      const propsReq = httpMock.expectOne(req => req.url.includes('schema_properties'));
      const constraintMsgsReq = httpMock.expectOne(req => req.url.includes('constraint_messages'));

      // Flush all requests
      requests.forEach(req => req.flush([]));
      propsReq.flush([]);
      constraintMsgsReq.flush([]);
    });
  });

  describe('refreshEntitiesCache()', () => {
    it('should trigger background refresh of schema entities only', () => {
      service.refreshEntitiesCache();

      // refreshEntitiesCache() only calls getSchema()
      const req = httpMock.expectOne(req => req.url.includes('schema_entities'));
      req.flush([]);

      // Should NOT make properties request
      httpMock.expectNone(req => req.url.includes('schema_properties'));
    });
  });

  describe('refreshPropertiesCache()', () => {
    it('should clear properties cache and trigger refresh', () => {
      service.refreshPropertiesCache();

      // refreshPropertiesCache() calls getProperties()
      // which internally calls getEntities()
      const entitiesReq = httpMock.expectOne(req => req.url.includes('schema_entities'));
      const propsReq = httpMock.expectOne(req => req.url.includes('schema_properties'));

      entitiesReq.flush([]);
      propsReq.flush([]);
    });
  });

  describe('In-Flight Request Tracking', () => {
    it('should prevent concurrent getEntities() calls from triggering duplicate HTTP requests', () => {
      const mockEntities = [MOCK_ENTITIES.issue, MOCK_ENTITIES.status];

      // Simulate 3 components all calling getEntities() simultaneously
      const sub1 = service.getEntities().subscribe();
      const sub2 = service.getEntities().subscribe();
      const sub3 = service.getEntities().subscribe();

      // Should only make ONE HTTP request despite 3 subscriptions
      const requests = httpMock.match(req => req.url.includes('schema_entities'));
      expect(requests.length).toBe(1);

      // Flush the single request
      requests[0].flush(mockEntities);

      // All subscribers should receive the data
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
    });

    it('should prevent concurrent getProperties() calls from triggering duplicate HTTP requests', () => {
      const mockEntities = [MOCK_ENTITIES.issue];
      const mockProperties = [MOCK_PROPERTIES.textShort, MOCK_PROPERTIES.integer];

      // First ensure entities are loaded (getProperties depends on getEntities)
      service.getEntities().subscribe();
      const entitiesReq = httpMock.expectOne(req => req.url.includes('schema_entities'));
      entitiesReq.flush(mockEntities);

      // Now simulate 3 components calling getProperties() simultaneously
      const sub1 = service.getProperties().subscribe();
      const sub2 = service.getProperties().subscribe();
      const sub3 = service.getProperties().subscribe();

      // Should only make ONE HTTP request for properties despite 3 subscriptions
      const requests = httpMock.match(req => req.url.includes('schema_properties'));
      expect(requests.length).toBe(1);

      // Flush the single request
      requests[0].flush(mockProperties);

      // All subscribers should receive the processed data
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
    });

    it('should allow refreshCache() to trigger new requests after initial load completes', () => {
      const mockEntities = [MOCK_ENTITIES.issue];
      const mockProperties = [MOCK_PROPERTIES.textShort];
      const mockConstraintMessages: any[] = [];

      // Initial load
      service.getEntities().subscribe();
      const req1 = httpMock.expectOne(req => req.url.includes('schema_entities'));
      req1.flush(mockEntities);

      // Refresh cache
      service.refreshCache();

      // Should make new requests (cache was cleared) - entities, properties, AND constraint_messages
      const requests = httpMock.match(req =>
        req.url.includes('schema_entities') ||
        req.url.includes('schema_properties') ||
        req.url.includes('constraint_messages')
      );
      expect(requests.length).toBe(3); // All three caches should refetch

      // Flush all requests
      requests.forEach(req => {
        if (req.request.url.includes('schema_entities')) {
          req.flush(mockEntities);
        } else if (req.request.url.includes('schema_properties')) {
          req.flush(mockProperties);
        } else if (req.request.url.includes('constraint_messages')) {
          req.flush(mockConstraintMessages);
        }
      });
    });
  });

  describe('Many-to-Many Detection', () => {
    it('should detect junction table with exactly 2 FKs and only metadata columns', () => {
      const tables = [createMockEntity({ table_name: 'issue_tags' })];
      const junctionProps = [
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'issue_id',
          udt_name: 'int8',
          join_schema: 'public',
          join_table: 'Issue',
          join_column: 'id',
          type: EntityPropertyType.ForeignKeyName
        }),
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'tag_id',
          udt_name: 'int4',
          join_schema: 'public',
          join_table: 'tags',
          join_column: 'id',
          type: EntityPropertyType.ForeignKeyName
        }),
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'created_at',
          udt_name: 'timestamptz',
          is_generated: true,
          is_updatable: false,
          type: EntityPropertyType.DateTimeLocal
        })
      ];

      const result = (service as any).detectJunctionTables(tables, junctionProps);
      // Should detect issue_tags as a junction table (returns M:M metadata for both sides)
      expect(result.size).toBeGreaterThan(0);
      expect(result.has('Issue') || result.has('tags')).toBe(true);
    });

    it('should not detect junction table with only 1 FK', () => {
      const tables = [createMockEntity({ table_name: 'Issue' })];
      const props = [
        createMockProperty({
          table_name: 'Issue',
          column_name: 'status_id',
          udt_name: 'int4',
          join_schema: 'public',
          join_table: 'statuses',
          join_column: 'id',
          type: EntityPropertyType.ForeignKeyName
        }),
        createMockProperty({
          table_name: 'Issue',
          column_name: 'name',
          udt_name: 'varchar',
          type: EntityPropertyType.TextShort
        })
      ];

      const result = (service as any).detectJunctionTables(tables, props);
      // Should not detect Issue as a junction table (only 1 FK)
      expect(result.size).toBe(0);
    });

    it('should not detect junction table with 3+ FKs', () => {
      const tables = [createMockEntity({ table_name: 'assignment' })];
      const props = [
        createMockProperty({
          table_name: 'assignment',
          column_name: 'user_id',
          udt_name: 'uuid',
          join_schema: 'public',
          join_table: 'civic_os_users',
          join_column: 'id',
          type: EntityPropertyType.User
        }),
        createMockProperty({
          table_name: 'assignment',
          column_name: 'role_id',
          udt_name: 'int4',
          join_schema: 'public',
          join_table: 'roles',
          join_column: 'id',
          type: EntityPropertyType.ForeignKeyName
        }),
        createMockProperty({
          table_name: 'assignment',
          column_name: 'granted_by',
          udt_name: 'uuid',
          join_schema: 'public',
          join_table: 'civic_os_users',
          join_column: 'id',
          type: EntityPropertyType.User
        })
      ];

      const result = (service as any).detectJunctionTables(tables, props);
      // Should not detect assignment as a junction table (3 FKs)
      expect(result.size).toBe(0);
    });

    it('should detect junction table with 2 public FKs despite having metadata schema FK (cross-schema bug fix)', () => {
      // Regression test for v0.8.2 fix: schema_relations_func() was incorrectly matching FKs
      // across schemas when table names collided (e.g., public.projects vs metadata.projects).
      // This caused junction tables to have 3+ FKs (2 public + 1 phantom metadata), breaking detection.
      const tables = [createMockEntity({ table_name: 'project_broader_impact_categories' })];
      const props = [
        // Valid public schema FK #1
        createMockProperty({
          table_name: 'project_broader_impact_categories',
          column_name: 'project_id',
          udt_name: 'int4',
          join_schema: 'public',
          join_table: 'projects',
          join_column: 'id',
          type: EntityPropertyType.ForeignKeyName
        }),
        // Valid public schema FK #2
        createMockProperty({
          table_name: 'project_broader_impact_categories',
          column_name: 'broader_impact_category_id',
          udt_name: 'int4',
          join_schema: 'public',
          join_table: 'broader_impact_categories',
          join_column: 'id',
          type: EntityPropertyType.ForeignKeyName
        }),
        // Phantom metadata schema FK (should be filtered out by detectJunctionTables)
        // This simulates the bug where schema_relations_func() incorrectly matched metadata.projects.project
        createMockProperty({
          table_name: 'project_broader_impact_categories',
          column_name: 'project_id',
          udt_name: 'int4',
          join_schema: 'metadata',  // Wrong schema!
          join_table: 'projects',
          join_column: 'project',
          type: EntityPropertyType.ForeignKeyName
        }),
        // Metadata column (required for junction detection)
        createMockProperty({
          table_name: 'project_broader_impact_categories',
          column_name: 'created_at',
          udt_name: 'timestamptz',
          is_generated: true,
          is_updatable: false,
          type: EntityPropertyType.DateTimeLocal
        })
      ];

      const result = (service as any).detectJunctionTables(tables, props);
      // Should detect as junction table (only counts 2 public schema FKs, ignores metadata FK)
      expect(result.size).toBeGreaterThan(0);
      expect(result.has('projects') || result.has('broader_impact_categories')).toBe(true);
    });

    it('should not detect junction table with extra business columns', () => {
      const tables = [createMockEntity({ table_name: 'user_roles' })];
      const props = [
        createMockProperty({
          table_name: 'user_roles',
          column_name: 'user_id',
          udt_name: 'uuid',
          join_schema: 'public',
          join_table: 'civic_os_users',
          join_column: 'id',
          type: EntityPropertyType.User
        }),
        createMockProperty({
          table_name: 'user_roles',
          column_name: 'role_id',
          udt_name: 'int4',
          join_schema: 'public',
          join_table: 'roles',
          join_column: 'id',
          type: EntityPropertyType.ForeignKeyName
        }),
        createMockProperty({
          table_name: 'user_roles',
          column_name: 'notes',
          udt_name: 'text',
          type: EntityPropertyType.TextLong
        }),
        createMockProperty({
          table_name: 'user_roles',
          column_name: 'granted_at',
          udt_name: 'timestamptz',
          type: EntityPropertyType.DateTimeLocal
        })
      ];

      const result = (service as any).detectJunctionTables(tables, props);
      // Should not detect user_roles as a junction table (has extra business columns)
      expect(result.size).toBe(0);
    });

    it('should accept id column as metadata (for backwards compatibility)', () => {
      const tables = [createMockEntity({ table_name: 'issue_tags' })];
      const props = [
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'id',
          udt_name: 'int4',
          is_identity: true,
          type: EntityPropertyType.IntegerNumber
        }),
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'issue_id',
          udt_name: 'int8',
          join_schema: 'public',
          join_table: 'Issue',
          join_column: 'id',
          type: EntityPropertyType.ForeignKeyName
        }),
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'tag_id',
          udt_name: 'int4',
          join_schema: 'public',
          join_table: 'tags',
          join_column: 'id',
          type: EntityPropertyType.ForeignKeyName
        })
      ];

      const result = (service as any).detectJunctionTables(tables, props);
      // Should detect issue_tags as a junction table (id column is allowed metadata)
      expect(result.size).toBeGreaterThan(0);
      expect(result.has('Issue') || result.has('tags')).toBe(true);
    });

    it('should generate ManyToMany property for each side of relationship', (done) => {
      const entities: SchemaEntityTable[] = [
        createMockEntity({ table_name: 'Issue', display_name: 'Issues' }),
        createMockEntity({ table_name: 'tags', display_name: 'Tags' }),
        createMockEntity({ table_name: 'issue_tags', display_name: 'Issue Tags' })
      ];

      const issueProps = [
        createMockProperty({ table_name: 'Issue', column_name: 'id', udt_name: 'int8' }),
        createMockProperty({ table_name: 'Issue', column_name: 'display_name', udt_name: 'varchar' })
      ];

      const tagProps = [
        createMockProperty({ table_name: 'tags', column_name: 'id', udt_name: 'int4' }),
        createMockProperty({ table_name: 'tags', column_name: 'display_name', udt_name: 'varchar' }),
        createMockProperty({ table_name: 'tags', column_name: 'color', udt_name: 'varchar' })
      ];

      const junctionProps = [
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'issue_id',
          udt_name: 'int8',
          join_schema: 'public',
          join_table: 'Issue',
          join_column: 'id'
        }),
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'tag_id',
          udt_name: 'int4',
          join_schema: 'public',
          join_table: 'tags',
          join_column: 'id'
        }),
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'created_at',
          udt_name: 'timestamptz',
          is_generated: true
        })
      ];

      const allProps = [...issueProps, ...tagProps, ...junctionProps];

      // Call getPropertiesForEntity for Issue (triggers M:M enrichment)
      service.getPropertiesForEntity(entities[0]).subscribe(props => {
        // Find the M:M property
        const m2mProp = props.find(p => p.type === EntityPropertyType.ManyToMany);

        expect(m2mProp).toBeDefined();
        expect(m2mProp?.column_name).toBe('issue_tags_m2m');
        expect(m2mProp?.display_name).toBe('Tags');
        expect(m2mProp?.many_to_many_meta).toBeDefined();
        expect(m2mProp?.many_to_many_meta?.junctionTable).toBe('issue_tags');
        expect(m2mProp?.many_to_many_meta?.sourceTable).toBe('Issue');
        expect(m2mProp?.many_to_many_meta?.targetTable).toBe('tags');
        expect(m2mProp?.many_to_many_meta?.sourceColumn).toBe('issue_id');
        expect(m2mProp?.many_to_many_meta?.targetColumn).toBe('tag_id');
        expect(m2mProp?.many_to_many_meta?.relatedTableHasColor).toBe(true);

        done();
      });

      expectPostgrestRequest(httpMock, 'schema_properties', allProps);
      expectPostgrestRequest(httpMock, 'schema_entities', entities);
    });

    it('should generate bidirectional M:M properties', (done) => {
      const entities: SchemaEntityTable[] = [
        createMockEntity({ table_name: 'Issue', display_name: 'Issues' }),
        createMockEntity({ table_name: 'tags', display_name: 'Tags' }),
        createMockEntity({ table_name: 'issue_tags', display_name: 'Issue Tags' })
      ];

      const allProps = [
        createMockProperty({ table_name: 'Issue', column_name: 'id', udt_name: 'int8' }),
        createMockProperty({ table_name: 'tags', column_name: 'id', udt_name: 'int4' }),
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'issue_id',
          udt_name: 'int8',
          join_schema: 'public',
          join_table: 'Issue',
          join_column: 'id'
        }),
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'tag_id',
          udt_name: 'int4',
          join_schema: 'public',
          join_table: 'tags',
          join_column: 'id'
        })
      ];

      // Get properties for tags table (triggers M:M enrichment)
      service.getPropertiesForEntity(entities[1]).subscribe(props => {
        const m2mProp = props.find(p => p.type === EntityPropertyType.ManyToMany);

        expect(m2mProp).toBeDefined();
        expect(m2mProp?.column_name).toBe('issue_tags_m2m');
        expect(m2mProp?.display_name).toBe('Issues');
        expect(m2mProp?.many_to_many_meta?.junctionTable).toBe('issue_tags');
        expect(m2mProp?.many_to_many_meta?.sourceTable).toBe('tags');
        expect(m2mProp?.many_to_many_meta?.targetTable).toBe('Issue');
        expect(m2mProp?.many_to_many_meta?.sourceColumn).toBe('tag_id');
        expect(m2mProp?.many_to_many_meta?.targetColumn).toBe('issue_id');

        done();
      });

      expectPostgrestRequest(httpMock, 'schema_properties', allProps);
      expectPostgrestRequest(httpMock, 'schema_entities', entities);
    });

    it('should set relatedTableHasColor=true when related table has color column', (done) => {
      const entities: SchemaEntityTable[] = [
        createMockEntity({ table_name: 'Issue', display_name: 'Issues' }),
        createMockEntity({ table_name: 'tags', display_name: 'Tags' }),
        createMockEntity({ table_name: 'issue_tags', display_name: 'Issue Tags' })
      ];

      const allProps = [
        createMockProperty({ table_name: 'Issue', column_name: 'id', udt_name: 'int8' }),
        createMockProperty({ table_name: 'tags', column_name: 'id', udt_name: 'int4' }),
        createMockProperty({ table_name: 'tags', column_name: 'color', udt_name: 'varchar' }),
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'issue_id',
          udt_name: 'int8',
          join_schema: 'public',
          join_table: 'Issue',
          join_column: 'id'
        }),
        createMockProperty({
          table_name: 'issue_tags',
          column_name: 'tag_id',
          udt_name: 'int4',
          join_schema: 'public',
          join_table: 'tags',
          join_column: 'id'
        })
      ];

      service.getPropertiesForEntity(entities[0]).subscribe(props => {
        const m2mProp = props.find(p => p.type === EntityPropertyType.ManyToMany);
        expect(m2mProp?.many_to_many_meta?.relatedTableHasColor).toBe(true);
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_properties', allProps);
      expectPostgrestRequest(httpMock, 'schema_entities', entities);
    });

    it('should set relatedTableHasColor=false when related table has no color column', (done) => {
      const entities: SchemaEntityTable[] = [
        createMockEntity({ table_name: 'Issue', display_name: 'Issues' }),
        createMockEntity({ table_name: 'categories', display_name: 'Categories' }),
        createMockEntity({ table_name: 'issue_categories', display_name: 'Issue Categories' })
      ];

      const allProps = [
        createMockProperty({ table_name: 'Issue', column_name: 'id', udt_name: 'int8' }),
        createMockProperty({ table_name: 'categories', column_name: 'id', udt_name: 'int4' }),
        createMockProperty({
          table_name: 'issue_categories',
          column_name: 'issue_id',
          udt_name: 'int8',
          join_schema: 'public',
          join_table: 'Issue',
          join_column: 'id'
        }),
        createMockProperty({
          table_name: 'issue_categories',
          column_name: 'category_id',
          udt_name: 'int4',
          join_schema: 'public',
          join_table: 'categories',
          join_column: 'id'
        })
      ];

      service.getPropertiesForEntity(entities[0]).subscribe(props => {
        const m2mProp = props.find(p => p.type === EntityPropertyType.ManyToMany);
        expect(m2mProp?.many_to_many_meta?.relatedTableHasColor).toBe(false);
        done();
      });

      expectPostgrestRequest(httpMock, 'schema_properties', allProps);
      expectPostgrestRequest(httpMock, 'schema_entities', entities);
    });

    it('should build PostgREST select string for M:M properties', () => {
      const m2mProp = createMockProperty({
        column_name: 'tags',
        display_name: 'Tags',
        type: EntityPropertyType.ManyToMany,
        many_to_many_meta: {
          junctionTable: 'issue_tags',
          sourceTable: 'Issue',
          targetTable: 'tags',
          sourceColumn: 'issue_id',
          targetColumn: 'tag_id',
          relatedTable: 'tags',
          relatedTableDisplayName: 'Tags',
          showOnSource: true,
          showOnTarget: true,
          displayOrder: 100,
          relatedTableHasColor: true
        }
      });

      const result = SchemaService.propertyToSelectString(m2mProp);
      // Format: column_name:junctionTable!sourceColumn(relatedTable!targetColumn(fields))
      expect(result).toBe('tags:issue_tags!issue_id(tags!tag_id(id,display_name,color))');
    });

    it('should build PostgREST select string for M:M without color', () => {
      const m2mProp = createMockProperty({
        column_name: 'categories',
        display_name: 'Categories',
        type: EntityPropertyType.ManyToMany,
        many_to_many_meta: {
          junctionTable: 'issue_categories',
          sourceTable: 'Issue',
          targetTable: 'categories',
          sourceColumn: 'issue_id',
          targetColumn: 'category_id',
          relatedTable: 'categories',
          relatedTableDisplayName: 'Categories',
          showOnSource: true,
          showOnTarget: true,
          displayOrder: 100,
          relatedTableHasColor: false
        }
      });

      const result = SchemaService.propertyToSelectString(m2mProp);
      // Format: column_name:junctionTable!sourceColumn(relatedTable!targetColumn(fields))
      expect(result).toBe('categories:issue_categories!issue_id(categories!category_id(id,display_name))');
    });
  });

  describe('getConstraintMessages()', () => {
    it('should fetch constraint messages from PostgREST on first call', (done) => {
      const mockMessages = [
        {
          constraint_name: 'no_overlapping_reservations',
          table_name: 'reservations',
          column_name: 'time_slot',
          error_message: 'This time slot is already booked.'
        },
        {
          constraint_name: 'price_positive',
          table_name: 'products',
          column_name: 'price',
          error_message: 'Price must be greater than zero.'
        }
      ];

      service.getConstraintMessages().subscribe(messages => {
        expect(messages).toEqual(mockMessages);
        expect(messages.length).toBe(2);
        done();
      });

      expectPostgrestRequest(httpMock, 'constraint_messages', mockMessages);
    });

    it('should cache constraint messages and return from memory on subsequent calls', (done) => {
      const mockMessages = [
        {
          constraint_name: 'test_constraint',
          table_name: 'test_table',
          column_name: 'test_column',
          error_message: 'Test error message'
        }
      ];

      // First call - fetches from HTTP
      service.getConstraintMessages().subscribe(() => {
        // Second call - should return from cache without HTTP request
        service.getConstraintMessages().subscribe(cachedMessages => {
          expect(cachedMessages).toEqual(mockMessages);
          done();
        });
        // No HTTP request should be made for the second call
      });

      expectPostgrestRequest(httpMock, 'constraint_messages', mockMessages);
    });

    it('should handle HTTP errors gracefully and return empty array', (done) => {
      service.getConstraintMessages().subscribe(messages => {
        expect(messages).toEqual([]);
        done();
      });

      const req = httpMock.expectOne(req => req.url.includes('constraint_messages'));
      req.error(new ProgressEvent('error'), { status: 500, statusText: 'Server Error' });
    });

    it('should prevent duplicate HTTP requests when called multiple times before response', (done) => {
      const mockMessages = [
        {
          constraint_name: 'test_constraint',
          table_name: 'test_table',
          column_name: null,
          error_message: 'Test error'
        }
      ];

      // Call getConstraintMessages() three times in quick succession
      const sub1 = service.getConstraintMessages().subscribe();
      const sub2 = service.getConstraintMessages().subscribe();
      const sub3 = service.getConstraintMessages().subscribe(messages => {
        expect(messages).toEqual(mockMessages);
        done();
      });

      // Should only make ONE HTTP request despite three subscriptions
      expectPostgrestRequest(httpMock, 'constraint_messages', mockMessages);

      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
    });
  });

  describe('refreshCache()', () => {
    it('should clear constraint messages cache and reload on next call', (done) => {
      const firstMessages = [
        {
          constraint_name: 'constraint_v1',
          table_name: 'table1',
          column_name: 'col1',
          error_message: 'Version 1 message'
        }
      ];
      const secondMessages = [
        {
          constraint_name: 'constraint_v2',
          table_name: 'table2',
          column_name: 'col2',
          error_message: 'Version 2 message'
        }
      ];

      // First load
      service.getConstraintMessages().subscribe(() => {
        // Refresh cache - this triggers getEntities(), getProperties(), and getConstraintMessages()
        service.refreshCache();

        // Flush all HTTP requests from refreshCache()
        const entitiesRequests = httpMock.match(req => req.url.includes('schema_entities'));
        const propsReq = httpMock.expectOne(req => req.url.includes('schema_properties'));
        const constraintMsgsReq = httpMock.expectOne(req => req.url.includes('constraint_messages'));

        entitiesRequests.forEach(req => req.flush([]));
        propsReq.flush([]);
        constraintMsgsReq.flush(secondMessages);  // Return new data

        // Verify second data was loaded
        expect(service.constraintMessages).toEqual(secondMessages);
        done();
      });

      expectPostgrestRequest(httpMock, 'constraint_messages', firstMessages);
    });
  });
});
