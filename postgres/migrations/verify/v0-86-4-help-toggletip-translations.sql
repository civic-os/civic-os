-- Verify civic_os:v0-86-4-help-toggletip-translations on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

SELECT 1 / (CASE WHEN COUNT(*) = 12 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'ui' AND source_key IN ('a11y.show_description', 'a11y.hide_description')
  AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps');

ROLLBACK;
