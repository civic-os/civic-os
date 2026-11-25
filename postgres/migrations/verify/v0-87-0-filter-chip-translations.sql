-- Verify civic_os:v0-87-0-filter-chip-translations on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- Every key has a row in each of the six core locales
SELECT 1 / (CASE WHEN COUNT(*) = 12 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'ui'
  AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps')
  AND source_key IN (
    'list.filter_selected_one',
    'list.filter_selected_other'
  );

ROLLBACK;
