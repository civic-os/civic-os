-- =====================================================
-- ECS Staff Dashboard — Quick Actions Nav Buttons
-- =====================================================
-- Adds a nav_buttons widget at the top of the ECS Intake
-- Dashboard with shortcuts for common staff workflows.
-- Follows FFSC pattern (staff-portal/11_staff_portal_dashboards.sql).

BEGIN;

-- Bump existing widgets down by 1 to make room at sort_order 1
UPDATE metadata.dashboard_widgets
SET sort_order = sort_order + 1
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE display_name = 'ECS Intake Dashboard');

-- Insert nav_buttons widget at position 1 (full-width)
INSERT INTO metadata.dashboard_widgets (
  dashboard_id, widget_type, title, config, sort_order, width, height
) VALUES (
  (SELECT id FROM metadata.dashboards WHERE display_name = 'ECS Intake Dashboard'),
  'nav_buttons',
  NULL,
  jsonb_build_object(
    'header', 'Quick Actions',
    'description', 'Common intake and referral workflows',
    'buttons', jsonb_build_array(
      jsonb_build_object('text', 'New Client Intake',  'url', '/create/clients',    'icon', 'person_add', 'variant', 'primary'),
      jsonb_build_object('text', 'View All Clients',   'url', '/view/clients',      'icon', 'group',      'variant', 'outline'),
      jsonb_build_object('text', 'Create Referral',    'url', '/create/referrals',   'icon', 'send',       'variant', 'primary'),
      jsonb_build_object('text', 'View Referrals',     'url', '/view/referrals',     'icon', 'assignment',  'variant', 'outline'),
      jsonb_build_object('text', 'View Partners',      'url', '/view/partners',      'icon', 'handshake',   'variant', 'outline')
    )
  ),
  1, 2, 1
);

COMMIT;
