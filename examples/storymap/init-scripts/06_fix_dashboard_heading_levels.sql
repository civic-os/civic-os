-- =====================================================
-- Fix Dashboard Markdown Heading Levels (WCAG 1.3.1)
-- =====================================================
-- The dashboard page renders the dashboard's display_name as the
-- page <h1>, so markdown widget content must start its headings at
-- ## (h2) to keep a single h1 per page. This demotes every heading
-- level by one (# -> ##, ## -> ###, ...) in markdown widgets that
-- still contain an h1 heading, preserving the nesting hierarchy.
--
-- Idempotent: after one run no widget contains an h1 line, so the
-- WHERE guard matches nothing on subsequent runs.

BEGIN;

UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
      config,
      '{content}',
      to_jsonb(regexp_replace(config->>'content', '(^|\n)(#{1,5}) ', '\1#\2 ', 'g'))
    ),
    updated_at = NOW()
WHERE widget_type = 'markdown'
  AND config->>'content' ~ '(^|\n)# ';

COMMIT;
