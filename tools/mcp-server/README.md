# Civic OS MCP Server

Semantic API adapter over PostgREST for LLM integration.

License: AGPL-3.0-or-later. Copyright (C) 2023-2026 Civic OS, L3C.

## What It Does

The MCP Server is a second thin client over PostgREST (the Angular frontend being the first). It translates human-friendly MCP tool calls into PostgREST HTTP requests, letting LLMs like Claude interact with any Civic OS instance through structured tools instead of raw SQL.

- Translates MCP tool calls into PostgREST HTTP requests
- Resolves display names to identifiers (entities, columns, FK values, statuses)
- Uses the same JWT auth + RLS as the web frontend -- users only see what their role permits

## Quick Start

### Local (stdio)

```bash
npx @civic-os/mcp-server --url http://localhost:3000 --token <jwt>
```

Or with environment variables:

```bash
POSTGREST_URL=http://localhost:3000 CIVICOS_TOKEN=<jwt> npx @civic-os/mcp-server
```

### Docker (hosted)

Add the container to docker-compose alongside PostgREST:

```yaml
mcp-server:
  image: ghcr.io/civic-os/mcp-server
  environment:
    POSTGREST_URL: http://postgrest:3000
  ports:
    - "3001:3001"  # HTTP Streamable transport (Phase 3)
```

## Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "civic-os": {
      "command": "npx",
      "args": ["@civic-os/mcp-server", "--url", "http://localhost:3000", "--token", "<your-jwt>"]
    }
  }
}
```

## Available Tools (11)

| Tool | Type | Description |
|------|------|-------------|
| `list_entities` | Read | Browse entities the user has access to |
| `describe_entity` | Read | Inspect entity structure, properties, types, actions |
| `list_actions` | Read | See available entity actions the user can execute |
| `list_records` | Read | Query/filter/search records with FK embedding |
| `get_record` | Read | Full record detail with ETag for concurrency |
| `search` | Read | Full-text search across entities |
| `create_record` | Write | Create new record with FK name resolution |
| `update_record` | Write | Update record with ETag-based optimistic concurrency |
| `execute_action` | Write | Run entity actions (RPCs with business logic) |
| `add_note` | Write | Add a note to any entity with notes enabled |
| `get_status_workflow` | Read | View status values and transitions |

## MCP Resources (2)

- `civicos://schema/overview` -- Entity list with descriptions and properties
- `civicos://entity/{name}` -- Full entity documentation per table

## Key Features

### Name Resolution

Users and LLMs speak in display names. The server resolves:

- Entities: "Time Entry" -> `time_entries`
- Columns: "Client" -> `client_id`
- FK values: "Website Redesign" -> looks up project ID
- Statuses: "Active" -> status ID
- Actions: "Approve" -> action config

### ETag Concurrency

- `get_record` captures PostgREST's ETag header
- `update_record` requires the ETag (If-Match header)
- Stale ETags get 412 Precondition Failed -- prevents LLM overwrites

### Schema Cache

- Loaded on startup from `schema_entities`, `schema_properties`, `schema_entity_actions`
- Checked for freshness via `schema_cache_versions` before each tool call
- Only stale sections are re-fetched

## Configuration

| Option | CLI Flag | Env Var | Default |
|--------|----------|---------|---------|
| PostgREST URL | `--url`, `-u` | `POSTGREST_URL` | `http://localhost:3000` |
| JWT Token | `--token`, `-t` | `CIVICOS_TOKEN` | (none) |
| Instance Context | `--instructions` | `MCP_SERVER_INSTRUCTIONS` | (none) |

## Development

```bash
cd tools/mcp-server
npm install
npm run build        # Compile TypeScript
npm test             # Run 384 unit tests (vitest)
npm start            # Start stdio server
```

### Integration Tests

Full-stack tests against real PostgreSQL + PostgREST + Keycloak:

```bash
cd tests/integration
./run-tests.sh --ci   # Starts stack, runs tests, tears down
```

## Architecture

```
MCP Client (Claude, Cursor, etc.)
    | MCP Protocol (stdio or HTTP)
MCP Server (this package)
    | HTTP (JWT in Authorization header)
PostgREST
    | SQL (RLS enforced)
PostgreSQL
```

Core modules:

- `postgrest-client.ts` -- Typed HTTP client for PostgREST
- `schema-cache.ts` -- Caches entity/property/action metadata
- `name-resolver.ts` -- Display name -> identifier resolution
- `select-builder.ts` -- Builds PostgREST `?select=` with FK embedding
- `formatters/` -- Markdown table and value formatting

## Docker

Production image uses Bun runtime (97 MB, ~30 MB RAM at idle):

```yaml
mcp-server:
  image: ghcr.io/civic-os/mcp-server:latest
  environment:
    POSTGREST_URL: http://postgrest:3000
  deploy:
    resources:
      limits:
        memory: 64M
        cpus: '0.25'
```

## License

AGPL-3.0-or-later. Copyright (C) 2023-2026 Civic OS, L3C.
