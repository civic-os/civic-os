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
 *   - stdio (default): for local development and MCP clients like Claude Desktop
 *   - HTTP Streamable: for hosted deployment (Phase 3)
 */

import { createRequire } from 'node:module';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { PostgRESTClient } from './postgrest-client.js';
import { SchemaCache } from './schema-cache.js';
import { NameResolver } from './name-resolver.js';

// Read version from package.json so it stays in sync with the root Civic OS version.
const require = createRequire(import.meta.url);
const PKG_VERSION: string = (require('../package.json') as { version: string }).version;

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
import { registerGetStatusWorkflow } from './tools/get-status-workflow.js';

// ============================================================================
// Configuration
// ============================================================================

interface ServerConfig {
  postgrestUrl: string;
  token?: string;
}

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  let postgrestUrl = process.env['POSTGREST_URL'] ?? 'http://localhost:3000';
  let token = process.env['CIVICOS_TOKEN'];

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
      case '--help':
      case '-h':
        console.error(`
Civic OS MCP Server

Usage:
  civicos-mcp [options]

Options:
  --url, -u <url>      PostgREST base URL (default: $POSTGREST_URL or http://localhost:3000)
  --token, -t <jwt>    JWT token for authentication (default: $CIVICOS_TOKEN)
  --help, -h           Show this help message

Environment Variables:
  POSTGREST_URL        PostgREST base URL
  CIVICOS_TOKEN        JWT token for authentication

Examples:
  civicos-mcp --url http://localhost:3000 --token eyJ...
  POSTGREST_URL=http://localhost:3000 CIVICOS_TOKEN=eyJ... civicos-mcp
`);
        process.exit(0);
    }
  }

  return { postgrestUrl, token };
}

// ============================================================================
// Server Factory
// ============================================================================

/**
 * Create and configure an MCP server instance with all tools and resources.
 * Used as factory for both stdio and HTTP transports.
 */
export function createServer(
  client: PostgRESTClient,
  cache: SchemaCache,
  resolver: NameResolver,
): McpServer {
  const server = new McpServer({
    name: 'civic-os',
    version: PKG_VERSION,
  });

  // Register all tools
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

  // Register MCP Resources
  registerResources(server, cache);

  return server;
}

// ============================================================================
// Server Setup
// ============================================================================

async function main(): Promise<void> {
  const config = parseArgs();

  // Initialize core services
  const client = new PostgRESTClient({
    baseUrl: config.postgrestUrl,
    token: config.token,
  });

  const cache = new SchemaCache(client);
  const resolver = new NameResolver(cache, client);

  // Initialize schema cache (best-effort; will load on first tool call if this fails)
  try {
    await cache.initialize();
    console.error(`Schema cache loaded: ${cache.entities.length} entities, ${cache.properties.length} properties`);
  } catch (err) {
    console.error('Warning: Failed to pre-load schema cache. It will be loaded on first tool call.');
    console.error(err instanceof Error ? err.message : err);
  }

  // Start stdio transport with factory (serveStdio creates per-connection instances)
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  serveStdio(() => createServer(client, cache, resolver));
}

// ============================================================================
// MCP Resources
// ============================================================================

function registerResources(server: McpServer, cache: SchemaCache): void {
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
      await cache.ensureFresh();

      const lines: string[] = [];
      lines.push('# Civic OS Schema Overview');
      lines.push('');

      for (const entity of cache.entities) {
        if (!entity.select) continue;
        let line = `## ${entity.display_name} (\`${entity.table_name}\`)`;
        if (entity.description) line += `\n${entity.description}`;
        lines.push(line);

        const properties = cache.getProperties(entity.table_name);
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
        resources: cache.entities
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
      await cache.ensureFresh();

      const entity = cache.getEntity(name as string);
      if (!entity) {
        return {
          contents: [{
            uri: `civicos://entity/${name}`,
            mimeType: 'text/plain',
            text: `Entity "${name}" not found.`,
          }],
        };
      }

      const properties = cache.getProperties(entity.table_name);
      const actions = cache.getActions(entity.table_name);
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
// Run
// ============================================================================

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
