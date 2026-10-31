#!/bin/bash
# =============================================================================
# Recurring Series: End a Series From an Occurrence (v0.78.1)
# =============================================================================
# Runs every call through PostgREST with real Keycloak tokens (authenticator ->
# authenticated with JWT claims), never as postgres, which passes _is_db_admin().
# Only the RESTRICT case runs as postgres, inside a transaction it rolls back.
#
# Covers:
#   1. end_series_from_date in the middle of a version: the records before the
#      date stay, the records from it on are gone, the rule ends the day before
#      (effective_until and UNTIL), and a re-run of the worker creates nothing.
#   2. On a version's first day the version is deleted, and the group when empty.
#   3. Exceptions and tombstones from the date on are deleted; earlier ones stay.
#   4. After a split, later versions and their records are deleted; a version
#      that already ended before the date is refused.
#   5. A foreign key that restricts deleting one record aborts the whole call.
#   6. A date that is not an occurrence of the series is refused.
#   7. The bound is the series-local occurrence_date: New York evening and
#      Kolkata early-morning occurrences, whose UTC dates differ from it.
#   8. Authorization: a series owner without delete permission (user, editor),
#      a non-owner editor and anonymous are refused; delete_series_with_instances,
#      delete_series_group and cancel_series_occurrence refuse a series owner
#      without delete permission too; an admin can delete a series that has no
#      group.
#
# Usage:
#   ./tests/functional/v0-78-1-end-series-from-date-test.sh
#
# Environment overrides (defaults match the community-center docker-compose stack):
#   POSTGREST_URL  http://localhost:3000     KEYCLOAK_URL  http://localhost:8082
#   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDB     psql access for setup and assertions
#
# Prerequisites: community-center example running with the consolidated worker
# (expansion), test users testuser (role user), testeditor (update, no delete on
# reservation_requests), testadmin.
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
check_contains() { # name needle haystack
  case "$3" in *"$2"*) echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1));;
  *) echo -e "  ${RED}FAIL${NC} $1 (expected to contain '$2', got '$3')"; FAIL=$((FAIL + 1));; esac
}
q() { psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -Atq -c "$1"; }
token() {
  curl -s -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
    -d grant_type=password -d client_id="$KEYCLOAK_CLIENT" -d username="$1" -d password="$1" |
    python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])"
}
BODY_FILE=$(mktemp); trap 'rm -f "$BODY_FILE"' EXIT
rpc() { # token fn json -> "<http status> <body>"; an empty token calls anonymously
  local auth=(); [ -n "$1" ] && auth=(-H "Authorization: Bearer $1")
  curl -s -o "$BODY_FILE" -w "%{http_code}" -X POST "$POSTGREST_URL/rpc/$2" \
    ${auth[@]+"${auth[@]}"} -H "Content-Type: application/json" -d "$3"
  echo " $(cat "$BODY_FILE")"
}
field() { # "<status> <body>" key -> the body's top-level key
  echo "$1" | sed 's/^[0-9]* //' | python3 -c "import sys,json
try: v=json.load(sys.stdin).get('$2','')
except Exception: v=''
print('' if v is None else str(v).lower() if isinstance(v,bool) else v)"
}
patch() { # token id json -> http status
  curl -s -o /dev/null -w "%{http_code}" -X PATCH "$POSTGREST_URL/reservation_requests?id=eq.$2" \
    -H "Authorization: Bearer $1" -H "Content-Type: application/json" -d "$3"
}
wait_instances() { # series_id count
  for _ in $(seq 1 40); do [ "$(q "select count(*) from metadata.time_slot_instances where series_id=$1")" -ge "$2" ] && return 0; sleep 1; done; return 1
}
end_series() { # token series date
  rpc "$1" end_series_from_date "{\"p_series_id\":$2,\"p_occurrence_date\":\"$3\"}"
}

# Groups left by an earlier run on the same stack
cleanup() {
  q "select delete_series_group(id) from metadata.time_slot_series_groups where display_name like 'v0781-%'" >/dev/null
  q "select set_config('recurring.allow_direct_delete','true',false); delete from metadata.time_slot_series where entity_template->>'purpose' like 'v0781-%'" >/dev/null
  q "delete from reservation_requests where purpose like 'v0781-%'" >/dev/null
}
cleanup

USER_TOKEN=$(token testuser); EDITOR_TOKEN=$(token testeditor); ADMIN_TOKEN=$(token testadmin)
for t in "$USER_TOKEN" "$EDITOR_TOKEN" "$ADMIN_TOKEN"; do rpc "$t" refresh_current_user '{}' >/dev/null; done
PENDING=$(q "select id from metadata.statuses where entity_type='reservation_request' and status_key='pending'")
USER_ID=$(echo "$USER_TOKEN" | cut -d. -f2 | python3 -c "import sys,base64,json;s=sys.stdin.read().strip();s+='='*(-len(s)%4);print(json.loads(base64.urlsafe_b64decode(s))['sub'])")

create_series() { # token name rrule dtstart [timezone] -> series id
  rpc "$1" create_recurring_series "{\"p_group_name\":\"$2\",\"p_group_description\":null,\"p_group_color\":null,
    \"p_entity_table\":\"reservation_requests\",\"p_entity_template\":{\"resource_id\":2,\"purpose\":\"$2\",\"attendee_count\":4,
    \"requested_by\":\"$USER_ID\",\"status_id\":$PENDING},\"p_rrule\":\"$3\",\"p_dtstart\":\"$4\",\"p_duration\":\"01:00:00\",
    \"p_timezone\":\"${5:-America/New_York}\",\"p_time_slot_property\":\"time_slot\",\"p_expand_now\":true,\"p_skip_conflicts\":false}" |
    sed 's/^[0-9]* //' | python3 -c "import sys,json;print(json.load(sys.stdin).get('series_id',''))"
}
entity_on() { q "select entity_id from metadata.time_slot_instances where series_id=$1 and occurrence_date='$2'"; }
group_of() { q "select group_id from metadata.time_slot_series where id=$1"; }
instances() { # series [where] -> count
  q "select count(*) from metadata.time_slot_instances where series_id=$1 ${2:+and $2}"
}
records() { # series [where] -> count of existing entity rows
  q "select count(*) from reservation_requests r join metadata.time_slot_instances i on i.entity_id=r.id where i.series_id=$1 ${2:+and $2}"
}
ids_from() { # series date -> comma-separated entity ids on or after the date
  q "select string_agg(entity_id::text, ',') from metadata.time_slot_instances where series_id=$1 and occurrence_date >= '$2' and entity_id is not null"
}
existing() { # comma-separated ids -> how many still exist
  q "select count(*) from reservation_requests where id = any('{$1}'::bigint[])"
}

# -----------------------------------------------------------------------------
section "1. Mid-version: earlier records stay, the rule ends the day before"
S1=$(create_series "$ADMIN_TOKEN" "v0781-mid" "FREQ=WEEKLY;BYDAY=WE" "2026-12-02T10:00:00")
wait_instances "$S1" 5
GONE=$(ids_from "$S1" 2026-12-16)
N_GONE=$(echo "$GONE" | tr ',' '\n' | grep -c .)
R=$(end_series "$ADMIN_TOKEN" "$S1" 2026-12-16)
check "end_series_from_date succeeds for an admin" "2" "${R:0:1}"
check "it reports success" "true" "$(field "$R" success)"
check "it reports every record it deleted" "$N_GONE" "$(field "$R" entities_deleted)"
check "the records from the date on are gone" "0" "$(existing "$GONE")"
check "their occurrences are gone" "0" "$(instances "$S1" "occurrence_date >= '2026-12-16'")"
check "the two earlier records stay" "2" "$(records "$S1" "occurrence_date < '2026-12-16'")"
check "the version ends the day before" "2026-12-15" "$(q "select effective_until from metadata.time_slot_series where id=$S1")"
check "the rule carries UNTIL the end of that day" "FREQ=WEEKLY;BYDAY=WE;UNTIL=20261215T235959Z" "$(q "select rrule from metadata.time_slot_series where id=$S1")"
q "select expand_series_instances($S1, '2027-06-30')" >/dev/null
for _ in $(seq 1 40); do
  [ "$(q "select state from metadata.river_job where kind='expand_recurring_series' and args->>'series_id'='$S1' order by id desc limit 1")" = "completed" ] && break; sleep 1
done
check "the re-enqueued expansion job completed" "completed" \
  "$(q "select state from metadata.river_job where kind='expand_recurring_series' and args->>'series_id'='$S1' order by id desc limit 1")"
check "the worker created nothing after the end" "2" "$(instances "$S1")"

# -----------------------------------------------------------------------------
section "2. First day of a version: the version and the empty group are deleted"
S2=$(create_series "$ADMIN_TOKEN" "v0781-first" "FREQ=DAILY;COUNT=3" "2026-12-07T11:00:00")
wait_instances "$S2" 3
G2=$(group_of "$S2"); GONE=$(ids_from "$S2" 2026-12-07)
R=$(end_series "$ADMIN_TOKEN" "$S2" 2026-12-07)
check "ending on the first day succeeds" "2" "${R:0:1}"
check "it reports one version deleted" "1" "$(field "$R" versions_deleted)"
check "every record is gone" "0" "$(existing "$GONE")"
check "the version is gone" "0" "$(q "select count(*) from metadata.time_slot_series where id=$S2")"
check "its occurrences are gone" "0" "$(instances "$S2")"
check "the empty group is gone" "0" "$(q "select count(*) from metadata.time_slot_series_groups where id=$G2")"

# -----------------------------------------------------------------------------
section "3. Exceptions and tombstones from the date on are deleted"
S3=$(create_series "$ADMIN_TOKEN" "v0781-exceptions" "FREQ=DAILY;COUNT=6" "2026-12-07T12:00:00")
wait_instances "$S3" 6
E_MOD=$(entity_on "$S3" 2026-12-10)
check "a this-only edit after the date succeeds" "204" "$(patch "$ADMIN_TOKEN" "$E_MOD" '{"notes":"v0781 one-off"}')"
rpc "$ADMIN_TOKEN" cancel_series_occurrence "{\"p_entity_table\":\"reservation_requests\",\"p_entity_id\":$(entity_on "$S3" 2026-12-11)}" >/dev/null
rpc "$ADMIN_TOKEN" cancel_series_occurrence "{\"p_entity_table\":\"reservation_requests\",\"p_entity_id\":$(entity_on "$S3" 2026-12-08)}" >/dev/null
check "the setup holds two tombstones and one modified occurrence" "2|1" \
  "$(q "select count(*) filter (where exception_type='cancelled')||'|'||count(*) filter (where exception_type='modified') from metadata.time_slot_instances where series_id=$S3")"
R=$(end_series "$ADMIN_TOKEN" "$S3" 2026-12-09)
check "ending over exceptions succeeds" "2" "${R:0:1}"
check "the modified occurrence's record is gone" "0" "$(existing "$E_MOD")"
check "no occurrence row from the date on is left, tombstone included" "0" "$(instances "$S3" "occurrence_date >= '2026-12-09'")"
check "the earlier tombstone stays" "cancelled" "$(q "select exception_type from metadata.time_slot_instances where series_id=$S3 and occurrence_date='2026-12-08'")"
check "the earlier record stays" "1" "$(records "$S3")"

# -----------------------------------------------------------------------------
section "4. After a split: later versions go, an ended version is refused"
S4=$(create_series "$ADMIN_TOKEN" "v0781-split" "FREQ=DAILY;COUNT=8" "2026-12-14T13:00:00")
wait_instances "$S4" 8
R=$(rpc "$ADMIN_TOKEN" split_series_from_date "{\"p_series_id\":$S4,\"p_split_date\":\"2026-12-18\",\"p_new_dtstart\":\"2026-12-18T14:00:00\"}")
check "the split succeeds" "2" "${R:0:1}"
G4=$(group_of "$S4"); N4=$(q "select max(id) from metadata.time_slot_series where group_id=$G4")
GONE_LATER=$(q "select string_agg(entity_id::text, ',') from metadata.time_slot_instances where series_id=$N4 and entity_id is not null")
R=$(end_series "$ADMIN_TOKEN" "$S4" 2026-12-19)
check "a date after the version ended is refused" "4" "${R:0:1}"
check_contains "the refusal names the end date" "ended on 2026-12-17" "$(field "$R" message)"
check "the refusal changed nothing" "8" "$(q "select count(*) from metadata.time_slot_instances i join metadata.time_slot_series s on s.id=i.series_id where s.group_id=$G4 and i.entity_id is not null")"
GONE=$(ids_from "$S4" 2026-12-16)
R=$(end_series "$ADMIN_TOKEN" "$S4" 2026-12-16)
check "ending the first version before the split succeeds" "2" "${R:0:1}"
check "it reports the later version deleted" "1" "$(field "$R" versions_deleted)"
check "the later version is gone" "0" "$(q "select count(*) from metadata.time_slot_series where id=$N4")"
check "the later version's records are gone" "0" "$(existing "$GONE_LATER")"
check "the first version's records from the date on are gone" "0" "$(existing "$GONE")"
check "the first version keeps its two earlier records" "2" "$(records "$S4")"
check "the group keeps the first version" "1" "$(q "select count(*) from metadata.time_slot_series where group_id=$G4")"
check "the first version ends the day before" "2026-12-15" "$(q "select effective_until from metadata.time_slot_series where id=$S4")"
check "COUNT gives way to UNTIL" "FREQ=DAILY;UNTIL=20261215T235959Z" "$(q "select rrule from metadata.time_slot_series where id=$S4")"

S4B=$(create_series "$ADMIN_TOKEN" "v0781-split-first-day" "FREQ=DAILY;COUNT=6" "2026-12-14T16:00:00")
wait_instances "$S4B" 6
rpc "$ADMIN_TOKEN" split_series_from_date "{\"p_series_id\":$S4B,\"p_split_date\":\"2026-12-17\",\"p_new_dtstart\":\"2026-12-17T17:00:00\"}" >/dev/null
G4B=$(group_of "$S4B"); N4B=$(q "select max(id) from metadata.time_slot_series where group_id=$G4B")
R=$(end_series "$ADMIN_TOKEN" "$N4B" 2026-12-17)
check "ending a later version on its first day succeeds" "2" "${R:0:1}"
check "the later version is gone" "0" "$(q "select count(*) from metadata.time_slot_series where id=$N4B")"
check "the earlier version and its three records stay" "3" "$(records "$S4B")"
check "the group stays with the earlier version" "1" "$(q "select count(*) from metadata.time_slot_series_groups where id=$G4B")"

# -----------------------------------------------------------------------------
section "5. A restricting foreign key aborts the whole call"
S5=$(create_series "$ADMIN_TOKEN" "v0781-restrict" "FREQ=DAILY;COUNT=4" "2026-12-21T15:00:00")
wait_instances "$S5" 4
HELD=$(entity_on "$S5" 2026-12-23)
OUT=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -Atq <<SQL
BEGIN;
CREATE TABLE public.v0781_hold (id serial PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES public.reservation_requests(id) ON DELETE RESTRICT);
INSERT INTO public.v0781_hold (request_id) VALUES ($HELD);
CREATE TEMP TABLE v0781_out (v text);
DO \$\$ BEGIN
  PERFORM end_series_from_date($S5, '2026-12-22');
  INSERT INTO v0781_out VALUES ('deleted');
EXCEPTION WHEN foreign_key_violation THEN
  INSERT INTO v0781_out VALUES ('restricted');
END \$\$;
SELECT v FROM v0781_out;
SELECT count(*) FROM metadata.time_slot_instances WHERE series_id=$S5 AND entity_id IS NOT NULL;
SELECT count(*) FROM public.reservation_requests r JOIN metadata.time_slot_instances i ON i.entity_id=r.id WHERE i.series_id=$S5;
SELECT coalesce(effective_until::text, 'open') || '|' || rrule FROM metadata.time_slot_series WHERE id=$S5;
ROLLBACK;
SQL
)
check "the call fails on the restricting foreign key" "restricted" "$(echo "$OUT" | sed -n 1p)"
check "every occurrence keeps its record" "4" "$(echo "$OUT" | sed -n 2p)"
check "every record survives" "4" "$(echo "$OUT" | sed -n 3p)"
check "the rule is unchanged" "open|FREQ=DAILY;COUNT=4" "$(echo "$OUT" | sed -n 4p)"
check "the fixture table was rolled back" "" "$(q "select to_regclass('public.v0781_hold')")"

# -----------------------------------------------------------------------------
section "6. A date that is not an occurrence is refused"
R=$(end_series "$ADMIN_TOKEN" "$S5" 2026-12-30)
check "a date outside the series is refused" "4" "${R:0:1}"
check_contains "the refusal names the date" "has no occurrence on 2026-12-30" "$(field "$R" message)"
check "nothing was deleted" "4" "$(records "$S5")"
R=$(end_series "$ADMIN_TOKEN" 999999999 2026-12-22)
check "an unknown series answers success false" "false|Series not found" "$(field "$R" success)|$(field "$R" message)"

# -----------------------------------------------------------------------------
section "7. The bound is the series-local occurrence date"
# 21:00 New York is 02:00Z the next day: the Dec 29 occurrence starts on Dec 30 UTC.
S7N=$(create_series "$ADMIN_TOKEN" "v0781-new-york-evening" "FREQ=DAILY;COUNT=4" "2026-12-28T21:00:00" "America/New_York")
wait_instances "$S7N" 4
KEEP=$(entity_on "$S7N" 2026-12-29); DROP=$(entity_on "$S7N" 2026-12-30)
check "the kept occurrence starts on the end date in UTC" "2026-12-30" "$(q "select (lower(time_slot) at time zone 'UTC')::date from reservation_requests where id=$KEEP")"
end_series "$ADMIN_TOKEN" "$S7N" 2026-12-30 >/dev/null
check "New York: the evening before the date stays" "1" "$(existing "$KEEP")"
check "New York: the occurrence on the date is gone" "0" "$(existing "$DROP")"
check "New York: two records stay" "2" "$(records "$S7N")"
# 02:00 Kolkata is 20:30Z the day before: the Dec 30 occurrence starts on Dec 29 UTC.
S7K=$(create_series "$ADMIN_TOKEN" "v0781-kolkata-early" "FREQ=DAILY;COUNT=4" "2026-12-28T02:00:00" "Asia/Kolkata")
wait_instances "$S7K" 4
KEEP=$(entity_on "$S7K" 2026-12-29); DROP=$(entity_on "$S7K" 2026-12-30)
check "the dropped occurrence starts the day before in UTC" "2026-12-29" "$(q "select (lower(time_slot) at time zone 'UTC')::date from reservation_requests where id=$DROP")"
end_series "$ADMIN_TOKEN" "$S7K" 2026-12-30 >/dev/null
check "Kolkata: the occurrence on the date is gone" "0" "$(existing "$DROP")"
check "Kolkata: the day before stays" "1" "$(existing "$KEEP")"
check "Kolkata: two records stay" "2" "$(records "$S7K")"
check "Kolkata: the rule ends the local day before" "FREQ=DAILY;UNTIL=20261229T235959Z" "$(q "select rrule from metadata.time_slot_series where id=$S7K")"

# -----------------------------------------------------------------------------
section "8. Authorization"
SU=$(create_series "$USER_TOKEN" "v0781-user-owned" "FREQ=DAILY;COUNT=3" "2027-01-04T10:00:00")
wait_instances "$SU" 3
SE=$(create_series "$EDITOR_TOKEN" "v0781-editor-owned" "FREQ=DAILY;COUNT=3" "2027-01-04T12:00:00")
wait_instances "$SE" 3
SA=$(create_series "$ADMIN_TOKEN" "v0781-admin-owned" "FREQ=DAILY;COUNT=3" "2027-01-04T14:00:00")
wait_instances "$SA" 3

R=$(end_series "$USER_TOKEN" "$SU" 2027-01-05)
check "a user who owns the series but lacks delete is refused" "4" "${R:0:1}"
check "  for want of delete permission" "Requires reservation_requests:delete permission" "$(field "$R" hint)"
R=$(end_series "$EDITOR_TOKEN" "$SE" 2027-01-05)
check "an editor who owns the series but lacks delete is refused" "4" "${R:0:1}"
check "  for want of delete permission" "Requires reservation_requests:delete permission" "$(field "$R" hint)"
R=$(end_series "$EDITOR_TOKEN" "$SA" 2027-01-05)
check "an editor who does not own the series is refused" "4" "${R:0:1}"
check "  for not owning it" "Must be the series owner or an admin" "$(field "$R" hint)"
R=$(end_series "" "$SA" 2027-01-05)
check "anonymous is refused" "4" "${R:0:1}"
check "no refused call deleted anything" "3|3|3" "$(records "$SU")|$(records "$SE")|$(records "$SA")"

for who in USER EDITOR; do
  tok_var="${who}_TOKEN"; tok="${!tok_var}"; [ "$who" = USER ] && S="$SU" || S="$SE"
  lower=$(echo "$who" | tr '[:upper:]' '[:lower:]')
  R=$(rpc "$tok" delete_series_with_instances "{\"p_series_id\":$S}")
  check "delete_series_with_instances refuses the $lower owner without delete" "4|Requires reservation_requests:delete permission" "${R:0:1}|$(field "$R" hint)"
  R=$(rpc "$tok" delete_series_group "{\"p_group_id\":$(group_of "$S")}")
  check "delete_series_group refuses the $lower owner without delete" "4|Requires reservation_requests:delete permission" "${R:0:1}|$(field "$R" hint)"
  E=$(entity_on "$S" 2027-01-04)
  R=$(rpc "$tok" cancel_series_occurrence "{\"p_entity_table\":\"reservation_requests\",\"p_entity_id\":$E}")
  check "cancel_series_occurrence refuses the $lower owner without delete" "4|Requires reservation_requests:delete permission" "${R:0:1}|$(field "$R" hint)"
  check "the $lower's series is intact" "3|0" "$(records "$S")|$(instances "$S" "is_exception")"
done

R=$(rpc "$ADMIN_TOKEN" delete_series_with_instances "{\"p_series_id\":$SE}")
check "delete_series_with_instances succeeds for an admin" "2|3" "${R:0:1}|$(field "$R" entities_deleted)"
R=$(rpc "$ADMIN_TOKEN" delete_series_group "{\"p_group_id\":$(group_of "$SU")}")
check "delete_series_group succeeds for an admin" "2|3" "${R:0:1}|$(field "$R" entities_deleted)"

GA=$(group_of "$SA")
q "update metadata.time_slot_series set group_id = null where id=$SA" >/dev/null
q "delete from metadata.time_slot_series_groups where id=$GA" >/dev/null
R=$(rpc "$ADMIN_TOKEN" delete_series_with_instances "{\"p_series_id\":$SA}")
check "an admin can delete a series that has no group" "2|3" "${R:0:1}|$(field "$R" entities_deleted)"
check "the ungrouped series is gone" "0" "$(q "select count(*) from metadata.time_slot_series where id=$SA")"

cleanup

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
