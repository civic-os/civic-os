-- Verify civic_os:v0-86-4-dashboard-unavailable-translations on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

SELECT 1 / (CASE WHEN COUNT(*) = 30 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'ui' AND source_key IN ('dashboard.loading', 'dashboard.unavailable.title', 'dashboard.unavailable.message', 'dashboard.unavailable.sign_in_message', 'dashboard.unavailable.go_home')
  AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps');

ROLLBACK;
