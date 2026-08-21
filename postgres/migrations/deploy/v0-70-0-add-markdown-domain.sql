-- Deploy civic_os:v0-70-0-add-markdown-domain to pg
-- requires: v0-69-1-pwa-app-name-translations

BEGIN;

-- ============================================================================
-- MARKDOWN DOMAIN FOR RICH TEXT CONTENT
-- ============================================================================
-- Version: v0.70.0
-- Purpose: Add core markdown domain for rich-text content columns
-- Context: This is a CORE Civic OS domain available to all applications.
--          Any application can use this for blog posts, newsletters,
--          announcements, knowledge base articles, etc.
-- Frontend: Columns typed as `markdown` render as sanitized HTML on display
--           and present a WYSIWYG editor (TipTap) on create/edit forms.
-- ============================================================================

CREATE DOMAIN markdown AS TEXT;

COMMENT ON DOMAIN markdown IS
  'Markdown-formatted text content. Rendered as sanitized HTML on display, edited via WYSIWYG on forms. Supports CommonMark: headings, bold, italic, lists, links, code blocks, tables, images.';

-- ============================================================================
-- MARKDOWN EDITOR a11y.* TRANSLATIONS (5 demo locales)
-- ============================================================================
-- The markdown editor toolbar uses 12 translated aria-label keys.
-- English defaults live in en.translations.ts; these seed the DB for
-- non-English demo locales.

-- SPANISH (es)
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'a11y.markdown_toolbar', 'es', 'Barra de herramientas de formato Markdown'),
('ui', 'a11y.bold', 'es', 'Negrita'),
('ui', 'a11y.italic', 'es', 'Cursiva'),
('ui', 'a11y.strikethrough', 'es', 'Tachado'),
('ui', 'a11y.heading_1', 'es', 'Encabezado 1'),
('ui', 'a11y.heading_2', 'es', 'Encabezado 2'),
('ui', 'a11y.heading_3', 'es', 'Encabezado 3'),
('ui', 'a11y.bullet_list', 'es', 'Lista con viñetas'),
('ui', 'a11y.ordered_list', 'es', 'Lista numerada'),
('ui', 'a11y.blockquote', 'es', 'Cita'),
('ui', 'a11y.code', 'es', 'Bloque de código'),
('ui', 'a11y.horizontal_rule', 'es', 'Línea horizontal')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ARABIC (ar)
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'a11y.markdown_toolbar', 'ar', 'شريط أدوات تنسيق Markdown'),
('ui', 'a11y.bold', 'ar', 'غامق'),
('ui', 'a11y.italic', 'ar', 'مائل'),
('ui', 'a11y.strikethrough', 'ar', 'يتوسطه خط'),
('ui', 'a11y.heading_1', 'ar', 'عنوان 1'),
('ui', 'a11y.heading_2', 'ar', 'عنوان 2'),
('ui', 'a11y.heading_3', 'ar', 'عنوان 3'),
('ui', 'a11y.bullet_list', 'ar', 'قائمة نقطية'),
('ui', 'a11y.ordered_list', 'ar', 'قائمة مرقمة'),
('ui', 'a11y.blockquote', 'ar', 'اقتباس'),
('ui', 'a11y.code', 'ar', 'كتلة تعليمات برمجية'),
('ui', 'a11y.horizontal_rule', 'ar', 'خط أفقي')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- FRENCH (fr)
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'a11y.markdown_toolbar', 'fr', 'Barre d''outils de formatage Markdown'),
('ui', 'a11y.bold', 'fr', 'Gras'),
('ui', 'a11y.italic', 'fr', 'Italique'),
('ui', 'a11y.strikethrough', 'fr', 'Barré'),
('ui', 'a11y.heading_1', 'fr', 'Titre 1'),
('ui', 'a11y.heading_2', 'fr', 'Titre 2'),
('ui', 'a11y.heading_3', 'fr', 'Titre 3'),
('ui', 'a11y.bullet_list', 'fr', 'Liste à puces'),
('ui', 'a11y.ordered_list', 'fr', 'Liste numérotée'),
('ui', 'a11y.blockquote', 'fr', 'Citation'),
('ui', 'a11y.code', 'fr', 'Bloc de code'),
('ui', 'a11y.horizontal_rule', 'fr', 'Ligne horizontale')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- GERMAN (de)
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'a11y.markdown_toolbar', 'de', 'Markdown-Formatierungsleiste'),
('ui', 'a11y.bold', 'de', 'Fett'),
('ui', 'a11y.italic', 'de', 'Kursiv'),
('ui', 'a11y.strikethrough', 'de', 'Durchgestrichen'),
('ui', 'a11y.heading_1', 'de', 'Überschrift 1'),
('ui', 'a11y.heading_2', 'de', 'Überschrift 2'),
('ui', 'a11y.heading_3', 'de', 'Überschrift 3'),
('ui', 'a11y.bullet_list', 'de', 'Aufzählungsliste'),
('ui', 'a11y.ordered_list', 'de', 'Nummerierte Liste'),
('ui', 'a11y.blockquote', 'de', 'Zitat'),
('ui', 'a11y.code', 'de', 'Codeblock'),
('ui', 'a11y.horizontal_rule', 'de', 'Horizontale Linie')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- PASHTO (ps)
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'a11y.markdown_toolbar', 'ps', 'د Markdown بڼه ورکولو وسیلې پټه'),
('ui', 'a11y.bold', 'ps', 'ډبل'),
('ui', 'a11y.italic', 'ps', 'ترچ'),
('ui', 'a11y.strikethrough', 'ps', 'کرښه وهل شوی'),
('ui', 'a11y.heading_1', 'ps', 'سرلیک ۱'),
('ui', 'a11y.heading_2', 'ps', 'سرلیک ۲'),
('ui', 'a11y.heading_3', 'ps', 'سرلیک ۳'),
('ui', 'a11y.bullet_list', 'ps', 'ټکي لرونکې لیست'),
('ui', 'a11y.ordered_list', 'ps', 'شمېره لرونکې لیست'),
('ui', 'a11y.blockquote', 'ps', 'نقل قول'),
('ui', 'a11y.code', 'ps', 'د کوډ بلاک'),
('ui', 'a11y.horizontal_rule', 'ps', 'افقي کرښه')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
