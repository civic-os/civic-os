-- =====================================================
-- Exemplary Community Services (demo instance)
-- 28: Consent Subsystem Translations
-- =====================================================
-- Translations for the consent subsystem (script 26) and
-- consent dashboard widget (script 27) across all 5
-- non-English locales: es, ar, ps, fr, de.
--
-- Covers: entities, properties, statuses, categories,
-- entity actions, action params, and dashboard widget.
--
-- Requires: 26_consent_subsystem.sql, 27_consent_dashboard_widget.sql
-- =====================================================

-- ============================================================================
-- ENTITIES — display names
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('entity', 'client_consents.display_name', 'es', 'Consentimientos de Clientes'),
  ('entity', 'client_current_consents.display_name', 'es', 'Consentimientos Vigentes'),
  ('entity', 'consents_expiring_soon.display_name', 'es', 'Consentimientos por Vencer'),
  -- Arabic
  ('entity', 'client_consents.display_name', 'ar', 'موافقات العملاء'),
  ('entity', 'client_current_consents.display_name', 'ar', 'الموافقات الحالية'),
  ('entity', 'consents_expiring_soon.display_name', 'ar', 'موافقات قاربت على الانتهاء'),
  -- Pashto
  ('entity', 'client_consents.display_name', 'ps', 'د مراجعینو موافقتونه'),
  ('entity', 'client_current_consents.display_name', 'ps', 'اوسنۍ موافقتونه'),
  ('entity', 'consents_expiring_soon.display_name', 'ps', 'موافقتونه چې ډیر ژر ختمیږي'),
  -- French
  ('entity', 'client_consents.display_name', 'fr', 'Consentements des Clients'),
  ('entity', 'client_current_consents.display_name', 'fr', 'Consentements en Vigueur'),
  ('entity', 'consents_expiring_soon.display_name', 'fr', 'Consentements Expirant Bientot'),
  -- German
  ('entity', 'client_consents.display_name', 'de', 'Klientenzustimmungen'),
  ('entity', 'client_current_consents.display_name', 'de', 'Aktuelle Zustimmungen'),
  ('entity', 'consents_expiring_soon.display_name', 'de', 'Bald Ablaufende Zustimmungen')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITIES — descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('entity', 'client_consents.description', 'es', 'Registros de consentimiento con vencimiento; la puerta de referencia los consulta.'),
  ('entity', 'client_consents.description', 'ar', 'سجلات الموافقة مع تاريخ الانتهاء؛ يقرأها نظام بوابة الإحالة.'),
  ('entity', 'client_consents.description', 'ps', 'د موافقتونو ریکارډونه د ختمیدو نیټې سره؛ د لیږدنې دروازه یې لولي.'),
  ('entity', 'client_consents.description', 'fr', 'Enregistrements de consentement avec expiration; la passerelle de reference les consulte.'),
  ('entity', 'client_consents.description', 'de', 'Zustimmungsdatensaetze mit Ablaufdatum; die Vermittlungssperre liest diese.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — client_consents
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('property', 'client_consents.client_id.display_name', 'es', 'Cliente'),
  ('property', 'client_consents.status_id.display_name', 'es', 'Estado'),
  ('property', 'client_consents.method_id.display_name', 'es', 'Metodo'),
  ('property', 'client_consents.granted_date.display_name', 'es', 'Fecha de Otorgamiento'),
  ('property', 'client_consents.expires_date.display_name', 'es', 'Fecha de Vencimiento'),
  ('property', 'client_consents.revoked_date.display_name', 'es', 'Fecha de Revocacion'),
  ('property', 'client_consents.captured_by.display_name', 'es', 'Registrado Por'),
  ('property', 'client_consents.evidence_file.display_name', 'es', 'Evidencia'),
  -- Arabic
  ('property', 'client_consents.client_id.display_name', 'ar', 'العميل'),
  ('property', 'client_consents.status_id.display_name', 'ar', 'الحالة'),
  ('property', 'client_consents.method_id.display_name', 'ar', 'الطريقة'),
  ('property', 'client_consents.granted_date.display_name', 'ar', 'تاريخ المنح'),
  ('property', 'client_consents.expires_date.display_name', 'ar', 'تاريخ الانتهاء'),
  ('property', 'client_consents.revoked_date.display_name', 'ar', 'تاريخ الإلغاء'),
  ('property', 'client_consents.captured_by.display_name', 'ar', 'سجّله'),
  ('property', 'client_consents.evidence_file.display_name', 'ar', 'الدليل'),
  -- Pashto
  ('property', 'client_consents.client_id.display_name', 'ps', 'مراجع'),
  ('property', 'client_consents.status_id.display_name', 'ps', 'حالت'),
  ('property', 'client_consents.method_id.display_name', 'ps', 'طریقه'),
  ('property', 'client_consents.granted_date.display_name', 'ps', 'د ورکولو نیټه'),
  ('property', 'client_consents.expires_date.display_name', 'ps', 'د ختمیدو نیټه'),
  ('property', 'client_consents.revoked_date.display_name', 'ps', 'د لغوه کولو نیټه'),
  ('property', 'client_consents.captured_by.display_name', 'ps', 'ثبت کوونکی'),
  ('property', 'client_consents.evidence_file.display_name', 'ps', 'شواهد'),
  -- French
  ('property', 'client_consents.client_id.display_name', 'fr', 'Client'),
  ('property', 'client_consents.status_id.display_name', 'fr', 'Statut'),
  ('property', 'client_consents.method_id.display_name', 'fr', 'Methode'),
  ('property', 'client_consents.granted_date.display_name', 'fr', 'Date d''Octroi'),
  ('property', 'client_consents.expires_date.display_name', 'fr', 'Date d''Expiration'),
  ('property', 'client_consents.revoked_date.display_name', 'fr', 'Date de Revocation'),
  ('property', 'client_consents.captured_by.display_name', 'fr', 'Enregistre Par'),
  ('property', 'client_consents.evidence_file.display_name', 'fr', 'Justificatif'),
  -- German
  ('property', 'client_consents.client_id.display_name', 'de', 'Klient'),
  ('property', 'client_consents.status_id.display_name', 'de', 'Status'),
  ('property', 'client_consents.method_id.display_name', 'de', 'Methode'),
  ('property', 'client_consents.granted_date.display_name', 'de', 'Erteilungsdatum'),
  ('property', 'client_consents.expires_date.display_name', 'de', 'Ablaufdatum'),
  ('property', 'client_consents.revoked_date.display_name', 'de', 'Widerrufsdatum'),
  ('property', 'client_consents.captured_by.display_name', 'de', 'Erfasst Von'),
  ('property', 'client_consents.evidence_file.display_name', 'de', 'Nachweis')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — clients (consent gate fields)
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('property', 'clients.consent_state_id.display_name', 'es', 'Estado de Consentimiento'),
  ('property', 'clients.consent_note.display_name', 'es', 'Estado del Consentimiento'),
  -- Arabic
  ('property', 'clients.consent_state_id.display_name', 'ar', 'حالة الموافقة'),
  ('property', 'clients.consent_note.display_name', 'ar', 'ملاحظة الموافقة'),
  -- Pashto
  ('property', 'clients.consent_state_id.display_name', 'ps', 'د موافقت حالت'),
  ('property', 'clients.consent_note.display_name', 'ps', 'د موافقت یادښت'),
  -- French
  ('property', 'clients.consent_state_id.display_name', 'fr', 'Etat du Consentement'),
  ('property', 'clients.consent_note.display_name', 'fr', 'Note de Consentement'),
  -- German
  ('property', 'clients.consent_state_id.display_name', 'de', 'Zustimmungsstatus'),
  ('property', 'clients.consent_note.display_name', 'de', 'Zustimmungshinweis')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — consents_expiring_soon VIEW
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('property', 'consents_expiring_soon.client_name.display_name', 'es', 'Cliente'),
  ('property', 'consents_expiring_soon.expires_date.display_name', 'es', 'Fecha de Vencimiento'),
  ('property', 'consents_expiring_soon.days_remaining.display_name', 'es', 'Dias Restantes'),
  -- Arabic
  ('property', 'consents_expiring_soon.client_name.display_name', 'ar', 'العميل'),
  ('property', 'consents_expiring_soon.expires_date.display_name', 'ar', 'تاريخ الانتهاء'),
  ('property', 'consents_expiring_soon.days_remaining.display_name', 'ar', 'الأيام المتبقية'),
  -- Pashto
  ('property', 'consents_expiring_soon.client_name.display_name', 'ps', 'مراجع'),
  ('property', 'consents_expiring_soon.expires_date.display_name', 'ps', 'د ختمیدو نیټه'),
  ('property', 'consents_expiring_soon.days_remaining.display_name', 'ps', 'پاتې ورځې'),
  -- French
  ('property', 'consents_expiring_soon.client_name.display_name', 'fr', 'Client'),
  ('property', 'consents_expiring_soon.expires_date.display_name', 'fr', 'Date d''Expiration'),
  ('property', 'consents_expiring_soon.days_remaining.display_name', 'fr', 'Jours Restants'),
  -- German
  ('property', 'consents_expiring_soon.client_name.display_name', 'de', 'Klient'),
  ('property', 'consents_expiring_soon.expires_date.display_name', 'de', 'Ablaufdatum'),
  ('property', 'consents_expiring_soon.days_remaining.display_name', 'de', 'Verbleibende Tage')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES — client_consent display names
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('status', 'client_consent.pending.display_name', 'es', 'Pendiente'),
  ('status', 'client_consent.active.display_name', 'es', 'Activo'),
  ('status', 'client_consent.expired.display_name', 'es', 'Vencido'),
  ('status', 'client_consent.revoked.display_name', 'es', 'Revocado'),
  ('status', 'client_consent.superseded.display_name', 'es', 'Reemplazado'),
  -- Arabic
  ('status', 'client_consent.pending.display_name', 'ar', 'معلّق'),
  ('status', 'client_consent.active.display_name', 'ar', 'نشط'),
  ('status', 'client_consent.expired.display_name', 'ar', 'منتهي الصلاحية'),
  ('status', 'client_consent.revoked.display_name', 'ar', 'ملغى'),
  ('status', 'client_consent.superseded.display_name', 'ar', 'مستبدل'),
  -- Pashto
  ('status', 'client_consent.pending.display_name', 'ps', 'پاتې'),
  ('status', 'client_consent.active.display_name', 'ps', 'فعال'),
  ('status', 'client_consent.expired.display_name', 'ps', 'ختم شوی'),
  ('status', 'client_consent.revoked.display_name', 'ps', 'لغوه شوی'),
  ('status', 'client_consent.superseded.display_name', 'ps', 'بدل شوی'),
  -- French
  ('status', 'client_consent.pending.display_name', 'fr', 'En Attente'),
  ('status', 'client_consent.active.display_name', 'fr', 'Actif'),
  ('status', 'client_consent.expired.display_name', 'fr', 'Expire'),
  ('status', 'client_consent.revoked.display_name', 'fr', 'Revoque'),
  ('status', 'client_consent.superseded.display_name', 'fr', 'Remplace'),
  -- German
  ('status', 'client_consent.pending.display_name', 'de', 'Ausstehend'),
  ('status', 'client_consent.active.display_name', 'de', 'Aktiv'),
  ('status', 'client_consent.expired.display_name', 'de', 'Abgelaufen'),
  ('status', 'client_consent.revoked.display_name', 'de', 'Widerrufen'),
  ('status', 'client_consent.superseded.display_name', 'de', 'Ersetzt')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES — client_consent descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('status', 'client_consent.pending.description', 'es', 'En espera de confirmacion del cliente'),
  ('status', 'client_consent.active.description', 'es', 'Consentimiento vigente; se permiten referencias'),
  ('status', 'client_consent.expired.description', 'es', 'El consentimiento vencio; se requiere renovacion'),
  ('status', 'client_consent.revoked.description', 'es', 'El cliente retiro su consentimiento'),
  ('status', 'client_consent.superseded.description', 'es', 'Reemplazado por un consentimiento mas reciente'),
  -- Arabic
  ('status', 'client_consent.pending.description', 'ar', 'بانتظار تأكيد العميل'),
  ('status', 'client_consent.active.description', 'ar', 'الموافقة سارية؛ الإحالات مسموحة'),
  ('status', 'client_consent.expired.description', 'ar', 'انتهت صلاحية الموافقة؛ يلزم التجديد'),
  ('status', 'client_consent.revoked.description', 'ar', 'سحب العميل موافقته'),
  ('status', 'client_consent.superseded.description', 'ar', 'تم استبدالها بموافقة أحدث'),
  -- Pashto
  ('status', 'client_consent.pending.description', 'ps', 'د مراجع د تایید په تمه'),
  ('status', 'client_consent.active.description', 'ps', 'موافقت فعاله ده؛ لیږدنې اجازه لري'),
  ('status', 'client_consent.expired.description', 'ps', 'موافقت ختمه شوه؛ نوي ته اړتیا ده'),
  ('status', 'client_consent.revoked.description', 'ps', 'مراجع خپله موافقت بیرته واخیسته'),
  ('status', 'client_consent.superseded.description', 'ps', 'د نوې موافقتې لخوا بدله شوه'),
  -- French
  ('status', 'client_consent.pending.description', 'fr', 'En attente de la confirmation du client'),
  ('status', 'client_consent.active.description', 'fr', 'Consentement en vigueur; les orientations sont autorisees'),
  ('status', 'client_consent.expired.description', 'fr', 'Le consentement a expire; un renouvellement est necessaire'),
  ('status', 'client_consent.revoked.description', 'fr', 'Le client a retire son consentement'),
  ('status', 'client_consent.superseded.description', 'fr', 'Remplace par un consentement plus recent'),
  -- German
  ('status', 'client_consent.pending.description', 'de', 'Warten auf Bestaetigung des Klienten'),
  ('status', 'client_consent.active.description', 'de', 'Zustimmung gueltig; Vermittlungen erlaubt'),
  ('status', 'client_consent.expired.description', 'de', 'Zustimmung abgelaufen; Erneuerung erforderlich'),
  ('status', 'client_consent.revoked.description', 'de', 'Klient hat Zustimmung widerrufen'),
  ('status', 'client_consent.superseded.description', 'de', 'Durch neuere Zustimmung ersetzt')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- CATEGORIES — consent_method
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('category', 'consent_method.verbal.display_name', 'es', 'Verbal'),
  ('category', 'consent_method.written.display_name', 'es', 'Escrito'),
  ('category', 'consent_method.portal.display_name', 'es', 'Portal'),
  -- Arabic
  ('category', 'consent_method.verbal.display_name', 'ar', 'شفهي'),
  ('category', 'consent_method.written.display_name', 'ar', 'خطي'),
  ('category', 'consent_method.portal.display_name', 'ar', 'عبر البوابة'),
  -- Pashto
  ('category', 'consent_method.verbal.display_name', 'ps', 'شفاهي'),
  ('category', 'consent_method.written.display_name', 'ps', 'لیکل شوی'),
  ('category', 'consent_method.portal.display_name', 'ps', 'د پورټال له لارې'),
  -- French
  ('category', 'consent_method.verbal.display_name', 'fr', 'Verbal'),
  ('category', 'consent_method.written.display_name', 'fr', 'Ecrit'),
  ('category', 'consent_method.portal.display_name', 'fr', 'Portail'),
  -- German
  ('category', 'consent_method.verbal.display_name', 'de', 'Muendlich'),
  ('category', 'consent_method.written.display_name', 'de', 'Schriftlich'),
  ('category', 'consent_method.portal.display_name', 'de', 'Portal')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- CATEGORIES — consent_state (on clients)
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('category', 'consent_state.none.display_name', 'es', 'Ninguno'),
  ('category', 'consent_state.pending.display_name', 'es', 'Pendiente'),
  ('category', 'consent_state.active.display_name', 'es', 'Activo'),
  ('category', 'consent_state.expired.display_name', 'es', 'Expirado'),
  ('category', 'consent_state.revoked.display_name', 'es', 'Revocado'),
  -- Arabic
  ('category', 'consent_state.none.display_name', 'ar', 'لا يوجد'),
  ('category', 'consent_state.pending.display_name', 'ar', 'قيد الانتظار'),
  ('category', 'consent_state.active.display_name', 'ar', 'نشط'),
  ('category', 'consent_state.expired.display_name', 'ar', 'منتهي'),
  ('category', 'consent_state.revoked.display_name', 'ar', 'ملغى'),
  -- Pashto
  ('category', 'consent_state.none.display_name', 'ps', 'هیڅ'),
  ('category', 'consent_state.pending.display_name', 'ps', 'په تمه'),
  ('category', 'consent_state.active.display_name', 'ps', 'فعال'),
  ('category', 'consent_state.expired.display_name', 'ps', 'پای ته رسیدلی'),
  ('category', 'consent_state.revoked.display_name', 'ps', 'لغوه شوی'),
  -- French
  ('category', 'consent_state.none.display_name', 'fr', 'Aucun'),
  ('category', 'consent_state.pending.display_name', 'fr', 'En attente'),
  ('category', 'consent_state.active.display_name', 'fr', 'Actif'),
  ('category', 'consent_state.expired.display_name', 'fr', 'Expire'),
  ('category', 'consent_state.revoked.display_name', 'fr', 'Revoque'),
  -- German
  ('category', 'consent_state.none.display_name', 'de', 'Keine'),
  ('category', 'consent_state.pending.display_name', 'de', 'Ausstehend'),
  ('category', 'consent_state.active.display_name', 'de', 'Aktiv'),
  ('category', 'consent_state.expired.display_name', 'de', 'Abgelaufen'),
  ('category', 'consent_state.revoked.display_name', 'de', 'Widerrufen')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — clients.record_consent
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('action', 'clients.record_consent.display_name', 'es', 'Registrar Consentimiento'),
  ('action', 'clients.record_consent.description', 'es', 'Registrar consentimiento verbal, escrito o por portal en nombre del cliente.'),
  ('action', 'clients.record_consent.success_message', 'es', 'Consentimiento registrado exitosamente.'),
  -- Arabic
  ('action', 'clients.record_consent.display_name', 'ar', 'تسجيل الموافقة'),
  ('action', 'clients.record_consent.description', 'ar', 'تسجيل الموافقة الشفهية أو الخطية أو عبر البوابة نيابة عن العميل.'),
  ('action', 'clients.record_consent.success_message', 'ar', 'تم تسجيل الموافقة بنجاح.'),
  -- Pashto
  ('action', 'clients.record_consent.display_name', 'ps', 'موافقت ثبت کول'),
  ('action', 'clients.record_consent.description', 'ps', 'د مراجع په استازیتوب شفاهي، لیکل شوی، یا د پورټال موافقت ثبت کړئ.'),
  ('action', 'clients.record_consent.success_message', 'ps', 'موافقت په بریالیتوب سره ثبت شوه.'),
  -- French
  ('action', 'clients.record_consent.display_name', 'fr', 'Enregistrer le Consentement'),
  ('action', 'clients.record_consent.description', 'fr', 'Enregistrer le consentement verbal, ecrit ou via le portail au nom du client.'),
  ('action', 'clients.record_consent.success_message', 'fr', 'Consentement enregistre avec succes.'),
  -- German
  ('action', 'clients.record_consent.display_name', 'de', 'Zustimmung Erfassen'),
  ('action', 'clients.record_consent.description', 'de', 'Muendliche, schriftliche oder Portal-Zustimmung im Namen des Klienten erfassen.'),
  ('action', 'clients.record_consent.success_message', 'de', 'Zustimmung erfolgreich erfasst.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — clients.request_consent
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('action', 'clients.request_consent.display_name', 'es', 'Solicitar Consentimiento'),
  ('action', 'clients.request_consent.description', 'es', 'Enviar al cliente una solicitud de consentimiento por correo electronico.'),
  ('action', 'clients.request_consent.confirmation_message', 'es', 'Enviar a este cliente una solicitud de consentimiento por correo electronico?'),
  ('action', 'clients.request_consent.success_message', 'es', 'Solicitud de consentimiento enviada.'),
  -- Arabic
  ('action', 'clients.request_consent.display_name', 'ar', 'طلب الموافقة'),
  ('action', 'clients.request_consent.description', 'ar', 'إرسال طلب موافقة للعميل عبر البريد الإلكتروني.'),
  ('action', 'clients.request_consent.confirmation_message', 'ar', 'هل تريد إرسال طلب موافقة لهذا العميل عبر البريد الإلكتروني؟'),
  ('action', 'clients.request_consent.success_message', 'ar', 'تم إرسال طلب الموافقة.'),
  -- Pashto
  ('action', 'clients.request_consent.display_name', 'ps', 'د موافقت غوښتنه'),
  ('action', 'clients.request_consent.description', 'ps', 'مراجع ته د بریښنالیک له لارې د موافقت غوښتنه واستوئ.'),
  ('action', 'clients.request_consent.confirmation_message', 'ps', 'دې مراجع ته د بریښنالیک له لارې د موافقت غوښتنه واستول شي؟'),
  ('action', 'clients.request_consent.success_message', 'ps', 'د موافقت غوښتنه واستول شوه.'),
  -- French
  ('action', 'clients.request_consent.display_name', 'fr', 'Demander le Consentement'),
  ('action', 'clients.request_consent.description', 'fr', 'Envoyer au client une demande de consentement par courriel.'),
  ('action', 'clients.request_consent.confirmation_message', 'fr', 'Envoyer une demande de consentement a ce client par courriel?'),
  ('action', 'clients.request_consent.success_message', 'fr', 'Demande de consentement envoyee.'),
  -- German
  ('action', 'clients.request_consent.display_name', 'de', 'Zustimmung Anfordern'),
  ('action', 'clients.request_consent.description', 'de', 'Dem Klienten eine Zustimmungsanfrage per E-Mail senden.'),
  ('action', 'clients.request_consent.confirmation_message', 'de', 'Diesem Klienten eine Zustimmungsanfrage per E-Mail senden?'),
  ('action', 'clients.request_consent.success_message', 'de', 'Zustimmungsanfrage gesendet.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTION PARAMS — clients.record_consent
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('action_param', 'clients.record_consent.p_method_id.display_name', 'es', 'Metodo de Consentimiento'),
  ('action_param', 'clients.record_consent.p_granted_date.display_name', 'es', 'Fecha de Otorgamiento'),
  ('action_param', 'clients.record_consent.p_expires_date.display_name', 'es', 'Fecha de Vencimiento'),
  ('action_param', 'clients.record_consent.p_expires_date.placeholder', 'es', 'Por defecto un ano desde la fecha de otorgamiento'),
  ('action_param', 'clients.record_consent.p_evidence.display_name', 'es', 'Evidencia (opcional)'),
  -- Arabic
  ('action_param', 'clients.record_consent.p_method_id.display_name', 'ar', 'طريقة الموافقة'),
  ('action_param', 'clients.record_consent.p_granted_date.display_name', 'ar', 'تاريخ المنح'),
  ('action_param', 'clients.record_consent.p_expires_date.display_name', 'ar', 'تاريخ الانتهاء'),
  ('action_param', 'clients.record_consent.p_expires_date.placeholder', 'ar', 'الافتراضي سنة واحدة من تاريخ المنح'),
  ('action_param', 'clients.record_consent.p_evidence.display_name', 'ar', 'الدليل (اختياري)'),
  -- Pashto
  ('action_param', 'clients.record_consent.p_method_id.display_name', 'ps', 'د موافقت طریقه'),
  ('action_param', 'clients.record_consent.p_granted_date.display_name', 'ps', 'د ورکولو نیټه'),
  ('action_param', 'clients.record_consent.p_expires_date.display_name', 'ps', 'د ختمیدو نیټه'),
  ('action_param', 'clients.record_consent.p_expires_date.placeholder', 'ps', 'د ورکولو نیټې څخه یو کال وروسته'),
  ('action_param', 'clients.record_consent.p_evidence.display_name', 'ps', 'شواهد (اختیاري)'),
  -- French
  ('action_param', 'clients.record_consent.p_method_id.display_name', 'fr', 'Methode de Consentement'),
  ('action_param', 'clients.record_consent.p_granted_date.display_name', 'fr', 'Date d''Octroi'),
  ('action_param', 'clients.record_consent.p_expires_date.display_name', 'fr', 'Date d''Expiration'),
  ('action_param', 'clients.record_consent.p_expires_date.placeholder', 'fr', 'Par defaut un an apres la date d''octroi'),
  ('action_param', 'clients.record_consent.p_evidence.display_name', 'fr', 'Justificatif (optionnel)'),
  -- German
  ('action_param', 'clients.record_consent.p_method_id.display_name', 'de', 'Zustimmungsmethode'),
  ('action_param', 'clients.record_consent.p_granted_date.display_name', 'de', 'Erteilungsdatum'),
  ('action_param', 'clients.record_consent.p_expires_date.display_name', 'de', 'Ablaufdatum'),
  ('action_param', 'clients.record_consent.p_expires_date.placeholder', 'de', 'Standard ein Jahr ab Erteilungsdatum'),
  ('action_param', 'clients.record_consent.p_evidence.display_name', 'de', 'Nachweis (optional)')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- DASHBOARD WIDGET — "Consents Expiring" title (widget added by script 27)
-- ============================================================================
-- The widget ID is dynamic, so we look it up by title + dashboard name.
DO $$
DECLARE
  v_widget_id INT;
BEGIN
  SELECT dw.id INTO v_widget_id
  FROM metadata.dashboard_widgets dw
  JOIN metadata.dashboards d ON d.id = dw.dashboard_id
  WHERE d.display_name = 'ECS Intake Dashboard'
    AND dw.title = 'Consents Expiring';

  IF v_widget_id IS NOT NULL THEN
    INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
      ('dashboard', 'dashboard.2.widget.' || v_widget_id || '.title', 'es', 'Consentimientos por Vencer'),
      ('dashboard', 'dashboard.2.widget.' || v_widget_id || '.title', 'ar', 'موافقات قاربت على الانتهاء'),
      ('dashboard', 'dashboard.2.widget.' || v_widget_id || '.title', 'ps', 'موافقتونه چې ډیر ژر ختمیږي'),
      ('dashboard', 'dashboard.2.widget.' || v_widget_id || '.title', 'fr', 'Consentements Expirant Bientot'),
      ('dashboard', 'dashboard.2.widget.' || v_widget_id || '.title', 'de', 'Bald Ablaufende Zustimmungen')
    ON CONFLICT (source_type, source_key, locale) DO NOTHING;
  END IF;
END $$;
