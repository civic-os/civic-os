/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for per-user permission caching in SchemaCache.
 */

import { describe, it, expect, vi } from 'vitest';
import { SchemaCache } from '../schema-cache.js';
import type { PostgRESTClient } from '../postgrest-client.js';
import type {
  SchemaEntity,
  SchemaEntityAction,
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
  insert: false,
  select: true,
  update: false,
  delete: false,
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
  can_execute: false,
  parameters: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock client builders
// ---------------------------------------------------------------------------

/** Anonymous client — returns entities with anonymous permissions */
function makeAnonClient(): PostgRESTClient {
  return {
    get: vi.fn().mockImplementation((path: string) => {
      const defaults: Record<string, unknown[]> = {
        schema_entities: [makeEntity({ insert: false, update: false, delete: false })],
        schema_properties: [],
        schema_entity_actions: [makeAction({ can_execute: false })],
        statuses: [],
        categories: [],
        status_transitions: [],
        constraint_messages: [],
        schema_cache_versions: [
          { cache_name: 'entities', version: '2024-01-01T00:00:00Z' },
        ],
      };
      return Promise.resolve({ data: defaults[path] ?? [], status: 200 });
    }),
  } as unknown as PostgRESTClient;
}

/** Authenticated client — returns entities with elevated permissions */
function makeUserClient(perms: Partial<SchemaEntity> = {}, actionPerms: Partial<SchemaEntityAction> = {}): PostgRESTClient {
  return {
    get: vi.fn().mockImplementation((path: string) => {
      const defaults: Record<string, unknown[]> = {
        schema_entities: [makeEntity({ insert: true, update: true, delete: false, ...perms })],
        schema_entity_actions: [makeAction({ can_execute: true, ...actionPerms })],
      };
      return Promise.resolve({ data: defaults[path] ?? [], status: 200 });
    }),
  } as unknown as PostgRESTClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchemaCache per-user caching', () => {
  it('getEntitiesForUser(undefined) returns shared anonymous entities', async () => {
    const anonClient = makeAnonClient();
    const cache = new SchemaCache(anonClient, 'http://localhost:3000');
    await cache.initialize();

    const entities = cache.getEntitiesForUser(undefined);
    expect(entities).toHaveLength(1);
    expect(entities[0].insert).toBe(false); // anonymous permissions
  });

  it('getActionsForUser(undefined, table) returns shared anonymous actions', async () => {
    const anonClient = makeAnonClient();
    const cache = new SchemaCache(anonClient, 'http://localhost:3000');
    await cache.initialize();

    const actions = cache.getActionsForUser(undefined, 'projects');
    expect(actions).toHaveLength(1);
    expect(actions[0].can_execute).toBe(false); // anonymous permissions
  });

  it('ensureFreshForUser() fetches entities/actions with user client', async () => {
    const anonClient = makeAnonClient();
    const cache = new SchemaCache(anonClient, 'http://localhost:3000');
    await cache.initialize();

    const userClient = makeUserClient();
    const cacheKey = 'user-123:sigfingerprintxx';

    await cache.ensureFreshForUser(userClient, cacheKey);

    // User client should have been called for both entities and actions
    const calls = (userClient.get as ReturnType<typeof vi.fn>).mock.calls as string[][];
    const paths = calls.map(c => c[0]);
    expect(paths).toContain('schema_entities');
    expect(paths).toContain('schema_entity_actions');
  });

  it('per-user cache returns user-specific permission flags', async () => {
    const anonClient = makeAnonClient();
    const cache = new SchemaCache(anonClient, 'http://localhost:3000');
    await cache.initialize();

    const userClient = makeUserClient();
    const cacheKey = 'user-123:sigfingerprintxx';
    await cache.ensureFreshForUser(userClient, cacheKey);

    // Anonymous should have insert=false
    const anonEntities = cache.getEntitiesForUser(undefined);
    expect(anonEntities[0].insert).toBe(false);

    // User should have insert=true
    const userEntities = cache.getEntitiesForUser(cacheKey);
    expect(userEntities[0].insert).toBe(true);
  });

  it('per-user cache returns user-specific action permissions', async () => {
    const anonClient = makeAnonClient();
    const cache = new SchemaCache(anonClient, 'http://localhost:3000');
    await cache.initialize();

    const userClient = makeUserClient();
    const cacheKey = 'user-123:sigfingerprintxx';
    await cache.ensureFreshForUser(userClient, cacheKey);

    // Anonymous actions have can_execute=false
    const anonActions = cache.getActionsForUser(undefined, 'projects');
    expect(anonActions[0].can_execute).toBe(false);

    // User actions have can_execute=true
    const userActions = cache.getActionsForUser(cacheKey, 'projects');
    expect(userActions[0].can_execute).toBe(true);
  });

  it('multiple users get separate cache entries', async () => {
    const anonClient = makeAnonClient();
    const cache = new SchemaCache(anonClient, 'http://localhost:3000');
    await cache.initialize();

    // User 1: editor (insert=true, delete=false)
    const user1Client = makeUserClient({ insert: true, delete: false });
    await cache.ensureFreshForUser(user1Client, 'user-1:sig1111111111111');

    // User 2: admin (insert=true, delete=true)
    const user2Client = makeUserClient({ insert: true, delete: true });
    await cache.ensureFreshForUser(user2Client, 'user-2:sig2222222222222');

    const user1Entities = cache.getEntitiesForUser('user-1:sig1111111111111');
    const user2Entities = cache.getEntitiesForUser('user-2:sig2222222222222');

    expect(user1Entities[0].delete).toBe(false);
    expect(user2Entities[0].delete).toBe(true);
  });

  it('version change invalidates per-user caches on next ensureFreshForUser', async () => {
    let version = '2024-01-01T00:00:00Z';
    const anonClient = {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === 'schema_cache_versions') {
          return Promise.resolve({
            data: [{ cache_name: 'entities', version: version }],
            status: 200,
          });
        }
        const defaults: Record<string, unknown[]> = {
          schema_entities: [makeEntity()],
          schema_properties: [],
          schema_entity_actions: [makeAction()],
          statuses: [],
          categories: [],
          status_transitions: [],
          constraint_messages: [],
        };
        return Promise.resolve({ data: defaults[path] ?? [], status: 200 });
      }),
    } as unknown as PostgRESTClient;

    const cache = new SchemaCache(anonClient, 'http://localhost:3000');
    await cache.initialize();

    const userClient = makeUserClient();
    const cacheKey = 'user-123:sigfingerprintxx';
    await cache.ensureFreshForUser(userClient, cacheKey);

    // Reset call count
    (userClient.get as ReturnType<typeof vi.fn>).mockClear();

    // Same version — should NOT re-fetch
    await cache.ensureFreshForUser(userClient, cacheKey);
    expect((userClient.get as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

    // Simulate version change
    version = '2024-06-01T00:00:00Z';
    await cache.ensureFreshForUser(userClient, cacheKey);

    // Should have re-fetched entities + actions
    const paths = (userClient.get as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
    expect(paths).toContain('schema_entities');
    expect(paths).toContain('schema_entity_actions');
  });

  it('getEntityForUser returns per-user entity by table name', async () => {
    const anonClient = makeAnonClient();
    const cache = new SchemaCache(anonClient, 'http://localhost:3000');
    await cache.initialize();

    const userClient = makeUserClient({ insert: true });
    const cacheKey = 'user-123:sigfingerprintxx';
    await cache.ensureFreshForUser(userClient, cacheKey);

    // Anonymous
    const anonEntity = cache.getEntityForUser(undefined, 'projects');
    expect(anonEntity?.insert).toBe(false);

    // User
    const userEntity = cache.getEntityForUser(cacheKey, 'projects');
    expect(userEntity?.insert).toBe(true);
  });

  it('getEntityByDisplayNameForUser returns per-user entity (case-insensitive)', async () => {
    const anonClient = makeAnonClient();
    const cache = new SchemaCache(anonClient, 'http://localhost:3000');
    await cache.initialize();

    const userClient = makeUserClient({ update: true });
    const cacheKey = 'user-123:sigfingerprintxx';
    await cache.ensureFreshForUser(userClient, cacheKey);

    const entity = cache.getEntityByDisplayNameForUser(cacheKey, 'PROJECTS');
    expect(entity?.update).toBe(true);
  });

  it('gracefully handles per-user fetch failure', async () => {
    const anonClient = makeAnonClient();
    const cache = new SchemaCache(anonClient, 'http://localhost:3000');
    await cache.initialize();

    const failingClient = {
      get: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as PostgRESTClient;

    const cacheKey = 'user-456:sigfingerprintxx';
    // Should not throw
    await expect(cache.ensureFreshForUser(failingClient, cacheKey)).resolves.not.toThrow();

    // Falls back to shared entities
    const entities = cache.getEntitiesForUser(cacheKey);
    expect(entities[0].insert).toBe(false); // anonymous permissions
  });

  it('skips per-user fetch for undefined cacheKey', async () => {
    const anonClient = makeAnonClient();
    const cache = new SchemaCache(anonClient, 'http://localhost:3000');
    await cache.initialize();

    const userClient = makeUserClient();
    await cache.ensureFreshForUser(userClient, undefined);

    // Should NOT have called userClient — anonymous callers use shared cache
    expect((userClient.get as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
