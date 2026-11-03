#!/bin/bash
# =============================================================================
# Functional Test: v0-80-2 instance config label translations
# =============================================================================
# Covers the metadata.t() routing in public.instance_config (display_name, description,
# group_display_name, group_description), driven the way PostgREST drives it: the
# Accept-Language header reaches SQL as the request.header.accept-language setting.
#   - English and no header return the column values;
#   - es/ar/fr/de/ps return distinct translated labels for every framework key and group;
#   - a regional tag (es-MX) falls back to its base language, an unsupported locale to English;
#   - an integrator key and group translate through the same source types, and an untranslated
#     integrator key falls back to its column value;
#   - the view keeps security_invoker, and web_anon still reads the public rows.
#
# All fixtures live inside one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-80-2-instance-config-label-i18n-test.sh
#
# Environment overrides (the connecting user must be a superuser, to create fixtures and switch roles):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

-- Integrator fixtures: one translated group and key, one key without a translation
INSERT INTO metadata.instance_config_groups (group_key, display_name, description, sort_order)
VALUES ('t_org', 'T Organization', 'T org description', 900);
INSERT INTO metadata.instance_config (config_key, config_type, group_key, display_name, description, is_public)
VALUES ('t_agency', 'string', 't_org', 'T Agency name', 'T agency help', true),
       ('t_plain',  'string', 't_org', 'T Plain',       'T plain help',  true);
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('instance_config_group', 't_org.display_name', 'es', 'T Organización'),
  ('instance_config_group', 't_org.description',  'es', 'T descripción'),
  ('instance_config', 't_agency.display_name', 'es', 'T Nombre de la agencia'),
  ('instance_config', 't_agency.description',  'es', 'T ayuda de la agencia');

-- Label of a key / group as seen under a locale
CREATE FUNCTION pg_temp.lbl(p_locale text, p_key text, p_col text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.header.accept-language', p_locale, true);
  EXECUTE format('SELECT %I FROM public.instance_config WHERE config_key = %L', p_col, p_key) INTO v;
  RETURN v;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.lbl(text, text, text) TO PUBLIC;

DO $$
BEGIN
  ASSERT (SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid = 'public.instance_config'::regclass),
    'public.instance_config keeps security_invoker = true';
  ASSERT pg_get_viewdef('public.instance_config'::regclass) LIKE '%metadata.t(%', 'the view routes labels through metadata.t()';
END $$;

SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated","roles":["user"]}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  loc text;
  col text;
  kk text;
  v text;
BEGIN
  -- English and a missing header return the column values
  ASSERT pg_temp.lbl('en', 'app_title', 'display_name') = 'Application title', 'en returns the column value';
  ASSERT pg_temp.lbl('', 'app_title', 'display_name') = 'Application title', 'no header returns the column value';
  ASSERT pg_temp.lbl('en', 'app_title', 'group_display_name') = 'Appearance', 'en group label';

  -- every framework key and group (explicit list: an example DB may hold untranslated integrator keys)
  -- translates in every non-English core locale
  FOREACH loc IN ARRAY ARRAY['es', 'ar', 'fr', 'de', 'ps'] LOOP
    FOREACH kk IN ARRAY ARRAY['app_title', 'default_theme', 'default_locale', 'supported_locales', 'sms_configured',
                              'matomo_enabled', 'stripe_publishable_key', 'map_default_lat', 'map_default_lng', 'map_default_zoom'] LOOP
      FOREACH col IN ARRAY ARRAY['display_name', 'description'] LOOP
        v := pg_temp.lbl(loc, kk, col);
        ASSERT v IS NOT NULL AND v <> '', format('%s.%s has a %s label', kk, col, loc);
        ASSERT v <> (SELECT CASE col WHEN 'display_name' THEN display_name ELSE description END
                     FROM metadata.instance_config WHERE config_key = kk),
          format('%s.%s is translated in %s', kk, col, loc);
      END LOOP;
    END LOOP;
    -- each group is read through one of its keys
    FOREACH kk IN ARRAY ARRAY['app_title', 'default_locale', 'matomo_enabled', 'map_default_lat'] LOOP
      FOREACH col IN ARRAY ARRAY['group_display_name', 'group_description'] LOOP
        v := pg_temp.lbl(loc, kk, col);
        ASSERT v IS NOT NULL AND v <> '', format('group of %s %s has a %s label', kk, col, loc);
        ASSERT v <> (SELECT CASE col WHEN 'group_display_name' THEN g.display_name ELSE g.description END
                     FROM metadata.instance_config c JOIN metadata.instance_config_groups g ON g.group_key = c.group_key
                     WHERE c.config_key = kk),
          format('group of %s %s is translated in %s', kk, col, loc);
      END LOOP;
    END LOOP;
  END LOOP;

  -- sms_configured is non-public: its translation is read as authenticated (see the role switch above)
  ASSERT pg_temp.lbl('es', 'sms_configured', 'display_name') = 'SMS habilitado', 'es sms_configured label (non-public key)';

  -- spot checks
  ASSERT pg_temp.lbl('es', 'app_title', 'display_name') = 'Título de la aplicación', 'es app_title label';
  ASSERT pg_temp.lbl('es', 'app_title', 'group_display_name') = 'Apariencia', 'es appearance group label';
  ASSERT pg_temp.lbl('fr', 'map_default_zoom', 'display_name') = 'Zoom par défaut', 'fr zoom label';

  -- regional tag falls back to the base language; unsupported locale falls back to English
  ASSERT pg_temp.lbl('es-MX', 'app_title', 'display_name') = 'Título de la aplicación', 'es-MX falls back to es';
  ASSERT pg_temp.lbl('zh', 'app_title', 'display_name') = 'Application title', 'unsupported locale falls back to English';

  -- integrator keys and groups use the same source types
  ASSERT pg_temp.lbl('es', 't_agency', 'display_name') = 'T Nombre de la agencia', 'integrator key label translates';
  ASSERT pg_temp.lbl('es', 't_agency', 'description') = 'T ayuda de la agencia', 'integrator key description translates';
  ASSERT pg_temp.lbl('es', 't_agency', 'group_display_name') = 'T Organización', 'integrator group label translates';
  ASSERT pg_temp.lbl('es', 't_agency', 'group_description') = 'T descripción', 'integrator group description translates';
  ASSERT pg_temp.lbl('de', 't_agency', 'display_name') = 'T Agency name', 'untranslated locale falls back to the column';
  ASSERT pg_temp.lbl('es', 't_plain', 'display_name') = 'T Plain', 'untranslated integrator key falls back to the column';

  -- the stored columns are untouched
  ASSERT (SELECT display_name FROM metadata.instance_config WHERE config_key = 'app_title') = 'Application title',
    'the stored display_name stays English';
END $$;

-- web_anon still reads the public rows translated
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT pg_temp.lbl('es', 'app_title', 'display_name') = 'Título de la aplicación', 'web_anon reads translated public labels';
  ASSERT NOT EXISTS (SELECT 1 FROM public.instance_config WHERE config_key = 'sms_configured'), 'web_anon does not see sms_configured';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: instance config labels translate per locale (framework and integrator keys, fallbacks)"
else
  echo "FAIL: instance config label translation checks failed (see error above)"
  exit 1
fi
