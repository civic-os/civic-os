-- Verify civic_os:v0-57-0-add-i18n on pg

-- Verify metadata.translations table
SELECT 1 FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'translations';

-- Verify metadata.t() function
SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 't';

-- Verify metadata.current_locale() function
SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'current_locale';

-- Verify locale column on civic_os_users_private
SELECT 1 FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'civic_os_users_private' AND column_name = 'locale';

-- Verify public.translations VIEW
SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'translations';

-- Verify public.civic_os_users VIEW includes locale
SELECT 1 FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'civic_os_users' AND column_name = 'locale';

-- Verify RPCs
SELECT 1 FROM pg_proc WHERE proname = 'get_translations_for_locale';
SELECT 1 FROM pg_proc WHERE proname = 'upsert_translations';
SELECT 1 FROM pg_proc WHERE proname = 'get_missing_translations';

-- Verify seed data exists for both locales
SELECT 1 FROM metadata.translations WHERE source_type = 'ui' AND locale = 'en' LIMIT 1;
SELECT 1 FROM metadata.translations WHERE source_type = 'ui' AND locale = 'es' LIMIT 1;
