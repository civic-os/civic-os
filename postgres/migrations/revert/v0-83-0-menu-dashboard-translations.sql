-- Revert civic_os:v0-83-0-menu-dashboard-translations
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
  ('admin_menu.dashboard_badge', 'en', 'Dashboard'),
  ('admin_menu.dashboard_badge', 'es', 'Tablero'),
  ('admin_menu.dashboard_badge', 'fr', 'Tableau de bord'),
  ('admin_menu.dashboard_badge', 'de', 'Dashboard'),
  ('admin_menu.dashboard_badge', 'ar', 'لوحة المعلومات'),
  ('admin_menu.dashboard_badge', 'ps', 'ډشبورډ'),
  ('admin_menu.dashboards', 'en', 'Dashboards not in the menu'),
  ('admin_menu.dashboards', 'es', 'Tableros fuera del menú'),
  ('admin_menu.dashboards', 'fr', 'Tableaux de bord absents du menu'),
  ('admin_menu.dashboards', 'de', 'Dashboards nicht im Menü'),
  ('admin_menu.dashboards', 'ar', 'لوحات المعلومات خارج القائمة'),
  ('admin_menu.dashboards', 'ps', 'هغه ډشبورډونه چې په مینو کې نه دي'),
  ('admin_menu.dashboards_help', 'en', 'A dashboard appears in the menu only once you place it, and only to people who can see it. Placing it changes neither who can open it nor whether the dashboard selector lists it.'),
  ('admin_menu.dashboards_help', 'es', 'Un tablero aparece en el menú solo cuando lo coloca, y solo para quienes pueden verlo. Colocarlo no cambia quién puede abrirlo ni si el selector de tableros lo muestra.'),
  ('admin_menu.dashboards_help', 'fr', 'Un tableau de bord n''apparaît dans le menu qu''une fois placé, et seulement pour les personnes qui peuvent le voir. Le placer ne change ni qui peut l''ouvrir ni sa présence dans le sélecteur de tableaux de bord.'),
  ('admin_menu.dashboards_help', 'de', 'Ein Dashboard erscheint erst im Menü, wenn Sie es platzieren, und nur für Personen, die es sehen dürfen. Das Platzieren ändert weder, wer es öffnen kann, noch ob die Dashboard-Auswahl es auflistet.'),
  ('admin_menu.dashboards_help', 'ar', 'لا تظهر لوحة المعلومات في القائمة إلا بعد وضعها فيها، ولمن يمكنهم رؤيتها فقط. ولا يغيّر وضعها من يمكنه فتحها ولا ظهورها في محدد لوحات المعلومات.'),
  ('admin_menu.dashboards_help', 'ps', 'ډشبورډ یوازې هغه وخت په مینو کې ښکاري چې تاسو یې ځای پر ځای کړئ، او یوازې هغو کسانو ته چې لیدلی یې شي. ځای پر ځای کول نه دا بدلوي چې څوک یې خلاصولی شي او نه دا چې د ډشبورډ ټاکونکی یې ښيي.'),
  ('admin_menu.dashboards_empty', 'en', 'Every dashboard you can see is in the menu.'),
  ('admin_menu.dashboards_empty', 'es', 'Todos los tableros que puede ver están en el menú.'),
  ('admin_menu.dashboards_empty', 'fr', 'Tous les tableaux de bord que vous pouvez voir figurent dans le menu.'),
  ('admin_menu.dashboards_empty', 'de', 'Jedes Dashboard, das Sie sehen können, ist im Menü.'),
  ('admin_menu.dashboards_empty', 'ar', 'كل لوحات المعلومات التي يمكنك رؤيتها موجودة في القائمة.'),
  ('admin_menu.dashboards_empty', 'ps', 'هر ډشبورډ چې تاسو یې لیدلی شئ په مینو کې دی.'),
  ('admin_menu.dashboard_not_shown_help', 'en', 'You cannot see this dashboard, so your preview leaves it out. People who can see it get the link.'),
  ('admin_menu.dashboard_not_shown_help', 'es', 'No puede ver este tablero, así que su vista previa lo omite. Quienes pueden verlo reciben el enlace.'),
  ('admin_menu.dashboard_not_shown_help', 'fr', 'Vous ne pouvez pas voir ce tableau de bord, votre aperçu l''omet donc. Les personnes qui peuvent le voir reçoivent le lien.'),
  ('admin_menu.dashboard_not_shown_help', 'de', 'Sie können dieses Dashboard nicht sehen, daher fehlt es in Ihrer Vorschau. Personen, die es sehen dürfen, erhalten den Link.'),
  ('admin_menu.dashboard_not_shown_help', 'ar', 'لا يمكنك رؤية لوحة المعلومات هذه، لذا تستبعدها معاينتك. يحصل على الرابط من يمكنهم رؤيتها.'),
  ('admin_menu.dashboard_not_shown_help', 'ps', 'تاسو دا ډشبورډ نه شئ لیدلی، نو ستاسو مخکتنه یې نه ښيي. هغه کسان چې لیدلی یې شي لینک ترلاسه کوي.'),
  ('admin_menu.links_to', 'en', 'Opens dashboard'),
  ('admin_menu.links_to', 'es', 'Abre el tablero'),
  ('admin_menu.links_to', 'fr', 'Ouvre le tableau de bord'),
  ('admin_menu.links_to', 'de', 'Öffnet Dashboard'),
  ('admin_menu.links_to', 'ar', 'يفتح لوحة المعلومات'),
  ('admin_menu.links_to', 'ps', 'ډشبورډ خلاصوي'),
  ('admin_menu.links_to_none', 'en', 'None (heading only)'),
  ('admin_menu.links_to_none', 'es', 'Ninguno (solo encabezado)'),
  ('admin_menu.links_to_none', 'fr', 'Aucun (titre seul)'),
  ('admin_menu.links_to_none', 'de', 'Keines (nur Überschrift)'),
  ('admin_menu.links_to_none', 'ar', 'لا شيء (عنوان فقط)'),
  ('admin_menu.links_to_none', 'ps', 'هیڅ (یوازې سرلیک)'),
  ('admin_menu.links_to_help', 'en', 'The heading''s title opens this dashboard. People who cannot see the dashboard get a plain heading.'),
  ('admin_menu.links_to_help', 'es', 'El título del encabezado abre este tablero. Quienes no pueden ver el tablero reciben un encabezado simple.'),
  ('admin_menu.links_to_help', 'fr', 'Le titre ouvre ce tableau de bord. Les personnes qui ne peuvent pas le voir obtiennent un titre simple.'),
  ('admin_menu.links_to_help', 'de', 'Der Titel der Überschrift öffnet dieses Dashboard. Wer das Dashboard nicht sehen kann, erhält eine einfache Überschrift.'),
  ('admin_menu.links_to_help', 'ar', 'يفتح عنوان القسم لوحة المعلومات هذه. ويرى من لا يمكنهم رؤيتها عنوانًا عاديًا.'),
  ('admin_menu.links_to_help', 'ps', 'د سرلیک عنوان دا ډشبورډ خلاصوي. هغه کسان چې ډشبورډ نه شي لیدلی ساده سرلیک ویني.'),
  ('admin_menu.error.dashboard-key', 'en', '"{{name}}" has an invalid dashboard link.'),
  ('admin_menu.error.dashboard-key', 'es', '"{{name}}" tiene un enlace de tablero no válido.'),
  ('admin_menu.error.dashboard-key', 'fr', '« {{name}} » a un lien de tableau de bord non valide.'),
  ('admin_menu.error.dashboard-key', 'de', '„{{name}}“ hat einen ungültigen Dashboard-Link.'),
  ('admin_menu.error.dashboard-key', 'ar', '"{{name}}" يحتوي على رابط لوحة معلومات غير صالح.'),
  ('admin_menu.error.dashboard-key', 'ps', '"{{name}}" د ډشبورډ ناسم لینک لري.'),
  ('admin_menu.error.dashboard-children', 'en', '"{{name}}" cannot be nested under a dashboard.'),
  ('admin_menu.error.dashboard-children', 'es', '"{{name}}" no puede anidarse bajo un tablero.'),
  ('admin_menu.error.dashboard-children', 'fr', '« {{name}} » ne peut pas être imbriqué sous un tableau de bord.'),
  ('admin_menu.error.dashboard-children', 'de', '„{{name}}“ kann nicht unter einem Dashboard verschachtelt werden.'),
  ('admin_menu.error.dashboard-children', 'ar', 'لا يمكن وضع "{{name}}" تحت لوحة معلومات.'),
  ('admin_menu.error.dashboard-children', 'ps', '"{{name}}" د ډشبورډ لاندې نه شي ایښودل کېدای.'),
  ('admin_menu.error.duplicate-dashboard', 'en', 'The dashboard of "{{name}}" is already in the menu.'),
  ('admin_menu.error.duplicate-dashboard', 'es', 'El tablero de "{{name}}" ya está en el menú.'),
  ('admin_menu.error.duplicate-dashboard', 'fr', 'Le tableau de bord de « {{name}} » figure déjà dans le menu.'),
  ('admin_menu.error.duplicate-dashboard', 'de', 'Das Dashboard von „{{name}}“ ist bereits im Menü.'),
  ('admin_menu.error.duplicate-dashboard', 'ar', 'لوحة المعلومات الخاصة بـ "{{name}}" موجودة بالفعل في القائمة.'),
  ('admin_menu.error.duplicate-dashboard', 'ps', 'د "{{name}}" ډشبورډ مخکې له مخکې په مینو کې دی.')
) AS seeded(source_key, locale, translated_text)
WHERE t.source_type = 'ui'
  AND t.source_key = seeded.source_key
  AND t.locale = seeded.locale
  AND t.translated_text = seeded.translated_text;

COMMIT;
