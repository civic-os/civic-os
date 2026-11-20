-- Deploy civic_os:v0-83-0-menu-dashboard-translations
-- Requires: v0-83-0-menu-dashboard-nodes
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- v0.83.0 -- Translate the menu editor's dashboard strings (the dashboards tray, the dashboard badge, a
-- heading's dashboard link and the dashboard validation messages) into the six core locales.
-- Instance-agnostic UI strings only: no schema change, no instance content.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'admin_menu.dashboard_badge', 'en', 'Dashboard'),
('ui', 'admin_menu.dashboard_badge', 'es', 'Tablero'),
('ui', 'admin_menu.dashboard_badge', 'fr', 'Tableau de bord'),
('ui', 'admin_menu.dashboard_badge', 'de', 'Dashboard'),
('ui', 'admin_menu.dashboard_badge', 'ar', 'لوحة المعلومات'),
('ui', 'admin_menu.dashboard_badge', 'ps', 'ډشبورډ'),
('ui', 'admin_menu.dashboards', 'en', 'Dashboards not in the menu'),
('ui', 'admin_menu.dashboards', 'es', 'Tableros fuera del menú'),
('ui', 'admin_menu.dashboards', 'fr', 'Tableaux de bord absents du menu'),
('ui', 'admin_menu.dashboards', 'de', 'Dashboards nicht im Menü'),
('ui', 'admin_menu.dashboards', 'ar', 'لوحات المعلومات خارج القائمة'),
('ui', 'admin_menu.dashboards', 'ps', 'هغه ډشبورډونه چې په مینو کې نه دي'),
('ui', 'admin_menu.dashboards_help', 'en', 'A dashboard appears in the menu only once you place it, and only to people who can see it. Placing it changes neither who can open it nor whether the dashboard selector lists it.'),
('ui', 'admin_menu.dashboards_help', 'es', 'Un tablero aparece en el menú solo cuando lo coloca, y solo para quienes pueden verlo. Colocarlo no cambia quién puede abrirlo ni si el selector de tableros lo muestra.'),
('ui', 'admin_menu.dashboards_help', 'fr', 'Un tableau de bord n''apparaît dans le menu qu''une fois placé, et seulement pour les personnes qui peuvent le voir. Le placer ne change ni qui peut l''ouvrir ni sa présence dans le sélecteur de tableaux de bord.'),
('ui', 'admin_menu.dashboards_help', 'de', 'Ein Dashboard erscheint erst im Menü, wenn Sie es platzieren, und nur für Personen, die es sehen dürfen. Das Platzieren ändert weder, wer es öffnen kann, noch ob die Dashboard-Auswahl es auflistet.'),
('ui', 'admin_menu.dashboards_help', 'ar', 'لا تظهر لوحة المعلومات في القائمة إلا بعد وضعها فيها، ولمن يمكنهم رؤيتها فقط. ولا يغيّر وضعها من يمكنه فتحها ولا ظهورها في محدد لوحات المعلومات.'),
('ui', 'admin_menu.dashboards_help', 'ps', 'ډشبورډ یوازې هغه وخت په مینو کې ښکاري چې تاسو یې ځای پر ځای کړئ، او یوازې هغو کسانو ته چې لیدلی یې شي. ځای پر ځای کول نه دا بدلوي چې څوک یې خلاصولی شي او نه دا چې د ډشبورډ ټاکونکی یې ښيي.'),
('ui', 'admin_menu.dashboards_empty', 'en', 'Every dashboard you can see is in the menu.'),
('ui', 'admin_menu.dashboards_empty', 'es', 'Todos los tableros que puede ver están en el menú.'),
('ui', 'admin_menu.dashboards_empty', 'fr', 'Tous les tableaux de bord que vous pouvez voir figurent dans le menu.'),
('ui', 'admin_menu.dashboards_empty', 'de', 'Jedes Dashboard, das Sie sehen können, ist im Menü.'),
('ui', 'admin_menu.dashboards_empty', 'ar', 'كل لوحات المعلومات التي يمكنك رؤيتها موجودة في القائمة.'),
('ui', 'admin_menu.dashboards_empty', 'ps', 'هر ډشبورډ چې تاسو یې لیدلی شئ په مینو کې دی.'),
('ui', 'admin_menu.dashboard_not_shown_help', 'en', 'You cannot see this dashboard, so your preview leaves it out. People who can see it get the link.'),
('ui', 'admin_menu.dashboard_not_shown_help', 'es', 'No puede ver este tablero, así que su vista previa lo omite. Quienes pueden verlo reciben el enlace.'),
('ui', 'admin_menu.dashboard_not_shown_help', 'fr', 'Vous ne pouvez pas voir ce tableau de bord, votre aperçu l''omet donc. Les personnes qui peuvent le voir reçoivent le lien.'),
('ui', 'admin_menu.dashboard_not_shown_help', 'de', 'Sie können dieses Dashboard nicht sehen, daher fehlt es in Ihrer Vorschau. Personen, die es sehen dürfen, erhalten den Link.'),
('ui', 'admin_menu.dashboard_not_shown_help', 'ar', 'لا يمكنك رؤية لوحة المعلومات هذه، لذا تستبعدها معاينتك. يحصل على الرابط من يمكنهم رؤيتها.'),
('ui', 'admin_menu.dashboard_not_shown_help', 'ps', 'تاسو دا ډشبورډ نه شئ لیدلی، نو ستاسو مخکتنه یې نه ښيي. هغه کسان چې لیدلی یې شي لینک ترلاسه کوي.'),
('ui', 'admin_menu.links_to', 'en', 'Opens dashboard'),
('ui', 'admin_menu.links_to', 'es', 'Abre el tablero'),
('ui', 'admin_menu.links_to', 'fr', 'Ouvre le tableau de bord'),
('ui', 'admin_menu.links_to', 'de', 'Öffnet Dashboard'),
('ui', 'admin_menu.links_to', 'ar', 'يفتح لوحة المعلومات'),
('ui', 'admin_menu.links_to', 'ps', 'ډشبورډ خلاصوي'),
('ui', 'admin_menu.links_to_none', 'en', 'None (heading only)'),
('ui', 'admin_menu.links_to_none', 'es', 'Ninguno (solo encabezado)'),
('ui', 'admin_menu.links_to_none', 'fr', 'Aucun (titre seul)'),
('ui', 'admin_menu.links_to_none', 'de', 'Keines (nur Überschrift)'),
('ui', 'admin_menu.links_to_none', 'ar', 'لا شيء (عنوان فقط)'),
('ui', 'admin_menu.links_to_none', 'ps', 'هیڅ (یوازې سرلیک)'),
('ui', 'admin_menu.links_to_help', 'en', 'The heading''s title opens this dashboard. People who cannot see the dashboard get a plain heading.'),
('ui', 'admin_menu.links_to_help', 'es', 'El título del encabezado abre este tablero. Quienes no pueden ver el tablero reciben un encabezado simple.'),
('ui', 'admin_menu.links_to_help', 'fr', 'Le titre ouvre ce tableau de bord. Les personnes qui ne peuvent pas le voir obtiennent un titre simple.'),
('ui', 'admin_menu.links_to_help', 'de', 'Der Titel der Überschrift öffnet dieses Dashboard. Wer das Dashboard nicht sehen kann, erhält eine einfache Überschrift.'),
('ui', 'admin_menu.links_to_help', 'ar', 'يفتح عنوان القسم لوحة المعلومات هذه. ويرى من لا يمكنهم رؤيتها عنوانًا عاديًا.'),
('ui', 'admin_menu.links_to_help', 'ps', 'د سرلیک عنوان دا ډشبورډ خلاصوي. هغه کسان چې ډشبورډ نه شي لیدلی ساده سرلیک ویني.'),
('ui', 'admin_menu.error.dashboard-key', 'en', '"{{name}}" has an invalid dashboard link.'),
('ui', 'admin_menu.error.dashboard-key', 'es', '"{{name}}" tiene un enlace de tablero no válido.'),
('ui', 'admin_menu.error.dashboard-key', 'fr', '« {{name}} » a un lien de tableau de bord non valide.'),
('ui', 'admin_menu.error.dashboard-key', 'de', '„{{name}}“ hat einen ungültigen Dashboard-Link.'),
('ui', 'admin_menu.error.dashboard-key', 'ar', '"{{name}}" يحتوي على رابط لوحة معلومات غير صالح.'),
('ui', 'admin_menu.error.dashboard-key', 'ps', '"{{name}}" د ډشبورډ ناسم لینک لري.'),
('ui', 'admin_menu.error.dashboard-children', 'en', '"{{name}}" cannot be nested under a dashboard.'),
('ui', 'admin_menu.error.dashboard-children', 'es', '"{{name}}" no puede anidarse bajo un tablero.'),
('ui', 'admin_menu.error.dashboard-children', 'fr', '« {{name}} » ne peut pas être imbriqué sous un tableau de bord.'),
('ui', 'admin_menu.error.dashboard-children', 'de', '„{{name}}“ kann nicht unter einem Dashboard verschachtelt werden.'),
('ui', 'admin_menu.error.dashboard-children', 'ar', 'لا يمكن وضع "{{name}}" تحت لوحة معلومات.'),
('ui', 'admin_menu.error.dashboard-children', 'ps', '"{{name}}" د ډشبورډ لاندې نه شي ایښودل کېدای.'),
('ui', 'admin_menu.error.duplicate-dashboard', 'en', 'The dashboard of "{{name}}" is already in the menu.'),
('ui', 'admin_menu.error.duplicate-dashboard', 'es', 'El tablero de "{{name}}" ya está en el menú.'),
('ui', 'admin_menu.error.duplicate-dashboard', 'fr', 'Le tableau de bord de « {{name}} » figure déjà dans le menu.'),
('ui', 'admin_menu.error.duplicate-dashboard', 'de', 'Das Dashboard von „{{name}}“ ist bereits im Menü.'),
('ui', 'admin_menu.error.duplicate-dashboard', 'ar', 'لوحة المعلومات الخاصة بـ "{{name}}" موجودة بالفعل في القائمة.'),
('ui', 'admin_menu.error.duplicate-dashboard', 'ps', 'د "{{name}}" ډشبورډ مخکې له مخکې په مینو کې دی.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
