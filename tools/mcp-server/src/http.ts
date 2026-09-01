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
  oauthMetadataResponse,
  type AuthMetadataOptions,
  type McpHttpHandler,
  type OAuthMetadata,
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
    return authHeader.slice(7);
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
// OAuth Discovery (optional)
// ============================================================================

function buildAuthMetadataOptions(config: ServerConfig): AuthMetadataOptions | undefined {
  if (!config.keycloakUrl || !config.keycloakRealm) {
    return undefined;
  }

  const realmUrl = `${config.keycloakUrl}/realms/${config.keycloakRealm}`;
  const resourceServerUrl = config.mcpPublicUrl
    ? new URL(config.mcpPublicUrl)
    : new URL(`http://localhost:${config.port}`);

  const oauthMetadata: OAuthMetadata = {
    issuer: realmUrl,
    authorization_endpoint: `${realmUrl}/protocol/openid-connect/auth`,
    token_endpoint: `${realmUrl}/protocol/openid-connect/token`,
    registration_endpoint: `${realmUrl}/clients-registrations/openid-connect`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
  };

  return {
    resourceServerUrl,
    oauthMetadata,
    resourceName: 'Civic OS MCP',
    dangerouslyAllowInsecureIssuerUrl: true,
  };
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

  // Build OAuth metadata options (undefined if Keycloak not configured)
  const authMetadataOptions = buildAuthMetadataOptions(config);

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

    // OAuth discovery (optional — only if Keycloak configured)
    if (authMetadataOptions) {
      const metadataResponse = oauthMetadataResponse(request, authMetadataOptions);
      if (metadataResponse) {
        return withCors(metadataResponse);
      }
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
  if (authMetadataOptions) {
    console.error(`OAuth discovery enabled: ${config.keycloakUrl}/realms/${config.keycloakRealm}`);
  }
}
