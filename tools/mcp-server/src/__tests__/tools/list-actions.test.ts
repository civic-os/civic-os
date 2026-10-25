/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for the list_actions tool.
 *
 * The condition text must never contradict evaluateCondition: anything the
 * evaluator treats as malformed or unknown (it evaluates false) is described
 * as never true, not as "always".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerListActions } from '../../tools/list-actions.js';
import { evaluateCondition } from '@civic-os/core';
import type { PostgRESTClient } from '../../postgrest-client.js';
import type { SchemaCache } from '../../schema-cache.js';
import type { NameResolver } from '../../name-resolver.js';
import type { ActionCondition, SchemaEntity, SchemaEntityAction } from '../../interfaces.js';

async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { executor: (args: unknown) => Promise<unknown> }>;
  return tools[toolName].executor(args) as Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

const entity: SchemaEntity = {
  display_name: 'Clients',
  table_name: 'clients',
  description: null,
  sort_order: 1,
  insert: true,
  select: true,
  update: true,
  delete: false,
};

function makeAction(overrides: Partial<SchemaEntityAction> = {}): SchemaEntityAction {
  return {
    id: 1,
    table_name: 'clients',
    action_name: 'approve',
    display_name: 'Approve',
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

function render(action: SchemaEntityAction, server: McpServer) {
  const cache = {
    ensureFreshForUser: vi.fn().mockResolvedValue(undefined),
    getActionsForUser: vi.fn().mockReturnValue([action]),
  } as unknown as SchemaCache;
  const resolver = { resolveEntity: vi.fn().mockReturnValue(entity) } as unknown as NameResolver;
  registerListActions(server, {} as PostgRESTClient, cache, resolver);
  return callTool(server, 'list_actions', { entity: 'clients' }).then(r => r.content[0].text);
}

describe('list_actions condition text', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.1' });
  });

  it('describes simple and compound conditions', async () => {
    const text = await render(makeAction({
      visibility_condition: { field: 'status_id', operator: 'ne', value: 6 },
      enabled_condition: {
        or: [
          { field: 'status_id', operator: 'eq', value: 5 },
          { field: 'status_id.status_key', operator: 'in', value: ['draft'] },
        ],
      },
    }), server);

    expect(text).toContain('**Visible when**: status_id ≠ 6');
    expect(text).toContain('**Enabled when**: status_id = 5 OR status_id.status_key in ["draft"]');
  });

  // Review finding: {or: [null]} used to read "Visible when: always" while
  // evaluateCondition refuses it.
  it.each([
    ['{or: [null]}', { or: [null] }, 'malformed condition (never)'],
    ['{and: [null]}', { and: [null] }, 'malformed condition (never)'],
    ['{or: [0]}', { or: [0] }, 'malformed condition (never)'],
    ['{or: [false, <cond>]}', { or: [false, { field: 'id', operator: 'eq', value: 1 }] }, 'malformed condition (never) OR id = 1'],
    ['{or: "x"}', { or: 'x' }, 'malformed condition (never)'],
    ['a bare string', 'x', 'malformed condition (never)'],
    ['{or: []}', { or: [] }, 'never (empty OR)'],
    ['an unknown operator', { field: 'v', operator: 'EQ', value: 1 }, 'v EQ 1 (unknown operator — never true)'],
  ])('%s is described as never, not "always"', async (_label, cond, expected) => {
    const text = await render(makeAction({ visibility_condition: cond as unknown as ActionCondition }), server);

    expect(text).toContain(`**Visible when**: ${expected}`);
    expect(text).not.toContain('**Visible when**: always');
  });

  it('agrees with evaluateCondition: every case shown as never evaluates false', () => {
    for (const cond of [{ or: [null] }, { and: [null] }, { or: [0] }, { or: 'x' }, 'x', { or: [] },
      { field: 'v', operator: 'EQ', value: 1 }]) {
      expect(evaluateCondition(cond as unknown as ActionCondition, { id: 1, v: 1 })).toBe(false);
    }
  });
});
