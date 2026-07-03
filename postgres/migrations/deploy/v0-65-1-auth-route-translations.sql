-- Deploy civic_os:v0-65-1-auth-route-translations
-- Requires: v0-65-0-user-profile-extensions
--
-- 1. Seed nav.redirecting UI translation for all supported locales.
-- 2. Update default Welcome dashboard to include a login button.

BEGIN;

-- =====================================================
-- 1. Translation seeds
-- =====================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'nav.redirecting', 'en', 'Redirecting...'),
('ui', 'nav.redirecting', 'es', 'Redirigiendo...'),
('ui', 'nav.redirecting', 'ar', 'جارٍ إعادة التوجيه...'),
('ui', 'nav.redirecting', 'ps', 'لیږدول کیږي...'),
('ui', 'nav.redirecting', 'fr', 'Redirection...'),
('ui', 'nav.redirecting', 'de', 'Weiterleitung...')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- =====================================================
-- 2. Add login button to default Welcome dashboard
-- =====================================================

UPDATE metadata.dashboard_widgets
SET config = jsonb_build_object(
      'content', '# Welcome to Civic OS

Point Civic OS at your PostgreSQL database, and it instantly creates a working web application — complete with forms, tables, search, and user permissions. No front-end code to write, no forms to build. Just focus on your data.

## Getting Started

- **Browse Entities**: Use the menu to explore your database tables
- **Create Records**: Click the "Create" button on any entity list page
- **Search**: Use full-text search on list pages
- **Customize**: Admins can configure dashboards, entities, and permissions

## Next Steps

1. Explore the **Database Schema** (ERD) to understand your data model
2. Check the **Entity Management** page to customize display names
3. Review **Permissions** to configure role-based access control

---

*Sign in to get started, or create an account if you are new.*

@[login-button](Sign In)',
      'enableHtml', false
    ),
    updated_at = NOW()
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE is_default = TRUE)
  AND widget_type = 'markdown';

COMMIT;
