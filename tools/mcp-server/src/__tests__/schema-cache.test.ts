/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for SchemaCache and detectPropertyType().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchemaCache, detectPropertyType } from '../schema-cache.js';
import { EntityPropertyType } from '../interfaces.js';
import type { PostgRESTClient } from '../postgrest-client.js';
import type {
  SchemaEntity,
  SchemaProperty,
  SchemaEntityAction,
  StatusOption,
  CategoryOption,
  StatusTransition,
  ConstraintMessage,
  SchemaCacheVersion,
} from '../interfaces.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeEntity = (overrides: Partial<SchemaEntity> = {}): SchemaEntity => ({
  display_name: 'Projects',
  table_name: 'projects',
  description: null,
  sort_order: 1,
  insert: true,
  select: true,
  update: true,
  delete: false,
  ...overrides,
});

const makeProperty = (overrides: Partial<SchemaProperty> = {}): SchemaProperty => ({
  table_name: 'projects',
  column_name: 'name',
  display_name: 'Name',
  data_type: 'character varying',
  udt_name: 'varchar',
  udt_schema: 'pg_catalog',
  sort_order: 1,
  join_schema: '',
  join_table: '',
  join_column: '',
  geography_type: '',
  is_nullable: true,
  is_updatable: true,
  is_identity: false,
  is_generated: false,
  is_self_referencing: false,
  column_default: '',
  ...overrides,
});

const makeAction = (overrides: Partial<SchemaEntityAction> = {}): SchemaEntityAction => ({
  id: 1,
  table_name: 'projects',
  action_name: 'approve',
  display_name: 'Approve',
  rpc_function: 'approve_project',
  button_style: 'primary',
  sort_order: 1,
  requires_confirmation: false,
  refresh_after_action: true,
  show_on_detail: true,
  can_execute: true,
  parameters: [],
  ...overrides,
});

const makeStatus = (overrides: Partial<StatusOption> = {}): StatusOption => ({
  id: 1,
  display_name: 'Active',
  color: '#00FF00',
  entity_type: 'projects',
  ...overrides,
});

const makeCategory = (overrides: Partial<CategoryOption> = {}): CategoryOption => ({
  id: 1,
  display_name: 'Internal',
  color: '#0000FF',
  entity_type: 'projects',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock client builder
// ---------------------------------------------------------------------------

function makeMockClient(overrides: Partial<Record<string, unknown>> = {}): PostgRESTClient {
  const defaults: Record<string, unknown[]> = {
    schema_entities: [makeEntity()],
    schema_properties: [makeProperty()],
    schema_entity_actions: [makeAction()],
    statuses: [makeStatus()],
    categories: [makeCategory()],
    status_transitions: [],
    constraint_messages: [],
    schema_cache_versions: [],
  };

  const data = { ...defaults, ...overrides };

  return {
    get: vi.fn().mockImplementation((path: string) => {
      const key = path.split('/').pop() ?? path;
      const result = data[key] ?? data[path] ?? [];
      return Promise.resolve({ data: result, status: 200 });
    }),
  } as unknown as PostgRESTClient;
}

// ---------------------------------------------------------------------------
// SchemaCache.initialize()
// ---------------------------------------------------------------------------

describe('SchemaCache.initialize()', () => {
  it('loads entities, properties, actions, statuses, categories', async () => {
    const client = makeMockClient();
    const cache = new SchemaCache(client);

    await cache.initialize();

    expect(cache.entities).toHaveLength(1);
    expect(cache.entities[0].table_name).toBe('projects');
    expect(cache.properties).toHaveLength(1);
    expect(cache.actions).toHaveLength(1);
    expect(cache.statuses).toHaveLength(1);
    expect(cache.categories).toHaveLength(1);
  });

  it('is a no-op on second call without force', async () => {
    const client = makeMockClient();
    const cache = new SchemaCache(client);

    await cache.initialize();
    await cache.initialize(); // second call

    // get() should have been called for schema_entities once during init, not twice
    const calls = (client.get as ReturnType<typeof vi.fn>).mock.calls as string[][];
    const entityCalls = calls.filter(([path]) => path === 'schema_entities');
    expect(entityCalls).toHaveLength(1);
  });

  it('re-fetches everything when force=true', async () => {
    const client = makeMockClient();
    const cache = new SchemaCache(client);

    await cache.initialize();
    const callsBefore = (client.get as ReturnType<typeof vi.fn>).mock.calls.length;

    await cache.initialize(true);
    const callsAfter = (client.get as ReturnType<typeof vi.fn>).mock.calls.length;

    // Should have made additional calls on force
    expect(callsAfter).toBeGreaterThan(callsBefore);
  });

  it('assigns computed type to each property', async () => {
    const boolProp = makeProperty({ udt_name: 'bool', column_name: 'active', display_name: 'Active' });
    const client = makeMockClient({ schema_properties: [boolProp] });
    const cache = new SchemaCache(client);

    await cache.initialize();

    expect(cache.properties[0].type).toBe(EntityPropertyType.Boolean);
  });

  it('silently ignores status_transitions fetch failure', async () => {
    const client = makeMockClient();
    (client.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === 'status_transitions') return Promise.reject(new Error('View not found'));
      const defaults: Record<string, unknown[]> = {
        schema_entities: [makeEntity()],
        schema_properties: [makeProperty()],
        schema_entity_actions: [],
        statuses: [],
        categories: [],
        constraint_messages: [],
        schema_cache_versions: [],
      };
      return Promise.resolve({ data: defaults[path] ?? [], status: 200 });
    });

    const cache = new SchemaCache(client);
    await expect(cache.initialize()).resolves.not.toThrow();
    expect(cache.transitions).toHaveLength(0);
  });

  it('silently ignores constraint_messages fetch failure', async () => {
    const client = makeMockClient();
    (client.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === 'constraint_messages') return Promise.reject(new Error('View not found'));
      const defaults: Record<string, unknown[]> = {
        schema_entities: [makeEntity()],
        schema_properties: [makeProperty()],
        schema_entity_actions: [],
        statuses: [],
        categories: [],
        status_transitions: [],
        schema_cache_versions: [],
      };
      return Promise.resolve({ data: defaults[path] ?? [], status: 200 });
    });

    const cache = new SchemaCache(client);
    await expect(cache.initialize()).resolves.not.toThrow();
    expect(cache.constraintMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SchemaCache.ensureFresh()
// ---------------------------------------------------------------------------

describe('SchemaCache.ensureFresh()', () => {
  it('calls initialize() when not yet initialized', async () => {
    const client = makeMockClient();
    const cache = new SchemaCache(client);

    await cache.ensureFresh();

    expect(cache.entities).toHaveLength(1);
  });

  it('does not re-fetch when versions are unchanged', async () => {
    const versions: SchemaCacheVersion[] = [
      { view_name: 'entities', max_updated_at: '2024-01-01T00:00:00Z' },
    ];
    const client = makeMockClient({ schema_cache_versions: versions });
    const cache = new SchemaCache(client);

    await cache.initialize();
    const callsBefore = (client.get as ReturnType<typeof vi.fn>).mock.calls.length;

    await cache.ensureFresh();
    const callsAfter = (client.get as ReturnType<typeof vi.fn>).mock.calls.length;

    // Only one additional call (the version check itself)
    expect(callsAfter - callsBefore).toBe(1);
  });

  it('re-fetches entities when entities version is stale', async () => {
    const entity1 = makeEntity({ display_name: 'Old Entity', table_name: 'old_table' });
    const versions1: SchemaCacheVersion[] = [
      { view_name: 'entities', max_updated_at: '2024-01-01T00:00:00Z' },
    ];

    let versionTimestamp = '2024-01-01T00:00:00Z';
    const client = makeMockClient();

    (client.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === 'schema_cache_versions') {
        return Promise.resolve({
          data: [{ view_name: 'entities', max_updated_at: versionTimestamp }],
          status: 200,
        });
      }
      const defaults: Record<string, unknown[]> = {
        schema_entities: [entity1],
        schema_properties: [makeProperty()],
        schema_entity_actions: [],
        statuses: [],
        categories: [],
        status_transitions: [],
        constraint_messages: [],
      };
      return Promise.resolve({ data: defaults[path] ?? [], status: 200 });
    });

    const cache = new SchemaCache(client);
    await cache.initialize();

    // Simulate a schema change
    versionTimestamp = '2024-06-01T00:00:00Z';
    await cache.ensureFresh();

    // The version check should have triggered a re-fetch of entities
    const calls = (client.get as ReturnType<typeof vi.fn>).mock.calls as string[][];
    const entityRefetchCalls = calls.filter(([path]) => path === 'schema_entities');
    expect(entityRefetchCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('silently continues when version check throws', async () => {
    const client = makeMockClient();
    const cache = new SchemaCache(client);
    await cache.initialize();

    (client.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB down'));

    await expect(cache.ensureFresh()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Derived lookups
// ---------------------------------------------------------------------------

describe('SchemaCache derived lookups', () => {
  it('getEntity() resolves by table name', async () => {
    const client = makeMockClient();
    const cache = new SchemaCache(client);
    await cache.initialize();

    const entity = cache.getEntity('projects');
    expect(entity?.display_name).toBe('Projects');
  });

  it('getEntity() returns undefined for unknown table', async () => {
    const client = makeMockClient();
    const cache = new SchemaCache(client);
    await cache.initialize();

    expect(cache.getEntity('nonexistent')).toBeUndefined();
  });

  it('getEntityByDisplayName() resolves case-insensitively', async () => {
    const client = makeMockClient();
    const cache = new SchemaCache(client);
    await cache.initialize();

    const entity = cache.getEntityByDisplayName('PROJECTS');
    expect(entity?.table_name).toBe('projects');
  });

  it('getProperties() returns properties for a table', async () => {
    const prop1 = makeProperty({ column_name: 'name', display_name: 'Name' });
    const prop2 = makeProperty({ column_name: 'budget', display_name: 'Budget', udt_name: 'money' });
    const client = makeMockClient({ schema_properties: [prop1, prop2] });
    const cache = new SchemaCache(client);
    await cache.initialize();

    const props = cache.getProperties('projects');
    expect(props).toHaveLength(2);
    expect(props.map(p => p.column_name)).toContain('name');
    expect(props.map(p => p.column_name)).toContain('budget');
  });

  it('getProperties() returns empty array for unknown table', async () => {
    const client = makeMockClient();
    const cache = new SchemaCache(client);
    await cache.initialize();

    expect(cache.getProperties('nonexistent')).toEqual([]);
  });

  it('getActions() groups actions by table', async () => {
    const action1 = makeAction({ action_name: 'approve', display_name: 'Approve' });
    const action2 = makeAction({ id: 2, action_name: 'reject', display_name: 'Reject' });
    const client = makeMockClient({ schema_entity_actions: [action1, action2] });
    const cache = new SchemaCache(client);
    await cache.initialize();

    const actions = cache.getActions('projects');
    expect(actions).toHaveLength(2);
  });

  it('getStatuses() groups statuses by entity_type', async () => {
    const s1 = makeStatus({ id: 1, display_name: 'Active', entity_type: 'projects' });
    const s2 = makeStatus({ id: 2, display_name: 'Closed', entity_type: 'projects' });
    const s3 = makeStatus({ id: 3, display_name: 'Open', entity_type: 'tickets' });
    const client = makeMockClient({ statuses: [s1, s2, s3] });
    const cache = new SchemaCache(client);
    await cache.initialize();

    expect(cache.getStatuses('projects')).toHaveLength(2);
    expect(cache.getStatuses('tickets')).toHaveLength(1);
    expect(cache.getStatuses('unknown')).toHaveLength(0);
  });

  it('getCategories() groups categories by entity_type', async () => {
    const c1 = makeCategory({ id: 1, display_name: 'Internal', entity_type: 'projects' });
    const c2 = makeCategory({ id: 2, display_name: 'External', entity_type: 'tickets' });
    const client = makeMockClient({ categories: [c1, c2] });
    const cache = new SchemaCache(client);
    await cache.initialize();

    expect(cache.getCategories('projects')).toHaveLength(1);
    expect(cache.getCategories('tickets')).toHaveLength(1);
  });

  it('getTransitions() groups transitions by entity_type', async () => {
    const t1: StatusTransition = { from_status_id: 1, to_status_id: 2, entity_type: 'projects' };
    const t2: StatusTransition = { from_status_id: 2, to_status_id: 3, entity_type: 'projects' };
    const client = makeMockClient({ status_transitions: [t1, t2] });
    const cache = new SchemaCache(client);
    await cache.initialize();

    expect(cache.getTransitions('projects')).toHaveLength(2);
    expect(cache.getTransitions('tickets')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectPropertyType()
// ---------------------------------------------------------------------------

describe('detectPropertyType()', () => {
  const base = makeProperty();

  // Status and Category (priority before FK)
  it('detects Status when status_entity_type and FK are set', () => {
    const prop = makeProperty({
      udt_name: 'int4',
      join_table: 'statuses',
      join_column: 'id',
      status_entity_type: 'projects',
    });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.Status);
  });

  it('detects Category when category_entity_type and FK are set', () => {
    const prop = makeProperty({
      udt_name: 'int4',
      join_table: 'categories',
      join_column: 'id',
      category_entity_type: 'projects',
    });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.Category);
  });

  // System FK types
  it('detects FileImage via files join_table with image fileType rule', () => {
    const prop = makeProperty({
      join_table: 'files',
      join_column: 'id',
      validation_rules: [{ type: 'fileType', value: 'image/jpeg', message: '' }],
    });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.FileImage);
  });

  it('detects FilePDF via files join_table with application/pdf fileType rule', () => {
    const prop = makeProperty({
      join_table: 'files',
      join_column: 'id',
      validation_rules: [{ type: 'fileType', value: 'application/pdf', message: '' }],
    });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.FilePDF);
  });

  it('detects generic File via files join_table without fileType rule', () => {
    const prop = makeProperty({ join_table: 'files', join_column: 'id' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.File);
  });

  it('detects User via civic_os_users join_table', () => {
    const prop = makeProperty({ join_table: 'civic_os_users', join_column: 'id' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.User);
  });

  it('detects User via civic_os_users_private join_table', () => {
    const prop = makeProperty({ join_table: 'civic_os_users_private', join_column: 'id' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.User);
  });

  it('detects Payment via payment_transactions join_table', () => {
    const prop = makeProperty({ join_table: 'payment_transactions', join_column: 'id' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.Payment);
  });

  it('detects PhotoGallery via photo_galleries join_table', () => {
    const prop = makeProperty({ join_table: 'photo_galleries', join_column: 'id' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.PhotoGallery);
  });

  // Geographic types
  it('detects GeoPoint for geography type without polygon', () => {
    const prop = makeProperty({
      data_type: 'USER-DEFINED',
      udt_name: 'geography',
      geography_type: 'Point',
    });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.GeoPoint);
  });

  it('detects GeoPolygon for Polygon geography type', () => {
    const prop = makeProperty({
      data_type: 'USER-DEFINED',
      udt_name: 'geography',
      geography_type: 'Polygon',
    });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.GeoPolygon);
  });

  it('detects GeoPolygon for MultiPolygon geography type', () => {
    const prop = makeProperty({
      data_type: 'USER-DEFINED',
      udt_name: 'geography',
      geography_type: 'MultiPolygon',
    });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.GeoPolygon);
  });

  // Domain types
  it('detects DateTime for timestamp udt_name', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'timestamp' }))).toBe(EntityPropertyType.DateTime);
  });

  it('detects DateTimeLocal for timestamptz udt_name', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'timestamptz' }))).toBe(EntityPropertyType.DateTimeLocal);
  });

  it('detects Date for date udt_name', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'date' }))).toBe(EntityPropertyType.Date);
  });

  it('detects Boolean for bool udt_name', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'bool' }))).toBe(EntityPropertyType.Boolean);
  });

  it('detects Money for money udt_name', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'money' }))).toBe(EntityPropertyType.Money);
  });

  it('detects DecimalNumber for numeric udt_name', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'numeric' }))).toBe(EntityPropertyType.DecimalNumber);
  });

  it('detects DecimalNumber for float4 udt_name', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'float4' }))).toBe(EntityPropertyType.DecimalNumber);
  });

  it('detects DecimalNumber for float8 udt_name', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'float8' }))).toBe(EntityPropertyType.DecimalNumber);
  });

  it('detects Color for hex_color domain', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'hex_color' }))).toBe(EntityPropertyType.Color);
  });

  it('detects Email for email_address domain', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'email_address' }))).toBe(EntityPropertyType.Email);
  });

  it('detects Telephone for phone_number domain', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'phone_number' }))).toBe(EntityPropertyType.Telephone);
  });

  it('detects Markdown for markdown domain', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'markdown' }))).toBe(EntityPropertyType.Markdown);
  });

  it('detects TimeSlot for time_slot domain when not recurring', () => {
    const prop = makeProperty({ udt_name: 'time_slot', is_recurring: false });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.TimeSlot);
  });

  it('detects RecurringTimeSlot for time_slot domain when is_recurring=true', () => {
    const prop = makeProperty({ udt_name: 'time_slot', is_recurring: true });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.RecurringTimeSlot);
  });

  // Integer FK vs plain int
  it('detects ForeignKeyName for int4 with FK info', () => {
    const prop = makeProperty({ udt_name: 'int4', join_table: 'clients', join_column: 'id' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.ForeignKeyName);
  });

  it('detects IntegerNumber for int4 without FK info', () => {
    const prop = makeProperty({ udt_name: 'int4' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.IntegerNumber);
  });

  it('detects IntegerNumber for int8 without FK info', () => {
    const prop = makeProperty({ udt_name: 'int8' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.IntegerNumber);
  });

  it('detects ForeignKeyName for int2 with FK info', () => {
    const prop = makeProperty({ udt_name: 'int2', join_table: 'types', join_column: 'id' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.ForeignKeyName);
  });

  it('detects ForeignKeyName for uuid with FK info', () => {
    const prop = makeProperty({ udt_name: 'uuid', join_table: 'users', join_column: 'id' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.ForeignKeyName);
  });

  it('detects TextShort for uuid without FK info', () => {
    const prop = makeProperty({ udt_name: 'uuid' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.TextShort);
  });

  it('detects TextShort for varchar', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'varchar' }))).toBe(EntityPropertyType.TextShort);
  });

  it('detects TextShort for bpchar', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'bpchar' }))).toBe(EntityPropertyType.TextShort);
  });

  it('detects TextLong for text', () => {
    expect(detectPropertyType(makeProperty({ udt_name: 'text' }))).toBe(EntityPropertyType.TextLong);
  });

  // Fallback FK
  it('falls back to ForeignKeyName when has FK but unrecognized udt_name', () => {
    const prop = makeProperty({
      udt_name: 'some_custom_type',
      join_table: 'custom_table',
      join_column: 'id',
    });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.ForeignKeyName);
  });

  // Unknown fallback
  it('returns Unknown for unrecognized type with no FK', () => {
    const prop = makeProperty({ udt_name: 'completely_unknown_type' });
    expect(detectPropertyType(prop)).toBe(EntityPropertyType.Unknown);
  });
});
