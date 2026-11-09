-- Verify civic_os:v0-81-3-translations-admin-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM metadata.translations
      WHERE source_type = 'ui'
        AND source_key IN (
          'admin_translations.title',
          'admin_translations.intro',
          'admin_translations.translated',
          'admin_translations.missing',
          'admin_translations.coverage',
          'admin_translations.language',
          'admin_translations.source_type',
          'admin_translations.all_types',
          'admin_translations.search',
          'admin_translations.search_placeholder',
          'admin_translations.export_tooltip',
          'admin_translations.import_tooltip',
          'admin_translations.tab_translations',
          'admin_translations.empty_translations',
          'admin_translations.empty_missing',
          'admin_translations.all_complete',
          'admin_translations.count_one',
          'admin_translations.count_other',
          'admin_translations.missing_count_one',
          'admin_translations.missing_count_other',
          'admin_translations.col_type',
          'admin_translations.source_key',
          'admin_translations.english_default',
          'admin_translations.translated_text',
          'admin_translations.col_actions',
          'admin_translations.col_action',
          'admin_translations.no_default',
          'admin_translations.translation',
          'admin_translations.translation_placeholder',
          'admin_translations.delete_confirm',
          'admin_translations.delete_note',
          'admin_translations.text_required',
          'admin_translations.created',
          'admin_translations.updated',
          'admin_translations.deleted',
          'admin_translations.save_failed',
          'admin_translations.delete_failed',
          'admin_translations.import_failed',
          'admin_translations.imported_one',
          'admin_translations.imported_other',
          'admin_translations.import_title',
          'admin_translations.import_item_label',
          'admin_translations.hint_do_not_edit',
          'admin_translations.hint_reference',
          'admin_translations.hint_edit',
          'admin_translations.hint_enter',
          'admin_translations.sheet_translations',
          'admin_translations.sheet_import_data',
          'admin_translations.source_type.ui',
          'admin_translations.source_type.entity',
          'admin_translations.source_type.property',
          'admin_translations.source_type.status',
          'admin_translations.source_type.category',
          'admin_translations.source_type.action',
          'admin_translations.source_type.action_param',
          'admin_translations.source_type.guided_form_step',
          'admin_translations.source_type.static_text',
          'admin_translations.source_type.dashboard',
          'admin_translations.source_type.widget_config',
          'admin_translations.source_type.menu_node',
          'admin_translations.source_type.instance_config',
          'admin_translations.source_type.instance_config_group'
        )
        AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps')) <> 372 THEN
    RAISE EXCEPTION 'Expected 62 keys x 6 locales (372 rows)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM metadata.translations
    WHERE source_type = 'ui' AND source_key = 'admin_translations.title' AND locale = 'es'
  ) THEN
    -- Existence only: an integrator may have customized the text
    RAISE EXCEPTION 'Sentinel translation admin_translations.title/es not found';
  END IF;
END $$;
