-- =====================================================
-- Exemplary Community Services (demo instance)
-- 27: Consent Dashboard Widget
-- =====================================================
-- Adds a "Consents Expiring" filtered-list widget to the
-- ECS Intake Dashboard alongside Intake Pending, Open
-- Referrals, and Pending Surveys.
--
-- Source: consents_expiring_soon VIEW (created in 26).
-- The VIEW already filters to active consents within 30
-- days; the widget just lists them sorted by urgency.
--
-- Requires: 26_consent_subsystem.sql applied first.
-- =====================================================

BEGIN;

-- Add widget to the ECS Intake Dashboard
INSERT INTO metadata.dashboard_widgets (
  dashboard_id, widget_type, entity_key, title,
  config, sort_order, width, height
)
SELECT
  d.id,
  'filtered_list',
  'consents_expiring_soon',
  'Consents Expiring',
  jsonb_build_object(
    'orderBy', 'expires_date',
    'orderDirection', 'asc',
    'limit', 10,
    'showColumns', jsonb_build_array('client_name', 'expires_date', 'days_remaining')
  ),
  5, 1, 1
FROM metadata.dashboards d
WHERE d.display_name = 'ECS Intake Dashboard';

COMMIT;
