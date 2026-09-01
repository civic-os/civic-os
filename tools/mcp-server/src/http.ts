/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * HTTP Streamable transport for the Civic OS MCP server.
 * Uses createMcpHandler from the MCP SDK for protocol handling,
 * with custom routing for health checks, CORS, and OAuth discovery.
 *
 * Token passthrough: The server never verifies JWTs — it extracts
 * the Bearer token from the Authorization header and forwards it to
 * PostgREST, which handles verification via check_jwt() + JWKS.
 */

import {
  createMcpHandler,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import type { SchemaCache } from './schema-cache.js';
import { createServer, PKG_VERSION, type ServerConfig } from './index.js';

// Bun runtime type declaration for runtime detection
declare const Bun: { serve(options: { port: number; fetch: (req: Request) => Promise<Response> }): unknown } | undefined;

// ============================================================================
// CORS Headers
// ============================================================================

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

/** Add CORS headers to a Response */
function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

// ============================================================================
// Bearer Token Extraction
// ============================================================================

/** Extract Bearer token from Authorization header — no verification. */
export function extractBearerToken(request: Request): string | undefined {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    // Defensive: strip a second "Bearer " prefix in case the token value
    // itself was configured with the prefix (e.g., "Bearer eyJ..." in a config file)
    return token.startsWith('Bearer ') ? token.slice(7) : token;
  }
  return undefined;
}

// ============================================================================
// Health Check
// ============================================================================

function healthResponse(): Response {
  return new Response(
    JSON.stringify({ status: 'ok', version: PKG_VERSION }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

// ============================================================================
// OAuth Protected Resource Metadata (RFC 9728)
// ============================================================================

/**
 * Build the OAuth Protected Resource Metadata JSON response (RFC 9728).
 * Served at /.well-known/oauth-protected-resource.
 */
export function buildProtectedResourceMetadata(config: ServerConfig): string | undefined {
  if (!config.keycloakUrl || !config.keycloakRealm) {
    return undefined;
  }

  const realmUrl = `${config.keycloakUrl}/realms/${config.keycloakRealm}`;
  const resourceUrl = config.mcpPublicUrl ?? `http://localhost:${config.port}`;

  return JSON.stringify({
    resource: resourceUrl,
    authorization_servers: [realmUrl],
    bearer_methods_supported: ['header'],
  });
}

// ============================================================================
// OAuth Authorization Server Metadata (RFC 8414)
// ============================================================================

/**
 * Fetch and cache Keycloak's OIDC discovery document for the configured realm.
 *
 * The MCP server serves this at /.well-known/oauth-authorization-server so it
 * is fully self-contained — the routing layer (Caddy, K8s HTTPRoute, nginx)
 * only needs to route /.well-known/oauth-* paths to the MCP server, with no
 * Keycloak-specific proxy rules. This makes the deployment portable across
 * infrastructure types.
 *
 * The OIDC config is cached for 1 hour. On fetch failure, stale cache is
 * returned if available; otherwise a 503 is sent.
 */
export class OidcConfigCache {
  private json: string | undefined;
  private fetchedAt = 0;
  private readonly ttlMs = 60 * 60 * 1000; // 1 hour
  private readonly oidcUrl: string;

  constructor(keycloakUrl: string, keycloakRealm: string) {
    this.oidcUrl = `${keycloakUrl}/realms/${keycloakRealm}/.well-known/openid-configuration`;
  }

  async get(): Promise<string | undefined> {
    if (this.json && Date.now() - this.fetchedAt < this.ttlMs) {
      return this.json;
    }

    try {
      const response = await fetch(this.oidcUrl);
      if (!response.ok) {
        console.error(`Failed to fetch OIDC config from ${this.oidcUrl}: ${response.status}`);
        return this.json; // stale cache
      }
      this.json = await response.text();
      this.fetchedAt = Date.now();
      return this.json;
    } catch (err) {
      console.error('Failed to fetch OIDC config:', err instanceof Error ? err.message : err);
      return this.json; // stale cache
    }
  }
}

// ============================================================================
// HTTP Server
// ============================================================================

/**
 * Start the HTTP server with MCP Streamable transport.
 * Handles routing: health → OAuth discovery → CORS preflight → MCP handler.
 */
export async function startHttpServer(cache: SchemaCache, config: ServerConfig): Promise<void> {
  // Create the MCP handler with per-request server factory
  const handler: McpHttpHandler = createMcpHandler(
    (ctx) => createServer(cache, ctx.authInfo?.token),
    { legacy: 'stateless' },
  );

  // Build protected resource metadata JSON (undefined if Keycloak not configured)
  const protectedResourceJson = buildProtectedResourceMetadata(config);

  // OIDC config cache for oauth-authorization-server endpoint
  const oidcCache = (config.keycloakUrl && config.keycloakRealm)
    ? new OidcConfigCache(config.keycloakUrl, config.keycloakRealm)
    : undefined;

  // Pre-fetch OIDC config on startup (best-effort, non-blocking)
  oidcCache?.get().catch(() => {});

  // Request handler: route health, OAuth, CORS, then MCP
  const handleRequest = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // Health check — no CORS needed (internal use)
    if (url.pathname === '/health') {
      return healthResponse();
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    // OAuth Protected Resource Metadata (RFC 9728)
    // Matches /.well-known/oauth-protected-resource and any suffix (e.g., /_/mcp)
    if (protectedResourceJson && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return withCors(new Response(protectedResourceJson, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // OAuth Authorization Server Metadata (RFC 8414)
    // Fetches from Keycloak and caches — makes MCP server self-contained
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      if (!oidcCache) {
        return withCors(new Response(
          JSON.stringify({ error: 'OAuth not configured (KEYCLOAK_URL/KEYCLOAK_REALM not set)' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ));
      }
      const oidcJson = await oidcCache.get();
      if (oidcJson) {
        return withCors(new Response(oidcJson, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return withCors(new Response(
        JSON.stringify({ error: 'OIDC configuration not available — Keycloak may be unreachable' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ));
    }

    // MCP handler — extract Bearer token and pass as authInfo
    // clientId and scopes are required by AuthInfo but not needed for transparent passthrough;
    // PostgREST handles all authorization via the JWT itself.
    const token = extractBearerToken(request);
    const response = await handler.fetch(request, {
      authInfo: token ? { token, clientId: 'civic-os-mcp', scopes: [] } : undefined,
    });
    return withCors(response);
  };

  const port = config.port;

  // Use Bun.serve() if available (Docker container), otherwise Node http
  if (typeof Bun !== 'undefined') {
    Bun.serve({ port, fetch: handleRequest });
  } else {
    // Node.js fallback — convert web-standard fetch handler to Node http
    const { createServer: createHttpServer } = await import('node:http');
    const server = createHttpServer(async (req, res) => {
      // Build a web-standard Request from Node's IncomingMessage
      const protocol = 'http';
      const host = req.headers.host ?? `localhost:${port}`;
      const url = `${protocol}://${host}${req.url ?? '/'}`;

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }

      let body: string | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
        body = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });
      }

      const webRequest = new Request(url, {
        method: req.method ?? 'GET',
        headers,
        body,
      });

      const webResponse = await handleRequest(webRequest);

      // Write web Response back to Node response
      res.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
      const responseBody = await webResponse.text();
      res.end(responseBody);
    });

    server.listen(port);
  }

  console.error(`MCP server listening on http://0.0.0.0:${port} (HTTP Streamable transport)`);
  if (protectedResourceJson) {
    console.error(`OAuth discovery enabled (protected-resource + authorization-server): ${config.keycloakUrl}/realms/${config.keycloakRealm}`);
  }
}
