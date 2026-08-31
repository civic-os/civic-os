# MCP Server Full-Stack Integration Tests

Tests the MCP server against a real PostgreSQL + PostgREST + Keycloak environment using the pothole example schema.

## What's Tested

1. **Keycloak OAuth** — Direct Access Grant to obtain a JWT
2. **JWKS sync** — Keycloak signs JWTs, PostgREST verifies them
3. **Schema cache** — Initializes from real `schema_entities` / `schema_properties` views
4. **list_entities** — Returns pothole example entities
5. **describe_entity** — Resolves display names, shows properties
6. **list_records** — Queries records via PostgREST with FK embedding
7. **search** — Full-text search execution
8. **create_record + get_record** — Write path with ETag capture
9. **update_record with ETag** — Optimistic concurrency (valid + stale)
10. **Anonymous access** — web_anon role behavior

## Running Locally

```bash
# Start the test stack
docker compose -f docker-compose.test.yml up -d

# Wait for Keycloak to be ready (can take 60-90s on first run)
# Then fetch the JWKS for PostgREST
cd ../../../../examples/pothole
KEYCLOAK_PORT=28082 ./fetch-keycloak-jwk.sh
cd ../../tools/mcp-server/tests/integration

# Run tests
./run-tests.sh
```

## Running in CI

```bash
./run-tests.sh --ci
```

The `--ci` flag starts the docker-compose stack, runs tests, and tears everything down automatically.

## Teardown

```bash
docker compose -f docker-compose.test.yml down -v
```
