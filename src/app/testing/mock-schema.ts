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

import { EntityPropertyType, SchemaEntityProperty, SchemaEntityTable, ManyToManyMeta } from '../interfaces/entity';

/**
 * Creates a mock SchemaEntityTable with sensible defaults.
 * Override any properties as needed for specific test cases.
 */
export function createMockEntity(overrides?: Partial<SchemaEntityTable>): SchemaEntityTable {
  return {
    display_name: 'Test Entity',
    sort_order: 1,
    description: null,
    search_fields: null,
    show_map: false,
    map_property_name: null,
    show_calendar: false,
    calendar_property_name: null,
    calendar_color_property: null,
    table_name: 'test_entity',
    insert: true,
    select: true,
    update: true,
    delete: true,
    payment_initiation_rpc: null,
    payment_capture_mode: null,
    ...overrides
  };
}

/**
 * Creates a mock SchemaEntityProperty with sensible defaults.
 * Override any properties as needed for specific test cases.
 */
export function createMockProperty(overrides?: Partial<SchemaEntityProperty>): SchemaEntityProperty {
  return {
    table_catalog: 'civic_os_db',
    table_schema: 'public',
    table_name: 'test_entity',
    column_name: 'test_column',
    display_name: 'Test Column',
    sort_order: 1,
    column_default: '',
    is_nullable: true,
    data_type: 'character varying',
    character_maximum_length: 255,
    udt_schema: 'pg_catalog',
    udt_name: 'varchar',
    is_self_referencing: false,
    is_identity: false,
    is_generated: false,
    is_updatable: true,
    join_schema: '',
    join_table: '',
    join_column: '',
    geography_type: '',
    type: EntityPropertyType.TextShort,
    ...overrides
  };
}

/**
 * Pre-configured property type samples for common test scenarios.
 * Use these to quickly set up tests for each EntityPropertyType.
 */
export const MOCK_PROPERTIES = {
  textShort: createMockProperty({
    column_name: 'name',
    display_name: 'Name',
    data_type: 'character varying',
    udt_name: 'varchar',
    character_maximum_length: 255,
    type: EntityPropertyType.TextShort
  }),

  textLong: createMockProperty({
    column_name: 'description',
    display_name: 'Description',
    data_type: 'text',
    udt_name: 'text',
    character_maximum_length: 0,
    type: EntityPropertyType.TextLong
  }),

  boolean: createMockProperty({
    column_name: 'is_active',
    display_name: 'Is Active',
    data_type: 'boolean',
    udt_name: 'bool',
    type: EntityPropertyType.Boolean
  }),

  integer: createMockProperty({
    column_name: 'count',
    display_name: 'Count',
    data_type: 'integer',
    udt_name: 'int4',
    type: EntityPropertyType.IntegerNumber
  }),

  integerBig: createMockProperty({
    column_name: 'big_count',
    display_name: 'Big Count',
    data_type: 'bigint',
    udt_name: 'int8',
    type: EntityPropertyType.IntegerNumber
  }),

  money: createMockProperty({
    column_name: 'amount',
    display_name: 'Amount',
    data_type: 'money',
    udt_name: 'money',
    type: EntityPropertyType.Money
  }),

  date: createMockProperty({
    column_name: 'due_date',
    display_name: 'Due Date',
    data_type: 'date',
    udt_name: 'date',
    type: EntityPropertyType.Date
  }),

  dateTime: createMockProperty({
    column_name: 'created_at',
    display_name: 'Created At',
    data_type: 'timestamp without time zone',
    udt_name: 'timestamp',
    type: EntityPropertyType.DateTime
  }),

  dateTimeLocal: createMockProperty({
    column_name: 'updated_at',
    display_name: 'Updated At',
    data_type: 'timestamp with time zone',
    udt_name: 'timestamptz',
    type: EntityPropertyType.DateTimeLocal
  }),

  foreignKey: createMockProperty({
    column_name: 'status_id',
    display_name: 'Status',
    data_type: 'integer',
    udt_name: 'int4',
    join_schema: 'public',
    join_table: 'Status',
    join_column: 'id',
    type: EntityPropertyType.ForeignKeyName,
    is_nullable: false
  }),

  user: createMockProperty({
    column_name: 'assigned_to',
    display_name: 'Assigned To',
    data_type: 'uuid',
    udt_name: 'uuid',
    join_table: 'civic_os_users',
    type: EntityPropertyType.User
  }),

  geoPoint: createMockProperty({
    column_name: 'location',
    display_name: 'Location',
    data_type: 'USER-DEFINED',
    udt_name: 'geography',
    geography_type: 'Point',
    type: EntityPropertyType.GeoPoint
  }),

  unknown: createMockProperty({
    column_name: 'unknown_field',
    display_name: 'Unknown Field',
    data_type: 'unknown_type',
    udt_name: 'unknown_type',
    type: EntityPropertyType.Unknown
  })
};

/**
 * Pre-configured entity samples for common test scenarios.
 */
export const MOCK_ENTITIES: {
  issue: SchemaEntityTable;
  status: SchemaEntityTable;
  workPackage: SchemaEntityTable;
} = {
  issue: createMockEntity({
    table_name: 'Issue',
    display_name: 'Issues',
    sort_order: 1
  }),

  status: createMockEntity({
    table_name: 'Status',
    display_name: 'Statuses',
    sort_order: 2
  }),

  workPackage: createMockEntity({
    table_name: 'WorkPackage',
    display_name: 'Work Packages',
    sort_order: 3
  })
};

/**
 * Creates a mock ManyToManyMeta object with sensible defaults.
 * Override any properties as needed for specific test cases.
 */
export function createMockManyToManyMeta(overrides?: Partial<ManyToManyMeta>): ManyToManyMeta {
  return {
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
    relatedTableHasColor: true,
    ...overrides
  };
}

/**
 * Mock data samples for testing DisplayPropertyComponent
 */
export const MOCK_DATA = {
  textValue: { name: 'Test Issue' },
  booleanTrue: { is_active: true },
  booleanFalse: { is_active: false },
  integer: { count: 42 },
  money: { amount: '$1,234.56' },
  date: { due_date: '2025-12-31' },
  dateTime: { created_at: '2025-10-04T12:00:00' },
  foreignKey: { status_id: { id: 1, display_name: 'Open' } },
  user: {
    assigned_to: {
      display_name: 'John Doe',
      private: { email: 'john@example.com', phone: '555-1234' }
    }
  },
  geoPoint: { location: 'POINT(-83.6875 43.0125)' },
  geoPointNull: { location: null }
};

/**
 * Mock M:M property with complete metadata for testing ManyToManyEditorComponent
 */
export const MOCK_M2M_PROPERTY = createMockProperty({
  column_name: 'tags',
  display_name: 'Tags',
  table_name: 'Issue',
  udt_name: '_junction_',
  type: EntityPropertyType.ManyToMany,
  many_to_many_meta: createMockManyToManyMeta()
});

/**
 * Mock related entity data with colors (for M:M display/edit testing)
 */
export const MOCK_RELATED_DATA = [
  { id: 1, display_name: 'Urgent', color: '#FF0000', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
  { id: 2, display_name: 'Road Surface', color: '#00FF00', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
  { id: 3, display_name: 'Sidewalk', color: '#0000FF', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
  { id: 4, display_name: 'Lighting', color: '#FFFF00', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
  { id: 5, display_name: 'Drainage', color: '#FF00FF', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' }
];

/**
 * Mock junction table properties for testing junction detection logic.
 * This represents a clean junction table with exactly 2 FKs and only metadata columns.
 */
export const MOCK_JUNCTION_PROPERTIES = [
  createMockProperty({
    table_name: 'issue_tags',
    column_name: 'issue_id',
    display_name: 'Issue ID',
    udt_name: 'int8',
    join_schema: 'public',
    join_table: 'Issue',
    join_column: 'id',
    type: EntityPropertyType.ForeignKeyName
  }),
  createMockProperty({
    table_name: 'issue_tags',
    column_name: 'tag_id',
    display_name: 'Tag ID',
    udt_name: 'int4',
    join_schema: 'public',
    join_table: 'tags',
    join_column: 'id',
    type: EntityPropertyType.ForeignKeyName
  }),
  createMockProperty({
    table_name: 'issue_tags',
    column_name: 'created_at',
    display_name: 'Created At',
    udt_name: 'timestamptz',
    is_generated: true,
    is_updatable: false,
    type: EntityPropertyType.DateTime
  })
];

/**
 * Mock non-junction table properties (has extra business columns).
 * This table has 2+ FKs but also has non-metadata columns, so it should NOT be detected as a junction table.
 */
export const MOCK_NON_JUNCTION_PROPERTIES = [
  createMockProperty({
    table_name: 'user_roles',
    column_name: 'user_id',
    udt_name: 'uuid',
    join_table: 'civic_os_users',
    type: EntityPropertyType.User
  }),
  createMockProperty({
    table_name: 'user_roles',
    column_name: 'role_id',
    udt_name: 'int4',
    join_table: 'roles',
    type: EntityPropertyType.ForeignKeyName
  }),
  createMockProperty({
    table_name: 'user_roles',
    column_name: 'granted_by',
    display_name: 'Granted By',
    udt_name: 'uuid',
    join_table: 'civic_os_users',
    type: EntityPropertyType.User
  }),
  createMockProperty({
    table_name: 'user_roles',
    column_name: 'granted_at',
    udt_name: 'timestamptz',
    type: EntityPropertyType.DateTime
  })
];
