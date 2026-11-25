-- Revert civic_os:v0-87-0-filter-chip-translations from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- Delete only the rows that still hold the seeded text, so translations an admin edited stay
DELETE FROM metadata.translations t
USING (VALUES
  ('list.filter_selected_one', 'en', '{{count}} selected'),
  ('list.filter_selected_one', 'es', '{{count}} seleccionado'),
  ('list.filter_selected_one', 'fr', '{{count}} sélectionné'),
  ('list.filter_selected_one', 'de', '{{count}} ausgewählt'),
  ('list.filter_selected_one', 'ar', '{{count}} محدد'),
  ('list.filter_selected_one', 'ps', '{{count}} ټاکل شوی'),
  ('list.filter_selected_other', 'en', '{{count}} selected'),
  ('list.filter_selected_other', 'es', '{{count}} seleccionados'),
  ('list.filter_selected_other', 'fr', '{{count}} sélectionnés'),
  ('list.filter_selected_other', 'de', '{{count}} ausgewählt'),
  ('list.filter_selected_other', 'ar', '{{count}} محددة'),
  ('list.filter_selected_other', 'ps', '{{count}} ټاکل شوي')
) AS v(source_key, locale, seeded)
WHERE t.source_type = 'ui'
  AND t.source_key = v.source_key
  AND t.locale = v.locale
  AND t.translated_text = v.seeded;

COMMIT;
