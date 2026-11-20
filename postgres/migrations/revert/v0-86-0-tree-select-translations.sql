-- Revert civic_os:v0-86-0-tree-select-translations from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key IN ('tree_select.options', 'tree_select.none', 'tree_select.inactive',
                     'tree_select.no_matches', 'tree_select.match_count');

COMMIT;
