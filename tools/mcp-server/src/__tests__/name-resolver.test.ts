/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for NameResolver.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NameResolver, NameResolutionError } from '../name-resolver.js';
import { EntityPropertyType } from '../interfaces.js';
import type { SchemaCache } from '../schema-cache.js';
import type { PostgRESTClient } from '../postgrest-client.js';
import type {
  SchemaEntity,
  SchemaProperty,
  SchemaEntityAction,
  StatusOption,
  CategoryOption,
} from '../interfaces.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntity(overrides: Partial<SchemaEntity> = {}): SchemaEntity {
  return {
    display_name: 'Projects',
    table_name: 'projects',
    description: null,
    sort_order: 1,
    insert: true,
    select: true,
    update: true,
    delete: false,
    ...overrides,
  };
}

function makeProperty(overrides: Partial<SchemaProperty> = {}): SchemaProperty {
  return {
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
    type: EntityPropertyType.TextShort,
    ...overrides,
  };
}

function makeAction(overrides: Partial<SchemaEntityAction> = {}): SchemaEntityAction {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Mock builder helpers
// ---------------------------------------------------------------------------

function makeMockCache(entities: SchemaEntity[], properties: SchemaProperty[], actions: SchemaEntityAction[] = [], statuses: StatusOption[] = [], categories: CategoryOption[] = []): SchemaCache {
  const entityByTable = new Map(entities.map(e => [e.table_name, e]));
  const entityByDisplay = new Map(entities.map(e => [e.display_name.toLowerCase(), e]));
  const propsByTable = new Map<string, SchemaProperty[]>();
  for (const p of properties) {
    const list = propsByTable.get(p.table_name) ?? [];
    list.push(p);
    propsByTable.set(p.table_name, list);
  }
  const actionsByTable = new Map<string, SchemaEntityAction[]>();
  for (const a of actions) {
    const list = actionsByTable.get(a.table_name) ?? [];
    list.push(a);
    actionsByTable.set(a.table_name, list);
  }
  const statusesByType = new Map<string, StatusOption[]>();
  for (const s of statuses) {
    const list = statusesByType.get(s.entity_type) ?? [];
    list.push(s);
    statusesByType.set(s.entity_type, list);
  }
  const categoriesByType = new Map<string, CategoryOption[]>();
  for (const c of categories) {
    const list = categoriesByType.get(c.entity_type) ?? [];
    list.push(c);
    categoriesByType.set(c.entity_type, list);
  }

  return {
    entities,
    properties,
    actions,
    statuses,
    categories,
    getEntity: (name: string) => entityByTable.get(name),
    getEntityByDisplayName: (name: string) => entityByDisplay.get(name.toLowerCase()),
    getEntitiesForUser: () => entities,
    getActionsForUser: (_cacheKey: string | undefined, table: string) => actionsByTable.get(table) ?? [],
    getProperties: (table: string) => propsByTable.get(table) ?? [],
    getPropertiesForUser: (_cacheKey: string | undefined, table: string) => propsByTable.get(table) ?? [],
    getActions: (table: string) => actionsByTable.get(table) ?? [],
    getStatuses: (type: string) => statusesByType.get(type) ?? [],
    getCategories: (type: string) => categoriesByType.get(type) ?? [],
  } as unknown as SchemaCache;
}

function makeMockClient(responses: Record<string, unknown[]> = {}): PostgRESTClient {
  return {
    get: vi.fn().mockImplementation((path: string, params?: Record<string, string>) => {
      const data = responses[path] ?? [];
      return Promise.resolve({ data, status: 200 });
    }),
  } as unknown as PostgRESTClient;
}

// ---------------------------------------------------------------------------
// Entity Resolution
// ---------------------------------------------------------------------------

describe('NameResolver.resolveEntity()', () => {
  it('resolves by exact table_name', () => {
    const cache = makeMockCache([makeEntity()], []);
    const resolver = new NameResolver(cache, makeMockClient());

    const entity = resolver.resolveEntity('projects');
    expect(entity.table_name).toBe('projects');
  });

  it('resolves by exact display_name (case-insensitive)', () => {
    const cache = makeMockCache([makeEntity({ display_name: 'My Projects' })], []);
    const resolver = new NameResolver(cache, makeMockClient());

    const entity = resolver.resolveEntity('my projects');
    expect(entity.table_name).toBe('projects');
  });

  it('resolves by display_name in upper case', () => {
    const cache = makeMockCache([makeEntity({ display_name: 'Projects' })], []);
    const resolver = new NameResolver(cache, makeMockClient());

    const entity = resolver.resolveEntity('PROJECTS');
    expect(entity.table_name).toBe('projects');
  });

  it('resolves by substring match (display_name contains search)', () => {
    const cache = makeMockCache([makeEntity({ display_name: 'Active Projects' })], []);
    const resolver = new NameResolver(cache, makeMockClient());

    const entity = resolver.resolveEntity('active');
    expect(entity.display_name).toBe('Active Projects');
  });

  it('throws NameResolutionError with candidates for ambiguous substring', () => {
    const entities = [
      makeEntity({ table_name: 'project_tasks', display_name: 'Project Tasks' }),
      makeEntity({ table_name: 'project_notes', display_name: 'Project Notes' }),
    ];
    const cache = makeMockCache(entities, []);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(() => resolver.resolveEntity('project')).toThrowError(NameResolutionError);
    try {
      resolver.resolveEntity('project');
    } catch (e) {
      const err = e as NameResolutionError;
      expect(err.message).toContain('Ambiguous entity name');
      expect(err.candidates).toHaveLength(2);
    }
  });

  it('throws NameResolutionError for completely unknown name', () => {
    const cache = makeMockCache([makeEntity()], []);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(() => resolver.resolveEntity('completely_unknown')).toThrowError(NameResolutionError);
    try {
      resolver.resolveEntity('completely_unknown');
    } catch (e) {
      const err = e as NameResolutionError;
      expect(err.message).toContain('not found');
      expect(err.candidates).toBeUndefined();
    }
  });

  it('trims whitespace before matching', () => {
    const cache = makeMockCache([makeEntity()], []);
    const resolver = new NameResolver(cache, makeMockClient());

    const entity = resolver.resolveEntity('  projects  ');
    expect(entity.table_name).toBe('projects');
  });
});

// ---------------------------------------------------------------------------
// Column Resolution
// ---------------------------------------------------------------------------

describe('NameResolver.resolveColumn()', () => {
  it('resolves by exact column_name', () => {
    const props = [makeProperty({ column_name: 'name', display_name: 'Name' })];
    const cache = makeMockCache([], props);
    const resolver = new NameResolver(cache, makeMockClient());

    const prop = resolver.resolveColumn('projects', 'name');
    expect(prop.column_name).toBe('name');
  });

  it('resolves by exact display_name (case-insensitive)', () => {
    const props = [makeProperty({ column_name: 'client_id', display_name: 'Client' })];
    const cache = makeMockCache([], props);
    const resolver = new NameResolver(cache, makeMockClient());

    const prop = resolver.resolveColumn('projects', 'client');
    expect(prop.column_name).toBe('client_id');
  });

  it('resolves by substring match on display_name', () => {
    const props = [makeProperty({ column_name: 'budget_amount', display_name: 'Budget Amount' })];
    const cache = makeMockCache([], props);
    const resolver = new NameResolver(cache, makeMockClient());

    const prop = resolver.resolveColumn('projects', 'budget');
    expect(prop.column_name).toBe('budget_amount');
  });

  it('throws NameResolutionError for ambiguous column substring', () => {
    const props = [
      makeProperty({ column_name: 'client_id', display_name: 'Client Name' }),
      makeProperty({ column_name: 'client_email', display_name: 'Client Email' }),
    ];
    const cache = makeMockCache([], props);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(() => resolver.resolveColumn('projects', 'client')).toThrowError(NameResolutionError);
    try {
      resolver.resolveColumn('projects', 'client');
    } catch (e) {
      const err = e as NameResolutionError;
      expect(err.message).toContain('Ambiguous column');
      expect(err.candidates).toHaveLength(2);
    }
  });

  it('throws NameResolutionError for unknown column', () => {
    const props = [makeProperty({ column_name: 'name', display_name: 'Name' })];
    const cache = makeMockCache([], props);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(() => resolver.resolveColumn('projects', 'nonexistent')).toThrowError(NameResolutionError);
    try {
      resolver.resolveColumn('projects', 'nonexistent');
    } catch (e) {
      const err = e as NameResolutionError;
      expect(err.message).toContain('not found');
    }
  });

  it('resolveFieldName() returns the column_name string', () => {
    const props = [makeProperty({ column_name: 'client_id', display_name: 'Client' })];
    const cache = makeMockCache([], props);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(resolver.resolveFieldName('projects', 'Client')).toBe('client_id');
  });
});

// ---------------------------------------------------------------------------
// FK Value Resolution
// ---------------------------------------------------------------------------

describe('NameResolver.resolveForeignKeyValue()', () => {
  it('returns ID on exact match', async () => {
    const client = makeMockClient({
      clients: [{ id: 42, display_name: 'Acme Corp' }],
    });
    // Exact match returns on first call
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: 42, display_name: 'Acme Corp' }],
      status: 200,
    });
    const cache = makeMockCache([], []);
    const resolver = new NameResolver(cache, client);

    const id = await resolver.resolveForeignKeyValue('clients', 'Acme Corp');
    expect(id).toBe(42);
  });

  it('falls back to ilike search when exact match returns nothing', async () => {
    const get = vi.fn();
    // First call (exact) returns empty; second call (ilike) returns one match
    get.mockResolvedValueOnce({ data: [], status: 200 });
    get.mockResolvedValueOnce({ data: [{ id: 7, display_name: 'Acme Corporation' }], status: 200 });

    const client = { get } as unknown as PostgRESTClient;
    const cache = makeMockCache([], []);
    const resolver = new NameResolver(cache, client);

    const id = await resolver.resolveForeignKeyValue('clients', 'acme corporation');
    expect(id).toBe(7);
  });

  it('throws NameResolutionError when multiple ilike matches', async () => {
    const get = vi.fn();
    get.mockResolvedValueOnce({ data: [], status: 200 });
    get.mockResolvedValueOnce({
      data: [
        { id: 1, display_name: 'Acme Corp' },
        { id: 2, display_name: 'Acme Ltd' },
      ],
      status: 200,
    });

    const client = { get } as unknown as PostgRESTClient;
    const cache = makeMockCache([], []);
    const resolver = new NameResolver(cache, client);

    await expect(resolver.resolveForeignKeyValue('clients', 'acme')).rejects.toThrowError(NameResolutionError);
    try {
      get.mockResolvedValueOnce({ data: [], status: 200 });
      get.mockResolvedValueOnce({
        data: [
          { id: 1, display_name: 'Acme Corp' },
          { id: 2, display_name: 'Acme Ltd' },
        ],
        status: 200,
      });
      await resolver.resolveForeignKeyValue('clients', 'acme');
    } catch (e) {
      const err = e as NameResolutionError;
      expect(err.candidates).toHaveLength(2);
    }
  });

  it('throws NameResolutionError when not found at all', async () => {
    const get = vi.fn();
    get.mockResolvedValueOnce({ data: [], status: 200 });
    get.mockResolvedValueOnce({ data: [], status: 200 });

    const client = { get } as unknown as PostgRESTClient;
    const cache = makeMockCache([], []);
    const resolver = new NameResolver(cache, client);

    await expect(resolver.resolveForeignKeyValue('clients', 'Ghost Inc')).rejects.toThrowError(NameResolutionError);
  });

  it('throws NameResolutionError for multiple exact matches', async () => {
    const get = vi.fn();
    get.mockResolvedValueOnce({
      data: [
        { id: 1, display_name: 'Duplicate' },
        { id: 2, display_name: 'Duplicate' },
      ],
      status: 200,
    });

    const client = { get } as unknown as PostgRESTClient;
    const cache = makeMockCache([], []);
    const resolver = new NameResolver(cache, client);

    await expect(resolver.resolveForeignKeyValue('clients', 'Duplicate')).rejects.toThrowError(NameResolutionError);
  });
});

// ---------------------------------------------------------------------------
// Status Resolution
// ---------------------------------------------------------------------------

describe('NameResolver.resolveStatus()', () => {
  const statuses: StatusOption[] = [
    { id: 1, display_name: 'Active', color: 'green', entity_type: 'projects', status_key: 'active' },
    { id: 2, display_name: 'Closed', color: 'red', entity_type: 'projects', status_key: 'closed' },
  ];

  it('resolves by display_name (case-insensitive)', () => {
    const cache = makeMockCache([], [], [], statuses);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(resolver.resolveStatus('projects', 'active')).toBe(1);
    expect(resolver.resolveStatus('projects', 'CLOSED')).toBe(2);
  });

  it('resolves by status_key', () => {
    const cache = makeMockCache([], [], [], statuses);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(resolver.resolveStatus('projects', 'active')).toBe(1);
  });

  it('resolves by status_key when display_name does not match', () => {
    const cache = makeMockCache([], [], [], statuses);
    const resolver = new NameResolver(cache, makeMockClient());

    // 'active' matches both display_name and status_key — display_name checked first
    // Test status_key-only lookup via a key that doesn't match display_name
    const statusesWithKey: StatusOption[] = [
      { id: 5, display_name: 'In Review', color: null, entity_type: 'projects', status_key: 'review' },
    ];
    const cache2 = makeMockCache([], [], [], statusesWithKey);
    const resolver2 = new NameResolver(cache2, makeMockClient());

    expect(resolver2.resolveStatus('projects', 'review')).toBe(5);
  });

  it('throws NameResolutionError for unknown status', () => {
    const cache = makeMockCache([], [], [], statuses);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(() => resolver.resolveStatus('projects', 'nonexistent')).toThrowError(NameResolutionError);
    try {
      resolver.resolveStatus('projects', 'nonexistent');
    } catch (e) {
      const err = e as NameResolutionError;
      expect(err.candidates).toHaveLength(2);
      expect(err.message).toContain('not found');
    }
  });

  it('throws NameResolutionError for wrong entity_type', () => {
    const cache = makeMockCache([], [], [], statuses);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(() => resolver.resolveStatus('tickets', 'Active')).toThrowError(NameResolutionError);
  });
});

// ---------------------------------------------------------------------------
// Category Resolution
// ---------------------------------------------------------------------------

describe('NameResolver.resolveCategory()', () => {
  const categories: CategoryOption[] = [
    { id: 10, display_name: 'Internal', color: 'blue', entity_type: 'projects' },
    { id: 11, display_name: 'External', color: 'orange', entity_type: 'projects' },
  ];

  it('resolves by display_name (case-insensitive)', () => {
    const cache = makeMockCache([], [], [], [], categories);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(resolver.resolveCategory('projects', 'internal')).toBe(10);
    expect(resolver.resolveCategory('projects', 'EXTERNAL')).toBe(11);
  });

  it('throws NameResolutionError for unknown category', () => {
    const cache = makeMockCache([], [], [], [], categories);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(() => resolver.resolveCategory('projects', 'Unknown')).toThrowError(NameResolutionError);
    try {
      resolver.resolveCategory('projects', 'Unknown');
    } catch (e) {
      const err = e as NameResolutionError;
      expect(err.candidates).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Action Resolution
// ---------------------------------------------------------------------------

describe('NameResolver.resolveAction()', () => {
  const actions: SchemaEntityAction[] = [
    makeAction({ id: 1, action_name: 'approve', display_name: 'Approve' }),
    makeAction({ id: 2, action_name: 'reject', display_name: 'Reject' }),
  ];

  it('resolves by exact action_name', () => {
    const cache = makeMockCache([], [], actions);
    const resolver = new NameResolver(cache, makeMockClient());

    const action = resolver.resolveAction('projects', 'approve');
    expect(action.id).toBe(1);
  });

  it('resolves by exact display_name (case-insensitive)', () => {
    const cache = makeMockCache([], [], actions);
    const resolver = new NameResolver(cache, makeMockClient());

    const action = resolver.resolveAction('projects', 'REJECT');
    expect(action.id).toBe(2);
  });

  it('resolves by substring match', () => {
    const specificActions: SchemaEntityAction[] = [
      makeAction({ id: 3, action_name: 'send_notification', display_name: 'Send Notification' }),
    ];
    const cache = makeMockCache([], [], specificActions);
    const resolver = new NameResolver(cache, makeMockClient());

    const action = resolver.resolveAction('projects', 'notification');
    expect(action.id).toBe(3);
  });

  it('throws NameResolutionError for ambiguous action', () => {
    const ambiguousActions: SchemaEntityAction[] = [
      makeAction({ id: 1, action_name: 'send_email', display_name: 'Send Email' }),
      makeAction({ id: 2, action_name: 'send_sms', display_name: 'Send SMS' }),
    ];
    const cache = makeMockCache([], [], ambiguousActions);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(() => resolver.resolveAction('projects', 'send')).toThrowError(NameResolutionError);
  });

  it('throws NameResolutionError for unknown action', () => {
    const cache = makeMockCache([], [], actions);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(() => resolver.resolveAction('projects', 'nonexistent')).toThrowError(NameResolutionError);
  });

  it('throws NameResolutionError for table with no actions', () => {
    const cache = makeMockCache([], [], []);
    const resolver = new NameResolver(cache, makeMockClient());

    expect(() => resolver.resolveAction('projects', 'approve')).toThrowError(NameResolutionError);
    try {
      resolver.resolveAction('projects', 'approve');
    } catch (e) {
      const err = e as NameResolutionError;
      expect(err.message).toContain('none');
    }
  });
});

// ---------------------------------------------------------------------------
// NameResolutionError
// ---------------------------------------------------------------------------

describe('NameResolutionError', () => {
  it('has name NameResolutionError', () => {
    const err = new NameResolutionError('test');
    expect(err.name).toBe('NameResolutionError');
  });

  it('stores candidates', () => {
    const err = new NameResolutionError('test', ['A', 'B']);
    expect(err.candidates).toEqual(['A', 'B']);
  });

  it('candidates is undefined when not provided', () => {
    const err = new NameResolutionError('test');
    expect(err.candidates).toBeUndefined();
  });

  it('is an instance of Error', () => {
    const err = new NameResolutionError('test');
    expect(err).toBeInstanceOf(Error);
  });
});
