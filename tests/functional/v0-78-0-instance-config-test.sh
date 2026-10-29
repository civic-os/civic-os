#!/bin/bash
# =============================================================================
# Functional Test: v0-78-0 instance config store
# =============================================================================
# Covers metadata.instance_config / instance_config_groups, public.instance_config (view),
# public.set_instance_config(), public.get_config() and the instance_config entry of
# public.schema_cache_versions:
#   - web_anon sees exactly the is_public rows; authenticated sees all of them;
#   - get_config() follows RLS (NULL for a non-public key as web_anon);
#   - set_instance_config(): web_anon has no EXECUTE, a non-admin gets success:false, admin succeeds;
#   - validation and normalization for each of the 8 config types, unknown keys, blank and NULL;
#   - API roles cannot INSERT, DELETE, or update any column but config_value, and a non-admin's direct
#     UPDATE changes nothing;
#   - an update bumps updated_at and the instance_config cache version for both readers;
#   - schema_contract_hash() is unchanged by a config update; the view is security_invoker.
#
# All fixtures (temporary keys, values) live inside one transaction that is rolled back; a second
# session then confirms the framework keys are still NULL and no temporary key remains.
#
# Usage:
#   ./tests/functional/v0-78-0-instance-config-test.sh
#
# Environment overrides (the connecting user must be a superuser, to create fixtures and switch roles):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

-- ---------------------------------------------------------------------------
-- Baselines, taken before any fixture: contract hash, cache version, one row's updated_at
-- ---------------------------------------------------------------------------
SELECT set_config('ic.hash', metadata.schema_contract_hash(), true);
SELECT set_config('ic.version',
  (SELECT version::text FROM public.schema_cache_versions WHERE cache_name = 'instance_config'), true);
SELECT set_config('ic.sms_updated_at',
  (SELECT updated_at::text FROM metadata.instance_config WHERE config_key = 'sms_configured'), true);

-- ---------------------------------------------------------------------------
-- Fixtures: one temporary non-public key per type (old updated_at, so the cache version only moves
-- when an update really bumps it) and helpers
-- ---------------------------------------------------------------------------
INSERT INTO metadata.instance_config (config_key, config_type, display_name, is_public, updated_at) VALUES
  ('t_string',      'string',      'T string',      false, '2000-01-01'),
  ('t_integer',     'integer',     'T integer',     false, '2000-01-01'),
  ('t_number',      'number',      'T number',      false, '2000-01-01'),
  ('t_boolean',     'boolean',     'T boolean',     false, '2000-01-01'),
  ('t_json',        'json',        'T json',        false, '2000-01-01'),
  ('t_theme',       'theme',       'T theme',       false, '2000-01-01'),
  ('t_locale',      'locale',      'T locale',      false, '2000-01-01'),
  ('t_locale_list', 'locale_list', 'T locale list', false, '2000-01-01');

CREATE FUNCTION pg_temp.expect_sqlstate(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE = p_state;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_sqlstate(text, text) TO PUBLIC;

-- Runs set_instance_config and returns its result as the calling role
CREATE FUNCTION pg_temp.sic(p_key text, p_value text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.set_instance_config(p_key, p_value)
$$;
GRANT EXECUTE ON FUNCTION pg_temp.sic(text, text) TO PUBLIC;

-- The stored value of a key, read as the calling role
CREATE FUNCTION pg_temp.val(p_key text) RETURNS text LANGUAGE sql AS $$
  SELECT config_value FROM metadata.instance_config WHERE config_key = p_key
$$;
GRANT EXECUTE ON FUNCTION pg_temp.val(text) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- Shape and security properties
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM metadata.instance_config WHERE config_key NOT LIKE 't\_%') = 10, 'ten framework keys are seeded';
  ASSERT (SELECT count(*) FROM metadata.instance_config_groups) = 4, 'four framework groups are seeded';
  ASSERT (SELECT count(*) FROM metadata.instance_config WHERE config_key NOT LIKE 't\_%' AND config_value IS NOT NULL) = 0,
    'framework keys start NULL (not set)';
  ASSERT (SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid = 'public.instance_config'::regclass),
    'public.instance_config sets security_invoker = true';
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.entities WHERE table_name IN ('instance_config', 'instance_config_groups')),
    'the config store is not registered as a CRUD entity';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'metadata.instance_config'::regclass), 'RLS on instance_config';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'metadata.instance_config_groups'::regclass), 'RLS on instance_config_groups';
  ASSERT EXISTS (SELECT 1 FROM pg_index WHERE indrelid = 'metadata.instance_config'::regclass AND indkey[0] =
    (SELECT attnum FROM pg_attribute WHERE attrelid = 'metadata.instance_config'::regclass AND attname = 'group_key')),
    'group_key is indexed';
  ASSERT (SELECT bool_and(prosecdef = false AND proconfig::text LIKE '%search_path%')
          FROM pg_proc WHERE oid IN ('public.set_instance_config(text,text)'::regprocedure, 'public.get_config(text)'::regprocedure)),
    'both functions are SECURITY INVOKER with a pinned search_path';
  ASSERT NOT has_function_privilege('public', 'public.set_instance_config(text,text)', 'EXECUTE'), 'no PUBLIC execute on set_instance_config';
  ASSERT NOT has_function_privilege('public', 'metadata.instance_config_normalize()', 'EXECUTE'), 'no PUBLIC execute on the normalize trigger function';
  ASSERT (SELECT proconfig::text LIKE '%search_path%' FROM pg_proc WHERE oid = 'metadata.instance_config_normalize()'::regprocedure),
    'the trigger function pins its search_path';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'metadata.instance_config'::regclass AND tgname = 'instance_config_normalize_trigger'),
    'the normalize trigger exists';
  ASSERT NOT has_function_privilege('web_anon', 'public.set_instance_config(text,text)', 'EXECUTE'), 'web_anon cannot run set_instance_config';
  ASSERT has_function_privilege('authenticated', 'public.set_instance_config(text,text)', 'EXECUTE'), 'authenticated can run set_instance_config';
  ASSERT NOT has_function_privilege('public', 'public.get_config(text)', 'EXECUTE'), 'no PUBLIC execute on get_config';
  ASSERT has_function_privilege('web_anon', 'public.get_config(text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.get_config(text)', 'EXECUTE'), 'both API roles can run get_config';
  ASSERT EXISTS (SELECT 1 FROM metadata.permissions p
                 JOIN metadata.permission_roles pr ON pr.permission_id = p.id
                 JOIN metadata.roles r ON r.id = pr.role_id
                 WHERE p.table_name = 'metadata.instance_config' AND p.permission = 'update' AND r.role_key = 'admin'),
    'the update permission is mapped to admin';
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.permissions p
                     JOIN metadata.permission_roles pr ON pr.permission_id = p.id
                     JOIN metadata.roles r ON r.id = pr.role_id
                     WHERE p.table_name = 'metadata.instance_config' AND r.role_key <> 'admin'),
    'no other role holds it';
END $$;

-- ---------------------------------------------------------------------------
-- Visibility: web_anon sees exactly the is_public rows
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.instance_config) = 9, 'web_anon sees the 9 public rows: ' || (SELECT count(*) FROM public.instance_config);
  ASSERT (SELECT bool_and(is_public) FROM public.instance_config), 'web_anon sees only is_public rows';
  ASSERT NOT EXISTS (SELECT 1 FROM public.instance_config WHERE config_key IN ('sms_configured', 't_string')),
    'web_anon does not see sms_configured or temporary non-public keys';
  ASSERT (SELECT count(*) FROM metadata.instance_config_groups) = 4, 'web_anon reads the groups';
  ASSERT public.get_config('sms_configured') IS NULL, 'get_config is NULL for web_anon on a non-public key';
  ASSERT public.get_config('no_such_key') IS NULL, 'get_config is NULL for an unknown key';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.set_instance_config('app_title', 'x')$q$, '42501'),
    'web_anon is refused set_instance_config (permission denied)';
END $$;
RESET ROLE;

-- authenticated non-admin sees everything
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated","roles":["user"]}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.instance_config WHERE config_key NOT LIKE 't\_%') = 10,
    'an authenticated user sees all 10 framework rows';
  ASSERT (SELECT count(*) FROM public.instance_config) = 18, 'and the 8 temporary rows too';
  ASSERT (SELECT array_agg(config_key) FROM public.instance_config WHERE config_key NOT LIKE 't\_%') =
    ARRAY['app_title','default_theme','default_locale','supported_locales','sms_configured','matomo_enabled',
          'stripe_publishable_key','map_default_lat','map_default_lng','map_default_zoom'],
    'rows come back ordered by group, sort order, key';
  ASSERT (SELECT group_display_name FROM public.instance_config WHERE config_key = 'map_default_zoom') = 'Map'
     AND (SELECT group_icon FROM public.instance_config WHERE config_key = 'app_title') = 'palette'
     AND (SELECT group_sort_order FROM public.instance_config WHERE config_key = 'default_locale') = 20,
    'the group columns are joined in';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Non-admin writes: refused through the RPC, and nothing changes through direct API access
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated","roles":["manager"]}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_rows int;
BEGIN
  ASSERT pg_temp.sic('sms_configured', 'true') = '{"success": false, "error": "Permission denied"}'::jsonb,
    'a non-admin gets success:false from set_instance_config: ' || pg_temp.sic('sms_configured', 'true')::text;
  ASSERT pg_temp.val('sms_configured') IS NULL, 'and nothing was stored';

  -- direct UPDATE of the writable column is filtered by RLS: zero rows, no error
  UPDATE metadata.instance_config SET config_value = 'true' WHERE config_key = 'sms_configured';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  ASSERT v_rows = 0, 'a non-admin direct UPDATE matches no row';
  ASSERT pg_temp.val('sms_configured') IS NULL, 'and changes nothing';

  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.instance_config SET display_name = 'x'$q$, '42501'),
    'no one can update display_name through the API';
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.instance_config SET is_public = true$q$, '42501'),
    'no one can update is_public through the API';
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.instance_config SET config_key = 'x'$q$, '42501'),
    'no one can update config_key through the API';
  ASSERT pg_temp.expect_sqlstate($q$INSERT INTO metadata.instance_config (config_key, display_name) VALUES ('t_new', 'x')$q$, '42501'),
    'no one can INSERT through the API';
  ASSERT pg_temp.expect_sqlstate($q$DELETE FROM metadata.instance_config WHERE config_key = 't_string'$q$, '42501'),
    'no one can DELETE through the API';
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.instance_config_groups SET display_name = 'x'$q$, '42501'),
    'the groups table is read-only for the API';
END $$;
RESET ROLE;

SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.instance_config SET config_value = 'x'$q$, '42501'),
    'web_anon cannot UPDATE';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Admin: set, normalize, validate
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated","roles":["admin"]}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE r jsonb;
BEGIN
  -- success shape
  r := pg_temp.sic('sms_configured', ' TRUE ');
  ASSERT r = '{"success": true, "config_key": "sms_configured", "config_value": "true"}'::jsonb, 'admin success shape: ' || r::text;
  ASSERT pg_temp.val('sms_configured') = 'true', 'stored lowercased and trimmed';

  -- unknown key
  r := pg_temp.sic('no_such_key', 'x');
  ASSERT (r->>'success')::boolean = false AND r->>'error' = 'Unknown config key: no_such_key', 'unknown key: ' || r::text;

  -- string: kept as given (no trimming), blank and NULL clear
  r := pg_temp.sic('t_string', '  hello  ');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_string') = '  hello  ', 'string stored as given';
  r := pg_temp.sic('t_string', '');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_string') IS NULL, 'empty string stores NULL';
  PERFORM pg_temp.sic('t_string', 'again');
  r := pg_temp.sic('t_string', NULL);
  ASSERT (r->>'success')::boolean AND r->'config_value' = 'null'::jsonb AND pg_temp.val('t_string') IS NULL, 'NULL stores NULL';
  PERFORM pg_temp.sic('t_string', 'again');
  r := pg_temp.sic('t_string', '   ');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_string') IS NULL, 'blank string stores NULL';

  -- whitespace-only values (tab, CR, LF) are blank
  r := pg_temp.sic('t_string', E'\t');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_string') IS NULL, 'a tab-only string stores NULL: ' || r::text;
  PERFORM pg_temp.sic('t_string', 'again');
  r := pg_temp.sic('t_string', E' \t\r\n ');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_string') IS NULL, 'tab, CR and LF count as blank';
  r := pg_temp.sic('t_integer', E'\t12\n');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_integer') = '12', 'typed values are trimmed of tab and newline too';

  -- theme: any non-blank string as given
  r := pg_temp.sic('t_theme', 'corporate');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_theme') = 'corporate', 'theme stored as given';
  r := pg_temp.sic('t_theme', '');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_theme') IS NULL, 'blank theme stores NULL';

  -- integer
  r := pg_temp.sic('t_integer', ' -7 ');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_integer') = '-7', 'integer trimmed: ' || r::text;
  r := pg_temp.sic('t_integer', '42');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_integer') = '42', 'integer 42';
  FOREACH r IN ARRAY ARRAY[to_jsonb('4.5'::text), to_jsonb('abc'::text), to_jsonb('99999999999'::text), to_jsonb('1e3'::text), to_jsonb('--1'::text)]
  LOOP
    ASSERT (pg_temp.sic('t_integer', r #>> '{}')->>'success')::boolean = false, 'integer rejects ' || (r #>> '{}');
  END LOOP;
  ASSERT pg_temp.sic('t_integer', '4.5')->>'error' LIKE 't\_integer%whole number%', 'the integer error names the key and type';
  ASSERT pg_temp.val('t_integer') = '42', 'invalid input left the stored value alone';

  -- number
  r := pg_temp.sic('t_number', ' 42.25 ');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_number') = '42.25', 'number trimmed: ' || r::text;
  r := pg_temp.sic('t_number', '-83.04');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_number') = '-83.04', 'negative decimal accepted';
  r := pg_temp.sic('t_number', '-83.0458');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_number') = '-83.0458', 'negative decimal';
  FOREACH r IN ARRAY ARRAY[to_jsonb('abc'::text), to_jsonb('NaN'::text), to_jsonb('Infinity'::text), to_jsonb('-Infinity'::text), to_jsonb('1.2.3'::text),
                   to_jsonb('0x10'::text), to_jsonb('1_000'::text), to_jsonb('1e400'::text), to_jsonb('.5'::text), to_jsonb('1e3'::text), to_jsonb('5.'::text)]
  LOOP
    ASSERT (pg_temp.sic('t_number', r #>> '{}')->>'success')::boolean = false, 'number rejects ' || (r #>> '{}');
  END LOOP;
  ASSERT pg_temp.sic('t_number', 'NaN')->>'error' LIKE 't\_number%plain number%', 'the number error names the key and type';
  ASSERT pg_temp.val('t_number') = '-83.0458', 'invalid input left the stored value alone';

  -- boolean
  r := pg_temp.sic('t_boolean', 'False');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_boolean') = 'false', 'boolean lowercased';
  FOREACH r IN ARRAY ARRAY[to_jsonb('yes'::text), to_jsonb('1'::text), to_jsonb('t'::text), to_jsonb('truee'::text)]
  LOOP
    ASSERT (pg_temp.sic('t_boolean', r #>> '{}')->>'success')::boolean = false, 'boolean rejects ' || (r #>> '{}');
  END LOOP;
  ASSERT pg_temp.sic('t_boolean', 'yes')->>'error' LIKE 't\_boolean%true or false%', 'the boolean error names the key and type';
  ASSERT pg_temp.val('t_boolean') = 'false', 'invalid input left the stored value alone';

  -- json: stored as given
  r := pg_temp.sic('t_json', '{"a": [1,  2]}');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_json') = '{"a": [1,  2]}', 'json stored as given';
  FOREACH r IN ARRAY ARRAY[to_jsonb('{bad'::text), to_jsonb('not json'::text), to_jsonb('{"a":}'::text)]
  LOOP
    ASSERT (pg_temp.sic('t_json', r #>> '{}')->>'success')::boolean = false, 'json rejects ' || (r #>> '{}');
  END LOOP;
  ASSERT (pg_temp.sic('t_json', '"\u0000"')->>'success')::boolean = false, 'json with a NUL escape is rejected, not an error';
  ASSERT pg_temp.sic('t_json', '{bad')->>'error' LIKE 't\_json%JSON%', 'the json error names the key and type';
  ASSERT pg_temp.val('t_json') = '{"a": [1,  2]}', 'invalid input left the stored value alone';

  -- locale
  r := pg_temp.sic('t_locale', ' en ');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_locale') = 'en', 'locale trimmed';
  r := pg_temp.sic('t_locale', 'pt-BR');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_locale') = 'pt-BR', 'regional locale';
  FOREACH r IN ARRAY ARRAY[to_jsonb('EN'::text), to_jsonb('english'::text), to_jsonb('en-us'::text), to_jsonb('en_US'::text), to_jsonb('e'::text)]
  LOOP
    ASSERT (pg_temp.sic('t_locale', r #>> '{}')->>'success')::boolean = false, 'locale rejects ' || (r #>> '{}');
  END LOOP;
  ASSERT pg_temp.sic('t_locale', 'EN')->>'error' LIKE 't\_locale%language code%', 'the locale error names the key and type';
  ASSERT pg_temp.val('t_locale') = 'pt-BR', 'invalid input left the stored value alone';

  -- locale_list: items trimmed and joined without spaces
  r := pg_temp.sic('t_locale_list', ' en, es ,pt-BR');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_locale_list') = 'en,es,pt-BR', 'locale list normalized: ' || r::text;
  r := pg_temp.sic('t_locale_list', 'en');
  ASSERT (r->>'success')::boolean AND pg_temp.val('t_locale_list') = 'en', 'single-item locale list';
  FOREACH r IN ARRAY ARRAY[to_jsonb('en,,es'::text), to_jsonb('en,xx1'::text), to_jsonb(','::text), to_jsonb('en,ES'::text), to_jsonb('en;es'::text)]
  LOOP
    ASSERT (pg_temp.sic('t_locale_list', r #>> '{}')->>'success')::boolean = false, 'locale list rejects ' || (r #>> '{}');
  END LOOP;
  ASSERT pg_temp.sic('t_locale_list', 'en,,es')->>'error' LIKE 't\_locale\_list%language codes%', 'the locale list error names the key and type';
  ASSERT pg_temp.val('t_locale_list') = 'en', 'invalid input left the stored value alone';

  -- blank clears every typed key
  PERFORM pg_temp.sic('t_integer', '');
  PERFORM pg_temp.sic('t_number', NULL);
  PERFORM pg_temp.sic('t_boolean', ' ');
  PERFORM pg_temp.sic('t_json', '');
  PERFORM pg_temp.sic('t_locale', '');
  PERFORM pg_temp.sic('t_locale_list', NULL);
  ASSERT (SELECT count(*) FROM metadata.instance_config WHERE config_key LIKE 't\_%' AND config_key NOT IN ('t_string') AND config_value IS NOT NULL) = 0,
    'blank or NULL clears every typed key';

  -- the admin's direct UPDATE of config_value is allowed (RLS update policy), other columns are not
  UPDATE metadata.instance_config SET config_value = 'direct' WHERE config_key = 't_string';
  ASSERT pg_temp.val('t_string') = 'direct', 'admin direct UPDATE of config_value works';
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.instance_config SET is_public = true$q$, '42501'),
    'even admin cannot update is_public through the API';

  -- a direct UPDATE is validated by the same trigger as the RPC
  PERFORM pg_temp.sic('t_integer', '5');
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.instance_config SET config_value = 'abc' WHERE config_key = 't_integer'$q$, '23514'),
    'a direct UPDATE of an integer key with abc is rejected (check_violation)';
  ASSERT pg_temp.val('t_integer') = '5', 'and the row is unchanged';
  UPDATE metadata.instance_config SET config_value = ' en , es ' WHERE config_key = 'supported_locales';
  ASSERT pg_temp.val('supported_locales') = 'en,es', 'a direct UPDATE normalizes a locale list: ' || COALESCE(pg_temp.val('supported_locales'), 'NULL');
  UPDATE metadata.instance_config SET config_value = E'\t' WHERE config_key = 't_integer';
  ASSERT pg_temp.val('t_integer') IS NULL, 'a direct UPDATE with a tab stores NULL';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Reading after an admin set: get_config for non-admin and anonymous callers
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated","roles":["admin"]}', true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.sic('app_title', 'Test Title');
RESET ROLE;

SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated","roles":["user"]}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT public.get_config('sms_configured') = 'true', 'an authenticated non-admin reads the value the admin set';
  ASSERT public.get_config('app_title') = 'Test Title', 'and a public one';
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT public.get_config('sms_configured') IS NULL, 'web_anon still gets NULL for sms_configured once it is set';
  ASSERT public.get_config('app_title') = 'Test Title', 'web_anon reads a public value';
  ASSERT (SELECT config_value FROM public.instance_config WHERE config_key = 'app_title') = 'Test Title', 'and through the view';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Cache version and updated_at: bumped by an update, visible to both readers
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
SELECT set_config('ic.anon_version', (SELECT version::text FROM public.schema_cache_versions WHERE cache_name = 'instance_config'), true);
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated","roles":["user"]}', true);
SET LOCAL ROLE authenticated;
SELECT set_config('ic.user_version', (SELECT version::text FROM public.schema_cache_versions WHERE cache_name = 'instance_config'), true);
RESET ROLE;

DO $$
BEGIN
  ASSERT (SELECT updated_at FROM metadata.instance_config WHERE config_key = 'sms_configured') > current_setting('ic.sms_updated_at')::timestamptz,
    'an update bumps updated_at';
  ASSERT current_setting('ic.anon_version')::timestamptz > current_setting('ic.version')::timestamptz,
    'the instance_config cache version moved for web_anon';
  ASSERT current_setting('ic.user_version')::timestamptz > current_setting('ic.version')::timestamptz,
    'the instance_config cache version moved for authenticated';
  ASSERT current_setting('ic.anon_version') = current_setting('ic.user_version'), 'both readers see the same version';
  ASSERT current_setting('ic.anon_version')::timestamptz =
    (SELECT max(updated_at) FROM metadata.instance_config), 'the version is the newest updated_at, never a value';
END $$;

-- ---------------------------------------------------------------------------
-- The contract hash ignores config values
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT metadata.schema_contract_hash() = current_setting('ic.hash'),
    'schema_contract_hash is unchanged by config updates';
END $$;

ROLLBACK;
SQL
then
  # a second session: the rollback left nothing behind
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM metadata.instance_config) = 10, 'no temporary key remains';
  ASSERT (SELECT count(*) FROM metadata.instance_config WHERE config_value IS NOT NULL) = 0, 'every framework key is back to NULL';
END $$;
SQL
  echo "PASS: instance config store (visibility, typed set_instance_config, get_config, write lockdown, cache version, contract hash)"
else
  echo "FAIL: instance config checks failed (see error above)"
  exit 1
fi
