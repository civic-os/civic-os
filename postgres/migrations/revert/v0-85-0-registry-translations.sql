-- Revert civic_os:v0-85-0-registry-translations from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

DELETE FROM metadata.translations
WHERE (source_type = 'constraint_message' AND source_key IN ('tree_parent_cycle', 'dimension_row_delete'))
   OR (source_type = 'ui' AND source_key = 'admin_translations.source_type.constraint_message');

COMMIT;
