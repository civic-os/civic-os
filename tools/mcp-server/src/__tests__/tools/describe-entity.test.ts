/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for the describe_entity tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerDescribeEntity } from '../../tools/describe-entity.js';
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
    type: EntityPropertyType.TextLong,
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
    refresh_after_action: true,
    show_on_detail: true,
    can_execute: true,
    parameters: [],
    ...overrides,
  };
}

function makeMockClient(): PostgRESTClient {
  return {
    get: vi.fn().mockResolvedValue({ data: [], status: 200 }),
  } as unknown as PostgRESTClient;
}

function makeMockCache(
  entity: SchemaEntity,
  properties: SchemaProperty[] = [],
  actions: SchemaEntityAction[] = [],
): SchemaCache {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    ensureFreshForUser: vi.fn().mockResolvedValue(undefined),
    entities: [entity],
    getEntitiesForUser: vi.fn().mockReturnValue([entity]),
    getProperties: vi.fn().mockReturnValue(properties),
    getPropertiesForUser: vi.fn().mockReturnValue(properties),
    getActions: vi.fn().mockReturnValue(actions),
    getActionsForUser: vi.fn().mockReturnValue(actions),
    getStatuses: vi.fn().mockReturnValue([]),
    getCategories: vi.fn().mockReturnValue([]),
    getTransitions: vi.fn().mockReturnValue([]),
    constraintMessages: [],
  } as unknown as SchemaCache;
}

function makeMockResolver(entity: SchemaEntity): NameResolver {
  return {
    resolveEntity: vi.fn().mockReturnValue(entity),
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

describe('describe_entity tool', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.0' });
  });

  it('registers the tool without throwing', () => {
    const entity = makeEntity();
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    expect(() => registerDescribeEntity(server, makeMockClient(), cache, resolver)).not.toThrow();
  });

  it('calls cache.ensureFresh on invocation', async () => {
    const entity = makeEntity();
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    await callTool(server, 'describe_entity', { entity: 'clients' });

    expect(cache.ensureFreshForUser).toHaveBeenCalledOnce();
  });

  it('calls resolver.resolveEntity with the entity name', async () => {
    const entity = makeEntity();
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    await callTool(server, 'describe_entity', { entity: 'Clients' });

    expect(resolver.resolveEntity).toHaveBeenCalledWith('Clients');
  });

  it('includes entity display name and table name in output', async () => {
    const entity = makeEntity({ display_name: 'Work Orders', table_name: 'work_orders' });
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'work_orders' });
    const text = result.content[0].text;

    expect(text).toContain('Work Orders');
    expect(text).toContain('work_orders');
  });

  it('includes entity description when present', async () => {
    const entity = makeEntity({ description: 'Tracks all work order lifecycle' });
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'clients' });

    expect(result.content[0].text).toContain('Tracks all work order lifecycle');
  });

  it('includes permissions in output', async () => {
    const entity = makeEntity({ insert: true, select: true, update: false, delete: false });
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'clients' });
    const text = result.content[0].text;

    // Extract the Permissions line only to avoid matching "Edit" in the properties table header
    const permissionsLine = text.split('\n').find(line => line.startsWith('**Permissions**')) ?? '';
    expect(permissionsLine).toContain('Read');
    expect(permissionsLine).toContain('Create');
    expect(permissionsLine).not.toContain('Edit');
    expect(permissionsLine).not.toContain('Delete');
  });

  it('renders properties table with correct columns', async () => {
    const entity = makeEntity();
    const props = [
      makeProperty({ column_name: 'name', display_name: 'Name', type: EntityPropertyType.TextShort }),
      makeProperty({ column_name: 'email', display_name: 'Email', type: EntityPropertyType.Email }),
    ];
    const cache = makeMockCache(entity, props);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'clients' });
    const text = result.content[0].text;

    expect(text).toContain('## Properties');
    expect(text).toContain('Name');
    expect(text).toContain('Email');
    expect(text).toContain('| Property |');
  });

  it('shows actions section when actions exist', async () => {
    const entity = makeEntity();
    const action = makeAction({ display_name: 'Approve', action_name: 'approve' });
    const cache = makeMockCache(entity, [], [action]);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'clients' });
    const text = result.content[0].text;

    expect(text).toContain('## Available Actions');
    expect(text).toContain('Approve');
    expect(text).toContain('approve');
  });

  it('marks actions without execute permission', async () => {
    const entity = makeEntity();
    const action = makeAction({ display_name: 'Delete All', can_execute: false });
    const cache = makeMockCache(entity, [], [action]);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'clients' });

    expect(result.content[0].text).toContain('no permission');
  });

  it('includes action parameters in output', async () => {
    const entity = makeEntity();
    const action = makeAction({
      parameters: [
        { id: 1, param_name: 'p_note', display_name: 'Note', param_type: 'text', required: true, sort_order: 1 },
        { id: 2, param_name: 'p_date', display_name: 'Date', param_type: 'date', required: false, sort_order: 2 },
      ],
    });
    const cache = makeMockCache(entity, [], [action]);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'clients' });
    const text = result.content[0].text;

    // Required params are marked with *
    expect(text).toContain('Note*');
    // Optional param has no *
    expect(text).toContain('Date');
  });

  it('shows features section for calendar-enabled entity', async () => {
    const entity = makeEntity({ show_calendar: true, calendar_property_name: 'scheduled_at' });
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'clients' });
    const text = result.content[0].text;

    expect(text).toContain('## Features');
    expect(text).toContain('Calendar');
    expect(text).toContain('scheduled_at');
  });

  it('shows features section for notes-enabled entity', async () => {
    const entity = makeEntity({ enable_notes: true });
    const cache = makeMockCache(entity);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'clients' });

    expect(result.content[0].text).toContain('Entity Notes');
  });

  it('includes status options in output when status property exists', async () => {
    const entity = makeEntity();
    const statusProp = makeProperty({
      column_name: 'status_id',
      display_name: 'Status',
      type: EntityPropertyType.Status,
      status_entity_type: 'work_order',
    });
    const cache = makeMockCache(entity, [statusProp]);
    // Return statuses for work_order
    (cache.getStatuses as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 1, display_name: 'Open', entity_type: 'work_order', color: null, is_initial: true, is_terminal: false },
      { id: 2, display_name: 'Closed', entity_type: 'work_order', color: null, is_initial: false, is_terminal: true },
    ]);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'clients' });
    const text = result.content[0].text;

    expect(text).toContain('Open');
    expect(text).toContain('(initial)');
    expect(text).toContain('Closed');
    expect(text).toContain('(terminal)');
  });

  it('includes category options in output when category property exists', async () => {
    const entity = makeEntity();
    const catProp = makeProperty({
      column_name: 'category_id',
      display_name: 'Category',
      type: EntityPropertyType.Category,
      category_entity_type: 'clients',
    });
    const cache = makeMockCache(entity, [catProp]);
    (cache.getCategories as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 1, display_name: 'Premium', entity_type: 'clients', color: null },
      { id: 2, display_name: 'Standard', entity_type: 'clients', color: null },
    ]);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'clients' });
    const text = result.content[0].text;

    expect(text).toContain('Premium');
    expect(text).toContain('Standard');
  });

  it('does not show actions section when no actions exist', async () => {
    const entity = makeEntity();
    const cache = makeMockCache(entity, [], []);
    const resolver = makeMockResolver(entity);
    registerDescribeEntity(server, makeMockClient(), cache, resolver);

    const result = await callTool(server, 'describe_entity', { entity: 'clients' });

    expect(result.content[0].text).not.toContain('## Available Actions');
  });
});
