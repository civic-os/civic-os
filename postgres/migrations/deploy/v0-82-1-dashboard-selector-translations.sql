-- Deploy civic_os:v0-82-1-dashboard-selector-translations
-- Requires: v0-82-0-dashboards-not-null
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- v0.82.1 -- Translate the navbar dashboard selector's menu title, loading state and fallback button
-- label (issue #121). Its "Default Dashboard" label reuses dashboard.default, seeded since v0.57.0.
-- Seeds the six core locales (en for get_translation_defaults(), plus es/fr/de/ar/ps).
-- Instance-agnostic UI strings only: no schema change, no instance content.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'dashboard.all', 'en', 'All Dashboards'),
('ui', 'dashboard.all', 'es', 'Todos los tableros'),
('ui', 'dashboard.all', 'fr', 'Tous les tableaux de bord'),
('ui', 'dashboard.all', 'de', 'Alle Dashboards'),
('ui', 'dashboard.all', 'ar', 'جميع لوحات المعلومات'),
('ui', 'dashboard.all', 'ps', 'ټول ډشبورډونه'),
('ui', 'dashboard.loading_list', 'en', 'Loading dashboards...'),
('ui', 'dashboard.loading_list', 'es', 'Cargando tableros...'),
('ui', 'dashboard.loading_list', 'fr', 'Chargement des tableaux de bord...'),
('ui', 'dashboard.loading_list', 'de', 'Dashboards werden geladen...'),
('ui', 'dashboard.loading_list', 'ar', 'جارٍ تحميل لوحات المعلومات...'),
('ui', 'dashboard.loading_list', 'ps', 'ډشبورډونه پورته کیږي...'),
('ui', 'dashboard.unnamed', 'en', 'Dashboard'),
('ui', 'dashboard.unnamed', 'es', 'Tablero'),
('ui', 'dashboard.unnamed', 'fr', 'Tableau de bord'),
('ui', 'dashboard.unnamed', 'de', 'Dashboard'),
('ui', 'dashboard.unnamed', 'ar', 'لوحة المعلومات'),
('ui', 'dashboard.unnamed', 'ps', 'ډشبورډ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
