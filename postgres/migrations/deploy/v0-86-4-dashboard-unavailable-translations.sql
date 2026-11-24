-- Deploy civic_os:v0-86-4-dashboard-unavailable-translations to pg
-- requires: v0-86-4-about-label-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Strings of the dashboard page's "not available" state (issue #129) and its loading text, which was
-- hard-coded English, in the six core locales (en, es, fr, de, ar, ps). get_dashboard() returns NULL both
-- for a missing dashboard and for one the caller may not see; the page now says so neutrally, with a
-- sign-in for anonymous visitors and a link home, instead of a load failure with a Retry that cannot
-- succeed. The English rows match src/app/i18n/en.translations.ts.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'dashboard.loading', 'en', 'Loading dashboard...'),
('ui', 'dashboard.loading', 'es', 'Cargando el panel...'),
('ui', 'dashboard.loading', 'fr', 'Chargement du tableau de bord...'),
('ui', 'dashboard.loading', 'de', 'Dashboard wird geladen...'),
('ui', 'dashboard.loading', 'ar', 'جارٍ تحميل لوحة المعلومات...'),
('ui', 'dashboard.loading', 'ps', 'ډشبورډ پورته کېږي...'),

('ui', 'dashboard.unavailable.title', 'en', 'This dashboard isn''t available'),
('ui', 'dashboard.unavailable.title', 'es', 'Este panel no está disponible'),
('ui', 'dashboard.unavailable.title', 'fr', 'Ce tableau de bord n''est pas disponible'),
('ui', 'dashboard.unavailable.title', 'de', 'Dieses Dashboard ist nicht verfügbar'),
('ui', 'dashboard.unavailable.title', 'ar', 'لوحة المعلومات هذه غير متاحة'),
('ui', 'dashboard.unavailable.title', 'ps', 'دا ډشبورډ شتون نه لري'),

('ui', 'dashboard.unavailable.message', 'en', 'It may have been removed, or you may not have access to it.'),
('ui', 'dashboard.unavailable.message', 'es', 'Puede que se haya eliminado o que no tenga acceso a él.'),
('ui', 'dashboard.unavailable.message', 'fr', 'Il a peut-être été supprimé, ou vous n''y avez pas accès.'),
('ui', 'dashboard.unavailable.message', 'de', 'Es wurde möglicherweise entfernt, oder Sie haben keinen Zugriff darauf.'),
('ui', 'dashboard.unavailable.message', 'ar', 'ربما تمت إزالتها، أو ليس لديك صلاحية الوصول إليها.'),
('ui', 'dashboard.unavailable.message', 'ps', 'کېدای شي لرې شوی وي، یا تاسو ورته لاسرسی نه لرئ.'),

('ui', 'dashboard.unavailable.sign_in_message', 'en', 'It may have been removed, or you may need to sign in to see it.'),
('ui', 'dashboard.unavailable.sign_in_message', 'es', 'Puede que se haya eliminado o que necesite iniciar sesión para verlo.'),
('ui', 'dashboard.unavailable.sign_in_message', 'fr', 'Il a peut-être été supprimé, ou vous devez vous connecter pour le voir.'),
('ui', 'dashboard.unavailable.sign_in_message', 'de', 'Es wurde möglicherweise entfernt, oder Sie müssen sich anmelden, um es zu sehen.'),
('ui', 'dashboard.unavailable.sign_in_message', 'ar', 'ربما تمت إزالتها، أو قد تحتاج إلى تسجيل الدخول لرؤيتها.'),
('ui', 'dashboard.unavailable.sign_in_message', 'ps', 'کېدای شي لرې شوی وي، یا د لیدو لپاره باید ننوځئ.'),

('ui', 'dashboard.unavailable.go_home', 'en', 'Go to the home dashboard'),
('ui', 'dashboard.unavailable.go_home', 'es', 'Ir al panel de inicio'),
('ui', 'dashboard.unavailable.go_home', 'fr', 'Aller au tableau de bord d''accueil'),
('ui', 'dashboard.unavailable.go_home', 'de', 'Zum Start-Dashboard'),
('ui', 'dashboard.unavailable.go_home', 'ar', 'الانتقال إلى لوحة المعلومات الرئيسية'),
('ui', 'dashboard.unavailable.go_home', 'ps', 'کور ډشبورډ ته لاړ شئ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
