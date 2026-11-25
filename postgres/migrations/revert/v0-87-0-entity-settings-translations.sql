-- Revert civic_os:v0-87-0-entity-settings-translations from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- Delete only the rows that still hold the seeded text, so translations an admin edited stay
DELETE FROM metadata.translations t
USING (VALUES
  ('entity_management.map_settings', 'en', 'Map Settings'),
  ('entity_management.map_settings', 'es', 'Configuración del mapa'),
  ('entity_management.map_settings', 'fr', 'Paramètres de la carte'),
  ('entity_management.map_settings', 'de', 'Karteneinstellungen'),
  ('entity_management.map_settings', 'ar', 'إعدادات الخريطة'),
  ('entity_management.map_settings', 'ps', 'د نقشې تنظیمات'),
  ('entity_management.show_map', 'en', 'Show map on list view'),
  ('entity_management.show_map', 'es', 'Mostrar mapa en la vista de lista'),
  ('entity_management.show_map', 'fr', 'Afficher la carte dans la vue liste'),
  ('entity_management.show_map', 'de', 'Karte in der Listenansicht anzeigen'),
  ('entity_management.show_map', 'ar', 'إظهار الخريطة في عرض القائمة'),
  ('entity_management.show_map', 'ps', 'د لیست په لید کې نقشه وښایه'),
  ('entity_management.calendar_settings', 'en', 'Calendar Settings'),
  ('entity_management.calendar_settings', 'es', 'Configuración del calendario'),
  ('entity_management.calendar_settings', 'fr', 'Paramètres du calendrier'),
  ('entity_management.calendar_settings', 'de', 'Kalendereinstellungen'),
  ('entity_management.calendar_settings', 'ar', 'إعدادات التقويم'),
  ('entity_management.calendar_settings', 'ps', 'د جنتري تنظیمات'),
  ('entity_management.show_calendar', 'en', 'Show calendar on list view'),
  ('entity_management.show_calendar', 'es', 'Mostrar calendario en la vista de lista'),
  ('entity_management.show_calendar', 'fr', 'Afficher le calendrier dans la vue liste'),
  ('entity_management.show_calendar', 'de', 'Kalender in der Listenansicht anzeigen'),
  ('entity_management.show_calendar', 'ar', 'إظهار التقويم في عرض القائمة'),
  ('entity_management.show_calendar', 'ps', 'د لیست په لید کې جنتري وښایه'),
  ('entity_management.recurring_settings', 'en', 'Recurring Schedules'),
  ('entity_management.recurring_settings', 'es', 'Horarios recurrentes'),
  ('entity_management.recurring_settings', 'fr', 'Horaires récurrents'),
  ('entity_management.recurring_settings', 'de', 'Wiederkehrende Termine'),
  ('entity_management.recurring_settings', 'ar', 'الجداول المتكررة'),
  ('entity_management.recurring_settings', 'ps', 'تکراري مهالویشونه'),
  ('entity_management.allow_recurring', 'en', 'Allow recurring schedules'),
  ('entity_management.allow_recurring', 'es', 'Permitir horarios recurrentes'),
  ('entity_management.allow_recurring', 'fr', 'Autoriser les horaires récurrents'),
  ('entity_management.allow_recurring', 'de', 'Wiederkehrende Termine erlauben'),
  ('entity_management.allow_recurring', 'ar', 'السماح بالجداول المتكررة'),
  ('entity_management.allow_recurring', 'ps', 'تکراري مهالویشونو ته اجازه ورکړئ'),
  ('entity_management.using', 'en', 'using'),
  ('entity_management.using', 'es', 'usando'),
  ('entity_management.using', 'fr', 'avec'),
  ('entity_management.using', 'de', 'mit'),
  ('entity_management.using', 'ar', 'باستخدام'),
  ('entity_management.using', 'ps', 'په کارولو سره'),
  ('a11y.map_property_for', 'en', 'Map property for {{entity}}'),
  ('a11y.map_property_for', 'es', 'Propiedad del mapa para {{entity}}'),
  ('a11y.map_property_for', 'fr', 'Propriété de la carte pour {{entity}}'),
  ('a11y.map_property_for', 'de', 'Karteneigenschaft für {{entity}}'),
  ('a11y.map_property_for', 'ar', 'خاصية الخريطة لـ {{entity}}'),
  ('a11y.map_property_for', 'ps', 'د {{entity}} لپاره د نقشې ځانګړنه'),
  ('a11y.calendar_property_for', 'en', 'Calendar property for {{entity}}'),
  ('a11y.calendar_property_for', 'es', 'Propiedad del calendario para {{entity}}'),
  ('a11y.calendar_property_for', 'fr', 'Propriété du calendrier pour {{entity}}'),
  ('a11y.calendar_property_for', 'de', 'Kalendereigenschaft für {{entity}}'),
  ('a11y.calendar_property_for', 'ar', 'خاصية التقويم لـ {{entity}}'),
  ('a11y.calendar_property_for', 'ps', 'د {{entity}} لپاره د جنتري ځانګړنه'),
  ('a11y.recurring_property_for', 'en', 'Recurring schedule property for {{entity}}'),
  ('a11y.recurring_property_for', 'es', 'Propiedad de horario recurrente para {{entity}}'),
  ('a11y.recurring_property_for', 'fr', 'Propriété d''horaire récurrent pour {{entity}}'),
  ('a11y.recurring_property_for', 'de', 'Eigenschaft für wiederkehrende Termine von {{entity}}'),
  ('a11y.recurring_property_for', 'ar', 'خاصية الجدول المتكرر لـ {{entity}}'),
  ('a11y.recurring_property_for', 'ps', 'د {{entity}} لپاره د تکراري مهالویش ځانګړنه')
) AS v(source_key, locale, seeded)
WHERE t.source_type = 'ui'
  AND t.source_key = v.source_key
  AND t.locale = v.locale
  AND t.translated_text = v.seeded;

COMMIT;
