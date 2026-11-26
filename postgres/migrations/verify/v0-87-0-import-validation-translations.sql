-- Verify civic_os:v0-87-0-import-validation-translations on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- Every key has a row in each of the six core locales
SELECT 1 / (CASE WHEN COUNT(*) = 318 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key IN (
    'import_modal.error_file_too_large_size',
    'import_validation.err_fk_lookup_unavailable_for',
    'import_validation.err_fk_lookup_unavailable',
    'import_validation.err_fk_not_found',
    'import_validation.err_fk_ambiguous',
    'import_validation.err_required',
    'import_validation.err_timeslot_incomplete',
    'import_validation.err_timeslot_generic',
    'import_validation.err_validation_generic',
    'import_validation.err_min_length',
    'import_validation.err_max_length',
    'import_validation.err_invalid_format',
    'import_validation.err_number',
    'import_validation.err_min_value',
    'import_validation.err_max_value',
    'import_validation.err_money',
    'import_validation.err_boolean',
    'import_validation.err_datetime',
    'import_validation.err_datetime_start',
    'import_validation.err_datetime_end',
    'import_validation.err_timeslot_range',
    'import_validation.err_geopoint_format',
    'import_validation.err_geopoint_numbers',
    'import_validation.err_geopoint_range',
    'import_validation.err_geopolygon_points',
    'import_validation.err_geopolygon_coords',
    'import_validation.err_geopolygon_geojson_type',
    'import_validation.err_geopolygon_pairs',
    'import_validation.err_geopolygon_invalid_geojson',
    'import_validation.err_geopolygon_format',
    'import_validation.err_color',
    'import_validation.err_email',
    'import_validation.err_phone',
    'import_validation.type_system',
    'import_validation.type_fk_not_found',
    'import_validation.type_fk_duplicate',
    'import_validation.type_required',
    'import_validation.type_timeslot_incomplete',
    'import_validation.type_timeslot_error',
    'import_validation.type_validation_error',
    'import_validation.type_text_length',
    'import_validation.type_pattern',
    'import_validation.type_number',
    'import_validation.type_number_range',
    'import_validation.type_money',
    'import_validation.type_boolean',
    'import_validation.type_datetime',
    'import_validation.type_timeslot_range',
    'import_validation.type_geopoint',
    'import_validation.type_geopolygon',
    'import_validation.type_color',
    'import_validation.type_email',
    'import_validation.type_phone'
  )
  AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps');

ROLLBACK;
