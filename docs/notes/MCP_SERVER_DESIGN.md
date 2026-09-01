# MCP Server Design -- Architecture Notes

Copyright (C) 2023-2026 Civic OS, L3C

**Created:** 2026-08-31
**Status:** v0.72.3 -- stdio + HTTP Streamable transport, per-request auth, OAuth discovery (pre-created client + DCR), 12 tools

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
      get-record.ts         # Single record detail with available actions
      create-record.ts      # Create with FK name resolution
      update-record.ts      # Update with FK name resolution
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

## Concurrency Model

> **Note (2026-09-01):** This section previously described ETag-based optimistic concurrency. PostgREST does not support native HTTP ETags ([issue #1176](https://github.com/PostgREST/postgrest/issues/1176), open since 2018). The MCP server's ETag code was removed in v0.72.3 as it was always `undefined`. See `docs/notes/ETAG_CONCURRENCY_DESIGN.md` for the invalidated design and alternative approaches.

The MCP server currently uses a **last-write-wins** model for `update_record`. The `get_record` -> `update_record` flow relies on the LLM reading current state before writing, but does not enforce concurrency control. Entity Actions (`execute_action`) are atomic server-side RPCs and do not have this concern.

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

## Action Condition Evaluation

Entity actions have two optional condition checks: `visibility_condition` (should the action appear?) and `enabled_condition` (can it be executed right now?). Both are recursive `ActionCondition` trees supporting `and`/`or` compounds and simple `{field, operator, value}` leaves.

### Dot-Notation and FK Embedding

Conditions frequently reference embedded FK fields via dot-notation (e.g., `status_id.status_key`). This requires the record to be fetched with full FK embedding — a bare `GET /clients?id=eq.42` returns `{status_id: 5}`, but the condition needs `{status_id: {id: 5, status_key: "pending"}}`.

`execute_action` handles this by calling `buildSelectString(allProperties)` before the condition-check fetch, producing select strings like `status_id:statuses!status_id(id,display_name,color,status_key)`. The same `buildSelectString` function is used by `list_records` and `get_record` for consistent FK embedding.

**Bug discovered (v0.72.3):** The original implementation fetched records without a `select` string for condition evaluation. PostgREST returned raw FK IDs, causing all dot-notation conditions to silently resolve to `undefined`. Every visibility condition appeared to fail, making actions like "Activate Client" unavailable.

### Diagnostic Error Messages

When a condition fails, `describeConditionFailure()` introspects both the condition and the current record to produce a message explaining what went wrong:

- **Simple condition:** `status_id.status_key is "completed", expected "pending"`
- **AND compound:** Lists only the failing sub-conditions: `is_active is false, expected true; balance is 0, must be > 100`
- **OR compound:** `None of these conditions are met: ...`

All condition failure messages also suggest `Use get_record to see the current state and available actions`, guiding the LLM to discover which actions ARE available for the record's current state.

For `enabled_condition` failures, the `disabled_tooltip` from metadata is used when available (integrator-authored, context-specific). The diagnostic fallback only appears when no tooltip is configured.

### Condition Evaluation in get_record

`get_record` also evaluates conditions, but for display rather than gating:

- Actions where `visibility_condition` fails are **excluded** from the "Available Actions" list entirely
- Actions where `enabled_condition` fails are **shown but marked disabled** with the `disabled_tooltip`

This means the LLM sees only contextually-appropriate actions and can read why disabled actions can't be used.

## Name Resolution Paths

The `NameResolver` handles three distinct resolution mechanisms, each appropriate for different column types:

### Status Resolution (synchronous, entity_type-scoped)

Statuses live in a shared `metadata.statuses` table with an `entity_type` discriminator. "Active" for clients is a different status row than "Active" for projects. `resolveStatus(entity_type, name)` queries the cached statuses filtered by entity_type.

### Category Resolution (synchronous, entity_type-scoped)

Same pattern as statuses — shared `metadata.categories` table with `entity_type` discriminator. `resolveCategory(entity_type, name)` is the synchronous lookup.

### FK Resolution (async, table-scoped)

Generic foreign keys query the target table via PostgREST: `GET /{join_table}?display_name=eq.{name}&select=id`. This is async (HTTP round-trip) and has no entity_type scoping — FK target tables are standalone.

### Why This Matters

**Bug discovered (v0.72.3):** `list_records` originally used `resolveForeignKeyValue()` for all filterable columns, including Status and Category types. Since statuses use a shared table, filtering "Clients where Status = Active" could match a *different entity's* "Active" status. The fix: check `prop.type` first and use `resolveStatus()`/`resolveCategory()` before falling back to `resolveForeignKeyValue()`.

The resolution order in `list_records` filters:
1. **Status columns** → `resolveStatus(prop.status_entity_type, value)` (sync, scoped)
2. **Category columns** → `resolveCategory(prop.category_entity_type, value)` (sync, scoped)
3. **FK columns** → `resolveForeignKeyValue(prop.join_table, value)` (async, table-wide)

## List View: Always-Include-ID

`list_records` includes the `id` column in the PostgREST select string when the entity has one. The `id` column may be noisy for human users, but for LLM consumers it's essential context — without it, the LLM can't reference records in follow-up calls like `get_record`, `update_record`, or `execute_action`.

If `id` is already in the display properties (via `is_identity` or `column_name === 'id'`), it's not duplicated. Otherwise, `id,` is prepended to the select string. Junction tables with composite primary keys (no `id` column) skip this injection entirely, and the markdown table omits the ID column header.

## Timestamp Formatting

`renderRecordDetail()` (used by `get_record`) appends `created_at` and `updated_at` as fallback lines when they're not already included in the detail properties. These timestamps are formatted via `formatDateTimeLocal()` using `toLocaleString('en-US')` to produce human-readable output like "Jan 15, 2024, 05:30 AM" rather than raw ISO strings like "2024-01-15T10:30:00Z".

Timestamps that ARE included in detail properties (via `show_on_detail = true`) go through the standard `formatValue()` pipeline which applies `DateTime` or `DateTimeLocal` formatting based on the property type.

## Error Handling

PostgREST errors are translated to user-friendly messages via `PostgRESTRequestError.toHumanMessage()`:

| Code | Meaning | MCP Error Message |
|---|---|---|
| 403 / 42501 | Forbidden | Permission denied |
| 404 | Not Found | Entity or record not found |
| 401 | Unauthorized | Session expired |
| 416 | Range Not Satisfiable | Pagination offset beyond bounds (friendly, not `isError`) |
| 23505 | Unique violation | Duplicate record |
| 23502 | Not-null violation | "Required field 'Display Name' is missing" (column → display name at tool level) |
| 23514 | Check constraint | Custom from `metadata.constraint_messages`, else humanized constraint name |
| 23P01 | Exclusion violation | Conflicts with existing record |
| 22P02 | Invalid input syntax | "Invalid value — expected a whole number / a date (YYYY-MM-DD) / ..." |
| 22007/22008 | Invalid date | "Invalid date format. Use YYYY-MM-DD..." |
| P0001 | Custom PL/pgSQL raise | Message passed through as-is (user-facing by convention) |

**Tool-level error enrichment**: `create_record` and `update_record` intercept `23502` before `toHumanMessage()` to resolve column names to display names using the schema cache. The generic handler falls back to the raw column name.

**Name resolution errors**: `NameResolutionError` is surfaced (not swallowed) for FK, Status, and Category resolution failures in both filters and action params. Error messages always list available values.

**Filter operator guards**: `like`/`ilike` on FK, Status, and Category columns returns an early error explaining the column stores IDs, not text.

**Empty display_name guard**: `create_record` and `update_record` convert empty/whitespace `display_name` values to `null`, letting the DB's NOT NULL constraint produce a friendly error.

Additionally, `execute_action` returns pre-flight errors with diagnostic detail when visibility or enabled conditions fail (see Action Condition Evaluation above).

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

### OAuth Authentication

MCP clients authenticate users via OAuth 2.1 Authorization Code + PKCE flow against Keycloak. Two client provisioning approaches are supported:

1. **Pre-created client** (recommended): A `civic-os-mcp` public client is included in the Keycloak realm template. MCP clients reference it via `oauthClientId: "civic-os-mcp"` in their config, bypassing dynamic registration entirely.

2. **Dynamic Client Registration (DCR)**: A trusted-hosts policy (also in the realm template) allows MCP clients connecting from localhost to self-register at runtime. More flexible for development but requires Keycloak DCR configuration for production hosts.

See `docs/AUTHENTICATION.md` (Step 9) for setup instructions for both approaches.

### OAuth Discovery (RFC 9728)

When `KEYCLOAK_URL` and `KEYCLOAK_REALM` env vars are set, the HTTP server exposes RFC 9728 protected resource metadata at `/.well-known/oauth-protected-resource`. This enables OAuth-capable MCP clients (Claude Code, Claude Desktop, claude.ai) to auto-discover Keycloak and perform the Authorization Code + PKCE flow.

The `buildProtectedResourceMetadata()` function in `http.ts` generates the discovery document -- a simple JSON response with `resource`, `authorization_servers`, and `bearer_methods_supported` fields. No token verification or Keycloak service account is needed.

**Why only `oauth-protected-resource`**: We serve the protected resource metadata (RFC 9728) but NOT `oauth-authorization-server` (RFC 8414). Clients discover the AS metadata directly from Keycloak via the `authorization_servers` array. This avoids path-prefix conflicts when the MCP server sits behind a reverse proxy (e.g., Caddy `handle_path` strips `/_/mcp` but clients fetch `/.well-known` from the origin).

### HTTP Routing

```
GET  /health                              → 200 { status: ok, version }
OPTIONS *                                 → 204 with CORS headers
GET  /.well-known/oauth-protected-resource → RFC 9728 metadata (if Keycloak configured)
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

## Entity Notes Integration

`get_record` uses a teaser pattern for notes: when `entity.enable_notes` is true, it fetches the most recent note with `count=exact` and renders a `## Notes` section showing the count and a preview:

```
## Notes
3 notes — most recent:
> **Jane Smith** — Sep 1, 2026, 10:30 AM
> Discussed renewal terms with the client...

Use `list_notes` to see all notes.
```

The dedicated `list_notes` tool provides the full history with pagination, author names, timestamps, and system note tags. It verifies record existence before querying notes to distinguish "no notes" from "record not found".

Both tools normalize literal `\n` sequences in note content (common LLM serialization artifact) to actual newlines.

## Filter Edge Cases

### Same-Column Multi-Condition Filters

PostgREST query params are key-value — setting the same column twice overwrites. For date/numeric ranges (e.g., `created_at >= X AND created_at < Y`), conditions are collected as an array, grouped by column, and same-column groups use PostgREST's `and=()` syntax:

```
Single condition:  ?status_id=eq.1
Multi-condition:   ?and=(created_at.gte.2026-08-15,created_at.lt.2026-09-01)
```

### Pattern Matching on Reference Columns

`like`/`ilike` on FK, Status, or Category columns is rejected early with a helpful error. These columns store integer IDs — pattern matching would match against the raw ID, not the display name. The error suggests using `eq` with an exact name or the `search` parameter instead.

### Entity Name Resolution Filtering

Error messages from `resolveEntity()` only suggest entities the user can read (`e.select === true`), hiding internal junction tables and system views from the suggestion list.

## Testing Strategy

Three layers, from fast to comprehensive:

### Unit Tests (424 tests, vitest)

Every tool, formatter, and core module tested with mocked PostgREST responses, plus HTTP transport tests (Bearer extraction, health endpoint, CORS, `buildProtectedResourceMetadata`, createMcpHandler integration). Run via `npm test` (vitest). Located in `src/__tests__/` mirroring the source structure.

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
