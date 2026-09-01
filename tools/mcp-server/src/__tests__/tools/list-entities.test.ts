/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for the list_entities tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerListEntities } from '../../tools/list-entities.js';
import type { PostgRESTClient } from '../../postgrest-client.js';
import type { SchemaCache } from '../../schema-cache.js';
import type { SchemaEntity } from '../../interfaces.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Invoke a registered tool by name via the McpServer internal mechanism.
 * Casts to `any` to access the private `_registeredTools` map.
 */
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

function makeMockClient(): PostgRESTClient {
  return {
    get: vi.fn().mockResolvedValue({ data: [], status: 200 }),
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
    getStatuses: vi.fn().mockReturnValue([]),
    getCategories: vi.fn().mockReturnValue([]),
    getTransitions: vi.fn().mockReturnValue([]),
    constraintMessages: [],
  } as unknown as SchemaCache;
}

// ============================================================================
// Tests
// ============================================================================

describe('list_entities tool', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.0' });
  });

  it('registers the tool without throwing', () => {
    const cache = makeMockCache([]);
    expect(() => registerListEntities(server, makeMockClient(), cache)).not.toThrow();
  });

  it('calls cache.ensureFresh on invocation', async () => {
    const cache = makeMockCache([]);
    registerListEntities(server, makeMockClient(), cache);

    await callTool(server, 'list_entities', {});

    expect(cache.ensureFreshForUser).toHaveBeenCalledOnce();
  });

  it('returns "no entities" message when cache is empty', async () => {
    const cache = makeMockCache([]);
    registerListEntities(server, makeMockClient(), cache);

    const result = await callTool(server, 'list_entities', {});

    expect(result.content[0].text).toContain('No entities available');
  });

  it('returns "no entities matching filter" when filter matches nothing', async () => {
    const cache = makeMockCache([makeEntity()]);
    registerListEntities(server, makeMockClient(), cache);

    const result = await callTool(server, 'list_entities', { filter: 'zzz_not_found' });

    expect(result.content[0].text).toContain('No entities found matching');
    expect(result.content[0].text).toContain('zzz_not_found');
  });

  it('lists entities when select=true', async () => {
    const entity = makeEntity({ display_name: 'Work Orders', table_name: 'work_orders' });
    const cache = makeMockCache([entity]);
    registerListEntities(server, makeMockClient(), cache);

    const result = await callTool(server, 'list_entities', {});

    expect(result.content[0].text).toContain('Work Orders');
    expect(result.content[0].text).toContain('work_orders');
  });

  it('excludes entities where select=false', async () => {
    const visible = makeEntity({ display_name: 'Clients', table_name: 'clients', select: true });
    const hidden = makeEntity({ display_name: 'Internal Logs', table_name: 'internal_logs', select: false });
    const cache = makeMockCache([visible, hidden]);
    registerListEntities(server, makeMockClient(), cache);

    const result = await callTool(server, 'list_entities', {});

    expect(result.content[0].text).toContain('Clients');
    expect(result.content[0].text).not.toContain('Internal Logs');
  });

  it('includes permissions in output', async () => {
    const entity = makeEntity({
      insert: true,
      select: true,
      update: true,
      delete: false,
    });
    const cache = makeMockCache([entity]);
    registerListEntities(server, makeMockClient(), cache);

    const result = await callTool(server, 'list_entities', {});
    const text = result.content[0].text;

    expect(text).toContain('read');
    expect(text).toContain('create');
    expect(text).toContain('edit');
    expect(text).not.toContain('delete');
  });

  it('includes feature flags in output', async () => {
    const entity = makeEntity({
      show_calendar: true,
      enable_notes: true,
      fulltext_search_column: 'search_vector',
      show_map: true,
      payment_initiation_rpc: 'initiate_payment',
      supports_recurring: true,
      guided_form_key: 'intake_form',
    });
    const cache = makeMockCache([entity]);
    registerListEntities(server, makeMockClient(), cache);

    const result = await callTool(server, 'list_entities', {});
    const text = result.content[0].text;

    expect(text).toContain('calendar');
    expect(text).toContain('notes');
    expect(text).toContain('full-text search');
    expect(text).toContain('map');
    expect(text).toContain('payments');
    expect(text).toContain('recurring');
    expect(text).toContain('guided form');
  });

  it('filters entities by display name substring (case-insensitive)', async () => {
    const entities = [
      makeEntity({ display_name: 'Work Orders', table_name: 'work_orders' }),
      makeEntity({ display_name: 'Clients', table_name: 'clients' }),
      makeEntity({ display_name: 'Service Requests', table_name: 'service_requests' }),
    ];
    const cache = makeMockCache(entities);
    registerListEntities(server, makeMockClient(), cache);

    const result = await callTool(server, 'list_entities', { filter: 'client' });
    const text = result.content[0].text;

    expect(text).toContain('Clients');
    expect(text).not.toContain('Work Orders');
    expect(text).not.toContain('Service Requests');
  });

  it('filters entities by table name substring', async () => {
    const entities = [
      makeEntity({ display_name: 'Work Orders', table_name: 'work_orders' }),
      makeEntity({ display_name: 'Clients', table_name: 'clients' }),
    ];
    const cache = makeMockCache(entities);
    registerListEntities(server, makeMockClient(), cache);

    const result = await callTool(server, 'list_entities', { filter: 'work_orders' });
    const text = result.content[0].text;

    expect(text).toContain('Work Orders');
    expect(text).not.toContain('Clients');
  });

  it('includes entity description when present', async () => {
    const entity = makeEntity({ description: 'Tracks all client relationships' });
    const cache = makeMockCache([entity]);
    registerListEntities(server, makeMockClient(), cache);

    const result = await callTool(server, 'list_entities', {});

    expect(result.content[0].text).toContain('Tracks all client relationships');
  });

  it('shows total count in output', async () => {
    const entities = [
      makeEntity({ display_name: 'Clients', table_name: 'clients' }),
      makeEntity({ display_name: 'Work Orders', table_name: 'work_orders' }),
    ];
    const cache = makeMockCache(entities);
    registerListEntities(server, makeMockClient(), cache);

    const result = await callTool(server, 'list_entities', {});

    expect(result.content[0].text).toContain('Found 2 entities');
  });
});
