#!/bin/bash
# =============================================================================
# Functional Test: v0-86-1 module interface and dimension missing columns
# =============================================================================
# Covers:
#   - register_module(..., p_interface) stores the declaration on metadata.modules.interface; a malformed
#     declaration is refused (22023); the interface follows the latest registration, and the v0.85.0
#     three-argument form registers with none; installed_at is kept; neither form admits an authenticator
#     session without a JWT (42501);
#   - schema_dimensions.missing_columns is empty for a healthy registration, names a renamed or dropped
#     registry column in role order, names every column when the table is gone, and is empty again after
#     re-registering with the new names; compare_interface() still reports dimension_mismatch meanwhile.
#
# All fixtures are created inside one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-86-1-module-interface-test.sh
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

SET LOCAL request.jwt.claims = '{}';

CREATE FUNCTION pg_temp.expect_sqlstate(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE = p_state;
END $f$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_sqlstate(text, text) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- 1. Module interface
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_decl JSONB := '{"elements":[{"element":"table","name":"public.schema_entities"},{"element":"module","key":"people_served"}]}';
  v_installed TIMESTAMPTZ;
BEGIN
  PERFORM public.register_module('mi_test', 'MI Test', '1.0.0', v_decl);
  ASSERT (SELECT interface FROM metadata.modules WHERE module_key = 'mi_test') = v_decl, 'the declaration is stored';
  v_installed := (SELECT installed_at FROM metadata.modules WHERE module_key = 'mi_test');

  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_module('mi_test', 'MI Test', '1.1.0', '{"elements":[{"element":"nope"}]}'::jsonb)$q$, '22023'),
    'a malformed declaration is refused (22023)';
  ASSERT (SELECT version FROM metadata.modules WHERE module_key = 'mi_test') = '1.0.0', 'and nothing is written';

  PERFORM public.register_module('mi_test', 'MI Test', '1.1.0', '{"elements":[{"element":"table","name":"public.schema_entities"}]}'::jsonb);
  ASSERT (SELECT jsonb_array_length(interface->'elements') FROM metadata.modules WHERE module_key = 'mi_test') = 1,
    'the interface follows the latest registration';

  PERFORM public.register_module('mi_test', 'MI Test', '1.2.0');
  ASSERT (SELECT interface IS NULL AND version = '1.2.0' FROM metadata.modules WHERE module_key = 'mi_test'),
    'the three-argument form registers with no declaration';
  ASSERT (SELECT installed_at FROM metadata.modules WHERE module_key = 'mi_test') = v_installed, 'installed_at is kept';

  PERFORM public.register_module('mi_test', 'MI Test', '1.2.0', NULL);
  ASSERT (SELECT interface FROM metadata.modules WHERE module_key = 'mi_test') IS NULL, 'NULL is accepted';
END $$;

-- refusal: an authenticator session (the PostgREST login role) with no JWT is neither an admin nor the deployer
SET LOCAL SESSION AUTHORIZATION authenticator;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_module('mi_other', 'Other', '1.0.0', NULL::jsonb)$q$, '42501'),
    'the four-argument form is refused without admin or deployer (42501)';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_module('mi_other', 'Other', '1.0.0')$q$, '42501'),
    'so is the three-argument form';
END $$;
RESET SESSION AUTHORIZATION;
SET LOCAL request.jwt.claims = '{}';

-- ---------------------------------------------------------------------------
-- 2. schema_dimensions.missing_columns
-- ---------------------------------------------------------------------------
CREATE TABLE public.mc_programs (
  id BIGSERIAL PRIMARY KEY,
  parent_id BIGINT REFERENCES public.mc_programs(id),
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT
);
CREATE INDEX ON public.mc_programs(parent_id);
GRANT SELECT ON public.mc_programs TO web_anon, authenticated;
SELECT public.register_dimension('mc_program', 'Program', 'public', 'mc_programs', p_parent_column := 'parent_id');

DO $$
BEGIN
  ASSERT (SELECT missing_columns FROM public.schema_dimensions WHERE dimension_key = 'mc_program') = '{}'::name[],
    'a healthy registration has no missing columns';
END $$;

ALTER TABLE public.mc_programs RENAME COLUMN display_name TO title;
ALTER TABLE public.mc_programs RENAME COLUMN sort_order TO rank;
DO $$
BEGIN
  ASSERT (SELECT missing_columns FROM public.schema_dimensions WHERE dimension_key = 'mc_program') = '{display_name,sort_order}'::name[],
    'renamed label and sort columns are reported, in role order';
  ASSERT (SELECT difference || ':' || column_name FROM public.compare_interface(
    '{"elements":[{"element":"dimension","key":"mc_program","columns":{"label":"display_name"}}]}')) = 'dimension_mismatch:label',
    'compare_interface() still reports the stale column';
END $$;

SELECT public.register_dimension('mc_program', 'Program', 'public', 'mc_programs', p_parent_column := 'parent_id',
  p_label_column := 'title', p_sort_column := 'rank');
DO $$
BEGIN
  ASSERT (SELECT missing_columns FROM public.schema_dimensions WHERE dimension_key = 'mc_program') = '{}'::name[],
    're-registering with the new names repairs it';
END $$;

-- anonymous readers see the same column (security_invoker view over catalog tables everyone can read)
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT (SELECT missing_columns FROM public.schema_dimensions WHERE dimension_key = 'mc_program') = '{}'::name[],
    'web_anon reads missing_columns';
END $$;
RESET ROLE;

-- a table that is gone: every named column is reported (the registry row is otherwise left behind)
ALTER TABLE public.mc_programs RENAME TO mc_programs_gone;
DO $$
BEGIN
  ASSERT (SELECT missing_columns FROM public.schema_dimensions WHERE dimension_key = 'mc_program')
         = '{id,title,parent_id,is_active,rank}'::name[],
    'a missing table reports every named column';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: module interface stored and validated, schema_dimensions reports missing columns"
else
  echo "FAIL: v0.86.1 checks failed (see the assertion above)"
  exit 1
fi
