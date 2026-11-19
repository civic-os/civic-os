-- Verify civic_os:v0-82-1-dashboard-selector-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM metadata.translations
      WHERE source_type = 'ui'
        AND source_key IN ('dashboard.all', 'dashboard.loading_list', 'dashboard.unnamed')
        AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps')) <> 18 THEN
    RAISE EXCEPTION 'Expected 3 keys x 6 locales (18 rows)';
  END IF;
END $$;
