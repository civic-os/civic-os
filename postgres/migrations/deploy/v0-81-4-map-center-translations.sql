-- Deploy civic_os:v0-81-4-map-center-translations
-- Requires: v0-81-3-translations-admin-translations
--
-- v0.81.4 -- Keyboard path for the location picker (issue #99): the "Use map center" button,
-- its spoken confirmation ("Location set to <lat>, <lng>") and the edit map's region name, which
-- says the arrow keys pan the map. Seeds the six core locales (en for get_translation_defaults(),
-- plus es/fr/de/ar/ps). Instance-agnostic UI strings only: no schema change, no instance content.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'a11y.use_map_center', 'en', 'Use map center'),
('ui', 'a11y.use_map_center', 'es', 'Usar el centro del mapa'),
('ui', 'a11y.use_map_center', 'fr', 'Utiliser le centre de la carte'),
('ui', 'a11y.use_map_center', 'de', 'Kartenmitte verwenden'),
('ui', 'a11y.use_map_center', 'ar', 'استخدام مركز الخريطة'),
('ui', 'a11y.use_map_center', 'ps', 'د نقشې مرکز وکاروئ'),
('ui', 'a11y.map_location_set', 'en', 'Location set to {{lat}}, {{lng}}'),
('ui', 'a11y.map_location_set', 'es', 'Ubicación fijada en {{lat}}, {{lng}}'),
('ui', 'a11y.map_location_set', 'fr', 'Emplacement défini sur {{lat}}, {{lng}}'),
('ui', 'a11y.map_location_set', 'de', 'Standort auf {{lat}}, {{lng}} gesetzt'),
('ui', 'a11y.map_location_set', 'ar', 'تم تحديد الموقع عند {{lat}}، {{lng}}'),
('ui', 'a11y.map_location_set', 'ps', 'موقعیت په {{lat}}، {{lng}} وټاکل شو'),
('ui', 'a11y.map_keyboard_instructions', 'en', 'Location map. Use the arrow keys to move the map, plus and minus to zoom.'),
('ui', 'a11y.map_keyboard_instructions', 'es', 'Mapa de ubicación. Use las flechas para mover el mapa y las teclas más y menos para acercar o alejar.'),
('ui', 'a11y.map_keyboard_instructions', 'fr', 'Carte de l''emplacement. Utilisez les flèches pour déplacer la carte, plus et moins pour zoomer.'),
('ui', 'a11y.map_keyboard_instructions', 'de', 'Standortkarte. Mit den Pfeiltasten verschieben Sie die Karte, mit Plus und Minus zoomen Sie.'),
('ui', 'a11y.map_keyboard_instructions', 'ar', 'خريطة الموقع. استخدم مفاتيح الأسهم لتحريك الخريطة، ومفتاحي الزائد والناقص للتكبير والتصغير.'),
('ui', 'a11y.map_keyboard_instructions', 'ps', 'د موقعیت نقشه. د نقشې د خوځولو لپاره د غشو تڼۍ، او د لوییدو او کوچنیدو لپاره جمع او منفي وکاروئ.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
