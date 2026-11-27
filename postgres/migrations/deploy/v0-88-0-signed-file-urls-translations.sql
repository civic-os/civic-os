-- Deploy civic_os:v0-88-0-signed-file-urls-translations
-- Requires: v0-88-0-signed-file-urls
--
-- v0.88.0 -- The upload error shown while the database has no S3 signing config
-- (file_upload.storage_not_configured), in the six core locales (en for get_translation_defaults(),
-- plus es/ar/fr/de/ps). Instance-agnostic UI strings only: no schema change, no instance content.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'file_upload.storage_not_configured', 'en', 'File storage is not set up yet. Try again in a minute, or ask an administrator.'),
('ui', 'file_upload.storage_not_configured', 'es', 'El almacenamiento de archivos aún no está configurado. Inténtelo de nuevo en un minuto o consulte a un administrador.'),
('ui', 'file_upload.storage_not_configured', 'ar', 'لم يتم إعداد تخزين الملفات بعد. حاول مرة أخرى بعد دقيقة، أو اسأل المسؤول.'),
('ui', 'file_upload.storage_not_configured', 'fr', 'Le stockage des fichiers n''est pas encore configuré. Réessayez dans une minute ou contactez un administrateur.'),
('ui', 'file_upload.storage_not_configured', 'de', 'Der Dateispeicher ist noch nicht eingerichtet. Versuchen Sie es in einer Minute erneut oder wenden Sie sich an einen Administrator.'),
('ui', 'file_upload.storage_not_configured', 'ps', 'د فایلونو زیرمه لا تنظیم شوې نه ده. یوه دقیقه وروسته بیا هڅه وکړئ، یا له مدیر څخه وپوښتئ.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
