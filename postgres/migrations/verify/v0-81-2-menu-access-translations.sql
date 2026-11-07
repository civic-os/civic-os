-- Verify civic_os:v0-81-2-menu-access-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM metadata.translations
      WHERE source_type = 'ui'
        AND source_key IN ('admin_menu.conflict', 'admin_menu.reload')
        AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps')) <> 12 THEN
    RAISE EXCEPTION 'Expected 2 keys x 6 locales (12 rows)';
  END IF;
END $$;
