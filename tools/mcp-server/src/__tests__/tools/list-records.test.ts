/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for the list_records tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerListRecords } from '../../tools/list-records.js';
import { PostgRESTRequestError } from '../../postgrest-client.js';
import type { PostgRESTClient } from '../../postgrest-client.js';
import type { SchemaCache } from '../../schema-cache.js';
import type { NameResolver } from '../../name-resolver.js';
import type { SchemaEntity, SchemaProperty } from '../../interfaces.js';
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
    show_on_list: true,
    type: EntityPropertyType.TextShort,
    ...overrides,
  };
}

type MockClientGet = ReturnType<typeof vi.fn>;

function makeMockClient(
  records: Record<string, unknown>[] = [],
  total: number | null = null,
): { client: PostgRESTClient; mockGet: MockClientGet } {
  const mockGet = vi.fn().mockResolvedValue({
    data: records,
    status: 200,
    contentRange: total !== null ? { from: 0, to: records.length - 1, total } : undefined,
  });

  const client = {
    get: mockGet,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    setToken: vi.fn(),
  } as unknown as PostgRESTClient;

  return { client, mockGet };
}

function makeMockCache(
  entity: SchemaEntity,
  properties: SchemaProperty[] = [],
): SchemaCache {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    entities: [entity],
    getProperties: vi.fn().mockReturnValue(properties),
    getActions: vi.fn().mockReturnValue([]),
    getStatuses: vi.fn().mockReturnValue([]),
    getCategories: vi.fn().mockReturnValue([]),
    constraintMessages: [],
  } as unknown as SchemaCache;
}

function makeMockResolver(entity: SchemaEntity, properties: SchemaProperty[] = []): NameResolver {
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

describe('list_records tool', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.0' });
  });

  it('registers the tool without throwing', () => {
    const entity = makeEntity();
    const { client } = makeMockClient();
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    expect(() => registerListRecords(server, client, cache, resolver)).not.toThrow();
  });

  it('calls cache.ensureFresh on invocation', async () => {
    const entity = makeEntity();
    const { client } = makeMockClient([]);
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', { entity: 'clients' });

    expect(cache.ensureFresh).toHaveBeenCalledOnce();
  });

  it('calls resolver.resolveEntity with the entity name', async () => {
    const entity = makeEntity();
    const { client } = makeMockClient([]);
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', { entity: 'Clients' });

    expect(resolver.resolveEntity).toHaveBeenCalledWith('Clients');
  });

  it('passes the correct table name to client.get', async () => {
    const entity = makeEntity({ table_name: 'work_orders', display_name: 'Work Orders' });
    const { client, mockGet } = makeMockClient([]);
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', { entity: 'work_orders' });

    expect(mockGet).toHaveBeenCalledWith(
      'work_orders',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('renders records in markdown table format', async () => {
    const entity = makeEntity();
    const props = [makeProperty({ column_name: 'name', display_name: 'Name', show_on_list: true })];
    const { client } = makeMockClient([
      { id: 1, name: 'Acme Corp' },
      { id: 2, name: 'Widgets Inc' },
    ], 2);
    const cache = makeMockCache(entity, props);
    const resolver = makeMockResolver(entity, props);
    registerListRecords(server, client, cache, resolver);

    const result = await callTool(server, 'list_records', { entity: 'clients' });
    const text = result.content[0].text;

    // Markdown table structure
    expect(text).toContain('|');
    expect(text).toContain('Acme Corp');
    expect(text).toContain('Widgets Inc');
  });

  it('includes total count in summary when content-range is returned', async () => {
    const entity = makeEntity({ display_name: 'Clients', table_name: 'clients' });
    const { client } = makeMockClient([{ id: 1, name: 'Acme' }], 42);
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerListRecords(server, client, cache, resolver);

    const result = await callTool(server, 'list_records', { entity: 'clients' });

    expect(result.content[0].text).toContain('42 total record');
  });

  it('applies a default limit of 25', async () => {
    const entity = makeEntity();
    const { client, mockGet } = makeMockClient([]);
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', { entity: 'clients' });

    // Range header: offset=0, limit=25 → "0-24"
    const callHeaders = mockGet.mock.calls[0][2] as Record<string, string>;
    expect(callHeaders['Range']).toBe('0-24');
  });

  it('applies custom limit and offset', async () => {
    const entity = makeEntity();
    const { client, mockGet } = makeMockClient([]);
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', { entity: 'clients', limit: 10, offset: 30 });

    const callHeaders = mockGet.mock.calls[0][2] as Record<string, string>;
    expect(callHeaders['Range']).toBe('30-39');
  });

  it('applies fulltext search when entity has fulltext_search_column', async () => {
    const entity = makeEntity({ fulltext_search_column: 'search_vector' });
    const { client, mockGet } = makeMockClient([]);
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', { entity: 'clients', search: 'acme' });

    const callParams = mockGet.mock.calls[0][1] as Record<string, string>;
    expect(callParams['search_vector']).toBe('wfts.acme');
  });

  it('applies substring search when entity has substring_search_column but no fts column', async () => {
    const entity = makeEntity({ fulltext_search_column: null, substring_search_column: 'name' });
    const { client, mockGet } = makeMockClient([]);
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', { entity: 'clients', search: 'acme' });

    const callParams = mockGet.mock.calls[0][1] as Record<string, string>;
    expect(callParams['name']).toBe('ilike.*acme*');
  });

  it('applies filters with eq operator', async () => {
    const entity = makeEntity();
    const statusProp = makeProperty({ column_name: 'status', display_name: 'Status', type: EntityPropertyType.TextShort });
    const { client, mockGet } = makeMockClient([]);
    const cache = makeMockCache(entity, [statusProp]);
    const resolver = makeMockResolver(entity, [statusProp]);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', {
      entity: 'clients',
      filters: [{ field: 'status', operator: 'eq', value: 'active' }],
    });

    const callParams = mockGet.mock.calls[0][1] as Record<string, string>;
    expect(callParams['status']).toBe('eq.active');
  });

  it('applies filters with in operator using array value', async () => {
    const entity = makeEntity();
    const idProp = makeProperty({ column_name: 'id', display_name: 'ID', type: EntityPropertyType.IntegerNumber });
    const { client, mockGet } = makeMockClient([]);
    const cache = makeMockCache(entity, [idProp]);
    const resolver = makeMockResolver(entity, [idProp]);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', {
      entity: 'clients',
      filters: [{ field: 'id', operator: 'in', value: [1, 2, 3] }],
    });

    const callParams = mockGet.mock.calls[0][1] as Record<string, string>;
    expect(callParams['id']).toBe('in.(1,2,3)');
  });

  it('applies filters with is operator (null check)', async () => {
    const entity = makeEntity();
    const prop = makeProperty({ column_name: 'deleted_at', display_name: 'Deleted At' });
    const { client, mockGet } = makeMockClient([]);
    const cache = makeMockCache(entity, [prop]);
    const resolver = makeMockResolver(entity, [prop]);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', {
      entity: 'clients',
      filters: [{ field: 'deleted_at', operator: 'is', value: null }],
    });

    const callParams = mockGet.mock.calls[0][1] as Record<string, string>;
    expect(callParams['deleted_at']).toBe('is.null');
  });

  it('applies sort ascending by column name', async () => {
    const entity = makeEntity();
    const prop = makeProperty({ column_name: 'name', display_name: 'Name' });
    const { client, mockGet } = makeMockClient([]);
    const cache = makeMockCache(entity, [prop]);
    const resolver = makeMockResolver(entity, [prop]);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', { entity: 'clients', sort: 'name' });

    const callParams = mockGet.mock.calls[0][1] as Record<string, string>;
    expect(callParams['order']).toBe('name.asc');
  });

  it('applies sort descending when prefixed with -', async () => {
    const entity = makeEntity();
    const prop = makeProperty({ column_name: 'created_at', display_name: 'Created At' });
    const { client, mockGet } = makeMockClient([]);
    const cache = makeMockCache(entity, [prop]);
    const resolver = makeMockResolver(entity, [prop]);
    registerListRecords(server, client, cache, resolver);

    await callTool(server, 'list_records', { entity: 'clients', sort: '-created_at' });

    const callParams = mockGet.mock.calls[0][1] as Record<string, string>;
    expect(callParams['order']).toBe('created_at.desc');
  });

  it('returns isError and human message on PostgRESTRequestError', async () => {
    const entity = makeEntity();
    const { client } = makeMockClient([]);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PostgRESTRequestError('Permission denied', 403, '42501'),
    );
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerListRecords(server, client, cache, resolver);

    const result = await callTool(server, 'list_records', { entity: 'clients' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Permission denied');
  });

  it('re-throws non-PostgREST errors', async () => {
    const entity = makeEntity();
    const { client } = makeMockClient([]);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Unexpected network failure'));
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerListRecords(server, client, cache, resolver);

    await expect(callTool(server, 'list_records', { entity: 'clients' }))
      .rejects.toThrow('Unexpected network failure');
  });

  it('shows "no records found" message when list is empty', async () => {
    const entity = makeEntity();
    const { client } = makeMockClient([], 0);
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerListRecords(server, client, cache, resolver);

    const result = await callTool(server, 'list_records', { entity: 'clients' });

    expect(result.content[0].text).toContain('No records found');
  });
});
