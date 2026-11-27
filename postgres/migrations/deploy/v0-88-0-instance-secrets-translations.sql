-- Deploy civic_os:v0-88-0-instance-secrets-translations
-- Requires: v0-88-0-instance-secrets
--
-- v0.88.0 -- Translate the secret-key rows of /admin/config (admin_config.secret.* and
-- a11y.admin_config.secret_clear) in the six core locales (en for get_translation_defaults(), plus
-- es/ar/fr/de/ps). Instance-agnostic UI strings only: no schema change, no instance content.

BEGIN;

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'admin_config.secret.set', 'en', 'Set'),
('ui', 'admin_config.secret.set', 'es', 'Definido'),
('ui', 'admin_config.secret.set', 'ar', 'مُعيَّن'),
('ui', 'admin_config.secret.set', 'fr', 'Défini'),
('ui', 'admin_config.secret.set', 'de', 'Gesetzt'),
('ui', 'admin_config.secret.set', 'ps', 'ټاکل شوی'),
('ui', 'admin_config.secret.missing', 'en', 'Missing'),
('ui', 'admin_config.secret.missing', 'es', 'Falta'),
('ui', 'admin_config.secret.missing', 'ar', 'مفقود'),
('ui', 'admin_config.secret.missing', 'fr', 'Manquant'),
('ui', 'admin_config.secret.missing', 'de', 'Fehlt'),
('ui', 'admin_config.secret.missing', 'ps', 'نشته'),
('ui', 'admin_config.secret.changed', 'en', 'Changed {{date}}'),
('ui', 'admin_config.secret.changed', 'es', 'Cambiado el {{date}}'),
('ui', 'admin_config.secret.changed', 'ar', 'تم التغيير في {{date}}'),
('ui', 'admin_config.secret.changed', 'fr', 'Modifié le {{date}}'),
('ui', 'admin_config.secret.changed', 'de', 'Geändert am {{date}}'),
('ui', 'admin_config.secret.changed', 'ps', 'په {{date}} بدل شو'),
('ui', 'admin_config.secret.deployment_managed', 'en', 'Set by the deployment. It cannot be changed here.'),
('ui', 'admin_config.secret.deployment_managed', 'es', 'Lo define el despliegue. No se puede cambiar aquí.'),
('ui', 'admin_config.secret.deployment_managed', 'ar', 'يحدده النشر. لا يمكن تغييره هنا.'),
('ui', 'admin_config.secret.deployment_managed', 'fr', 'Défini par le déploiement. Il ne peut pas être modifié ici.'),
('ui', 'admin_config.secret.deployment_managed', 'de', 'Wird bei der Bereitstellung festgelegt. Kann hier nicht geändert werden.'),
('ui', 'admin_config.secret.deployment_managed', 'ps', 'د ځای پر ځای کولو له لارې ټاکل کیږي. دلته نشي بدلېدای.'),
('ui', 'admin_config.secret.replace', 'en', 'Replace'),
('ui', 'admin_config.secret.replace', 'es', 'Reemplazar'),
('ui', 'admin_config.secret.replace', 'ar', 'استبدال'),
('ui', 'admin_config.secret.replace', 'fr', 'Remplacer'),
('ui', 'admin_config.secret.replace', 'de', 'Ersetzen'),
('ui', 'admin_config.secret.replace', 'ps', 'ځای ناستی کړئ'),
('ui', 'admin_config.secret.clear', 'en', 'Clear'),
('ui', 'admin_config.secret.clear', 'es', 'Borrar'),
('ui', 'admin_config.secret.clear', 'ar', 'مسح'),
('ui', 'admin_config.secret.clear', 'fr', 'Effacer'),
('ui', 'admin_config.secret.clear', 'de', 'Löschen'),
('ui', 'admin_config.secret.clear', 'ps', 'پاک کړئ'),
('ui', 'admin_config.secret.new_value', 'en', 'Type a new value'),
('ui', 'admin_config.secret.new_value', 'es', 'Escriba un valor nuevo'),
('ui', 'admin_config.secret.new_value', 'ar', 'اكتب قيمة جديدة'),
('ui', 'admin_config.secret.new_value', 'fr', 'Saisissez une nouvelle valeur'),
('ui', 'admin_config.secret.new_value', 'de', 'Neuen Wert eingeben'),
('ui', 'admin_config.secret.new_value', 'ps', 'نوی ارزښت ولیکئ'),
('ui', 'a11y.admin_config.secret_clear', 'en', 'Clear {{name}}'),
('ui', 'a11y.admin_config.secret_clear', 'es', 'Borrar {{name}}'),
('ui', 'a11y.admin_config.secret_clear', 'ar', 'مسح {{name}}'),
('ui', 'a11y.admin_config.secret_clear', 'fr', 'Effacer {{name}}'),
('ui', 'a11y.admin_config.secret_clear', 'de', '{{name}} löschen'),
('ui', 'a11y.admin_config.secret_clear', 'ps', '{{name}} پاک کړئ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
