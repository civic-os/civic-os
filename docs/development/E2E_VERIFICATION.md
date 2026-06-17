# E2E Verification Protocol

> **Audience**: Claude Code sessions. This document defines the mandatory verification steps
> that must be performed after ALL code changes, before committing.

## Overview

Every code change must pass through all applicable verification layers. Do not skip layers.
Do not declare work complete after unit tests alone.

## Layer 1: Unit Tests

**Always required.** Run first — fastest feedback loop.

```bash
npm run test:headless 2>&1 | tee /tmp/test-output.txt
```

If tests fail, fix them before proceeding. Check `/tmp/test-output.txt` for failure details:
```bash
grep "FAILED" /tmp/test-output.txt
grep -B 5 -A 10 "FAILED" /tmp/test-output.txt
```

## Layer 2: Docker (Migration Verification)

**When to run**: When changes touch SQL migrations, `docker-compose` files, Dockerfiles, or init scripts.

Verify migrations apply cleanly on a fresh database:
```bash
cd examples/<active-example>
docker compose down -v && docker compose up -d
```

Watch postgres logs for migration errors:
```bash
docker compose logs postgres 2>&1 | tail -50
```

Wait for all services to be healthy before proceeding to Layer 3.

## Layer 3: SQL Verification

**When to run**: When changes touch migrations, VIEWs, RLS policies, functions, or metadata.

Use the MCP postgres tool or `psql` to verify:

1. **Schema changes applied**: Check columns, constraints, indexes exist
2. **VIEWs return correct data**: Query the affected VIEWs
3. **RLS policies work**: Test with different roles (set role, query, reset)
4. **Functions execute**: Call any new/modified RPCs
5. **Metadata is correct**: Query `metadata.*` tables for expected rows

Example verification queries:
```sql
-- Check a VIEW returns expected columns
SELECT * FROM schema_entities WHERE table_name = 'your_entity' LIMIT 1;
SELECT * FROM schema_properties WHERE table_name = 'your_entity';

-- Check RLS as different roles
SET LOCAL role = 'authenticated';
SET LOCAL request.jwt.claims = '{"roles":["user"],"user_id":"..."}';
SELECT * FROM your_table;
RESET role;

-- Check a function works
SELECT your_rpc_function('param1', 'param2');
```

## Layer 4: curl / PostgREST API Verification

**When to run**: When changes affect API-exposed entities, VIEWs, or RPC functions.

Verify PostgREST serves the data correctly:

```bash
# Unauthenticated access (web_anon role)
curl -s http://localhost:3000/your_entity?limit=1 | jq .

# Authenticated access (generate a JWT or use a token)
curl -s http://localhost:3000/your_entity?limit=1 \
  -H "Authorization: Bearer $TOKEN" | jq .

# RPC call
curl -s -X POST http://localhost:3000/rpc/your_function \
  -H "Content-Type: application/json" \
  -d '{"param1": "value"}' | jq .

# Check select string works (embedded resources)
curl -s "http://localhost:3000/your_entity?select=id,name,related:other_table(display_name)&limit=1" | jq .
```

## Layer 5: Browser (Playwright MCP)

**When to run**: When changes affect UI rendering, navigation, forms, or user-facing behavior.

Use the Playwright MCP tools to verify the actual UI:

1. **Navigate** to the affected page(s)
2. **Snapshot** the page to verify elements render correctly
3. **Interact** — click buttons, fill forms, submit data
4. **Verify** — check that actions produce expected results (new records appear, errors display, navigation works)

Key pages to check based on change type:
- **New entity/property**: List page (`/view/entity`), Detail page, Create page, Edit page
- **New admin page**: Navigate to the admin route, verify data loads
- **Dashboard changes**: Home page (`/`), widget rendering
- **Schema changes**: Verify the affected entity's pages still render correctly

## Verification Checklist Summary

| Layer | Tool | Check |
|-------|------|-------|
| 1. Unit tests | `npm run test:headless` | All tests pass |
| 2. Docker | `docker compose down -v && up` | Migrations apply cleanly |
| 3. SQL | MCP postgres / `psql` | Schema, VIEWs, RLS, functions correct |
| 4. API | `curl` | PostgREST serves correct data |
| 5. Browser | Playwright MCP | UI renders and behaves correctly |

## Troubleshooting

- **PostgREST 401/403**: Run `fetch-keycloak-jwk.sh` to refresh JWT verification keys
- **Migration errors**: Check `sqitch.plan` for dependency ordering issues
- **UI not updating**: Hard refresh (`Ctrl+Shift+R`) or clear Angular cache
- **Playwright can't connect**: Ensure `npm start` is running and dev server is at `localhost:4200`
