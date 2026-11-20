-- Verify civic_os:v0-85-0-registry-translations on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- both messages in the six core locales, and the source type label
SELECT 1 / (CASE WHEN COUNT(*) = 12 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'constraint_message' AND source_key IN ('tree_parent_cycle', 'dimension_row_delete')
  AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps');
SELECT 1 / (CASE WHEN COUNT(*) = 6 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'ui' AND source_key = 'admin_translations.source_type.constraint_message';

ROLLBACK;
