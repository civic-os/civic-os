-- Revert civic_os:v0-65-1-auth-route-translations from pg

BEGIN;

-- Revert translations
DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key = 'nav.redirecting';

-- Revert default Welcome dashboard to original content (without login button)
UPDATE metadata.dashboard_widgets
SET config = jsonb_build_object(
      'content', E'# Welcome to Civic OS\n\nPoint Civic OS at your PostgreSQL database, and it instantly creates a working web application — complete with forms, tables, search, and user permissions. No front-end code to write, no forms to build. Just focus on your data.\n\n## Getting Started\n\n- **Browse Entities**: Use the menu to explore your database tables\n- **Create Records**: Click the "Create" button on any entity list page\n- **Search**: Use full-text search on list pages\n- **Customize**: Admins can configure dashboards, entities, and permissions\n\n## Next Steps\n\n1. Explore the **Database Schema** (ERD) to understand your data model\n2. Check the **Entity Management** page to customize display names\n3. Review **Permissions** to configure role-based access control\n\n---\n\n*This dashboard is customizable! Admins can edit widgets and create new dashboards in Phase 3.*',
      'enableHtml', false
    ),
    updated_at = NOW()
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE is_default = TRUE)
  AND widget_type = 'markdown';

COMMIT;
