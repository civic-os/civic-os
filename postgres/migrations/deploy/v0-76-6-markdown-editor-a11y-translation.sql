-- Deploy civic_os:v0-76-6-markdown-editor-a11y-translation
-- Requires: v0-76-5-revoke-public-execute
--
-- v0.76.6 -- Accessible name for the Markdown editor surface.
-- The TipTap contenteditable cannot be named by a <label for>; EditPropertyComponent
-- passes the field's display name, and this key is the fallback when none is given.
-- Seeds the six core locales (en for get_translation_defaults(), plus es/ar/fr/de/ps).
-- Instance-agnostic UI string only: no schema change, no instance content.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'a11y.markdown_editor', 'en', 'Markdown editor'),
('ui', 'a11y.markdown_editor', 'es', 'Editor de Markdown'),
('ui', 'a11y.markdown_editor', 'ar', 'محرر Markdown'),
('ui', 'a11y.markdown_editor', 'fr', 'Éditeur Markdown'),
('ui', 'a11y.markdown_editor', 'de', 'Markdown-Editor'),
('ui', 'a11y.markdown_editor', 'ps', 'د Markdown ایډیټر')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
