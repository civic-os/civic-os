/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for the get_status_workflow tool.
 *
 * Ledger A-03: transitions come from rpc/get_status_transitions_for_entity
 * (the source the frontend uses), not a status_transitions view.
 * Fixtures mirror the community-center reservation_request golden data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerGetStatusWorkflow } from '../../tools/get-status-workflow.js';
import { MaintenanceError, PostgRESTRequestError } from '../../postgrest-client.js';
import type { PostgRESTClient } from '../../postgrest-client.js';
import type { SchemaCache } from '../../schema-cache.js';
import type { NameResolver } from '../../name-resolver.js';
import {
  EntityPropertyType,
  type SchemaEntity,
  type SchemaProperty,
  type StatusOption,
  type StatusTransition,
} from '../../interfaces.js';

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

const entity: SchemaEntity = {
  display_name: 'Reservation Requests',
  table_name: 'reservation_requests',
  description: null,
  sort_order: 1,
  insert: true,
  select: true,
  update: true,
  delete: false,
};

const statusProperty = {
  table_name: 'reservation_requests',
  column_name: 'status_id',
  display_name: 'Status',
  data_type: 'integer',
  udt_name: 'int4',
  udt_schema: 'pg_catalog',
  sort_order: 1,
  join_schema: 'metadata',
  join_table: 'statuses',
  join_column: 'id',
  geography_type: '',
  is_nullable: false,
  is_updatable: true,
  is_identity: false,
  is_generated: false,
  is_self_referencing: false,
  column_default: '',
  status_entity_type: 'reservation_request',
  type: EntityPropertyType.Status,
} as SchemaProperty;

function status(id: number, display_name: string, extra: Partial<StatusOption> = {}): StatusOption {
  return { id, display_name, color: null, entity_type: 'reservation_request', ...extra } as StatusOption;
}

const statuses: StatusOption[] = [
  status(5, 'Pending', { is_initial: true, status_key: 'pending' }),
  status(6, 'Approved', { is_terminal: true, status_key: 'approved' }),
  status(7, 'Denied', { is_terminal: true, status_key: 'denied' }),
  status(8, 'Cancelled', { is_terminal: true, status_key: 'cancelled' }),
];

function transition(
  id: number,
  from: [number, string],
  to: [number, string],
  extra: Partial<StatusTransition> = {},
): StatusTransition {
  return {
    id,
    entity_type: 'reservation_request',
    from_status_id: from[0],
    from_display_name: from[1],
    to_status_id: to[0],
    to_display_name: to[1],
    on_transition_rpc: null,
    display_name: null,
    description: null,
    sort_order: 0,
    is_enabled: true,
    ...extra,
  };
}

// community-center · reservation_request: the RPC returns 4 transitions for every role
const goldenTransitions: StatusTransition[] = [
  transition(1, [5, 'Pending'], [6, 'Approved'], { display_name: 'Approve', on_transition_rpc: 'approve_reservation_request' }),
  transition(2, [5, 'Pending'], [7, 'Denied'], { display_name: 'Deny', on_transition_rpc: 'deny_reservation_request' }),
  transition(3, [5, 'Pending'], [8, 'Cancelled'], { display_name: 'Cancel', on_transition_rpc: 'cancel_reservation_request' }),
  transition(4, [6, 'Approved'], [8, 'Cancelled'], { display_name: 'Cancel', on_transition_rpc: 'cancel_reservation_request' }),
];

function makeMockClient(post: ReturnType<typeof vi.fn>): PostgRESTClient {
  return {
    get: vi.fn().mockResolvedValue({ data: [], status: 200 }),
    post,
    patch: vi.fn(),
    delete: vi.fn(),
    setToken: vi.fn(),
  } as unknown as PostgRESTClient;
}

function makeMockCache(): SchemaCache {
  return {
    ensureFreshForUser: vi.fn().mockResolvedValue(undefined),
    getPropertiesForUser: vi.fn().mockReturnValue([statusProperty]),
    getStatuses: vi.fn().mockReturnValue(statuses),
  } as unknown as SchemaCache;
}

function makeMockResolver(): NameResolver {
  return { resolveEntity: vi.fn().mockReturnValue(entity) } as unknown as NameResolver;
}

// ============================================================================
// Tests
// ============================================================================

describe('get_status_workflow tool', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.1' });
  });

  it('fetches transitions through rpc/get_status_transitions_for_entity', async () => {
    const post = vi.fn().mockResolvedValue({ data: goldenTransitions, status: 200 });
    const client = makeMockClient(post);
    registerGetStatusWorkflow(server, client, makeMockCache(), makeMockResolver());

    await callTool(server, 'get_status_workflow', { entity: 'Reservation Requests' });

    expect(post).toHaveBeenCalledWith(
      'rpc/get_status_transitions_for_entity',
      { p_entity_type: 'reservation_request' },
    );
    expect(client.get).not.toHaveBeenCalledWith('status_transitions', expect.anything());
  });

  it('reports the transitions the RPC returns, with labels and on-transition RPCs', async () => {
    const post = vi.fn().mockResolvedValue({ data: goldenTransitions, status: 200 });
    registerGetStatusWorkflow(server, makeMockClient(post), makeMockCache(), makeMockResolver());

    const result = await callTool(server, 'get_status_workflow', { entity: 'Reservation Requests' });
    const text = result.content[0].text;

    expect(text).toContain('### Allowed Transitions');
    expect(text).toContain(
      '- **Pending** → Approved ("Approve", runs `approve_reservation_request`), ' +
      'Denied ("Deny", runs `deny_reservation_request`), ' +
      'Cancelled ("Cancel", runs `cancel_reservation_request`)',
    );
    expect(text).toContain('- **Approved** → Cancelled ("Cancel", runs `cancel_reservation_request`)');
    expect(text).not.toContain('No transition restrictions');
  });

  it('leaves out soft-disabled transitions (is_enabled = false)', async () => {
    const withDisabled = [
      ...goldenTransitions.slice(0, 3),
      { ...goldenTransitions[3], is_enabled: false },
    ];
    const post = vi.fn().mockResolvedValue({ data: withDisabled, status: 200 });
    registerGetStatusWorkflow(server, makeMockClient(post), makeMockCache(), makeMockResolver());

    const text = (await callTool(server, 'get_status_workflow', { entity: 'Reservation Requests' })).content[0].text;

    expect(text).not.toContain('- **Approved** → Cancelled');
    expect(text).toContain('- **Approved** → *(terminal — no transitions out)*');
  });

  it('says every transition is disabled instead of "no restrictions" (review finding 6)', async () => {
    const allDisabled = goldenTransitions.map(t => ({ ...t, is_enabled: false }));
    const post = vi.fn().mockResolvedValue({ data: allDisabled, status: 200 });
    registerGetStatusWorkflow(server, makeMockClient(post), makeMockCache(), makeMockResolver());

    const text = (await callTool(server, 'get_status_workflow', { entity: 'Reservation Requests' })).content[0].text;

    expect(text).toContain('All 4 configured transitions are disabled');
    expect(text).not.toContain('No transition restrictions');
    expect(text).not.toContain('### Allowed Transitions');
  });

  it('separates sections with a blank line after the "all disabled" message', async () => {
    const second = { ...statusProperty, column_name: 'review_status_id', display_name: 'Review Status' } as SchemaProperty;
    const cache = {
      ensureFreshForUser: vi.fn().mockResolvedValue(undefined),
      getPropertiesForUser: vi.fn().mockReturnValue([statusProperty, second]),
      getStatuses: vi.fn().mockReturnValue(statuses),
    } as unknown as SchemaCache;
    const allDisabled = goldenTransitions.map(t => ({ ...t, is_enabled: false }));
    const post = vi.fn().mockResolvedValue({ data: allDisabled, status: 200 });
    registerGetStatusWorkflow(server, makeMockClient(post), cache, makeMockResolver());

    const text = (await callTool(server, 'get_status_workflow', { entity: 'Reservation Requests' })).content[0].text;

    expect(text).toContain('so none is listed as an allowed move.*\n\n## Review Status Workflow');
  });

  it('says there are no restrictions when the RPC returns none', async () => {
    const post = vi.fn().mockResolvedValue({ data: [], status: 200 });
    registerGetStatusWorkflow(server, makeMockClient(post), makeMockCache(), makeMockResolver());

    const text = (await callTool(server, 'get_status_workflow', { entity: 'Reservation Requests' })).content[0].text;

    expect(text).toContain('No transition restrictions configured');
  });

  it('does not claim "any status change is allowed" when the RPC fails', async () => {
    const post = vi.fn().mockRejectedValue(new PostgRESTRequestError('Not found', 404));
    registerGetStatusWorkflow(server, makeMockClient(post), makeMockCache(), makeMockResolver());

    const result = await callTool(server, 'get_status_workflow', { entity: 'Reservation Requests' });
    const text = result.content[0].text;

    expect(text).toContain('could not be loaded');
    expect(text).not.toContain('No transition restrictions');
    // Status values are still reported
    expect(text).toContain('**Pending**');
  });

  it('re-throws MaintenanceError so the maintenance wrapper can answer', async () => {
    const post = vi.fn().mockRejectedValue(new MaintenanceError('full'));
    registerGetStatusWorkflow(server, makeMockClient(post), makeMockCache(), makeMockResolver());

    await expect(
      callTool(server, 'get_status_workflow', { entity: 'Reservation Requests' }),
    ).rejects.toBeInstanceOf(MaintenanceError);
  });
});
