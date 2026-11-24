-- Revert civic_os:v0-86-4-about-label-translations from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Restores the seeded auth.about text, only where a row still holds this change's text.

BEGIN;

UPDATE metadata.translations AS t SET translated_text = v.seeded
FROM (VALUES
    ('en', 'About {{appTitle}}',     'About Civic OS'),
    ('es', 'Acerca de {{appTitle}}', 'Acerca de Civic OS'),
    ('fr', 'A propos de Civic OS',   'À propos de Civic OS'),
    ('de', 'Ueber Civic OS',         'Über Civic OS')
) AS v(locale, seeded, fixed)
WHERE t.source_type = 'ui' AND t.source_key = 'auth.about'
  AND t.locale = v.locale AND t.translated_text = v.fixed;

COMMIT;
