#!/bin/bash
# =============================================================================
# PostgREST API Regression Test
# =============================================================================
# Exercises the PostgREST query patterns used by Civic OS to catch regressions
# from PostgREST version upgrades. Each test case maps to a real code path in
# DataService, SchemaService, or the MCP server's postgrest-client.
#
# Usage:
#   ./tests/functional/postgrest-api-regression-test.sh
#
# Prerequisites:
#   - Docker compose running (pothole example)
#   - PostgREST running (auto-fetches JWKS from Keycloak)
#   - jq installed
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

# Configuration
POSTGREST_URL="http://localhost:3000"
KEYCLOAK_URL="http://localhost:8082"
KEYCLOAK_REALM="civic-os-dev"
KEYCLOAK_CLIENT="civic-os-dev-client"

# Test data IDs (populated during setup, cleaned in teardown)
TAG_ID_1=""
TAG_ID_2=""
ISSUE_ID=""
CREATED_ISSUE=false  # Track whether we created the Issue (vs used existing)

# =============================================================================
# Test Helpers
# =============================================================================

assert_eq() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo -e "  ${GREEN}PASS${NC} $test_name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $test_name"
    echo -e "       Expected: ${CYAN}$expected${NC}"
    echo -e "       Actual:   ${RED}$actual${NC}"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_empty() {
  local test_name="$1"
  local actual="$2"
  if [ -n "$actual" ] && [ "$actual" != "null" ] && [ "$actual" != "" ]; then
    echo -e "  ${GREEN}PASS${NC} $test_name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $test_name (got empty/null)"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local test_name="$1"
  local needle="$2"
  local haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "  ${GREEN}PASS${NC} $test_name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $test_name"
    echo -e "       Expected to contain: ${CYAN}$needle${NC}"
    echo -e "       Got: ${RED}$haystack${NC}"
    FAIL=$((FAIL + 1))
  fi
}

assert_http_status() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "^$expected"; then
    echo -e "  ${GREEN}PASS${NC} $test_name (HTTP $actual)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $test_name (expected HTTP $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

section() {
  echo ""
  echo -e "${BOLD}$1${NC}"
  echo -e "${BOLD}$(printf '─%.0s' $(seq 1 ${#1}))${NC}"
}

get_token() {
  local username="$1"
  curl -s -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
    -d "client_id=$KEYCLOAK_CLIENT" \
    -d "username=$username" \
    -d "password=$username" \
    -d "grant_type=password" 2>/dev/null | jq -r '.access_token // empty'
}

# =============================================================================
# Cleanup (runs on exit)
# =============================================================================

cleanup() {
  echo ""
  echo -e "${BOLD}Cleanup${NC}"

  # Delete junction rows first (FK constraint)
  if [ -n "$ISSUE_ID" ]; then
    curl -s -o /dev/null -X DELETE \
      -H "Authorization: Bearer $TOKEN" \
      "$POSTGREST_URL/issue_tags?issue_id=eq.$ISSUE_ID"
    echo -e "  Deleted junction rows for Issue $ISSUE_ID"
  fi

  # Delete test Issue (only if we created it)
  if [ "$CREATED_ISSUE" = true ] && [ -n "$ISSUE_ID" ]; then
    curl -s -o /dev/null -X DELETE \
      -H "Authorization: Bearer $TOKEN" \
      "$POSTGREST_URL/Issue?id=eq.$ISSUE_ID"
    echo -e "  Deleted Issue $ISSUE_ID"
  fi

  # Delete test tags
  if [ -n "$TAG_ID_1" ]; then
    curl -s -o /dev/null -X DELETE \
      -H "Authorization: Bearer $TOKEN" \
      "$POSTGREST_URL/Tag?id=eq.$TAG_ID_1"
    echo -e "  Deleted Tag $TAG_ID_1"
  fi
  if [ -n "$TAG_ID_2" ]; then
    curl -s -o /dev/null -X DELETE \
      -H "Authorization: Bearer $TOKEN" \
      "$POSTGREST_URL/Tag?id=eq.$TAG_ID_2"
    echo -e "  Deleted Tag $TAG_ID_2"
  fi
}

trap cleanup EXIT

# =============================================================================
# Main
# =============================================================================

echo -e "${BOLD}PostgREST API Regression Test${NC}"
echo -e "${BOLD}════════════════════════════════════════${NC}"

# Get auth token
TOKEN=$(get_token "testadmin")
if [ -z "$TOKEN" ]; then
  echo -e "${RED}FATAL: Could not get Keycloak token. Is the stack running?${NC}"
  exit 1
fi
echo -e "Token acquired for testadmin"

# =============================================================================
# Setup: create test data used by multiple tests
# =============================================================================
section "Setup"

# Ensure the JWT user exists in civic_os_users (mirrors app login flow)
curl -s -o /dev/null \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$POSTGREST_URL/rpc/refresh_current_user"
echo -e "  Registered testadmin in civic_os_users"

# Create a test Issue
ISSUE_RESPONSE=$(curl -s \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -X POST "$POSTGREST_URL/Issue" \
  -d '{"display_name":"_PgRST_Regression_Test_Issue"}')
ISSUE_ID=$(echo "$ISSUE_RESPONSE" | jq -r '.[0].id // empty')
if [ -z "$ISSUE_ID" ] || [ "$ISSUE_ID" = "null" ]; then
  echo -e "${RED}FATAL: Could not create test Issue${NC}"
  echo "$ISSUE_RESPONSE"
  exit 1
fi
CREATED_ISSUE=true
echo -e "  Created Issue id=$ISSUE_ID"

# Create two test Tags (also serves as bulk insert test — see Test 3)
TAG_RESPONSE=$(curl -s \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -X POST "$POSTGREST_URL/Tag" \
  -d '[{"display_name":"_PgRST_Test_Tag_A","color":"#FF0000"},{"display_name":"_PgRST_Test_Tag_B","color":"#00FF00"}]')
TAG_ID_1=$(echo "$TAG_RESPONSE" | jq -r '.[0].id // empty')
TAG_ID_2=$(echo "$TAG_RESPONSE" | jq -r '.[1].id // empty')
if [ -z "$TAG_ID_1" ] || [ "$TAG_ID_1" = "null" ]; then
  echo -e "${RED}FATAL: Could not create test Tags${NC}"
  echo "$TAG_RESPONSE"
  exit 1
fi
echo -e "  Created Tags id=$TAG_ID_1, id=$TAG_ID_2"

# Create junction records (Issue ↔ Tags)
curl -s -o /dev/null \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -X POST "$POSTGREST_URL/issue_tags" \
  -d "[{\"issue_id\":$ISSUE_ID,\"tag_id\":$TAG_ID_1},{\"issue_id\":$ISSUE_ID,\"tag_id\":$TAG_ID_2}]"
echo -e "  Created junction records (Issue $ISSUE_ID ↔ Tags $TAG_ID_1, $TAG_ID_2)"

# =============================================================================
# Test 1: M:M junction table read
# Source: DataService.getManyToManyData() — data.service.ts:780-830
# =============================================================================
section "1. M:M junction table read"

RESPONSE=$(curl -s -o /tmp/pgrst_body.json -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$POSTGREST_URL/issue_tags?select=issue_id,tag_id&issue_id=eq.$ISSUE_ID")
assert_http_status "GET /issue_tags with select columns" "200" "$RESPONSE"

# Verify response is a JSON array with our junction records
ARRAY_CHECK=$(jq -r 'type' /tmp/pgrst_body.json 2>/dev/null)
assert_eq "Response is JSON array" "array" "$ARRAY_CHECK"

JUNCTION_COUNT=$(jq -r 'length' /tmp/pgrst_body.json 2>/dev/null)
assert_eq "Junction table has 2 records" "2" "$JUNCTION_COUNT"

# =============================================================================
# Test 2: M:M FK embedding through junction
# Source: SchemaService.propertyToSelectString() — schema.service.ts:697-718
# The !-hint disambiguator is PostgREST-specific syntax most likely to change.
# =============================================================================
section "2. FK embedding through junction (!-hint syntax)"

RESPONSE=$(curl -s -o /tmp/pgrst_body.json -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$POSTGREST_URL/Issue?select=id,issue_tags!issue_id(Tag!tag_id(id,display_name))&id=eq.$ISSUE_ID")
assert_http_status "GET /Issue with M:M FK embedding" "200" "$RESPONSE"

# Verify nested structure: Issue → issue_tags[] → Tag{}
NESTED_COUNT=$(jq -r '.[0].issue_tags | length' /tmp/pgrst_body.json 2>/dev/null)
assert_eq "M:M embedding returned 2 nested tags" "2" "$NESTED_COUNT"

NESTED_TAG_NAME=$(jq -r '.[0].issue_tags[0].Tag.display_name // empty' /tmp/pgrst_body.json 2>/dev/null)
assert_not_empty "Nested Tag has display_name" "$NESTED_TAG_NAME"

# =============================================================================
# Test 3: Bulk insert with return=representation
# Source: DataService.bulkInsert() — data.service.ts:923-958
# Used by Excel import on List pages.
# (Verified via setup — Tags were created with bulk insert + return=representation)
# =============================================================================
section "3. Bulk insert (array POST)"

# Re-verify the setup bulk insert results
RETURNED_COUNT=$(echo "$TAG_RESPONSE" | jq -r 'length' 2>/dev/null)
assert_eq "Bulk insert returned 2 records" "2" "$RETURNED_COUNT"
assert_not_empty "Bulk insert returned first ID" "$TAG_ID_1"
assert_not_empty "Bulk insert returned second ID" "$TAG_ID_2"

# Verify the records exist via GET
RESPONSE=$(curl -s -o /tmp/pgrst_body.json -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$POSTGREST_URL/Tag?id=in.($TAG_ID_1,$TAG_ID_2)&order=id")
assert_http_status "GET bulk-inserted Tags" "200" "$RESPONSE"

FETCHED_COUNT=$(jq -r 'length' /tmp/pgrst_body.json 2>/dev/null)
assert_eq "Both bulk-inserted Tags exist" "2" "$FETCHED_COUNT"

# =============================================================================
# Test 4: Bulk junction insert with return=minimal
# Source: DataService.bulkInsertJunctions() — data.service.ts:970-988
# Used by M:M import (v0.60.0).
# (Verified via setup — junction records were created with bulk insert)
# =============================================================================
section "4. Bulk junction insert"

# Verify the junction records exist
RESPONSE=$(curl -s -o /tmp/pgrst_body.json -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$POSTGREST_URL/issue_tags?issue_id=eq.$ISSUE_ID&order=tag_id")
assert_http_status "GET junction records" "200" "$RESPONSE"

JUNCTION_COUNT=$(jq -r 'length' /tmp/pgrst_body.json 2>/dev/null)
assert_eq "Bulk junction insert created 2 records" "2" "$JUNCTION_COUNT"

# =============================================================================
# Test 5: Pagination — empty result with Content-Range
# Source: DataService.getDataPaginated() — data.service.ts:137-169
# Parses Content-Range: */0 for empty tables.
# =============================================================================
section "5. Pagination: empty result"

HEADERS=$(curl -s -D - -o /tmp/pgrst_body.json \
  -H "Authorization: Bearer $TOKEN" \
  -H "Range: 0-0" \
  -H "Prefer: count=exact" \
  "$POSTGREST_URL/Issue?id=eq.-999")
CONTENT_RANGE=$(echo "$HEADERS" | grep -i 'content-range' | tr -d '\r')
assert_contains "Content-Range header present for empty result" "content-range" "$(echo "$CONTENT_RANGE" | tr '[:upper:]' '[:lower:]')"
assert_contains "Content-Range shows */0 for empty result" "*/0" "$CONTENT_RANGE"

# =============================================================================
# Test 6: Pagination — single row with exact count
# Source: DataService.getDataPaginated() — data.service.ts:137-169
# Validates Content-Range: 0-0/N format for total count extraction.
# =============================================================================
section "6. Pagination: single row with exact count"

HEADERS=$(curl -s -D - -o /tmp/pgrst_body.json \
  -H "Authorization: Bearer $TOKEN" \
  -H "Range: 0-0" \
  -H "Prefer: count=exact" \
  "$POSTGREST_URL/Issue?limit=1")
CONTENT_RANGE=$(echo "$HEADERS" | grep -i 'content-range' | tr -d '\r')
assert_contains "Content-Range header present for single row" "content-range" "$(echo "$CONTENT_RANGE" | tr '[:upper:]' '[:lower:]')"
# Should be 0-0/N where N >= 1
assert_contains "Content-Range format 0-0/" "0-0/" "$CONTENT_RANGE"

# =============================================================================
# Test 7: Count without Range header
# Source: MCP server postgrest-client.ts:38-44
# v16 optimized this path (eliminated double-query).
# =============================================================================
section "7. Count without Range header"

HEADERS=$(curl -s -D - -o /tmp/pgrst_body.json \
  -H "Authorization: Bearer $TOKEN" \
  -H "Prefer: count=exact" \
  "$POSTGREST_URL/Issue?limit=1")
CONTENT_RANGE=$(echo "$HEADERS" | grep -i 'content-range' | tr -d '\r')
assert_contains "Content-Range present without Range request header" "content-range" "$(echo "$CONTENT_RANGE" | tr '[:upper:]' '[:lower:]')"

# =============================================================================
# Test 8: FK embedding with alias and hint
# Source: SchemaService.propertyToSelectString() — schema.service.ts:736-738
# Also mirrored in MCP select-builder.ts:29-30.
# The :alias!hint(fields) syntax is the most frequently used PostgREST feature.
# =============================================================================
section "8. FK embedding with :alias!hint"

RESPONSE=$(curl -s -o /tmp/pgrst_body.json -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$POSTGREST_URL/Issue?select=id,status:statuses!status(id,display_name,color)&id=eq.$ISSUE_ID")
assert_http_status "GET /Issue with FK alias embedding" "200" "$RESPONSE"

# Verify the alias resolved correctly — status should be an object, not an int
STATUS_TYPE=$(jq -r '.[0].status | type' /tmp/pgrst_body.json 2>/dev/null)
assert_eq "FK alias 'status' resolved to object" "object" "$STATUS_TYPE"

STATUS_NAME=$(jq -r '.[0].status.display_name // empty' /tmp/pgrst_body.json 2>/dev/null)
assert_not_empty "FK embedded display_name present" "$STATUS_NAME"

# =============================================================================
# Test 9: RPC call with JWT auth
# Source: DataService.refreshCurrentUser() — data.service.ts:229-244
# Called on every role impersonation.
# =============================================================================
section "9. RPC call"

RESPONSE=$(curl -s -o /tmp/pgrst_body.json -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$POSTGREST_URL/rpc/refresh_current_user")
assert_http_status "POST /rpc/refresh_current_user" "200" "$RESPONSE"

# =============================================================================
# Test 10: Error response shape (verbose mode)
# Source: DataService.parseApiError() — data.service.ts:662-688
# Also PostgRESTRequestError in MCP — postgrest-client.ts:128-140.
# Validates the verbose error response includes code, message, details, hint.
# =============================================================================
section "10. Error response shape"

# POST to Issue with missing required 'display_name' — should trigger a constraint error
RESPONSE=$(curl -s -o /tmp/pgrst_body.json -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$POSTGREST_URL/Issue" \
  -d '{}')

# Should be 400-range error
ERROR_CODE=$(jq -r '.code // empty' /tmp/pgrst_body.json 2>/dev/null)
ERROR_MSG=$(jq -r '.message // empty' /tmp/pgrst_body.json 2>/dev/null)
assert_not_empty "Error response has 'code' field" "$ERROR_CODE"
assert_not_empty "Error response has 'message' field" "$ERROR_MSG"

# 'details' and 'hint' may be null but should be present as keys
DETAILS_EXISTS=$(jq 'has("details")' /tmp/pgrst_body.json 2>/dev/null)
HINT_EXISTS=$(jq 'has("hint")' /tmp/pgrst_body.json 2>/dev/null)
assert_eq "Error response has 'details' key" "true" "$DETAILS_EXISTS"
assert_eq "Error response has 'hint' key" "true" "$HINT_EXISTS"

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
