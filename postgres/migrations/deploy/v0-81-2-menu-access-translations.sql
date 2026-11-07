-- Deploy civic_os:v0-81-2-menu-access-translations
-- Requires: v0-81-2-menu-access
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- v0.81.2 -- Translate the menu editor's stale-save notice and its Reload button.
-- Seeds the six core locales (en for get_translation_defaults(), plus es/fr/de/ar/ps).
-- Instance-agnostic UI strings only: no schema change, no instance content.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'admin_menu.conflict', 'en', 'Someone else changed the menu after you opened it, so your changes were not saved. Reload to see the current menu (your unsaved changes will be lost).'),
('ui', 'admin_menu.conflict', 'es', 'Otra persona cambió el menú después de que usted lo abrió, por lo que sus cambios no se guardaron. Vuelva a cargarlo para ver el menú actual (se perderán sus cambios sin guardar).'),
('ui', 'admin_menu.conflict', 'fr', 'Quelqu''un d''autre a modifié le menu après que vous l''avez ouvert, vos modifications n''ont donc pas été enregistrées. Rechargez pour voir le menu actuel (vos modifications non enregistrées seront perdues).'),
('ui', 'admin_menu.conflict', 'de', 'Jemand anderes hat das Menü geändert, nachdem Sie es geöffnet haben, daher wurden Ihre Änderungen nicht gespeichert. Laden Sie neu, um das aktuelle Menü zu sehen (Ihre nicht gespeicherten Änderungen gehen verloren).'),
('ui', 'admin_menu.conflict', 'ar', 'غيّر شخص آخر القائمة بعد أن فتحتها، لذلك لم تُحفظ تغييراتك. أعد التحميل لرؤية القائمة الحالية (ستفقد تغييراتك غير المحفوظة).'),
('ui', 'admin_menu.conflict', 'ps', 'بل چا مینو ستاسو له پرانیستلو وروسته بدل کړ، نو ستاسو بدلونونه خوندي نه شول. د اوسني مینو لیدو لپاره یې بیا پورته کړئ (ستاسو ناخوندي بدلونونه به ورک شي).'),
('ui', 'admin_menu.reload', 'en', 'Reload menu'),
('ui', 'admin_menu.reload', 'es', 'Volver a cargar el menú'),
('ui', 'admin_menu.reload', 'fr', 'Recharger le menu'),
('ui', 'admin_menu.reload', 'de', 'Menü neu laden'),
('ui', 'admin_menu.reload', 'ar', 'إعادة تحميل القائمة'),
('ui', 'admin_menu.reload', 'ps', 'مینو بیا پورته کړئ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
