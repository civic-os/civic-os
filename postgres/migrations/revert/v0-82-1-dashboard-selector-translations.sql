-- Revert civic_os:v0-82-1-dashboard-selector-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Deletes only rows still holding the text this change seeded. A row an integrator customized
-- (deploy uses ON CONFLICT DO NOTHING, so it may predate this change or have been edited since)
-- is left in place.

BEGIN;

DELETE FROM metadata.translations t
USING (VALUES
  ('dashboard.all', 'en', 'All Dashboards'),
  ('dashboard.all', 'es', 'Todos los tableros'),
  ('dashboard.all', 'fr', 'Tous les tableaux de bord'),
  ('dashboard.all', 'de', 'Alle Dashboards'),
  ('dashboard.all', 'ar', 'جميع لوحات المعلومات'),
  ('dashboard.all', 'ps', 'ټول ډشبورډونه'),
  ('dashboard.loading_list', 'en', 'Loading dashboards...'),
  ('dashboard.loading_list', 'es', 'Cargando tableros...'),
  ('dashboard.loading_list', 'fr', 'Chargement des tableaux de bord...'),
  ('dashboard.loading_list', 'de', 'Dashboards werden geladen...'),
  ('dashboard.loading_list', 'ar', 'جارٍ تحميل لوحات المعلومات...'),
  ('dashboard.loading_list', 'ps', 'ډشبورډونه پورته کیږي...'),
  ('dashboard.unnamed', 'en', 'Dashboard'),
  ('dashboard.unnamed', 'es', 'Tablero'),
  ('dashboard.unnamed', 'fr', 'Tableau de bord'),
  ('dashboard.unnamed', 'de', 'Dashboard'),
  ('dashboard.unnamed', 'ar', 'لوحة المعلومات'),
  ('dashboard.unnamed', 'ps', 'ډشبورډ')
) AS seeded(source_key, locale, translated_text)
WHERE t.source_type = 'ui'
  AND t.source_key = seeded.source_key
  AND t.locale = seeded.locale
  AND t.translated_text = seeded.translated_text;

COMMIT;
