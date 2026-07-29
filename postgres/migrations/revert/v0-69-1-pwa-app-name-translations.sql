-- Revert civic_os:v0-69-1-pwa-app-name-translations
-- Restore generic text (no {{appName}} interpolation).

BEGIN;

UPDATE metadata.translations
SET translated_text = 'Instala esta aplicación para una mejor experiencia'
WHERE source_type = 'ui' AND source_key = 'pwa.install_prompt' AND locale = 'es';

UPDATE metadata.translations
SET translated_text = 'Instala esta aplicación en tu dispositivo para acceso rápido y una experiencia similar a una app.'
WHERE source_type = 'ui' AND source_key = 'pwa.install_description' AND locale = 'es';

UPDATE metadata.translations
SET translated_text = 'ثبّت هذا التطبيق للحصول على تجربة أفضل'
WHERE source_type = 'ui' AND source_key = 'pwa.install_prompt' AND locale = 'ar';

UPDATE metadata.translations
SET translated_text = 'ثبّت هذا التطبيق على جهازك للوصول السريع وتجربة شبيهة بالتطبيقات.'
WHERE source_type = 'ui' AND source_key = 'pwa.install_description' AND locale = 'ar';

UPDATE metadata.translations
SET translated_text = 'Installez cette application pour une meilleure expérience'
WHERE source_type = 'ui' AND source_key = 'pwa.install_prompt' AND locale = 'fr';

UPDATE metadata.translations
SET translated_text = 'Installez cette application sur votre appareil pour un accès rapide et une expérience semblable à une application.'
WHERE source_type = 'ui' AND source_key = 'pwa.install_description' AND locale = 'fr';

UPDATE metadata.translations
SET translated_text = 'Installieren Sie diese App für ein besseres Erlebnis'
WHERE source_type = 'ui' AND source_key = 'pwa.install_prompt' AND locale = 'de';

UPDATE metadata.translations
SET translated_text = 'Installieren Sie diese Anwendung auf Ihrem Gerät für schnellen Zugriff und ein App-ähnliches Erlebnis.'
WHERE source_type = 'ui' AND source_key = 'pwa.install_description' AND locale = 'de';

UPDATE metadata.translations
SET translated_text = 'دا اپلیکیشن د غوره تجربې لپاره نصب کړئ'
WHERE source_type = 'ui' AND source_key = 'pwa.install_prompt' AND locale = 'ps';

UPDATE metadata.translations
SET translated_text = 'دا اپلیکیشن په خپل وسیله باندې نصب کړئ د ګړندي لاسرسي او د اپلیکیشن په شان تجربې لپاره.'
WHERE source_type = 'ui' AND source_key = 'pwa.install_description' AND locale = 'ps';

COMMIT;
