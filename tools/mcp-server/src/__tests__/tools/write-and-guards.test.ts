/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Tests for behavior the core migration introduced in the MCP tools: value
 * normalization before create/update (ledger X-01), the empty-id guards that
 * keep core's empty-filter drop (Q-08) from widening a request, the Range plus
 * count read in list_records (Q-02), and the page validation message.
 */

import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerCreateRecord } from '../../tools/create-record.js';
import { registerUpdateRecord } from '../../tools/update-record.js';
import { registerGetRecord } from '../../tools/get-record.js';
import { registerListRecords } from '../../tools/list-records.js';
import type { SchemaCache } from '../../schema-cache.js';
import type { NameResolver } from '../../name-resolver.js';
import type { SchemaEntity, SchemaProperty } from '../../interfaces.js';
import { EntityPropertyType } from '@civic-os/core';
import { withTransport } from '../mock-transport.js';

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<Result> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { executor: (a: unknown) => Promise<unknown> }>;
  return tools[name].executor(args) as Promise<Result>;
}

const entity: SchemaEntity = {
  display_name: 'Events', table_name: 'events', description: null, sort_order: 1,
  insert: true, select: true, update: true, delete: false,
};

function prop(column: string, type: EntityPropertyType, extra: Partial<SchemaProperty> = {}): SchemaProperty {
  return {
    table_name: 'events', column_name: column, display_name: column, data_type: 'text', udt_name: 'text',
    udt_schema: 'pg_catalog', sort_order: 1, join_schema: '', join_table: '', join_column: '', geography_type: '',
    is_nullable: true, is_updatable: true, is_identity: false, is_generated: false, is_self_referencing: false,
    column_default: '', show_on_detail: true, show_on_list: true, type, ...extra,
  } as SchemaProperty;
}

const properties = [
  prop('id', EntityPropertyType.IntegerNumber, { is_identity: true, data_type: 'integer', udt_name: 'int4' }),
  prop('starts_at', EntityPropertyType.DateTimeLocal, { data_type: 'timestamp with time zone', udt_name: 'timestamptz' }),
  prop('title', EntityPropertyType.TextShort),
];

function mocks(records: unknown[] = [{ id: 1 }], contentRange?: { from: number; to: number; total: number | null }) {
  const raw = {
    get: vi.fn().mockResolvedValue({ data: records, status: 200, contentRange }),
    post: vi.fn().mockResolvedValue({ data: [{ id: 9 }], status: 201 }),
    patch: vi.fn().mockResolvedValue({ data: [{ id: 1 }], status: 200 }),
    delete: vi.fn(),
    setToken: vi.fn(),
  };
  const client = withTransport(raw as never);
  const cache = {
    ensureFreshForUser: vi.fn().mockResolvedValue(undefined),
    getPropertiesForUser: vi.fn().mockReturnValue(properties),
    getActionsForUser: vi.fn().mockReturnValue([]),
    constraintMessages: [],
  } as unknown as SchemaCache;
  const resolver = {
    resolveEntity: vi.fn().mockReturnValue(entity),
    resolveColumn: vi.fn().mockImplementation((_t: string, n: string) => properties.find(p => p.column_name === n)),
    resolveData: vi.fn().mockImplementation(async (_t: string, d: Record<string, unknown>) => ({ ...d })),
  } as unknown as NameResolver;
  return { raw, client, cache, resolver };
}

describe('create_record / update_record value normalization (X-01)', () => {
  it('create_record rejects a timestamptz without an offset and sends nothing', async () => {
    const { raw, client, cache, resolver } = mocks();
    const server = new McpServer({ name: 't', version: '0' });
    registerCreateRecord(server, client, cache, resolver);
    const res = await callTool(server, 'create_record', { entity: 'events', data: { starts_at: '2026-03-01T10:00:00' } });
    expect(res.isError).toBe(true);
    expect(raw.post).not.toHaveBeenCalled();
  });

  it('create_record sends an ISO value with an offset as canonical UTC', async () => {
    const { raw, client, cache, resolver } = mocks();
    const server = new McpServer({ name: 't', version: '0' });
    registerCreateRecord(server, client, cache, resolver);
    const res = await callTool(server, 'create_record', { entity: 'events', data: { starts_at: '2026-03-01T10:00:00Z' } });
    expect(res.isError).toBeUndefined();
    expect(raw.post).toHaveBeenCalledWith('events', { starts_at: '2026-03-01T10:00:00.000Z' }, expect.anything());
  });

  it('update_record rejects a timestamptz without an offset and sends nothing', async () => {
    const { raw, client, cache, resolver } = mocks();
    const server = new McpServer({ name: 't', version: '0' });
    registerUpdateRecord(server, client, cache, resolver);
    const res = await callTool(server, 'update_record', { entity: 'events', id: 1, data: { starts_at: 'tomorrow' } });
    expect(res.isError).toBe(true);
    expect(raw.patch).not.toHaveBeenCalled();
  });

  it('update_record with an empty id sends no request and reports not found', async () => {
    const { raw, client, cache, resolver } = mocks();
    const server = new McpServer({ name: 't', version: '0' });
    registerUpdateRecord(server, client, cache, resolver);
    const res = await callTool(server, 'update_record', { entity: 'events', id: '', data: { title: 'x' } });
    expect(res.isError).toBe(true);
    expect(raw.patch).not.toHaveBeenCalled();
  });
});

describe('empty-id guard and list_records window (Q-08, Q-02, Q-16)', () => {
  it('get_record with an empty id sends no request (core would drop the empty filter)', async () => {
    const { raw, client, cache, resolver } = mocks();
    const server = new McpServer({ name: 't', version: '0' });
    registerGetRecord(server, client, cache, resolver);
    const res = await callTool(server, 'get_record', { entity: 'events', id: '' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
    expect(raw.get).not.toHaveBeenCalled();
  });

  it('list_records reads a Range window with an exact count', async () => {
    const { raw, client, cache, resolver } = mocks([{ id: 1 }], { from: 0, to: 0, total: 41 });
    const server = new McpServer({ name: 't', version: '0' });
    registerListRecords(server, client, cache, resolver);
    const res = await callTool(server, 'list_records', { entity: 'events', limit: 5, offset: 10 });
    const headers = raw.get.mock.calls[0][2] as Record<string, string>;
    expect(headers['Range']).toBe('10-14');
    expect(headers['Prefer']).toContain('count=exact');
    expect(res.content[0].text).toContain('41');
  });

  it('list_records rejects a limit above the maximum of 100 without a request', async () => {
    const { raw, client, cache, resolver } = mocks();
    const server = new McpServer({ name: 't', version: '0' });
    registerListRecords(server, client, cache, resolver);
    const res = await callTool(server, 'list_records', { entity: 'events', limit: 101 });
    expect(res.isError).toBe(true);
    expect(raw.get).not.toHaveBeenCalled();
  });
});
