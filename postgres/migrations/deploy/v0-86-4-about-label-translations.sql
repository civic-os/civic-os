-- Deploy civic_os:v0-86-4-about-label-translations to pg
-- requires: v0-86-4-help-toggletip-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- The About label names the framework (issue #105). v0-57-0-add-i18n seeded auth.about as
-- 'About {{appTitle}}' (en) and 'Acerca de {{appTitle}}' (es), but the menu item and the About modal
-- translate it with no parameters, so Spanish showed the raw placeholder. The other locales already
-- named Civic OS, and the modal reports framework versions, so every locale now says "About Civic OS";
-- fr and de get their accents. Only rows still holding the seeded text change: an administrator's own
-- wording is instance content and stays.

BEGIN;

UPDATE metadata.translations AS t SET translated_text = v.fixed
FROM (VALUES
    ('en', 'About {{appTitle}}',     'About Civic OS'),
    ('es', 'Acerca de {{appTitle}}', 'Acerca de Civic OS'),
    ('fr', 'A propos de Civic OS',   'À propos de Civic OS'),
    ('de', 'Ueber Civic OS',         'Über Civic OS')
) AS v(locale, seeded, fixed)
WHERE t.source_type = 'ui' AND t.source_key = 'auth.about'
  AND t.locale = v.locale AND t.translated_text = v.seeded;

COMMIT;
