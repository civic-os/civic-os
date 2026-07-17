-- =====================================================
-- Referrals Per Week chart widget
-- =====================================================
-- Adds the pre-aggregated VIEW and dashboard chart widget
-- that were added to the example in v0.61.0 but not yet
-- deployed to production.
--
-- Requires: Civic OS v0.61.0+ (chart dashboard widget)

BEGIN;

-- 1. Create the chart-ready VIEW
CREATE OR REPLACE VIEW referrals_per_week AS
SELECT
  DATE_TRUNC('week', r.referral_date)::date AS week_start,
  TO_CHAR(DATE_TRUNC('week', r.referral_date), 'MM/DD') AS week_label,
  COUNT(*) AS total_referrals,
  COUNT(*) FILTER (WHERE
    ttc.category_key IN ('more_than_5_days', 'unable_to_contact')
    OR h.category_key IN ('not_helpful', 'could_not_contact')
  ) AS poor_outcome_referrals
FROM referrals r
LEFT JOIN follow_up_surveys s ON s.referral_id = r.id
LEFT JOIN metadata.categories ttc ON ttc.id = s.time_to_contact_id
  AND ttc.entity_type = 'time_to_contact'
LEFT JOIN metadata.categories h ON h.id = s.helpfulness_id
  AND h.entity_type = 'helpfulness'
GROUP BY DATE_TRUNC('week', r.referral_date)
ORDER BY week_start DESC
LIMIT 12;

GRANT SELECT ON referrals_per_week TO web_anon, authenticated;

-- Hide from sidebar — this VIEW is only consumed by the chart widget
INSERT INTO metadata.entities (table_name, display_name, show_in_sidebar)
VALUES ('referrals_per_week', 'Referrals Per Week', FALSE)
ON CONFLICT (table_name) DO UPDATE SET show_in_sidebar = FALSE;

-- 2. Add chart widget to the ECS Intake Dashboard
INSERT INTO metadata.dashboard_widgets (
  dashboard_id, widget_type, entity_key, title,
  config, sort_order, width, height
)
SELECT
  d.id,
  'chart',
  'referrals_per_week',
  'Referrals Per Week',
  jsonb_build_object(
    'labelColumn', 'week_label',
    'valueColumns', jsonb_build_array('total_referrals', 'poor_outcome_referrals'),
    'seriesLabels', jsonb_build_array('Total Referrals', 'Poor Outcome'),
    'colorMode', 'custom',
    'seriesColors', jsonb_build_array('primary', 'warning'),
    'orderBy', 'week_start',
    'orderDirection', 'asc',
    'xAxisLabel', 'Week',
    'yAxisLabel', 'Referrals'
  ),
  5, 2, 2
FROM metadata.dashboards d
WHERE d.display_name = 'ECS Intake Dashboard';

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
