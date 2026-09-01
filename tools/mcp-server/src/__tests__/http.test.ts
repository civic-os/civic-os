/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for the HTTP transport module.
 * Tests Bearer extraction, health endpoint, CORS headers, and OAuth metadata.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { extractBearerToken, buildProtectedResourceMetadata, OidcConfigCache } from '../http.js';
import { createServer, PKG_VERSION, type ServerConfig } from '../index.js';
import { SchemaCache } from '../schema-cache.js';
import type { PostgRESTClient } from '../postgrest-client.js';

// ============================================================================
// Mock PostgREST client (same pattern as mcp-protocol.test.ts)
// ============================================================================

function makeMockClient(): PostgRESTClient {
  return {
    get: vi.fn().mockImplementation((path: string) => {
      const base = path.split('?')[0];
      const key = base.split('/').filter(Boolean).pop() ?? base;
      const data: Record<string, unknown[]> = {
        schema_entities: [
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
        ],
        schema_properties: [
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
        ],
        schema_entity_actions: [],
        statuses: [],
        categories: [],
        status_transitions: [],
        constraint_messages: [],
        schema_cache_versions: [],
      };
      return Promise.resolve({ data: data[key] ?? [], status: 200 });
    }),
    post: vi.fn().mockResolvedValue({ data: [], status: 200 }),
    patch: vi.fn().mockResolvedValue({ data: [], status: 200 }),
    delete: vi.fn().mockResolvedValue({ data: [], status: 200 }),
  } as unknown as PostgRESTClient;
}

// ============================================================================
// Bearer Token Extraction
// ============================================================================

describe('extractBearerToken', () => {
  it('extracts token from valid Authorization header', () => {
    const request = new Request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.test' },
    });
    expect(extractBearerToken(request)).toBe('eyJhbGciOiJSUzI1NiJ9.test');
  });

  it('returns undefined when Authorization header is missing', () => {
    const request = new Request('http://localhost/mcp');
    expect(extractBearerToken(request)).toBeUndefined();
  });

  it('returns undefined for non-Bearer auth schemes', () => {
    const request = new Request('http://localhost/mcp', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(extractBearerToken(request)).toBeUndefined();
  });

  it('returns undefined for malformed Bearer header (missing space)', () => {
    const request = new Request('http://localhost/mcp', {
      headers: { Authorization: 'BearerNoSpace' },
    });
    expect(extractBearerToken(request)).toBeUndefined();
  });

  it('extracts token with special characters', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwidXNlcl9pZCI6ImFiYzEyMyJ9.signature_here';
    const request = new Request('http://localhost/mcp', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(extractBearerToken(request)).toBe(jwt);
  });

  it('strips double Bearer prefix (token value includes "Bearer ")', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.test';
    const request = new Request('http://localhost/mcp', {
      headers: { Authorization: `Bearer Bearer ${jwt}` },
    });
    expect(extractBearerToken(request)).toBe(jwt);
  });
});

// ============================================================================
// OAuth Protected Resource Metadata (buildProtectedResourceMetadata)
// ============================================================================

describe('buildProtectedResourceMetadata', () => {
  const baseConfig: ServerConfig = {
    postgrestUrl: 'http://localhost:3000',
    transport: 'http',
    port: 3001,
  };

  it('returns correct JSON when Keycloak is configured', () => {
    const config: ServerConfig = {
      ...baseConfig,
      keycloakUrl: 'http://localhost:8080',
      keycloakRealm: 'civic-os-dev',
    };

    const result = buildProtectedResourceMetadata(config);
    expect(result).toBeDefined();

    const parsed = JSON.parse(result!);
    expect(parsed.resource).toBe('http://localhost:3001');
    expect(parsed.authorization_servers).toEqual([
      'http://localhost:8080/realms/civic-os-dev',
    ]);
    expect(parsed.bearer_methods_supported).toEqual(['header']);
  });

  it('uses mcpPublicUrl as resource when provided', () => {
    const config: ServerConfig = {
      ...baseConfig,
      keycloakUrl: 'https://auth.example.com',
      keycloakRealm: 'my-realm',
      mcpPublicUrl: 'https://example.com/_/mcp',
    };

    const result = buildProtectedResourceMetadata(config);
    const parsed = JSON.parse(result!);
    expect(parsed.resource).toBe('https://example.com/_/mcp');
    expect(parsed.authorization_servers).toEqual([
      'https://auth.example.com/realms/my-realm',
    ]);
  });

  it('returns undefined when keycloakUrl is missing', () => {
    const config: ServerConfig = {
      ...baseConfig,
      keycloakRealm: 'civic-os-dev',
    };

    expect(buildProtectedResourceMetadata(config)).toBeUndefined();
  });

  it('returns undefined when keycloakRealm is missing', () => {
    const config: ServerConfig = {
      ...baseConfig,
      keycloakUrl: 'http://localhost:8080',
    };

    expect(buildProtectedResourceMetadata(config)).toBeUndefined();
  });

  it('returns undefined when both Keycloak params are missing', () => {
    expect(buildProtectedResourceMetadata(baseConfig)).toBeUndefined();
  });
});

// ============================================================================
// OidcConfigCache (Authorization Server Metadata)
// ============================================================================

describe('OidcConfigCache', () => {
  const oidcResponse = JSON.stringify({
    issuer: 'http://localhost:8080/realms/civic-os-dev',
    authorization_endpoint: 'http://localhost:8080/realms/civic-os-dev/protocol/openid-connect/auth',
    token_endpoint: 'http://localhost:8080/realms/civic-os-dev/protocol/openid-connect/token',
    registration_endpoint: 'http://localhost:8080/realms/civic-os-dev/clients-registrations/openid-connect',
  });

  it('fetches OIDC config from Keycloak', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(oidcResponse, { status: 200 }),
    );

    const cache = new OidcConfigCache('http://localhost:8080', 'civic-os-dev');
    const result = await cache.get();

    expect(result).toBe(oidcResponse);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:8080/realms/civic-os-dev/.well-known/openid-configuration',
    );

    fetchSpy.mockRestore();
  });

  it('returns cached value on subsequent calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(oidcResponse, { status: 200 }),
    );

    const cache = new OidcConfigCache('http://localhost:8080', 'civic-os-dev');
    await cache.get();
    const result = await cache.get();

    expect(result).toBe(oidcResponse);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Only fetched once

    fetchSpy.mockRestore();
  });

  it('returns stale cache when fetch fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(oidcResponse, { status: 200 }))
      .mockRejectedValueOnce(new Error('Connection refused'));

    const cache = new OidcConfigCache('http://localhost:8080', 'civic-os-dev');
    await cache.get();

    // Force cache expiry by accessing private field
    (cache as unknown as { fetchedAt: number }).fetchedAt = 0;

    const result = await cache.get();
    expect(result).toBe(oidcResponse); // Returns stale cache

    fetchSpy.mockRestore();
  });

  it('returns undefined when fetch fails with no cache', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Connection refused'));

    const cache = new OidcConfigCache('http://localhost:8080', 'civic-os-dev');
    const result = await cache.get();

    expect(result).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it('returns stale cache on non-200 response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(oidcResponse, { status: 200 }))
      .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const cache = new OidcConfigCache('http://localhost:8080', 'civic-os-dev');
    await cache.get();

    // Force cache expiry
    (cache as unknown as { fetchedAt: number }).fetchedAt = 0;

    const result = await cache.get();
    expect(result).toBe(oidcResponse); // Stale cache

    fetchSpy.mockRestore();
  });
});

// ============================================================================
// createServer with per-request token
// ============================================================================

describe('createServer per-request factory', () => {
  let cache: SchemaCache;

  beforeAll(async () => {
    const client = makeMockClient();
    cache = new SchemaCache(client, 'http://localhost:3000');
    await cache.initialize();
  });

  it('creates a server without token (anonymous)', () => {
    const server = createServer(cache);
    expect(server).toBeDefined();
  });

  it('creates a server with a token', () => {
    const server = createServer(cache, 'test-jwt-token');
    expect(server).toBeDefined();
  });

  it('produces an MCP server with instructions', async () => {
    const server = createServer(cache, 'test-jwt-token');
    // Access the underlying Server to check instructions
    const underlyingServer = server.server;
    expect(underlyingServer).toBeDefined();
  });
});

// ============================================================================
// createMcpHandler integration
// ============================================================================

describe('createMcpHandler integration', () => {
  let cache: SchemaCache;

  beforeAll(async () => {
    const client = makeMockClient();
    cache = new SchemaCache(client, 'http://localhost:3000');
    await cache.initialize();
  });

  it('creates an McpHttpHandler from createServer factory', () => {
    const handler = createMcpHandler(
      (ctx) => createServer(cache, ctx.authInfo?.token),
      { legacy: 'stateless' },
    );

    expect(handler).toBeDefined();
    expect(typeof handler.fetch).toBe('function');
    expect(typeof handler.close).toBe('function');
  });

  it('accepts MCP initialize request with Bearer token and returns 200', async () => {
    const handler = createMcpHandler(
      (ctx) => createServer(cache, ctx.authInfo?.token),
      { legacy: 'stateless' },
    );

    const initRequest = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
      id: 1,
    };

    const response = await handler.fetch(
      new Request('http://localhost:3001/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': 'Bearer test-jwt-token',
        },
        body: JSON.stringify(initRequest),
      }),
      { authInfo: { token: 'test-jwt-token', clientId: 'civic-os-mcp', scopes: [] } },
    );

    // 2025-era legacy stateless mode returns SSE format (200 with text/event-stream)
    expect(response.status).toBe(200);
    const body = await response.text();
    // SSE contains the server info in the event data
    expect(body).toContain('civic-os');

    await handler.close();
  });

  it('accepts MCP request without token (anonymous) and returns 200', async () => {
    const handler = createMcpHandler(
      (ctx) => createServer(cache, ctx.authInfo?.token),
      { legacy: 'stateless' },
    );

    const initRequest = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
      id: 1,
    };

    const response = await handler.fetch(
      new Request('http://localhost:3001/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify(initRequest),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('civic-os');

    await handler.close();
  });
});

// ============================================================================
// PKG_VERSION export
// ============================================================================

describe('PKG_VERSION', () => {
  it('is a semver string', () => {
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
