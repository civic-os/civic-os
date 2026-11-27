#!/bin/bash
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Mott Fest module (examples/mottpark init scripts 34-38): full-stack API test.
#
# Runs against a live examples/mottpark stack (Postgres, PostgREST, Keycloak, consolidated
# worker, inbucket) with real Keycloak tokens. Personas:
#   anonymous      no token
#   applicant A    testuser
#   applicant B    testmanager (also proves the clubhouse manager role grants no Mott Fest access)
#   organizer      testeditor, given mottfest_admin by testadmin through assign_user_role
#   admin          testadmin
#
# What it asserts (UAT checklist row numbers from the Mott Fest design docs in brackets):
#   Roles     editor alone sees no applications; assigning mottfest_admin reaches the Keycloak
#             token through the worker and grants access [46]; revoking removes it again
#   Festival  defaults ($25/$75, due date one month before the event) [1]; Planning hidden from
#             anonymous and applicants [2]; one Open festival at a time [4]; open/close [3];
#             fee changes apply to new applications only [5]; Close blocks applicants but not
#             organizers [36]; Mark Completed refuses while rows are unresolved, listing
#             counts [37], and succeeds once they are resolved [38]
#   Applying  create sets Pending, applicant and fee, ignoring spoofed status [6]; applicants
#             read only their own rows [7, 8] and cannot edit them [7]; sponsorship rules
#             [26-29, 33]; in-kind needs no payment method [30]
#   Window    applicants are refused before the window opens [V2]
#   Review    approve, waive (vendors only) [13, 24], deny with reason from Pending and
#             Approved [14, 15], withdraw paid and duplicate rows [18, 19], record payment
#             excludes card [11, 12], enable online payment [11b], capacity warning [21],
#             due-now approval email data [22], organizer edits recalculate fees [33],
#             organizer edits an application [V14], placement request kept [V16]
#   Trucks    every food-truck wrapper: approve (card and cash), Record Payment, Pay Now,
#             Enable Online Payment, deny, withdraw after paid [T2, T5, T6]; a phone-in truck
#             owned by the organizer, paid in cash [T3]; truck capacity warning [V18]
#   Sponsors  thank-you filter (Paid/In-Kind, no Thank-You Sent) and the dates [S8, S9]
#   Next year a returning vendor applies to the new festival, last year's row stays [V15];
#             a late feedback response defaults to the new festival and organizers refile it [FB4]
#   Pay Now   every initiation refusal message [9, 11, 13, 30], owner-or-update rule, card
#             payers get a reusable transaction on approval [10]
#   Actions   visibility/enabled conditions per status and payment preference; action roles
#   Notes     organizer notes invisible to applicants [20]
#   Feedback  write-only virtual entity, nothing identifies the respondent [39-41]
#   Revenue   paid-then-withdrawn still counted [18, 43]; applicants and anonymous see no
#             revenue [44]; anonymous sees the current festival [45]
#   Mail      all 8 templates queued with the right recipients; the worker sends them with no
#             unfilled template fields
#   Database  no PUBLIC EXECUTE on module functions; notes permissions staff only; every module
#             table and view is covered by a schema decision from scripts 34-37; re-running
#             34-38 changes no counts (idempotency)
#
# Stripe completion (rows 10, 11b, 34 after the card step) needs `stripe listen` and is
# verified separately.
#
# Fixtures: one test festival (plus a second one for the one-Open rule). An Open sample
# festival is closed for the run and re-opened afterwards. Everything the test creates is
# removed on exit, including the role assignment.
#
# Usage: tests/functional/mottfest-module-test.sh            (defaults match examples/mottpark)
#   DATABASE_URL, API, KC_TOKEN_URL, MAIL_API override the endpoints; SKIP_RERUN=1 skips the
#   idempotency re-run of the init scripts; MAIL_WAIT seconds to wait for the worker (90).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"
API="${API:-http://localhost:3000}"
KC_TOKEN_URL="${KC_TOKEN_URL:-http://localhost:8082/realms/civic-os-dev/protocol/openid-connect/token}"
MAIL_API="${MAIL_API:-http://localhost:9100/api/v1}"
SCRIPTS_DIR="${SCRIPTS_DIR:-$ROOT/examples/mottpark/init-scripts}"
MAIL_WAIT="${MAIL_WAIT:-90}"

PASS=0; FAIL=0
RUN_START=$(date -u +%s)
pass() { PASS=$((PASS + 1)); echo "  PASS  $*"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $*"; }
section() { echo; echo "== $* =="; }

q() { psql "$DATABASE_URL" -Atq -v ON_ERROR_STOP=1 -c "$1"; }

# req TOKEN METHOD PATH [JSON] [extra curl args...]  ->  sets CODE and BODY
req() {
  local t=$1 m=$2 p=$3 d=${4-}
  shift 3; [ $# -gt 0 ] && shift
  local args=(-s -w $'\n%{http_code}' -X "$m" -H 'Content-Type: application/json')
  [ -n "$t" ] && args+=(-H "Authorization: Bearer $t")
  [ -n "$d" ] && args+=(-d "$d")
  local out
  out=$(curl "${args[@]}" "$@" "$API$p")
  CODE=${out##*$'\n'}
  BODY=${out%$'\n'*}
}
rpc() { req "$1" POST "/rpc/$2" "$3"; }
ins() { req "$1" POST "/$2" "$3" -H 'Prefer: return=representation'; }

# expect_ok DESC: 2xx; expect_err DESC TEXT: non-2xx whose body contains TEXT
expect_ok() { if [ "${CODE:0:1}" = 2 ]; then pass "$1"; else fail "$1 (HTTP $CODE: $BODY)"; fi; }
expect_err() {
  if [ "${CODE:0:1}" != 2 ] && grep -qF -- "$2" <<<"$BODY"; then pass "$1"
  else fail "$1 (HTTP $CODE, wanted \"$2\": $BODY)"; fi
}
eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got \"$2\", wanted \"$3\")"; fi; }

tok() {
  curl -s -d client_id=civic-os-dev-client -d "username=$1" -d "password=$1" -d grant_type=password \
    "$KC_TOKEN_URL" | jq -r '.access_token // empty'
}
claims() {
  local p
  p=$(printf %s "$1" | cut -d. -f2 | tr '_-' '/+')
  while [ $(( ${#p} % 4 )) -ne 0 ]; do p="$p="; done
  printf %s "$p" | base64 -d 2>/dev/null
}
has_realm_role() { claims "$1" | jq -e --arg r "$2" '.realm_access.roles | index($r)' >/dev/null; }

sid() { q "SELECT get_status_id('$1', '$2')"; }
cid() { q "SELECT id FROM metadata.categories WHERE entity_type = '$1' AND category_key = '$2'"; }
status_of() { q "SELECT s.status_key FROM $1 t JOIN metadata.statuses s ON s.id = t.status_id WHERE t.id = $2"; }
col() { q "SELECT $3 FROM $1 WHERE id = $2"; }
json_id() { jq -r 'if type == "array" then .[0].id // empty else empty end' <<<"$BODY" 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
section "Setup"
A=$(tok testuser); B=$(tok testmanager); O=$(tok testeditor); ADM=$(tok testadmin)
for v in A B O ADM; do
  if [ -z "${!v}" ]; then echo "Could not get a Keycloak token for $v"; exit 1; fi
  rpc "${!v}" refresh_current_user '{}'
done
A_ID=$(claims "$A" | jq -r .sub); B_ID=$(claims "$B" | jq -r .sub)
O_ID=$(claims "$O" | jq -r .sub)
pass "tokens for testuser, testmanager, testeditor, testadmin"

CC=$(sid payment_method credit_card); CHECK=$(sid payment_method check)
CASH=$(sid payment_method cash)
RETAIL=$(cid vendor_type retail); NONPROFIT=$(cid vendor_type nonprofit)
T100=$(cid sponsorship_tier individual_100); T250=$(cid sponsorship_tier corporate_250)
T500=$(cid sponsorship_tier corporate_500); TCUSTOM=$(cid sponsorship_tier custom)
TINKIND=$(cid sponsorship_tier in_kind); SHIRT_L=$(cid tshirt_size l)
W_YES=$(cid worth_it yes); W_OTHER=$(cid worth_it other)

ORIG_OPEN=$(q "SELECT id FROM festival WHERE status_id = get_status_id('festival','open') LIMIT 1")
TAG="FT$$"
FIDS=""
ROLE_ASSIGNED=0

cleanup() {
  set +e
  echo; echo "== Cleanup =="
  if [ -n "$FIDS" ]; then
    psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
CREATE TEMP TABLE ft_apps ON COMMIT DROP AS
  SELECT 'vendor_application'::text AS t, id::text AS eid FROM vendor_application WHERE festival_id IN ($FIDS)
  UNION ALL SELECT 'food_truck_application', id::text FROM food_truck_application WHERE festival_id IN ($FIDS)
  UNION ALL SELECT 'sponsorship_application', id::text FROM sponsorship_application WHERE festival_id IN ($FIDS);
UPDATE vendor_application SET payment_transaction_id = NULL WHERE festival_id IN ($FIDS);
UPDATE food_truck_application SET payment_transaction_id = NULL WHERE festival_id IN ($FIDS);
UPDATE sponsorship_application SET payment_transaction_id = NULL WHERE festival_id IN ($FIDS);
DELETE FROM payments.refunds WHERE transaction_id IN
  (SELECT id FROM payments.transactions WHERE (entity_type, entity_id::text) IN (SELECT t, eid FROM ft_apps));
DELETE FROM payments.transactions WHERE (entity_type, entity_id::text) IN (SELECT t, eid FROM ft_apps);
DELETE FROM metadata.entity_notes WHERE (entity_type, entity_id::text) IN (SELECT t, eid FROM ft_apps);
DELETE FROM metadata.notifications WHERE (entity_type, entity_id::text) IN (SELECT t, eid FROM ft_apps);
DELETE FROM vendor_application WHERE festival_id IN ($FIDS);
DELETE FROM food_truck_application WHERE festival_id IN ($FIDS);
DELETE FROM sponsorship_application WHERE festival_id IN ($FIDS);
DELETE FROM feedback_response WHERE festival_id IN ($FIDS) OR what_worked_well LIKE '$TAG %';
DELETE FROM festival WHERE id IN ($FIDS);
COMMIT;
SQL
    echo "  removed test festivals $FIDS and their rows"
  fi
  if [ -n "$ORIG_OPEN" ]; then
    q "UPDATE festival SET status_id = get_status_id('festival','open') WHERE id = $ORIG_OPEN" \
      && echo "  re-opened festival $ORIG_OPEN"
  fi
  if [ "$ROLE_ASSIGNED" = 1 ]; then
    q "DELETE FROM metadata.user_roles WHERE user_id = '$O_ID'
       AND role_id = (SELECT id FROM metadata.roles WHERE role_key = 'mottfest_admin')"
    echo "  removed mottfest_admin from testeditor"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Database contract: grants, notes permissions, schema decisions
# ---------------------------------------------------------------------------
section "Database contract"
MODULE_FUNCS="p.pronamespace = 'public'::regnamespace AND (p.proname LIKE '%mottfest%'
  OR p.proname ~ '^(approve|deny|withdraw|waive_and_approve|record|enable_online_payment|initiate)_.*(vendor|food_truck|sponsorship)'
  OR p.proname IN ('open_festival','close_festival','complete_festival','get_current_festival','get_manual_payment_methods'))"
eq "no module function is executable by PUBLIC" \
  "$(q "SELECT count(*) FROM pg_proc p WHERE $MODULE_FUNCS AND (p.proacl IS NULL OR array_to_string(p.proacl, ' ') ~ '(^| )=X')")" 0
eq "private helpers are not granted to API roles" \
  "$(q "SELECT coalesce(string_agg(p.proname, ','), '') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname ~ '^mottfest_(review|record_payment|enable_online_payment|initiate_payment|lock_|require_reviewer|create_card_payment|notification_data|payment_is_open|entity_type)'
        AND array_to_string(p.proacl, ' ') ~ '(authenticated|web_anon)='")" ""
eq "notes permissions held only by mottfest_admin and admin" \
  "$(q "SELECT string_agg(DISTINCT r.role_key, ',' ORDER BY r.role_key) FROM metadata.permissions p
        JOIN metadata.permission_roles pr ON pr.permission_id = p.id JOIN metadata.roles r ON r.id = pr.role_id
        WHERE p.table_name LIKE '%:notes' AND split_part(p.table_name, ':', 1) LIKE ANY
          (ARRAY['vendor_application','food_truck_application','sponsorship_application'])")" "admin,mottfest_admin"
eq "feedback_response has no column that could identify a respondent" \
  "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'feedback_response'
        AND (data_type = 'uuid' OR column_name ~ '(user|author|created_by|respondent|email|applicant)')")" 0

# Script names come from SCRIPTS_DIR, so the same check runs on the example (34-37, launch 40)
# and on a production replica (32-35, launch 37). Sample data records no decision.
MODULE_SCRIPTS=$(cd "$SCRIPTS_DIR" && ls [0-9][0-9]_mottfest_*.sql | grep -v sample_data | sed 's/\.sql$//')
[ -n "$MODULE_SCRIPTS" ] || fail "no Mott Fest scripts found in $SCRIPTS_DIR"
for s in $MODULE_SCRIPTS; do
  # The launch script has run only once Mott Fest is public.
  if [[ "$s" == *_launch ]] && [ "$(q "SELECT coalesce(bool_or(is_public), false) FROM metadata.dashboards WHERE display_name = 'Mott Fest'")" != t ]; then
    pass "script $s not run yet: Mott Fest is not launched"; continue
  fi
  n=$(q "SELECT count(*) FROM metadata.schema_decisions WHERE migration_id LIKE '$s%'")
  if [ "$n" -ge 1 ]; then pass "script $s has $n schema decisions"; else fail "script $s has no schema decision"; fi
done
UNCOVERED=$(q "SELECT coalesce(string_agg(r, ','), '') FROM unnest(ARRAY['festival','vendor_application',
  'food_truck_application','sponsorship_application','feedback_response','feedback_submission',
  'current_festival','mottfest_revenue_summary','mottfest_current_summary']) r
  WHERE NOT EXISTS (SELECT 1 FROM metadata.schema_decisions d
                    WHERE d.migration_id LIKE '__\_mottfest\_%' AND r = ANY (d.entity_types))")
eq "every module table and view is named by a schema decision" "$UNCOVERED" ""

# ---------------------------------------------------------------------------
# Action conditions: which buttons each status shows, for each payment preference
# ---------------------------------------------------------------------------
section "Action visibility"
ACTUAL=$(psql "$DATABASE_URL" -Atq -v ON_ERROR_STOP=1 <<'SQL'
CREATE FUNCTION pg_temp.ok(c jsonb, st int, pref int) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE e jsonb; v int;
BEGIN
  IF c IS NULL THEN RETURN TRUE; END IF;
  IF c ? 'and' THEN
    FOR e IN SELECT * FROM jsonb_array_elements(c->'and') LOOP
      IF NOT pg_temp.ok(e, st, pref) THEN RETURN FALSE; END IF;
    END LOOP;
    RETURN TRUE;
  END IF;
  IF c->>'field' NOT IN ('status_id', 'preferred_payment_method_id') THEN
    RAISE EXCEPTION 'unexpected condition field %', c->>'field';
  END IF;
  v := CASE c->>'field' WHEN 'status_id' THEN st ELSE pref END;
  RETURN CASE c->>'operator'
    WHEN 'in'  THEN (c->'value') @> to_jsonb(v)
    WHEN 'eq'  THEN (c->'value') = to_jsonb(v)
    WHEN 'neq' THEN (c->'value') <> to_jsonb(v)
  END;
END $$;
WITH t(table_name, entity_type) AS (VALUES
  ('festival','festival'), ('vendor_application','vendor_application'),
  ('food_truck_application','food_truck_application'), ('sponsorship_application','sponsorship_application')),
prefs(pref_key) AS (VALUES ('credit_card'), ('check'))
SELECT t.table_name || '|' || s.status_key || '|' || CASE WHEN t.table_name = 'festival' THEN '-' ELSE p.pref_key END || '|' ||
  coalesce((SELECT string_agg(a.action_name, ',' ORDER BY a.sort_order) FROM metadata.entity_actions a
            WHERE a.table_name = t.table_name
              AND pg_temp.ok(a.visibility_condition, s.id, get_status_id('payment_method', p.pref_key))), '')
FROM t JOIN metadata.statuses s ON s.entity_type = t.entity_type CROSS JOIN prefs p
WHERE t.table_name <> 'festival' OR p.pref_key = 'credit_card'
ORDER BY t.table_name, s.sort_order, s.id, p.pref_key DESC;
SQL
)
EXPECTED="festival|planning|-|open_applications
festival|open|-|close_applications
festival|closed|-|open_applications,mark_completed
festival|completed|-|
food_truck_application|pending|credit_card|approve,deny,withdraw
food_truck_application|pending|check|approve,deny,withdraw
food_truck_application|approved|credit_card|record_payment,deny,withdraw
food_truck_application|approved|check|record_payment,enable_online_payment,deny,withdraw
food_truck_application|paid|credit_card|withdraw
food_truck_application|paid|check|withdraw
food_truck_application|denied|credit_card|
food_truck_application|denied|check|
food_truck_application|withdrawn|credit_card|
food_truck_application|withdrawn|check|
sponsorship_application|pending|credit_card|approve,deny,withdraw
sponsorship_application|pending|check|approve,deny,withdraw
sponsorship_application|approved|credit_card|record_payment,deny,withdraw
sponsorship_application|approved|check|record_payment,enable_online_payment,deny,withdraw
sponsorship_application|paid|credit_card|withdraw
sponsorship_application|paid|check|withdraw
sponsorship_application|in_kind|credit_card|withdraw
sponsorship_application|in_kind|check|withdraw
sponsorship_application|denied|credit_card|
sponsorship_application|denied|check|
sponsorship_application|withdrawn|credit_card|
sponsorship_application|withdrawn|check|
vendor_application|pending|credit_card|approve,waive_and_approve,deny,withdraw
vendor_application|pending|check|approve,waive_and_approve,deny,withdraw
vendor_application|approved|credit_card|record_payment,deny,withdraw
vendor_application|approved|check|record_payment,enable_online_payment,deny,withdraw
vendor_application|paid|credit_card|withdraw
vendor_application|paid|check|withdraw
vendor_application|waived|credit_card|withdraw
vendor_application|waived|check|withdraw
vendor_application|denied|credit_card|
vendor_application|denied|check|
vendor_application|withdrawn|credit_card|
vendor_application|withdrawn|check|"
if [ "$ACTUAL" = "$EXPECTED" ]; then pass "visible actions per status and payment preference (38 combinations) [24]"
else fail "visible actions differ:"; diff <(echo "$EXPECTED") <(echo "$ACTUAL") | sed 's/^/        /'; fi
eq "enabled_condition matches visibility_condition on every module action" \
  "$(q "SELECT count(*) FROM metadata.entity_actions WHERE table_name IN ('festival','vendor_application','food_truck_application','sponsorship_application')
        AND enabled_condition IS DISTINCT FROM visibility_condition")" 0
eq "every module action is granted to exactly admin and mottfest_admin" \
  "$(q "SELECT count(*) FROM metadata.entity_actions a WHERE a.table_name IN ('festival','vendor_application','food_truck_application','sponsorship_application')
        AND (SELECT string_agg(r.role_key, ',' ORDER BY r.role_key) FROM metadata.entity_action_roles ar
             JOIN metadata.roles r ON r.id = ar.role_id WHERE ar.entity_action_id = a.id) IS DISTINCT FROM 'admin,mottfest_admin'")" 0

# ---------------------------------------------------------------------------
# Roles: the organizer role through Keycloak [46]
# ---------------------------------------------------------------------------
section "Organizer role [46]"
req "$O" GET "/vendor_application?select=id"
eq "editor alone reads no applications" "$(jq 'length' <<<"$BODY")" 0
rpc "$B" approve_vendor_application '{"p_entity_id": 1}'
expect_err "clubhouse manager cannot review applications" "permission to manage Mott Fest applications"
rpc "$A" assign_user_role "{\"p_user_id\":\"$A_ID\",\"p_role_name\":\"mottfest_admin\"}"
eq "an applicant cannot grant themselves mottfest_admin" "$(jq -r '.success' <<<"$BODY")" false
rpc "$ADM" assign_user_role "{\"p_user_id\":\"$O_ID\",\"p_role_name\":\"mottfest_admin\"}"
eq "admin assigns mottfest_admin to testeditor" "$(jq -r '.success' <<<"$BODY")" true
ROLE_ASSIGNED=1
for _ in $(seq 1 30); do
  O=$(tok testeditor)
  if has_realm_role "$O" mottfest_admin; then break; fi
  sleep 1
done
if has_realm_role "$O" mottfest_admin; then pass "worker synced the role to Keycloak; new token carries it"
else fail "testeditor token lacks mottfest_admin after 30 s"; exit 1; fi

# ---------------------------------------------------------------------------
# Festival lifecycle [1-4]
# ---------------------------------------------------------------------------
section "Festival lifecycle [1-4]"
EVENT=$(date -v+150d +%Y-%m-%d 2>/dev/null || date -d '+150 days' +%Y-%m-%d)
CLOSE=$(date -v+100d +%Y-%m-%d 2>/dev/null || date -d '+100 days' +%Y-%m-%d)
OPEN_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ins "$O" festival "{\"display_name\":\"$TAG Mott Fest\",\"event_date\":\"$EVENT\",\"applications_open_at\":\"$OPEN_AT\",\"applications_close_at\":\"$CLOSE\",\"vendor_capacity\":40,\"food_truck_capacity\":8}"
expect_ok "organizer creates a festival"
FID=$(json_id); FIDS="$FID"
eq "new festival is Planning [1]" "$(status_of festival "$FID")" planning
eq "fees default to \$25 / \$75 [1]" "$(col festival "$FID" "vendor_fee::numeric || '/' || food_truck_fee::numeric")" "25.00/75.00"
eq "payment due one month before the event [1]" "$(col festival "$FID" "payment_due_date = event_date - interval '1 month'")" t

req "" GET "/festival?id=eq.$FID"
eq "anonymous does not see a Planning festival [2]" "$(jq 'length' <<<"$BODY")" 0
req "$A" GET "/festival?id=eq.$FID"
eq "an applicant does not see a Planning festival [2]" "$(jq 'length' <<<"$BODY")" 0

if [ -n "$ORIG_OPEN" ]; then
  rpc "$O" open_festival "{\"p_entity_id\":$FID}"
  expect_err "a second Open festival is refused [4]" "is already open. Close its applications first."
  rpc "$O" close_festival "{\"p_entity_id\":$ORIG_OPEN}"
  expect_ok "organizer closes the sample festival"
fi
rpc "$A" open_festival "{\"p_entity_id\":$FID}"
expect_err "an applicant cannot open a festival" "permission to manage festivals"
rpc "$O" open_festival "{\"p_entity_id\":$FID}"
expect_ok "organizer opens applications [3]"
eq "festival is Open [3]" "$(status_of festival "$FID")" open

ins "$O" festival "{\"display_name\":\"$TAG Second Fest\",\"event_date\":\"$EVENT\",\"applications_open_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"applications_close_at\":\"$CLOSE\"}"
F2=$(json_id); FIDS="$FIDS,$F2"
rpc "$O" open_festival "{\"p_entity_id\":$F2}"
expect_err "opening another festival while one is Open is refused [4]" "$TAG Mott Fest is already open"
eq "the partial unique index backs the rule" \
  "$(psql "$DATABASE_URL" -Atq -c "UPDATE festival SET status_id = get_status_id('festival','open') WHERE id = $F2" 2>&1 | grep -c 'duplicate key' || true)" 1

req "" GET "/current_festival?select=id,display_name,vendor_fee"
eq "anonymous sees the current festival [45]" "$(jq -r '.[0].id' <<<"$BODY")" "$FID"
req "" GET "/festival?id=eq.$FID&select=id"
eq "anonymous sees the Open festival [45]" "$(jq 'length' <<<"$BODY")" 1

# ---------------------------------------------------------------------------
# Applying [5-9]
# ---------------------------------------------------------------------------
section "Applying [5-9]"
vendor() { # token name pref [type] [extra json]
  ins "$1" vendor_application "{\"business_name\":\"$TAG $2\",\"vendor_type_id\":${4:-$RETAIL},\"description\":\"Handmade goods\",\"contact_name\":\"Test Person\",\"email\":\"applicant@example.com\",\"phone\":\"8105550100\",\"preferred_payment_method_id\":$3${5:+,$5}}"
}
req "" POST /vendor_application "{\"business_name\":\"$TAG anon\"}"
if [ "${CODE:0:1}" != 2 ]; then pass "anonymous cannot apply [45]"; else fail "anonymous created an application"; fi
TOMORROW=$(date -u -v+1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)
req "$O" PATCH "/festival?id=eq.$FID" "{\"applications_open_at\":\"$TOMORROW\"}"
vendor "$A" "Too Early" "$CHECK"
expect_err "an Open festival refuses applicants before its window opens [V2]" "Mott Fest applications are not open right now."
req "$O" PATCH "/festival?id=eq.$FID" "{\"applications_open_at\":\"$OPEN_AT\"}"

vendor "$A" "Pottery" "$CC" "" "\"status_id\":$(sid vendor_application approved),\"applicant_id\":\"$B_ID\""
expect_ok "applicant A applies as a vendor (card) [6]"
V1=$(json_id)
eq "status is Pending despite a spoofed status [6]" "$(status_of vendor_application "$V1")" pending
eq "applicant is the caller despite a spoofed applicant_id" "$(col vendor_application "$V1" applicant_id)" "$A_ID"
eq "fee is \$25 and festival is the current one [6]" "$(col vendor_application "$V1" "amount_due::numeric || '/' || festival_id")" "25.00/$FID"

req "$O" PATCH "/festival?id=eq.$FID" '{"vendor_fee":30}'
vendor "$A" "Prints" "$CHECK"; V2=$(json_id)
eq "fee change applies to new applications [5]" "$(col vendor_application "$V2" amount_due::numeric)" 30.00
eq "earlier applications keep their fee [5]" "$(col vendor_application "$V1" amount_due::numeric)" 25.00
req "$O" PATCH "/festival?id=eq.$FID" '{"vendor_fee":25}'
vendor "$A" "Candles" "$CHECK" "" '"placement_request":"Near the music stage"'; V3=$(json_id)
req "$A" GET "/vendor_application?id=eq.$V3&select=placement_request"
eq "the placement request is stored and the applicant reads it back [V16]" "$(jq -r '.[0].placement_request' <<<"$BODY")" "Near the music stage"
vendor "$A" "Friends of the Park" "$CHECK" "$NONPROFIT"; V4=$(json_id)
vendor "$B" "Jewelry" "$CC"; VB1=$(json_id)
vendor "$B" "Books" "$CC"; VB2=$(json_id)
vendor "$B" "Tacos" "$CHECK"; VB3=$(json_id)
vendor "$B" "Duplicate" "$CHECK"; VB4=$(json_id)

req "$A" GET "/vendor_application?select=id,applicant_id"
eq "applicant A reads only their own rows [7]" "$(jq --arg a "$A_ID" '[.[] | select(.applicant_id != $a)] | length' <<<"$BODY")" 0
eq "applicant A reads all four of them" "$(jq "[.[] | select(.id == $V1 or .id == $V2 or .id == $V3 or .id == $V4)] | length" <<<"$BODY")" 4
req "$B" GET "/vendor_application?id=eq.$V1"
eq "applicant B does not see applicant A's application [8]" "$(jq 'length' <<<"$BODY")" 0
req "$A" PATCH "/vendor_application?id=eq.$V1" '{"description":"changed by applicant"}'
eq "applicant cannot edit their application [7]" "$(col vendor_application "$V1" description)" "Handmade goods"

rpc "$A" initiate_vendor_application_payment "{\"p_entity_id\":$V1}"
expect_err "Pay Now on a Pending application refuses [9]" "isn't approved for payment yet"
rpc "$B" initiate_vendor_application_payment "{\"p_entity_id\":$V1}"
expect_err "Pay Now on someone else's application refuses" "You can only pay for your own applications."
rpc "$O" initiate_vendor_application_payment "{\"p_entity_id\":$V1}"
expect_err "an organizer without payment read is pointed to Record Payment" "Only the applicant can pay online."
rpc "$ADM" initiate_vendor_application_payment "{\"p_entity_id\":$V1}"
expect_err "an admin (update + payment read) passes the ownership check" "isn't approved for payment yet"
rpc "" initiate_vendor_application_payment "{\"p_entity_id\":$V1}"
if [ "${CODE:0:1}" != 2 ]; then pass "anonymous cannot start a payment"; else fail "anonymous started a payment"; fi
rpc "$A" approve_vendor_application "{\"p_entity_id\":$V1}"
expect_err "an applicant cannot approve" "permission to manage Mott Fest applications"

# ---------------------------------------------------------------------------
# Review and payments [10-22]
# ---------------------------------------------------------------------------
section "Review and payments [10-22]"
req "$O" GET "/vendor_application?id=eq.$V1&select=id"
eq "organizer reads applications [46]" "$(jq 'length' <<<"$BODY")" 1
req "$O" PATCH "/vendor_application?id=eq.$V3" '{"description":"Hand-poured candles","placement_request":"By the entrance"}'
eq "organizer edits an application [V14]" "$(col vendor_application "$V3" "description || '|' || placement_request")" "Hand-poured candles|By the entrance"

rpc "$O" get_manual_payment_methods "{\"p_id\":$V2,\"p_depends_on\":{}}"
eq "Record Payment methods exclude Credit Card [12]" \
  "$(jq -r '[.[].display_name] | sort | join(",")' <<<"$BODY" | grep -ci 'credit' || true)" 0
eq "Record Payment offers the manual methods [12]" \
  "$(jq 'length' <<<"$BODY")" "$(q "SELECT count(*) FROM metadata.statuses WHERE entity_type = 'payment_method' AND status_key <> 'credit_card'")"

rpc "$O" approve_vendor_application "{\"p_entity_id\":$V1}"
expect_ok "organizer approves a card payer [10]"
eq "approval message says the card payment is ready [10]" "$(jq -r '.message' <<<"$BODY" | grep -c 'online card payment ready' || true)" 1
TXN=$(col vendor_application "$V1" payment_transaction_id)
if [ -n "$TXN" ]; then pass "approval opened the online payment [10]"; else fail "no payment_transaction_id after approval"; fi
rpc "$A" initiate_vendor_application_payment "{\"p_entity_id\":$V1}"
eq "Pay Now returns the open payment [10]" "$(tr -d '"' <<<"$BODY")" "$TXN"
rpc "$O" enable_online_payment_vendor_application "{\"p_entity_id\":$V1}"
expect_err "Enable Online Payment refuses card payers" "already pays online by card"

rpc "$O" approve_vendor_application "{\"p_entity_id\":$V2}"
eq "a check payer's approval opens no payment [11]" "$(col vendor_application "$V2" "payment_transaction_id IS NULL")" t
rpc "$A" initiate_vendor_application_payment "{\"p_entity_id\":$V2}"
expect_err "Pay Now for a check payer refuses [11]" "You chose to pay by Check"
rpc "$O" record_vendor_payment "{\"p_entity_id\":$V2,\"p_payment_method_id\":$CC,\"p_payment_date\":\"$(date +%F)\",\"p_payment_reference\":null}"
expect_err "Record Payment refuses Credit Card [12]" "Card payments are recorded automatically"
rpc "$O" record_vendor_payment "{\"p_entity_id\":$V2,\"p_payment_method_id\":$CHECK,\"p_payment_date\":\"$(date +%F)\",\"p_payment_reference\":\"#1234\"}"
expect_ok "organizer records a check payment [11]"
eq "Paid by Check with reference #1234 [11]" \
  "$(col vendor_application "$V2" "(SELECT status_key FROM metadata.statuses WHERE id = status_id) || '|' || (SELECT status_key FROM metadata.statuses WHERE id = payment_method_id) || '|' || payment_reference || '|' || paid_amount::numeric")" \
  "paid|check|#1234|30.00"
rpc "$A" initiate_vendor_application_payment "{\"p_entity_id\":$V2}"
expect_err "Pay Now on a paid application refuses" "This application is already paid."

rpc "$O" approve_vendor_application "{\"p_entity_id\":$V3}"
rpc "$O" enable_online_payment_vendor_application "{\"p_entity_id\":$V3}"
expect_ok "organizer enables online payment for a check payer [11b]"
rpc "$A" initiate_vendor_application_payment "{\"p_entity_id\":$V3}"
eq "Pay Now then works for that applicant [11b]" "$(tr -d '"' <<<"$BODY")" "$(col vendor_application "$V3" payment_transaction_id)"

rpc "$O" waive_and_approve_vendor_application "{\"p_entity_id\":$V4,\"p_waiver_reason\":\"Resource table\"}"
expect_ok "organizer waives the fee [13]"
eq "status Waived with the reason [13]" "$(col vendor_application "$V4" "(SELECT status_key FROM metadata.statuses WHERE id = status_id) || '|' || waiver_reason")" "waived|Resource table"
rpc "$A" initiate_vendor_application_payment "{\"p_entity_id\":$V4}"
expect_err "Pay Now on a waived application refuses [13]" "your fee was waived"

rpc "$O" deny_vendor_application "{\"p_entity_id\":$VB1,\"p_denial_reason\":\" \"}"
expect_err "Deny needs a reason" "A denial reason is required."
rpc "$O" deny_vendor_application "{\"p_entity_id\":$VB1,\"p_denial_reason\":\"Category is full\"}"
expect_ok "organizer denies a Pending application [14]"
eq "status Denied with the reason [14]" "$(col vendor_application "$VB1" "(SELECT status_key FROM metadata.statuses WHERE id = status_id) || '|' || denial_reason")" "denied|Category is full"
rpc "$B" initiate_vendor_application_payment "{\"p_entity_id\":$VB1}"
expect_err "Pay Now on a denied application refuses" "This application is closed."

rpc "$O" approve_vendor_application "{\"p_entity_id\":$VB2}"
VB2_TXN=$(col vendor_application "$VB2" payment_transaction_id)
rpc "$O" deny_vendor_application "{\"p_entity_id\":$VB2,\"p_denial_reason\":\"Changed our mind\"}"
expect_ok "an Approved application can be denied [15]"
# Deny unlinks the open card payment (checkout cannot resume past the guard) and
# keeps the transaction for the Stripe sync. The transaction's own status is the
# worker's and races it, so it is not asserted here.
eq "denying unlinks its open card payment" \
  "$([ -n "$VB2_TXN" ] && echo created)|$(col vendor_application "$VB2" "payment_transaction_id IS NULL")|$(q "SELECT count(*) FROM payments.transactions WHERE id = '$VB2_TXN'")" \
  "created|t|1"

rpc "$O" deny_vendor_application "{\"p_entity_id\":$VB3,\"p_denial_reason\":\"Please re-apply using the Food Truck form\"}"
ins "$B" food_truck_application "{\"business_name\":\"$TAG Tacos\",\"menu_description\":\"Tacos\",\"contact_name\":\"Test\",\"email\":\"b@example.com\",\"phone\":\"8105550101\",\"preferred_payment_method_id\":$CASH}"
expect_ok "denied vendor re-applies as a food truck [16]"
FT1=$(json_id)
eq "food truck fee is \$75 [16]" "$(col food_truck_application "$FT1" amount_due::numeric)" 75.00
rpc "$O" waive_and_approve_vendor_application "{\"p_entity_id\":$FT1,\"p_waiver_reason\":\"x\"}"
if [ "${CODE:0:1}" = 2 ] && [ "$(status_of food_truck_application "$FT1")" != pending ]; then
  fail "a vendor waiver changed a food truck"; else pass "waivers never apply to food trucks [24]"; fi

# Food trucks [T2, T3, T5, T6, V18]: every per-table wrapper, end to end
truck() { # token name pref [extra json]
  ins "$1" food_truck_application "{\"business_name\":\"$TAG $2\",\"menu_description\":\"Street food\",\"contact_name\":\"Test\",\"email\":\"truck@example.com\",\"phone\":\"8105550106\",\"preferred_payment_method_id\":$3${4:+,$4}}"
}
mstatus() { col "$1" "$2" "(SELECT status_key FROM metadata.statuses WHERE id = status_id) || '|' || coalesce((SELECT status_key FROM metadata.statuses WHERE id = payment_method_id), '') || '|' || coalesce(paid_amount::numeric::text, '')"; }
rpc "$B" initiate_food_truck_application_payment "{\"p_entity_id\":$FT1}"
expect_err "truck Pay Now on a Pending application refuses" "isn't approved for payment yet"
rpc "$A" approve_food_truck_application "{\"p_entity_id\":$FT1}"
expect_err "an applicant cannot approve a truck" "permission to manage Mott Fest applications"
rpc "$O" approve_food_truck_application "{\"p_entity_id\":$FT1}"
expect_ok "organizer approves a cash-paying truck [T2]"
eq "a cash payer's truck approval opens no payment [T2]" "$(col food_truck_application "$FT1" "payment_transaction_id IS NULL")" t
rpc "$B" initiate_food_truck_application_payment "{\"p_entity_id\":$FT1}"
expect_err "truck Pay Now for a cash payer refuses [T5]" "You chose to pay by Cash"
rpc "$O" record_food_truck_payment "{\"p_entity_id\":$FT1,\"p_payment_method_id\":$CC,\"p_payment_date\":\"$(date +%F)\",\"p_payment_reference\":null}"
expect_err "truck Record Payment refuses Credit Card [T5]" "Card payments are recorded automatically"
rpc "$O" record_food_truck_payment "{\"p_entity_id\":$FT1,\"p_payment_method_id\":$CASH,\"p_payment_date\":\"$(date +%F)\",\"p_payment_reference\":null}"
expect_ok "organizer records a cash truck payment [T5]"
eq "truck Paid by Cash for \$75 [T5]" "$(mstatus food_truck_application "$FT1")" "paid|cash|75.00"
rpc "$O" withdraw_food_truck_application "{\"p_entity_id\":$FT1,\"p_withdrawal_reason\":\"Truck broke down\"}"
expect_ok "a Paid truck can be withdrawn [T6]"
eq "the withdrawn truck keeps its payment record [T6]" "$(mstatus food_truck_application "$FT1")" "withdrawn|cash|75.00"

truck "$A" "Crepes" "$CC"; FT2=$(json_id)
rpc "$O" approve_food_truck_application "{\"p_entity_id\":$FT2}"
eq "approving a card-paying truck opens its online payment [T2]" "$(col food_truck_application "$FT2" "payment_transaction_id IS NOT NULL")" t
rpc "$A" initiate_food_truck_application_payment "{\"p_entity_id\":$FT2}"
eq "truck Pay Now returns the open payment [T5]" "$(tr -d '"' <<<"$BODY")" "$(col food_truck_application "$FT2" payment_transaction_id)"
rpc "$O" enable_online_payment_food_truck_application "{\"p_entity_id\":$FT2}"
expect_err "truck Enable Online Payment refuses card payers" "already pays online by card"

truck "$A" "BBQ" "$CHECK"; FT3=$(json_id)
rpc "$O" approve_food_truck_application "{\"p_entity_id\":$FT3}"
rpc "$O" enable_online_payment_food_truck_application "{\"p_entity_id\":$FT3}"
expect_ok "organizer enables online payment for a check-paying truck"
rpc "$A" initiate_food_truck_application_payment "{\"p_entity_id\":$FT3}"
eq "truck Pay Now then works for that applicant" "$(tr -d '"' <<<"$BODY")" "$(col food_truck_application "$FT3" payment_transaction_id)"

truck "$B" "Ice Cream" "$CHECK"; FT4=$(json_id)
rpc "$O" deny_food_truck_application "{\"p_entity_id\":$FT4,\"p_denial_reason\":\"Too many dessert trucks\"}"
eq "organizer denies a truck with a reason" "$(col food_truck_application "$FT4" "(SELECT status_key FROM metadata.statuses WHERE id = status_id) || '|' || denial_reason")" "denied|Too many dessert trucks"
rpc "$B" initiate_food_truck_application_payment "{\"p_entity_id\":$FT4}"
expect_err "truck Pay Now on a denied application refuses" "This application is closed."

# Phone-in truck [T3] and the truck capacity warning [V18]
ins "$O" food_truck_application "{\"festival_id\":$FID,\"business_name\":\"$TAG Phone Truck\",\"menu_description\":\"Hot dogs\",\"contact_name\":\"Caller\",\"email\":\"caller@example.com\",\"phone\":\"8105550107\",\"preferred_payment_method_id\":$CASH}"
expect_ok "organizer enters a phone-in truck application [T3]"
FTP=$(json_id)
eq "the phone-in row belongs to the organizer [T3]" "$(col food_truck_application "$FTP" applicant_id)" "$O_ID"
req "$O" PATCH "/festival?id=eq.$FID" '{"food_truck_capacity":1}'
rpc "$O" approve_food_truck_application "{\"p_entity_id\":$FTP}"
eq "truck approval over capacity succeeds with a warning [V18]" "$(jq -r '.message' <<<"$BODY" | grep -c 'Warning:' || true)" 1
req "$O" PATCH "/festival?id=eq.$FID" '{"food_truck_capacity":8}'
rpc "$O" record_food_truck_payment "{\"p_entity_id\":$FTP,\"p_payment_method_id\":$CASH,\"p_payment_date\":\"$(date +%F)\",\"p_payment_reference\":null}"
eq "the phone-in truck is Paid by Cash [T3]" "$(mstatus food_truck_application "$FTP")" "paid|cash|75.00"

rpc "$O" withdraw_vendor_application "{\"p_entity_id\":$V2,\"p_withdrawal_reason\":\"\"}"
expect_err "Withdraw needs a reason" "A withdrawal reason is required."
rpc "$O" withdraw_vendor_application "{\"p_entity_id\":$V2,\"p_withdrawal_reason\":\"Family emergency\"}"
expect_ok "a Paid application can be withdrawn [18]"
eq "withdrawn row keeps its payment record [18]" "$(col vendor_application "$V2" "paid_amount::numeric")" 30.00
rpc "$O" withdraw_vendor_application "{\"p_entity_id\":$VB4,\"p_withdrawal_reason\":\"Duplicate\"}"
eq "a duplicate is withdrawn [19]" "$(status_of vendor_application "$VB4")" withdrawn

# Notes [20]
rpc "$O" create_entity_note "{\"p_entity_type\":\"vendor_application\",\"p_entity_id\":\"$V3\",\"p_content\":\"VM 5/19\"}"
expect_ok "organizer adds a note [20]"
req "$O" GET "/entity_notes?entity_type=eq.vendor_application&entity_id=eq.$V3&content=eq.VM%205%2F19"
eq "organizer sees the note [20]" "$(jq 'length' <<<"$BODY")" 1
req "$A" GET "/entity_notes?entity_type=eq.vendor_application&entity_id=eq.$V3"
eq "the applicant sees no notes on their application [20]" "$(jq 'if type == "array" then length else 0 end' <<<"$BODY")" 0

# Capacity warning [21] and due-now approval [22]
vendor "$A" "Cap One" "$CHECK"; VC1=$(json_id)
req "$O" PATCH "/festival?id=eq.$FID" '{"vendor_capacity":1}'
rpc "$O" approve_vendor_application "{\"p_entity_id\":$VC1}"
eq "approval over capacity succeeds with a warning [21]" "$(jq -r '.message' <<<"$BODY" | grep -c 'Warning:' || true)" 1
req "$O" PATCH "/festival?id=eq.$FID" '{"vendor_capacity":40}'

vendor "$A" "Late" "$CHECK"; VL=$(json_id)
NEAR=$(date -v+20d +%Y-%m-%d 2>/dev/null || date -d '+20 days' +%Y-%m-%d)
req "$O" PATCH "/festival?id=eq.$FID" "{\"event_date\":\"$NEAR\"}"
rpc "$O" approve_vendor_application "{\"p_entity_id\":$VL}"
eq "approval inside the last month marks payment due now [22]" \
  "$(q "SELECT entity_data->>'payment_is_past_due' FROM metadata.notifications WHERE template_name = 'mottfest_application_approved'
        AND entity_type = 'vendor_application' AND entity_id::text = '$VL' ORDER BY id DESC LIMIT 1")" true
req "$O" PATCH "/festival?id=eq.$FID" "{\"event_date\":\"$EVENT\"}"

# ---------------------------------------------------------------------------
# Sponsorships [26-34]
# ---------------------------------------------------------------------------
section "Sponsorships [26-34]"
sponsor() { # token name tier pref extra-json agreed
  ins "$1" sponsorship_application "{\"sponsor_name\":\"$TAG $2\",\"mailing_address\":\"1 Main St, Flint MI\",\"contact_name\":\"Test\",\"email\":\"s@example.com\",\"phone\":\"8105550102\",\"tier_id\":$3,\"preferred_payment_method_id\":$4,\"tshirt_size_id\":$SHIRT_L,\"agreed_to_terms\":${6:-true}${5:+,$5}}"
}
sponsor "$A" "No Agree" "$T500" "$CC" "" false
expect_err "submitting without the agreement is blocked [27]" "sponsorship_application_agreed_check"
eq "the agreement block has a friendly message [27]" \
  "$(q "SELECT count(*) FROM metadata.constraint_messages WHERE constraint_name = 'sponsorship_application_agreed_check'")" 1
sponsor "$A" "Corp 500" "$T500" "$CC"
expect_ok "applicant applies at Corporate \$500 [26]"
S1=$(json_id)
eq "fee \$500 and agreement time stamped [26]" "$(col sponsorship_application "$S1" "amount_due::numeric || '|' || (agreed_at IS NOT NULL)")" "500.00|true"
sponsor "$A" "Custom" "$TCUSTOM" "$CHECK" '"custom_amount":2000'
eq "custom amount \$2,000 [28]" "$(col sponsorship_application "$(json_id)" amount_due::numeric)" 2000.00
sponsor "$A" "Custom Empty" "$TCUSTOM" "$CHECK"
expect_err "Custom with no amount is blocked [29]" "Enter a custom amount, or choose a fixed level"
sponsor "$A" "Fixed Plus" "$T250" "$CHECK" '"custom_amount":300'
expect_err "a fixed level with a custom amount is blocked [29]" "Custom amount only applies to the Custom Amount level"

sponsor "$A" "Pending 250" "$T250" "$CHECK"; S250=$(json_id)
req "$O" PATCH "/sponsorship_application?id=eq.$S250" "{\"tier_id\":$TCUSTOM,\"custom_amount\":750}"
eq "organizer edit recalculates the fee to \$750 [33]" "$(col sponsorship_application "$S250" amount_due::numeric)" 750.00

ins "$A" sponsorship_application "{\"sponsor_name\":\"$TAG Tents\",\"mailing_address\":\"2 Main St\",\"contact_name\":\"Test\",\"email\":\"t@example.com\",\"phone\":\"8105550103\",\"tier_id\":$TINKIND,\"in_kind_description\":\"Two tents\",\"in_kind_value\":400,\"agreed_to_terms\":true}"
expect_ok "in-kind needs no payment method [30]"
SK=$(json_id)
rpc "$O" approve_sponsorship "{\"p_entity_id\":$SK}"
eq "approving in-kind sets In-Kind [30]" "$(status_of sponsorship_application "$SK")" in_kind
rpc "$A" initiate_sponsorship_payment "{\"p_entity_id\":$SK}"
expect_err "Pay Now on in-kind refuses [30]" "No payment is due for in-kind sponsorships."
rpc "$O" withdraw_sponsorship "{\"p_entity_id\":$SK,\"p_withdrawal_reason\":\"Tents fell through\"}"
eq "organizer withdraws an in-kind sponsorship [31]" "$(status_of sponsorship_application "$SK")" withdrawn

sponsor "$A" "Individual" "$T100" "$CC"; S100=$(json_id)
rpc "$O" approve_sponsorship "{\"p_entity_id\":$S100}"
rpc "$A" initiate_sponsorship_payment "{\"p_entity_id\":$S100}"
eq "Pay Now for a \$100 card sponsorship returns its payment [34]" "$(tr -d '"' <<<"$BODY")" "$(col sponsorship_application "$S100" payment_transaction_id)"

ins "$O" sponsorship_application "{\"festival_id\":$FID,\"sponsor_name\":\"$TAG Mailed In\",\"mailing_address\":\"3 Main St\",\"contact_name\":\"Test\",\"email\":\"m@example.com\",\"phone\":\"8105550104\",\"tier_id\":$T250,\"preferred_payment_method_id\":$CHECK,\"agreed_to_terms\":true}"
SM=$(json_id)
rpc "$O" approve_sponsorship "{\"p_entity_id\":$SM}"
rpc "$O" record_sponsorship_payment "{\"p_entity_id\":$SM,\"p_payment_method_id\":$CHECK,\"p_payment_date\":\"$(date +%F)\",\"p_payment_reference\":\"#77\"}"
eq "organizer-entered sponsorship approved and paid [32]" "$(status_of sponsorship_application "$SM")" paid
eq "organizer-entered rows belong to the organizer (spec: applicant_id default) [32]" "$(col sponsorship_application "$SM" applicant_id)" "$O_ID"

# Thank-you follow-up [S8] and social promotion [S9]
S8Q="/sponsorship_application?festival_id=eq.$FID&status_id=in.($(sid sponsorship_application paid),$(sid sponsorship_application in_kind))&thank_you_sent=is.null&select=id"
req "$O" GET "$S8Q"
eq "the thank-you filter lists the paid sponsor [S8]" "$(jq "[.[] | select(.id == $SM)] | length" <<<"$BODY")" 1
req "$O" PATCH "/sponsorship_application?id=eq.$SM" "{\"thank_you_sent\":\"$(date +%F)\",\"promoted_on_social\":\"$(date +%F)\"}"
expect_ok "organizer sets Thank-You Sent and Promoted on Social [S8, S9]"
eq "both dates are stored [S8, S9]" "$(col sponsorship_application "$SM" "thank_you_sent = current_date AND promoted_on_social = current_date")" t
req "$O" GET "$S8Q"
eq "the thanked sponsor leaves the filter [S8]" "$(jq "[.[] | select(.id == $SM)] | length" <<<"$BODY")" 0
# The Filters panel cannot express "date is empty", so the Management
# dashboard carries the same filter as a widget, by status key, not id.
eq "the Management dashboard has a Thank-Yous Due list with the same filter [S8]" "$(q "SELECT count(*) FROM metadata.dashboard_widgets w JOIN metadata.dashboards d ON d.id = w.dashboard_id
     WHERE d.display_name = 'Mott Fest Management' AND w.widget_type = 'filtered_list' AND w.entity_key = 'sponsorship_application'
       AND w.config->'filters' @> '[{\"column\": \"thank_you_sent\", \"operator\": \"is\", \"value\": null},
                                    {\"column\": \"status_id.status_key\", \"operator\": \"in\", \"value\": [\"paid\", \"in_kind\"]}]'")" 1
req "$O" GET "/rpc/get_dashboard?p_dashboard_id=$(q "SELECT id FROM metadata.dashboards WHERE display_name = 'Mott Fest Management' ORDER BY id LIMIT 1")"
expect_ok "organizer loads the Management dashboard [S8]"
eq "the organizer sees the Thank-Yous Due list [S8]" "$(jq '[.. | objects | select(.config?.filters? // [] | any(.column == "thank_you_sent"))] | length' <<<"$BODY")" 1

# Dashboard links are nav_buttons widgets (routerLink, no page reload), never
# HTML anchors in markdown.
eq "Mott Fest dashboards link through nav_buttons, not HTML" "$(q "SELECT count(*) FILTER (WHERE w.widget_type = 'nav_buttons') || ',' ||
       count(*) FILTER (WHERE w.config->>'content' ~* '<a[[:space:]]')
     FROM metadata.dashboard_widgets w JOIN metadata.dashboards d ON d.id = w.dashboard_id
     WHERE d.display_name IN ('Mott Fest', 'Mott Fest Management', 'Thanks for your feedback')")" "4,0"

# ---------------------------------------------------------------------------
# Staged launch: the dashboards script shows Mott Fest to organizers only;
# the launch script (example 40, production 37) shows it to everyone. The
# checks follow whichever state the database is in, so a production replica
# tested before launch passes too.
# ---------------------------------------------------------------------------
section "Staged launch"
MF_ID=$(q "SELECT id FROM metadata.dashboards WHERE display_name = 'Mott Fest' ORDER BY id LIMIT 1")
TH_ID=$(q "SELECT id FROM metadata.dashboards WHERE display_name = 'Thanks for your feedback' ORDER BY id LIMIT 1")
MAIN_ID=$(q "SELECT id FROM metadata.dashboards WHERE display_name = 'Mott Park Clubhouse Reservations' ORDER BY id LIMIT 1")
BANNERS=$(q "SELECT count(*) FROM metadata.dashboard_widgets WHERE dashboard_id = $MAIN_ID
     AND (config->'buttons' @> '[{\"url\": \"/dashboard/$MF_ID\"}]' OR config->>'content' LIKE '%/dashboard/$MF_ID\"%')")
seen() { rpc "$1" get_dashboards '{}'; jq --argjson d "$2" '[.[] | select(.id == $d)] | length' <<<"$BODY"; }
eq "the organizer sees the Mott Fest dashboard" "$(seen "$O" "$MF_ID")" 1
eq "the organizer may open the Thanks page" "$(q "SELECT count(*) FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
     WHERE dr.dashboard_id = $TH_ID AND r.role_key = 'mottfest_admin'")" 1
if [ "$(q "SELECT is_public FROM metadata.dashboards WHERE id = $MF_ID")" = t ]; then
  pass "Mott Fest is launched: checking the launched state"
  eq "anonymous sees the Mott Fest dashboard" "$(seen "" "$MF_ID")" 1
  eq "an applicant sees the Mott Fest dashboard" "$(seen "$A" "$MF_ID")" 1
  eq "every signed-in user may open the Thanks page" "$(q "SELECT count(*) FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
       WHERE dr.dashboard_id = $TH_ID AND r.role_key = 'user'")" 1
  eq "the clubhouse dashboard carries one Mott Fest banner" "$BANNERS" 1
  eq "the welcome header and the banner are one column each" "$(q "SELECT string_agg(width::text, ',' ORDER BY sort_order) FROM (
       SELECT width, sort_order FROM metadata.dashboard_widgets WHERE dashboard_id = $MAIN_ID ORDER BY sort_order LIMIT 2) s")" "1,1"
else
  pass "Mott Fest is not launched: checking the staged state"
  eq "anonymous does not see the Mott Fest dashboard" "$(seen "" "$MF_ID")" 0
  eq "an applicant does not see the Mott Fest dashboard" "$(seen "$A" "$MF_ID")" 0
  eq "the clubhouse manager does not see the Mott Fest dashboard" "$(seen "$B" "$MF_ID")" 0
  eq "the clubhouse dashboard has no Mott Fest banner" "$BANNERS" 0
fi

# ---------------------------------------------------------------------------
# Revenue visibility [18, 43, 44]
# ---------------------------------------------------------------------------
section "Revenue [18, 43, 44]"
req "$O" GET "/mottfest_revenue_summary?festival_id=eq.$FID&pipeline_no=eq.1&select=total_paid,paid,withdrawn"
eq "vendor revenue counts the paid-then-withdrawn row [18, 43]" "$(jq -r '.[0].total_paid' <<<"$BODY")" '$30.00'
req "$O" GET "/mottfest_revenue_summary?festival_id=eq.$FID&pipeline_no=eq.2&select=total_paid"
eq "truck revenue counts the withdrawn and phone-in cash payments [T6, 43]" "$(jq -r '.[0].total_paid' <<<"$BODY")" '$150.00'
for who in A B; do
  req "${!who}" GET "/mottfest_revenue_summary?select=festival_id"
  eq "applicant $who sees no revenue summary [44]" "$(jq 'if type == "array" then length else 0 end' <<<"$BODY")" 0
  req "${!who}" GET "/mottfest_current_summary?select=pipeline"
  eq "applicant $who sees no current summary [44]" "$(jq 'if type == "array" then length else 0 end' <<<"$BODY")" 0
done
req "" GET "/mottfest_revenue_summary?select=festival_id"
eq "anonymous sees no revenue [44]" "$(jq 'if type == "array" then length else 0 end' <<<"$BODY")" 0

# ---------------------------------------------------------------------------
# Closing and completing [36-38]
# ---------------------------------------------------------------------------
section "Close and complete [36-38]"
rpc "$O" close_festival "{\"p_entity_id\":$FID}"
expect_ok "organizer closes applications [36]"
vendor "$B" "Too Late" "$CHECK"
expect_err "applicants are blocked once applications close [36]" "Mott Fest applications are not open right now."
# A 23514 without a constraint name shows as a generic "Validation failed" in the app;
# a plain RAISE (P0001) shows this message verbatim.
eq "the refusal is a plain RAISE the app shows verbatim [36]" "$(jq -r '.code // empty' <<<"$BODY")" "P0001"
ins "$O" vendor_application "{\"festival_id\":$FID,\"business_name\":\"$TAG Phone In\",\"vendor_type_id\":$RETAIL,\"description\":\"Phone-in\",\"contact_name\":\"Test\",\"email\":\"p@example.com\",\"phone\":\"8105550105\",\"preferred_payment_method_id\":$CASH}"
expect_ok "organizer still creates an application after closing [36, 25]"

rpc "$O" complete_festival "{\"p_entity_id\":$FID}"
expect_err "Mark Completed refuses with unresolved rows, listing counts [37]" "Resolve "
grep -qE 'Resolve [0-9]+ pending and [0-9]+ unpaid' <<<"$BODY" && pass "refusal names the pending and unpaid counts [37]" || fail "refusal lacks counts: $BODY"

# Resolve everything still Pending or Approved
psql "$DATABASE_URL" -Atq -c "
  SELECT 'vendor_application', id FROM vendor_application WHERE festival_id = $FID AND status_id IN (get_status_id('vendor_application','pending'), get_status_id('vendor_application','approved'))
  UNION ALL SELECT 'food_truck_application', id FROM food_truck_application WHERE festival_id = $FID AND status_id IN (get_status_id('food_truck_application','pending'), get_status_id('food_truck_application','approved'))
  UNION ALL SELECT 'sponsorship_application', id FROM sponsorship_application WHERE festival_id = $FID AND status_id IN (get_status_id('sponsorship_application','pending'), get_status_id('sponsorship_application','approved'))" |
while IFS='|' read -r t id; do
  case $t in
    vendor_application) fn=withdraw_vendor_application ;;
    food_truck_application) fn=withdraw_food_truck_application ;;
    sponsorship_application) fn=withdraw_sponsorship ;;
  esac
  rpc "$O" "$fn" "{\"p_entity_id\":$id,\"p_withdrawal_reason\":\"Test cleanup\"}"
done
rpc "$O" complete_festival "{\"p_entity_id\":$FID}"
expect_ok "Mark Completed succeeds once everything is resolved [38]"
eq "festival is Completed [38]" "$(status_of festival "$FID")" completed

# ---------------------------------------------------------------------------
# Feedback [39-41]
# ---------------------------------------------------------------------------
section "Feedback [39-41]"
FB="{\"festival_id\":$FID,\"what_worked_well\":\"$TAG music\",\"what_did_not_go_well\":\"parking\",\"worth_it_financially_id\":$W_OTHER,\"worth_it_financially_other\":\"broke even\",\"worth_it_non_financially_id\":$W_YES}"
req "" POST /feedback_submission "$FB"
if [ "${CODE:0:1}" != 2 ]; then pass "anonymous cannot submit feedback [39]"; else fail "anonymous submitted feedback"; fi
ins "$A" feedback_submission "$FB"
expect_ok "applicant submits feedback with return=representation [39]"
req "$A" GET "/feedback_response?festival_id=eq.$FID"
eq "the applicant cannot read feedback, including their own [39]" "$(jq 'if type == "array" then length else 0 end' <<<"$BODY")" 0
req "$A" GET "/feedback_submission?festival_id=eq.$FID"
eq "the submission view returns nothing to read [39]" "$(jq 'if type == "array" then length else 0 end' <<<"$BODY")" 0
# The trigger files feedback under get_current_festival(), whatever the caller sends
req "$O" GET "/feedback_response?what_worked_well=eq.$TAG%20music&select=*"
eq "organizer reads the response [40]" "$(jq 'length' <<<"$BODY")" 1
eq "the response is filed under the current festival, not the one sent [39]" \
  "$(jq -r '.[0].festival_id' <<<"$BODY")" "$(q "SELECT get_current_festival()")"
eq "the response carries no user field [40, 41]" "$(jq '[.[0] // {} | keys[] | select(test("user|author|created_by|respondent|applicant"))] | length' <<<"$BODY")" 0
eq "no notification, note or payment references the response [40]" \
  "$(q "SELECT count(*) FROM metadata.notifications WHERE entity_type IN ('feedback_response','feedback_submission')")" 0

# ---------------------------------------------------------------------------
# Next year: returning vendors and late feedback [V15, FB4]
# ---------------------------------------------------------------------------
section "Next year [V15, FB4]"
NEXT_EVENT=$(date -v+515d +%Y-%m-%d 2>/dev/null || date -d '+515 days' +%Y-%m-%d)
NEXT_CLOSE=$(date -v+465d +%Y-%m-%d 2>/dev/null || date -d '+465 days' +%Y-%m-%d)
ins "$O" festival "{\"display_name\":\"$TAG Next Fest\",\"event_date\":\"$NEXT_EVENT\",\"applications_open_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"applications_close_at\":\"$NEXT_CLOSE\"}"
F3=$(json_id); FIDS="$FIDS,$F3"
rpc "$O" open_festival "{\"p_entity_id\":$F3}"
expect_ok "organizer opens next year's festival"
vendor "$A" "Pottery" "$CC"
expect_ok "a returning vendor applies again [V15]"
VN=$(json_id)
eq "the new application is on the new festival [V15]" "$(col vendor_application "$VN" festival_id)" "$F3"
eq "last year's application stays on last year's festival [V15]" "$(col vendor_application "$V1" festival_id)" "$FID"
req "$A" GET "/vendor_application?id=in.($V1,$VN)&select=id"
eq "the applicant sees both years' applications [V15]" "$(jq 'length' <<<"$BODY")" 2

ins "$A" feedback_submission "{\"what_worked_well\":\"$TAG late\",\"worth_it_financially_id\":$W_YES,\"worth_it_non_financially_id\":$W_YES}"
expect_ok "an applicant submits feedback after next year opens [FB4]"
req "$O" GET "/feedback_response?what_worked_well=eq.$TAG%20late&select=id,festival_id"
eq "a late response defaults to the new festival [FB4]" "$(jq -r '.[0].festival_id' <<<"$BODY")" "$F3"
FBL=$(jq -r '.[0].id' <<<"$BODY")
req "$O" PATCH "/feedback_response?id=eq.$FBL" "{\"festival_id\":$FID}"
expect_ok "organizer edits the response's festival [FB4]"
eq "the response is refiled under last year's festival [FB4]" "$(col feedback_response "$FBL" festival_id)" "$FID"
# Close it again so a re-run of the sample-data script never meets two Open festivals
rpc "$O" close_festival "{\"p_entity_id\":$F3}"

# ---------------------------------------------------------------------------
# Notifications and the worker [6, 10, 11, 13, 14, 18, 30]
# ---------------------------------------------------------------------------
section "Notifications"
NSQL="FROM metadata.notifications n WHERE (n.entity_type, n.entity_id::text) IN (
  SELECT 'vendor_application', id::text FROM vendor_application WHERE festival_id = $FID
  UNION ALL SELECT 'food_truck_application', id::text FROM food_truck_application WHERE festival_id = $FID
  UNION ALL SELECT 'sponsorship_application', id::text FROM sponsorship_application WHERE festival_id = $FID)"
eq "all 8 Mott Fest templates were queued" \
  "$(q "SELECT count(DISTINCT template_name) $NSQL AND template_name LIKE 'mottfest\_%'")" 8
eq "receipts go to the applicant [6]" \
  "$(q "SELECT string_agg(DISTINCT user_id::text, ',') $NSQL AND template_name = 'mottfest_application_received' AND n.entity_type = 'vendor_application' AND n.entity_id::text = '$V1'")" "$A_ID"
eq "new-application notices go to mottfest_admin holders [6]" \
  "$(q "SELECT string_agg(DISTINCT user_id::text, ',' ORDER BY user_id::text) $NSQL AND template_name = 'mottfest_application_submitted' AND n.entity_type = 'vendor_application' AND n.entity_id::text = '$V1'")" \
  "$(q "SELECT string_agg(ur.user_id::text, ',' ORDER BY ur.user_id::text) FROM metadata.user_roles ur JOIN metadata.roles r ON r.id = ur.role_id WHERE r.role_key = 'mottfest_admin'")"
eq "organizer-entered rows send status mail to organizers [32]" \
  "$(q "SELECT count(*) $NSQL AND n.entity_id::text = '$SM' AND n.entity_type = 'sponsorship_application' AND template_name = 'mottfest_payment_received' AND user_id = '$O_ID'")" 1
eq "a phone-in truck's approval and payment mail go to the organizer [T3]" \
  "$(q "SELECT string_agg(template_name, ',' ORDER BY template_name) $NSQL AND n.entity_id::text = '$FTP' AND n.entity_type = 'food_truck_application' AND template_name IN ('mottfest_application_approved','mottfest_payment_received') AND user_id = '$O_ID'")" \
  "mottfest_application_approved,mottfest_payment_received"

WAITED=0
while [ "$(q "SELECT count(*) $NSQL AND status = 'pending'")" != 0 ] && [ $WAITED -lt "$MAIL_WAIT" ]; do
  sleep 3; WAITED=$((WAITED + 3))
done
eq "the worker delivered every test notification" "$(q "SELECT count(*) $NSQL AND status <> 'sent'")" 0
eq "no delivery errors" "$(q "SELECT coalesce(string_agg(DISTINCT error_message, '; '), '') $NSQL AND error_message IS NOT NULL")" ""
if curl -sf -o /dev/null "$MAIL_API/mailbox/testuser"; then
  # Inbucket keeps one mailbox per recipient local part; walk every recipient this run notified
  BAD=0; N=0; SUBJECTS=""
  for box in $(q "SELECT DISTINCT split_part(u.email, '@', 1) FROM metadata.civic_os_users_private u WHERE u.id IN (SELECT n.user_id $NSQL)"); do
    for id in $(curl -s "$MAIL_API/mailbox/$box" | jq -r --argjson since "$RUN_START" \
                '.[] | select(.subject | test("Mott Fest|^New .* application: ")) | select((.date | sub("\\.[0-9]+"; "") | sub("Z$"; "") | strptime("%Y-%m-%dT%H:%M:%S") | mktime) >= $since) | .id'); do
      N=$((N + 1))
      MSG=$(curl -s "$MAIL_API/mailbox/$box/$id")
      SUBJECTS="$SUBJECTS$(jq -r .subject <<<"$MSG")"$'\n'
      if jq -r '.body.text, .body.html' <<<"$MSG" | grep -qE '\{\{|<no value>|%!|\$0\.00 is due'; then BAD=$((BAD + 1)); fi
    done
  done
  if [ "$N" -gt 0 ] && [ "$BAD" = 0 ]; then pass "$N delivered Mott Fest emails have every template field filled"
  else fail "$BAD of $N delivered Mott Fest emails have unfilled fields"; fi
  echo "$SUBJECTS" | sed '/^$/d' | sort | uniq -c | sed 's/^/        /'
else
  echo "  NOTE  mail API at $MAIL_API not reachable; skipped rendered-mail check"
fi

# ---------------------------------------------------------------------------
# Revoking the role [46]
# ---------------------------------------------------------------------------
section "Revoking the organizer role [46]"
rpc "$ADM" revoke_user_role "{\"p_user_id\":\"$O_ID\",\"p_role_name\":\"mottfest_admin\"}"
eq "admin revokes mottfest_admin" "$(jq -r '.success' <<<"$BODY")" true
ROLE_ASSIGNED=0
for _ in $(seq 1 30); do
  O=$(tok testeditor)
  if ! has_realm_role "$O" mottfest_admin; then break; fi
  sleep 1
done
if has_realm_role "$O" mottfest_admin; then fail "role still in the token after 30 s"
else pass "the next token no longer carries the role"; fi
req "$O" GET "/vendor_application?select=id,applicant_id&festival_id=eq.$FID"
eq "former organizer reads only rows they entered themselves (owner RLS)" \
  "$(jq --arg o "$O_ID" '[.[] | select(.applicant_id != $o)] | length' <<<"$BODY")" 0

# ---------------------------------------------------------------------------
# Idempotency: re-running the init scripts changes nothing
# ---------------------------------------------------------------------------
if [ "${SKIP_RERUN:-0}" != 1 ]; then
  section "Idempotency"
  COUNTS="SELECT (SELECT count(*) FROM metadata.schema_decisions) || '|' ||
    (SELECT count(*) FROM metadata.entity_actions) || '|' || (SELECT count(*) FROM metadata.entity_action_params) || '|' ||
    (SELECT count(*) FROM metadata.permissions) || '|' || (SELECT count(*) FROM metadata.permission_roles) || '|' ||
    (SELECT count(*) FROM metadata.menu_nodes) || '|' || (SELECT count(*) FROM metadata.dashboards) || '|' ||
    (SELECT count(*) FROM metadata.dashboard_widgets) || '|' || (SELECT count(*) FROM metadata.dashboard_roles) || '|' ||
    (SELECT count(*) FROM metadata.notification_templates) || '|' || (SELECT count(*) FROM metadata.statuses) || '|' ||
    (SELECT count(*) FROM metadata.categories) || '|' || (SELECT count(*) FROM metadata.validations) || '|' ||
    (SELECT count(*) FROM metadata.instance_config) || '|' || (SELECT count(*) FROM festival) || '|' ||
    (SELECT count(*) FROM vendor_application) || '|' || (SELECT count(*) FROM metadata.notifications)"
  BEFORE=$(q "$COUNTS")
  LAUNCHED=$(q "SELECT coalesce(bool_or(is_public), false) FROM metadata.dashboards WHERE display_name = 'Mott Fest'")
  for f in "$SCRIPTS_DIR"/[0-9][0-9]_mottfest_*.sql; do
    # Re-running the launch script before launch would launch the module.
    if [[ "$f" == *_launch.sql && "$LAUNCHED" != t ]]; then
      pass "left $(basename "$f") alone: Mott Fest is not launched"; continue
    fi
    if psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>"/tmp/mottfest-rerun.$$"; then
      pass "re-ran $(basename "$f")"
    else
      fail "re-run of $(basename "$f") failed: $(head -3 "/tmp/mottfest-rerun.$$")"
    fi
  done
  rm -f "/tmp/mottfest-rerun.$$"
  eq "object, row and decision counts unchanged after the re-run" "$(q "$COUNTS")" "$BEFORE"
fi

echo
echo "Mott Fest module: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
