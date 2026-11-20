#!/bin/bash
# =============================================================================
# Functional Test: v0-85-0 module registry
# =============================================================================
# Covers metadata.modules, register_module(), module_installed(), metadata._is_deployer(), and module
# elements in compare_interface():
#   - the deployment role (no JWT) registers modules, packs (pack:) and bridges (bridge:); a re-registration
#     replaces the version and keeps installed_at; malformed keys, names and versions are refused (22023);
#   - module_installed() answers for web_anon and authenticated;
#   - authenticator with a non-admin JWT is refused (42501); with an admin JWT it is admitted;
#   - _is_deployer() is true for the deployment role only, never with a JWT (even an admin one);
#   - compare_interface(): missing_module, module_version_mismatch (other major, lower minor), a higher minor
#     passes, a pre-release installed version compares by its core.
#
# All fixtures are created inside one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-85-0-module-registry-test.sh
#
# Environment overrides (the connecting user must be a superuser, to switch session authorization):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

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

-- one module element's differences as "code" joined by commas ('' when none)
CREATE FUNCTION pg_temp.mod(p_element jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(difference, ',' ORDER BY difference), '')
  FROM public.compare_interface(jsonb_build_object('elements', jsonb_build_array(p_element || '{"element":"module"}')))
$$;
GRANT EXECUTE ON FUNCTION pg_temp.mod(jsonb) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- The deployment role
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_first timestamptz;
BEGIN
  ASSERT metadata._is_deployer(), 'a superuser session without a JWT is the deployer';

  PERFORM public.register_module('mr_people', 'People Served', '1.1.0');
  PERFORM public.register_module('pack:mr_people', 'People Served pack', '1.0.0');
  PERFORM public.register_module('bridge:mr_people_money', 'People Served and Money', '0.1.0');
  ASSERT public.module_installed('mr_people'), 'module registered';
  ASSERT public.module_installed('pack:mr_people'), 'pack registered under the pack: prefix';
  ASSERT public.module_installed('bridge:mr_people_money'), 'bridge registered under the bridge: prefix';
  ASSERT NOT public.module_installed('mr_absent'), 'an absent module is not installed';

  SELECT installed_at INTO v_first FROM metadata.modules WHERE module_key = 'mr_people';
  PERFORM pg_sleep(0.01);
  PERFORM public.register_module('mr_people', 'People Served (renamed)', '1.2.0');
  ASSERT (SELECT version FROM metadata.modules WHERE module_key = 'mr_people') = '1.2.0', 'a re-registration replaces the version';
  ASSERT (SELECT display_name FROM metadata.modules WHERE module_key = 'mr_people') = 'People Served (renamed)', 'and the name';
  ASSERT (SELECT installed_at FROM metadata.modules WHERE module_key = 'mr_people') = v_first, 'installed_at is kept';
  ASSERT (SELECT updated_at >= installed_at FROM metadata.modules WHERE module_key = 'mr_people'), 'updated_at is set (NOW() is the transaction time)';

  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_module('People', 'x', '1.0.0')$q$, '22023'), 'uppercase key refused';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_module('plugin:x', 'x', '1.0.0')$q$, '22023'), 'unknown prefix refused';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_module('x', ' ', '1.0.0')$q$, '22023'), 'blank name refused';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_module('x', 'x', '1.0')$q$, '22023'), 'two-part version refused';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_module(NULL, 'x', '1.0.0')$q$, '22023'), 'NULL key refused';
END $$;

-- ---------------------------------------------------------------------------
-- compare_interface() module elements
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM public.register_module('mr_pre', 'Pre-release', '2.3.0-rc.1+b7');
  ASSERT pg_temp.mod('{"key":"mr_absent"}') = 'missing_module', 'missing_module';
  ASSERT pg_temp.mod('{"key":"mr_people"}') = '', 'installed, no version declared';
  ASSERT pg_temp.mod('{"key":"mr_people","version":"1.2"}') = '', 'same major and minor';
  ASSERT pg_temp.mod('{"key":"mr_people","version":"1.1"}') = '', 'a higher installed minor passes';
  ASSERT pg_temp.mod('{"key":"mr_people","version":"1.3"}') = 'module_version_mismatch', 'a lower installed minor fails';
  ASSERT pg_temp.mod('{"key":"mr_people","version":"0.9"}') = 'module_version_mismatch', 'another major fails (older)';
  ASSERT pg_temp.mod('{"key":"mr_people","version":"2.0"}') = 'module_version_mismatch', 'another major fails (newer)';
  ASSERT pg_temp.mod('{"key":"mr_pre","version":"2.3"}') = '', 'a pre-release compares by its core version';
  ASSERT pg_temp.mod('{"key":"pack:mr_people","version":"1.0"}') = '', 'packs are module elements too';
  ASSERT (SELECT expected || '|' || actual FROM public.compare_interface(
    '{"elements":[{"element":"module","key":"mr_people","version":"1.3"}]}')) = '1.3|1.2.0', 'expected and actual versions';
  ASSERT (SELECT expected FROM public.compare_interface(
    '{"elements":[{"element":"module","key":"mr_absent","version":"1.0"}]}')) = '1.0', 'missing_module names the required version';
END $$;

DO $$
DECLARE
  v_detail text;
BEGIN
  BEGIN
    PERFORM public.assert_interface('{"template":"t@1","elements":[{"element":"module","key":"mr_people","version":"1.3"},{"element":"module","key":"mr_absent","version":"1.0"}]}');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  ASSERT v_detail = E'mr_absent: module is not installed (required 1.0)\nmr_people: version 1.2.0, required 1.3 or a later 1.x',
    format('assert_interface module lines: %s', v_detail);
END $$;

-- ---------------------------------------------------------------------------
-- PostgREST's login role: the JWT decides
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000085a1","role":"authenticated","roles":["manager"]}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_module('mr_api', 'x', '1.0.0')$q$, '42501'),
    'a non-admin JWT is refused (42501)';
  ASSERT public.module_installed('mr_people'), 'authenticated can ask module_installed()';
  ASSERT (SELECT count(*) FROM metadata.modules) >= 1, 'authenticated reads the registry';
  ASSERT pg_temp.expect_sqlstate($q$INSERT INTO metadata.modules (module_key, display_name, version) VALUES ('mr_x', 'x', '1.0.0')$q$, '42501'),
    'no direct write';
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000085a2","role":"authenticated","roles":["admin"]}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.register_module('mr_api', 'Registered over the API', '1.0.0');
  ASSERT public.module_installed('mr_api'), 'an admin JWT registers a module';
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- an admin JWT never makes the session a deployer, even for the superuser login
DO $$
BEGIN
  ASSERT NOT metadata._is_deployer(), 'JWT claims rule out the deployer path';
END $$;
SELECT set_config('request.jwt.claims', '{}', true);

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT public.module_installed('mr_people'), 'web_anon can ask module_installed()';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.register_module('mr_anon', 'x', '1.0.0')$q$, '42501'),
    'web_anon cannot execute register_module';
END $$;
RESET ROLE;

ROLLBACK;
SQL
then
  echo "PASS: module registry, module_installed(), _is_deployer() and module elements in compare_interface()"
else
  echo "FAIL: module registry checks failed (see the assertion above)"
  exit 1
fi
