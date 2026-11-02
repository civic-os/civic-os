#!/bin/bash
# =============================================================================
# Functional Test: Neighborhood Hub access hardening
# =============================================================================
# Verifies init script 38_neh_access_hardening.sql (with 37's role guards) as
# real callers: anonymous, two borrowers, an editor, NEH staff and an admin.
#
#   - Anonymous reads only public reference data and calls no workflow RPC
#   - A borrower reads their own records only and cannot change their status
#   - Workflow RPCs reject everyone outside neh_staff, neh_admin and admin
#   - Staff and admin keep full access
#   - The SQL layer: RLS on every table, ACLs, indexes, wfchecks, conditions
#
# Identities (password = username):
#   testuser      borrower A
#   testmanager   borrower B (the manager role holds no NEH permissions)
#   testeditor    holds table permissions, fails the role guards
#   testnehstaff  neh_staff, created here with the Keycloak admin API, so the
#                 realm file every example imports stays untouched
#   testadmin     admin
#
# It owns its fixtures and is re-runnable. Rows carry the marker below, and are
# removed at the start of a run and again on exit. Run it against the
# neighborhood-hub stack only. CI has no such stack, so it is run by hand.
# Two things outlast a run: the testuser and testmanager borrowers stay approved,
# and testnehstaff and the neh_staff realm role stay in Keycloak.
#
# Run before the scripts are applied, every behavior below must fail. Anonymous
# RPC calls use id -1, so a run against unguarded bodies mutates nothing.
#
# Usage:
#   ./tests/functional/neh-access-hardening-test.sh
#
# Environment overrides (defaults match the local docker-compose stack):
#   POSTGREST_URL        http://localhost:3000
#   KEYCLOAK_URL         http://localhost:8082
#   KEYCLOAK_REALM       civic-os-dev
#   KEYCLOAK_CLIENT      civic-os-dev-client
#   KEYCLOAK_ADMIN_USER  admin
#   KEYCLOAK_ADMIN_PASS  admin
#   DB_HOST              localhost
#   DB_PORT              15432
#   DB_NAME              civic_os_db
#   DB_USER              postgres
#   DB_PASS              securepassword123
#
# Prerequisites: curl, jq, psql.
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
BOLD='\033[1m'

PASS=0
FAIL=0

POSTGREST_URL="${POSTGREST_URL:-http://localhost:3000}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8082}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-civic-os-dev}"
KEYCLOAK_CLIENT="${KEYCLOAK_CLIENT:-civic-os-dev-client}"
KEYCLOAK_ADMIN_USER="${KEYCLOAK_ADMIN_USER:-admin}"
KEYCLOAK_ADMIN_PASS="${KEYCLOAK_ADMIN_PASS:-admin}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-15432}"
DB_NAME="${DB_NAME:-civic_os_db}"
DB_USER="${DB_USER:-postgres}"
export PGPASSWORD="${DB_PASS:-securepassword123}"

MARKER="neh-hardening-fixture"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_37="$SCRIPT_DIR/../../examples/neighborhood-hub/init-scripts/37_revoke_public_execute.sql"

ANON_DENIED_TABLES="borrowers training_records tool_reservation_checkouts tool_instances projects project_parcels building_use_rooms"
ANON_PUBLIC_TABLES="parcels tool_types census_block_groups"

HTTP_STATUS=""
HTTP_BODY=""

# =============================================================================
# Helpers
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

section() {
  echo ""
  echo -e "${BOLD}━━━ $1 ━━━${NC}"
}

assert_eq() {
  if [ "$2" = "$3" ]; then
    pass "$1"
  else
    fail "$1" "expected '$2', got '$3'"
  fi
}

# Keycloak tokens carry no role claim, so PostgREST starts every request as the
# anon role and check_jwt switches it. A 42501 denial for a signed-in caller can
# therefore surface as 401, so either code counts.
assert_denied() {
  case "$HTTP_STATUS" in
    401|403) pass "$1 ($HTTP_STATUS)" ;;
    *) fail "$1" "$HTTP_STATUS, $(body_snippet)" ;;
  esac
}

die() {
  echo -e "${RED}$1${NC}" >&2
  exit 2
}

sql() {
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"
}

# Usage: api <method> <path> <token-or-empty> [json-body]
# Sets HTTP_STATUS and HTTP_BODY.
api() {
  local method="$1" path="$2" token="$3" body="${4:-}" raw
  local -a args=(-s -m 20 -X "$method" "$POSTGREST_URL/$path" -H "Content-Type: application/json" -w $'\n%{http_code}')
  if [ -n "$token" ]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  if [ -n "$body" ]; then
    args+=(-d "$body")
  fi
  raw=$(curl "${args[@]}" 2>/dev/null) || true
  HTTP_STATUS="${raw##*$'\n'}"
  HTTP_BODY="${raw%$'\n'*}"
  if [ -z "$HTTP_STATUS" ]; then
    HTTP_STATUS="000"
  fi
}

body_snippet() {
  local s="${HTTP_BODY:0:160}"
  echo "${s//$'\n'/ }"
}

get_token() {
  curl -s -m 15 -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
    -d "client_id=$KEYCLOAK_CLIENT" -d "grant_type=password" \
    -d "username=$1" -d "password=$1" 2>/dev/null | jq -r '.access_token // empty'
}

kc_admin() {
  local method="$1" path="$2" body="${3:-}"
  local -a args=(-s -m 15 -X "$method" "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/$path"
    -H "Authorization: Bearer $KC_ADMIN_TOKEN" -H "Content-Type: application/json")
  if [ -n "$body" ]; then
    args+=(-d "$body")
  fi
  curl "${args[@]}" 2>/dev/null
}

cleanup_rows() {
  sql "
    DELETE FROM metadata.entity_notes WHERE content = '$MARKER';
    DELETE FROM metadata.guided_form_progress WHERE guided_form_key = 'mek_request' AND parent_id IN (SELECT id FROM mek_requests WHERE notes = '$MARKER');
    DELETE FROM mek_checkouts WHERE mek_request_id IN (SELECT id FROM mek_requests WHERE notes = '$MARKER');
    DELETE FROM mek_request_equipment_items WHERE mek_request_equipment_id IN (SELECT e.id FROM mek_request_equipment e JOIN mek_requests r ON r.id = e.mek_request_id WHERE r.notes = '$MARKER');
    DELETE FROM mek_request_equipment WHERE mek_request_id IN (SELECT id FROM mek_requests WHERE notes = '$MARKER');
    DELETE FROM mek_requests WHERE notes = '$MARKER';
    DELETE FROM tool_reservation_checkouts WHERE tool_reservation_id IN (SELECT id FROM tool_reservations WHERE notes = '$MARKER');
    DELETE FROM tool_reservations WHERE notes = '$MARKER';
    DELETE FROM training_records WHERE display_name = '$MARKER';
    DELETE FROM building_use_rooms WHERE display_name = '$MARKER';
    DELETE FROM tool_types WHERE display_name = '$MARKER';
    DELETE FROM parcels WHERE prop_street = '$MARKER';
  " >/dev/null
}

# Reservation as postgres. Usage: new_reservation <borrower-id> <created-by-uuid> <status-key> <hour>
new_reservation() {
  sql "
    INSERT INTO tool_reservations (borrower_id, created_by, notes, timeslot, guided_form_status_id, workflow_status_id)
    VALUES ($1, '$2', '$MARKER',
      tstzrange(now() + interval '$4 days', now() + interval '$4 days 1 hour'),
      (SELECT id FROM metadata.statuses WHERE entity_type = 'guided_form' AND status_key = 'submitted'),
      (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_reservations' AND status_key = '$3'))
    RETURNING id;" | head -1
}

# Event kit request ready to submit, as postgres: one equipment item and progress on every step.
# Usage: new_mek_request <borrower-id> <created-by-uuid>
new_mek_request() {
  local id equipment
  id=$(sql "
    INSERT INTO mek_requests (borrower_id, created_by, notes, event_location, responsibility_acknowledged, timeslot, guided_form_status_id)
    VALUES ($1, '$2', '$MARKER', '$MARKER', true,
      tstzrange(now() + interval '301 days', now() + interval '301 days 1 hour'),
      (SELECT id FROM metadata.statuses WHERE entity_type = 'guided_form' AND status_key = 'complete'))
    RETURNING id;" | head -1)
  equipment=$(sql "INSERT INTO mek_request_equipment (mek_request_id) VALUES ($id) RETURNING id;" | head -1)
  sql "
    INSERT INTO mek_request_equipment_items (mek_request_equipment_id, tool_type_id)
    VALUES ($equipment, (SELECT min(id) FROM tool_types));
    INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at, completed_by)
    SELECT 'mek_request', $id, step_key, now(), '$2'
    FROM metadata.guided_form_steps WHERE guided_form_key = 'mek_request';
  " >/dev/null
  echo "$id"
}

reservation_status() {
  sql "SELECT s.status_key FROM tool_reservations r JOIN metadata.statuses s ON s.id = r.workflow_status_id WHERE r.id = $1;"
}

set_borrower_status() {
  sql "UPDATE borrowers SET status_id = (SELECT id FROM metadata.statuses WHERE entity_type = 'borrowers' AND status_key = '$2') WHERE id = $1;" >/dev/null
}

borrower_status() {
  sql "SELECT s.status_key FROM borrowers b JOIN metadata.statuses s ON s.id = b.status_id WHERE b.id = $1;"
}

# =============================================================================
# Preflight and fixtures
# =============================================================================

section "Preflight"

for cmd in curl jq psql; do
  command -v "$cmd" >/dev/null || die "$cmd is required"
done
[ "$(sql "SELECT to_regclass('public.borrowers') IS NOT NULL;")" = "t" ] \
  || die "public.borrowers not found on $DB_HOST:$DB_PORT: this test needs the neighborhood-hub stack"
[ -f "$SCRIPT_37" ] || die "script 37 not found at $SCRIPT_37"

cleanup_rows
trap cleanup_rows EXIT
pass "database is a neighborhood-hub instance, stale fixtures removed"

section "Fixtures: Keycloak"

KC_ADMIN_TOKEN=$(curl -s -m 15 -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
  -d "client_id=admin-cli" -d "grant_type=password" \
  -d "username=$KEYCLOAK_ADMIN_USER" -d "password=$KEYCLOAK_ADMIN_PASS" 2>/dev/null | jq -r '.access_token // empty')
[ -n "$KC_ADMIN_TOKEN" ] || die "could not get a Keycloak admin token from $KEYCLOAK_URL"

kc_admin POST roles '{"name":"neh_staff"}' >/dev/null
kc_admin POST users '{"username":"testnehstaff","email":"testnehstaff@example.com","firstName":"Test","lastName":"NEH Staff","enabled":true,"emailVerified":true,"credentials":[{"type":"password","value":"testnehstaff","temporary":false}]}' >/dev/null
STAFF_KC_ID=$(kc_admin GET "users?username=testnehstaff&exact=true" | jq -r '.[0].id // empty')
[ -n "$STAFF_KC_ID" ] || die "testnehstaff was not created"
ROLE_REPS=$(jq -n --argjson staff "$(kc_admin GET roles/neh_staff)" --argjson user "$(kc_admin GET roles/user)" '[$staff, $user]')
kc_admin POST "users/$STAFF_KC_ID/role-mappings/realm" "$ROLE_REPS" >/dev/null

T_USER=$(get_token testuser)
T_MANAGER=$(get_token testmanager)
T_EDITOR=$(get_token testeditor)
T_STAFF=$(get_token testnehstaff)
T_ADMIN=$(get_token testadmin)
for pair in "testuser:$T_USER" "testmanager:$T_MANAGER" "testeditor:$T_EDITOR" "testnehstaff:$T_STAFF" "testadmin:$T_ADMIN"; do
  [ -n "${pair#*:}" ] || die "no token for ${pair%%:*}"
done
pass "tokens issued for all five identities"

section "Fixtures: rows"

for t in "$T_USER" "$T_MANAGER" "$T_EDITOR" "$T_STAFF" "$T_ADMIN"; do
  api POST rpc/refresh_current_user "$t" '{}'
done

UID_A=$(echo "$T_USER" | cut -d. -f2 | tr '_-' '/+' | awk '{l=length($0)%4; if(l==2)$0=$0"=="; if(l==3)$0=$0"="; print}' | base64 -d 2>/dev/null | jq -r .sub)
UID_B=$(echo "$T_MANAGER" | cut -d. -f2 | tr '_-' '/+' | awk '{l=length($0)%4; if(l==2)$0=$0"=="; if(l==3)$0=$0"="; print}' | base64 -d 2>/dev/null | jq -r .sub)
BORROWER_A=$(sql "SELECT id FROM borrowers WHERE user_id = '$UID_A';")
BORROWER_B=$(sql "SELECT id FROM borrowers WHERE user_id = '$UID_B';")
[ -n "$BORROWER_A" ] && [ -n "$BORROWER_B" ] || die "the sync trigger did not create borrowers for testuser and testmanager"

set_borrower_status "$BORROWER_A" approved
set_borrower_status "$BORROWER_B" approved

R_A_CHECKOUT=$(new_reservation "$BORROWER_A" "$UID_A" checked_out 201)
R_B_CHECKOUT=$(new_reservation "$BORROWER_B" "$UID_B" checked_out 202)
R_A_PENDING=$(new_reservation "$BORROWER_A" "$UID_A" pending 203)
R_B_PENDING=$(new_reservation "$BORROWER_B" "$UID_B" pending 204)
R_B_PENDING_2=$(new_reservation "$BORROWER_B" "$UID_B" pending 205)

MEK_A=$(new_mek_request "$BORROWER_A" "$UID_A")

CHECKOUT_STATUS="(SELECT id FROM metadata.statuses WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'preparing')"
TRAINING_TYPE="(SELECT id FROM metadata.categories ORDER BY (entity_type ILIKE '%training%') DESC, id LIMIT 1)"
sql "
  INSERT INTO tool_reservation_checkouts (tool_reservation_id, status_id, display_name)
  VALUES ($R_A_CHECKOUT, $CHECKOUT_STATUS, '$MARKER'), ($R_B_CHECKOUT, $CHECKOUT_STATUS, '$MARKER');
  INSERT INTO training_records (display_name, borrower_id, training_type, date_earned)
  VALUES ('$MARKER', $BORROWER_A, $TRAINING_TYPE, CURRENT_DATE), ('$MARKER', $BORROWER_B, $TRAINING_TYPE, CURRENT_DATE);
  INSERT INTO metadata.entity_notes (entity_type, entity_id, content)
  VALUES ('borrowers', '$BORROWER_B', '$MARKER');
" >/dev/null
pass "borrowers A=$BORROWER_A B=$BORROWER_B, with reservations, checkouts, training records and a note"

# =============================================================================
# Anonymous
# =============================================================================

section "Anonymous: tables"

for table in $ANON_DENIED_TABLES; do
  api GET "$table?limit=1" ""
  assert_eq "GET $table is denied" "401" "$HTTP_STATUS"
done

for table in $ANON_PUBLIC_TABLES; do
  api GET "$table?select=id&limit=1" ""
  expected=$(sql "SELECT LEAST(count(*), 1) FROM (SELECT 1 FROM $table LIMIT 1) t;")
  actual=$(echo "$HTTP_BODY" | jq 'if type == "array" then length else -1 end' 2>/dev/null)
  if [ "$HTTP_STATUS" = "200" ] && [ "$actual" = "$expected" ]; then
    pass "GET $table returns public rows ($expected)"
  else
    fail "GET $table returns public rows" "$HTTP_STATUS, $(body_snippet)"
  fi
done

section "Anonymous: RPCs"

api POST rpc/approve_tool_reservation "" '{"p_entity_id": -1}'
assert_eq "approve_tool_reservation is denied" "401" "$HTTP_STATUS"
api POST rpc/confirm_checkout "" '{"p_entity_id": -1}'
assert_eq "confirm_checkout is denied" "401" "$HTTP_STATUS"
api POST rpc/get_approved_borrowers "" '{}'
assert_eq "get_approved_borrowers is denied" "401" "$HTTP_STATUS"
api POST rpc/get_room_options "" '{}'
assert_eq "get_room_options is denied" "401" "$HTTP_STATUS"

# =============================================================================
# Borrower
# =============================================================================

section "Borrower: reads own rows only"

api GET "borrowers?select=id" "$T_USER"
assert_eq "borrowers lists one row, their own" "[$BORROWER_A]" "$(echo "$HTTP_BODY" | jq -c '[.[].id]' 2>/dev/null)"

api GET "training_records?select=borrower_id" "$T_USER"
assert_eq "training_records lists their own" "[$BORROWER_A]" "$(echo "$HTTP_BODY" | jq -c '[.[].borrower_id] | unique' 2>/dev/null)"

# Scoped to the fixtures: testuser may hold checkouts from earlier use of the stack.
api GET "tool_reservation_checkouts?select=tool_reservation_id&tool_reservation_id=in.($R_A_CHECKOUT,$R_B_CHECKOUT)" "$T_USER"
assert_eq "tool_reservation_checkouts lists their own" "[$R_A_CHECKOUT]" "$(echo "$HTTP_BODY" | jq -c '[.[].tool_reservation_id]' 2>/dev/null)"

api GET "entity_notes?entity_type=eq.borrowers&entity_id=eq.$BORROWER_B&select=id" "$T_USER"
assert_eq "notes on another borrower are not visible" "0" "$(echo "$HTTP_BODY" | jq 'length' 2>/dev/null)"

section "Borrower: cannot write"

set_borrower_status "$BORROWER_A" pending
APPROVED_ID=$(sql "SELECT id FROM metadata.statuses WHERE entity_type = 'borrowers' AND status_key = 'approved';")
api PATCH "borrowers?id=eq.$BORROWER_A" "$T_USER" "{\"status_id\": $APPROVED_ID}"
assert_eq "PATCH own status_id leaves it unchanged" "pending" "$(borrower_status "$BORROWER_A")"
set_borrower_status "$BORROWER_A" approved

CATEGORY_ID=$(sql "SELECT category_id FROM tool_types LIMIT 1;")
api POST parcels "$T_USER" "{\"prop_street\": \"$MARKER\"}"
assert_denied "POST parcels is denied"
api POST tool_types "$T_USER" "{\"display_name\": \"$MARKER\", \"category_id\": $CATEGORY_ID}"
assert_denied "POST tool_types is denied"

api GET "schema_entities?table_name=eq.borrowers&select=update" "$T_USER"
assert_eq "schema_entities reports no update on borrowers" "false" "$(echo "$HTTP_BODY" | jq -r '.[0].update' 2>/dev/null)"

section "Borrower: workflow RPC"

api POST rpc/approve_tool_reservation "$T_USER" "{\"p_entity_id\": $R_A_PENDING}"
assert_eq "approve_tool_reservation on their own request leaves it pending" "pending" "$(reservation_status "$R_A_PENDING")"
case "$HTTP_STATUS" in
  2*) fail "approve_tool_reservation on their own request is rejected" "$HTTP_STATUS, $(body_snippet)" ;;
  *) pass "approve_tool_reservation on their own request is rejected ($HTTP_STATUS)" ;;
esac

section "Borrower: event kit submit"

# Holds no mek_requests update permission, so block_submitted_update applies to every write.
MEK_SUBMIT="{\"p_guided_form_key\": \"mek_request\", \"p_parent_id\": $MEK_A}"
api POST rpc/submit_guided_form "$T_USER" "$MEK_SUBMIT"
assert_eq "submit_guided_form on their own event kit request (HTTP)" "200" "$HTTP_STATUS"
assert_eq "event kit request is submitted and pending" "submitted|pending|t" "$(sql "
  SELECT g.status_key, s.status_key, r.submitted_at IS NOT NULL
  FROM mek_requests r
  JOIN metadata.statuses g ON g.id = r.guided_form_status_id
  LEFT JOIN metadata.statuses s ON s.id = r.status_id
  WHERE r.id = $MEK_A;")"
api POST rpc/submit_guided_form "$T_USER" "$MEK_SUBMIT"
case "$HTTP_STATUS" in
  2*) fail "a second submit is rejected by the lock" "$HTTP_STATUS, $(body_snippet)" ;;
  *) pass "a second submit is rejected by the lock ($HTTP_STATUS)" ;;
esac

# =============================================================================
# Editor: table permissions do not pass a role guard
# =============================================================================

section "Editor"

sql "UPDATE tool_reservations SET workflow_status_id = (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_reservations' AND status_key = 'pending') WHERE id = $R_A_PENDING;" >/dev/null
api POST rpc/approve_tool_reservation "$T_EDITOR" "{\"p_entity_id\": $R_A_PENDING}"
assert_eq "approve_tool_reservation leaves the request pending" "pending" "$(reservation_status "$R_A_PENDING")"

# =============================================================================
# Staff
# =============================================================================

section "NEH staff"

BORROWER_COUNT=$(sql "SELECT count(*) FROM borrowers;")
api GET "borrowers?select=id" "$T_STAFF"
assert_eq "borrowers lists all rows" "$BORROWER_COUNT" "$(echo "$HTTP_BODY" | jq 'length' 2>/dev/null)"

set_borrower_status "$BORROWER_B" pending
api PATCH "borrowers?id=eq.$BORROWER_B" "$T_STAFF" "{\"status_id\": $APPROVED_ID}"
assert_eq "PATCH a borrower status takes effect" "approved" "$(borrower_status "$BORROWER_B")"

api POST rpc/approve_tool_reservation "$T_STAFF" "{\"p_entity_id\": $R_B_PENDING}"
assert_eq "approve_tool_reservation on another borrower reports success" "true" "$(echo "$HTTP_BODY" | jq -r '.success' 2>/dev/null)"
assert_eq "the request is approved" "approved" "$(reservation_status "$R_B_PENDING")"

api POST building_use_rooms "$T_STAFF" "{\"display_name\": \"$MARKER\"}"
assert_eq "POST building_use_rooms creates a room" "201" "$HTTP_STATUS"

api GET "schema_entity_actions?table_name=eq.building_use_requests&action_name=eq.approve_request&select=can_execute" "$T_STAFF"
assert_eq "Approve Request is available on building use requests" "true" "$(echo "$HTTP_BODY" | jq -r '.[0].can_execute' 2>/dev/null)"

# =============================================================================
# Admin
# =============================================================================

section "Admin"

api GET "borrowers?select=id" "$T_ADMIN"
assert_eq "borrowers lists all rows" "$BORROWER_COUNT" "$(echo "$HTTP_BODY" | jq 'length' 2>/dev/null)"

api POST rpc/approve_tool_reservation "$T_ADMIN" "{\"p_entity_id\": $R_B_PENDING_2}"
assert_eq "approve_tool_reservation reports success" "true" "$(echo "$HTTP_BODY" | jq -r '.success' 2>/dev/null)"

# =============================================================================
# SQL layer
# =============================================================================

section "SQL"

assert_eq "every public base table has RLS enabled" "" "$(sql "
  SELECT string_agg(c.relname, ', ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
    AND c.relname NOT IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'spatial_ref_sys');")"

for table in $ANON_DENIED_TABLES; do
  assert_eq "web_anon holds no SELECT on $table" "f" "$(sql "SELECT has_table_privilege('web_anon', 'public.$table', 'SELECT');")"
done

# Function targets come from script 37 itself, so the list cannot drift from it.
TARGETS=$(grep -E '^REVOKE EXECUTE ON FUNCTION public\..* FROM PUBLIC' "$SCRIPT_37" \
  | sed -E "s/^REVOKE EXECUTE ON FUNCTION (public\.[^ ]*(\([^)]*\))).*/'\1'/" | paste -sd, -)
assert_eq "no PUBLIC EXECUTE on any target of script 37" "" "$(sql "
  SELECT string_agg(p.proname, ', ') FROM pg_proc p
  WHERE p.oid = ANY (ARRAY[$TARGETS]::regprocedure[])
    AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0);")"
assert_eq "no PUBLIC or web_anon EXECUTE on the borrower and room options" "" "$(sql "
  SELECT string_agg(p.proname, ', ') FROM pg_proc p
  WHERE p.oid IN ('public.get_approved_borrowers(text, jsonb)'::regprocedure, 'public.get_room_options(text, jsonb)'::regprocedure)
    AND has_function_privilege('web_anon', p.oid, 'EXECUTE');")"

assert_eq "authenticated can use borrowers_id_seq" "t" "$(sql "SELECT has_sequence_privilege('authenticated', 'public.borrowers_id_seq', 'USAGE');")"

for pair in borrowers.status_id borrowers.photo_id borrowers.address_proof borrowers.liability_waiver \
            building_use_requests.group_type tool_reservation_checkouts.checkout_photos tool_reservation_checkouts.return_photos; do
  assert_eq "index leads with $pair" "t" "$(sql "
    SELECT EXISTS (
      SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = 'public.${pair%%.*}'::regclass AND a.attname = '${pair##*.}');")"
done

for table in tool_reservations mek_requests; do
  assert_eq "$table has the timeslot wfcheck" "t" "$(sql "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_timeslot_required_wfcheck');")"
done

assert_eq "Approve Request has three roles" "admin,neh_admin,neh_staff" "$(sql "
  SELECT string_agg(r.role_key, ',' ORDER BY r.role_key)
  FROM metadata.entity_action_roles ear
  JOIN metadata.entity_actions ea ON ea.id = ear.entity_action_id
  JOIN metadata.roles r ON r.id = ear.role_id
  WHERE ea.table_name = 'building_use_requests' AND ea.action_name = 'approve_request';")"

assert_eq "no numeric status value remains in action conditions" "0" "$(sql "
  SELECT count(*) FROM metadata.entity_actions
  WHERE COALESCE(visibility_condition::text, '') ~ '\"value\": *\\[?[0-9]'
     OR COALESCE(enabled_condition::text, '') ~ '\"value\": *\\[?[0-9]';")"

SUBMITTED="(SELECT id FROM metadata.statuses WHERE entity_type = 'guided_form' AND status_key = 'submitted')"
out=$(sql "BEGIN; INSERT INTO tool_reservations (borrower_id, created_by, notes, guided_form_status_id) VALUES ($BORROWER_A, '$UID_A', '$MARKER', $SUBMITTED); ROLLBACK;" 2>&1)
case "$out" in
  *tool_reservations_timeslot_required_wfcheck*) pass "a submitted tool reservation without a timeslot is rejected" ;;
  *) fail "a submitted tool reservation without a timeslot is rejected" "${out:0:160}" ;;
esac
out=$(sql "BEGIN; INSERT INTO mek_requests (borrower_id, created_by, guided_form_status_id, responsibility_acknowledged) VALUES ($BORROWER_A, '$UID_A', $SUBMITTED, true); ROLLBACK;" 2>&1)
case "$out" in
  *mek_requests_timeslot_required_wfcheck*) pass "a submitted event kit request without a timeslot is rejected" ;;
  *) fail "a submitted event kit request without a timeslot is rejected" "${out:0:160}" ;;
esac

# =============================================================================
# Summary
# =============================================================================

echo ""
echo -e "${BOLD}Passed: $PASS, Failed: $FAIL${NC}"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
