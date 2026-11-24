-- Deploy civic_os:v0-86-4-help-toggletip-translations to pg
-- requires: v0-86-4-drop-legacy-river-unique-index
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Accessible names of the help toggletip (issue #130), in the six core locales (en, es, fr, de, ar, ps).
-- The (?) next to a page title or field label became a button that shows or hides the entity or field
-- description in the page, replacing a hover-only tooltip that widened the page at phone width and that
-- keyboard users could not open. The English rows match src/app/i18n/en.translations.ts.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'a11y.show_description', 'en', 'Show description of {{name}}'),
('ui', 'a11y.show_description', 'es', 'Mostrar la descripción de {{name}}'),
('ui', 'a11y.show_description', 'fr', 'Afficher la description de {{name}}'),
('ui', 'a11y.show_description', 'de', 'Beschreibung von {{name}} anzeigen'),
('ui', 'a11y.show_description', 'ar', 'إظهار وصف {{name}}'),
('ui', 'a11y.show_description', 'ps', 'د {{name}} تشریح ښکاره کړئ'),

('ui', 'a11y.hide_description', 'en', 'Hide description of {{name}}'),
('ui', 'a11y.hide_description', 'es', 'Ocultar la descripción de {{name}}'),
('ui', 'a11y.hide_description', 'fr', 'Masquer la description de {{name}}'),
('ui', 'a11y.hide_description', 'de', 'Beschreibung von {{name}} ausblenden'),
('ui', 'a11y.hide_description', 'ar', 'إخفاء وصف {{name}}'),
('ui', 'a11y.hide_description', 'ps', 'د {{name}} تشریح پټ کړئ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
