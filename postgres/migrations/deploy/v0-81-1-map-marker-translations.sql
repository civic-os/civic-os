-- Deploy civic_os:v0-81-1-map-marker-translations
-- Requires: v0-81-0-menu-translations
--
-- v0.81.1 -- Name the single Leaflet map marker: "Location" on the read-only display map and
-- "Drag to set location" on the edit map (alt, and the edit marker's hover title).
-- Seeds the six core locales (en for get_translation_defaults(), plus es/fr/de/ar/ps).
-- Instance-agnostic UI strings only: no schema change, no instance content.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'a11y.map_location_marker', 'en', 'Location'),
('ui', 'a11y.map_location_marker', 'es', 'Ubicación'),
('ui', 'a11y.map_location_marker', 'fr', 'Emplacement'),
('ui', 'a11y.map_location_marker', 'de', 'Standort'),
('ui', 'a11y.map_location_marker', 'ar', 'الموقع'),
('ui', 'a11y.map_location_marker', 'ps', 'موقعیت'),
('ui', 'a11y.map_drag_marker', 'en', 'Drag to set location'),
('ui', 'a11y.map_drag_marker', 'es', 'Arrastre para fijar la ubicación'),
('ui', 'a11y.map_drag_marker', 'fr', 'Faites glisser pour définir l''emplacement'),
('ui', 'a11y.map_drag_marker', 'de', 'Ziehen, um den Standort festzulegen'),
('ui', 'a11y.map_drag_marker', 'ar', 'اسحب لتحديد الموقع'),
('ui', 'a11y.map_drag_marker', 'ps', 'د موقعیت ټاکلو لپاره کش کړئ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
