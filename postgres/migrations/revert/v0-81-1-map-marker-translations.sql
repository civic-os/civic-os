-- Revert civic_os:v0-81-1-map-marker-translations
--
-- Deletes only rows still holding the text this change seeded. A row an integrator customized
-- (deploy uses ON CONFLICT DO NOTHING, so it may predate this change or have been edited since)
-- is left in place.

BEGIN;

DELETE FROM metadata.translations t
USING (VALUES
  ('a11y.map_location_marker', 'en', 'Location'),
  ('a11y.map_location_marker', 'es', 'Ubicación'),
  ('a11y.map_location_marker', 'fr', 'Emplacement'),
  ('a11y.map_location_marker', 'de', 'Standort'),
  ('a11y.map_location_marker', 'ar', 'الموقع'),
  ('a11y.map_location_marker', 'ps', 'موقعیت'),
  ('a11y.map_drag_marker', 'en', 'Drag to set location'),
  ('a11y.map_drag_marker', 'es', 'Arrastre para fijar la ubicación'),
  ('a11y.map_drag_marker', 'fr', 'Faites glisser pour définir l''emplacement'),
  ('a11y.map_drag_marker', 'de', 'Ziehen, um den Standort festzulegen'),
  ('a11y.map_drag_marker', 'ar', 'اسحب لتحديد الموقع'),
  ('a11y.map_drag_marker', 'ps', 'د موقعیت ټاکلو لپاره کش کړئ')
) AS seeded(source_key, locale, translated_text)
WHERE t.source_type = 'ui'
  AND t.source_key = seeded.source_key
  AND t.locale = seeded.locale
  AND t.translated_text = seeded.translated_text;

COMMIT;
