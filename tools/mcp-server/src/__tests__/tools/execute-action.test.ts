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
import { evaluateActionCondition } from '@civic-os/core';
import { registerExecuteAction } from '../../tools/execute-action.js';
import { MaintenanceError, PostgRESTRequestError } from '../../postgrest-client.js';
import type { PostgRESTClient } from '../../postgrest-client.js';
import type { SchemaCache } from '../../schema-cache.js';
import type { NameResolver } from '../../name-resolver.js';
import type { SchemaEntity, SchemaEntityAction } from '../../interfaces.js';
import type { ActionCondition } from '../../interfaces.js';
import { withTransport } from '../mock-transport.js';

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
  return withTransport({
    get: vi.fn().mockResolvedValue({ data: [{ id: 1, name: 'Acme' }], status: 200 }),
    post: vi.fn().mockResolvedValue({ data: rpcResult, status: 200 }),
    patch: vi.fn(),
    delete: vi.fn(),
    setToken: vi.fn(),
  } as any);
}

function makeMockCache(entity: SchemaEntity, actions: SchemaEntityAction[] = []): SchemaCache {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    ensureFreshForUser: vi.fn().mockResolvedValue(undefined),
    entities: [entity],
    getEntitiesForUser: vi.fn().mockReturnValue([entity]),
    getProperties: vi.fn().mockReturnValue([]),
    getPropertiesForUser: vi.fn().mockReturnValue([]),
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
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('eq: returns false when values do not match', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'eq', value: 99 };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  it('ne: returns true when values differ', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'ne', value: 99 };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('ne: returns false when values are equal', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'ne', value: 2 };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  it('gt: returns true when record value is greater', () => {
    const cond: ActionCondition = { field: 'count', operator: 'gt', value: 3 };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('gt: returns false when record value is not greater', () => {
    const cond: ActionCondition = { field: 'count', operator: 'gt', value: 5 };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  it('lt: returns true when record value is less', () => {
    const cond: ActionCondition = { field: 'count', operator: 'lt', value: 10 };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('lt: returns false when record value is not less', () => {
    const cond: ActionCondition = { field: 'count', operator: 'lt', value: 3 };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  it('gte: returns true when record value equals threshold', () => {
    const cond: ActionCondition = { field: 'count', operator: 'gte', value: 5 };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('gte: returns true when record value exceeds threshold', () => {
    const cond: ActionCondition = { field: 'count', operator: 'gte', value: 3 };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('gte: returns false when record value is less than threshold', () => {
    const cond: ActionCondition = { field: 'count', operator: 'gte', value: 6 };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  it('lte: returns true when record value equals threshold', () => {
    const cond: ActionCondition = { field: 'count', operator: 'lte', value: 5 };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('lte: returns true when record value is less', () => {
    const cond: ActionCondition = { field: 'count', operator: 'lte', value: 10 };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('lte: returns false when record value exceeds threshold', () => {
    const cond: ActionCondition = { field: 'count', operator: 'lte', value: 4 };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  it('in: returns true when record value is in the array', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'in', value: [1, 2, 3] };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('in: returns false when record value is not in the array', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'in', value: [5, 6, 7] };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  it('in: returns false when value is not an array', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'in', value: 2 };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  it('is_null: returns true when field is null', () => {
    const cond: ActionCondition = { field: 'deleted_at', operator: 'is_null' };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('is_null: returns false when field has a value', () => {
    const cond: ActionCondition = { field: 'name', operator: 'is_null' };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  it('is_null: returns true when field is undefined (missing from record)', () => {
    const cond: ActionCondition = { field: 'nonexistent_field', operator: 'is_null' };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('is_not_null: returns true when field has a value', () => {
    const cond: ActionCondition = { field: 'name', operator: 'is_not_null' };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('is_not_null: returns false when field is null', () => {
    const cond: ActionCondition = { field: 'deleted_at', operator: 'is_not_null' };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  // -- Dot-notation field paths --

  it('dot-notation: resolves nested field value', () => {
    const cond: ActionCondition = { field: 'nested.value', operator: 'eq', value: 42 };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('dot-notation: returns undefined (is_null) when intermediate field is missing', () => {
    const cond: ActionCondition = { field: 'nested.deep.missing', operator: 'is_null' };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('dot-notation: resolves embedded FK object fields', () => {
    const recordWithFk = {
      ...record,
      status_id: { id: 3, display_name: 'Approved', color: 'green' },
    };
    const cond: ActionCondition = { field: 'status_id.id', operator: 'eq', value: 3 };
    expect(evaluateActionCondition(cond, recordWithFk)).toBe(true);
  });

  // -- Boolean fields --

  it('eq: works with boolean true', () => {
    const cond: ActionCondition = { field: 'is_active', operator: 'eq', value: true };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('eq: works with boolean false', () => {
    const cond: ActionCondition = { field: 'is_active', operator: 'eq', value: false };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  // -- Compound conditions: AND --

  it('and: returns true when all sub-conditions pass', () => {
    const cond: ActionCondition = {
      and: [
        { field: 'status_id', operator: 'eq', value: 2 },
        { field: 'is_active', operator: 'eq', value: true },
      ],
    };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('and: returns false when any sub-condition fails', () => {
    const cond: ActionCondition = {
      and: [
        { field: 'status_id', operator: 'eq', value: 2 },
        { field: 'count', operator: 'gt', value: 100 }, // fails
      ],
    };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  it('and: returns true for empty array (vacuous truth)', () => {
    const cond: ActionCondition = { and: [] };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  // -- Compound conditions: OR --

  it('or: returns true when any sub-condition passes', () => {
    const cond: ActionCondition = {
      or: [
        { field: 'status_id', operator: 'eq', value: 99 }, // fails
        { field: 'is_active', operator: 'eq', value: true }, // passes
      ],
    };
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  it('or: returns false when all sub-conditions fail', () => {
    const cond: ActionCondition = {
      or: [
        { field: 'status_id', operator: 'eq', value: 99 },
        { field: 'count', operator: 'gt', value: 1000 },
      ],
    };
    expect(evaluateActionCondition(cond, record)).toBe(false);
  });

  it('or: returns false for empty array (vacuous falsehood)', () => {
    const cond: ActionCondition = { or: [] };
    expect(evaluateActionCondition(cond, record)).toBe(false);
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
    expect(evaluateActionCondition(cond, record)).toBe(true);
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
    expect(evaluateActionCondition(cond, record)).toBe(true);
  });

  // -- Edge cases --

  // Ledger C-04: an unknown operator fails closed (frontend returns false).
  // Synthetic matrix instances: <empty>/"between"/"EQ" with "1" @ "1".
  it.each(['regex', 'between', 'EQ', ''])('unknown operator %j returns false (fail closed)', (op) => {
    const cond = { field: 'code', operator: op as 'eq', value: '1' };
    expect(evaluateActionCondition(cond, { code: '1' })).toBe(false);
  });

  it('is_null: returns true for null embedded FK object', () => {
    const recordWithNullFk = { ...record, client_id: null };
    const cond: ActionCondition = { field: 'client_id', operator: 'is_null' };
    expect(evaluateActionCondition(cond, recordWithNullFk)).toBe(true);
  });
});

// ============================================================================
// Ledger C-01: plain condition fields on FK-embedded values compare the .id
// (src/app/utils/condition-evaluator.ts is the reference)
// ============================================================================

describe('evaluateCondition — embedded FK objects (ledger C-01)', () => {
  // community-center · reservation_requests.approve / deny:enabled_condition
  const embeddedStatus = { status_id: { display_name: 'N', id: 5, status_key: 'k' } };

  it('eq on a plain field matches the embedded object\'s id', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'eq', value: 5 };
    expect(evaluateActionCondition(cond, embeddedStatus)).toBe(true);
  });

  it('eq on a plain field rejects a different id', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'eq', value: 6 };
    expect(evaluateActionCondition(cond, embeddedStatus)).toBe(false);
  });

  it('ne on a plain field compares the id (community-center approve visibility: status_id ne 6)', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'ne', value: 6 };
    expect(evaluateActionCondition(cond, embeddedStatus)).toBe(true);
    expect(evaluateActionCondition(cond, { status_id: { id: 6, display_name: 'Denied' } })).toBe(false);
  });

  it('in on a plain field compares the id', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'in', value: [4, 5] };
    expect(evaluateActionCondition(cond, embeddedStatus)).toBe(true);
  });

  it('client-intake · clients.refer: eq true against an embedded object with id true', () => {
    const cond: ActionCondition = { field: 'consent_active', operator: 'eq', value: true };
    const rec = { consent_active: { display_name: 'N', id: true, status_key: 'k' } };
    expect(evaluateActionCondition(cond, rec)).toBe(true);
  });

  it('_shared · conditions.dotted: plain field "a" @ {a:{b:1,id:1}} resolves to 1', () => {
    const cond: ActionCondition = { field: 'a', operator: 'eq', value: 1 };
    expect(evaluateActionCondition(cond, { a: { b: 1, id: 1 } })).toBe(true);
  });

  it('dot-notation still reads nested fields of the embed', () => {
    const cond: ActionCondition = { field: 'status_id.status_key', operator: 'eq', value: 'k' };
    expect(evaluateActionCondition(cond, embeddedStatus)).toBe(true);
  });

  it('an object without an id is not unwrapped', () => {
    const cond: ActionCondition = { field: 'meta', operator: 'is_not_null' };
    expect(evaluateActionCondition(cond, { meta: { tag: 'x' } })).toBe(true);
  });
});

// ============================================================================
// Ledger C-02 / C-03 / C-05 / C-06: evaluator parity with the frontend
// ============================================================================

describe('evaluateCondition — strict equality (ledger C-02)', () => {
  it.each([
    ['eq "1" @ 1', { field: 'v', operator: 'eq', value: '1' }, { v: 1 }, false],
    ['eq 5 @ "5" (community-center / mottpark status_id)', { field: 'status_id', operator: 'eq', value: 5 }, { status_id: '5' }, false],
    ['eq false @ 0', { field: 'v', operator: 'eq', value: false }, { v: 0 }, false],
    ['eq "1,2" @ [1,2]', { field: 'v', operator: 'eq', value: '1,2' }, { v: [1, 2] }, false],
    ['ne "1" @ 1', { field: 'v', operator: 'ne', value: '1' }, { v: 1 }, true],
    ['eq 5 @ 5', { field: 'v', operator: 'eq', value: 5 }, { v: 5 }, true],
  ] as Array<[string, ActionCondition, Record<string, unknown>, boolean]>)('%s', (_label, cond, rec, expected) => {
    expect(evaluateActionCondition(cond, rec)).toBe(expected);
  });
});

describe('evaluateCondition — ordering needs numbers (ledger C-03)', () => {
  it.each([
    ['gt "1" @ "a"', { field: 'v', operator: 'gt', value: '1' }, { v: 'a' }, false],
    ['gt "1" @ "x"', { field: 'v', operator: 'gt', value: '1' }, { v: 'x' }, false],
    ['gt "1" @ 1.5', { field: 'v', operator: 'gt', value: '1' }, { v: 1.5 }, false],
    ['lt 5 @ null (was coerced to 0)', { field: 'v', operator: 'lt', value: 5 }, { v: null }, false],
    ['gte 0 @ missing field', { field: 'v', operator: 'gte', value: 0 }, {}, false],
    ['gt 1 @ 1.5', { field: 'v', operator: 'gt', value: 1 }, { v: 1.5 }, true],
    ['lte 2 @ 2', { field: 'v', operator: 'lte', value: 2 }, { v: 2 }, true],
  ] as Array<[string, ActionCondition, Record<string, unknown>, boolean]>)('%s', (_label, cond, rec, expected) => {
    expect(evaluateActionCondition(cond, rec)).toBe(expected);
  });
});

describe('evaluateCondition — missing record (ledger C-05)', () => {
  // community-center · reservation_requests.approve:visibility_condition
  const cond: ActionCondition = { field: 'status_id', operator: 'ne', value: 6 };

  it('returns false for null data', () => {
    expect(evaluateActionCondition(cond, null)).toBe(false);
  });

  it('returns false for undefined data', () => {
    expect(evaluateActionCondition(cond, undefined)).toBe(false);
  });

  it('returns false for an OR whose branches would pass on undefined fields', () => {
    const orCond: ActionCondition = { or: [{ field: 'x', operator: 'is_null' }] };
    expect(evaluateActionCondition(orCond, null)).toBe(false);
  });
});

// Review finding 1: with the .id unwrap (C-01), loose equality would have made a
// string status id match an embedded numeric id. Strict equality (C-02) blocks it.
describe('evaluateCondition — C-01 unwrap with C-02 strict equality', () => {
  it('a string id does not match the embedded numeric id', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'eq', value: '5' };
    expect(evaluateActionCondition(cond, { status_id: { id: 5, display_name: 'Pending' } })).toBe(false);
  });

  it('ne with a string id holds against the embedded numeric id', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'ne', value: '5' };
    expect(evaluateActionCondition(cond, { status_id: { id: 5, display_name: 'Pending' } })).toBe(true);
  });

  it('in with string ids does not match the embedded numeric id', () => {
    const cond: ActionCondition = { field: 'status_id', operator: 'in', value: ['5', '6'] };
    expect(evaluateActionCondition(cond, { status_id: { id: 5 } })).toBe(false);
  });
});

// Review finding 2: entries inside or/and that are not objects fail closed
// (only an absent top-level condition means "always").
describe('evaluateCondition — malformed compound entries', () => {
  const failing: ActionCondition = { field: 'id', operator: 'eq', value: 999 };
  it.each([
    ['{or: [null]}', { or: [null] }],
    ['{and: [null]}', { and: [null] }],
    ['{or: [0]}', { or: [0] }],
    ['{or: [false, <failing>]}', { or: [false, failing] }],
    ['{and: [<passing>, undefined]}', { and: [{ field: 'id', operator: 'eq', value: 1 }, undefined] }],
    ['{or: ["x"]}', { or: ['x'] }],
  ])('%s is false', (_label, cond) => {
    expect(evaluateActionCondition(cond as unknown as ActionCondition, { id: 1 })).toBe(false);
  });

  it('a valid entry alongside a malformed one still counts in OR', () => {
    const cond = { or: [null, { field: 'id', operator: 'eq', value: 1 }] };
    expect(evaluateActionCondition(cond as unknown as ActionCondition, { id: 1 })).toBe(true);
  });

  it('execute_action explains a malformed entry instead of crashing', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const entity = makeEntity();
    const action = makeAction({
      enabled_condition: { and: [null, { field: 'id', operator: 'eq', value: 1 }] } as unknown as ActionCondition,
    });
    const client = makeMockClient();
    registerExecuteAction(server, client, makeMockCache(entity, [action]), makeMockResolver(entity, action));

    const result = await callTool(server, 'execute_action', { entity: 'clients', id: 1, action: 'approve' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('a sub-condition is malformed');
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe('evaluateCondition — total over malformed conditions (ledger C-06)', () => {
  it('nullCondition: a null condition is always true', () => {
    expect(evaluateActionCondition(null, { id: 1 })).toBe(true);
  });

  it('undefinedConditionNullData: an absent condition is true even without data', () => {
    expect(evaluateActionCondition(undefined, null)).toBe(true);
  });

  it.each([
    ['{or: "x"}', { or: 'x' }],
    ['{and: 5}', { and: 5 }],
    ['{} (no field)', {}],
    ['{field: 3, operator: "eq"}', { field: 3, operator: 'eq', value: 3 }],
    ['a bare string "x"', 'x'],
    ['a bare number 5', 5],
    ['an array', [{ field: 'id', operator: 'eq', value: 1 }]],
  ])('%s does not throw and fails closed', (_label, cond) => {
    expect(() => evaluateActionCondition(cond as unknown as ActionCondition, { id: 1 })).not.toThrow();
    expect(evaluateActionCondition(cond as unknown as ActionCondition, { id: 1 })).toBe(false);
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
    // Should explain why: status_id is 2, expected 1
    expect(result.content[0].text).toContain('status_id is 2');
    expect(result.content[0].text).toContain('expected 1');
    // Should suggest using get_record
    expect(result.content[0].text).toContain('get_record');
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
    // Should suggest using get_record
    expect(result.content[0].text).toContain('get_record');
  });

  // Ledger A-01: the record fetched for conditions embeds Status columns, so
  // "status_id eq 5" must match {status_id: {id: 5, ...}} and the RPC must run.
  it('runs a status-gated action when the embedded status id satisfies the conditions (A-01)', async () => {
    const entity = makeEntity({ table_name: 'reservation_requests', display_name: 'Reservation Requests' });
    const action = makeAction({
      table_name: 'reservation_requests',
      rpc_function: 'approve_reservation_request',
      visibility_condition: { field: 'status_id', operator: 'ne', value: 6 },
      enabled_condition: { field: 'status_id', operator: 'eq', value: 5 },
      disabled_tooltip: 'Only pending requests can be approved',
    });
    const client = makeMockClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: 42, status_id: { id: 5, display_name: 'Pending', color: '#ccc', status_key: 'pending' } }],
      status: 200,
    });
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    const result = await callTool(server, 'execute_action', {
      entity: 'reservation_requests',
      id: 42,
      action: 'approve',
    });

    expect(result.isError).toBeUndefined();
    expect(client.post).toHaveBeenCalledWith(
      'rpc/approve_reservation_request',
      expect.objectContaining({ p_entity_id: 42 }),
    );
  });

  it('refuses a status-gated action when the embedded status id fails the condition (A-01)', async () => {
    const entity = makeEntity({ table_name: 'reservation_requests', display_name: 'Reservation Requests' });
    const action = makeAction({
      table_name: 'reservation_requests',
      visibility_condition: { field: 'status_id', operator: 'ne', value: 6 },
    });
    const client = makeMockClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: 42, status_id: { id: 6, display_name: 'Denied', color: '#f00', status_key: 'denied' } }],
      status: 200,
    });
    const cache = makeMockCache(entity, [action]);
    const resolver = makeMockResolver(entity, action);
    registerExecuteAction(server, client, cache, resolver);

    const result = await callTool(server, 'execute_action', {
      entity: 'reservation_requests',
      id: 42,
      action: 'approve',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not available');
    expect(result.content[0].text).toContain('status_id is 6');
    expect(client.post).not.toHaveBeenCalled();
  });

  // Ledger C-05: when the record behind a condition cannot be loaded, the action
  // is refused instead of being sent to the RPC unchecked.
  it('refuses a conditional action when the record is not found (C-05)', async () => {
    const entity = makeEntity();
    const action = makeAction({ visibility_condition: { field: 'status_id', operator: 'ne', value: 6 } });
    const client = makeMockClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], status: 200 });
    registerExecuteAction(server, client, makeMockCache(entity, [action]), makeMockResolver(entity, action));

    const result = await callTool(server, 'execute_action', { entity: 'clients', id: 99, action: 'approve' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Record #99 not found');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('refuses a conditional action when the record fetch fails (C-05)', async () => {
    const entity = makeEntity();
    const action = makeAction({ enabled_condition: { field: 'is_active', operator: 'eq', value: true } });
    const client = makeMockClient();
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PostgRESTRequestError('permission denied for table clients', 403, '42501'),
    );
    registerExecuteAction(server, client, makeMockCache(entity, [action]), makeMockResolver(entity, action));

    const result = await callTool(server, 'execute_action', { entity: 'clients', id: 1, action: 'approve' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Could not load Clients #1');
    expect(result.content[0].text).toContain('Permission denied');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('re-throws MaintenanceError from the condition fetch', async () => {
    const entity = makeEntity();
    const action = makeAction({ enabled_condition: { field: 'is_active', operator: 'eq', value: true } });
    const client = makeMockClient();
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(new MaintenanceError('full'));
    registerExecuteAction(server, client, makeMockCache(entity, [action]), makeMockResolver(entity, action));

    await expect(
      callTool(server, 'execute_action', { entity: 'clients', id: 1, action: 'approve' }),
    ).rejects.toBeInstanceOf(MaintenanceError);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('does not fetch the record for an action without conditions', async () => {
    const entity = makeEntity();
    const action = makeAction();
    const client = makeMockClient();
    registerExecuteAction(server, client, makeMockCache(entity, [action]), makeMockResolver(entity, action));

    const result = await callTool(server, 'execute_action', { entity: 'clients', id: 1, action: 'approve' });

    expect(result.isError).toBeUndefined();
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalled();
  });

  it('checks enabled condition without tooltip shows condition details', async () => {
    const entity = makeEntity();
    const action = makeAction({
      enabled_condition: { field: 'is_active', operator: 'eq', value: true },
      // No disabled_tooltip — should fall back to condition description
    });
    const client = makeMockClient();
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
    // Without tooltip, should describe the condition failure
    expect(result.content[0].text).toContain('is_active is false');
    expect(result.content[0].text).toContain('expected true');
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
