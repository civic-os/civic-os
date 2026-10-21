#!/bin/bash
# =============================================================================
# Recurring Series: Template/Split Permissions and Split Behavior (v0.76.9)
# =============================================================================
# Runs every call through PostgREST with real Keycloak tokens (authenticator ->
# authenticated with JWT claims), never as postgres, which passes _is_db_admin().
#
# Covers:
#   1. A series owner WITHOUT update permission on the entity table cannot change
#      records through update_series_template or split_series_from_date
#      (previously: definer rights let a 'user' self-approve their own requests).
#   2. Status columns never propagate through a template to existing records.
#   3. A this-only edit marks the occurrence 'modified'; template updates skip it.
#   4. split_series_from_date saves the edited occurrence in the same transaction,
#      moves the following non-exception occurrences, keeps COUNT a series total,
#      and refuses a second split of the same series on the same date.
#   5. time_slot_series.timezone must be an exact pg_timezone_names name.
#
# Usage:
#   ./tests/functional/recurring-series-split-test.sh
#
# Environment overrides (defaults match the community-center docker-compose stack):
#   POSTGREST_URL  http://localhost:3000     KEYCLOAK_URL  http://localhost:8082
#   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDB     psql access for setup and assertions
#
# Prerequisites: community-center example running with the consolidated worker
# (expansion), test users testuser (role user), testeditor, testadmin.
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0

POSTGREST_URL="${POSTGREST_URL:-http://localhost:3000}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8082}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-civic-os-dev}"
KEYCLOAK_CLIENT="${KEYCLOAK_CLIENT:-civic-os-dev-client}"
PGHOST="${PGHOST:-localhost}"; PGPORT="${PGPORT:-15432}"; PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-securepassword123}"; PGDB="${PGDB:-civic_os_db}"
export PGPASSWORD

section() { echo ""; echo -e "${BOLD}$1${NC}"; }
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1));
  else echo -e "  ${RED}FAIL${NC} $1 (expected '$2', got '$3')"; FAIL=$((FAIL + 1)); fi
}
q() { psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -Atq -c "$1"; }
token() {
  curl -s -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
    -d grant_type=password -d client_id="$KEYCLOAK_CLIENT" -d username="$1" -d password="$1" |
    python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])"
}
BODY_FILE=$(mktemp); trap 'rm -f "$BODY_FILE"' EXIT
rpc() { # token fn json -> "<http status> <body>"
  curl -s -o "$BODY_FILE" -w "%{http_code}" -X POST "$POSTGREST_URL/rpc/$2" \
    -H "Authorization: Bearer $1" -H "Content-Type: application/json" -d "$3"
  echo " $(cat "$BODY_FILE")"
}
patch() { # token id json -> http status
  curl -s -o /dev/null -w "%{http_code}" -X PATCH "$POSTGREST_URL/reservation_requests?id=eq.$2" \
    -H "Authorization: Bearer $1" -H "Content-Type: application/json" -d "$3"
}
wait_instances() { # series_id count
  for _ in $(seq 1 40); do [ "$(q "select count(*) from metadata.time_slot_instances where series_id=$1")" -ge "$2" ] && return 0; sleep 1; done; return 1
}

USER_TOKEN=$(token testuser); EDITOR_TOKEN=$(token testeditor); ADMIN_TOKEN=$(token testadmin)
for t in "$USER_TOKEN" "$EDITOR_TOKEN" "$ADMIN_TOKEN"; do rpc "$t" refresh_current_user '{}' >/dev/null; done
PENDING=$(q "select id from metadata.statuses where entity_type='reservation_request' and status_key='pending'")
APPROVED=$(q "select id from metadata.statuses where entity_type='reservation_request' and status_key='approved'")
USER_ID=$(q "select id from metadata.civic_os_users where display_name ilike 'test u%' order by created_at desc limit 1")
[ -z "$USER_ID" ] && USER_ID=$(echo "$USER_TOKEN" | cut -d. -f2 | python3 -c "import sys,base64,json;s=sys.stdin.read().strip();s+='='*(-len(s)%4);print(json.loads(base64.urlsafe_b64decode(s))['sub'])")

create_series() { # token name rrule dtstart -> series id
  rpc "$1" create_recurring_series "{\"p_group_name\":\"$2\",\"p_group_description\":null,\"p_group_color\":null,
    \"p_entity_table\":\"reservation_requests\",\"p_entity_template\":{\"resource_id\":2,\"purpose\":\"$2\",\"attendee_count\":4,
    \"requested_by\":\"$USER_ID\",\"status_id\":$PENDING},\"p_rrule\":\"$3\",\"p_dtstart\":\"$4\",\"p_duration\":\"01:00:00\",
    \"p_timezone\":\"America/New_York\",\"p_time_slot_property\":\"time_slot\",\"p_expand_now\":true,\"p_skip_conflicts\":false}" |
    sed 's/^[0-9]* //' | python3 -c "import sys,json;print(json.load(sys.stdin).get('series_id',''))"
}
entity_on() { q "select entity_id from metadata.time_slot_instances where series_id=$1 and occurrence_date='$2'"; }

# -----------------------------------------------------------------------------
section "1. Series owner without update permission cannot change records"
SU=$(create_series "$USER_TOKEN" "rsst-user-owned" "FREQ=WEEKLY;BYDAY=WE;COUNT=3" "2026-11-04T10:00:00")
wait_instances "$SU" 3
R=$(rpc "$USER_TOKEN" update_series_template "{\"p_series_id\":$SU,\"p_new_template\":{\"status_id\":$APPROVED}}")
check "update_series_template is refused for a user without update permission" "4" "${R:0:1}"
check "the series template did not take the status" "$PENDING" "$(q "select entity_template->>'status_id' from metadata.time_slot_series where id=$SU")"
check "no occurrence was approved through update_series_template" "0" \
  "$(q "select count(*) from reservation_requests r join metadata.time_slot_instances i on i.entity_id=r.id where i.series_id=$SU and r.status_id=$APPROVED")"
R=$(rpc "$USER_TOKEN" split_series_from_date "{\"p_series_id\":$SU,\"p_split_date\":\"2026-11-11\",\"p_new_dtstart\":\"2026-11-11T10:00:00\",\"p_new_template\":{\"status_id\":$APPROVED}}")
check "split_series_from_date is refused for a user without update permission" "4" "${R:0:1}"
check "no occurrence was approved through split_series_from_date" "0" \
  "$(q "select count(*) from reservation_requests r join metadata.time_slot_instances i on i.entity_id=r.id join metadata.time_slot_series s on s.id=i.series_id where s.group_id=(select group_id from metadata.time_slot_series where id=$SU) and r.status_id=$APPROVED")"
check "the refused split created no new version" "1" "$(q "select count(*) from metadata.time_slot_series where group_id=(select group_id from metadata.time_slot_series where id=$SU)")"

# -----------------------------------------------------------------------------
section "2. Status columns never propagate through a template"
SE=$(create_series "$EDITOR_TOKEN" "rsst-editor-owned" "FREQ=WEEKLY;BYDAY=WE;COUNT=4" "2026-11-04T11:00:00")
wait_instances "$SE" 4
R=$(rpc "$EDITOR_TOKEN" update_series_template "{\"p_series_id\":$SE,\"p_new_template\":{\"purpose\":\"rsst-renamed\",\"status_id\":$APPROVED}}")
check "update_series_template succeeds for an owner with update permission" "2" "${R:0:1}"
check "the template change reached every occurrence" "4" \
  "$(q "select count(*) from reservation_requests r join metadata.time_slot_instances i on i.entity_id=r.id where i.series_id=$SE and r.purpose='rsst-renamed'")"
check "no occurrence took the status" "0" \
  "$(q "select count(*) from reservation_requests r join metadata.time_slot_instances i on i.entity_id=r.id where i.series_id=$SE and r.status_id=$APPROVED")"
check "the stored template kept its status" "$PENDING" "$(q "select entity_template->>'status_id' from metadata.time_slot_series where id=$SE")"

# -----------------------------------------------------------------------------
section "3. A this-only edit makes the occurrence an exception"
E2=$(entity_on "$SE" 2026-11-11)
check "PATCH of one occurrence succeeds" "204" "$(patch "$EDITOR_TOKEN" "$E2" '{"notes":"rsst one-off note"}')"
check "the occurrence is marked modified" "true|modified" "$(q "select is_exception||'|'||exception_type from metadata.time_slot_instances where entity_id=$E2")"
rpc "$EDITOR_TOKEN" update_series_template "{\"p_series_id\":$SE,\"p_new_template\":{\"notes\":\"rsst series note\"}}" >/dev/null
check "a later template update leaves the exception's edit alone" "rsst one-off note" "$(q "select notes from reservation_requests where id=$E2")"
check "the template update reached the other occurrences" "3" \
  "$(q "select count(*) from reservation_requests r join metadata.time_slot_instances i on i.entity_id=r.id where i.series_id=$SE and r.notes='rsst series note'")"

# -----------------------------------------------------------------------------
section "4. Split: atomic edit, following occurrences, COUNT, refusals"
SS=$(create_series "$EDITOR_TOKEN" "rsst-split" "FREQ=WEEKLY;BYDAY=WE;COUNT=4" "2026-11-04T12:00:00")
wait_instances "$SS" 4
ES=$(entity_on "$SS" 2026-11-11)
# Move this and following from 12:00 to 13:00 New York (18:00Z), editing this occurrence's purpose too
R=$(rpc "$EDITOR_TOKEN" split_series_from_date "{\"p_series_id\":$SS,\"p_split_date\":\"2026-11-11\",\"p_new_dtstart\":\"2026-11-11T13:00:00\",
  \"p_new_template\":{\"purpose\":\"rsst-split-later\"},\"p_edited_entity_id\":$ES,
  \"p_edited_values\":{\"purpose\":\"rsst-split-later\",\"time_slot\":\"[2026-11-11T18:00:00Z,2026-11-11T19:00:00Z)\"}}")
check "split with the edited occurrence succeeds" "2" "${R:0:1}"
NS=$(q "select max(id) from metadata.time_slot_series where group_id=(select group_id from metadata.time_slot_series where id=$SS)")
check "the edited occurrence was saved in the same call" "rsst-split-later|2026-11-11 18:00:00+00" \
  "$(q "select purpose||'|'||lower(time_slot) from reservation_requests where id=$ES")"
check "the edited occurrence is not an exception (it matches the new version)" "f" "$(q "select is_exception from metadata.time_slot_instances where entity_id=$ES")"
check "the following occurrences moved to 13:00 with the new purpose" "2" \
  "$(q "select count(*) from reservation_requests r join metadata.time_slot_instances i on i.entity_id=r.id where i.series_id=$NS and i.occurrence_date > '2026-11-11' and r.purpose='rsst-split-later' and to_char(lower(r.time_slot) at time zone 'America/New_York','HH24:MI')='13:00'")"
check "COUNT stays a series total (4 - 1 before the split)" "3" "$(q "select substring(rrule from 'COUNT=(\d+)') from metadata.time_slot_series where id=$NS")"
R=$(rpc "$EDITOR_TOKEN" split_series_from_date "{\"p_series_id\":$SS,\"p_split_date\":\"2026-11-11\",\"p_new_dtstart\":\"2026-11-11T13:00:00\"}")
check "a second split of the old version (a retried save) is refused" "4" "${R:0:1}"
R=$(rpc "$EDITOR_TOKEN" split_series_from_date "{\"p_series_id\":$NS,\"p_split_date\":\"2026-11-11\",\"p_new_dtstart\":\"2026-11-11T14:00:00\"}")
check "a second split of the group on the same date is refused" "4" "${R:0:1}"
check "no extra version was created" "2" "$(q "select count(*) from metadata.time_slot_series where group_id=(select group_id from metadata.time_slot_series where id=$SS)")"

SD=$(create_series "$EDITOR_TOKEN" "rsst-daily" "FREQ=DAILY;COUNT=4" "2026-11-02T15:00:00")
wait_instances "$SD" 4
R=$(rpc "$EDITOR_TOKEN" split_series_from_date "{\"p_series_id\":$SD,\"p_split_date\":\"2026-11-03\",\"p_new_dtstart\":\"2026-11-02T16:00:00\"}")
check "moving a daily occurrence onto the previous one is refused" "4" "${R:0:1}"
ED=$(entity_on "$SD" 2026-11-05)
patch "$EDITOR_TOKEN" "$ED" '{"notes":"rsst edited later occurrence"}' >/dev/null
R=$(rpc "$EDITOR_TOKEN" split_series_from_date "{\"p_series_id\":$SD,\"p_split_date\":\"2026-11-04\",\"p_new_dtstart\":\"2026-11-05T15:00:00\"}")
check "a day shift that would detach an edited following occurrence is refused" "4" "${R:0:1}"
R=$(rpc "$EDITOR_TOKEN" split_series_from_date "{\"p_series_id\":$SD,\"p_split_date\":\"2026-11-04\",\"p_new_dtstart\":\"2026-11-04T17:00:00\"}")
check "a 5-parameter split call (no edited occurrence) still works" "2" "${R:0:1}"

# -----------------------------------------------------------------------------
section "5. time_slot_series.timezone must be an exact IANA name"
for tz in "america/new_york" "+05:30" "EST5EDT_bogus"; do
  R=$(rpc "$ADMIN_TOKEN" create_recurring_series "{\"p_group_name\":\"rsst-tz\",\"p_group_description\":null,\"p_group_color\":null,\"p_entity_table\":\"reservation_requests\",\"p_entity_template\":{\"purpose\":\"rsst-tz\"},\"p_rrule\":\"FREQ=WEEKLY;COUNT=1\",\"p_dtstart\":\"2026-11-04T10:00:00\",\"p_duration\":\"01:00:00\",\"p_timezone\":\"$tz\",\"p_time_slot_property\":\"time_slot\",\"p_expand_now\":false,\"p_skip_conflicts\":false}")
  check "timezone '$tz' is rejected" "4" "${R:0:1}"
done
R=$(rpc "$ADMIN_TOKEN" create_recurring_series "{\"p_group_name\":\"rsst-tz\",\"p_group_description\":null,\"p_group_color\":null,\"p_entity_table\":\"reservation_requests\",\"p_entity_template\":{\"purpose\":\"rsst-tz\"},\"p_rrule\":\"FREQ=WEEKLY;COUNT=1\",\"p_dtstart\":\"2026-11-04T10:00:00\",\"p_duration\":\"01:00:00\",\"p_timezone\":\"America/New_York\",\"p_time_slot_property\":\"time_slot\",\"p_expand_now\":false,\"p_skip_conflicts\":false}")
check "timezone 'America/New_York' is accepted" "2" "${R:0:1}"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
