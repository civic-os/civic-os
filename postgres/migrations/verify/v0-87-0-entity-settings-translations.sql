-- Verify civic_os:v0-87-0-entity-settings-translations on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- Every key has a row in each of the six core locales
SELECT 1 / (CASE WHEN COUNT(*) = 60 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'ui'
  AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps')
  AND source_key IN (
    'entity_management.map_settings',
    'entity_management.show_map',
    'entity_management.calendar_settings',
    'entity_management.show_calendar',
    'entity_management.recurring_settings',
    'entity_management.allow_recurring',
    'entity_management.using',
    'a11y.map_property_for',
    'a11y.calendar_property_for',
    'a11y.recurring_property_for'
  );

ROLLBACK;
