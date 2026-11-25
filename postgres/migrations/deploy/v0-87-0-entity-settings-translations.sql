-- Deploy civic_os:v0-87-0-entity-settings-translations to pg
-- requires: v0-87-0-filter-chip-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Issue #111. The map, calendar and recurring-schedule settings on /entity-management are translated
-- (headings, toggles and the "using" connector), and each property select is named for its entity
-- (a11y.*_property_for). Seeds the keys in the six core locales (en, es, fr, de, ar, ps).
-- Seeded with ON CONFLICT DO NOTHING, so a row an admin already added is left alone. The English rows
-- match src/app/i18n/en.translations.ts.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'entity_management.map_settings', 'en', 'Map Settings'),
('ui', 'entity_management.map_settings', 'es', 'Configuración del mapa'),
('ui', 'entity_management.map_settings', 'fr', 'Paramètres de la carte'),
('ui', 'entity_management.map_settings', 'de', 'Karteneinstellungen'),
('ui', 'entity_management.map_settings', 'ar', 'إعدادات الخريطة'),
('ui', 'entity_management.map_settings', 'ps', 'د نقشې تنظیمات'),
('ui', 'entity_management.show_map', 'en', 'Show map on list view'),
('ui', 'entity_management.show_map', 'es', 'Mostrar mapa en la vista de lista'),
('ui', 'entity_management.show_map', 'fr', 'Afficher la carte dans la vue liste'),
('ui', 'entity_management.show_map', 'de', 'Karte in der Listenansicht anzeigen'),
('ui', 'entity_management.show_map', 'ar', 'إظهار الخريطة في عرض القائمة'),
('ui', 'entity_management.show_map', 'ps', 'د لیست په لید کې نقشه وښایه'),
('ui', 'entity_management.calendar_settings', 'en', 'Calendar Settings'),
('ui', 'entity_management.calendar_settings', 'es', 'Configuración del calendario'),
('ui', 'entity_management.calendar_settings', 'fr', 'Paramètres du calendrier'),
('ui', 'entity_management.calendar_settings', 'de', 'Kalendereinstellungen'),
('ui', 'entity_management.calendar_settings', 'ar', 'إعدادات التقويم'),
('ui', 'entity_management.calendar_settings', 'ps', 'د جنتري تنظیمات'),
('ui', 'entity_management.show_calendar', 'en', 'Show calendar on list view'),
('ui', 'entity_management.show_calendar', 'es', 'Mostrar calendario en la vista de lista'),
('ui', 'entity_management.show_calendar', 'fr', 'Afficher le calendrier dans la vue liste'),
('ui', 'entity_management.show_calendar', 'de', 'Kalender in der Listenansicht anzeigen'),
('ui', 'entity_management.show_calendar', 'ar', 'إظهار التقويم في عرض القائمة'),
('ui', 'entity_management.show_calendar', 'ps', 'د لیست په لید کې جنتري وښایه'),
('ui', 'entity_management.recurring_settings', 'en', 'Recurring Schedules'),
('ui', 'entity_management.recurring_settings', 'es', 'Horarios recurrentes'),
('ui', 'entity_management.recurring_settings', 'fr', 'Horaires récurrents'),
('ui', 'entity_management.recurring_settings', 'de', 'Wiederkehrende Termine'),
('ui', 'entity_management.recurring_settings', 'ar', 'الجداول المتكررة'),
('ui', 'entity_management.recurring_settings', 'ps', 'تکراري مهالویشونه'),
('ui', 'entity_management.allow_recurring', 'en', 'Allow recurring schedules'),
('ui', 'entity_management.allow_recurring', 'es', 'Permitir horarios recurrentes'),
('ui', 'entity_management.allow_recurring', 'fr', 'Autoriser les horaires récurrents'),
('ui', 'entity_management.allow_recurring', 'de', 'Wiederkehrende Termine erlauben'),
('ui', 'entity_management.allow_recurring', 'ar', 'السماح بالجداول المتكررة'),
('ui', 'entity_management.allow_recurring', 'ps', 'تکراري مهالویشونو ته اجازه ورکړئ'),
('ui', 'entity_management.using', 'en', 'using'),
('ui', 'entity_management.using', 'es', 'usando'),
('ui', 'entity_management.using', 'fr', 'avec'),
('ui', 'entity_management.using', 'de', 'mit'),
('ui', 'entity_management.using', 'ar', 'باستخدام'),
('ui', 'entity_management.using', 'ps', 'په کارولو سره'),
('ui', 'a11y.map_property_for', 'en', 'Map property for {{entity}}'),
('ui', 'a11y.map_property_for', 'es', 'Propiedad del mapa para {{entity}}'),
('ui', 'a11y.map_property_for', 'fr', 'Propriété de la carte pour {{entity}}'),
('ui', 'a11y.map_property_for', 'de', 'Karteneigenschaft für {{entity}}'),
('ui', 'a11y.map_property_for', 'ar', 'خاصية الخريطة لـ {{entity}}'),
('ui', 'a11y.map_property_for', 'ps', 'د {{entity}} لپاره د نقشې ځانګړنه'),
('ui', 'a11y.calendar_property_for', 'en', 'Calendar property for {{entity}}'),
('ui', 'a11y.calendar_property_for', 'es', 'Propiedad del calendario para {{entity}}'),
('ui', 'a11y.calendar_property_for', 'fr', 'Propriété du calendrier pour {{entity}}'),
('ui', 'a11y.calendar_property_for', 'de', 'Kalendereigenschaft für {{entity}}'),
('ui', 'a11y.calendar_property_for', 'ar', 'خاصية التقويم لـ {{entity}}'),
('ui', 'a11y.calendar_property_for', 'ps', 'د {{entity}} لپاره د جنتري ځانګړنه'),
('ui', 'a11y.recurring_property_for', 'en', 'Recurring schedule property for {{entity}}'),
('ui', 'a11y.recurring_property_for', 'es', 'Propiedad de horario recurrente para {{entity}}'),
('ui', 'a11y.recurring_property_for', 'fr', 'Propriété d''horaire récurrent pour {{entity}}'),
('ui', 'a11y.recurring_property_for', 'de', 'Eigenschaft für wiederkehrende Termine von {{entity}}'),
('ui', 'a11y.recurring_property_for', 'ar', 'خاصية الجدول المتكرر لـ {{entity}}'),
('ui', 'a11y.recurring_property_for', 'ps', 'د {{entity}} لپاره د تکراري مهالویش ځانګړنه')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
