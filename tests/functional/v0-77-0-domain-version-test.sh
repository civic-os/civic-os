#!/bin/bash
# =============================================================================
# Functional Test: v0-77-0 domain version record and schema contract hash
# =============================================================================
# Covers metadata.domain_version (single row, semver and ADR CHECKs), public.set_domain_version()
# (admin only, requires an existing schema decision and stamps it), public.schema_domain_version
# (security_invoker), and metadata.schema_contract_hash():
#   - equal for web_anon, authenticated, editor and admin callers, and in locales en and es
#     (with a Spanish translation present for the fixture's display name);
#   - changes when a column is added or an action parameter's required flag changes;
#   - does not change when a display name, a status row or a permission changes.
#
# All fixtures are created inside one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-77-0-domain-version-test.sh
#
# Environment overrides (the connecting user must be a superuser, to create fixtures and switch roles):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures: a table, a translation of its display name, an action with a parameter, a decision
-- ---------------------------------------------------------------------------
CREATE TABLE public.dv_fixture (id serial PRIMARY KEY, name text NOT NULL);
GRANT SELECT ON public.dv_fixture TO web_anon, authenticated;
INSERT INTO metadata.entities (table_name, display_name) VALUES ('dv_fixture', 'DV Fixture');
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text)
VALUES ('entity', 'dv_fixture.display_name', 'es', 'Accesorio DV'),
       ('property', 'dv_fixture.name.display_name', 'es', 'Nombre DV');

INSERT INTO metadata.entity_actions (table_name, action_name, display_name, rpc_function)
VALUES ('dv_fixture', 'dv_close', 'Close', 'dv_close_rpc');
INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required)
SELECT id, 'p_note', 'Note', 'text', false FROM metadata.entity_actions WHERE action_name = 'dv_close';

INSERT INTO metadata.schema_decisions (title, decision) VALUES ('dv decision one', 'one'), ('dv decision two', 'two');

CREATE FUNCTION pg_temp.expect_sqlstate(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE = p_state;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_sqlstate(text, text) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- Table shape: single row, semver CHECKs, ADR rule, seed
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM metadata.domain_version) = 1, 'the seed row exists';
  ASSERT (SELECT domain_version FROM metadata.domain_version) = '0.0.0', 'seeded at 0.0.0';
  ASSERT (SELECT decision_id FROM metadata.domain_version) IS NULL,
    'the seed row is allowed a NULL decision_id';

  ASSERT pg_temp.expect_sqlstate($q$INSERT INTO metadata.domain_version (id, domain_version, set_by_migration, decision_id)
    SELECT false, '1.0.0', 'm', min(id) FROM metadata.schema_decisions$q$, '23514'),
    'a second row (id = false) is rejected by the single-row CHECK';
  ASSERT pg_temp.expect_sqlstate($q$INSERT INTO metadata.domain_version (id, domain_version, set_by_migration, decision_id)
    SELECT true, '1.0.0', 'm', min(id) FROM metadata.schema_decisions$q$, '23505'),
    'a second row (id = true) is rejected by the primary key';

  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.domain_version SET domain_version = '1.0'$q$, '23514'),
    'a two-part version is rejected';
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.domain_version SET domain_version = '01.0.0'$q$, '23514'),
    'a leading zero is rejected';
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.domain_version SET domain_version = 'v1.0.0'$q$, '23514'),
    'a v prefix is rejected';
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.domain_version SET min_client_domain_version = 'latest'$q$, '23514'),
    'a malformed minimum client version is rejected';
  -- the CHECK is the SemVer 2.0.0 grammar core's checkCompatibility parses, so no stored version reads as invalid
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.domain_version SET min_client_domain_version = '1.0.0-01'$q$, '23514'),
    'a numeric pre-release identifier with a leading zero is rejected';
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.domain_version SET min_client_domain_version = '1.0.0-rc..1'$q$, '23514'),
    'an empty pre-release identifier is rejected';
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.domain_version SET min_client_domain_version = '1.0.0+build.'$q$, '23514'),
    'an empty build identifier is rejected';
  UPDATE metadata.domain_version SET min_client_domain_version = '0.0.0-rc.1+build.5';  -- a full SemVer value is accepted
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.schema_decisions SET domain_version = 'x' WHERE title = 'dv decision one'$q$, '23514'),
    'a malformed schema_decisions.domain_version is rejected';

  -- UPDATE bypass of the function: a non-seed version without a decision
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.domain_version SET domain_version = '1.0.0'$q$, '23514'),
    'a non-seed version without a decision is rejected by the CHECK';
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.domain_version SET decision_id = 999999999$q$, '23503'),
    'decision_id must reference an existing decision';
  UPDATE metadata.domain_version SET min_client_domain_version = '0.0.0';  -- the seed may still change other fields
END $$;

-- ---------------------------------------------------------------------------
-- Hash and view: equal across roles and locales
-- ---------------------------------------------------------------------------
SELECT set_config('dv.base', metadata.schema_contract_hash(), true);

DO $$
BEGIN
  ASSERT current_setting('dv.base') ~ '^sha256:[0-9a-f]{64}$', 'the hash has the sha256:<hex> form';
  ASSERT (SELECT contract_hash FROM public.schema_domain_version) = current_setting('dv.base'),
    'the view returns the function''s hash';
  ASSERT (SELECT framework_version FROM public.schema_domain_version) ~ '^[0-9]+\.[0-9]+\.[0-9]+$',
    'the framework version is derived from the Sqitch registry';
END $$;

-- web_anon, English
SELECT set_config('request.jwt.claims', '{}', true);
SELECT set_config('request.headers', '{"accept-language":"en"}', true);
SET LOCAL ROLE web_anon;
SELECT set_config('dv.anon_en', metadata.schema_contract_hash(), true);
SELECT set_config('dv.anon_en_view', (SELECT contract_hash FROM public.schema_domain_version), true);
RESET ROLE;

-- authenticated user, Spanish
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated","roles":["user"]}', true);
SELECT set_config('request.headers', '{"accept-language":"es"}', true);
SET LOCAL ROLE authenticated;
SELECT set_config('dv.user_es', metadata.schema_contract_hash(), true);
SELECT set_config('dv.user_es_view', (SELECT contract_hash FROM public.schema_domain_version), true);
-- the translation really is visible to this caller (otherwise the locale check proves nothing)
SELECT set_config('dv.es_name', (SELECT display_name FROM public.schema_entities WHERE table_name = 'dv_fixture'), true);
RESET ROLE;

-- editor, English
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated","roles":["editor"]}', true);
SELECT set_config('request.headers', '{"accept-language":"en"}', true);
SET LOCAL ROLE authenticated;
SELECT set_config('dv.editor_en', metadata.schema_contract_hash(), true);
RESET ROLE;

-- admin, Spanish regional variant
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated","roles":["admin"]}', true);
SELECT set_config('request.headers', '{"accept-language":"es-MX"}', true);
SET LOCAL ROLE authenticated;
SELECT set_config('dv.admin_es', metadata.schema_contract_hash(), true);
SELECT set_config('dv.admin_es_view', (SELECT contract_hash FROM public.schema_domain_version), true);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{}', true);
SELECT set_config('request.headers', '{}', true);

DO $$
BEGIN
  ASSERT current_setting('dv.es_name') = 'Accesorio DV', 'the es translation reaches schema_entities: ' || current_setting('dv.es_name');
  ASSERT current_setting('dv.anon_en') = current_setting('dv.base'), 'web_anon/en hash equals the superuser hash';
  ASSERT current_setting('dv.user_es') = current_setting('dv.base'), 'authenticated/es hash equals the superuser hash';
  ASSERT current_setting('dv.editor_en') = current_setting('dv.base'), 'editor/en hash equals the superuser hash';
  ASSERT current_setting('dv.admin_es') = current_setting('dv.base'), 'admin/es-MX hash equals the superuser hash';
  ASSERT current_setting('dv.anon_en_view') = current_setting('dv.base') AND
         current_setting('dv.user_es_view') = current_setting('dv.base') AND
         current_setting('dv.admin_es_view') = current_setting('dv.base'),
    'the view returns the same hash to every role and locale';
  RAISE NOTICE 'hash web_anon/en=% authenticated/es=% editor/en=% admin/es-MX=%',
    current_setting('dv.anon_en'), current_setting('dv.user_es'), current_setting('dv.editor_en'), current_setting('dv.admin_es');
END $$;

-- ---------------------------------------------------------------------------
-- Hash sensitivity
-- ---------------------------------------------------------------------------
-- presentation, permissions and status/category rows do not change it
UPDATE metadata.entities SET display_name = 'Renamed', description = 'x', sort_order = 99, show_in_sidebar = false
WHERE table_name = 'dv_fixture';
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, sortable, filterable, column_width)
VALUES ('dv_fixture', 'name', 'Renamed Name', 'd', 7, false, false, true, 2)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, description = EXCLUDED.description, sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list, sortable = EXCLUDED.sortable, filterable = EXCLUDED.filterable,
      column_width = EXCLUDED.column_width;
UPDATE metadata.entity_actions SET display_name = 'Close it', icon = 'x', sort_order = 5 WHERE action_name = 'dv_close';
UPDATE metadata.translations SET translated_text = 'Otro' WHERE source_key = 'dv_fixture.display_name';
INSERT INTO metadata.status_types (entity_type) VALUES ('dv_fixture');
INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, is_initial, is_terminal, status_key)
VALUES ('dv_fixture', 'Open', '#00ff00', 1, true, false, 'open');
INSERT INTO metadata.category_groups (entity_type) VALUES ('dv_fixture');
INSERT INTO metadata.categories (entity_type, display_name, color, sort_order, category_key)
VALUES ('dv_fixture', 'Cat', '#ff0000', 1, 'cat');
UPDATE metadata.statuses SET display_name = 'Opened', color = '#0000ff' WHERE entity_type = 'dv_fixture';
INSERT INTO metadata.permissions (table_name, permission) VALUES ('dv_fixture', 'read') ON CONFLICT DO NOTHING;

DO $$
BEGIN
  ASSERT metadata.schema_contract_hash() = current_setting('dv.base'),
    'display names, descriptions, sort order, show_on_*, translations, status/category rows and permissions must not change the hash';
END $$;

-- an added column changes it
ALTER TABLE public.dv_fixture ADD COLUMN extra int;
SELECT set_config('dv.after_col', metadata.schema_contract_hash(), true);
DO $$
BEGIN
  ASSERT current_setting('dv.after_col') <> current_setting('dv.base'), 'an added column must change the hash';
END $$;

-- a changed action parameter changes it
UPDATE metadata.entity_action_params SET required = true WHERE param_name = 'p_note';
SELECT set_config('dv.after_param', metadata.schema_contract_hash(), true);
DO $$
BEGIN
  ASSERT current_setting('dv.after_param') <> current_setting('dv.after_col'), 'a changed action param must change the hash';
END $$;

-- a feature flag changes it
UPDATE metadata.entities SET enable_notes = true WHERE table_name = 'dv_fixture';
DO $$
BEGIN
  ASSERT metadata.schema_contract_hash() <> current_setting('dv.after_param'), 'an entity feature flag must change the hash';
END $$;

-- ---------------------------------------------------------------------------
-- Security properties
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT (SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid = 'public.schema_domain_version'::regclass),
    'the view sets security_invoker = true';
  ASSERT (SELECT prosecdef AND proconfig IS NOT NULL AND proconfig::text LIKE '%search_path%'
          FROM pg_proc WHERE oid = 'metadata.schema_contract_hash()'::regprocedure),
    'the hash function is SECURITY DEFINER with a pinned search_path';
  ASSERT (SELECT prosecdef AND proconfig::text LIKE '%search_path%'
          FROM pg_proc WHERE oid = 'public.set_domain_version(text,text,text,integer)'::regprocedure),
    'set_domain_version is SECURITY DEFINER with a pinned search_path';
  ASSERT NOT has_function_privilege('public', 'metadata.schema_contract_hash()', 'EXECUTE'), 'no PUBLIC execute on the hash';
  ASSERT NOT has_function_privilege('public', 'metadata.framework_version()', 'EXECUTE'), 'no PUBLIC execute on framework_version';
  ASSERT NOT has_function_privilege('public', 'public.set_domain_version(text,text,text,integer)', 'EXECUTE'), 'no PUBLIC execute on set_domain_version';
  ASSERT NOT has_function_privilege('web_anon', 'public.set_domain_version(text,text,text,integer)', 'EXECUTE'), 'web_anon cannot run set_domain_version';
  ASSERT has_function_privilege('authenticated', 'public.set_domain_version(text,text,text,integer)', 'EXECUTE'), 'authenticated can run it (the body guards admin)';
  ASSERT has_function_privilege('web_anon', 'metadata.schema_contract_hash()', 'EXECUTE') AND
         has_function_privilege('authenticated', 'metadata.schema_contract_hash()', 'EXECUTE'), 'both API roles can read the hash';
  ASSERT has_table_privilege('web_anon', 'public.schema_domain_version', 'SELECT') AND
         has_table_privilege('authenticated', 'public.schema_domain_version', 'SELECT'), 'both API roles can read the view';
  ASSERT NOT has_table_privilege('authenticated', 'metadata.domain_version', 'INSERT,UPDATE,DELETE'), 'no direct write grant on the table';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'metadata.domain_version'::regclass), 'RLS enabled';
END $$;

-- ---------------------------------------------------------------------------
-- set_domain_version
-- ---------------------------------------------------------------------------
-- web_anon: no execute
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.set_domain_version('1.0.0', NULL, 'm', 1)$q$, '42501'),
    'web_anon is refused';
END $$;
RESET ROLE;

-- authenticated non-admin: refused by the in-body guard
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated","roles":["manager"]}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate(
    format($q$SELECT public.set_domain_version('1.0.0', NULL, 'm', %s)$q$, (SELECT min(id) FROM metadata.schema_decisions)),
    '42501'), 'a non-admin is refused with 42501';
END $$;
RESET ROLE;
DO $$
BEGIN
  ASSERT (SELECT domain_version FROM metadata.domain_version) = '0.0.0', 'the refused call changed nothing';
END $$;

-- admin
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated","roles":["admin"]}', true);
SET LOCAL ROLE authenticated;
SELECT set_config('dv.d1', (SELECT id::text FROM metadata.schema_decisions WHERE title = 'dv decision one'), true);
SELECT set_config('dv.d2', (SELECT id::text FROM metadata.schema_decisions WHERE title = 'dv decision two'), true);
DO $$
DECLARE d1 int := current_setting('dv.d1')::int; d2 int := current_setting('dv.d2')::int;
BEGIN
  -- no decision, nonexistent decision
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.set_domain_version('1.0.0', NULL, 'm', NULL)$q$, '23502'),
    'a NULL decision is refused (23502)';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.set_domain_version('1.0.0', NULL, 'm', 999999999)$q$, '23503'),
    'a nonexistent decision is refused (23503)';
  -- malformed input
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.set_domain_version('1.0', NULL, 'm', %s)$q$, d1), '22023'),
    'a malformed version is refused (22023)';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.set_domain_version('1.0.0-01', NULL, 'm', %s)$q$, d1), '22023'),
    'a pre-release with a leading zero is refused (22023), as core would read it as invalid';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.set_domain_version('1.0.0', 'x', 'm', %s)$q$, d1), '22023'),
    'a malformed floor is refused (22023)';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.set_domain_version('1.0.0', '1.1.0', 'm', %s)$q$, d1), '22023'),
    'a floor above the version is refused (22023)';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.set_domain_version('1.0.0', NULL, '', %s)$q$, d1), '22023'),
    'an empty migration name is refused (22023)';
  ASSERT (SELECT domain_version FROM metadata.domain_version) = '0.0.0', 'refused calls changed nothing';

  -- valid
  PERFORM public.set_domain_version('1.2.0', '1.0.0', 'v1-2-0-my-change', d1);
  ASSERT (SELECT (domain_version, min_client_domain_version, set_by_migration, decision_id)::text
          FROM metadata.domain_version) = format('(1.2.0,1.0.0,v1-2-0-my-change,%s)', d1),
    'the record holds the new version, floor, migration and decision';
  ASSERT (SELECT domain_version FROM public.schema_decisions WHERE id = d1) = '1.2.0',
    'the decision is stamped with the version (visible through the public view)';
  ASSERT (SELECT decision_id FROM public.schema_domain_version) = d1, 'the view reflects it';

  -- same decision, same version: idempotent
  PERFORM public.set_domain_version('1.2.0', NULL, 'v1-2-0-my-change', d1);
  -- a decision already linked to another version is refused
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.set_domain_version('1.3.0', NULL, 'm', %s)$q$, d1), '23505'),
    'a decision linked to a different version is refused (23505)';
  ASSERT (SELECT domain_version FROM metadata.domain_version) = '1.2.0', 'the refused call changed nothing';
  -- a second decision moves the version on
  PERFORM public.set_domain_version('1.3.0', NULL, 'v1-3-0-next', d2);
  ASSERT (SELECT domain_version FROM public.schema_decisions WHERE id = d2) = '1.3.0', 'the second decision is stamped';
  ASSERT (SELECT domain_version FROM public.schema_decisions WHERE id = d1) = '1.2.0', 'the first keeps its version';
END $$;
RESET ROLE;

-- the record still obeys the ADR rule after a valid call
DO $$
BEGIN
  ASSERT (SELECT decision_id IS NOT NULL FROM metadata.domain_version), 'a set version carries its decision';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: domain version record, set_domain_version() ADR rule and role/locale-independent contract hash"
else
  echo "FAIL: domain version checks failed (see error above)"
  exit 1
fi
