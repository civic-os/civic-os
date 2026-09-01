# MCP Server Design -- Architecture Notes

Copyright (C) 2023-2026 Civic OS, L3C

**Created:** 2026-08-31
**Status:** v0.72.1 -- stdio + HTTP Streamable transport, per-request auth, OAuth discovery, 11 tools

## Purpose

The MCP server is a semantic API adapter that translates MCP tool calls into PostgREST HTTP requests. It is the second thin client over PostgREST (the Angular frontend being the first). A normal, non-developer user should be able to connect their LLM client to a Civic OS instance and interact with their data using natural language.

## Key Decision: PostgREST as Backend (Not Direct PostgreSQL)

The MCP server proxies through PostgREST rather than connecting directly to PostgreSQL. This reuses the entire infrastructure layer the Angular frontend already depends on:

- **JWT auth + RLS** -- users only see rows their role permits, no reimplementation needed
- **CRUD via HTTP** -- POST/PATCH/DELETE with constraint error propagation
- **RPC calls** -- entity actions, status changes
- **FK embedding** -- `?select=id,project(display_name)` resolves FKs in one query
- **Pagination** -- Range headers + Content-Range
- **FTS** -- `civic_os_text_search=wfts.query`
- **Schema views** -- `schema_entities`, `schema_properties`, `schema_entity_actions` expose metadata with per-user permission filtering

What we would have to reimplement without it: JWT verification, role assignment, RLS enforcement, query building, type serialization, constraint error codes.

**Trade-off**: No raw SQL. This is appropriate -- the MCP server is user-facing, not admin tooling.

## Key Decision: Token Passthrough (Not Verification)

The MCP server does NOT verify JWTs. It forwards the token to PostgREST as `Authorization: Bearer <jwt>`. PostgREST and the `metadata.check_jwt()` pre-request handle verification against Keycloak's JWKS.

Three auth modes:

1. **OAuth2/OIDC (hosted, Phase 3)**: User authenticates via browser, MCP server gets JWT from Keycloak
2. **Token passthrough (current)**: User provides JWT via `--token` flag or `CIVICOS_TOKEN` env var
3. **Local dev (stdio)**: Same as token passthrough with `--url http://localhost:3000`

## Architecture

```
tools/mcp-server/
  src/
    index.ts                # Entry point: config parsing, server factory, stdio transport,
                            # MCP resource registration (schema-overview, entity-detail)
    interfaces.ts           # TypeScript types (subset of Angular's entity.ts)
    postgrest-client.ts     # Typed HTTP client for PostgREST
    schema-cache.ts         # Caches schema_entities/properties/actions, version-based refresh
    name-resolver.ts        # Display name -> identifier resolution
    select-builder.ts       # Builds PostgREST ?select= strings with FK embedding
    formatters/
      value.ts              # Value formatting (money, dates, booleans, FK display)
      markdown-table.ts     # Markdown table rendering for tool output
    tools/                  # 11 MCP tool implementations
      list-entities.ts      # Browse entities with permissions
      describe-entity.ts    # Entity structure, properties, actions
      list-actions.ts       # Available entity actions
      list-records.ts       # Query with filters, FK embedding, pagination
      get-record.ts         # Single record with ETag capture
      create-record.ts      # Create with FK name resolution
      update-record.ts      # Update with ETag-based concurrency
      execute-action.ts     # RPC execution with condition evaluation
      add-note.ts           # Polymorphic entity notes
      search.ts             # Cross-entity full-text search
      get-status-workflow.ts # Status values and transitions
```

### Server Factory

`createServer(cache, token?)` is a factory function that takes a shared `SchemaCache` and an optional JWT token. It creates a per-session `PostgRESTClient` and `NameResolver`, then registers all 11 tools, 2 MCP resources, and server instructions onto an `McpServer` instance.

In stdio mode, the factory is called once with the static `--token`. In HTTP mode, `createMcpHandler` calls the factory per-request with the token extracted from `McpRequestContext.authInfo`.

### MCP Resources

Two resources are registered via the `@modelcontextprotocol/server` ResourceTemplate API:

- **`civicos://schema/overview`** -- Markdown listing of all readable entities with descriptions and top properties. Static URI.
- **`civicos://entity/{name}`** -- Per-entity detail with full property list and available actions. Templated URI with `list` callback for resource discovery.

Both call `cache.ensureFresh()` before rendering.

## Schema Cache Strategy

The schema cache mirrors the Angular frontend's `SchemaService` pattern.

**Startup**: Full load of `schema_entities`, `schema_properties`, `schema_entity_actions`, statuses, categories, transitions, and constraint messages. Builds derived lookups (entity-by-table, properties-by-table, etc.).

**Per tool call**: `ensureFresh()` queries `schema_cache_versions` (3 rows with `MAX(updated_at)` timestamps). If any version is newer than cached, re-fetches only the stale section.

**Why not TTL**: Could serve stale data for up to N minutes. Version-check costs one extra lightweight query but guarantees freshness.

**Why not no-cache**: Querying schema views on every tool call adds 3-5 queries overhead. Version check collapses this to 1 query in the common case.

## Name Resolution

The `NameResolver` translates human-readable names to identifiers at every level:

- **Entities**: "Time Entry" / "time_entries" / "Time Entries" -> `time_entries` (exact, case-insensitive, fuzzy)
- **Columns**: "Client" / "client_id" -> `client_id`
- **FK values**: "Website Redesign" -> queries the FK target table for matching `display_name`, returns ID
- **Statuses**: "Active" -> queries `metadata.statuses` for matching display_name, returns ID
- **Categories**: "Email" -> same pattern as statuses
- **Actions**: "Approve" -> looks up `schema_entity_actions` by display_name or action_name

Ambiguous matches return an error listing candidates. Unknown names return a clear error message.

## ETag-Based Optimistic Concurrency

PostgREST natively supports HTTP ETag-based concurrency control.

Flow:

1. `get_record` -> PostgREST returns `ETag` header (MD5 hash of response body) -> included in tool output
2. `update_record` -> MCP server sends `If-Match: "{etag}"` header with the PATCH
3. PostgREST re-reads the row, recomputes hash:
   - Match -> applies PATCH, returns new ETag
   - Mismatch -> returns 412 Precondition Failed

Why this matters for LLMs: an LLM's context can be minutes or hours stale. Without ETags, `update_record` is last-write-wins and could silently overwrite changes made via the web UI.

Entity Actions do not need ETags -- RPCs are atomic server-side transactions.

## Column Visibility Defaults

The MCP server uses `show_on_list`, `show_on_detail`, `show_on_create`, `show_on_edit` flags from `schema_properties` as defaults:

- `list_records` -> columns where `show_on_list = true`
- `get_record` -> columns where `show_on_detail = true`

The LLM can request any column via the `columns` parameter -- the defaults keep output concise.

## FK Embedding Depth

PostgREST generates JOINs from `?select=`. The MCP server limits depth:

- **Depth 1** (default): Direct FK -> display_name. Example: `client_id(display_name)`
- **Depth 2** (explicit columns param): One level of nested FK. Example: `projects(id,status_id(display_name))`
- **Depth 3+** (blocked): Returns error suggesting separate `list_records` calls

## Tool Design: Entity Actions Over Direct Edits

Entity Actions often embed business logic that raw PATCH updates bypass (status transition validation, notification triggers, audit logging). The MCP tool descriptions guide the LLM to prefer `execute_action` over `update_record` when an applicable action exists.

`describe_entity` and `get_record` prominently list available actions so the LLM sees them before deciding to modify a record.

## Error Handling

PostgREST errors are translated to user-friendly messages:

| HTTP Status | Meaning | MCP Error Message |
|---|---|---|
| 412 | Precondition Failed | "This record has been modified since you last read it. Call get_record again." |
| 403 | Forbidden | Permission denied with role context |
| 404 | Not Found | Entity or record not found |
| 409 / 23505 | Conflict / Unique violation | Duplicate record |
| 23514 | Check constraint violation | Custom message from `metadata.constraint_messages` if available |

## Transport

Two transport modes, selectable via `--transport` flag or `MCP_TRANSPORT` env var:

- **stdio** (default for CLI): For local development and MCP clients like Claude Desktop. Uses `@modelcontextprotocol/server/stdio` with the `serveStdio()` factory pattern. Single-user session with a static token via `--token` or `CIVICOS_TOKEN`.
- **http** (default in Docker): HTTP Streamable transport for hosted deployment behind a reverse proxy. Uses `createMcpHandler()` from the MCP SDK v2.0.0 with `legacy: 'stateless'` for backward compatibility with 2025-era MCP clients.

### Per-Request Auth Architecture (HTTP mode)

In HTTP mode, each request carries a different user's JWT via `Authorization: Bearer`. The architecture splits into shared and per-session layers:

```
Shared (process lifetime):
  SchemaCache ← anonymous PostgRESTClient (schema views are public)

Per-session (per HTTP request):
  Authorization: Bearer <jwt> → extractBearerToken()
  → createServer(cache, token)
    → PostgRESTClient(baseUrl, token)  // per-session, user's JWT
    → NameResolver(cache, client)       // per-session
    → McpServer with all tools          // per-session
```

The MCP server never verifies JWTs. It extracts the Bearer token and passes it through to PostgREST as `AuthInfo.token` via the `createMcpHandler` factory context. PostgREST handles verification against Keycloak's JWKS.

### OAuth Discovery (optional)

When `KEYCLOAK_URL` and `KEYCLOAK_REALM` env vars are set, the HTTP server exposes RFC 9728 protected resource metadata at `/.well-known/oauth-protected-resource`. This enables OAuth-capable MCP clients (like Claude Desktop) to auto-discover Keycloak and perform Authorization Code + PKCE flow.

The `oauthMetadataResponse()` helper from the MCP SDK builds the discovery document. No token verification or Keycloak service account is needed -- it's a static JSON response pointing clients to Keycloak endpoints.

### HTTP Routing

```
GET  /health                              → 200 { status: ok, version }
OPTIONS *                                 → 204 with CORS headers
GET  /.well-known/oauth-protected-resource → RFC 9728 metadata (if Keycloak configured)
GET  /.well-known/oauth-authorization-server → RFC 8414 metadata (if Keycloak configured)
POST /mcp                                 → MCP Streamable handler
GET  /mcp                                 → MCP SSE stream
```

CORS headers (`Access-Control-Allow-Origin: *`) are added to all responses except health checks.

### Caddy Integration

Route `/_/mcp/*` to the MCP server container:

```
handle_path /_/mcp/* {
    reverse_proxy mcp-server:3001
}
```

## Container

Bun-based single-stage image (`oven/bun:1-alpine`). Bun runs TypeScript natively, so no build step is needed in the container.

- Image base: `oven/bun:1-alpine`
- Non-root user: `civicos` (UID 1001)
- Default env: `POSTGREST_URL=http://postgrest:3000`, `MCP_TRANSPORT=http`, `MCP_PORT=3001`
- Exposed port: 3001
- Entrypoint: `bun run src/index.ts`
- Runtime memory: ~30 MB idle
- CPU: negligible (I/O bound, proxying HTTP)
- Health check: `wget -qO- http://localhost:3001/health`

## Testing Strategy

Three layers, from fast to comprehensive:

### Unit Tests (402 tests, vitest)

Every tool, formatter, and core module tested with mocked PostgREST responses, plus HTTP transport tests (Bearer extraction, health endpoint, CORS, OAuth metadata, createMcpHandler integration). Run via `npm test` (vitest). Located in `src/__tests__/` mirroring the source structure.

### Integration Tests (MCP protocol)

Full MCP protocol lifecycle via `@modelcontextprotocol/client` in-memory transport. Validates tool registration, argument schemas, and response format without a real PostgREST. Located in `src/__tests__/integration/`.

### Full-Stack Tests

Docker Compose with real PostgreSQL + PostgREST + Keycloak (pothole example schema). Shell scripts and Node.js test runners exercise the MCP server against a live database. Located in `tests/integration/`.

## What This Does NOT Cover

- **File uploads** -- presigned URL flow requires browser interaction; deferred
- **Delete** -- intentionally omitted; destructive operation better done in UI
- **Raw SQL** -- this is user-facing, not dev tooling
- **Admin operations** -- entity/property management uses the web UI

## Future Work

- npm publish for local dev use (`npx @civic-os/mcp-server`)
- MCP Sampling support (LLM-initiated prompts for complex workflows)
