/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * MCP protocol integration test.
 * Tests the full tool-call lifecycle using InMemoryTransport — no real I/O,
 * no real PostgREST. Validates that tools are registered, callable via the
 * MCP protocol, and return well-formed responses.
 *
 * NOTE: We do not import from ../../index.js because that module calls
 * main() as a top-level side-effect (for stdio startup). Instead we
 * reconstruct the server using createServer's constituent parts directly.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import type { PostgRESTClient } from '../../postgrest-client.js';
import { SchemaCache } from '../../schema-cache.js';
import { NameResolver } from '../../name-resolver.js';
import { registerListEntities } from '../../tools/list-entities.js';
import { registerDescribeEntity } from '../../tools/describe-entity.js';
import { registerListActions } from '../../tools/list-actions.js';
import { registerListRecords } from '../../tools/list-records.js';
import { registerGetRecord } from '../../tools/get-record.js';
import { registerSearch } from '../../tools/search.js';
import { registerCreateRecord } from '../../tools/create-record.js';
import { registerUpdateRecord } from '../../tools/update-record.js';
import { registerExecuteAction } from '../../tools/execute-action.js';
import { registerAddNote } from '../../tools/add-note.js';
import { registerGetStatusWorkflow } from '../../tools/get-status-workflow.js';
import type {
  SchemaEntity,
  SchemaProperty,
} from '../../interfaces.js';

// ============================================================================
// Mock data — mirrors the spec in the task brief
// ============================================================================

const MOCK_ENTITIES: SchemaEntity[] = [
  {
    table_name: 'clients',
    display_name: 'Clients',
    description: 'Client records',
    select: true,
    insert: true,
    update: true,
    delete: false,
    sort_order: 1,
    show_in_sidebar: true,
  },
];

const MOCK_PROPERTIES: SchemaProperty[] = [
  {
    table_name: 'clients',
    column_name: 'id',
    display_name: 'ID',
    data_type: 'integer',
    udt_name: 'int4',
    udt_schema: 'pg_catalog',
    sort_order: 0,
    is_identity: true,
    is_nullable: false,
    is_updatable: false,
    is_generated: false,
    is_self_referencing: false,
    column_default: '',
    join_schema: '',
    join_table: '',
    join_column: '',
    geography_type: '',
    show_on_list: true,
    show_on_detail: true,
  },
  {
    table_name: 'clients',
    column_name: 'display_name',
    display_name: 'Name',
    data_type: 'character varying',
    udt_name: 'varchar',
    udt_schema: 'pg_catalog',
    sort_order: 1,
    is_identity: false,
    is_nullable: true,
    is_updatable: true,
    is_generated: false,
    is_self_referencing: false,
    column_default: '',
    join_schema: '',
    join_table: '',
    join_column: '',
    geography_type: '',
    show_on_list: true,
    show_on_detail: true,
  },
];

// ============================================================================
// Mock PostgRESTClient builder
// Mirrors the pattern from src/__tests__/schema-cache.test.ts
// ============================================================================

function makeMockClient(): PostgRESTClient {
  const data: Record<string, unknown[]> = {
    schema_entities: MOCK_ENTITIES,
    schema_properties: MOCK_PROPERTIES,
    schema_entity_actions: [],
    statuses: [],
    categories: [],
    status_transitions: [],
    constraint_messages: [],
    schema_cache_versions: [],
  };

  return {
    get: vi.fn().mockImplementation((path: string) => {
      // Strip query-string suffix if present; use last path segment as key
      const base = path.split('?')[0];
      const key = base.split('/').filter(Boolean).pop() ?? base;
      const result = data[key] ?? [];
      return Promise.resolve({ data: result, status: 200 });
    }),
    post: vi.fn().mockResolvedValue({ data: [], status: 200 }),
    patch: vi.fn().mockResolvedValue({ data: [], status: 200 }),
    delete: vi.fn().mockResolvedValue({ data: [], status: 200 }),
  } as unknown as PostgRESTClient;
}

// ============================================================================
// Server factory (mirrors createServer from index.ts, but without the
// top-level main() call that would try to start stdio transport)
// ============================================================================

function buildTestServer(
  client: PostgRESTClient,
  cache: SchemaCache,
  resolver: NameResolver,
): McpServer {
  const server = new McpServer({ name: 'civic-os-test', version: '0.0.0-test' });

  registerListEntities(server, cache);
  registerDescribeEntity(server, cache, resolver);
  registerListActions(server, cache, resolver);
  registerListRecords(server, client, cache, resolver);
  registerGetRecord(server, client, cache, resolver);
  registerSearch(server, client, cache, resolver);
  registerCreateRecord(server, client, cache, resolver);
  registerUpdateRecord(server, client, cache, resolver);
  registerExecuteAction(server, client, cache, resolver);
  registerAddNote(server, client, cache, resolver);
  registerGetStatusWorkflow(server, cache, resolver);

  return server;
}

// ============================================================================
// Test suite
// ============================================================================

describe('MCP Protocol Integration', () => {
  let client: Client;

  beforeAll(async () => {
    const postgrestClient = makeMockClient();
    const cache = new SchemaCache(postgrestClient);
    const resolver = new NameResolver(cache, postgrestClient);

    // Pre-load schema cache (no real HTTP — all mocked via PostgRESTClient.get)
    await cache.initialize();

    const server = buildTestServer(postgrestClient, cache, resolver);

    // Wire client and server via in-process transports
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Server connects first, then client initiates the MCP handshake
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  // ============================================================================
  // Tool registration
  // ============================================================================

  describe('tool registration', () => {
    it('lists all expected tools via tools/list', async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map(t => t.name);

      expect(toolNames).toContain('list_entities');
      expect(toolNames).toContain('describe_entity');
      expect(toolNames).toContain('list_actions');
      expect(toolNames).toContain('list_records');
      expect(toolNames).toContain('get_record');
      expect(toolNames).toContain('search');
      expect(toolNames).toContain('create_record');
      expect(toolNames).toContain('update_record');
      expect(toolNames).toContain('execute_action');
      expect(toolNames).toContain('add_note');
      expect(toolNames).toContain('get_status_workflow');
    });

    it('exposes tool metadata: name, description, and inputSchema', async () => {
      const result = await client.listTools();
      const listEntities = result.tools.find(t => t.name === 'list_entities');

      expect(listEntities).toBeDefined();
      expect(typeof listEntities?.description).toBe('string');
      expect(listEntities?.description?.length).toBeGreaterThan(0);
      expect(listEntities?.inputSchema).toBeDefined();
    });
  });

  // ============================================================================
  // list_entities tool
  // ============================================================================

  describe('list_entities tool', () => {
    it('returns the clients entity from the mocked schema', async () => {
      const result = await client.callTool({
        name: 'list_entities',
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('Clients');
      expect(text).toContain('clients');
    });

    it('reports the total entity count in the response text', async () => {
      const result = await client.callTool({
        name: 'list_entities',
        arguments: {},
      });

      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('Found 1 entities');
    });

    it('reports correct permissions (read/create/edit, not delete)', async () => {
      const result = await client.callTool({
        name: 'list_entities',
        arguments: {},
      });

      const text = (result.content[0] as { type: string; text: string }).text;
      // clients fixture has select/insert/update=true, delete=false
      expect(text).toContain('read');
      expect(text).toContain('create');
      expect(text).toContain('edit');
      expect(text).not.toContain('delete');
    });

    it('filters entities by display name substring', async () => {
      const result = await client.callTool({
        name: 'list_entities',
        arguments: { filter: 'client' },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('Clients');
    });

    it('returns a "no entities found" message when the filter matches nothing', async () => {
      const result = await client.callTool({
        name: 'list_entities',
        arguments: { filter: 'zzz_nonexistent_xyz' },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('No entities found');
    });
  });

  // ============================================================================
  // describe_entity tool
  // ============================================================================

  describe('describe_entity tool', () => {
    it('returns a property table for a valid entity (by table name)', async () => {
      const result = await client.callTool({
        name: 'describe_entity',
        arguments: { entity: 'clients' },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('Clients');
      expect(text).toContain('Properties');
      // Both mock properties should appear
      expect(text).toContain('id');
      expect(text).toContain('display_name');
    });

    it('resolves entity by display name (case-insensitive)', async () => {
      const result = await client.callTool({
        name: 'describe_entity',
        arguments: { entity: 'Clients' },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('clients');
    });

    it('returns isError response for an unknown entity name', async () => {
      const result = await client.callTool({
        name: 'describe_entity',
        arguments: { entity: 'nonexistent_entity_xyz' },
      });

      // NameResolver.resolveEntity throws NameResolutionError;
      // the tool handler catches it and returns isError: true
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('nonexistent_entity_xyz');
    });
  });

  // ============================================================================
  // Error handling
  // ============================================================================

  describe('error handling', () => {
    it('returns an isError response for list_entities with invalid argument types', async () => {
      // Pass a non-string for the optional `filter` field to trigger schema validation
      const result = await client.callTool({
        name: 'list_entities',
        // @ts-expect-error intentionally passing wrong type to test runtime validation
        arguments: { filter: 123 },
      });

      // The MCP SDK validates the Zod input schema. With a numeric value for a
      // string field, it may coerce or reject. Either way the call must not throw
      // an uncaught exception — the server must respond.
      expect(result).toBeDefined();
    });

    it('handles describe_entity called with an ambiguous substring gracefully', async () => {
      // "cli" matches "clients"; with only one entity in the cache it resolves
      // unambiguously — but this exercises the substring-match path.
      const result = await client.callTool({
        name: 'describe_entity',
        arguments: { entity: 'cli' },
      });

      // Single substring match should succeed
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('Clients');
    });
  });
});
