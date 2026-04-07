-- =====================================================
-- Summary VIEW: Issue counts by status
-- Tests summary VIEW support (no id, created_at, updated_at)
-- =====================================================

CREATE OR REPLACE VIEW public.issue_status_summary AS
SELECT
  s.display_name,
  s.color AS status_color,
  COUNT(*)::int AS issue_count,
  MIN(i.created_at)::date AS earliest_report,
  MAX(i.created_at)::date AS latest_report
FROM "Issue" i
JOIN statuses s ON s.id = i.status
GROUP BY s.display_name, s.color;

-- Register in metadata so it appears in the UI
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('issue_status_summary', 'Issue Summary', 'Issue counts grouped by status', 99)
ON CONFLICT (table_name) DO NOTHING;

-- Grant read-only access
GRANT SELECT ON public.issue_status_summary TO web_anon;
GRANT SELECT ON public.issue_status_summary TO authenticated;
