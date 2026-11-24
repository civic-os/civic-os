-- Revert civic_os:v0-86-4-help-toggletip-translations from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

DELETE FROM metadata.translations
WHERE source_type = 'ui' AND source_key IN ('a11y.show_description', 'a11y.hide_description');

COMMIT;
