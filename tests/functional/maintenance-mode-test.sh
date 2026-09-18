#!/bin/bash
# =============================================================================
# Maintenance Mode Functional Test
# =============================================================================
# Tests the check_jwt() maintenance mode enforcement at the SQL level using
# SET LOCAL to simulate PostgREST GUC injection. Covers all 12 combinations
# of mode x role x HTTP method.
#
# Usage:
#   ./tests/functional/maintenance-mode-test.sh
#
# Prerequisites:
#   - Docker compose running (pothole example)
#   - PostgreSQL accessible on port 15432
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -uo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Counters
PASS=0
FAIL=0

# Database connection
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-15432}"
PGDB="${PGDB:-civic_os_db}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-securepassword123}"

export PGPASSWORD

# =============================================================================
# Test Helpers
# =============================================================================

section() {
  echo ""
  echo -e "${BOLD}$1${NC}"
  echo -e "${BOLD}$(printf '─%.0s' $(seq 1 ${#1}))${NC}"
}

assert_pass() {
  local test_name="$1"
  echo -e "  ${GREEN}PASS${NC} $test_name"
  PASS=$((PASS + 1))
}

assert_fail() {
  local test_name="$1"
  local detail="${2:-}"
  echo -e "  ${RED}FAIL${NC} $test_name"
  if [ -n "$detail" ]; then
    echo -e "       ${CYAN}$detail${NC}"
  fi
  FAIL=$((FAIL + 1))
}

# Run a SQL block inside a transaction that simulates PostgREST's pre-request
# environment. The function sets GUCs the way PostgREST would, then calls
# metadata.check_jwt().
#
# Args:
#   $1 - maintenance_mode value ('off', 'readonly', 'full')
#   $2 - JWT sub claim (empty string for anonymous)
#   $3 - request method ('GET', 'POST', etc.)
#   $4 - whether the user is admin ('true' or 'false')
#   $5 - (optional) request path (e.g., '/rpc/get_dashboards')
#
# Returns: exit code 0 if check_jwt() succeeded, non-zero if it raised PT503
run_check_jwt() {
  local mode="$1"
  local jwt_sub="$2"
  local method="$3"
  local is_admin="$4"
  local request_path="${5:-/Issue}"

  local jwt_claims
  if [ -n "$jwt_sub" ]; then
    jwt_claims="{\"sub\": \"$jwt_sub\"}"
  else
    jwt_claims="{}"
  fi

  # Build the SQL. We need to:
  # 1. Set app.settings.maintenance_mode (simulates PGRST_APP_SETTINGS_MAINTENANCE_MODE)
  # 2. Set request.jwt.claims (simulates PostgREST JWT parsing)
  # 3. Set request.method (simulates PostgREST HTTP method)
  # 4. Mock metadata.is_admin() if needed
  # 5. Call metadata.check_jwt()
  # 6. Read response.headers for admin bypass verification

  local admin_mock=""
  if [ "$is_admin" = "true" ]; then
    # Temporarily replace is_admin to return true for testing
    admin_mock="
      CREATE OR REPLACE FUNCTION metadata.is_admin() RETURNS BOOLEAN AS \$\$
        SELECT true;
      \$\$ LANGUAGE sql STABLE SECURITY DEFINER;
    "
  else
    admin_mock="
      CREATE OR REPLACE FUNCTION metadata.is_admin() RETURNS BOOLEAN AS \$\$
        SELECT false;
      \$\$ LANGUAGE sql STABLE SECURITY DEFINER;
    "
  fi

  local sql="
    BEGIN;
    $admin_mock
    SET LOCAL app.settings.maintenance_mode = '$mode';
    SELECT set_config('request.jwt.claims', '$jwt_claims', true);
    SELECT set_config('request.method', '$method', true);
    SELECT set_config('request.path', '$request_path', true);
    SELECT metadata.check_jwt();
    SELECT current_setting('response.headers', true) AS response_headers;
    ROLLBACK;
  "

  psql -h "$PGHOST" -p "$PGPORT" -d "$PGDB" -U "$PGUSER" \
    -t -A -c "$sql" 2>&1
}

# =============================================================================
# Main
# =============================================================================

echo -e "${BOLD}Maintenance Mode Functional Test${NC}"
echo -e "${BOLD}════════════════════════════════════════${NC}"

# Verify database connectivity
if ! psql -h "$PGHOST" -p "$PGPORT" -d "$PGDB" -U "$PGUSER" -c "SELECT 1" > /dev/null 2>&1; then
  echo -e "${RED}FATAL: Cannot connect to PostgreSQL at $PGHOST:$PGPORT/$PGDB${NC}"
  exit 1
fi
echo -e "Connected to PostgreSQL at $PGHOST:$PGPORT/$PGDB"

# Verify metadata.check_jwt() exists
if ! psql -h "$PGHOST" -p "$PGPORT" -d "$PGDB" -U "$PGUSER" -t -A \
  -c "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proname = 'check_jwt' AND n.nspname = 'metadata'" 2>/dev/null | grep -q "1"; then
  echo -e "${RED}FATAL: metadata.check_jwt() does not exist. Run migrations first.${NC}"
  exit 1
fi
echo -e "metadata.check_jwt() found"

# =============================================================================
# Test Group 1: mode=off (normal operation)
# =============================================================================
section "1. Mode: off (normal operation)"

# 1a. Anonymous GET — should succeed
OUTPUT=$(run_check_jwt "off" "" "GET" "false" 2>&1)
if echo "$OUTPUT" | grep -q "PT503\|ERROR"; then
  assert_fail "off + anonymous + GET: should succeed" "$OUTPUT"
else
  assert_pass "off + anonymous + GET: succeeds normally"
fi

# 1b. Authenticated POST — should succeed
OUTPUT=$(run_check_jwt "off" "00000000-0000-0000-0000-000000000001" "POST" "false" 2>&1)
if echo "$OUTPUT" | grep -q "PT503\|ERROR"; then
  assert_fail "off + authenticated + POST: should succeed" "$OUTPUT"
else
  assert_pass "off + authenticated + POST: succeeds normally"
fi

# =============================================================================
# Test Group 2: mode=readonly
# =============================================================================
section "2. Mode: readonly"

# 2a. Anonymous GET — should succeed (read allowed)
OUTPUT=$(run_check_jwt "readonly" "" "GET" "false" 2>&1)
if echo "$OUTPUT" | grep -q "PT503\|ERROR"; then
  assert_fail "readonly + anonymous + GET: should succeed" "$OUTPUT"
else
  assert_pass "readonly + anonymous + GET: succeeds (reads allowed)"
fi

# 2b. Authenticated GET — should succeed with header
OUTPUT=$(run_check_jwt "readonly" "00000000-0000-0000-0000-000000000001" "GET" "false" 2>&1)
if echo "$OUTPUT" | grep -q "PT503\|ERROR"; then
  assert_fail "readonly + authenticated + GET: should succeed" "$OUTPUT"
else
  if echo "$OUTPUT" | grep -q "X-Maintenance-Mode.*readonly"; then
    assert_pass "readonly + authenticated + GET: succeeds with X-Maintenance-Mode header"
  else
    assert_pass "readonly + authenticated + GET: succeeds (reads allowed)"
  fi
fi

# 2c. Authenticated POST — should fail with PT503
OUTPUT=$(run_check_jwt "readonly" "00000000-0000-0000-0000-000000000001" "POST" "false" 2>&1)
if echo "$OUTPUT" | grep -q "ERROR.*maintenance"; then
  assert_pass "readonly + authenticated + POST: blocked with maintenance error"
else
  assert_fail "readonly + authenticated + POST: should be blocked" "$OUTPUT"
fi

# 2d. Authenticated PATCH — should fail with PT503
OUTPUT=$(run_check_jwt "readonly" "00000000-0000-0000-0000-000000000001" "PATCH" "false" 2>&1)
if echo "$OUTPUT" | grep -q "ERROR.*maintenance"; then
  assert_pass "readonly + authenticated + PATCH: blocked with maintenance error"
else
  assert_fail "readonly + authenticated + PATCH: should be blocked" "$OUTPUT"
fi

# 2e. Authenticated DELETE — should fail with PT503
OUTPUT=$(run_check_jwt "readonly" "00000000-0000-0000-0000-000000000001" "DELETE" "false" 2>&1)
if echo "$OUTPUT" | grep -q "ERROR.*maintenance"; then
  assert_pass "readonly + authenticated + DELETE: blocked with maintenance error"
else
  assert_fail "readonly + authenticated + DELETE: should be blocked" "$OUTPUT"
fi

# 2f. Authenticated POST to /rpc/* — should succeed (RPC passthrough)
OUTPUT=$(run_check_jwt "readonly" "00000000-0000-0000-0000-000000000001" "POST" "false" "/rpc/get_dashboards" 2>&1)
if echo "$OUTPUT" | grep -q "ERROR.*maintenance"; then
  assert_fail "readonly + authenticated + POST /rpc/*: RPCs should pass through" "$OUTPUT"
else
  assert_pass "readonly + authenticated + POST /rpc/*: RPC allowed (reads via POST)"
fi

# 2g. Admin POST — should succeed (admin bypass)
OUTPUT=$(run_check_jwt "readonly" "00000000-0000-0000-0000-000000000001" "POST" "true" 2>&1)
if echo "$OUTPUT" | grep -q "PT503"; then
  assert_fail "readonly + admin + POST: admin should bypass" "$OUTPUT"
else
  if echo "$OUTPUT" | grep -q "X-Maintenance-Mode.*readonly-admin"; then
    assert_pass "readonly + admin + POST: bypassed with readonly-admin header"
  else
    assert_pass "readonly + admin + POST: bypassed (admin override)"
  fi
fi

# =============================================================================
# Test Group 3: mode=full
# =============================================================================
section "3. Mode: full"

# 3a. Anonymous GET — should fail with PT503
OUTPUT=$(run_check_jwt "full" "" "GET" "false" 2>&1)
if echo "$OUTPUT" | grep -q "ERROR.*maintenance"; then
  assert_pass "full + anonymous + GET: blocked with maintenance error"
else
  assert_fail "full + anonymous + GET: should be blocked" "$OUTPUT"
fi

# 3b. Authenticated GET — should fail with PT503
OUTPUT=$(run_check_jwt "full" "00000000-0000-0000-0000-000000000001" "GET" "false" 2>&1)
if echo "$OUTPUT" | grep -q "ERROR.*maintenance"; then
  assert_pass "full + authenticated + GET: blocked with maintenance error"
else
  assert_fail "full + authenticated + GET: should be blocked" "$OUTPUT"
fi

# 3c. Authenticated POST — should fail with PT503
OUTPUT=$(run_check_jwt "full" "00000000-0000-0000-0000-000000000001" "POST" "false" 2>&1)
if echo "$OUTPUT" | grep -q "ERROR.*maintenance"; then
  assert_pass "full + authenticated + POST: blocked with maintenance error"
else
  assert_fail "full + authenticated + POST: should be blocked" "$OUTPUT"
fi

# 3d. Admin GET — should succeed (admin bypass)
OUTPUT=$(run_check_jwt "full" "00000000-0000-0000-0000-000000000001" "GET" "true" 2>&1)
if echo "$OUTPUT" | grep -q "PT503"; then
  assert_fail "full + admin + GET: admin should bypass" "$OUTPUT"
else
  if echo "$OUTPUT" | grep -q "X-Maintenance-Mode.*full-admin"; then
    assert_pass "full + admin + GET: bypassed with full-admin header"
  else
    assert_pass "full + admin + GET: bypassed (admin override)"
  fi
fi

# =============================================================================
# Test Group 4: Translation keys
# =============================================================================
section "4. Translation keys"

TRANS_COUNT=$(psql -h "$PGHOST" -p "$PGPORT" -d "$PGDB" -U "$PGUSER" -t -A \
  -c "SELECT count(*) FROM metadata.translations WHERE source_type = 'ui' AND source_key LIKE 'maintenance.%'" 2>/dev/null)

if [ "$TRANS_COUNT" -ge 30 ]; then
  assert_pass "At least 30 maintenance.* translations exist ($TRANS_COUNT found)"
else
  assert_fail "Expected at least 30 maintenance.* translations, found $TRANS_COUNT"
fi

# Spot-check English sentinel
EN_CHECK=$(psql -h "$PGHOST" -p "$PGPORT" -d "$PGDB" -U "$PGUSER" -t -A \
  -c "SELECT translated_text FROM metadata.translations WHERE source_type = 'ui' AND source_key = 'maintenance.full_title' AND locale = 'en'" 2>/dev/null)

if [ "$EN_CHECK" = "System Maintenance" ]; then
  assert_pass "English sentinel: maintenance.full_title = 'System Maintenance'"
else
  assert_fail "English sentinel mismatch: got '$EN_CHECK'"
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo -e "${BOLD}════════════════════════════════════════${NC}"
TOTAL=$((PASS + FAIL))
echo -e "${BOLD}Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} / $TOTAL total"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}Some tests failed!${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi
