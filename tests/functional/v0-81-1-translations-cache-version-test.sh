#!/bin/bash
# =============================================================================
# Functional Test: v0-81-1 translations cache version (issue #78) and config translation defaults (#89)
# =============================================================================
# The 'translations' row of public.schema_cache_versions reads metadata.translations_version, which
# statement-level triggers stamp on every write to metadata.translations:
#   - INSERT, UPDATE, DELETE and TRUNCATE each move the version (a delete used to leave it alone);
#   - a statement that touches no row still moves it (statement-level, like metadata.menu_version);
#   - API roles cannot execute the stamp function, and cannot read or write the version table.
#
# All fixtures live inside one transaction that is rolled back. clock_timestamp() advances inside a
# transaction, so each statement's stamp differs from the one before.
#
# Usage:
#   ./tests/functional/v0-81-1-translations-cache-version-test.sh
#
# Environment overrides (the connecting user must be a superuser, to create fixtures and switch roles):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

-- The translations version as clients read it
CREATE FUNCTION pg_temp.tv() RETURNS timestamptz LANGUAGE sql AS $$
  SELECT version::timestamptz FROM public.schema_cache_versions WHERE cache_name = 'translations'
$$;

CREATE TEMP TABLE seen (step text PRIMARY KEY, v timestamptz NOT NULL);
INSERT INTO seen VALUES ('start', pg_temp.tv());

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text)
VALUES ('ui', 't_cache_version.probe', 'es', 'Sonda');
INSERT INTO seen VALUES ('insert', pg_temp.tv());

UPDATE metadata.translations SET translated_text = 'Sonda 2'
WHERE source_type = 'ui' AND source_key = 't_cache_version.probe' AND locale = 'es';
INSERT INTO seen VALUES ('update', pg_temp.tv());

DELETE FROM metadata.translations
WHERE source_type = 'ui' AND source_key = 't_cache_version.probe' AND locale = 'es';
INSERT INTO seen VALUES ('delete', pg_temp.tv());

DELETE FROM metadata.translations WHERE source_key = 't_cache_version.no_such_key';
INSERT INTO seen VALUES ('empty_delete', pg_temp.tv());

TRUNCATE metadata.translations;
INSERT INTO seen VALUES ('truncate', pg_temp.tv());

DO $$
DECLARE
  steps text[] := ARRAY['start', 'insert', 'update', 'delete', 'empty_delete', 'truncate'];
  i int;
BEGIN
  ASSERT (SELECT v FROM seen WHERE step = 'start') IS NOT NULL, 'schema_cache_versions has a translations row';
  FOR i IN 2..array_length(steps, 1) LOOP
    ASSERT (SELECT v FROM seen WHERE step = steps[i]) > (SELECT v FROM seen WHERE step = steps[i - 1]),
      format('%s moves the translations version', steps[i]);
  END LOOP;
  ASSERT (SELECT count(*) FROM metadata.translations_version) = 1, 'translations_version stays a single row';
END $$;

-- API roles: no direct access to the stamp function or the version table
DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'metadata.translations_stamp_version()', 'EXECUTE'),
    'authenticated cannot execute translations_stamp_version';
  ASSERT NOT has_function_privilege('web_anon', 'metadata.translations_stamp_version()', 'EXECUTE'),
    'web_anon cannot execute translations_stamp_version';
  ASSERT NOT has_table_privilege('authenticated', 'metadata.translations_version', 'SELECT,INSERT,UPDATE,DELETE'),
    'authenticated has no privilege on translations_version';
  ASSERT NOT has_table_privilege('web_anon', 'metadata.translations_version', 'SELECT,INSERT,UPDATE,DELETE'),
    'web_anon has no privilege on translations_version';
  ASSERT (SELECT prosecdef FROM pg_proc WHERE oid = 'metadata.translations_stamp_version()'::regprocedure),
    'translations_stamp_version is SECURITY DEFINER';
  ASSERT (SELECT proconfig @> ARRAY['search_path=metadata, pg_catalog']
          FROM pg_proc WHERE oid = 'metadata.translations_stamp_version()'::regprocedure),
    'translations_stamp_version pins its search_path';
END $$;

-- An authenticated non-admin still reads the version through the view
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated","roles":["user"]}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT EXISTS (SELECT 1 FROM public.schema_cache_versions WHERE cache_name = 'translations'),
    'authenticated reads the translations version';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: every write to metadata.translations moves the translations cache version"
else
  echo "FAIL: translations cache version checks failed (see error above)"
  exit 1
fi

# -----------------------------------------------------------------------------
# v0-81-1-instance-config-translation-defaults (issue #89)
# -----------------------------------------------------------------------------
# get_translation_defaults() lists instance config key and group labels, so get_missing_translations()
# reports an integrator key with no translation, and the seeded framework keys are not missing.
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

INSERT INTO metadata.instance_config_groups (group_key, display_name, description, sort_order)
VALUES ('t_org', 'T Organization', 'T org description', 900);
INSERT INTO metadata.instance_config (config_key, config_type, group_key, display_name, description, is_public)
VALUES ('t_agency', 'string', 't_org', 'T Agency name', NULL, true),
       ('t_secret_label', 'string', 't_org', 'T Private', NULL, false);
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('instance_config_group', 't_org.display_name', 'es', 'T Organización');

SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e3","role":"authenticated","roles":["user"]}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  kk text;
BEGIN
  -- every framework key and group has an English default for its label and description
  FOREACH kk IN ARRAY ARRAY['app_title', 'default_theme', 'default_locale', 'supported_locales', 'sms_configured',
                            'matomo_enabled', 'stripe_publishable_key', 'map_default_lat', 'map_default_lng', 'map_default_zoom'] LOOP
    ASSERT EXISTS (SELECT 1 FROM public.get_translation_defaults()
                   WHERE source_type = 'instance_config' AND source_key = kk || '.display_name'),
      format('%s.display_name has a default', kk);
    ASSERT EXISTS (SELECT 1 FROM public.get_translation_defaults()
                   WHERE source_type = 'instance_config' AND source_key = kk || '.description'),
      format('%s.description has a default', kk);
  END LOOP;
  FOREACH kk IN ARRAY ARRAY['appearance', 'language', 'integrations', 'map'] LOOP
    ASSERT EXISTS (SELECT 1 FROM public.get_translation_defaults()
                   WHERE source_type = 'instance_config_group' AND source_key = kk || '.display_name'),
      format('group %s.display_name has a default', kk);
  END LOOP;
  ASSERT (SELECT default_text FROM public.get_translation_defaults()
          WHERE source_type = 'instance_config' AND source_key = 'app_title.display_name') = 'Application title',
    'app_title default is the English column value';
  ASSERT (SELECT default_text FROM public.get_translation_defaults()
          WHERE source_type = 'instance_config_group' AND source_key = 'appearance.display_name') = 'Appearance',
    'appearance default is the English column value';

  -- a NULL description yields no row
  ASSERT NOT EXISTS (SELECT 1 FROM public.get_translation_defaults()
                     WHERE source_type = 'instance_config' AND source_key = 't_agency.description'),
    'a key without a description has no description default';

  -- Missing: the untranslated integrator key, not the translated group or the seeded framework keys
  ASSERT EXISTS (SELECT 1 FROM public.get_missing_translations('es')
                 WHERE source_type = 'instance_config' AND source_key = 't_agency.display_name'
                   AND default_text = 'T Agency name'),
    'an integrator key with no Spanish row is missing';
  ASSERT NOT EXISTS (SELECT 1 FROM public.get_missing_translations('es')
                     WHERE source_type = 'instance_config_group' AND source_key = 't_org.display_name'),
    'a translated integrator group is not missing';
  ASSERT NOT EXISTS (SELECT 1 FROM public.get_missing_translations('es')
                     WHERE source_type LIKE 'instance_config%' AND source_key NOT LIKE 't\_%'),
    'framework config keys and groups are seeded in Spanish';
END $$;

-- web_anon: same grant as v0.81.0; RLS hides non-public keys
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT EXISTS (SELECT 1 FROM public.get_translation_defaults()
                 WHERE source_type = 'instance_config' AND source_key = 't_agency.display_name'),
    'web_anon sees public key defaults';
  ASSERT NOT EXISTS (SELECT 1 FROM public.get_translation_defaults()
                     WHERE source_type = 'instance_config' AND source_key = 't_secret_label.display_name'),
    'web_anon does not see non-public key defaults';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: instance config labels have English defaults and Missing entries"
else
  echo "FAIL: instance config translation default checks failed (see error above)"
  exit 1
fi
