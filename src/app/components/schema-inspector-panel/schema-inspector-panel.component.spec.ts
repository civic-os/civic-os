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
import { provideZonelessChangeDetection } from '@angular/core';
import { SchemaInspectorPanelComponent } from './schema-inspector-panel.component';
import { SchemaService } from '../../services/schema.service';
import { PermissionsService } from '../../services/permissions.service';
import { AuthService } from '../../services/auth.service';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { SchemaEntityTable, SchemaEntityProperty, EntityPropertyType, ManyToManyMeta } from '../../interfaces/entity';

/** Helper to create M:M metadata with all required fields */
function createM2MMeta(overrides: Partial<ManyToManyMeta>): ManyToManyMeta {
  return {
    junctionTable: overrides.junctionTable || 'junction',
    sourceTable: overrides.sourceTable || 'source',
    targetTable: overrides.targetTable || 'target',
    sourceColumn: overrides.sourceColumn || 'source_id',
    targetColumn: overrides.targetColumn || 'target_id',
    relatedTable: overrides.targetTable || 'target',  // Same as targetTable
    relatedTableDisplayName: overrides.relatedTableDisplayName || 'Related',
    showOnSource: overrides.showOnSource ?? true,
    showOnTarget: overrides.showOnTarget ?? true,
    displayOrder: overrides.displayOrder ?? 0,
    relatedTableHasColor: overrides.relatedTableHasColor ?? false
  };
}

/** Helper to create mock properties with all required fields */
function createMockProperty(overrides: Partial<SchemaEntityProperty>): SchemaEntityProperty {
  return {
    table_catalog: overrides.table_catalog || 'civic_os',
    table_schema: overrides.table_schema || 'public',
    table_name: overrides.table_name || 'test_table',
    column_name: overrides.column_name || 'test_column',
    display_name: overrides.display_name || 'Test Column',
    description: overrides.description || undefined,
    sort_order: overrides.sort_order ?? 1,
    column_width: overrides.column_width || 1,
    sortable: overrides.sortable ?? false,
    filterable: overrides.filterable ?? false,
    column_default: overrides.column_default || '',
    is_nullable: overrides.is_nullable ?? true,
    data_type: overrides.data_type || 'text',
    character_maximum_length: overrides.character_maximum_length || 0,
    udt_schema: overrides.udt_schema || 'pg_catalog',
    udt_name: overrides.udt_name || 'text',
    is_self_referencing: overrides.is_self_referencing ?? false,
    is_identity: overrides.is_identity ?? false,
    is_generated: overrides.is_generated ?? false,
    is_updatable: overrides.is_updatable ?? true,
    join_schema: overrides.join_schema || '',
    join_table: overrides.join_table || '',
    join_column: overrides.join_column || '',
    geography_type: overrides.geography_type || '',
    show_on_list: overrides.show_on_list ?? true,
    show_on_create: overrides.show_on_create ?? true,
    show_on_edit: overrides.show_on_edit ?? true,
    show_on_detail: overrides.show_on_detail ?? true,
    type: overrides.type ?? EntityPropertyType.TextShort,
    many_to_many_meta: overrides.many_to_many_meta,
    validation_rules: overrides.validation_rules
  };
}

describe('SchemaInspectorPanelComponent', () => {
  let component: SchemaInspectorPanelComponent;
  let fixture: ComponentFixture<SchemaInspectorPanelComponent>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockPermissionsService: jasmine.SpyObj<PermissionsService>;
  let mockAuthService: jasmine.SpyObj<AuthService>;

  // Test data
  const mockEntity: SchemaEntityTable = {
    table_name: 'issues',
    display_name: 'Issues',
    description: 'Issue tracking',
    sort_order: 1,
    search_fields: null,
    show_map: false,
    map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null,
    insert: true,
    select: true,
    update: true,
    delete: true
  };

  const mockFileProperty: SchemaEntityProperty = createMockProperty({
    table_name: 'issues',
    column_name: 'photo_id',
    display_name: 'Photo',
    udt_name: 'uuid',
    is_nullable: true,
    join_table: 'files',
    join_column: 'id',
    type: EntityPropertyType.FileImage,
    sort_order: 5,
    column_width: 1,
    sortable: false
  });

  const mockUserProperty: SchemaEntityProperty = createMockProperty({
    table_name: 'issues',
    column_name: 'created_by',
    display_name: 'Created By',
    udt_name: 'uuid',
    is_nullable: false,
    join_table: 'civic_os_users',
    join_column: 'id',
    type: EntityPropertyType.User,
    sort_order: 10,
    column_width: 1,
    sortable: false
  });

  const mockStatusProperty: SchemaEntityProperty = createMockProperty({
    table_name: 'issues',
    column_name: 'status_id',
    display_name: 'Status',
    udt_name: 'int4',
    is_nullable: false,
    join_schema: 'public',
    join_table: 'statuses',
    join_column: 'id',
    type: EntityPropertyType.ForeignKeyName,
    sort_order: 3,
    column_width: 1,
    sortable: true
  });

  beforeEach(async () => {
    // Create mock services
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getProperties', 'getPropertiesForEntity']);
    mockPermissionsService = jasmine.createSpyObj('PermissionsService', ['getRoles', 'getRolePermissions']);
    mockAuthService = jasmine.createSpyObj('AuthService', ['isAdmin'], {
      userRoles: signal<string[]>(['user'])
    });

    // Default: user is not admin (most tests don't need admin functionality)
    mockAuthService.isAdmin.and.returnValue(false);

    // Setup default return values
    mockSchemaService.getProperties.and.returnValue(of([]));
    mockSchemaService.getPropertiesForEntity.and.returnValue(of([]));
    mockPermissionsService.getRoles.and.returnValue(of([]));
    mockPermissionsService.getRolePermissions.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [SchemaInspectorPanelComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: PermissionsService, useValue: mockPermissionsService },
        { provide: AuthService, useValue: mockAuthService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(SchemaInspectorPanelComponent);
    component = fixture.componentInstance;

    // Set common inputs for all tests
    fixture.componentRef.setInput('systemTypes', new Set(['files', 'civic_os_users']));
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('isSystemTypeReference', () => {
    it('should return true for files FK', () => {
      expect(component.isSystemTypeReference(mockFileProperty)).toBe(true);
    });

    it('should return true for civic_os_users FK', () => {
      expect(component.isSystemTypeReference(mockUserProperty)).toBe(true);
    });

    it('should return false for domain entity FK', () => {
      expect(component.isSystemTypeReference(mockStatusProperty)).toBe(false);
    });

    it('should return false for property without join_table', () => {
      const textProperty: Partial<SchemaEntityProperty> = {
        ...mockStatusProperty,
        join_table: undefined as any,
        type: EntityPropertyType.TextShort
      };
      expect(component.isSystemTypeReference(textProperty as SchemaEntityProperty)).toBe(false);
    });

    it('should return false for M:M relationships', () => {
      const m2mProperty: SchemaEntityProperty = createMockProperty({
        ...mockFileProperty,
        type: EntityPropertyType.ManyToMany,
        many_to_many_meta: createM2MMeta({
          junctionTable: 'issue_files',
          sourceTable: 'issues',
          targetTable: 'files',
          sourceColumn: 'issue_id',
          targetColumn: 'file_id',
          relatedTableDisplayName: 'Files'
        })
      });
      expect(component.isSystemTypeReference(m2mProperty)).toBe(false);
    });
  });

  describe('getSystemTypeInfo', () => {
    it('should return correct info for files table', () => {
      const info = component.getSystemTypeInfo('files');
      expect(info.icon).toBe('description');
      expect(info.name).toBe('File');
      expect(info.color).toBe('text-info');
    });

    it('should return correct info for civic_os_users table', () => {
      const info = component.getSystemTypeInfo('civic_os_users');
      expect(info.icon).toBe('person');
      expect(info.name).toBe('User');
      expect(info.color).toBe('text-primary');
    });

    it('should return default info for unknown table', () => {
      const info = component.getSystemTypeInfo('unknown_table');
      expect(info.icon).toBe('label');
      expect(info.name).toBe('Reference');
      expect(info.color).toBe('text-secondary');
    });
  });

  describe('getConstraintBadges', () => {
    it('should not include FK badge for system type references', () => {
      const badges = component.getConstraintBadges(mockFileProperty);
      expect(badges).not.toContain('fk');
    });

    it('should include FK badge for domain entity references', () => {
      const badges = component.getConstraintBadges(mockStatusProperty);
      expect(badges).toContain('fk');
    });

    it('should include PK badge for id column', () => {
      const idProperty: SchemaEntityProperty = createMockProperty({
        ...mockStatusProperty,
        column_name: 'id',
        join_table: ''
      });
      const badges = component.getConstraintBadges(idProperty);
      expect(badges).toContain('pk');
    });

    it('should include M:M badge for many-to-many relationships', () => {
      const m2mProperty: SchemaEntityProperty = createMockProperty({
        ...mockStatusProperty,
        type: EntityPropertyType.ManyToMany,
        many_to_many_meta: createM2MMeta({
          junctionTable: 'issue_tags',
          sourceTable: 'issues',
          targetTable: 'tags',
          sourceColumn: 'issue_id',
          targetColumn: 'tag_id',
          relatedTableDisplayName: 'Tags'
        })
      });
      const badges = component.getConstraintBadges(m2mProperty);
      expect(badges).toContain('m2m');
    });

    it('should include required badge for non-nullable columns', () => {
      const badges = component.getConstraintBadges(mockUserProperty);
      expect(badges).toContain('required');
    });
  });

  describe('belongsToRelationships', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('entity', mockEntity);
      fixture.componentRef.setInput('systemTypes', new Set(['files', 'civic_os_users']));
      fixture.componentRef.setInput('junctionTables', new Set(['issue_tags']));
      fixture.detectChanges();
    });

    it('should exclude system types from belongsTo relationships', () => {
      component.properties.set([mockFileProperty, mockUserProperty, mockStatusProperty]);
      fixture.detectChanges();

      const relationships = component.belongsToRelationships();
      expect(relationships.length).toBe(1);
      expect(relationships[0].join_table).toBe('statuses');
    });

    it('should exclude junction tables from belongsTo relationships', () => {
      const junctionRefProperty: SchemaEntityProperty = createMockProperty({
        ...mockStatusProperty,
        table_name: 'some_table',
        column_name: 'junction_id',
        join_table: 'issue_tags'  // References junction table - should be filtered
      });
      component.properties.set([junctionRefProperty, mockStatusProperty]);
      fixture.detectChanges();

      const relationships = component.belongsToRelationships();
      expect(relationships.length).toBe(1);
      expect(relationships[0].join_table).toBe('statuses');
    });

    it('should exclude M:M relationships from belongsTo', () => {
      const m2mProperty: SchemaEntityProperty = createMockProperty({
        ...mockStatusProperty,
        type: EntityPropertyType.ManyToMany,
        many_to_many_meta: createM2MMeta({
          junctionTable: 'issue_tags',
          sourceTable: 'issues',
          targetTable: 'tags',
          sourceColumn: 'issue_id',
          targetColumn: 'tag_id',
          relatedTableDisplayName: 'Tags'
        })
      });
      component.properties.set([m2mProperty, mockStatusProperty]);
      fixture.detectChanges();

      const relationships = component.belongsToRelationships();
      expect(relationships.length).toBe(1);
      expect(relationships[0].type).toBe(EntityPropertyType.ForeignKeyName);
    });
  });

  describe('hasManyRelationships', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('entity', mockEntity);
      fixture.componentRef.setInput('systemTypes', new Set(['files', 'civic_os_users']));
      fixture.componentRef.setInput('junctionTables', new Set(['issue_tags']));
      fixture.detectChanges();
    });

    it('should exclude system types from hasMany relationships', () => {
      const inverseFileProperty: SchemaEntityProperty = createMockProperty({
        ...mockFileProperty,
        table_name: 'files',
        join_table: 'issues'
      });
      const inverseUserProperty: SchemaEntityProperty = createMockProperty({
        ...mockUserProperty,
        table_name: 'civic_os_users',
        join_table: 'issues'
      });
      const inverseCommentProperty: SchemaEntityProperty = createMockProperty({
        ...mockStatusProperty,
        table_name: 'comments',
        join_table: 'issues'
      });

      component.allProperties.set([inverseFileProperty, inverseUserProperty, inverseCommentProperty]);
      fixture.detectChanges();

      const relationships = component.hasManyRelationships();
      expect(relationships.length).toBe(1);
      expect(relationships[0].table_name).toBe('comments');
    });

    it('should exclude junction tables from hasMany relationships', () => {
      const junctionProperty: SchemaEntityProperty = createMockProperty({
        ...mockStatusProperty,
        table_name: 'issue_tags',
        join_table: 'issues'
      });
      const domainProperty: SchemaEntityProperty = createMockProperty({
        ...mockStatusProperty,
        table_name: 'comments',
        join_table: 'issues'
      });

      component.allProperties.set([junctionProperty, domainProperty]);
      fixture.detectChanges();

      const relationships = component.hasManyRelationships();
      expect(relationships.length).toBe(1);
      expect(relationships[0].table_name).toBe('comments');
    });
  });

  describe('manyToManyRelationships', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('entity', mockEntity);
      fixture.componentRef.setInput('systemTypes', new Set(['files', 'civic_os_users']));
      fixture.detectChanges();
    });

    it('should exclude system types from M:M relationships', () => {
      const m2mToFiles: SchemaEntityProperty = {
        ...mockStatusProperty,
        type: EntityPropertyType.ManyToMany,
        many_to_many_meta: createM2MMeta({
          junctionTable: 'issue_files',
          sourceTable: 'issues',
          targetTable: 'files',
          sourceColumn: 'issue_id',
          targetColumn: 'file_id',
          relatedTableDisplayName: 'Files'
        })
      };
      const m2mToTags: SchemaEntityProperty = {
        ...mockStatusProperty,
        type: EntityPropertyType.ManyToMany,
        many_to_many_meta: createM2MMeta({
          junctionTable: 'issue_tags',
          sourceTable: 'issues',
          targetTable: 'tags',
          sourceColumn: 'issue_id',
          targetColumn: 'tag_id',
          relatedTableDisplayName: 'Tags'
        })
      };

      component.properties.set([m2mToFiles, m2mToTags]);
      fixture.detectChanges();

      const relationships = component.manyToManyRelationships();
      expect(relationships.length).toBe(1);
      expect(relationships[0].many_to_many_meta?.targetTable).toBe('tags');
    });
  });

  describe('isMetadataTable', () => {
    it('should return true for files table', () => {
      const filesEntity: SchemaEntityTable = { ...mockEntity, table_name: 'files' };
      fixture.componentRef.setInput('entity', filesEntity);
      fixture.detectChanges();

      expect(component.isMetadataTable()).toBe(true);
    });

    it('should return true for civic_os_users table', () => {
      const usersEntity: SchemaEntityTable = { ...mockEntity, table_name: 'civic_os_users' };
      fixture.componentRef.setInput('entity', usersEntity);
      fixture.detectChanges();

      expect(component.isMetadataTable()).toBe(true);
    });

    it('should return false for domain tables', () => {
      fixture.componentRef.setInput('entity', mockEntity);
      fixture.detectChanges();

      expect(component.isMetadataTable()).toBe(false);
    });

    it('should return false when no entity selected', () => {
      fixture.componentRef.setInput('entity', null);
      fixture.detectChanges();

      expect(component.isMetadataTable()).toBe(false);
    });
  });

  describe('formatDataType', () => {
    it('should format type with character length', () => {
      const varcharProperty: SchemaEntityProperty = createMockProperty({
        ...mockStatusProperty,
        udt_name: 'varchar',
        character_maximum_length: 255
      });
      expect(component.formatDataType(varcharProperty)).toBe('varchar(255)');
    });

    it('should format type without character length', () => {
      expect(component.formatDataType(mockStatusProperty)).toBe('int4');
    });
  });

  describe('tab navigation', () => {
    it('should switch to relations tab for metadata tables', () => {
      mockSchemaService.getPropertiesForEntity.and.returnValue(of([]));

      const filesEntity: SchemaEntityTable = { ...mockEntity, table_name: 'files' };
      fixture.componentRef.setInput('entity', filesEntity);
      fixture.detectChanges();

      expect(component.activeTab()).toBe('relations');
    });

    it('should default to properties tab for domain tables', () => {
      mockSchemaService.getPropertiesForEntity.and.returnValue(of([mockStatusProperty]));

      fixture.componentRef.setInput('entity', mockEntity);
      fixture.detectChanges();

      expect(component.activeTab()).toBe('properties');
    });
  });
});
