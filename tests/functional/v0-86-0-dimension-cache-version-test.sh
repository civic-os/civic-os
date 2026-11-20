#!/bin/bash
# =============================================================================
# Functional Test: v0-86-0 database side of the Dimension property type
# =============================================================================
# Clients detect a Dimension from a foreign key's target (a BIGINT FK to a table in schema_dimensions), so the
# database side is small. Covers:
#   - schema_properties exposes the FK target a client matches against the registry (join_schema, join_table,
#     join_column) for an FK to a dimension and for the dimension table's own parent column;
#   - registering a dimension leaves schema_properties and the contract hash unchanged (no derived column);
#   - the properties cache version moves when the registry changes;
#   - the sort column (v0.86.0): a sort_order column by convention at registration, set_dimension_sort_column()
#     sets, keeps across re-registration, clears and refuses a missing column or dimension; schema_dimensions
#     returns it; compare_interface() compares it as the 'sort' role; a non-admin JWT is refused;
#   - the tree select strings exist in the six core locales.
#
# All fixtures are created inside one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-86-0-dimension-cache-version-test.sh
#
# Environment overrides (the connecting user must be a superuser):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

CREATE TABLE public.dk_programs (
  id BIGSERIAL PRIMARY KEY,
  parent_id BIGINT REFERENCES public.dk_programs(id),
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX ON public.dk_programs(parent_id);
CREATE TABLE public.dk_enrollments (
  id BIGSERIAL PRIMARY KEY,
  program_id BIGINT REFERENCES public.dk_programs(id),
  note TEXT
);
CREATE INDEX ON public.dk_enrollments(program_id);
GRANT SELECT ON public.dk_programs, public.dk_enrollments TO web_anon, authenticated;
INSERT INTO public.dk_programs (id, display_name) VALUES (1, 'General');

SELECT set_config('dk.hash_before', metadata.schema_contract_hash(), true);
SELECT set_config('dk.props_before',
  (SELECT md5(string_agg(to_jsonb(sp)::text, '' ORDER BY sp.table_name, sp.column_name))
   FROM public.schema_properties sp WHERE sp.table_name LIKE 'dk\_%'), true);
SELECT set_config('dk.cache_before', (SELECT version::text FROM public.schema_cache_versions WHERE cache_name = 'properties'), true);

SELECT public.register_dimension('dk_program', 'Program', 'public', 'dk_programs', p_parent_column := 'parent_id');

DO $$
BEGIN
  -- what a client matches against the registry row (table_schema, table_name, key_column)
  ASSERT (SELECT join_schema || '.' || join_table || '.' || join_column || ':' || udt_name FROM public.schema_properties
          WHERE table_name = 'dk_enrollments' AND column_name = 'program_id') = 'public.dk_programs.id:int8',
    'an FK to the dimension exposes its target';
  ASSERT (SELECT join_schema || '.' || join_table || '.' || join_column FROM public.schema_properties
          WHERE table_name = 'dk_programs' AND column_name = 'parent_id') = 'public.dk_programs.id',
    'so does the dimension table''s own parent column';
  ASSERT (SELECT table_schema || '.' || table_name || '.' || key_column FROM public.schema_dimensions
          WHERE dimension_key = 'dk_program') = 'public.dk_programs.id', 'the registry row it matches';

  -- no derived column: registration changes neither schema_properties nor the contract hash
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'schema_properties' AND column_name = 'dimension_key'),
    'schema_properties has no dimension_key';
  ASSERT (SELECT md5(string_agg(to_jsonb(sp)::text, '' ORDER BY sp.table_name, sp.column_name))
          FROM public.schema_properties sp WHERE sp.table_name LIKE 'dk\_%') = current_setting('dk.props_before'),
    'registration leaves schema_properties unchanged';
  ASSERT metadata.schema_contract_hash() = current_setting('dk.hash_before'),
    'registration leaves the contract hash unchanged';
END $$;

-- the properties cache version follows the registry (updated_at set past the transaction start)
UPDATE metadata.dimensions SET updated_at = now() + interval '1 minute' WHERE dimension_key = 'dk_program';
DO $$
BEGIN
  ASSERT (SELECT version FROM public.schema_cache_versions WHERE cache_name = 'properties')
    > current_setting('dk.cache_before')::timestamptz, 'the properties cache version moves with the registry';
END $$;

-- web_anon reads the registry clients type properties with
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.schema_dimensions WHERE dimension_key = 'dk_program') = 1, 'web_anon reads schema_dimensions';
END $$;
RESET ROLE;

-- sort column: explicit, by convention, none; refused when missing; compared as the 'sort' role
CREATE TABLE public.dk_sites (id BIGSERIAL PRIMARY KEY, display_name TEXT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
                              sort_order INT, rank INT);
CREATE TABLE public.dk_wards (id BIGSERIAL PRIMARY KEY, display_name TEXT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE FUNCTION pg_temp.expect_sqlstate(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE = p_state;
END $f$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_sqlstate(text, text) TO PUBLIC;
DO $$
BEGIN
  ASSERT (SELECT sort_column FROM public.schema_dimensions WHERE dimension_key = 'dk_program') IS NULL,
    'no sort column and no sort_order column: NULL (order by label)';

  PERFORM public.register_dimension('dk_site', 'Site', 'public', 'dk_sites');
  ASSERT (SELECT sort_column FROM metadata.dimensions WHERE dimension_key = 'dk_site') = 'sort_order',
    'a sort_order column is used by convention';
  PERFORM public.set_dimension_sort_column('dk_site', 'rank');
  ASSERT (SELECT sort_column FROM public.schema_dimensions WHERE dimension_key = 'dk_site') = 'rank',
    'set_dimension_sort_column() sets it, and schema_dimensions returns it';
  PERFORM public.register_dimension('dk_site', 'Site', 'public', 'dk_sites');
  ASSERT (SELECT sort_column FROM metadata.dimensions WHERE dimension_key = 'dk_site') = 'rank',
    're-registration keeps a sort column already set';
  PERFORM public.register_dimension('dk_ward', 'Ward', 'public', 'dk_wards');
  ASSERT (SELECT sort_column FROM metadata.dimensions WHERE dimension_key = 'dk_ward') IS NULL, 'no convention column: NULL';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.set_dimension_sort_column('dk_ward', 'nope')$q$, '22023'),
    'a missing sort column is refused (22023)';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.set_dimension_sort_column('dk_none', 'id')$q$, '22023'),
    'an unknown dimension is refused (22023)';
  PERFORM public.set_dimension_sort_column('dk_site', NULL);
  ASSERT (SELECT sort_column FROM metadata.dimensions WHERE dimension_key = 'dk_site') IS NULL, 'NULL clears it';
  PERFORM public.set_dimension_sort_column('dk_site', 'rank');

  ASSERT NOT EXISTS (SELECT 1 FROM public.compare_interface('{"elements":[{"element":"dimension","key":"dk_site","columns":{"sort":"rank"}}]}')),
    'the sort role matches';
  ASSERT (SELECT difference || ':' || column_name FROM public.compare_interface(
    '{"elements":[{"element":"dimension","key":"dk_site","columns":{"sort":"sort_order"}}]}')) = 'dimension_mismatch:sort',
    'a different sort column is a dimension_mismatch on the sort role';
END $$;

-- the setter needs an admin JWT or the deployment role
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000086b1","role":"authenticated","roles":["manager"]}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.set_dimension_sort_column('dk_site', 'id')$q$, '42501'),
    'a non-admin JWT cannot set the sort column (42501)';
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- tree select strings
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM metadata.translations WHERE source_type = 'ui' AND source_key LIKE 'tree\_select.%') = 30,
    'five tree select strings in six locales';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: FK targets match the registry, schema_properties and the contract hash unchanged, cache version follows the registry"
else
  echo "FAIL: v0.86.0 checks failed (see the assertion above)"
  exit 1
fi
