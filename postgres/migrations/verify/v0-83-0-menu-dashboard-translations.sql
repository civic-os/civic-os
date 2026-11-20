-- Verify civic_os:v0-83-0-menu-dashboard-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM metadata.translations
      WHERE source_type = 'ui'
        AND source_key IN (
          'admin_menu.dashboard_badge',
          'admin_menu.dashboards',
          'admin_menu.dashboards_help',
          'admin_menu.dashboards_empty',
          'admin_menu.dashboard_not_shown_help',
          'admin_menu.links_to',
          'admin_menu.links_to_none',
          'admin_menu.links_to_help',
          'admin_menu.error.dashboard-key',
          'admin_menu.error.dashboard-children',
          'admin_menu.error.duplicate-dashboard'
        )
        AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps')) <> 66 THEN
    RAISE EXCEPTION 'Expected 11 keys x 6 locales (66 rows)';
  END IF;
END $$;
