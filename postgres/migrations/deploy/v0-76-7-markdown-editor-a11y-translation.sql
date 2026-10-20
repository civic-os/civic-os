-- Deploy civic_os:v0-76-7-markdown-editor-a11y-translation
-- Requires: v0-76-5-revoke-public-execute
--
-- v0.76.7 -- UI strings for the Phase 0 app fixes, seeded for the six core locales
-- (en for get_translation_defaults(), plus es/ar/fr/de/ps):
-- - a11y.markdown_editor: accessible name of the Markdown editor surface. The TipTap
--   contenteditable cannot be named by a <label for>; EditPropertyComponent passes
--   the field's display name, and this key is the fallback when none is given.
-- - error.series_split_failed: shown by the edit page when a "this and following"
--   split fails (the occurrence is then not saved either).
-- Instance-agnostic UI string only: no schema change, no instance content.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'a11y.markdown_editor', 'en', 'Markdown editor'),
('ui', 'a11y.markdown_editor', 'es', 'Editor de Markdown'),
('ui', 'a11y.markdown_editor', 'ar', 'محرر Markdown'),
('ui', 'a11y.markdown_editor', 'fr', 'Éditeur Markdown'),
('ui', 'a11y.markdown_editor', 'de', 'Markdown-Editor'),
('ui', 'a11y.markdown_editor', 'ps', 'د Markdown ایډیټر'),
('ui', 'error.series_split_failed', 'en', 'Could not apply the change to this and following occurrences. Nothing was saved.'),
('ui', 'error.series_split_failed', 'es', 'No se pudo aplicar el cambio a esta y a las siguientes ocurrencias. No se guardó nada.'),
('ui', 'error.series_split_failed', 'ar', 'تعذر تطبيق التغيير على هذا الموعد والمواعيد التالية. لم يتم حفظ أي شيء.'),
('ui', 'error.series_split_failed', 'fr', 'Impossible d''appliquer la modification à cette occurrence et aux suivantes. Rien n''a été enregistré.'),
('ui', 'error.series_split_failed', 'de', 'Die Änderung konnte nicht auf diesen und die folgenden Termine angewendet werden. Es wurde nichts gespeichert.'),
('ui', 'error.series_split_failed', 'ps', 'بدلون په دې او راتلونکو پېښو نه شو پلي کېدای. هېڅ شی خوندي نه شو.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
