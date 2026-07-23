-- Deploy civic_os:v0-65-1-auth-route-translations
-- Requires: v0-65-0-user-profile-extensions
--
-- 1. Seed nav.redirecting UI translation for all supported locales.
--
-- NOTE: This migration previously replaced all markdown widgets on the default
-- dashboard with generic content to add a @[login-button]. That update was
-- removed because it overwrote custom instance content on every deployed
-- instance (Mott Park, FFSC, ICGF, Clients Demo). The login button is now
-- part of the baseline default widget in v0-4-0-baseline.sql instead.
--
-- LESSON: Framework migrations must NEVER replace user-editable content
-- wholesale. If a migration needs to modify widget/dashboard content, it
-- should either: (a) append/patch rather than replace, (b) guard with a
-- content-aware WHERE clause, or (c) be handled in the frontend instead.

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

COMMIT;
