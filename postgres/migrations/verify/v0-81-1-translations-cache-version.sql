-- Verify civic_os:v0-81-1-translations-cache-version
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

DO $$
BEGIN
  IF to_regclass('metadata.translations_version') IS NULL OR (SELECT count(*) FROM metadata.translations_version) <> 1 THEN
    RAISE EXCEPTION 'metadata.translations_version must exist with exactly one row';
  END IF;
  IF to_regprocedure('metadata.translations_stamp_version()') IS NULL THEN
    RAISE EXCEPTION 'metadata.translations_stamp_version() is missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'metadata.translations'::regclass AND NOT tgisinternal
      AND tgname IN ('translations_stamp_version_insert', 'translations_stamp_version_update',
                     'translations_stamp_version_delete', 'translations_stamp_version_truncate')) <> 4 THEN
    RAISE EXCEPTION 'one of the four translations_stamp_version triggers is missing';
  END IF;
  IF has_function_privilege('authenticated', 'metadata.translations_stamp_version()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not execute translations_stamp_version';
  END IF;
  IF has_function_privilege('web_anon', 'metadata.translations_stamp_version()', 'EXECUTE') THEN
    RAISE EXCEPTION 'web_anon must not execute translations_stamp_version';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_cache_versions WHERE cache_name = 'translations') THEN
    RAISE EXCEPTION 'schema_cache_versions has no translations row';
  END IF;
  IF pg_get_viewdef('public.schema_cache_versions'::regclass) NOT LIKE '%translations_version%' THEN
    RAISE EXCEPTION 'schema_cache_versions does not read translations_version';
  END IF;
END $$;
