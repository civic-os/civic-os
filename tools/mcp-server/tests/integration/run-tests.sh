#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
#
# Full-stack integration test for the Civic OS MCP server.
#
# Prerequisites:
#   docker compose -f docker-compose.test.yml up -d
#   Wait for all services to be healthy
#
# What this tests:
#   1. Keycloak JWKS fetch and PostgREST sync
#   2. Keycloak OAuth token acquisition (Direct Access Grant)
#   3. MCP server schema cache initialization against real PostgREST
#   4. list_entities — returns pothole example entities
#   5. describe_entity — returns properties for pot_holes
#   6. list_records — queries records from PostgREST
#   7. search — FTS search across entities
#   8. create_record + get_record — create then read back
#   9. update_record with ETag — optimistic concurrency
#  10. Anonymous access — web_anon role (no JWT) sees limited entities
#  11. HTTP transport — health, CORS, OAuth discovery, multi-role tool calls
#
# Usage:
#   ./run-tests.sh           # Run against local docker-compose
#   ./run-tests.sh --ci      # Full lifecycle: start, test, teardown

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
MCP_SERVER_DIR="$REPO_ROOT/tools/mcp-server"

# Ports from docker-compose.test.yml
POSTGREST_PORT=23000
KEYCLOAK_PORT=28082
MCP_PORT=23001

POSTGREST_URL="http://localhost:$POSTGREST_PORT"
KEYCLOAK_URL="http://localhost:$KEYCLOAK_PORT"
MCP_URL="http://localhost:$MCP_PORT"

# Keycloak realm/client from the shared keycloak realm import
REALM="civic-os-dev"
CLIENT_ID="civic-os-dev-client"

# Test users from the keycloak realm import
TEST_USER="testadmin"
TEST_PASSWORD="testadmin"

PASSED=0
FAILED=0
ERRORS=""

# ============================================================================
# Helpers
# ============================================================================

green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
red()   { printf '\033[0;31m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[0;33m%s\033[0m\n' "$1"; }

pass() {
  green "  ✓ $1"
  PASSED=$((PASSED + 1))
}

fail() {
  red "  ✗ $1"
  FAILED=$((FAILED + 1))
  ERRORS="${ERRORS}\n  - $1: $2"
}

wait_for_url() {
  local name=$1 url=$2 max_attempts=${3:-30} attempt=0
  printf "  Waiting for %s..." "$name"
  while [ $attempt -lt $max_attempts ]; do
    if curl -sf "$url" > /dev/null 2>&1; then
      green " ready"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 3
  done
  red " timeout after $((max_attempts * 3))s"
  return 1
}

# ============================================================================
# CI Mode: Full lifecycle
# ============================================================================

CI_MODE=false
if [[ "${1:-}" == "--ci" ]]; then
  CI_MODE=true
  echo "=== CI Mode: Starting docker-compose stack ==="
  cd "$SCRIPT_DIR"
  docker compose -f docker-compose.test.yml up -d
  trap 'echo "=== Tearing down..."; cd "$SCRIPT_DIR" && docker compose -f docker-compose.test.yml down -v' EXIT
fi

# ============================================================================
# Phase 1: Wait for services
# ============================================================================
# docker-compose.test.yml orchestrates the startup order:
#   postgres (healthy) + keycloak (healthy) → postgrest (auto-fetches JWKS)
# We just need to wait for PostgREST to be ready.

echo ""
echo "=== Phase 1: Service Readiness ==="

wait_for_url "PostgREST" "$POSTGREST_URL/" 60
pass "PostgREST is up (postgres healthy, JWKS auto-fetched from Keycloak)"

wait_for_url "MCP Server" "$MCP_URL/health" 30
pass "MCP HTTP server is up (health endpoint ready)"

# ============================================================================
# Phase 2: Get JWT from Keycloak (Direct Access Grant)
# ============================================================================

echo ""
echo "=== Phase 2: OAuth Token Acquisition ==="

TOKEN_URL="$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token"
TOKEN_RESPONSE=$(curl -sf -X POST "$TOKEN_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=$CLIENT_ID" \
  -d "username=$TEST_USER" \
  -d "password=$TEST_PASSWORD" 2>/dev/null || echo '{"error":"request_failed"}')

ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token // empty')

if [ -z "$ACCESS_TOKEN" ]; then
  red "  ✗ Failed to get access token from Keycloak"
  red "    Response: $(echo "$TOKEN_RESPONSE" | jq -r '.error_description // .error // "unknown"')"
  echo ""
  red "FATAL: Cannot continue without a valid JWT. Aborting."
  exit 1
fi

pass "Obtained JWT from Keycloak (Direct Access Grant)"

# Verify the token works against PostgREST with the synced JWKS
POSTGREST_AUTH_CHECK=$(curl -sf -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$POSTGREST_URL/schema_entities?limit=1" 2>/dev/null || echo "000")

if [ "$POSTGREST_AUTH_CHECK" = "200" ]; then
  pass "JWT accepted by PostgREST (HTTP 200)"
else
  fail "PostgREST auth" "HTTP $POSTGREST_AUTH_CHECK — JWKS sync may have failed"
  red "FATAL: PostgREST rejects the Keycloak JWT. Cannot test MCP tools."
  exit 1
fi

# ============================================================================
# Phase 3: MCP Server Tests (via Node.js test script)
# ============================================================================

echo ""
echo "=== Phase 3: MCP Server Integration Tests ==="

# Build the MCP server (needed for Node.js execution)
cd "$MCP_SERVER_DIR"
npm run build 2>/dev/null

# Run the MCP tool tests via a Node.js script that uses the MCP SDK client.
# Use process substitution (not pipe) so pass/fail counters update in this shell.
while IFS= read -r line; do
  case "$line" in
    PASS:*)
      pass "${line#PASS:}"
      ;;
    FAIL:*)
      msg="${line#FAIL:}"
      reason="${msg#*|}"
      test_name="${msg%%|*}"
      fail "$test_name" "$reason"
      ;;
    *)
      echo "  $line"
      ;;
  esac
done < <(node "$SCRIPT_DIR/mcp-tool-tests.mjs" "$POSTGREST_URL" "$ACCESS_TOKEN" 2>&1)

# ============================================================================
# Phase 4: Anonymous access test (no JWT)
# ============================================================================

echo ""
echo "=== Phase 4: Anonymous Access ==="

ANON_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$POSTGREST_URL/schema_entities?limit=1" 2>/dev/null || echo "000")

if [ "$ANON_STATUS" = "200" ]; then
  pass "Anonymous access to schema_entities works (web_anon role)"
else
  # This is expected if the instance requires authentication
  yellow "  ⚠ Anonymous access returned HTTP $ANON_STATUS (may be expected if auth is required)"
fi

# ============================================================================
# Phase 5: HTTP Transport Tests (multi-role via dockerized MCP server)
# ============================================================================

echo ""
echo "=== Phase 5: HTTP Transport Integration Tests ==="

# Run the HTTP transport tests against the dockerized MCP server.
# These test health, CORS, OAuth discovery, and tool calls as different roles.
while IFS= read -r line; do
  case "$line" in
    PASS:*)
      pass "${line#PASS:}"
      ;;
    FAIL:*)
      msg="${line#FAIL:}"
      reason="${msg#*|}"
      test_name="${msg%%|*}"
      fail "$test_name" "$reason"
      ;;
    *)
      echo "  $line"
      ;;
  esac
done < <(node "$SCRIPT_DIR/mcp-http-tests.mjs" "$MCP_URL" "$KEYCLOAK_URL" 2>&1)

# ============================================================================
# Summary
# ============================================================================

echo ""
echo "=== Test Summary ==="
green "  Passed: $PASSED"
if [ $FAILED -gt 0 ]; then
  red "  Failed: $FAILED"
  echo ""
  red "  Failures:$ERRORS"
  exit 1
else
  green "  All tests passed!"
fi
