#!/bin/bash
# =============================================================================
# Functional Test: v0-81-4 revoke TEMPORARY from PUBLIC (CVE-2026-6460 hardening)
# =============================================================================
# Verifies that after the migration:
#   1. PUBLIC holds CONNECT but not TEMPORARY on the Civic OS database
#   2. web_anon, authenticated and authenticator cannot create a temporary table
#   3. A login role set up by the documented read-only recipe (civic_os_mcp_readonly) cannot either
#   4. The database owner keeps TEMPORARY, so migrations that use temporary tables still deploy
#   5. A role granted TEMPORARY explicitly can still create a temporary table
#   6. Reading data as a read-only role still works
#
# Each case runs as the target role through SET ROLE inside a transaction that is rolled back, so the test
# leaves no roles, grants or tables behind. Connect as a superuser (the default) to allow SET ROLE.
#
# Usage (run against a fully migrated database):
#   DATABASE_URL=postgres://... ./tests/functional/v0-81-4-revoke-public-temp-test.sh
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0

# run_case <description> <sql>: passes when the SQL runs without error. Each SQL body raises on failure.
run_case() {
  local name="$1" sql="$2" out
  if out=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -At -c "$sql" 2>&1); then
    echo -e "  ${GREEN}PASS${NC} $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $name"
    echo "$out" | sed 's/^/       /'
    FAIL=$((FAIL + 1))
  fi
}

# expect_temp_denied <role>: SET ROLE, try CREATE TEMP TABLE, require insufficient_privilege.
expect_temp_denied_sql() {
  cat <<SQL
BEGIN;
SET LOCAL ROLE $1;
DO \$\$
BEGIN
  BEGIN
    CREATE TEMP TABLE v0_81_4_probe (x int) ON COMMIT DROP;
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN;
  END;
  RAISE EXCEPTION 'role % created a temporary table', current_user;
END \$\$;
ROLLBACK;
SQL
}

echo "v0-81-4 revoke TEMPORARY from PUBLIC"

run_case "PUBLIC lacks TEMPORARY and keeps CONNECT" "
DO \$\$
BEGIN
  IF has_database_privilege('public', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'PUBLIC holds TEMPORARY';
  END IF;
  IF NOT has_database_privilege('public', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'PUBLIC lost CONNECT';
  END IF;
END \$\$;"

for role in web_anon authenticated authenticator; do
  run_case "$role cannot create a temporary table" "$(expect_temp_denied_sql "$role")"
done

# Mirrors the read-only role recipe in docs/INTEGRATOR_GUIDE.md and infrastructure/vps/README.md.
run_case "a read-only role from the documented recipe cannot create a temporary table" "
BEGIN;
CREATE ROLE v0_81_4_readonly NOLOGIN;
GRANT web_anon TO v0_81_4_readonly;
GRANT USAGE ON SCHEMA public, metadata TO v0_81_4_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO v0_81_4_readonly;
$(expect_temp_denied_sql v0_81_4_readonly | sed '1d;$d')
ROLLBACK;"

run_case "a read-only role can still read data" "
BEGIN;
CREATE ROLE v0_81_4_reader NOLOGIN;
GRANT web_anon TO v0_81_4_reader;
GRANT USAGE ON SCHEMA public TO v0_81_4_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO v0_81_4_reader;
SET LOCAL ROLE v0_81_4_reader;
SELECT count(*) FROM public.schema_entities;
SELECT count(*) FROM public.statuses;
ROLLBACK;"

run_case "the database owner keeps TEMPORARY" "
DO \$\$
DECLARE v_owner name;
BEGIN
  SELECT pg_get_userbyid(datdba) INTO v_owner FROM pg_database WHERE datname = current_database();
  IF NOT has_database_privilege(v_owner, current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'owner % lost TEMPORARY', v_owner;
  END IF;
END \$\$;"

run_case "an explicit TEMPORARY grant still lets a role create a temporary table" "
BEGIN;
CREATE ROLE v0_81_4_granted NOLOGIN;
DO \$\$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO v0_81_4_granted', current_database()); END \$\$;
SET LOCAL ROLE v0_81_4_granted;
CREATE TEMP TABLE v0_81_4_probe (x int) ON COMMIT DROP;
ROLLBACK;"

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
