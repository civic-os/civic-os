#!/bin/bash
# =============================================================================
# Functional Test: v0-81-3 widget empty-message translation defaults (issue #96)
# =============================================================================
# get_translation_defaults() lists a filtered_list widget's config.emptyMessage under the key that
# translate_widget_config() reads (widget_config, dashboard.<id>.widget.<id>.emptyMessage):
#   - a string emptyMessage yields one row with its English text;
#   - a JSON null, a number or a missing key yields no row, as translate_widget_config() checks a string;
#   - get_missing_translations() reports the key until a translation exists, and get_dashboard() then
#     returns the translated message;
#   - the function keeps its attributes (SECURITY INVOKER, STABLE) and its grants.
#
# All fixtures live inside one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-81-3-widget-empty-message-defaults-test.sh
#
# Environment overrides (the connecting user must be a superuser, to create fixtures and switch roles):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id INT);
GRANT ALL ON ids TO PUBLIC;

WITH d AS (
  INSERT INTO metadata.dashboards (display_name, is_public, sort_order)
  VALUES ('T empty message', TRUE, 9101) RETURNING id)
INSERT INTO ids SELECT 'dash', id FROM d;

-- a: a string message. b: JSON null. c: no key. n: a number. m: a markdown widget with the key (not filtered_list).
WITH w AS (
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, config, sort_order)
  SELECT (SELECT id FROM ids WHERE k = 'dash'), v.widget_type, v.config::jsonb, v.sort_order
  FROM (VALUES
    ('filtered_list', '{"filters":[],"emptyMessage":"T nothing waiting"}', 1),
    ('filtered_list', '{"filters":[],"emptyMessage":null}', 2),
    ('filtered_list', '{"filters":[]}', 3),
    ('filtered_list', '{"filters":[],"emptyMessage":5}', 4),
    ('markdown', '{"content":"x","emptyMessage":"T not a list"}', 5)
  ) AS v(widget_type, config, sort_order)
  RETURNING id, sort_order)
INSERT INTO ids SELECT CASE sort_order WHEN 1 THEN 'a' WHEN 2 THEN 'b' WHEN 3 THEN 'c' WHEN 4 THEN 'n' ELSE 'm' END, id
FROM w;

CREATE FUNCTION pg_temp.k(p TEXT) RETURNS TEXT LANGUAGE sql AS $$
  SELECT 'dashboard.' || (SELECT id FROM ids WHERE k = 'dash') || '.widget.' || (SELECT id FROM ids WHERE k = p)
    || '.emptyMessage'
$$;
-- Default privileges revoke PUBLIC EXECUTE on new functions (v0.76.5), temp ones included
GRANT EXECUTE ON FUNCTION pg_temp.k(TEXT) TO PUBLIC;

-- Attributes and grants are unchanged
DO $$
BEGIN
  ASSERT NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_translation_defaults()'::regprocedure),
    'get_translation_defaults stays SECURITY INVOKER';
  ASSERT (SELECT provolatile FROM pg_proc WHERE oid = 'public.get_translation_defaults()'::regprocedure) = 's',
    'get_translation_defaults stays STABLE';
  ASSERT has_function_privilege('web_anon', 'public.get_translation_defaults()', 'EXECUTE'),
    'web_anon executes get_translation_defaults';
  ASSERT has_function_privilege('authenticated', 'public.get_translation_defaults()', 'EXECUTE'),
    'authenticated executes get_translation_defaults';
END $$;

SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated","roles":["user"]}', true);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.get_translation_defaults()
          WHERE source_type = 'widget_config' AND source_key = pg_temp.k('a')
            AND default_text = 'T nothing waiting') = 1,
    'a string emptyMessage has exactly one English default';
  ASSERT NOT EXISTS (SELECT 1 FROM public.get_translation_defaults()
                     WHERE source_key IN (pg_temp.k('b'), pg_temp.k('c'), pg_temp.k('n'), pg_temp.k('m'))),
    'a null, missing or non-string emptyMessage, or one on another widget type, has no default';
  ASSERT EXISTS (SELECT 1 FROM public.get_missing_translations('es')
                 WHERE source_type = 'widget_config' AND source_key = pg_temp.k('a')),
    'the untranslated emptyMessage is missing in es';
END $$;

RESET ROLE;
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text)
VALUES ('widget_config', pg_temp.k('a'), 'es', 'T nada pendiente');
SET LOCAL ROLE authenticated;

SELECT set_config('request.headers', '{"accept-language":"es"}', true);
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.get_missing_translations('es') WHERE source_key = pg_temp.k('a')),
    'a translated emptyMessage leaves the es missing list';
  ASSERT EXISTS (SELECT 1 FROM public.get_missing_translations('fr') WHERE source_key = pg_temp.k('a')),
    'the emptyMessage is still missing in fr';
END $$;

-- get_translation_defaults() (under get_missing_translations()) sets request.headers to English for the rest of
-- the transaction, so its defaults come back untranslated. PostgREST runs each request in its own transaction;
-- here, set Spanish again before reading the dashboard.
SELECT set_config('request.headers', '{"accept-language":"es"}', true);
DO $$
BEGIN
  ASSERT (SELECT w->'config'->>'emptyMessage'
          FROM jsonb_array_elements(to_jsonb(public.get_dashboard((SELECT id FROM ids WHERE k = 'dash')))->'widgets') AS w
          WHERE (w->>'id')::int = (SELECT id FROM ids WHERE k = 'a')) = 'T nada pendiente',
    'get_dashboard returns the es emptyMessage';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: get_translation_defaults() lists filtered_list empty messages as translate_widget_config() reads them"
else
  echo "FAIL: widget empty-message default checks failed (see error above)"
  exit 1
fi
