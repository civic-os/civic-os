-- Revert civic_os:v0-81-4-map-center-translations
--
-- Deletes only rows still holding the text this change seeded. A row an integrator customized
-- (deploy uses ON CONFLICT DO NOTHING, so it may predate this change or have been edited since)
-- is left in place.

BEGIN;

DELETE FROM metadata.translations t
USING (VALUES
  ('a11y.use_map_center', 'en', 'Use map center'),
  ('a11y.use_map_center', 'es', 'Usar el centro del mapa'),
  ('a11y.use_map_center', 'fr', 'Utiliser le centre de la carte'),
  ('a11y.use_map_center', 'de', 'Kartenmitte verwenden'),
  ('a11y.use_map_center', 'ar', 'استخدام مركز الخريطة'),
  ('a11y.use_map_center', 'ps', 'د نقشې مرکز وکاروئ'),
  ('a11y.map_location_set', 'en', 'Location set to {{lat}}, {{lng}}'),
  ('a11y.map_location_set', 'es', 'Ubicación fijada en {{lat}}, {{lng}}'),
  ('a11y.map_location_set', 'fr', 'Emplacement défini sur {{lat}}, {{lng}}'),
  ('a11y.map_location_set', 'de', 'Standort auf {{lat}}, {{lng}} gesetzt'),
  ('a11y.map_location_set', 'ar', 'تم تحديد الموقع عند {{lat}}، {{lng}}'),
  ('a11y.map_location_set', 'ps', 'موقعیت په {{lat}}، {{lng}} وټاکل شو'),
  ('a11y.location_map', 'en', 'Location map'),
  ('a11y.location_map', 'es', 'Mapa de ubicación'),
  ('a11y.location_map', 'fr', 'Carte de l''emplacement'),
  ('a11y.location_map', 'de', 'Standortkarte'),
  ('a11y.location_map', 'ar', 'خريطة الموقع'),
  ('a11y.location_map', 'ps', 'د موقعیت نقشه'),
  ('a11y.map_keyboard_instructions', 'en', 'Use the arrow keys to move the map, plus and minus to zoom.'),
  ('a11y.map_keyboard_instructions', 'es', 'Use las flechas para mover el mapa y las teclas más y menos para acercar o alejar.'),
  ('a11y.map_keyboard_instructions', 'fr', 'Utilisez les flèches pour déplacer la carte, plus et moins pour zoomer.'),
  ('a11y.map_keyboard_instructions', 'de', 'Mit den Pfeiltasten verschieben Sie die Karte, mit Plus und Minus zoomen Sie.'),
  ('a11y.map_keyboard_instructions', 'ar', 'استخدم مفاتيح الأسهم لتحريك الخريطة، ومفتاحي الزائد والناقص للتكبير والتصغير.'),
  ('a11y.map_keyboard_instructions', 'ps', 'د نقشې د خوځولو لپاره د غشو تڼۍ، او د لوییدو او کوچنیدو لپاره جمع او منفي وکاروئ.')
) AS seeded(source_key, locale, translated_text)
WHERE t.source_type = 'ui'
  AND t.source_key = seeded.source_key
  AND t.locale = seeded.locale
  AND t.translated_text = seeded.translated_text;

COMMIT;
