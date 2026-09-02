# PostgREST Upgrade Runbook

How to upgrade PostgREST across major versions in Civic OS. Last used: v13.0.7 → v16.2 (September 2026).

## Pre-Upgrade Research

Before touching any files, review the PostgREST changelog for every version between current and target:

1. **Deprecated config keys** — Check if any `PGRST_*` env vars we use have been renamed or removed. Search our compose files for every `PGRST_` variable and cross-reference the changelog.
2. **Breaking changes to query syntax** — The `!`-hint FK disambiguator, `:alias` embedding, `Prefer` headers, `Content-Range` pagination format, and array POST body handling are the patterns Civic OS relies on most heavily.
3. **Security advisories** — PostgREST publishes CVEs for information leakage (error hints), JWT timing bugs, and connection leaks. These are the primary motivation for staying current.
4. **Runtime dependencies** — PostgREST is a statically-linked Haskell binary but links against `libpq` and `libgmp`. Verify the target version's dependencies match our `docker/postgrest/Dockerfile` (currently Ubuntu 24.04 with `libpq5` and `libgmp10`).

## Files to Change

Only one file controls the PostgREST version:

```
docker/postgrest/Dockerfile    ← COPY --from=postgrest/postgrest:vX.Y.Z
```

All compose files (`docker-compose.prod.yml`, `infrastructure/vps/docker-compose.vps.yml`, example composes, CI composes) build from this Dockerfile. No version is pinned elsewhere.

### Healthcheck pattern

PostgREST exposes an admin server (configured via `PGRST_ADMIN_SERVER_PORT`) with lightweight `/ready` and `/live` endpoints that don't consume database connections. All compose files should use this for healthchecks:

```yaml
environment:
  PGRST_ADMIN_SERVER_PORT: 3001
healthcheck:
  test: ["CMD-SHELL", "curl -sf http://localhost:3001/ready || exit 1"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 10s
```

Do **not** healthcheck against the main API port (`:3000/`) — that fetches the full OpenAPI spec and consumes a database connection per check.

## Verification Layers

Run all 5 layers in order. Do not skip layers or stop early.

### Layer 1: Unit tests

```bash
npm run test:headless
```

These mock HTTP so they won't catch PostgREST behavior changes, but they confirm the build isn't broken and query-construction logic is intact.

### Layer 2: Docker smoke test

```bash
cd examples/pothole
docker compose down -v && docker compose up -d --build

# Verify version:
docker compose logs postgrest | grep -i "Starting PostgREST"

# Verify endpoints:
curl -sf http://localhost:3000/ | jq '.info.version'           # OpenAPI spec
docker exec postgrest_api curl -sf http://localhost:3001/ready  # Admin readiness
```

Note: The admin port (3001) is internal to the container. On the host, port 3001 may be mapped to the MCP server (a different service). Always test admin endpoints from inside the container.

### Layer 3: PostgREST API regression tests

```bash
./tests/functional/postgrest-api-regression-test.sh
```

This script exercises the specific PostgREST query patterns used by Civic OS:

| Test | PostgREST feature | Source code path |
|------|------------------|-----------------|
| M:M junction read | `GET /junction?select=col1,col2` | `DataService.getManyToManyData()` |
| M:M FK embedding | `!`-hint disambiguator through junctions | `SchemaService.propertyToSelectString()` |
| Bulk insert | Array POST + `Prefer: return=representation` | `DataService.bulkInsert()` |
| Bulk junction insert | Array POST + `Prefer: return=minimal` | `DataService.bulkInsertJunctions()` |
| Pagination (empty) | `Range: 0-0` → `Content-Range: */0` | `DataService.getDataPaginated()` |
| Pagination (single row) | `Range: 0-0` → `Content-Range: 0-0/N` | `DataService.getDataPaginated()` |
| Count without Range | `Prefer: count=exact` sans Range header | MCP `postgrest-client.ts` |
| FK embedding | `:alias!hint(fields)` syntax | `SchemaService.propertyToSelectString()` |
| RPC call | `POST /rpc/function_name` with JWT | `DataService.refreshCurrentUser()` |
| Error shape | Verbose error with code/message/details/hint | `DataService.parseApiError()` |

If any of these fail, the upgrade has introduced a query-level regression that will break the frontend or MCP server.

### Layer 4: Existing functional tests

```bash
cd tests/functional
./v0-71-0-ical-http-caching-test.sh
./v0-48-0-workflow-system-test.sh
./v0-39-0-file-admin-test.sh
```

These test higher-level features (iCal feeds, workflow RPCs, file storage) that exercise PostgREST indirectly.

### Layer 5: MCP integration suite

```bash
cd tools/mcp-server/tests/integration && ./run-tests.sh --ci
```

Spins up its own Docker stack (PostgreSQL, Keycloak, PostgREST, MCP server) and exercises all 12 MCP tools with real JWT auth and RLS. This is the most comprehensive end-to-end test.

## Rollback

Revert the single Dockerfile line and redeploy:

```diff
- COPY --from=postgrest/postgrest:vNEW /bin/postgrest /bin/postgrest
+ COPY --from=postgrest/postgrest:vOLD /bin/postgrest /bin/postgrest
```

No schema migrations, no data changes, no config keys to undo. Healthcheck additions in compose files are backward-compatible (the admin server `/ready` endpoint exists in older versions too).

## Upgrade History

| Date | From | To | Notes |
|------|------|----|-------|
| 2026-09 | v13.0.7 | v16.2 | No config changes needed. Added admin healthchecks to prod/VPS compose. Key gains: graceful SIGTERM (zero-downtime deploys), SIEVE JWT cache (~20% throughput), schema cache resilience (no 503s during reload). |
