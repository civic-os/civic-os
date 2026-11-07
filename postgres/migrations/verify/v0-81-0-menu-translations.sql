-- Verify civic_os:v0-81-0-menu-translations

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM metadata.translations
      WHERE source_type = 'ui'
        AND source_key IN (
          'nav.menu_load_failed',
          'nav.menu_retry',
          'a11y.expand_menu_section',
          'a11y.collapse_menu_section',
          'entity_management.order_help',
          'entity_management.arrange_menu',
          'sidebar.menu',
          'admin_menu.title',
          'admin_menu.intro',
          'admin_menu.access_denied',
          'admin_menu.load_error',
          'admin_menu.layout',
          'admin_menu.empty',
          'admin_menu.heading_badge',
          'admin_menu.label',
          'admin_menu.heading_label',
          'admin_menu.icon',
          'admin_menu.icon_placeholder',
          'admin_menu.hidden',
          'admin_menu.collapsed',
          'admin_menu.table',
          'admin_menu.view',
          'admin_menu.unplaced',
          'admin_menu.unplaced_help',
          'admin_menu.unplaced_empty',
          'admin_menu.add_to_menu',
          'admin_menu.add_heading',
          'admin_menu.add',
          'admin_menu.preview',
          'admin_menu.save',
          'admin_menu.saving',
          'admin_menu.discard',
          'admin_menu.saved',
          'admin_menu.unsaved',
          'admin_menu.error.duplicate-key',
          'admin_menu.error.heading-key',
          'admin_menu.error.heading-label',
          'admin_menu.error.heading-target',
          'admin_menu.error.entity-key',
          'admin_menu.error.unknown-parent',
          'admin_menu.error.parent-kind',
          'admin_menu.error.cycle',
          'admin_menu.error.depth',
          'admin_menu.error.duplicate-entity',
          'admin_menu.error.unknown-target',
          'a11y.admin_menu.indent',
          'a11y.admin_menu.outdent',
          'a11y.admin_menu.remove',
          'a11y.admin_menu.hide',
          'a11y.admin_menu.show',
          'admin_menu.not_shown',
          'admin_menu.not_shown_help',
          'a11y.admin_menu.moved_into',
          'a11y.admin_menu.moved_root',
          'a11y.admin_menu.removed',
          'a11y.admin_menu.added'
        )
        AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps')) <> 336 THEN
    RAISE EXCEPTION 'Expected 56 keys x 6 locales (336 rows)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM metadata.translations
    WHERE source_type = 'ui' AND source_key = 'sidebar.menu' AND locale = 'es'
  ) THEN
    -- Existence only: an integrator may have customized the text
    RAISE EXCEPTION 'Sentinel translation sidebar.menu/es not found';
  END IF;
END $$;
