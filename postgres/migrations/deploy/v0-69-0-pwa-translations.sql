-- Deploy civic_os:v0-69-0-pwa-translations
-- Requires: v0-68-0-a11y-translations
--
-- v0.69.0 -- Translate PWA UI strings (8 keys) into the five demo locales:
-- es, ar, fr, de, ps.

BEGIN;

-- ============================================================================
-- SPANISH (es)
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'pwa.offline_message', 'es', 'Actualmente estás sin conexión. Algunas funciones pueden no estar disponibles.'),
('ui', 'pwa.install_prompt', 'es', 'Instala esta aplicación para una mejor experiencia'),
('ui', 'pwa.install_action', 'es', 'Instalar'),
('ui', 'pwa.install_app', 'es', 'Instalar aplicación'),
('ui', 'pwa.install_description', 'es', 'Instala esta aplicación en tu dispositivo para acceso rápido y una experiencia similar a una app.'),
('ui', 'pwa.update_available', 'es', 'Una nueva versión está disponible'),
('ui', 'pwa.update_reload', 'es', 'Recargar'),
('ui', 'a11y.dismiss_install', 'es', 'Descartar solicitud de instalación')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ARABIC (ar)
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'pwa.offline_message', 'ar', 'أنت غير متصل حاليًا. قد لا تتوفر بعض الميزات.'),
('ui', 'pwa.install_prompt', 'ar', 'ثبّت هذا التطبيق للحصول على تجربة أفضل'),
('ui', 'pwa.install_action', 'ar', 'تثبيت'),
('ui', 'pwa.install_app', 'ar', 'تثبيت التطبيق'),
('ui', 'pwa.install_description', 'ar', 'ثبّت هذا التطبيق على جهازك للوصول السريع وتجربة شبيهة بالتطبيقات.'),
('ui', 'pwa.update_available', 'ar', 'يتوفر إصدار جديد'),
('ui', 'pwa.update_reload', 'ar', 'إعادة تحميل'),
('ui', 'a11y.dismiss_install', 'ar', 'تجاهل طلب التثبيت')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- FRENCH (fr)
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'pwa.offline_message', 'fr', 'Vous êtes actuellement hors ligne. Certaines fonctionnalités peuvent être indisponibles.'),
('ui', 'pwa.install_prompt', 'fr', 'Installez cette application pour une meilleure expérience'),
('ui', 'pwa.install_action', 'fr', 'Installer'),
('ui', 'pwa.install_app', 'fr', 'Installer l''application'),
('ui', 'pwa.install_description', 'fr', 'Installez cette application sur votre appareil pour un accès rapide et une expérience semblable à une application.'),
('ui', 'pwa.update_available', 'fr', 'Une nouvelle version est disponible'),
('ui', 'pwa.update_reload', 'fr', 'Recharger'),
('ui', 'a11y.dismiss_install', 'fr', 'Ignorer la demande d''installation')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- GERMAN (de)
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'pwa.offline_message', 'de', 'Sie sind derzeit offline. Einige Funktionen sind möglicherweise nicht verfügbar.'),
('ui', 'pwa.install_prompt', 'de', 'Installieren Sie diese App für ein besseres Erlebnis'),
('ui', 'pwa.install_action', 'de', 'Installieren'),
('ui', 'pwa.install_app', 'de', 'App installieren'),
('ui', 'pwa.install_description', 'de', 'Installieren Sie diese Anwendung auf Ihrem Gerät für schnellen Zugriff und ein App-ähnliches Erlebnis.'),
('ui', 'pwa.update_available', 'de', 'Eine neue Version ist verfügbar'),
('ui', 'pwa.update_reload', 'de', 'Neu laden'),
('ui', 'a11y.dismiss_install', 'de', 'Installationsaufforderung schließen')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PASHTO (ps)
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'pwa.offline_message', 'ps', 'تاسو اوس مهال آفلاین یاست. ځینې ب‌ڼسټونه ممکن شتون ونلري.'),
('ui', 'pwa.install_prompt', 'ps', 'دا اپلیکیشن د غوره تجربې لپاره نصب کړئ'),
('ui', 'pwa.install_action', 'ps', 'نصب'),
('ui', 'pwa.install_app', 'ps', 'اپلیکیشن نصب کړئ'),
('ui', 'pwa.install_description', 'ps', 'دا اپلیکیشن په خپل وسیله باندې نصب کړئ د ګړندي لاسرسي او د اپلیکیشن په شان تجربې لپاره.'),
('ui', 'pwa.update_available', 'ps', 'نوې نسخه شتون لري'),
('ui', 'pwa.update_reload', 'ps', 'بیا پورته کول'),
('ui', 'a11y.dismiss_install', 'ps', 'د نصب غوښتنه رد کړئ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
