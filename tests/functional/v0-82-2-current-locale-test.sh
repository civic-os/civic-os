#!/bin/bash
# =============================================================================
# Functional Test: v0-82-2 normalized metadata.current_locale()
# =============================================================================
# current_locale() turns the Accept-Language header into one language tag:
#   - the first language range, without its quality value (`en-US,en;q=0.9` -> `en`);
#   - every English variant is `en`, so metadata.t() takes its English short-circuit;
#   - anything that is not a language tag (`*`, empty, junk) is `en`;
#   - other tags keep their subtags with conventional casing (`es-mx` -> `es-MX`), and t() still
#     resolves them: exact locale, then base language.
# metadata.t() uses the translations index even when called with "C"-collated arguments, as
# schema_properties does (v0-82-2-translation-lookup-collation).
#
# All fixtures live inside one transaction that is rolled back. Headers are set the way PostgREST 13+
# sets them: a transaction-local `request.headers` JSON blob.
#
# Usage:
#   ./tests/functional/v0-82-2-current-locale-test.sh
#
# Environment overrides (the connecting user must be a superuser, to create fixtures):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

-- current_locale() as a request with this Accept-Language header sees it (NULL: no header)
CREATE FUNCTION pg_temp.locale_for(p_header text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.headers',
    CASE WHEN p_header IS NULL THEN '{}' ELSE json_build_object('accept-language', p_header)::text END,
    true);
  RETURN metadata.current_locale();
END $$;

-- Header normalization
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    (NULL,                         'en'),
    ('',                           'en'),
    ('*',                          'en'),
    ('en',                         'en'),
    ('en-US,en;q=0.9',             'en'),
    ('en-GB',                      'en'),
    ('EN-us',                      'en'),
    ('en_AU',                      'en'),
    ('es',                         'es'),
    ('es;q=0.8',                   'es'),
    (' fr-FR , fr;q=0.9, en;q=0.8', 'fr-FR'),
    ('es-mx,es;q=0.9',             'es-MX'),
    ('zh-hant-tw',                 'zh-Hant-TW'),
    ('es-419',                     'es-419'),
    ('ar',                         'ar'),
    ('prs',                        'prs'),
    ('x',                          'en'),
    ('es''; DROP TABLE x; --',     'en')
  ) AS t(header, expected)
  LOOP
    ASSERT pg_temp.locale_for(c.header) IS NOT DISTINCT FROM c.expected,
      format('Accept-Language %L gives %L, expected %L', c.header, pg_temp.locale_for(c.header), c.expected);
  END LOOP;
END $$;

-- A session that used request.headers before reads '' rather than NULL: still en, no JSON error
DO $$
BEGIN
  PERFORM set_config('request.headers', '', true);
  ASSERT metadata.current_locale() = 'en', 'an empty request.headers GUC gives en';
END $$;

-- Translations still resolve through metadata.t(): exact locale, then base language, else the default.
-- A synthetic key works on any database, including a core-only one.
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'v0_82_2_probe.col.display_name', 'es',    'Sonda ES'),
  ('property', 'v0_82_2_probe.col.display_name', 'es-MX', 'Sonda MX'),
  ('property', 'v0_82_2_probe.col.display_name', 'ar',    'مسبار'),
  ('property', 'v0_82_2_probe.col.display_name', 'en',    'Probe EN row');

CREATE FUNCTION pg_temp.t_for(p_header text, p_key text, p_default text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.locale_for(p_header);
  RETURN metadata.t('property', p_key, p_default);
END $$;

DO $$
DECLARE
  k text := 'v0_82_2_probe.col.display_name';
BEGIN
  ASSERT pg_temp.t_for('es', k, 'Probe') = 'Sonda ES', 'es resolves its translation';
  ASSERT pg_temp.t_for('es-MX,es;q=0.9', k, 'Probe') = 'Sonda MX', 'es-MX resolves its exact translation';
  ASSERT pg_temp.t_for('es-mx', k, 'Probe') = 'Sonda MX', 'a lowercase region still matches the es-MX row';
  ASSERT pg_temp.t_for('es-AR,es;q=0.9', k, 'Probe') = 'Sonda ES', 'es-AR falls back to the es translation';
  ASSERT pg_temp.t_for('ar', k, 'Probe') = 'مسبار', 'ar (RTL) resolves its translation';
  ASSERT pg_temp.t_for('de', k, 'Probe') = 'Probe', 'a locale with no row gives the default text';
  ASSERT pg_temp.t_for('en-US,en;q=0.9', k, 'Probe') = 'Probe',
    'en-US takes the English short-circuit (default text, even with an en row)';
  ASSERT pg_temp.t_for(NULL, k, 'Probe') = 'Probe', 'no header gives the default text';
END $$;

-- t() uses the translations index even when its arguments carry collation "C", as schema_properties'
-- information_schema names do (v0-82-2-translation-lookup-collation). With seq scans disabled the planner
-- only scans the table when no index matches the comparison's collation, so any seq scan counted in this
-- transaction means the lookup lost the index.
DO $$
DECLARE
  v_before bigint;
  v_after bigint;
  v_name text;
BEGIN
  SET LOCAL enable_seqscan = off;
  PERFORM pg_temp.locale_for('es-MX');
  SELECT coalesce(seq_scan, 0) INTO v_before FROM pg_stat_xact_user_tables
    WHERE relid = 'metadata.translations'::regclass;
  v_name := metadata.t('property'::text COLLATE "C", 'v0_82_2_probe.col.display_name' COLLATE "C", 'Probe');
  ASSERT v_name = 'Sonda MX', 'a "C"-collated key resolves its translation';
  v_name := metadata.t('property'::text COLLATE "C", 'v0_82_2_probe.col.missing' COLLATE "C", 'Probe');
  ASSERT v_name = 'Probe', 'a "C"-collated key with no row gives the default text';
  SELECT coalesce(seq_scan, 0) INTO v_after FROM pg_stat_xact_user_tables
    WHERE relid = 'metadata.translations'::regclass;
  ASSERT v_after = v_before,
    format('t() scanned metadata.translations sequentially %s times for "C"-collated keys', v_after - v_before);
  RESET enable_seqscan;
END $$;

-- The same through schema_properties, when the database has an entity property to probe (an example
-- database does; a core-only one does not)
CREATE TEMP TABLE probe AS
  SELECT table_name, column_name, display_name AS default_name,
         table_name || '.' || column_name || '.display_name' AS source_key
  FROM public.schema_properties
  ORDER BY table_name, column_name
  LIMIT 1;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text)
SELECT 'property', p.source_key, v.locale, v.text
FROM probe p, (VALUES ('es', 'Sonda ES'), ('es-MX', 'Sonda MX'), ('ar', 'مسبار')) AS v(locale, text)
ON CONFLICT (source_type, source_key, locale) DO UPDATE SET translated_text = EXCLUDED.translated_text;

CREATE FUNCTION pg_temp.name_for(p_header text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_name text;
BEGIN
  PERFORM pg_temp.locale_for(p_header);
  SELECT sp.display_name INTO v_name
  FROM public.schema_properties sp JOIN probe p USING (table_name, column_name);
  RETURN v_name;
END $$;

DO $$
DECLARE
  v_default text := (SELECT default_name FROM probe);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM probe) THEN
    RAISE NOTICE 'schema_properties is empty (core-only database): view checks skipped';
    RETURN;
  END IF;
  ASSERT pg_temp.name_for('es') = 'Sonda ES', 'schema_properties: es resolves its translation';
  ASSERT pg_temp.name_for('es-mx,es;q=0.9') = 'Sonda MX', 'schema_properties: es-MX resolves its exact translation';
  ASSERT pg_temp.name_for('ar') = 'مسبار', 'schema_properties: ar resolves its translation';
  ASSERT pg_temp.name_for('en-US,en;q=0.9') = v_default, 'schema_properties: en-US gives the default text';

  -- get_translation_defaults() forces accept-language: en, so it lists the untranslated name
  PERFORM pg_temp.locale_for('es');
  ASSERT EXISTS (
    SELECT 1 FROM public.get_translation_defaults() d JOIN probe p
      ON d.source_type = 'property' AND d.source_key = p.source_key
    WHERE d.default_text = p.default_name
  ), 'get_translation_defaults() returns the untranslated property name under an es request';
END $$;

-- Shape: STABLE, and still callable by the API roles (t() runs inside anonymously readable views)
DO $$
BEGIN
  ASSERT (SELECT provolatile FROM pg_proc WHERE oid = 'metadata.current_locale()'::regprocedure) = 's',
    'current_locale() is STABLE';
  ASSERT has_function_privilege('web_anon', 'metadata.current_locale()', 'EXECUTE'),
    'web_anon can execute current_locale()';
  ASSERT has_function_privilege('authenticated', 'metadata.current_locale()', 'EXECUTE'),
    'authenticated can execute current_locale()';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: v0-82-2 current_locale() normalization"
else
  echo "FAIL: v0-82-2 current_locale() normalization"
  exit 1
fi
