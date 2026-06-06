-- =====================================================
-- Client Intake & Referral - Report Views (Virtual Entities)
-- =====================================================
-- 5 PostgreSQL views registered as Virtual Entities (v0.28.0+)
-- for browsable list pages with filtering and Excel export.

BEGIN;

-- ============================================================================
-- 1. Monthly Referral Summary
-- ============================================================================

CREATE OR REPLACE VIEW monthly_referral_summary AS
SELECT
  to_char(r.referral_date, 'YYYY-MM') AS month,
  COUNT(*) AS total_referrals,
  COUNT(*) FILTER (WHERE rc.category_key = 'warm') AS warm_referrals,
  COUNT(*) FILTER (WHERE rc.category_key = 'info') AS info_referrals,
  COUNT(*) FILTER (WHERE rs.status_key = 'completed') AS completed,
  COUNT(*) FILTER (WHERE rs.status_key = 'not_completed') AS not_completed,
  COUNT(*) FILTER (WHERE rs.status_key = 'referred') AS open_referrals,
  CASE
    WHEN COUNT(*) FILTER (WHERE rs.is_terminal) > 0
    THEN ROUND(
      100.0 * COUNT(*) FILTER (WHERE rs.status_key = 'completed')
      / COUNT(*) FILTER (WHERE rs.is_terminal), 1
    )
    ELSE 0
  END AS completion_rate_pct
FROM referrals r
LEFT JOIN metadata.categories rc ON r.referral_type_id = rc.id
LEFT JOIN metadata.statuses rs ON r.status_id = rs.id
GROUP BY to_char(r.referral_date, 'YYYY-MM')
ORDER BY month DESC;

GRANT SELECT ON monthly_referral_summary TO authenticated;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_in_sidebar)
VALUES ('monthly_referral_summary', 'Monthly Referral Summary', 'Referral volume, types, and completion rates by month', 10, FALSE)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_in_sidebar = EXCLUDED.show_in_sidebar;

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES
  ('monthly_referral_summary', 'month', 'Month', 1, TRUE, FALSE, FALSE),
  ('monthly_referral_summary', 'total_referrals', 'Total', 2, TRUE, FALSE, FALSE),
  ('monthly_referral_summary', 'warm_referrals', 'Warm', 3, TRUE, FALSE, FALSE),
  ('monthly_referral_summary', 'info_referrals', 'Info', 4, TRUE, FALSE, FALSE),
  ('monthly_referral_summary', 'completed', 'Completed', 5, TRUE, FALSE, FALSE),
  ('monthly_referral_summary', 'not_completed', 'Not Completed', 6, TRUE, FALSE, FALSE),
  ('monthly_referral_summary', 'open_referrals', 'Open', 7, TRUE, FALSE, FALSE),
  ('monthly_referral_summary', 'completion_rate_pct', 'Completion %', 8, TRUE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit;


-- ============================================================================
-- 2. Client Contact Summary
-- ============================================================================

CREATE OR REPLACE VIEW client_contact_summary AS
SELECT
  to_char(c.created_at, 'YYYY-MM') AS month,
  COUNT(*) AS new_clients,
  COUNT(*) FILTER (WHERE cs.status_key = 'intake_pending') AS intake_pending,
  COUNT(*) FILTER (WHERE cs.status_key = 'active') AS active_clients,
  c.country_of_origin,
  c.primary_language
FROM clients c
LEFT JOIN metadata.statuses cs ON c.status_id = cs.id
GROUP BY to_char(c.created_at, 'YYYY-MM'), c.country_of_origin, c.primary_language
ORDER BY month DESC, new_clients DESC;

GRANT SELECT ON client_contact_summary TO authenticated;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_in_sidebar)
VALUES ('client_contact_summary', 'Client Contact Summary', 'New client registrations by month, country, and language', 11, FALSE)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_in_sidebar = EXCLUDED.show_in_sidebar;

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES
  ('client_contact_summary', 'month', 'Month', 1, TRUE, FALSE, FALSE),
  ('client_contact_summary', 'new_clients', 'New Clients', 2, TRUE, FALSE, FALSE),
  ('client_contact_summary', 'intake_pending', 'Intake Pending', 3, TRUE, FALSE, FALSE),
  ('client_contact_summary', 'active_clients', 'Active', 4, TRUE, FALSE, FALSE),
  ('client_contact_summary', 'country_of_origin', 'Country of Origin', 5, TRUE, FALSE, FALSE),
  ('client_contact_summary', 'primary_language', 'Primary Language', 6, TRUE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit;


-- ============================================================================
-- 3. Top Needs Report
-- ============================================================================

CREATE OR REPLACE VIEW top_needs_report AS
SELECT
  sc.display_name AS service_category,
  sc.color,
  COUNT(DISTINCT csn.client_id) AS client_count,
  ROUND(
    100.0 * COUNT(DISTINCT csn.client_id)
    / GREATEST((SELECT COUNT(*) FROM clients WHERE status_id IN (
        SELECT id FROM metadata.statuses WHERE entity_type = 'client' AND status_key = 'active'
      )), 1),
    1
  ) AS pct_of_active_clients
FROM service_categories sc
LEFT JOIN client_service_needs csn ON sc.id = csn.service_category_id
LEFT JOIN clients c ON csn.client_id = c.id
  AND c.status_id IN (SELECT id FROM metadata.statuses WHERE entity_type = 'client' AND status_key = 'active')
WHERE sc.active = TRUE
GROUP BY sc.id, sc.display_name, sc.color
ORDER BY client_count DESC;

GRANT SELECT ON top_needs_report TO authenticated;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_in_sidebar)
VALUES ('top_needs_report', 'Top Needs Report', 'Service category demand across active client population', 12, FALSE)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_in_sidebar = EXCLUDED.show_in_sidebar;

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES
  ('top_needs_report', 'service_category', 'Service Category', 1, TRUE, FALSE, FALSE),
  ('top_needs_report', 'color', 'Color', 2, TRUE, FALSE, FALSE),
  ('top_needs_report', 'client_count', 'Client Count', 3, TRUE, FALSE, FALSE),
  ('top_needs_report', 'pct_of_active_clients', '% of Active Clients', 4, TRUE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit;


-- ============================================================================
-- 4. Partner Utilization Report
-- ============================================================================

CREATE OR REPLACE VIEW partner_utilization_report AS
SELECT
  p.display_name AS partner_name,
  p.active AS partner_active,
  COUNT(r.id) AS referral_count,
  COUNT(r.id) FILTER (WHERE rs.status_key = 'completed') AS completed,
  CASE
    WHEN COUNT(r.id) FILTER (WHERE rs.is_terminal) > 0
    THEN ROUND(
      100.0 * COUNT(r.id) FILTER (WHERE rs.status_key = 'completed')
      / COUNT(r.id) FILTER (WHERE rs.is_terminal), 1
    )
    ELSE 0
  END AS completion_rate_pct,
  string_agg(DISTINCT sc.display_name, ', ' ORDER BY sc.display_name) AS service_categories
FROM partners p
LEFT JOIN referrals r ON p.id = r.partner_id
LEFT JOIN metadata.statuses rs ON r.status_id = rs.id
LEFT JOIN referral_service_categories rsc ON r.id = rsc.referral_id
LEFT JOIN service_categories sc ON rsc.service_category_id = sc.id
GROUP BY p.id, p.display_name, p.active
ORDER BY referral_count DESC;

GRANT SELECT ON partner_utilization_report TO authenticated;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_in_sidebar)
VALUES ('partner_utilization_report', 'Partner Utilization', 'Referral volume and completion rates by partner', 13, FALSE)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_in_sidebar = EXCLUDED.show_in_sidebar;

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES
  ('partner_utilization_report', 'partner_name', 'Partner', 1, TRUE, FALSE, FALSE),
  ('partner_utilization_report', 'partner_active', 'Active', 2, TRUE, FALSE, FALSE),
  ('partner_utilization_report', 'referral_count', 'Referrals', 3, TRUE, FALSE, FALSE),
  ('partner_utilization_report', 'completed', 'Completed', 4, TRUE, FALSE, FALSE),
  ('partner_utilization_report', 'completion_rate_pct', 'Completion %', 5, TRUE, FALSE, FALSE),
  ('partner_utilization_report', 'service_categories', 'Services', 6, TRUE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit;


-- ============================================================================
-- 5. Time Lag Report
-- ============================================================================

CREATE OR REPLACE VIEW time_lag_report AS
SELECT
  rc.display_name AS referral_type,
  p.display_name AS partner_name,
  tc.display_name AS time_to_contact,
  COUNT(*) AS response_count
FROM follow_up_surveys s
JOIN referrals r ON s.referral_id = r.id
LEFT JOIN metadata.categories rc ON r.referral_type_id = rc.id
LEFT JOIN partners p ON r.partner_id = p.id
LEFT JOIN metadata.categories tc ON s.time_to_contact_id = tc.id
WHERE s.status_id IN (SELECT id FROM metadata.statuses WHERE entity_type = 'survey' AND status_key = 'completed')
  AND s.time_to_contact_id IS NOT NULL
GROUP BY rc.display_name, p.display_name, tc.display_name
ORDER BY referral_type, partner_name, response_count DESC;

GRANT SELECT ON time_lag_report TO authenticated;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_in_sidebar)
VALUES ('time_lag_report', 'Time Lag Report', 'Time-to-contact breakdown by referral type and partner', 14, FALSE)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_in_sidebar = EXCLUDED.show_in_sidebar;

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES
  ('time_lag_report', 'referral_type', 'Referral Type', 1, TRUE, FALSE, FALSE),
  ('time_lag_report', 'partner_name', 'Partner', 2, TRUE, FALSE, FALSE),
  ('time_lag_report', 'time_to_contact', 'Time to Contact', 3, TRUE, FALSE, FALSE),
  ('time_lag_report', 'response_count', 'Responses', 4, TRUE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit;


-- ============================================================================
-- 6. Referrals Per Week (Chart-ready VIEW for dashboard widget)
-- ============================================================================
-- Pre-aggregated weekly data for the chart widget. No id column — consumed
-- via isSummaryView: true in the frontend DataService.

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


-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
