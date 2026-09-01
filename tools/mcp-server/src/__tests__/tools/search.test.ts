/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for the search tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerSearch } from '../../tools/search.js';
import { PostgRESTRequestError } from '../../postgrest-client.js';
import type { PostgRESTClient } from '../../postgrest-client.js';
import type { SchemaCache } from '../../schema-cache.js';
import type { NameResolver } from '../../name-resolver.js';
import type { SchemaEntity } from '../../interfaces.js';

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
    fulltext_search_column: null,
    substring_search_column: null,
    ...overrides,
  };
}

function makeMockClient(): PostgRESTClient {
  return {
    get: vi.fn().mockResolvedValue({ data: [], status: 200 }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    setToken: vi.fn(),
  } as unknown as PostgRESTClient;
}

function makeMockCache(entities: SchemaEntity[]): SchemaCache {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    ensureFreshForUser: vi.fn().mockResolvedValue(undefined),
    entities,
    getEntitiesForUser: vi.fn().mockReturnValue(entities),
    getProperties: vi.fn().mockReturnValue([]),
    getActions: vi.fn().mockReturnValue([]),
    getActionsForUser: vi.fn().mockReturnValue([]),
    constraintMessages: [],
  } as unknown as SchemaCache;
}

function makeMockResolver(entity?: SchemaEntity): NameResolver {
  return {
    resolveEntity: vi.fn().mockReturnValue(entity ?? makeEntity()),
    resolveColumn: vi.fn(),
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

describe('search tool', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.0' });
  });

  it('registers the tool without throwing', () => {
    const cache = makeMockCache([]);
    const client = makeMockClient();
    const resolver = makeMockResolver();
    expect(() => registerSearch(server, client, cache, resolver)).not.toThrow();
  });

  it('calls cache.ensureFresh on invocation', async () => {
    const cache = makeMockCache([]);
    const client = makeMockClient();
    const resolver = makeMockResolver();
    registerSearch(server, client, cache, resolver);

    await callTool(server, 'search', { query: 'test' });

    expect(cache.ensureFreshForUser).toHaveBeenCalledOnce();
  });

  it('returns "no searchable entities" when none have search columns', async () => {
    const entities = [
      makeEntity({ fulltext_search_column: null, substring_search_column: null }),
    ];
    const cache = makeMockCache(entities);
    const client = makeMockClient();
    const resolver = makeMockResolver();
    registerSearch(server, client, cache, resolver);

    const result = await callTool(server, 'search', { query: 'test' });

    expect(result.content[0].text).toContain('No searchable entities found');
  });

  it('returns "no searchable entities" when all entities have select=false', async () => {
    const entities = [
      makeEntity({ select: false, fulltext_search_column: 'search_vector' }),
    ];
    const cache = makeMockCache(entities);
    const client = makeMockClient();
    const resolver = makeMockResolver();
    registerSearch(server, client, cache, resolver);

    const result = await callTool(server, 'search', { query: 'test' });

    expect(result.content[0].text).toContain('No searchable entities found');
  });

  it('uses FTS operator for entities with fulltext_search_column', async () => {
    const entity = makeEntity({ fulltext_search_column: 'search_vector' });
    const cache = makeMockCache([entity]);
    const client = makeMockClient();
    const resolver = makeMockResolver(entity);
    registerSearch(server, client, cache, resolver);

    await callTool(server, 'search', { query: 'acme' });

    expect(client.get).toHaveBeenCalledWith(
      'clients',
      expect.objectContaining({ search_vector: 'wfts.acme' }),
      expect.any(Object),
    );
  });

  it('uses ILIKE operator for entities with substring_search_column only', async () => {
    const entity = makeEntity({
      fulltext_search_column: null,
      substring_search_column: 'name',
    });
    const cache = makeMockCache([entity]);
    const client = makeMockClient();
    const resolver = makeMockResolver(entity);
    registerSearch(server, client, cache, resolver);

    await callTool(server, 'search', { query: 'acme' });

    expect(client.get).toHaveBeenCalledWith(
      'clients',
      expect.objectContaining({ name: 'ilike.*acme*' }),
      expect.any(Object),
    );
  });

  it('includes results in output grouped by entity', async () => {
    const entity = makeEntity({ display_name: 'Clients', fulltext_search_column: 'search_vector' });
    const cache = makeMockCache([entity]);
    const client = makeMockClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        { id: 1, display_name: 'Acme Corp' },
        { id: 2, display_name: 'Beta Ltd' },
      ],
      status: 200,
      contentRange: { from: 0, to: 1, total: 2 },
    });
    const resolver = makeMockResolver(entity);
    registerSearch(server, client, cache, resolver);

    const result = await callTool(server, 'search', { query: 'acme' });
    const text = result.content[0].text;

    expect(text).toContain('### Clients');
    expect(text).toContain('Acme Corp');
    expect(text).toContain('Beta Ltd');
  });

  it('shows total result count in the header', async () => {
    const entity = makeEntity({ fulltext_search_column: 'search_vector' });
    const cache = makeMockCache([entity]);
    const client = makeMockClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: 1, display_name: 'Acme' }],
      status: 200,
      contentRange: { from: 0, to: 0, total: 1 },
    });
    const resolver = makeMockResolver(entity);
    registerSearch(server, client, cache, resolver);

    const result = await callTool(server, 'search', { query: 'acme' });

    expect(result.content[0].text).toContain('Found 1 total result');
  });

  it('shows "no results found" when all entities return empty results', async () => {
    const entity = makeEntity({ fulltext_search_column: 'search_vector' });
    const cache = makeMockCache([entity]);
    const client = makeMockClient(); // default mock returns []
    const resolver = makeMockResolver(entity);
    registerSearch(server, client, cache, resolver);

    const result = await callTool(server, 'search', { query: 'zzznomatch' });

    expect(result.content[0].text).toContain('No results found');
  });

  it('searches in parallel across multiple entities', async () => {
    const entities = [
      makeEntity({ table_name: 'clients', display_name: 'Clients', fulltext_search_column: 'search_vector' }),
      makeEntity({ table_name: 'work_orders', display_name: 'Work Orders', fulltext_search_column: 'ts_vector' }),
    ];
    const cache = makeMockCache(entities);
    const client = makeMockClient();
    const mockGet = client.get as ReturnType<typeof vi.fn>;
    mockGet.mockResolvedValue({ data: [], status: 200 });

    const resolver = makeMockResolver();
    registerSearch(server, client, cache, resolver);

    await callTool(server, 'search', { query: 'test' });

    // Both entities should have been queried
    expect(mockGet).toHaveBeenCalledTimes(2);
    const calledTables = mockGet.mock.calls.map(call => call[0] as string);
    expect(calledTables).toContain('clients');
    expect(calledTables).toContain('work_orders');
  });

  it('skips entities that return 404 (graceful fallback)', async () => {
    const entities = [
      makeEntity({ table_name: 'clients', fulltext_search_column: 'search_vector' }),
      makeEntity({ table_name: 'reports', display_name: 'Reports', fulltext_search_column: 'ts_vector' }),
    ];
    const cache = makeMockCache(entities);
    const client = makeMockClient();
    const mockGet = client.get as ReturnType<typeof vi.fn>;

    // clients returns results, reports returns 404
    mockGet.mockImplementation((table: string) => {
      if (table === 'clients') {
        return Promise.resolve({
          data: [{ id: 1, display_name: 'Acme' }],
          status: 200,
          contentRange: { from: 0, to: 0, total: 1 },
        });
      }
      return Promise.reject(new PostgRESTRequestError('Not found', 404));
    });

    const resolver = makeMockResolver(entities[0]);
    registerSearch(server, client, cache, resolver);

    const result = await callTool(server, 'search', { query: 'acme' });
    const text = result.content[0].text;

    expect(text).toContain('Acme');
    // Should not throw even though reports 404'd
    expect(result.isError).not.toBe(true);
  });

  it('limits to specific entity when entity parameter provided', async () => {
    const clients = makeEntity({ table_name: 'clients', fulltext_search_column: 'search_vector' });
    const workOrders = makeEntity({ table_name: 'work_orders', display_name: 'Work Orders', fulltext_search_column: 'ts_vector' });
    const cache = makeMockCache([clients, workOrders]);
    const client = makeMockClient();

    // Resolver returns clients entity when "clients" is resolved
    const resolver = makeMockResolver(clients);
    registerSearch(server, client, cache, resolver);

    await callTool(server, 'search', { query: 'acme', entity: 'clients' });

    const calledTables = (client.get as ReturnType<typeof vi.fn>).mock.calls.map(
      call => call[0] as string,
    );
    // Only clients should be searched
    expect(calledTables).toContain('clients');
    expect(calledTables).not.toContain('work_orders');
  });

  it('applies default limit of 5 per entity', async () => {
    const entity = makeEntity({ fulltext_search_column: 'search_vector' });
    const cache = makeMockCache([entity]);
    const client = makeMockClient();
    const resolver = makeMockResolver(entity);
    registerSearch(server, client, cache, resolver);

    await callTool(server, 'search', { query: 'test' });

    const callParams = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, string>;
    expect(callParams['limit']).toBe('5');
  });

  it('applies custom limit when provided', async () => {
    const entity = makeEntity({ fulltext_search_column: 'search_vector' });
    const cache = makeMockCache([entity]);
    const client = makeMockClient();
    const resolver = makeMockResolver(entity);
    registerSearch(server, client, cache, resolver);

    await callTool(server, 'search', { query: 'test', limit: 10 });

    const callParams = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, string>;
    expect(callParams['limit']).toBe('10');
  });

  it('shows "...and N more" when total exceeds limit', async () => {
    const entity = makeEntity({ display_name: 'Clients', fulltext_search_column: 'search_vector' });
    const cache = makeMockCache([entity]);
    const client = makeMockClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        { id: 1, display_name: 'Acme Corp' },
        { id: 2, display_name: 'Beta Ltd' },
      ],
      status: 200,
      contentRange: { from: 0, to: 1, total: 25 }, // 25 total, only 2 returned
    });
    const resolver = makeMockResolver(entity);
    registerSearch(server, client, cache, resolver);

    const result = await callTool(server, 'search', { query: 'acme', limit: 2 });

    expect(result.content[0].text).toContain('and 23 more');
  });

  it('handles rejected (non-404) entity search by skipping it', async () => {
    const entities = [
      makeEntity({ table_name: 'clients', fulltext_search_column: 'search_vector' }),
    ];
    const cache = makeMockCache(entities);
    const client = makeMockClient();
    // Non-404 error should cause the allSettled to have status="rejected" — skipped
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PostgRESTRequestError('Internal server error', 500),
    );
    const resolver = makeMockResolver(entities[0]);
    registerSearch(server, client, cache, resolver);

    // Should not throw — rejected results are skipped
    const result = await callTool(server, 'search', { query: 'test' });

    // Output should exist but show no results
    expect(result.content[0].text).toContain('No results found');
  });

  it('includes search query in output header', async () => {
    const entity = makeEntity({ fulltext_search_column: 'search_vector' });
    const cache = makeMockCache([entity]);
    const client = makeMockClient();
    const resolver = makeMockResolver(entity);
    registerSearch(server, client, cache, resolver);

    const result = await callTool(server, 'search', { query: 'budget report' });

    expect(result.content[0].text).toContain('"budget report"');
  });
});
