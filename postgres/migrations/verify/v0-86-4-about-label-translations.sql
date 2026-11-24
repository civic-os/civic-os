-- Verify civic_os:v0-86-4-about-label-translations on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- No seeded auth.about text is left: no placeholder, no unaccented fr/de seed
SELECT 1 / (CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'ui' AND source_key = 'auth.about'
  AND translated_text IN ('About {{appTitle}}', 'Acerca de {{appTitle}}', 'A propos de Civic OS', 'Ueber Civic OS');

ROLLBACK;
