-- Deploy civic_os:v0-69-1-pwa-app-name-translations
-- Requires: v0-69-0-pwa-translations
--
-- v0.69.2 -- Update pwa.install_prompt and pwa.install_description translations
-- to use {{appName}} interpolation instead of generic text.

BEGIN;

-- ============================================================================
-- SPANISH (es)
-- ============================================================================

UPDATE metadata.translations
SET translated_text = 'Instala la aplicación {{appName}} para una mejor experiencia'
WHERE source_type = 'ui' AND source_key = 'pwa.install_prompt' AND locale = 'es';

UPDATE metadata.translations
SET translated_text = 'Instala {{appName}} en tu dispositivo para acceso rápido y una experiencia similar a una app.'
WHERE source_type = 'ui' AND source_key = 'pwa.install_description' AND locale = 'es';

-- ============================================================================
-- ARABIC (ar)
-- ============================================================================

UPDATE metadata.translations
SET translated_text = 'ثبّت تطبيق {{appName}} للحصول على تجربة أفضل'
WHERE source_type = 'ui' AND source_key = 'pwa.install_prompt' AND locale = 'ar';

UPDATE metadata.translations
SET translated_text = 'ثبّت {{appName}} على جهازك للوصول السريع وتجربة شبيهة بالتطبيقات.'
WHERE source_type = 'ui' AND source_key = 'pwa.install_description' AND locale = 'ar';

-- ============================================================================
-- FRENCH (fr)
-- ============================================================================

UPDATE metadata.translations
SET translated_text = 'Installez l''application {{appName}} pour une meilleure expérience'
WHERE source_type = 'ui' AND source_key = 'pwa.install_prompt' AND locale = 'fr';

UPDATE metadata.translations
SET translated_text = 'Installez {{appName}} sur votre appareil pour un accès rapide et une expérience semblable à une application.'
WHERE source_type = 'ui' AND source_key = 'pwa.install_description' AND locale = 'fr';

-- ============================================================================
-- GERMAN (de)
-- ============================================================================

UPDATE metadata.translations
SET translated_text = 'Installieren Sie die {{appName}}-App für ein besseres Erlebnis'
WHERE source_type = 'ui' AND source_key = 'pwa.install_prompt' AND locale = 'de';

UPDATE metadata.translations
SET translated_text = 'Installieren Sie {{appName}} auf Ihrem Gerät für schnellen Zugriff und ein App-ähnliches Erlebnis.'
WHERE source_type = 'ui' AND source_key = 'pwa.install_description' AND locale = 'de';

-- ============================================================================
-- PASHTO (ps)
-- ============================================================================

UPDATE metadata.translations
SET translated_text = 'د غوره تجربې لپاره د {{appName}} اپلیکیشن نصب کړئ'
WHERE source_type = 'ui' AND source_key = 'pwa.install_prompt' AND locale = 'ps';

UPDATE metadata.translations
SET translated_text = '{{appName}} په خپل وسیله باندې نصب کړئ د ګړندي لاسرسي او د اپلیکیشن په شان تجربې لپاره.'
WHERE source_type = 'ui' AND source_key = 'pwa.install_description' AND locale = 'ps';

COMMIT;
