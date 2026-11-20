-- Deploy civic_os:v0-86-0-tree-select-translations to pg
-- requires: v0-86-0-dimension-cache-version
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- UI strings of the tree select used by the Dimension property type (v0.86.0), in the six core locales
-- (en, es, fr, de, ar, ps). The English rows match src/app/i18n/en.translations.ts.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'tree_select.options', 'en', 'Options'),
('ui', 'tree_select.options', 'es', 'Opciones'),
('ui', 'tree_select.options', 'fr', 'Options'),
('ui', 'tree_select.options', 'de', 'Optionen'),
('ui', 'tree_select.options', 'ar', 'الخيارات'),
('ui', 'tree_select.options', 'ps', 'انتخابونه'),

('ui', 'tree_select.none', 'en', 'None'),
('ui', 'tree_select.none', 'es', 'Ninguno'),
('ui', 'tree_select.none', 'fr', 'Aucun'),
('ui', 'tree_select.none', 'de', 'Keine Auswahl'),
('ui', 'tree_select.none', 'ar', 'لا شيء'),
('ui', 'tree_select.none', 'ps', 'هېڅ'),

('ui', 'tree_select.inactive', 'en', 'Inactive'),
('ui', 'tree_select.inactive', 'es', 'Inactivo'),
('ui', 'tree_select.inactive', 'fr', 'Inactif'),
('ui', 'tree_select.inactive', 'de', 'Inaktiv'),
('ui', 'tree_select.inactive', 'ar', 'غير نشط'),
('ui', 'tree_select.inactive', 'ps', 'غیر فعال'),

('ui', 'tree_select.no_matches', 'en', 'No matches'),
('ui', 'tree_select.no_matches', 'es', 'Sin coincidencias'),
('ui', 'tree_select.no_matches', 'fr', 'Aucun résultat'),
('ui', 'tree_select.no_matches', 'de', 'Keine Treffer'),
('ui', 'tree_select.no_matches', 'ar', 'لا توجد نتائج'),
('ui', 'tree_select.no_matches', 'ps', 'هېڅ پایله ونه موندل شوه'),

('ui', 'tree_select.match_count', 'en', 'Matching options: {{count}}'),
('ui', 'tree_select.match_count', 'es', 'Opciones que coinciden: {{count}}'),
('ui', 'tree_select.match_count', 'fr', 'Options correspondantes : {{count}}'),
('ui', 'tree_select.match_count', 'de', 'Passende Optionen: {{count}}'),
('ui', 'tree_select.match_count', 'ar', 'الخيارات المطابقة: {{count}}'),
('ui', 'tree_select.match_count', 'ps', 'برابر انتخابونه: {{count}}')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
