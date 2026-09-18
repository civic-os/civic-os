-- Revert civic_os:v0-76-0-maintenance-mode
-- Restores the original metadata.check_jwt() without maintenance mode logic.
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- AGPL-3.0-or-later

BEGIN;

-- ============================================================================
-- 1. RESTORE ORIGINAL metadata.check_jwt()
-- ============================================================================
-- This is the pre-maintenance-mode version: simple JWT-based role switching.

CREATE OR REPLACE FUNCTION metadata.check_jwt()
RETURNS VOID AS $$
BEGIN
  IF current_setting('request.jwt.claims', true)::json->>'sub' IS NOT NULL THEN
    EXECUTE 'SET LOCAL ROLE authenticated';
  ELSE
    EXECUTE 'SET LOCAL ROLE web_anon';
  END IF;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN RAISE NOTICE 'Restored original metadata.check_jwt() without maintenance mode'; END $$;

-- ============================================================================
-- 2. DELETE MAINTENANCE MODE TRANSLATIONS
-- ============================================================================

DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key LIKE 'maintenance.%'
  AND locale IN ('en', 'es', 'ar', 'fr', 'de', 'ps');

DO $$ BEGIN RAISE NOTICE 'Deleted maintenance mode translations'; END $$;

-- ============================================================================
-- 3. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
