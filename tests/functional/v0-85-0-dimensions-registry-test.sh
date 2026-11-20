#!/bin/bash
# =============================================================================
# Functional Test: v0-85-0 dimensions registry
# =============================================================================
# Covers metadata.dimensions, register_dimension(), set_dimension_default(), dimension_subtree(), the delete,
# truncate, parent-cycle and default-fill triggers, schema_dimensions, and dimension elements in
# compare_interface():
#   1. (rolled back)
#      - Registration as the deployment role installs the delete and truncate guards, the parent guard, and a
#        fill trigger on every referencing FK column (other schemas included), not on the table's own parent.
#      - Fill: an insert without the column gets the default (a NOT NULL column too, since BEFORE triggers run
#        first); an explicit value is kept; updates are untouched; a retired default is skipped and comes
#        back when the row is reactivated; set_dimension_default() changes or clears it and refuses a missing
#        (23503) or retired (22023) row; a re-registration with a NULL default keeps the current one.
#      - Rows cannot be deleted or truncated (23514, dimension_row_delete); parent cycles are refused.
#      - dimension_subtree(): a value and its descendants; flat dimensions; an unknown key (22023).
#      - Refused registrations: non-BIGINT or non-unique key, missing or non-boolean active column, parent
#        without a self FK, an existing cycle (23514), a key registered for another table or a table under
#        another key (23505), a malformed key, a view, a missing (23503) or retired (22023) default.
#      - Over the API (authenticator): a non-admin JWT is refused (42501); an admin JWT registers public
#        tables only (42501 otherwise) and installs fill triggers only on public referencing tables; the
#        deployment role then adds the rest.
#      - compare_interface(): a matching declaration, missing_dimension, a different table, a different
#        column role, and a stale registry row after a column rename.
#      - A synthetic Program install end to end: assert_interface, create, seed, register_dimension,
#        bump_domain_version with a schema decision, register_module; a pack's checks then pass.
#   2. (committed, cleaned up) Over PostgREST with Keycloak tokens: an insert without the dimension column is
#      filled; deleting a dimension row answers 400 / 23514 naming dimension_row_delete; schema_dimensions
#      and dimension_subtree are readable.
#
# Usage:
#   ./tests/functional/v0-85-0-dimensions-registry-test.sh
#
# Environment overrides (the psql user must be a superuser):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
#   POSTGREST_URL  http://localhost:3000     KEYCLOAK_URL  http://localhost:8082
#   SKIP_API=1     skip section 2 (no PostgREST or Keycloak running)
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
check_contains() { case "$3" in *"$2"*) pass "$1";; *) fail "$1 (expected to contain '$2', got '$3')";; esac; }
q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atq -c "$1"; }

# -----------------------------------------------------------------------------
echo -e "${BOLD}1. Registry, triggers, RPCs and interface checks (rolled back)${NC}"
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

CREATE FUNCTION pg_temp.triggers(p_table regclass) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(tgname, ',' ORDER BY tgname), '') FROM pg_trigger WHERE tgrelid = p_table AND NOT tgisinternal
$$;
CREATE FUNCTION pg_temp.dim(p_element jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(difference || coalesce(':' || column_name, ''), ',' ORDER BY column_name NULLS FIRST, difference), '')
  FROM public.compare_interface(jsonb_build_object('elements', jsonb_build_array(p_element || '{"element":"dimension"}')))
$$;
GRANT EXECUTE ON FUNCTION pg_temp.triggers(regclass), pg_temp.dim(jsonb) TO PUBLIC;

-- programs: 1 General > 2 Youth > 3 Teens; 4 Retired (inactive)
CREATE TABLE public.dm_programs (
  id BIGSERIAL PRIMARY KEY,
  parent_id BIGINT REFERENCES public.dm_programs(id),
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  qb_class TEXT
);
CREATE INDEX ON public.dm_programs(parent_id);
INSERT INTO public.dm_programs (id, parent_id, display_name, is_active) VALUES
  (1, NULL, 'General', true), (2, 1, 'Youth', true), (3, 2, 'Teens', true), (4, NULL, 'Retired', false);
CREATE TABLE public.dm_enrollments (id BIGSERIAL PRIMARY KEY, program_id BIGINT REFERENCES public.dm_programs(id), note TEXT);
CREATE INDEX ON public.dm_enrollments(program_id);
CREATE TABLE public.dm_events (id BIGSERIAL PRIMARY KEY, program_id BIGINT NOT NULL REFERENCES public.dm_programs(id), note TEXT);
CREATE INDEX ON public.dm_events(program_id);
CREATE SCHEMA dm_fx;
CREATE TABLE dm_fx.links (id BIGSERIAL PRIMARY KEY, program_id BIGINT REFERENCES public.dm_programs(id));
CREATE INDEX ON dm_fx.links(program_id);

-- ---------------------------------------------------------------------------
-- Registration as the deployment role
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM public.register_dimension('dm_program', 'Program', 'public', 'dm_programs',
    p_parent_column := 'parent_id', p_external_id_column := 'qb_class', p_default_value_id := 1);

  ASSERT pg_temp.triggers('public.dm_programs') = 'dimension_delete_guard,dimension_truncate_guard,tree_parent_guard',
    format('dimension table triggers: %s', pg_temp.triggers('public.dm_programs'));
  ASSERT pg_temp.triggers('public.dm_enrollments') = 'dimension_default_program_id', 'fill trigger on a referencing table';
  ASSERT pg_temp.triggers('public.dm_events') = 'dimension_default_program_id', 'and on a NOT NULL referencing column';
  ASSERT pg_temp.triggers('dm_fx.links') = 'dimension_default_program_id', 'the deployment role also fills other schemas';
  ASSERT (SELECT default_value_id FROM metadata.dimensions WHERE dimension_key = 'dm_program') = 1, 'registry row';
END $$;

-- ---------------------------------------------------------------------------
-- Default fill, retirement, set_dimension_default()
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v BIGINT;
BEGIN
  INSERT INTO public.dm_enrollments (note) VALUES ('no program') RETURNING program_id INTO v;
  ASSERT v = 1, 'an insert without the column gets the default';
  INSERT INTO public.dm_events (note) VALUES ('required column') RETURNING program_id INTO v;
  ASSERT v = 1, 'a NOT NULL column is filled before the NOT NULL check';
  INSERT INTO public.dm_enrollments (program_id, note) VALUES (3, 'chosen') RETURNING program_id INTO v;
  ASSERT v = 3, 'an explicit value is kept';
  INSERT INTO dm_fx.links DEFAULT VALUES RETURNING program_id INTO v;
  ASSERT v = 1, 'filled in another schema';
  UPDATE public.dm_enrollments SET program_id = NULL WHERE note = 'chosen';
  ASSERT (SELECT program_id FROM public.dm_enrollments WHERE note = 'chosen') IS NULL, 'updates are not filled';

  -- retire the default: skipped, and the NOT NULL column now fails as it would without the trigger
  UPDATE public.dm_programs SET is_active = false WHERE id = 1;
  INSERT INTO public.dm_enrollments (note) VALUES ('retired default') RETURNING program_id INTO v;
  ASSERT v IS NULL, 'a retired default is skipped';
  ASSERT pg_temp.expect_sqlstate($q$INSERT INTO public.dm_events (note) VALUES ('x')$q$, '23502'),
    'without a default the NOT NULL column refuses the insert';
  ASSERT (SELECT default_value_id FROM metadata.dimensions WHERE dimension_key = 'dm_program') = 1, 'the setting is kept';
  UPDATE public.dm_programs SET is_active = true WHERE id = 1;
  INSERT INTO public.dm_enrollments (note) VALUES ('reactivated') RETURNING program_id INTO v;
  ASSERT v = 1, 'reactivating the row brings the default back';

  -- set_dimension_default()
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.set_dimension_default('dm_program', 4)$q$, '22023'), 'a retired row is refused';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.set_dimension_default('dm_program', 999)$q$, '23503'), 'a missing row is refused';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.set_dimension_default('dm_nope', 1)$q$, '22023'), 'an unknown dimension is refused';
  PERFORM public.set_dimension_default('dm_program', 2);
  INSERT INTO public.dm_enrollments (note) VALUES ('new default') RETURNING program_id INTO v;
  ASSERT v = 2, 'the new default is filled';

  -- a re-registration with a NULL default keeps the current one
  PERFORM public.register_dimension('dm_program', 'Program', 'public', 'dm_programs', p_parent_column := 'parent_id');
  ASSERT (SELECT default_value_id FROM metadata.dimensions WHERE dimension_key = 'dm_program') = 2, 're-registering keeps the default';
  ASSERT (SELECT external_id_column FROM metadata.dimensions WHERE dimension_key = 'dm_program') IS NULL,
    'other settings follow the latest registration';

  PERFORM public.set_dimension_default('dm_program', NULL);
  INSERT INTO public.dm_enrollments (note) VALUES ('cleared') RETURNING program_id INTO v;
  ASSERT v IS NULL, 'a cleared default fills nothing';
END $$;

-- ---------------------------------------------------------------------------
-- Delete and truncate guards, parent cycles, dimension_subtree()
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_state text; v_msg text; v_hint text;
BEGIN
  BEGIN
    DELETE FROM public.dm_programs WHERE id = 4;
    RAISE EXCEPTION 'no error';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_hint = PG_EXCEPTION_HINT;
  END;
  ASSERT v_state = '23514', format('delete refused with 23514, got %s', v_state);
  ASSERT v_msg = 'delete on relation "dm_programs" violates check constraint "dimension_row_delete"', format('message: %s', v_msg);
  ASSERT v_hint = 'Set is_active to false instead.', format('hint: %s', v_hint);
  ASSERT pg_temp.expect_sqlstate('TRUNCATE public.dm_programs CASCADE', '23514'), 'truncate refused';
  ASSERT pg_temp.expect_sqlstate('UPDATE public.dm_programs SET parent_id = 3 WHERE id = 1', '23514'), 'parent cycle refused';

  ASSERT (SELECT array_agg(x ORDER BY x) FROM public.dimension_subtree('dm_program', 1) x) = ARRAY[1, 2, 3]::bigint[], 'subtree of the root';
  ASSERT (SELECT array_agg(x ORDER BY x) FROM public.dimension_subtree('dm_program', 2) x) = ARRAY[2, 3]::bigint[], 'subtree of a child';
  ASSERT (SELECT array_agg(x) FROM public.dimension_subtree('dm_program', 3) x) = ARRAY[3]::bigint[], 'a leaf';
  ASSERT NOT EXISTS (SELECT 1 FROM public.dimension_subtree('dm_program', 999)), 'a missing value has no subtree';
  ASSERT pg_temp.expect_sqlstate($q$SELECT * FROM public.dimension_subtree('dm_nope', 1)$q$, '22023'), 'an unknown dimension';
END $$;

-- a flat dimension: no parent guard; re-registering a hierarchy as flat drops the guard
CREATE TABLE public.dm_sites (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE);
INSERT INTO public.dm_sites (id, name) VALUES (1, 'Main');
DO $$
BEGIN
  PERFORM public.register_dimension('dm_site', 'Site', 'public', 'dm_sites', p_label_column := 'name', p_active_column := 'active');
  ASSERT pg_temp.triggers('public.dm_sites') = 'dimension_delete_guard,dimension_truncate_guard', 'no parent guard on a flat table';
  ASSERT (SELECT array_agg(x) FROM public.dimension_subtree('dm_site', 1) x) = ARRAY[1]::bigint[], 'a flat subtree is the value';

  PERFORM public.register_dimension('dm_program', 'Program', 'public', 'dm_programs');
  ASSERT pg_temp.triggers('public.dm_programs') = 'dimension_delete_guard,dimension_truncate_guard',
    'registering without a parent drops the parent guard';
  PERFORM public.register_dimension('dm_program', 'Program', 'public', 'dm_programs', p_parent_column := 'parent_id');
END $$;

-- ---------------------------------------------------------------------------
-- Refused registrations
-- ---------------------------------------------------------------------------
CREATE TABLE public.dm_intkey (id SERIAL PRIMARY KEY, display_name TEXT, is_active BOOLEAN);
CREATE TABLE public.dm_nonunique (id BIGINT, display_name TEXT, is_active BOOLEAN);
CREATE TABLE public.dm_textactive (id BIGSERIAL PRIMARY KEY, display_name TEXT, is_active TEXT);
CREATE TABLE public.dm_noparentfk (id BIGSERIAL PRIMARY KEY, parent_id BIGINT, display_name TEXT, is_active BOOLEAN);
CREATE TABLE public.dm_cyclic (id BIGSERIAL PRIMARY KEY, parent_id BIGINT REFERENCES public.dm_cyclic(id), display_name TEXT, is_active BOOLEAN);
INSERT INTO public.dm_cyclic VALUES (1, NULL, 'a', true), (2, 1, 'b', true);
UPDATE public.dm_cyclic SET parent_id = 2 WHERE id = 1;
CREATE VIEW public.dm_view AS SELECT id, display_name, is_active FROM public.dm_programs;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_x', 'X', 'public', 'dm_intkey')$q$, '22023'), 'integer key';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_x', 'X', 'public', 'dm_nonunique')$q$, '22023'), 'non-unique key';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_x', 'X', 'public', 'dm_textactive')$q$, '22023'), 'text active column';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_x', 'X', 'public', 'dm_sites', p_label_column := 'name', p_active_column := NULL)$q$, '22023'),
    'no active column';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_x', 'X', 'public', 'dm_noparentfk', p_parent_column := 'parent_id')$q$, '22023'),
    'parent without a self FK';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_x', 'X', 'public', 'dm_cyclic', p_parent_column := 'parent_id')$q$, '23514'),
    'a table that already holds a cycle';
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.dimensions WHERE dimension_key = 'dm_x'), 'nothing registered by a refused call';
  ASSERT pg_temp.triggers('public.dm_cyclic') = '', 'and no trigger installed';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_program', 'P', 'public', 'dm_sites', p_label_column := 'name', p_active_column := 'active')$q$, '23505'),
    'a key registered for another table';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_other', 'P', 'public', 'dm_programs')$q$, '23505'),
    'a table registered under another key';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('Bad-Key', 'X', 'public', 'dm_programs')$q$, '22023'), 'malformed key';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_x', 'X', 'public', 'dm_view')$q$, '22023'), 'a view';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_x', 'X', 'public', 'dm_nope')$q$, '22023'), 'a missing table';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_program', 'P', 'public', 'dm_programs', p_default_value_id := 999)$q$, '23503'),
    'a missing default';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_program', 'P', 'public', 'dm_programs', p_default_value_id := 4)$q$, '22023'),
    'a retired default';
END $$;

-- ---------------------------------------------------------------------------
-- compare_interface() dimension elements
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT pg_temp.dim('{"key":"dm_program","table":"public.dm_programs","columns":{"key":"id","parent":"parent_id","active":"is_active","label":"display_name"}}') = '',
    'a matching declaration';
  ASSERT pg_temp.dim('{"key":"dm_program"}') = '', 'key only';
  ASSERT pg_temp.dim('{"key":"dm_absent"}') = 'missing_dimension', 'missing_dimension';
  ASSERT pg_temp.dim('{"key":"dm_program","table":"public.dm_sites"}') = 'dimension_mismatch', 'another table';
  ASSERT pg_temp.dim('{"key":"dm_program","columns":{"parent":"up_id"}}') = 'dimension_mismatch:parent', 'another parent column';
  ASSERT pg_temp.dim('{"key":"dm_site","columns":{"parent":"parent_id"}}') = 'dimension_mismatch:parent', 'a flat dimension has no parent';
  ALTER TABLE public.dm_programs RENAME COLUMN display_name TO title;
  ASSERT pg_temp.dim('{"key":"dm_program","columns":{"label":"display_name","key":"id"}}') = 'dimension_mismatch:label',
    'a stale registry row after a rename';
  ASSERT (SELECT actual FROM public.compare_interface('{"elements":[{"element":"dimension","key":"dm_program","columns":{"label":"display_name"}}]}'))
    = 'the registry names a column the table no longer has', 'the stale row is explained';
  ALTER TABLE public.dm_programs RENAME COLUMN title TO display_name;
END $$;

-- ---------------------------------------------------------------------------
-- Over the API (authenticator)
-- ---------------------------------------------------------------------------
CREATE TABLE public.dm_wards (id BIGSERIAL PRIMARY KEY, display_name TEXT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE);
INSERT INTO public.dm_wards (id, display_name) VALUES (1, 'Ward 1');
CREATE TABLE public.dm_requests (id BIGSERIAL PRIMARY KEY, ward_id BIGINT REFERENCES public.dm_wards(id));
CREATE TABLE dm_fx.ward_notes (id BIGSERIAL PRIMARY KEY, ward_id BIGINT REFERENCES public.dm_wards(id));
CREATE TABLE dm_fx.regions (id BIGSERIAL PRIMARY KEY, display_name TEXT, is_active BOOLEAN);
GRANT USAGE ON SCHEMA dm_fx TO authenticated;   -- so the checks below can name its tables

SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000085c1","role":"authenticated","roles":["manager"]}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_ward', 'Ward', 'public', 'dm_wards')$q$, '42501'),
    'a non-admin JWT cannot register (42501)';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.set_dimension_default('dm_program', 1)$q$, '42501'),
    'a non-admin JWT cannot set a default (42501)';
  ASSERT (SELECT count(*) FROM public.schema_dimensions WHERE dimension_key LIKE 'dm_%') = 2, 'authenticated reads schema_dimensions';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000085c2","role":"authenticated","roles":["admin"]}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_region', 'Region', 'dm_fx', 'regions')$q$, '42501'),
    'an admin JWT cannot register a table outside public (42501)';
  PERFORM public.register_dimension('dm_ward', 'Ward', 'public', 'dm_wards', p_default_value_id := 1);
  ASSERT pg_temp.triggers('public.dm_requests') = 'dimension_default_ward_id', 'an admin JWT fills public referencing tables';
  ASSERT pg_temp.triggers('dm_fx.ward_notes') = '', 'but not referencing tables in other schemas';
  PERFORM public.set_dimension_default('dm_ward', 1);
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  PERFORM public.register_dimension('dm_ward', 'Ward', 'public', 'dm_wards');
  ASSERT pg_temp.triggers('dm_fx.ward_notes') = 'dimension_default_ward_id', 'the deployment role adds them on re-registration';
  PERFORM public.register_dimension('dm_region', 'Region', 'dm_fx', 'regions');
  ASSERT pg_temp.triggers('dm_fx.regions') = 'dimension_delete_guard,dimension_truncate_guard', 'and registers other schemas';
END $$;

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.schema_dimensions WHERE dimension_key LIKE 'dm_%') = 4, 'web_anon reads schema_dimensions';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_dimension('dm_y', 'Y', 'public', 'dm_wards')$q$, '42501'),
    'web_anon cannot execute register_dimension';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A synthetic Program install, end to end (what a Woven install script does)
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
DECLARE
  v_version text;
  v_before text := (SELECT domain_version FROM metadata.domain_version);
BEGIN
  PERFORM public.assert_interface($j${"template":"dm_program_install@1.0.0","elements":[
    {"element":"rpc","name":"public.register_dimension","args":["text","text","name","name","name","name","name","name","name","bigint","boolean","integer","name"]},
    {"element":"rpc","name":"public.bump_domain_version","args":["text","text","integer","text"],"returns":"text"},
    {"element":"rpc","name":"public.register_module","args":["text","text","text"]}]}$j$);

  CREATE TABLE IF NOT EXISTS public.dm_install_programs (
    id BIGSERIAL PRIMARY KEY,
    parent_id BIGINT REFERENCES public.dm_install_programs(id),
    display_name VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE);
  CREATE INDEX IF NOT EXISTS dm_install_programs_parent_id_idx ON public.dm_install_programs(parent_id);
  INSERT INTO public.dm_install_programs (display_name) VALUES ('General');
  PERFORM public.register_dimension('dm_install_program', 'Program', 'public', 'dm_install_programs',
    p_parent_column := 'parent_id', p_default_value_id := (SELECT id FROM public.dm_install_programs WHERE display_name = 'General'));
  v_version := public.bump_domain_version('minor', 'dm_program_install@1.0.0',
    public.create_schema_decision(p_title := 'Program installed', p_decision := 'Install the shared Program entity',
                                  p_migration_id := 'dm_program_install@1.0.0'));
  PERFORM public.register_module('dm_program_install', 'Program', '1.0.0');

  ASSERT v_version <> v_before, 'the install raised the domain version';
  -- a pack that depends on the install now passes its checks
  ASSERT public.module_installed('dm_program_install'), 'the pack sees the module';
  PERFORM public.assert_interface($j${"template":"pack:dm@1.0.0","elements":[
    {"element":"module","key":"dm_program_install","version":"1.0"},
    {"element":"dimension","key":"dm_install_program","table":"public.dm_install_programs","columns":{"key":"id","parent":"parent_id"}},
    {"element":"table","name":"public.dm_install_programs","columns":[{"name":"display_name","type":"varchar(50)"}]}]}$j$);
END $$;

ROLLBACK;
SQL
then
  pass "registration, fill, retirement, defaults, guards, subtree, refusals, API scope, interface checks, synthetic install"
else
  fail "registry checks (see the assertion above)"
fi

# -----------------------------------------------------------------------------
echo -e "${BOLD}2. Over PostgREST${NC}"
# -----------------------------------------------------------------------------
if [ "${SKIP_API:-0}" = "1" ]; then
  echo "  (skipped: SKIP_API=1)"
else
  cleanup_api() {
    q "DROP TABLE IF EXISTS public.dm_api_items; DROP TABLE IF EXISTS public.dm_api_programs;
       DELETE FROM metadata.dimensions WHERE dimension_key = 'dm_api_program'; NOTIFY pgrst, 'reload schema';" >/dev/null
  }
  cleanup_api
  trap cleanup_api EXIT
  q "CREATE TABLE public.dm_api_programs (id BIGSERIAL PRIMARY KEY, parent_id BIGINT REFERENCES public.dm_api_programs(id),
       display_name TEXT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE);
     CREATE INDEX ON public.dm_api_programs(parent_id);
     CREATE TABLE public.dm_api_items (id BIGSERIAL PRIMARY KEY, program_id BIGINT REFERENCES public.dm_api_programs(id), note TEXT);
     CREATE INDEX ON public.dm_api_items(program_id);
     GRANT SELECT, INSERT, UPDATE, DELETE ON public.dm_api_programs, public.dm_api_items TO authenticated;
     GRANT USAGE ON SEQUENCE public.dm_api_items_id_seq TO authenticated;
     INSERT INTO public.dm_api_programs (id, parent_id, display_name) VALUES (1, NULL, 'General'), (2, 1, 'Youth');
     SELECT public.register_dimension('dm_api_program', 'Program', 'public', 'dm_api_programs',
       p_parent_column := 'parent_id', p_default_value_id := 1);
     NOTIFY pgrst, 'reload schema';" >/dev/null
  sleep 2
  TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
    -d grant_type=password -d client_id="$KEYCLOAK_CLIENT" -d username=testadmin -d password=testadmin |
    python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

  CREATED=$(curl -s -X POST "$POSTGREST_URL/dm_api_items" -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"note":"from the API"}')
  check "an insert over the API without the dimension column is filled" "1" \
    "$(echo "$CREATED" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['program_id'])")"

  BODY=$(mktemp)
  STATUS=$(curl -s -o "$BODY" -w "%{http_code}" -X DELETE "$POSTGREST_URL/dm_api_programs?id=eq.2" -H "Authorization: Bearer $TOKEN")
  check "deleting a dimension row over the API is a 400" "400" "$STATUS"
  check_contains "naming dimension_row_delete for the friendly message" 'constraint "dimension_row_delete"' \
    "$(python3 -c "import json;b=json.load(open('$BODY'));print(b['code'], b['message'])")"
  rm -f "$BODY"
  check "the row is still there" "1" "$(q "SELECT count(*) FROM public.dm_api_programs WHERE id = 2")"

  check_contains "schema_dimensions over the API" '"default_value_id":1' \
    "$(curl -s "$POSTGREST_URL/schema_dimensions?dimension_key=eq.dm_api_program" -H "Authorization: Bearer $TOKEN")"
  check "dimension_subtree over the API" "[1, 2]" \
    "$(curl -s -X POST "$POSTGREST_URL/rpc/dimension_subtree" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        -d '{"p_dimension_key":"dm_api_program","p_value_id":1}' | python3 -c "import sys,json;print(sorted(json.load(sys.stdin)))")"
  cleanup_api
  trap - EXIT
fi

echo ""
echo -e "${BOLD}Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
[ "$FAIL" -eq 0 ]
