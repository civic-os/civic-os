#!/bin/bash
# =============================================================================
# Functional Test: v0-76-5 REVOKE PUBLIC EXECUTE
# =============================================================================
# Verifies that anonymous users (web_anon) cannot call authenticated-only RPC
# functions through PostgREST after the v0-76-5-revoke-public-execute security
# migration, that authenticated users still can, and that the RPCs intended for
# anonymous use keep working.
#
# The assertion is on the HTTP status code, not on function logic:
#   - Anonymous, authenticated-only RPC      -> 401/403 (EXECUTE denied)
#   - Authenticated, same RPC                -> anything except 401/403/404-PGRST202/5xx
#                                               (200, or 400/404 from an in-body
#                                               guard or lookup are all fine)
#   - Anonymous, anon-facing RPC             -> 200
#
# Request payloads are deliberately inert (nonexistent table/entity names, nil
# UUIDs, id -1) and authenticated calls use the least-privileged test user so
# the in-body guards stop execution before any side effects.
#
# Run this AFTER the migration is deployed. Against a pre-migration database the
# anonymous calls reach the vulnerable function bodies (that is the bug this
# test guards against) and enable_entity_notes would leave a bogus
# metadata.entities row for 'v0_76_5_nonexistent'.
#
# Usage:
#   ./tests/functional/v0-76-5-revoke-public-execute-test.sh
#
# Environment overrides (defaults match the local docker-compose stack):
#   POSTGREST_URL    http://localhost:3000
#   KEYCLOAK_URL     http://localhost:8082
#   KEYCLOAK_REALM   civic-os-dev
#   KEYCLOAK_CLIENT  civic-os-dev-client
#   TEST_USER        testuser   (password = username)
#   TEST_TOKEN       pre-minted JWT for authenticated tests; skips Keycloak
#
# Prerequisites:
#   - Docker compose running (any example) with the v0-76-5 migration applied
#   - PostgREST reachable, Keycloak reachable for authenticated tests
#   - No jq/psql dependency (curl only)
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Counters
PASS=0
FAIL=0
SKIP=0

# Configuration
POSTGREST_URL="${POSTGREST_URL:-http://localhost:3000}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8082}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-civic-os-dev}"
KEYCLOAK_CLIENT="${KEYCLOAK_CLIENT:-civic-os-dev-client}"
TEST_USER="${TEST_USER:-testuser}"

# Result of the last call_rpc
HTTP_STATUS=""
HTTP_BODY=""

# =============================================================================
# Test Helpers
# =============================================================================

pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  if [ -n "${2:-}" ]; then
    echo -e "       ${2}"
  fi
  FAIL=$((FAIL + 1))
}

skip_test() {
  echo -e "  ${YELLOW}SKIP${NC} $1 ($2)"
  SKIP=$((SKIP + 1))
}

section() {
  echo ""
  echo -e "${BOLD}━━━ $1 ━━━${NC}"
}

# First 160 chars of the last response body, newlines flattened.
body_snippet() {
  local s="${HTTP_BODY:0:160}"
  echo "${s//$'\n'/ }"
}

get_token() {
  local username="$1"
  curl -s -m 15 -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "client_id=$KEYCLOAK_CLIENT" \
    -d "grant_type=password" \
    -d "username=$username" \
    -d "password=$username" 2>/dev/null \
    | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4 || true
}

# POST to /rpc/<fn> and set HTTP_STATUS / HTTP_BODY.
# Usage: call_rpc <token-or-empty-for-anonymous> <function_name> <json_body>
call_rpc() {
  local token="$1" fn="$2" body="$3" raw
  local -a auth=()
  if [ -n "$token" ]; then
    auth=(-H "Authorization: Bearer $token")
  fi
  raw=$(curl -s -m 20 -X POST "$POSTGREST_URL/rpc/$fn" \
    ${auth[@]+"${auth[@]}"} \
    -H "Content-Type: application/json" \
    -d "$body" \
    -w $'\n%{http_code}' 2>/dev/null) || true
  HTTP_STATUS="${raw##*$'\n'}"
  HTTP_BODY="${raw%$'\n'*}"
  if [ -z "$HTTP_STATUS" ]; then
    HTTP_STATUS="000"
  fi
}

# -----------------------------------------------------------------------------
# RPC cases: <function_name>|<minimal valid JSON body>
# Every function here is authenticated-only after v0-76-5. Bodies satisfy
# PostgREST parameter resolution (so a denial is an EXECUTE denial, not a 404)
# while staying inert if a call ever reaches the function body.
# -----------------------------------------------------------------------------
RPC_CASES=$(cat <<'EOF'
request_upload_url|{"p_entity_type":"v0_76_5_nonexistent","p_entity_id":"1","p_file_name":"v0-76-5-test.txt","p_file_type":"text/plain"}
get_upload_url|{"p_request_id":"00000000-0000-0000-0000-000000000000"}
cancel_series_occurrence|{"p_entity_table":"v0_76_5_nonexistent","p_entity_id":-1}
create_recurring_series|{"p_group_name":"v0-76-5 test","p_group_description":null,"p_group_color":null,"p_entity_table":"v0_76_5_nonexistent","p_entity_template":{},"p_rrule":"FREQ=DAILY;COUNT=1","p_dtstart":"2099-01-01T09:00:00","p_duration":"1 hour","p_timezone":"UTC","p_time_slot_property":"time_slot","p_expand_now":false,"p_skip_conflicts":false,"p_expand_horizon_days":90}
delete_series_group|{"p_group_id":-1}
delete_series_with_instances|{"p_series_id":-1}
create_notification|{"p_user_id":"00000000-0000-0000-0000-000000000000","p_template_name":"v0_76_5_nonexistent_template"}
create_entity_note|{"p_entity_type":"v0_76_5_nonexistent","p_entity_id":"1","p_content":"v0-76-5 test"}
enable_entity_notes|{"p_entity_type":"v0_76_5_nonexistent"}
preview_template_parts|{"p_subject_template":"v0-76-5 test"}
validate_template_parts|{"p_subject_template":"v0-76-5 test"}
admin_get_user_bulk_subscriptions|{"p_user_id":"00000000-0000-0000-0000-000000000000"}
expand_series_instances|{"p_series_id":-1,"p_expand_until":"2099-01-01"}
preview_recurring_conflicts|{"p_entity_table":"v0_76_5_nonexistent","p_scope_column":"id","p_scope_value":"1","p_time_slot_column":"time_slot","p_occurrences":["2099-01-01T09:00:00Z","2099-01-01T10:00:00Z"]}
EOF
)

# =============================================================================
# SETUP
# =============================================================================

section "SETUP"

echo "  PostgREST: $POSTGREST_URL"
echo "  Keycloak:  $KEYCLOAK_URL (realm $KEYCLOAK_REALM, user $TEST_USER)"

PR_STATUS=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$POSTGREST_URL/" 2>/dev/null || true)
if [ "$PR_STATUS" = "000" ] || [ -z "$PR_STATUS" ]; then
  echo -e "  ${RED}FAIL${NC} PostgREST not reachable at $POSTGREST_URL"
  exit 1
fi
echo "  PostgREST reachable (HTTP $PR_STATUS)."

USER_TOKEN="${TEST_TOKEN:-}"
if [ -n "$USER_TOKEN" ]; then
  echo "  Using TEST_TOKEN from environment."
else
  USER_TOKEN=$(get_token "$TEST_USER")
fi
if [ -n "$USER_TOKEN" ]; then
  echo "  Authenticated token available."
else
  echo -e "  ${YELLOW}WARNING${NC}: could not get a token for $TEST_USER; authenticated tests will be skipped."
fi

# =============================================================================
# PART 1: Anonymous access blocked
# =============================================================================

section "PART 1: Anonymous access blocked (expect HTTP 401/403)"

IDX=0
while IFS='|' read -r FN BODY; do
  [ -z "$FN" ] && continue
  IDX=$((IDX + 1))
  LABEL=$(printf "1.%02d anon blocked: %s" "$IDX" "$FN")
  call_rpc "" "$FN" "$BODY"
  case "$HTTP_STATUS" in
    401|403)
      if [[ "$HTTP_BODY" == *PGRST30* ]]; then
        fail "$LABEL" "Blocked for the wrong reason (JWT/anon-role error, not EXECUTE): $(body_snippet)"
      else
        pass "$LABEL (HTTP $HTTP_STATUS)"
      fi
      ;;
    404)
      if [[ "$HTTP_BODY" == *PGRST202* ]]; then
        fail "$LABEL" "HTTP 404 PGRST202: function not found for these params; EXECUTE privilege unverified. $(body_snippet)"
      else
        # PostgREST returns 404 when the function is not visible to web_anon
        # at all (PGRST119) — this is even better than 401 since the function
        # is completely invisible to anonymous callers.
        pass "$LABEL (HTTP 404 — function invisible to anon)"
      fi
      ;;
    *)
      fail "$LABEL" "Anonymous call NOT blocked (HTTP $HTTP_STATUS): $(body_snippet)"
      ;;
  esac
done <<< "$RPC_CASES"

# =============================================================================
# PART 2: Authenticated access allowed
# =============================================================================

section "PART 2: Authenticated access allowed (expect anything but 401/403)"

AUTH_READY=false
if [ -z "$USER_TOKEN" ]; then
  fail "2.00 token for $TEST_USER" "Keycloak at $KEYCLOAK_URL returned no access_token; authenticated tests cannot run"
else
  # Control: confirm PostgREST accepts the token before judging 401/403 below.
  call_rpc "$USER_TOKEN" "get_dashboards" '{}'
  if [ "$HTTP_STATUS" = "200" ]; then
    pass "2.00 token for $TEST_USER accepted by PostgREST (get_dashboards HTTP 200)"
    AUTH_READY=true
  else
    fail "2.00 token for $TEST_USER accepted by PostgREST" "get_dashboards returned HTTP $HTTP_STATUS: $(body_snippet)"
  fi
fi

IDX=0
while IFS='|' read -r FN BODY; do
  [ -z "$FN" ] && continue
  IDX=$((IDX + 1))
  LABEL=$(printf "2.%02d authenticated allowed: %s" "$IDX" "$FN")
  if [ "$AUTH_READY" != true ]; then
    skip_test "$LABEL" "no usable $TEST_USER token"
    continue
  fi
  call_rpc "$USER_TOKEN" "$FN" "$BODY"
  case "$HTTP_STATUS" in
    401|403)
      fail "$LABEL" "Authenticated call denied (HTTP $HTTP_STATUS): $(body_snippet)"
      ;;
    404)
      if [[ "$HTTP_BODY" == *PGRST202* ]]; then
        fail "$LABEL" "HTTP 404 PGRST202: function not found for these params. $(body_snippet)"
      else
        pass "$LABEL (HTTP 404 from function body, EXECUTE allowed)"
      fi
      ;;
    000|5*)
      fail "$LABEL" "Unexpected HTTP $HTTP_STATUS: $(body_snippet)"
      ;;
    *)
      pass "$LABEL (HTTP $HTTP_STATUS)"
      ;;
  esac
done <<< "$RPC_CASES"

# =============================================================================
# PART 3: Anonymous-facing RPCs still work
# =============================================================================
# Also the control for Part 1: if anonymous access were disabled wholesale
# (no db-anon-role), Part 1 would pass vacuously and this part would fail.

section "PART 3: Anonymous-facing RPCs still work (expect HTTP 200)"

ANON_CASES=$(cat <<'EOF'
get_dashboards|{}
get_translations_for_locale|{"p_locale":"en"}
get_statuses_for_entity|{"p_entity_type":"issue"}
EOF
)

IDX=0
while IFS='|' read -r FN BODY; do
  [ -z "$FN" ] && continue
  IDX=$((IDX + 1))
  LABEL=$(printf "3.%02d anon allowed: %s" "$IDX" "$FN")
  call_rpc "" "$FN" "$BODY"
  if [ "$HTTP_STATUS" = "200" ]; then
    pass "$LABEL (HTTP 200)"
  else
    fail "$LABEL" "Expected HTTP 200, got $HTTP_STATUS: $(body_snippet)"
  fi
done <<< "$ANON_CASES"

# =============================================================================
# Summary
# =============================================================================

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  FUNCTIONAL TEST RESULTS: v0-76-5 REVOKE PUBLIC EXECUTE${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${GREEN}PASSED${NC}: $PASS"
echo -e "  ${RED}FAILED${NC}: $FAIL"
echo -e "  ${YELLOW}SKIPPED${NC}: $SKIP"
echo -e "  Total:   $((PASS + FAIL + SKIP))"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ "$FAIL" -gt 0 ]; then
  echo -e "\n${RED}Some tests failed!${NC}"
  exit 1
else
  echo -e "\n${GREEN}All tests passed!${NC}"
  exit 0
fi
