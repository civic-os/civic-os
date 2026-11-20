-- Deploy civic_os:v0-85-0-registry-translations to pg
-- requires: v0-85-0-compare-interface-registries
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Translations for v0.85.0 in the six core locales (en, es, fr, de, ar, ps):
--   constraint_message  tree_parent_cycle, dimension_row_delete (read through public.constraint_messages)
--   ui                  admin_translations.source_type.constraint_message, the /admin/translations filter label
-- The English constraint_message rows match metadata.constraint_messages and make the two messages appear,
-- with their defaults, at /admin/translations (get_translation_defaults() lists every English row). The
-- English ui row matches src/app/i18n/en.translations.ts.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('constraint_message', 'tree_parent_cycle', 'en', 'A record cannot be placed under itself or one of its own descendants. Choose a different parent.'),
('constraint_message', 'tree_parent_cycle', 'es', 'Un registro no puede colocarse debajo de sí mismo ni de uno de sus propios descendientes. Elija otro elemento superior.'),
('constraint_message', 'tree_parent_cycle', 'fr', 'Un enregistrement ne peut pas être placé sous lui-même ni sous l''un de ses propres descendants. Choisissez un autre parent.'),
('constraint_message', 'tree_parent_cycle', 'de', 'Ein Datensatz kann nicht unter sich selbst oder einem seiner eigenen Nachkommen eingeordnet werden. Wählen Sie ein anderes übergeordnetes Element.'),
('constraint_message', 'tree_parent_cycle', 'ar', 'لا يمكن وضع سجل تحت نفسه أو تحت أحد العناصر المتفرعة منه. اختر عنصرًا أصلًا مختلفًا.'),
('constraint_message', 'tree_parent_cycle', 'ps', 'یو ریکارډ نشي کولی د ځان یا د خپلو فرعي توکو لاندې کېښودل شي. بل اصلي توکی وټاکئ.'),

('constraint_message', 'dimension_row_delete', 'en', 'This record is used for reporting and cannot be deleted. Mark it inactive instead.'),
('constraint_message', 'dimension_row_delete', 'es', 'Este registro se usa en los informes y no se puede eliminar. Márquelo como inactivo.'),
('constraint_message', 'dimension_row_delete', 'fr', 'Cet enregistrement est utilisé dans les rapports et ne peut pas être supprimé. Marquez-le plutôt comme inactif.'),
('constraint_message', 'dimension_row_delete', 'de', 'Dieser Datensatz wird für Berichte verwendet und kann nicht gelöscht werden. Markieren Sie ihn stattdessen als inaktiv.'),
('constraint_message', 'dimension_row_delete', 'ar', 'يُستخدم هذا السجل في التقارير ولا يمكن حذفه. ضع عليه علامة غير نشط بدلًا من ذلك.'),
('constraint_message', 'dimension_row_delete', 'ps', 'دا ریکارډ په راپورونو کې کارول کېږي او نشي ړنګېدای. پر ځای یې غیر فعال په نښه کړئ.'),

('ui', 'admin_translations.source_type.constraint_message', 'en', 'Error messages'),
('ui', 'admin_translations.source_type.constraint_message', 'es', 'Mensajes de error'),
('ui', 'admin_translations.source_type.constraint_message', 'fr', 'Messages d''erreur'),
('ui', 'admin_translations.source_type.constraint_message', 'de', 'Fehlermeldungen'),
('ui', 'admin_translations.source_type.constraint_message', 'ar', 'رسائل الخطأ'),
('ui', 'admin_translations.source_type.constraint_message', 'ps', 'د تېروتنې پیغامونه')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
