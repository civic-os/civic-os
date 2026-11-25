-- Deploy civic_os:v0-87-0-filter-chip-translations to pg
-- requires: v0-87-0-file-reconcile
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Issue #169. The List page's selected-count filter chips ("3 selected") now come from
-- list.filter_selected_one / _other; the yes/no chips reuse form.yes and form.no, which every core
-- locale already has. Seeds the two new keys in the six core locales (en, es, fr, de, ar, ps).
-- Seeded with ON CONFLICT DO NOTHING, so a row an admin already added is left alone. The English rows
-- match src/app/i18n/en.translations.ts.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'list.filter_selected_one', 'en', '{{count}} selected'),
('ui', 'list.filter_selected_one', 'es', '{{count}} seleccionado'),
('ui', 'list.filter_selected_one', 'fr', '{{count}} sélectionné'),
('ui', 'list.filter_selected_one', 'de', '{{count}} ausgewählt'),
('ui', 'list.filter_selected_one', 'ar', '{{count}} محدد'),
('ui', 'list.filter_selected_one', 'ps', '{{count}} ټاکل شوی'),
('ui', 'list.filter_selected_other', 'en', '{{count}} selected'),
('ui', 'list.filter_selected_other', 'es', '{{count}} seleccionados'),
('ui', 'list.filter_selected_other', 'fr', '{{count}} sélectionnés'),
('ui', 'list.filter_selected_other', 'de', '{{count}} ausgewählt'),
('ui', 'list.filter_selected_other', 'ar', '{{count}} محددة'),
('ui', 'list.filter_selected_other', 'ps', '{{count}} ټاکل شوي')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
