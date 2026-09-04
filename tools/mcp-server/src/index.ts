#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Civic OS MCP Server — semantic API adapter over PostgREST.
 * Provides LLM-friendly tools for browsing entities, querying records,
 * creating/updating data, and executing entity actions.
 *
 * Usage:
 *   npx @civic-os/mcp-server --url http://localhost:3000 --token <jwt>
 *
 * Transport:
 *   - stdio (default for CLI): for local development and MCP clients like Claude Desktop
 *   - http (default in Docker): for hosted deployment behind a reverse proxy
 */

import { createRequire } from 'node:module';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { PostgRESTClient } from './postgrest-client.js';
import { SchemaCache } from './schema-cache.js';
import { NameResolver } from './name-resolver.js';
import { extractUserCacheKey, extractUserId } from './jwt-utils.js';
import { configureLogging, getLogger } from './logger.js';

// Read version from package.json so it stays in sync with the root Civic OS version.
const require = createRequire(import.meta.url);
export const PKG_VERSION: string = (require('../package.json') as { version: string }).version;

// Tool registrations
import { registerListEntities } from './tools/list-entities.js';
import { registerDescribeEntity } from './tools/describe-entity.js';
import { registerListActions } from './tools/list-actions.js';
import { registerListRecords } from './tools/list-records.js';
import { registerGetRecord } from './tools/get-record.js';
import { registerSearch } from './tools/search.js';
import { registerCreateRecord } from './tools/create-record.js';
import { registerUpdateRecord } from './tools/update-record.js';
import { registerExecuteAction } from './tools/execute-action.js';
import { registerAddNote } from './tools/add-note.js';
import { registerListNotes } from './tools/list-notes.js';
import { registerGetStatusWorkflow } from './tools/get-status-workflow.js';

// ============================================================================
// Configuration
// ============================================================================

export interface ServerConfig {
  postgrestUrl: string;
  token?: string;
  transport: 'stdio' | 'http';
  port: number;
  keycloakUrl?: string;
  keycloakRealm?: string;
  mcpPublicUrl?: string;
  serverInstructions?: string;
  logLevel?: string;
}

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  let postgrestUrl = process.env['POSTGREST_URL'] ?? 'http://localhost:3000';
  let token = process.env['CIVICOS_TOKEN'];
  let transport: 'stdio' | 'http' =
    (process.env['MCP_TRANSPORT'] as 'stdio' | 'http') ?? 'stdio';
  let port = parseInt(process.env['MCP_PORT'] ?? '3001', 10);
  let serverInstructions = process.env['MCP_SERVER_INSTRUCTIONS'];
  let logLevel = process.env['MCP_LOG_LEVEL'];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
      case '-u':
        postgrestUrl = args[++i];
        break;
      case '--token':
      case '-t':
        token = args[++i];
        break;
      case '--transport':
        transport = args[++i] as 'stdio' | 'http';
        break;
      case '--port':
        port = parseInt(args[++i], 10);
        break;
      case '--instructions':
        serverInstructions = args[++i];
        break;
      case '--log-level':
        logLevel = args[++i];
        break;
      case '--help':
      case '-h':
        console.error(`
Civic OS MCP Server v${PKG_VERSION}

Usage:
  civicos-mcp [options]

Options:
  --url, -u <url>        PostgREST base URL (default: $POSTGREST_URL or http://localhost:3000)
  --token, -t <jwt>      JWT token for authentication (default: $CIVICOS_TOKEN, stdio only)
  --transport <mode>     Transport: stdio (default) or http (default: $MCP_TRANSPORT)
  --port <port>          HTTP port (default: $MCP_PORT or 3001)
  --instructions <text>  Instance context prepended to server instructions ($MCP_SERVER_INSTRUCTIONS)
  --log-level <level>    Log level: debug, info, warning, error, fatal, silent ($MCP_LOG_LEVEL, default: info)
  --help, -h             Show this help message

Environment Variables:
  POSTGREST_URL          PostgREST base URL
  CIVICOS_TOKEN          JWT token for authentication (stdio mode)
  MCP_TRANSPORT          Transport mode: stdio or http
  MCP_PORT               HTTP server port (default: 3001)
  MCP_SERVER_INSTRUCTIONS  Instance context prepended to generic usage instructions
  MCP_LOG_LEVEL          Log level: debug, info, warning, error, fatal, silent (default: info)
  KEYCLOAK_URL           Keycloak base URL (enables OAuth discovery in http mode)
  KEYCLOAK_REALM         Keycloak realm name (default: civic-os)
  MCP_PUBLIC_URL         Public URL of the MCP server (for OAuth metadata)

Examples:
  civicos-mcp --url http://localhost:3000 --token eyJ...
  MCP_TRANSPORT=http civicos-mcp --url http://postgrest:3000
`);
        process.exit(0);
    }
  }

  return {
    postgrestUrl,
    token,
    transport,
    port,
    serverInstructions,
    logLevel,
    keycloakUrl: process.env['KEYCLOAK_URL'],
    keycloakRealm: process.env['KEYCLOAK_REALM'] ?? 'civic-os',
    mcpPublicUrl: process.env['MCP_PUBLIC_URL'],
  };
}

// ============================================================================
// Server Instructions
// ============================================================================

const BASE_INSTRUCTIONS = `You are connected to a Civic OS instance — a meta-application framework that dynamically generates CRUD views from PostgreSQL schema metadata.

Getting started:
- Start with list_entities to discover available data types and your permissions
- Use describe_entity before querying to understand field types, relationships, and available actions
- Use list_records to browse data with filters, search, and pagination

Working with data:
- Always get_record before update_record to see the current state
- Prefer execute_action over update_record for status changes and workflows
- Foreign key fields accept display names (e.g., "Acme Corp") — the server resolves them to IDs
- Use add_note for comments and audit trails on entities that support notes
- Use get_status_workflow to understand allowed state transitions before changing statuses`;

/**
 * Build the full instructions string for the MCP server.
 * When serverInstructions is provided (via MCP_SERVER_INSTRUCTIONS env var),
 * it is prepended before the generic usage instructions so LLM clients
 * immediately understand the purpose of this specific instance.
 */
export function buildInstructions(serverInstructions?: string): string {
  if (!serverInstructions) return BASE_INSTRUCTIONS;
  return serverInstructions + '\n\n' + BASE_INSTRUCTIONS;
}

// ============================================================================
// Server Factory
// ============================================================================

/**
 * Intercept server.registerTool() to wrap every tool handler with timing and logging.
 * Avoids modifying individual tool files — the proxy is installed once before registration.
 */
function instrumentToolHandlers(server: McpServer, userId?: string): void {
  const toolLogger = getLogger(['mcp', 'tool']);
  const origRegisterTool = server.registerTool.bind(server);

  server.registerTool = ((...args: unknown[]) => {
    const toolName = args[0] as string;
    const handlerIdx = args.length - 1;
    const handler = args[handlerIdx] as (a: Record<string, unknown>, e: unknown) => Promise<{ content?: Array<{ text?: string }>; isError?: boolean }>;

    args[handlerIdx] = async (toolArgs: Record<string, unknown>, extra: unknown) => {
      const start = performance.now();
      try {
        const result = await handler(toolArgs, extra);
        const durationMs = Math.round(performance.now() - start);
        const props: Record<string, unknown> = {
          tool: toolName,
          duration_ms: durationMs,
          success: !result?.isError,
        };
        if (toolArgs?.entity) props.entity = toolArgs.entity;
        if (userId) props.user_id = userId;

        if (result?.isError) {
          const errorText = (result.content?.[0] as { text?: string } | undefined)?.text;
          if (errorText) props.error = errorText;
          toolLogger.warn('tool_error', props);
        } else {
          toolLogger.info('tool_call', props);
        }
        return result;
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        toolLogger.error('tool_exception', {
          tool: toolName,
          user_id: userId,
          duration_ms: durationMs,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };

    return (origRegisterTool as Function)(...args);
  }) as typeof server.registerTool;
}

/**
 * Create and configure an MCP server instance with all tools and resources.
 *
 * In stdio mode: uses the provided token for a single-user session.
 * In HTTP mode: called per-request with the token extracted from Authorization header.
 *
 * SchemaCache is shared (process-lifetime); PostgRESTClient and NameResolver are per-session.
 */
export function createServer(cache: SchemaCache, token?: string, serverInstructions?: string): McpServer {
  const logger = getLogger(['mcp']);

  // Per-session client, cache key, and resolver — each request gets its own token
  const cacheKey = token ? extractUserCacheKey(token) : undefined;
  const userId = token ? extractUserId(token) : undefined;
  const client = new PostgRESTClient({ baseUrl: cache.baseUrl, token });
  const resolver = new NameResolver(cache, client, cacheKey);

  // Fire-and-forget: sync user record from JWT claims when an authenticated user connects.
  // This ensures the user row and roles are up-to-date without blocking server creation.
  if (token) {
    client.post('rpc/refresh_current_user', {}).catch((err: unknown) => {
      logger.warn('refresh_current_user failed', { error: err instanceof Error ? err.message : String(err), user_id: userId });
    });
  }

  const server = new McpServer(
    { name: 'civic-os', version: PKG_VERSION },
    { instructions: buildInstructions(serverInstructions) },
  );

  // Wrap all tool handlers with timing/logging before registration
  instrumentToolHandlers(server, userId);

  // Register all tools — pass client + cacheKey for per-user permission caching
  registerListEntities(server, client, cache, cacheKey);
  registerDescribeEntity(server, client, cache, resolver, cacheKey);
  registerListActions(server, client, cache, resolver, cacheKey);
  registerListRecords(server, client, cache, resolver, cacheKey);
  registerGetRecord(server, client, cache, resolver, cacheKey);
  registerSearch(server, client, cache, resolver, cacheKey);
  registerCreateRecord(server, client, cache, resolver, cacheKey);
  registerUpdateRecord(server, client, cache, resolver, cacheKey);
  registerExecuteAction(server, client, cache, resolver, cacheKey);
  registerAddNote(server, client, cache, resolver, cacheKey);
  registerListNotes(server, client, cache, resolver, cacheKey);
  registerGetStatusWorkflow(server, client, cache, resolver, cacheKey);

  // Register MCP Resources
  registerResources(server, client, cache, cacheKey, serverInstructions);

  return server;
}

// ============================================================================
// Server Setup
// ============================================================================

async function main(): Promise<void> {
  const config = parseArgs();
  await configureLogging(config.logLevel);
  const logger = getLogger(['mcp']);

  // Initialize shared schema cache with an anonymous client (schema views are public)
  const anonymousClient = new PostgRESTClient({ baseUrl: config.postgrestUrl });
  const cache = new SchemaCache(anonymousClient, config.postgrestUrl);

  // Pre-load schema cache (best-effort; will load on first tool call if this fails)
  try {
    await cache.initialize();
    logger.info('schema_cache_loaded', { entities: cache.entities.length, properties: cache.properties.length });
  } catch (err) {
    logger.warn('schema_cache_failed', { error: err instanceof Error ? err.message : String(err) });
  }

  if (config.transport === 'http') {
    // HTTP Streamable transport — per-request auth via Bearer token
    const { startHttpServer } = await import('./http.js');
    await startHttpServer(cache, config);
  } else {
    // stdio transport — single-user session with optional static token
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    serveStdio(() => createServer(cache, config.token, config.serverInstructions));
  }
}

// ============================================================================
// MCP Resources
// ============================================================================

function registerResources(
  server: McpServer,
  client: PostgRESTClient,
  cache: SchemaCache,
  cacheKey?: string,
  serverInstructions?: string,
): void {
  // Schema overview resource
  server.registerResource(
    'schema-overview',
    'civicos://schema/overview',
    {
      title: 'Schema Overview',
      description: 'Entity list with descriptions, relationships, and record counts',
      mimeType: 'text/markdown',
    },
    async () => {
      await cache.ensureFreshForUser(client, cacheKey);

      const lines: string[] = [];
      lines.push('# Civic OS Schema Overview');
      lines.push('');
      if (serverInstructions) {
        lines.push(serverInstructions);
        lines.push('');
      }

      for (const entity of cache.getEntitiesForUser(cacheKey)) {
        if (!entity.select) continue;
        let line = `## ${entity.display_name} (\`${entity.table_name}\`)`;
        if (entity.description) line += `\n${entity.description}`;
        lines.push(line);

        const properties = cache.getPropertiesForUser(cacheKey, entity.table_name);
        if (properties.length > 0) {
          const propNames = properties.slice(0, 8).map(p => p.display_name).join(', ');
          lines.push(`Properties: ${propNames}${properties.length > 8 ? '...' : ''}`);
        }

        lines.push('');
      }

      return {
        contents: [{
          uri: 'civicos://schema/overview',
          mimeType: 'text/markdown',
          text: lines.join('\n'),
        }],
      };
    },
  );

  // Per-entity detail resource
  server.registerResource(
    'entity-detail',
    new ResourceTemplate('civicos://entity/{name}', {
      list: async () => ({
        resources: cache.getEntitiesForUser(cacheKey)
          .filter(e => e.select)
          .map(e => ({
            uri: `civicos://entity/${e.table_name}`,
            name: e.display_name,
            description: e.description ?? undefined,
            mimeType: 'text/markdown',
          })),
      }),
    }),
    {
      title: 'Entity Detail',
      description: 'Full entity documentation: properties, types, actions, relationships',
      mimeType: 'text/markdown',
    },
    async (_uri, { name }) => {
      await cache.ensureFreshForUser(client, cacheKey);

      const entity = cache.getEntityForUser(cacheKey, name as string);
      if (!entity) {
        return {
          contents: [{
            uri: `civicos://entity/${name}`,
            mimeType: 'text/plain',
            text: `Entity "${name}" not found.`,
          }],
        };
      }

      const properties = cache.getPropertiesForUser(cacheKey, entity.table_name);
      const actions = cache.getActionsForUser(cacheKey, entity.table_name);
      const { getTypeLabel } = await import('./formatters/value.js');

      const lines: string[] = [];
      lines.push(`# ${entity.display_name}`);
      if (entity.description) lines.push(entity.description);
      lines.push('');

      lines.push('## Properties');
      for (const prop of properties) {
        lines.push(`- **${prop.display_name}** (\`${prop.column_name}\`): ${getTypeLabel(prop)}`);
      }
      lines.push('');

      if (actions.length > 0) {
        lines.push('## Actions');
        for (const action of actions) {
          lines.push(`- **${action.display_name}**: ${action.description ?? action.rpc_function}`);
        }
      }

      return {
        contents: [{
          uri: `civicos://entity/${name}`,
          mimeType: 'text/markdown',
          text: lines.join('\n'),
        }],
      };
    },
  );
}

// ============================================================================
// Run — only when this module is the entry point, not when imported as a library
// ============================================================================

const isEntryPoint = process.argv[1]
  && (import.meta.url.endsWith(process.argv[1]) || import.meta.url === `file://${process.argv[1]}`);
if (isEntryPoint) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
