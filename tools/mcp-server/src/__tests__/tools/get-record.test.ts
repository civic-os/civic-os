/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for the get_record tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerGetRecord } from '../../tools/get-record.js';
import { PostgRESTRequestError } from '../../postgrest-client.js';
import type { PostgRESTClient } from '../../postgrest-client.js';
import type { SchemaCache } from '../../schema-cache.js';
import type { NameResolver } from '../../name-resolver.js';
import type { SchemaEntity, SchemaProperty, SchemaEntityAction } from '../../interfaces.js';
import { EntityPropertyType } from '../../interfaces.js';

// ============================================================================
// Helpers
// ============================================================================

async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { executor: (args: unknown) => Promise<unknown> }>;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.executor(args) as Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

// ============================================================================
// Fixtures
// ============================================================================

function makeEntity(overrides: Partial<SchemaEntity> = {}): SchemaEntity {
  return {
    display_name: 'Clients',
    table_name: 'clients',
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
    table_name: 'clients',
    column_name: 'name',
    display_name: 'Name',
    data_type: 'text',
    udt_name: 'text',
    udt_schema: 'pg_catalog',
    sort_order: 1,
    join_schema: '',
    join_table: '',
    join_column: '',
    geography_type: '',
    is_nullable: false,
    is_updatable: true,
    is_identity: false,
    is_generated: false,
    is_self_referencing: false,
    column_default: '',
    show_on_detail: true,
    type: EntityPropertyType.TextShort,
    ...overrides,
  };
}

function makeAction(overrides: Partial<SchemaEntityAction> = {}): SchemaEntityAction {
  return {
    id: 1,
    table_name: 'clients',
    action_name: 'approve',
    display_name: 'Approve',
    description: 'Approves the client',
    rpc_function: 'approve_client',
    button_style: 'primary',
    sort_order: 1,
    requires_confirmation: false,
    refresh_after_action: false,
    show_on_detail: true,
    can_execute: true,
    parameters: [],
    ...overrides,
  };
}

function makeMockClient(
  records: Record<string, unknown>[] = [],
  etag?: string,
): PostgRESTClient {
  return {
    get: vi.fn().mockResolvedValue({
      data: records,
      status: 200,
      etag,
    }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    setToken: vi.fn(),
  } as unknown as PostgRESTClient;
}

function makeMockCache(
  entity: SchemaEntity,
  properties: SchemaProperty[] = [],
  actions: SchemaEntityAction[] = [],
): SchemaCache {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    entities: [entity],
    getProperties: vi.fn().mockReturnValue(properties),
    getActions: vi.fn().mockReturnValue(actions),
    getStatuses: vi.fn().mockReturnValue([]),
    getCategories: vi.fn().mockReturnValue([]),
    constraintMessages: [],
  } as unknown as SchemaCache;
}

function makeMockResolver(
  entity: SchemaEntity,
  properties: SchemaProperty[] = [],
): NameResolver {
  const resolveColumn = vi.fn().mockImplementation((_, name: string) =>
    properties.find(p => p.column_name === name || p.display_name.toLowerCase() === name.toLowerCase()) ??
    makeProperty({ column_name: name, display_name: name }),
  );

  return {
    resolveEntity: vi.fn().mockReturnValue(entity),
    resolveColumn,
    resolveForeignKeyValue: vi.fn(),
    resolveStatus: vi.fn(),
    resolveCategory: vi.fn(),
    resolveAction: vi.fn(),
    resolveData: vi.fn(),
  } as unknown as NameResolver;
}

// ============================================================================
// Tests
// ============================================================================

describe('get_record tool', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.0' });
  });

  it('registers the tool without throwing', () => {
    const entity = makeEntity();
    const client = makeMockClient();
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    expect(() => registerGetRecord(server, client, cache, resolver)).not.toThrow();
  });

  it('calls cache.ensureFresh on invocation', async () => {
    const entity = makeEntity();
    const client = makeMockClient([{ id: 1, name: 'Acme' }]);
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerGetRecord(server, client, cache, resolver);

    await callTool(server, 'get_record', { entity: 'clients', id: 1 });

    expect(cache.ensureFresh).toHaveBeenCalledOnce();
  });

  it('renders record detail with entity name and id in header', async () => {
    const entity = makeEntity({ display_name: 'Clients' });
    const client = makeMockClient([{ id: 42, name: 'Acme Corp' }]);
    const props = [makeProperty()];
    const cache = makeMockCache(entity, props);
    const resolver = makeMockResolver(entity, props);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 42 });
    const text = result.content[0].text;

    expect(text).toContain('# Clients #42');
  });

  it('returns isError and "not found" message when record is missing', async () => {
    const entity = makeEntity();
    const client = makeMockClient([]); // empty → not found
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 99 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('includes ETag in output when returned by client', async () => {
    const entity = makeEntity();
    const client = makeMockClient([{ id: 1, name: 'Acme' }], '"abc123"');
    const props = [makeProperty()];
    const cache = makeMockCache(entity, props);
    const resolver = makeMockResolver(entity, props);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 1 });

    expect(result.content[0].text).toContain('"abc123"');
    expect(result.content[0].text).toContain('ETag');
  });

  it('does not include ETag section when client returns no etag', async () => {
    const entity = makeEntity();
    const client = makeMockClient([{ id: 1, name: 'Acme' }]); // no etag
    const props = [makeProperty()];
    const cache = makeMockCache(entity, props);
    const resolver = makeMockResolver(entity, props);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 1 });

    expect(result.content[0].text).not.toContain('ETag');
  });

  it('shows available actions that pass visibility conditions', async () => {
    const entity = makeEntity();
    const action = makeAction({
      display_name: 'Approve',
      action_name: 'approve',
      can_execute: true,
      show_on_detail: true,
      visibility_condition: undefined,
    });
    const client = makeMockClient([{ id: 1, name: 'Acme' }]);
    const cache = makeMockCache(entity, [], [action]);
    const resolver = makeMockResolver(entity);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 1 });
    const text = result.content[0].text;

    expect(text).toContain('## Available Actions');
    expect(text).toContain('Approve');
  });

  it('hides actions where can_execute=false', async () => {
    const entity = makeEntity();
    const action = makeAction({ display_name: 'Delete', can_execute: false, show_on_detail: true });
    const client = makeMockClient([{ id: 1, name: 'Acme' }]);
    const cache = makeMockCache(entity, [], [action]);
    const resolver = makeMockResolver(entity);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 1 });

    expect(result.content[0].text).not.toContain('Delete');
    expect(result.content[0].text).not.toContain('## Available Actions');
  });

  it('hides actions where show_on_detail=false', async () => {
    const entity = makeEntity();
    const action = makeAction({ display_name: 'Export', can_execute: true, show_on_detail: false });
    const client = makeMockClient([{ id: 1, name: 'Acme' }]);
    const cache = makeMockCache(entity, [], [action]);
    const resolver = makeMockResolver(entity);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 1 });

    expect(result.content[0].text).not.toContain('## Available Actions');
  });

  it('evaluates visibility_condition and hides action when condition fails', async () => {
    const entity = makeEntity();
    const action = makeAction({
      display_name: 'Approve',
      can_execute: true,
      show_on_detail: true,
      // Only show when status_id equals 1 (pending)
      visibility_condition: { field: 'status_id', operator: 'eq', value: 1 },
    });
    // Record has status_id=2 → condition fails → action hidden
    const client = makeMockClient([{ id: 1, name: 'Acme', status_id: 2 }]);
    const cache = makeMockCache(entity, [], [action]);
    const resolver = makeMockResolver(entity);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 1 });

    expect(result.content[0].text).not.toContain('Approve');
  });

  it('evaluates visibility_condition and shows action when condition passes', async () => {
    const entity = makeEntity();
    const action = makeAction({
      display_name: 'Approve',
      can_execute: true,
      show_on_detail: true,
      visibility_condition: { field: 'status_id', operator: 'eq', value: 1 },
    });
    // Record has status_id=1 → condition passes → action visible
    const client = makeMockClient([{ id: 1, name: 'Acme', status_id: 1 }]);
    const cache = makeMockCache(entity, [], [action]);
    const resolver = makeMockResolver(entity);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 1 });

    expect(result.content[0].text).toContain('Approve');
  });

  it('marks disabled actions with tooltip when enabled_condition fails', async () => {
    const entity = makeEntity();
    const action = makeAction({
      display_name: 'Archive',
      can_execute: true,
      show_on_detail: true,
      enabled_condition: { field: 'is_active', operator: 'eq', value: true },
      disabled_tooltip: 'Already archived',
    });
    // Record has is_active=false → enabled_condition fails → action shown but disabled
    const client = makeMockClient([{ id: 1, name: 'Acme', is_active: false }]);
    const cache = makeMockCache(entity, [], [action]);
    const resolver = makeMockResolver(entity);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 1 });
    const text = result.content[0].text;

    expect(text).toContain('Archive');
    expect(text).toContain('disabled');
    expect(text).toContain('Already archived');
  });

  it('returns isError and human message on PostgRESTRequestError', async () => {
    const entity = makeEntity();
    const client = makeMockClient([]);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PostgRESTRequestError('Not found', 404),
    );
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 1 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Record not found');
  });

  it('re-throws non-PostgREST errors', async () => {
    const entity = makeEntity();
    const client = makeMockClient([]);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB connection lost'));
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerGetRecord(server, client, cache, resolver);

    await expect(callTool(server, 'get_record', { entity: 'clients', id: 1 }))
      .rejects.toThrow('DB connection lost');
  });

  it('passes select with timestamps when building the query', async () => {
    const entity = makeEntity({ table_name: 'clients' });
    const client = makeMockClient([{ id: 1, name: 'Acme' }]);
    const props = [makeProperty()];
    const cache = makeMockCache(entity, props);
    const resolver = makeMockResolver(entity, props);
    registerGetRecord(server, client, cache, resolver);

    await callTool(server, 'get_record', { entity: 'clients', id: 1 });

    const callParams = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, string>;
    // buildSelectString with includeTimestamps includes created_at and updated_at
    expect(callParams['select']).toContain('created_at');
    expect(callParams['select']).toContain('updated_at');
  });

  it('renders property values in the output', async () => {
    const entity = makeEntity();
    const props = [
      makeProperty({ column_name: 'email', display_name: 'Email', type: EntityPropertyType.Email }),
    ];
    const client = makeMockClient([{ id: 1, email: 'acme@example.com' }]);
    const cache = makeMockCache(entity, props);
    const resolver = makeMockResolver(entity, props);
    registerGetRecord(server, client, cache, resolver);

    const result = await callTool(server, 'get_record', { entity: 'clients', id: 1 });

    expect(result.content[0].text).toContain('acme@example.com');
  });
});
