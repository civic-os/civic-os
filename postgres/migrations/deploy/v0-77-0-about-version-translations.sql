-- Deploy civic_os:v0-77-0-about-version-translations
-- Requires: v0-77-0-domain-version
--
-- v0.77.0 -- Translate the about modal's version lines.
-- AboutModalComponent's hard-coded "Version:" label now uses about.version, and the modal
-- adds about.domain_version and about.framework_version for the instance's domain version record.
-- Seeds the six core locales (en for get_translation_defaults(), plus es/ar/fr/de/ps).
-- Instance-agnostic UI strings only: no schema change, no instance content.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'about.version', 'en', 'Version:'),
('ui', 'about.version', 'es', 'Versión:'),
('ui', 'about.version', 'ar', 'الإصدار:'),
('ui', 'about.version', 'fr', 'Version :'),
('ui', 'about.version', 'de', 'Version:'),
('ui', 'about.version', 'ps', 'نسخه:'),
('ui', 'about.domain_version', 'en', 'Domain version:'),
('ui', 'about.domain_version', 'es', 'Versión del dominio:'),
('ui', 'about.domain_version', 'ar', 'إصدار النطاق:'),
('ui', 'about.domain_version', 'fr', 'Version du domaine :'),
('ui', 'about.domain_version', 'de', 'Domänenversion:'),
('ui', 'about.domain_version', 'ps', 'د ډومین نسخه:'),
('ui', 'about.framework_version', 'en', 'Framework version:'),
('ui', 'about.framework_version', 'es', 'Versión del framework:'),
('ui', 'about.framework_version', 'ar', 'إصدار الإطار:'),
('ui', 'about.framework_version', 'fr', 'Version du framework :'),
('ui', 'about.framework_version', 'de', 'Framework-Version:'),
('ui', 'about.framework_version', 'ps', 'د چوکاټ نسخه:')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
