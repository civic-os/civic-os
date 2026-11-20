-- Verify civic_os:v0-86-0-tree-select-translations on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

SELECT 1 / (CASE WHEN COUNT(*) = 30 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'ui' AND source_key LIKE 'tree\_select.%'
  AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps');

ROLLBACK;
