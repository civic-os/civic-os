#!/bin/bash
# =============================================================================
# Functional Test: v0-84-0 install path without a JWT
# =============================================================================
# Covers the _is_db_admin() guard on create_schema_decision() and set_domain_version(), the internal
# writer metadata._set_domain_version(), and bump_domain_version():
#   1. The deployment role (postgres, no JWT) records a decision (author NULL), sets and bumps the
#      domain version: 1.3.0 + minor = 1.4.0; 1.4.0-rc.1 + minor = 1.5.0; + patch keeps the floor;
#      + major with a new floor; 0.0.0 + minor = 0.1.0. The decision checks (23502, 23503, 23505) and a
#      bad part (22023) refuse, changing nothing.
#   2. A non-superuser login role with CREATEROLE (a managed database admin) is admitted.
#   3. PostgREST's login role (authenticator) with a non-admin JWT is refused with 42501 by all three;
#      with an admin JWT it is admitted and author_id is the JWT subject; web_anon cannot execute.
#   4. Two concurrent bumps apply one after the other (the row lock): each gets its own version.
#   5. Over PostgREST with real Keycloak tokens: testuser is refused (403), testadmin passes the guard.
#
# Sections 1 to 3 run in one transaction that is rolled back. Section 4 commits two decisions and two
# bumps, then restores the domain version row and deletes the decisions. Section 5 changes nothing (it
# calls with an invalid part, which is refused after the guard).
#
# Usage:
#   ./tests/functional/v0-84-0-install-path-test.sh
#
# Environment overrides (the psql user must be a superuser):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
#   POSTGREST_URL  http://localhost:3000     KEYCLOAK_URL  http://localhost:8082
#   SKIP_API=1     skip section 5 (no PostgREST or Keycloak running)
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -uo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"
POSTGREST_URL="${POSTGREST_URL:-http://localhost:3000}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8082}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-civic-os-dev}"
KEYCLOAK_CLIENT="${KEYCLOAK_CLIENT:-civic-os-dev-client}"

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0
pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atq -c "$1"; }

# -----------------------------------------------------------------------------
echo -e "${BOLD}1-3. Guard, writer and bump arithmetic (rolled back)${NC}"
# -----------------------------------------------------------------------------
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

CREATE FUNCTION pg_temp.expect_sqlstate(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE = p_state;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_sqlstate(text, text) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- 1. The deployment role, no JWT
-- ---------------------------------------------------------------------------
DO $$
DECLARE d1 int; d2 int; d3 int; d4 int; d5 int; d6 int; d7 int; v text;
BEGIN
  ASSERT current_setting('is_superuser') = 'on', 'section 1 runs as a superuser';

  d1 := public.create_schema_decision(p_title := 'ip one', p_decision := 'one', p_migration_id := 'ip@1');
  ASSERT (SELECT author_id FROM metadata.schema_decisions WHERE id = d1) IS NULL, 'a decision without a JWT has no author';
  ASSERT (SELECT migration_id FROM metadata.schema_decisions WHERE id = d1) = 'ip@1', 'the decision is recorded';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.create_schema_decision('t', 'd', p_status := 'nope')$q$, 'P0001'),
    'create_schema_decision keeps its validation';

  d2 := public.create_schema_decision('ip two', 'two');
  d3 := public.create_schema_decision('ip three', 'three');
  d4 := public.create_schema_decision('ip four', 'four');
  d5 := public.create_schema_decision('ip five', 'five');
  d6 := public.create_schema_decision('ip six', 'six');
  d7 := public.create_schema_decision('ip seven', 'seven');

  PERFORM public.set_domain_version('1.3.0', '1.0.0', 'ip-set', d1);
  ASSERT (SELECT domain_version FROM metadata.domain_version) = '1.3.0', 'set_domain_version works without a JWT';

  v := public.bump_domain_version('minor', 'ip@minor', d2);
  ASSERT v = '1.4.0', format('1.3.0 + minor = 1.4.0, got %s', v);
  ASSERT (SELECT domain_version FROM metadata.domain_version) = '1.4.0', 'the row holds the new version';
  ASSERT (SELECT min_client_domain_version FROM metadata.domain_version) = '1.0.0', 'the floor is kept';
  ASSERT (SELECT set_by_migration FROM metadata.domain_version) = 'ip@minor', 'the migration is recorded';
  ASSERT (SELECT decision_id FROM metadata.domain_version) = d2, 'the decision is linked';
  ASSERT (SELECT domain_version FROM metadata.schema_decisions WHERE id = d2) = '1.4.0', 'the decision is stamped';

  -- the decision checks live once, in the internal writer, and refuse without changing anything
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.bump_domain_version('minor', 'm', NULL)$q$, '23502'),
    'bump without a decision is refused (23502)';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.bump_domain_version('minor', 'm', 999999999)$q$, '23503'),
    'bump with a nonexistent decision is refused (23503)';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.bump_domain_version('minor', 'm', %s)$q$, d1), '23505'),
    'bump with a decision linked to another version is refused (23505)';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.bump_domain_version('huge', 'm', %s)$q$, d3), '22023'),
    'an unknown part is refused (22023)';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.bump_domain_version(NULL, 'm', %s)$q$, d3), '22023'),
    'a NULL part is refused (22023)';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.bump_domain_version('minor', ' ', %s)$q$, d3), '22023'),
    'an empty migration name is refused (22023)';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.bump_domain_version('minor', 'm', %s, '9.0.0')$q$, d3), '22023'),
    'a floor above the new version is refused (22023)';
  ASSERT (SELECT domain_version FROM metadata.domain_version) = '1.4.0', 'refused bumps changed nothing';
  ASSERT (SELECT domain_version FROM metadata.schema_decisions WHERE id = d3) IS NULL, 'refused bumps stamped nothing';

  -- pre-release and build metadata are dropped before raising
  PERFORM public.set_domain_version('1.4.0-rc.1+build.7', '1.0.0', 'ip-rc', d3);
  v := public.bump_domain_version('minor', 'ip@rc-minor', d4);
  ASSERT v = '1.5.0', format('1.4.0-rc.1 + minor = 1.5.0, got %s', v);

  v := public.bump_domain_version('patch', 'ip@patch', d5);
  ASSERT v = '1.5.1', format('1.5.0 + patch = 1.5.1, got %s', v);
  ASSERT (SELECT min_client_domain_version FROM metadata.domain_version) = '1.0.0', 'a patch keeps the floor';

  v := public.bump_domain_version('major', 'ip@major', d6, '2.0.0');
  ASSERT v = '2.0.0', format('1.5.1 + major = 2.0.0, got %s', v);
  ASSERT (SELECT min_client_domain_version FROM metadata.domain_version) = '2.0.0', 'a given floor replaces the old one';

  -- from the seeded state
  UPDATE metadata.domain_version SET domain_version = '0.0.0', min_client_domain_version = NULL, decision_id = NULL;
  v := public.bump_domain_version('minor', 'ip@first', d7);
  ASSERT v = '0.1.0', format('0.0.0 + minor = 0.1.0, got %s', v);
  ASSERT (SELECT min_client_domain_version FROM metadata.domain_version) IS NULL, 'no floor stays no floor';

  -- the internal writer is not callable by API roles
  ASSERT NOT has_function_privilege('authenticated', 'metadata._set_domain_version(text,text,text,integer)', 'EXECUTE'),
    'authenticated cannot call the internal writer';
END $$;

-- ---------------------------------------------------------------------------
-- 2. A managed database admin: a login role with CREATEROLE, not a superuser
-- ---------------------------------------------------------------------------
CREATE ROLE ip_managed_admin LOGIN CREATEROLE;
GRANT EXECUTE ON FUNCTION public.create_schema_decision(text, text, name[], name[], text, text, text, text, text, integer),
                          public.bump_domain_version(text, text, integer, text) TO ip_managed_admin;
SET LOCAL SESSION AUTHORIZATION ip_managed_admin;
DO $$
DECLARE d int; v text;
BEGIN
  ASSERT current_setting('is_superuser') = 'off', 'section 2 runs without superuser';
  d := public.create_schema_decision('ip managed', 'managed');
  v := public.bump_domain_version('minor', 'ip@managed', d);
  ASSERT v = '0.2.0', format('a CREATEROLE login bumps the version, got %s', v);
END $$;
RESET SESSION AUTHORIZATION;

-- ---------------------------------------------------------------------------
-- 3. PostgREST's login role: the JWT decides
-- ---------------------------------------------------------------------------
INSERT INTO metadata.civic_os_users (id, display_name)
VALUES ('00000000-0000-0000-0000-0000000084a1', 'IP Admin') ON CONFLICT DO NOTHING;
SELECT set_config('ip.d', public.create_schema_decision('ip api', 'api')::text, true);

-- non-admin JWT
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000084a2","role":"authenticated","roles":["manager"]}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.create_schema_decision('t', 'd')$q$, '42501'),
    'create_schema_decision refuses a non-admin JWT (42501)';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.set_domain_version('5.0.0', NULL, 'm', %s)$q$, current_setting('ip.d')), '42501'),
    'set_domain_version refuses a non-admin JWT (42501)';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.bump_domain_version('minor', 'm', %s)$q$, current_setting('ip.d')), '42501'),
    'bump_domain_version refuses a non-admin JWT (42501)';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT metadata._set_domain_version('5.0.0', NULL, 'm', %s)$q$, current_setting('ip.d')), '42501'),
    'the internal writer is not executable (42501)';
END $$;
RESET ROLE;

-- web_anon: no EXECUTE
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.bump_domain_version('minor', 'm', %s)$q$, current_setting('ip.d')), '42501'),
    'web_anon cannot execute bump_domain_version';
END $$;
RESET ROLE;

-- admin JWT
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000084a1","role":"authenticated","roles":["admin"]}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE d int; v text;
BEGIN
  d := public.create_schema_decision('ip admin', 'admin');
  ASSERT (SELECT author_id FROM metadata.schema_decisions WHERE id = d) = '00000000-0000-0000-0000-0000000084a1',
    'an admin decision records the JWT subject as author';
  v := public.bump_domain_version('patch', 'ip@admin', d);
  ASSERT v = '0.2.1', format('an admin JWT bumps the version, got %s', v);
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

ROLLBACK;
SQL
then
  pass "deployment role, managed admin, authenticator with non-admin and admin JWTs, bump arithmetic"
else
  fail "guard, writer or bump checks (see the assertion above)"
fi

# -----------------------------------------------------------------------------
echo -e "${BOLD}4. Concurrent bumps apply one after the other${NC}"
# -----------------------------------------------------------------------------
ORIG=$(q "SELECT domain_version || '|' || coalesce(min_client_domain_version, '') || '|' || set_by_migration || '|' || coalesce(decision_id::text, '') FROM metadata.domain_version")
IFS='|' read -r O_VER O_FLOOR O_MIG O_DEC <<< "$ORIG"
DA=$(q "SELECT public.create_schema_decision('ip concurrent a', 'a')")
DB=$(q "SELECT public.create_schema_decision('ip concurrent b', 'b')")
cleanup_concurrency() {
  q "UPDATE metadata.domain_version SET domain_version = '$O_VER',
       min_client_domain_version = NULLIF('$O_FLOOR', ''), set_by_migration = '$O_MIG',
       decision_id = NULLIF('$O_DEC', '')::int;
     DELETE FROM metadata.schema_decisions WHERE id IN ($DA, $DB);" >/dev/null
}
trap cleanup_concurrency EXIT

OUT_A=$(mktemp)
psql "$DATABASE_URL" -Atq -v ON_ERROR_STOP=1 > "$OUT_A" 2>&1 <<SQL &
BEGIN;
SELECT public.bump_domain_version('minor', 'ip@concurrent-a', $DA);
SELECT pg_sleep(2);
COMMIT;
SQL
PID_A=$!
sleep 0.7
VB=$(q "SELECT public.bump_domain_version('minor', 'ip@concurrent-b', $DB)")
wait $PID_A
VA=$(head -1 "$OUT_A"); rm -f "$OUT_A"
BASE_MAJOR=$(echo "$O_VER" | sed 's/[-+].*//' | cut -d. -f1)
BASE_MINOR=$(echo "$O_VER" | sed 's/[-+].*//' | cut -d. -f2)
check "the first bump (holding the lock) gets the next minor" "$BASE_MAJOR.$((BASE_MINOR + 1)).0" "$VA"
check "the second bump waits and gets the one after" "$BASE_MAJOR.$((BASE_MINOR + 2)).0" "$VB"
check "the row holds the second bump" "$VB" "$(q "SELECT domain_version FROM metadata.domain_version")"
check "each decision is stamped with its own version" "$VA,$VB" \
  "$(q "SELECT string_agg(domain_version, ',' ORDER BY id) FROM metadata.schema_decisions WHERE id IN ($DA, $DB)")"
cleanup_concurrency
trap - EXIT
check "the domain version row is restored" "$O_VER" "$(q "SELECT domain_version FROM metadata.domain_version")"

# -----------------------------------------------------------------------------
echo -e "${BOLD}5. Over PostgREST with Keycloak tokens${NC}"
# -----------------------------------------------------------------------------
if [ "${SKIP_API:-0}" = "1" ]; then
  echo "  (skipped: SKIP_API=1)"
else
  token() {
    curl -s -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
      -d grant_type=password -d client_id="$KEYCLOAK_CLIENT" -d username="$1" -d password="$1" |
      python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])"
  }
  rpc_status() { # token json -> "<http status> <SQLSTATE> <message>"
    local body; body=$(mktemp)
    local status
    status=$(curl -s -o "$body" -w "%{http_code}" -X POST "$POSTGREST_URL/rpc/bump_domain_version" \
      ${1:+-H "Authorization: Bearer $1"} -H "Content-Type: application/json" -d "$2")
    echo "$status $(python3 -c "import sys,json
try:
  b=json.load(open('$body')); print(b.get('code',''), b.get('message',''))
except Exception: print('')")"
    rm -f "$body"
  }
  BEFORE=$(q "SELECT domain_version FROM metadata.domain_version")
  USER_TOKEN=$(token testuser)
  ADMIN_TOKEN=$(token testadmin)
  # An invalid part is refused after the guard, so the call changes nothing either way. PostgREST v16
  # answers 401 to any 42501; the message tells the guard's refusal from a missing EXECUTE grant.
  check "testuser is refused by the guard" "401 42501 Admin access required" \
    "$(rpc_status "$USER_TOKEN" '{"p_part":"huge","p_migration":"m","p_decision_id":1}')"
  check "anonymous cannot execute" "401 42501 permission denied for function bump_domain_version" \
    "$(rpc_status "" '{"p_part":"huge","p_migration":"m","p_decision_id":1}')"
  check "testadmin passes the guard (then 22023 for the part)" "400 22023 Invalid version part huge: expected major, minor or patch" \
    "$(rpc_status "$ADMIN_TOKEN" '{"p_part":"huge","p_migration":"m","p_decision_id":1}')"
  check "the API calls changed nothing" "$BEFORE" "$(q "SELECT domain_version FROM metadata.domain_version")"
fi

echo ""
echo -e "${BOLD}Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
[ "$FAIL" -eq 0 ]
