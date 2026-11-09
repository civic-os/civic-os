-- Revert civic_os:v0-81-2-menu-access-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Deletes only rows still holding the text this change seeded. A row an integrator customized
-- (deploy uses ON CONFLICT DO NOTHING, so it may predate this change or have been edited since)
-- is left in place.

BEGIN;

DELETE FROM metadata.translations t
USING (VALUES
  ('admin_menu.conflict', 'en', 'Someone else changed the menu after you opened it, so your changes were not saved. Reload to see the current menu (your unsaved changes will be lost).'),
  ('admin_menu.conflict', 'es', 'Otra persona cambió el menú después de que usted lo abrió, por lo que sus cambios no se guardaron. Vuelva a cargarlo para ver el menú actual (se perderán sus cambios sin guardar).'),
  ('admin_menu.conflict', 'fr', 'Quelqu''un d''autre a modifié le menu après que vous l''avez ouvert, vos modifications n''ont donc pas été enregistrées. Rechargez pour voir le menu actuel (vos modifications non enregistrées seront perdues).'),
  ('admin_menu.conflict', 'de', 'Jemand anderes hat das Menü geändert, nachdem Sie es geöffnet haben, daher wurden Ihre Änderungen nicht gespeichert. Laden Sie neu, um das aktuelle Menü zu sehen (Ihre nicht gespeicherten Änderungen gehen verloren).'),
  ('admin_menu.conflict', 'ar', 'غيّر شخص آخر القائمة بعد أن فتحتها، لذلك لم تُحفظ تغييراتك. أعد التحميل لرؤية القائمة الحالية (ستفقد تغييراتك غير المحفوظة).'),
  ('admin_menu.conflict', 'ps', 'بل چا مینو ستاسو له پرانیستلو وروسته بدل کړ، نو ستاسو بدلونونه خوندي نه شول. د اوسني مینو لیدو لپاره یې بیا پورته کړئ (ستاسو ناخوندي بدلونونه به ورک شي).'),
  ('admin_menu.reload', 'en', 'Reload menu'),
  ('admin_menu.reload', 'es', 'Volver a cargar el menú'),
  ('admin_menu.reload', 'fr', 'Recharger le menu'),
  ('admin_menu.reload', 'de', 'Menü neu laden'),
  ('admin_menu.reload', 'ar', 'إعادة تحميل القائمة'),
  ('admin_menu.reload', 'ps', 'مینو بیا پورته کړئ')
) AS seeded(source_key, locale, translated_text)
WHERE t.source_type = 'ui'
  AND t.source_key = seeded.source_key
  AND t.locale = seeded.locale
  AND t.translated_text = seeded.translated_text;

COMMIT;
