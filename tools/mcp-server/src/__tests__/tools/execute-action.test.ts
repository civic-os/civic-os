/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for the execute_action tool and evaluateCondition function.
 *
 * Two test suites:
 *  1. evaluateCondition — exported pure function, comprehensive coverage
 *  2. execute_action tool — registration and handler behaviour via mocks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerExecuteAction, evaluateCondition } from '../../tools/execute-action.js';
import { PostgRESTRequestError } from '../../postgrest-client.js';
import type { PostgRESTClient } from '../../postgrest-client.js';
import type { SchemaCache } from '../../schema-cache.js';
import type { NameResolver } from '../../name-resolver.js';
import type { SchemaEntity, SchemaEntityAction } from '../../interfaces.js';
import type { ActionCondition } from '../../interfaces.js';

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

function makeAction(overrides: Partial<SchemaEntityAction> = {}): SchemaEntityAction {
  return {
    id: 1,
    table_name: 'clients',
    action_name: 'approve',
    display_name: 'Approve',
    description: 'Approve a client',
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

function makeMockClient(rpcResult: unknown = { success: true, message: 'Done' }): PostgRESTClient {
  return {
    get: vi.fn().mockResolvedValue({ data: [{ id: 1, name: 'Acme' }], status: 200 }),
    post: vi.fn().mockResolvedValue({ data: rpcResult, status: 200 }),
    patch: vi.fn(),
    delete: vi.fn(),
    setToken: vi.fn(),
  } as unknown as PostgRESTClient;
}

function makeMockCache(entity: SchemaEntity, actions: SchemaEntityAction[] = []): SchemaCache {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    ensureFreshForUser: vi.fn().mockResolvedValue(undefined),
    entities: [entity],
    getEntitiesForUser: vi.fn().mockReturnValue([entity]),
    getProperties: vi.fn().mockReturnValue([]),
    getActions: vi.fn().mockReturnValue(actions),
    getActionsForUser: vi.fn().mockReturnValue(actions),
    getStatuses: vi.fn().mockReturnValue([]),
    getCategories: vi.fn().mockReturnValue([]),
    constraintMessages: [],
  } as unknown as SchemaCache;
}

function makeMockResolver(entity: SchemaEntity, action: SchemaEntityAction): NameResolver {
  return {
    resolveEntity: vi.fn().mockReturnValue(entity),
    resolveColumn: vi.fn(),
    resolveForeignKeyValue: vi.fn(),
    resolveStatus: vi.fn(),
    resolveCategory: vi.fn(),
    resolveAction: vi.fn().mockReturnValue(action),
    resolveData: vi.fn(),
  } as unknown as NameResolver;
}

// ============================================================================
// Suite 1: evaluateCondition
// ============================================================================

describe('evaluateCondition', () => {
  const record = {
    id: 10,
    status_id: 2,
    name: 'Acme Corp',
    is_active: true,
    count: 5,
    deleted_at: null,
    nested: { value: 42 },
  };

  // -- Simple operators --

  it('eq: returns true when values match (strict/loose)', () => {
    // Loose equality: number 2 == string "2"
    const cond: ActionCondition = { field: 'status_id', operator: 'eq', value: 2 };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('eq: returns false when values do not match', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'eq', value: 99 };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  it('ne: returns true when values differ', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'ne', value: 99 };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('ne: returns false when values are equal', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'ne', value: 2 };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  it('gt: returns true when record value is greater', () => {
    const cond: ActionCondition = { field: 'count', operator: 'gt', value: 3 };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('gt: returns false when record value is not greater', () => {
    const cond: ActionCondition = { field: 'count', operator: 'gt', value: 5 };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  it('lt: returns true when record value is less', () => {
    const cond: ActionCondition = { field: 'count', operator: 'lt', value: 10 };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('lt: returns false when record value is not less', () => {
    const cond: ActionCondition = { field: 'count', operator: 'lt', value: 3 };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  it('gte: returns true when record value equals threshold', () => {
    const cond: ActionCondition = { field: 'count', operator: 'gte', value: 5 };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('gte: returns true when record value exceeds threshold', () => {
    const cond: ActionCondition = { field: 'count', operator: 'gte', value: 3 };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('gte: returns false when record value is less than threshold', () => {
    const cond: ActionCondition = { field: 'count', operator: 'gte', value: 6 };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  it('lte: returns true when record value equals threshold', () => {
    const cond: ActionCondition = { field: 'count', operator: 'lte', value: 5 };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('lte: returns true when record value is less', () => {
    const cond: ActionCondition = { field: 'count', operator: 'lte', value: 10 };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('lte: returns false when record value exceeds threshold', () => {
    const cond: ActionCondition = { field: 'count', operator: 'lte', value: 4 };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  it('in: returns true when record value is in the array', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'in', value: [1, 2, 3] };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('in: returns false when record value is not in the array', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'in', value: [5, 6, 7] };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  it('in: returns false when value is not an array', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'in', value: 2 };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  it('is_null: returns true when field is null', () => {
    const cond: ActionCondition = { field: 'deleted_at', operator: 'is_null' };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('is_null: returns false when field has a value', () => {
    const cond: ActionCondition = { field: 'name', operator: 'is_null' };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  it('is_null: returns true when field is undefined (missing from record)', () => {
    const cond: ActionCondition = { field: 'nonexistent_field', operator: 'is_null' };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('is_not_null: returns true when field has a value', () => {
    const cond: ActionCondition = { field: 'name', operator: 'is_not_null' };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('is_not_null: returns false when field is null', () => {
    const cond: ActionCondition = { field: 'deleted_at', operator: 'is_not_null' };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  // -- Dot-notation field paths --

  it('dot-notation: resolves nested field value', () => {
    const cond: ActionCondition = { field: 'nested.value', operator: 'eq', value: 42 };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('dot-notation: returns undefined (is_null) when intermediate field is missing', () => {
    const cond: ActionCondition = { field: 'nested.deep.missing', operator: 'is_null' };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('dot-notation: resolves embedded FK object fields', () => {
    const recordWithFk = {
      ...record,
      status_id: { id: 3, display_name: 'Approved', color: 'green' },
    };
    const cond: ActionCondition = { field: 'status_id.id', operator: 'eq', value: 3 };
    expect(evaluateCondition(cond, recordWithFk)).toBe(true);
  });

  // -- Boolean fields --

  it('eq: works with boolean true', () => {
    const cond: ActionCondition = { field: 'is_active', operator: 'eq', value: true };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('eq: works with boolean false', () => {
    const cond: ActionCondition = { field: 'is_active', operator: 'eq', value: false };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  // -- Compound conditions: AND --

  it('and: returns true when all sub-conditions pass', () => {
    const cond: ActionCondition = {
      and: [
        { field: 'status_id', operator: 'eq', value: 2 },
        { field: 'is_active', operator: 'eq', value: true },
      ],
    };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('and: returns false when any sub-condition fails', () => {
    const cond: ActionCondition = {
      and: [
        { field: 'status_id', operator: 'eq', value: 2 },
        { field: 'count', operator: 'gt', value: 100 }, // fails
      ],
    };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  it('and: returns true for empty array (vacuous truth)', () => {
    const cond: ActionCondition = { and: [] };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  // -- Compound conditions: OR --

  it('or: returns true when any sub-condition passes', () => {
    const cond: ActionCondition = {
      or: [
        { field: 'status_id', operator: 'eq', value: 99 }, // fails
        { field: 'is_active', operator: 'eq', value: true }, // passes
      ],
    };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('or: returns false when all sub-conditions fail', () => {
    const cond: ActionCondition = {
      or: [
        { field: 'status_id', operator: 'eq', value: 99 },
        { field: 'count', operator: 'gt', value: 1000 },
      ],
    };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  it('or: returns false for empty array (vacuous falsehood)', () => {
    const cond: ActionCondition = { or: [] };
    expect(evaluateCondition(cond, record)).toBe(false);
  });

  // -- Nested compound conditions --

  it('nested: AND containing an OR evaluates correctly', () => {
    const cond: ActionCondition = {
      and: [
        { field: 'is_active', operator: 'eq', value: true },
        {
          or: [
            { field: 'status_id', operator: 'eq', value: 1 },
            { field: 'status_id', operator: 'eq', value: 2 }, // passes
          ],
        },
      ],
    };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('nested: OR containing an AND evaluates correctly when AND fails', () => {
    const cond: ActionCondition = {
      or: [
        {
          and: [
            { field: 'status_id', operator: 'eq', value: 99 }, // fails
            { field: 'is_active', operator: 'eq', value: true },
          ],
        },
        { field: 'count', operator: 'gte', value: 5 }, // passes
      ],
    };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  // -- Edge cases --

  it('unknown operator returns true (permissive)', () => {
    // Simulate an unknown operator that the switch default handles
    const cond = { field: 'name', operator: 'regex' as 'eq', value: '^A' };
    expect(evaluateCondition(cond, record)).toBe(true);
  });

  it('is_null: returns true for null embedded FK object', () => {
    const recordWithNullFk = { ...record, client_id: null };
    const cond: ActionCondition = { field: 'client_id', operator: 'is_null' };
    expect(evaluateCondition(cond, recordWithNullFk)).toBe(true);
  });
});

// ============================================================================
// Suite 2: execute_action tool (integration-style with mocks)
// ============================================================================

describe('execute_action tool', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.0' });
  });

  it('registers the tool without throwing', () => {
    const entity = makeEntity();
    const action = makeAction();
    const client = makeMockClient();
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    expect(() => registerExecuteAction(server, client, cache, resolver)).not.toThrow();
  });

  it('calls cache.ensureFresh on invocation', async () => {
    const entity = makeEntity();
    const action = makeAction();
    const client = makeMockClient();
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    await callTool(server, 'execute_action', { entity: 'clients', id: 1, action: 'approve' });

    expect(cache.ensureFreshForUser).toHaveBeenCalledOnce();
  });

  it('returns isError when action has can_execute=false', async () => {
    const entity = makeEntity();
    const action = makeAction({ can_execute: false });
    const client = makeMockClient();
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    const result = await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('do not have permission');
  });

  it('returns success message from RPC result', async () => {
    const entity = makeEntity();
    const action = makeAction();
    const client = makeMockClient({ success: true, message: 'Client approved successfully' });
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    const result = await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Client approved successfully');
  });

  it('uses default_success_message when RPC result has no message', async () => {
    const entity = makeEntity();
    const action = makeAction({ default_success_message: 'Operation completed' });
    const client = makeMockClient({ success: true }); // no message in result
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    const result = await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
    });

    expect(result.content[0].text).toContain('Operation completed');
  });

  it('mentions get_record when refresh_after_action=true', async () => {
    const entity = makeEntity();
    const action = makeAction({ refresh_after_action: true });
    const client = makeMockClient({ success: true });
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    const result = await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
    });

    expect(result.content[0].text).toContain('get_record');
  });

  it('mentions navigate_to suggestion when RPC result includes it', async () => {
    const entity = makeEntity();
    const action = makeAction();
    const client = makeMockClient({ success: true, navigate_to: '/clients/1/review' });
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    const result = await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
    });

    expect(result.content[0].text).toContain('/clients/1/review');
  });

  it('returns isError when required parameter is missing', async () => {
    const entity = makeEntity();
    const action = makeAction({
      parameters: [
        { id: 1, param_name: 'p_note', display_name: 'Note', param_type: 'text', required: true, sort_order: 1 },
      ],
    });
    const client = makeMockClient();
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    const result = await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
      // params omitted — required param not provided
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing required parameter');
    expect(result.content[0].text).toContain('Note');
  });

  it('builds RPC payload with p_entity_id', async () => {
    const entity = makeEntity();
    const action = makeAction();
    const client = makeMockClient();
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 42,
      action: 'approve',
    });

    expect(client.post).toHaveBeenCalledWith(
      'rpc/approve_client',
      expect.objectContaining({ p_entity_id: 42 }),
    );
  });

  it('resolves action parameters and includes them in RPC payload', async () => {
    const entity = makeEntity();
    const action = makeAction({
      parameters: [
        { id: 1, param_name: 'p_note', display_name: 'Note', param_type: 'text', required: false, sort_order: 1 },
      ],
    });
    const client = makeMockClient();
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
      params: { p_note: 'Looks good' },
    });

    expect(client.post).toHaveBeenCalledWith(
      'rpc/approve_client',
      expect.objectContaining({ p_note: 'Looks good', p_entity_id: 1 }),
    );
  });

  it('checks visibility condition and returns isError when condition fails', async () => {
    const entity = makeEntity();
    const action = makeAction({
      visibility_condition: { field: 'status_id', operator: 'eq', value: 1 },
    });
    const client = makeMockClient();
    // client.get returns record with status_id=2 → visibility fails
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: 1, status_id: 2 }],
      status: 200,
    });
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    const result = await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not available');
  });

  it('checks enabled condition and returns isError with tooltip when condition fails', async () => {
    const entity = makeEntity();
    const action = makeAction({
      enabled_condition: { field: 'is_active', operator: 'eq', value: true },
      disabled_tooltip: 'Client must be active',
    });
    const client = makeMockClient();
    // client.get returns record with is_active=false → enabled_condition fails
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: 1, is_active: false }],
      status: 200,
    });
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    const result = await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Client must be active');
  });

  it('returns isError and human message on PostgRESTRequestError from RPC', async () => {
    const entity = makeEntity();
    const action = makeAction();
    const client = makeMockClient();
    (client.post as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PostgRESTRequestError('validation failed', 422, 'P0001'),
    );
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    const result = await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
    });

    expect(result.isError).toBe(true);
    // P0001 → custom PL/pgSQL error — message is forwarded directly
    expect(result.content[0].text).toContain('validation failed');
  });

  it('re-throws non-PostgREST errors from RPC', async () => {
    const entity = makeEntity();
    const action = makeAction();
    const client = makeMockClient();
    (client.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network down'));
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    await expect(
      callTool(server, 'execute_action', { entity: 'clients', id: 1, action: 'approve' }),
    ).rejects.toThrow('Network down');
  });

  it('resolves status parameter values via resolver.resolveStatus', async () => {
    const entity = makeEntity();
    const action = makeAction({
      parameters: [
        {
          id: 1,
          param_name: 'p_status_id',
          display_name: 'Status',
          param_type: 'status',
          required: false,
          sort_order: 1,
          status_entity_type: 'clients',
        },
      ],
    });
    const client = makeMockClient();
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    (resolver.resolveStatus as ReturnType<typeof vi.fn>).mockReturnValue(5);
    registerExecuteAction(server, client, cache, resolver);

    await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
      params: { p_status_id: 'Active' },
    });

    expect(resolver.resolveStatus).toHaveBeenCalledWith('clients', 'Active');
    expect(client.post).toHaveBeenCalledWith(
      'rpc/approve_client',
      expect.objectContaining({ p_status_id: 5 }),
    );
  });

  it('resolves FK parameter values via resolver.resolveForeignKeyValue', async () => {
    const entity = makeEntity();
    const action = makeAction({
      parameters: [
        {
          id: 1,
          param_name: 'p_assigned_to',
          display_name: 'Assigned To',
          param_type: 'fk',
          required: false,
          sort_order: 1,
          join_table: 'civic_os_users',
        },
      ],
    });
    const client = makeMockClient();
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    (resolver.resolveForeignKeyValue as ReturnType<typeof vi.fn>).mockResolvedValue('user-uuid-123');
    registerExecuteAction(server, client, cache, resolver);

    await callTool(server, 'execute_action', {
      entity: 'clients',
      id: 1,
      action: 'approve',
      params: { p_assigned_to: 'Jane Doe' },
    });

    expect(resolver.resolveForeignKeyValue).toHaveBeenCalledWith('civic_os_users', 'Jane Doe');
    expect(client.post).toHaveBeenCalledWith(
      'rpc/approve_client',
      expect.objectContaining({ p_assigned_to: 'user-uuid-123' }),
    );
  });
});
