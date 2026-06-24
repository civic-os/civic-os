-- ICGF German (de) Translations
-- Instance-specific metadata translations for the International Center of Greater Flint.
-- Framework UI strings are handled by the core v0-64-1 migration.
-- This script covers: entities, properties, statuses, categories, actions, dashboards, widgets.
--
-- Uses ON CONFLICT DO NOTHING so this script is idempotent.

-- ============================================================================
-- ENTITIES — display names
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('entity', 'clients.display_name', 'de', 'Klient'),
  ('entity', 'partners.display_name', 'de', 'Partner'),
  ('entity', 'referrals.display_name', 'de', 'Vermittlung'),
  ('entity', 'follow_up_surveys.display_name', 'de', 'Nachbefragung'),
  ('entity', 'service_categories.display_name', 'de', 'Dienstleistungskategorie'),
  ('entity', 'monthly_referral_summary.display_name', 'de', 'Monatliche Vermittlungsuebersicht'),
  ('entity', 'client_contact_summary.display_name', 'de', 'Klientenkontaktuebersicht'),
  ('entity', 'top_needs_report.display_name', 'de', 'Bericht der wichtigsten Beduerfnisse'),
  ('entity', 'partner_utilization_report.display_name', 'de', 'Partnerauslastung'),
  ('entity', 'time_lag_report.display_name', 'de', 'Reaktionszeitbericht'),
  ('entity', 'referrals_per_week.display_name', 'de', 'Vermittlungen pro Woche'),
  ('entity', 'client_service_needs.display_name', 'de', 'Dienstleistungsbeduerfnisse des Klienten'),
  ('entity', 'partner_service_categories.display_name', 'de', 'Dienstleistungskategorien des Partners'),
  ('entity', 'referral_service_categories.display_name', 'de', 'Dienstleistungskategorien der Vermittlung')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITIES — descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('entity', 'clients.description', 'de', 'Mitglieder der Einwanderer- und Fluechtlingsgemeinschaft, die Dienstleistungen suchen'),
  ('entity', 'partners.description', 'de', 'Dienstleistungsanbieter-Organisationen und Einzelpersonen'),
  ('entity', 'referrals.description', 'de', 'Vermittlungsdatensaetze von Klienten an Partner'),
  ('entity', 'follow_up_surveys.description', 'de', 'Feedback-Umfragen nach der Vermittlung'),
  ('entity', 'service_categories.description', 'de', 'Verfuegbare Dienstleistungsarten fuer Klienten und Partner'),
  ('entity', 'monthly_referral_summary.description', 'de', 'Vermittlungsvolumen, -arten und Abschlussraten pro Monat'),
  ('entity', 'client_contact_summary.description', 'de', 'Neue Klientenregistrierungen nach Monat, Land und Sprache'),
  ('entity', 'top_needs_report.description', 'de', 'Nachfrage nach Dienstleistungskategorien unter aktiven Klienten'),
  ('entity', 'partner_utilization_report.description', 'de', 'Vermittlungsvolumen und Abschlussraten pro Partner'),
  ('entity', 'time_lag_report.description', 'de', 'Aufschluesselung der Kontaktzeit nach Vermittlungsart und Partner')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — clients
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'clients.id.display_name', 'de', 'Id'),
  ('property', 'clients.first_name.display_name', 'de', 'Vorname'),
  ('property', 'clients.last_name.display_name', 'de', 'Nachname'),
  ('property', 'clients.display_name.display_name', 'de', 'Vollstaendiger Name'),
  ('property', 'clients.email.display_name', 'de', 'E-Mail'),
  ('property', 'clients.phone.display_name', 'de', 'Telefon'),
  ('property', 'clients.date_of_birth.display_name', 'de', 'Geburtsdatum'),
  ('property', 'clients.gender_id.display_name', 'de', 'Geschlecht'),
  ('property', 'clients.country_of_origin.display_name', 'de', 'Herkunftsland'),
  ('property', 'clients.primary_language.display_name', 'de', 'Hauptsprache'),
  ('property', 'clients.preferred_comm_language.display_name', 'de', 'Bevorzugte Kommunikationssprache'),
  ('property', 'clients.date_of_arrival.display_name', 'de', 'Ankunftsdatum in den USA'),
  ('property', 'clients.immigration_status_id.display_name', 'de', 'Einwanderungsstatus'),
  ('property', 'clients.household_size.display_name', 'de', 'Haushaltsgroesse'),
  ('property', 'clients.status_id.display_name', 'de', 'Status'),
  ('property', 'clients.user_id.display_name', 'de', 'Verknuepftes Benutzerkonto'),
  ('property', 'clients.created_at.display_name', 'de', 'Registriert'),
  ('property', 'clients.created_by.display_name', 'de', 'Erstellt von'),
  ('property', 'clients.updated_at.display_name', 'de', 'Aktualisiert'),
  ('property', 'clients.search_vector.display_name', 'de', 'Suchindex')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — partners
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'partners.id.display_name', 'de', 'Id'),
  ('property', 'partners.display_name.display_name', 'de', 'Organisationsname'),
  ('property', 'partners.partner_type_id.display_name', 'de', 'Typ'),
  ('property', 'partners.contact_name.display_name', 'de', 'Kontaktperson'),
  ('property', 'partners.email.display_name', 'de', 'E-Mail'),
  ('property', 'partners.phone.display_name', 'de', 'Telefon'),
  ('property', 'partners.address.display_name', 'de', 'Adresse'),
  ('property', 'partners.location.display_name', 'de', 'Kartenstandort'),
  ('property', 'partners.website.display_name', 'de', 'Webseite'),
  ('property', 'partners.location_text.display_name', 'de', 'Standorttext'),
  ('property', 'partners.languages_supported.display_name', 'de', 'Verfuegbare Sprachen'),
  ('property', 'partners.capacity_notes.display_name', 'de', 'Kapazitaets- / Verfuegbarkeitshinweise'),
  ('property', 'partners.description.display_name', 'de', 'Beschreibung'),
  ('property', 'partners.active.display_name', 'de', 'Aktiv'),
  ('property', 'partners.updated_at.display_name', 'de', 'Aktualisiert'),
  ('property', 'partners.created_at.display_name', 'de', 'Hinzugefuegt'),
  ('property', 'partners.search_vector.display_name', 'de', 'Suchindex')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — referrals
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'referrals.display_name.display_name', 'de', 'Vermittlung'),
  ('property', 'referrals.id.display_name', 'de', 'Id'),
  ('property', 'referrals.client_id.display_name', 'de', 'Klient'),
  ('property', 'referrals.partner_id.display_name', 'de', 'Partner'),
  ('property', 'referrals.referral_type_id.display_name', 'de', 'Typ'),
  ('property', 'referrals.referral_date.display_name', 'de', 'Vermittlungsdatum'),
  ('property', 'referrals.referred_by.display_name', 'de', 'Vermittelt von'),
  ('property', 'referrals.status_id.display_name', 'de', 'Status'),
  ('property', 'referrals.outcome_notes.display_name', 'de', 'Ergebnisnotizen'),
  ('property', 'referrals.completed_date.display_name', 'de', 'Abschlussdatum'),
  ('property', 'referrals.updated_at.display_name', 'de', 'Aktualisiert'),
  ('property', 'referrals.created_at.display_name', 'de', 'Erstellt')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — follow_up_surveys
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'follow_up_surveys.display_name.display_name', 'de', 'Umfrage'),
  ('property', 'follow_up_surveys.id.display_name', 'de', 'Id'),
  ('property', 'follow_up_surveys.referral_id.display_name', 'de', 'Vermittlung'),
  ('property', 'follow_up_surveys.status_id.display_name', 'de', 'Status'),
  ('property', 'follow_up_surveys.helpfulness_id.display_name', 'de', 'War die Verbindung zum Partner hilfreich?'),
  ('property', 'follow_up_surveys.time_to_contact_id.display_name', 'de', 'Wie lange dauerte die Kontaktaufnahme mit dem Partner?'),
  ('property', 'follow_up_surveys.outcome_id.display_name', 'de', 'Was war das Ergebnis mit dem Partner?'),
  ('property', 'follow_up_surveys.open_feedback.display_name', 'de', 'Weitere Anmerkungen'),
  ('property', 'follow_up_surveys.completed_date.display_name', 'de', 'Abschlussdatum'),
  ('property', 'follow_up_surveys.updated_at.display_name', 'de', 'Aktualisiert'),
  ('property', 'follow_up_surveys.created_at.display_name', 'de', 'Erstellt')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — service_categories
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'service_categories.display_name.display_name', 'de', 'Kategoriename'),
  ('property', 'service_categories.id.display_name', 'de', 'Id'),
  ('property', 'service_categories.description.display_name', 'de', 'Beschreibung'),
  ('property', 'service_categories.color.display_name', 'de', 'Farbe'),
  ('property', 'service_categories.active.display_name', 'de', 'Aktiv'),
  ('property', 'service_categories.sort_order.display_name', 'de', 'Anzeigereihenfolge'),
  ('property', 'service_categories.created_at.display_name', 'de', 'Erstellt'),
  ('property', 'service_categories.updated_at.display_name', 'de', 'Aktualisiert')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — report views
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'client_contact_summary.month.display_name', 'de', 'Monat'),
  ('property', 'client_contact_summary.new_clients.display_name', 'de', 'Neue Klienten'),
  ('property', 'client_contact_summary.intake_pending.display_name', 'de', 'Aufnahme ausstehend'),
  ('property', 'client_contact_summary.active_clients.display_name', 'de', 'Aktive'),
  ('property', 'client_contact_summary.country_of_origin.display_name', 'de', 'Herkunftsland'),
  ('property', 'client_contact_summary.primary_language.display_name', 'de', 'Hauptsprache'),
  ('property', 'monthly_referral_summary.month.display_name', 'de', 'Monat'),
  ('property', 'monthly_referral_summary.total_referrals.display_name', 'de', 'Gesamt'),
  ('property', 'monthly_referral_summary.warm_referrals.display_name', 'de', 'Direkte'),
  ('property', 'monthly_referral_summary.info_referrals.display_name', 'de', 'Informativ'),
  ('property', 'monthly_referral_summary.completed.display_name', 'de', 'Abgeschlossen'),
  ('property', 'monthly_referral_summary.not_completed.display_name', 'de', 'Nicht abgeschlossen'),
  ('property', 'monthly_referral_summary.open_referrals.display_name', 'de', 'Offen'),
  ('property', 'monthly_referral_summary.completion_rate_pct.display_name', 'de', 'Abschlussrate'),
  ('property', 'partner_utilization_report.partner_name.display_name', 'de', 'Partner'),
  ('property', 'partner_utilization_report.partner_active.display_name', 'de', 'Aktiv'),
  ('property', 'partner_utilization_report.referral_count.display_name', 'de', 'Vermittlungen'),
  ('property', 'partner_utilization_report.completed.display_name', 'de', 'Abgeschlossen'),
  ('property', 'partner_utilization_report.completion_rate_pct.display_name', 'de', 'Abschlussrate'),
  ('property', 'partner_utilization_report.service_categories.display_name', 'de', 'Dienstleistungen'),
  ('property', 'time_lag_report.referral_type.display_name', 'de', 'Vermittlungsart'),
  ('property', 'time_lag_report.partner_name.display_name', 'de', 'Partner'),
  ('property', 'time_lag_report.time_to_contact.display_name', 'de', 'Kontaktzeit'),
  ('property', 'time_lag_report.response_count.display_name', 'de', 'Antworten'),
  ('property', 'top_needs_report.service_category.display_name', 'de', 'Dienstleistungskategorie'),
  ('property', 'top_needs_report.color.display_name', 'de', 'Farbe'),
  ('property', 'top_needs_report.client_count.display_name', 'de', 'Anzahl der Klienten'),
  ('property', 'top_needs_report.pct_of_active_clients.display_name', 'de', '% der aktiven Klienten'),
  ('property', 'referrals_per_week.week_start.display_name', 'de', 'Wochenbeginn'),
  ('property', 'referrals_per_week.week_label.display_name', 'de', 'Wochenbezeichnung'),
  ('property', 'referrals_per_week.total_referrals.display_name', 'de', 'Vermittlungen gesamt'),
  ('property', 'referrals_per_week.poor_outcome_referrals.display_name', 'de', 'Vermittlungen mit schlechtem Ergebnis')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — junction tables (M:M)
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'client_service_needs.client_id.display_name', 'de', 'Klienten-Id'),
  ('property', 'client_service_needs.service_category_id.display_name', 'de', 'Dienstleistungskategorie-Id'),
  ('property', 'partner_service_categories.partner_id.display_name', 'de', 'Partner-Id'),
  ('property', 'partner_service_categories.service_category_id.display_name', 'de', 'Dienstleistungskategorie-Id'),
  ('property', 'referral_service_categories.referral_id.display_name', 'de', 'Vermittlungs-Id'),
  ('property', 'referral_service_categories.service_category_id.display_name', 'de', 'Dienstleistungskategorie-Id')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES — display names
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('status', 'client.intake_pending.display_name', 'de', 'Aufnahme ausstehend'),
  ('status', 'client.active.display_name', 'de', 'Aktiv'),
  ('status', 'client.inactive.display_name', 'de', 'Inaktiv'),
  ('status', 'guided_form.draft.display_name', 'de', 'Entwurf'),
  ('status', 'guided_form.complete.display_name', 'de', 'Abgeschlossen'),
  ('status', 'guided_form.submitted.display_name', 'de', 'Eingereicht'),
  ('status', 'referral.referred.display_name', 'de', 'Vermittelt'),
  ('status', 'referral.completed.display_name', 'de', 'Abgeschlossen'),
  ('status', 'referral.not_completed.display_name', 'de', 'Nicht abgeschlossen'),
  ('status', 'survey.pending.display_name', 'de', 'Ausstehend'),
  ('status', 'survey.completed.display_name', 'de', 'Abgeschlossen'),
  ('status', 'survey.expired.display_name', 'de', 'Abgelaufen')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES — descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('status', 'client.intake_pending.description', 'de', 'Wartet auf Bewertung durch das Personal'),
  ('status', 'client.active.description', 'de', 'Bewertet und erhaelt aktiv Dienstleistungen'),
  ('status', 'client.inactive.description', 'de', 'Nimmt nicht mehr teil oder ist umgezogen'),
  ('status', 'referral.referred.description', 'de', 'Vermittlung erstellt, wartet auf Ergebnis'),
  ('status', 'referral.completed.description', 'de', 'Klient erfolgreich mit Partner verbunden'),
  ('status', 'referral.not_completed.description', 'de', 'Klient konnte nicht verbunden werden oder Vermittlung gescheitert'),
  ('status', 'survey.pending.description', 'de', 'Wartet auf Antwort des Klienten'),
  ('status', 'survey.completed.description', 'de', 'Klient hat die Umfrage abgeschlossen'),
  ('status', 'survey.expired.description', 'de', 'Keine Antwort nach allen Erinnerungen')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- CATEGORIES
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('category', 'gender.male.display_name', 'de', 'Maennlich'),
  ('category', 'gender.female.display_name', 'de', 'Weiblich'),
  ('category', 'gender.non_binary.display_name', 'de', 'Nicht-binaer'),
  ('category', 'gender.prefer_not_to_say.display_name', 'de', 'Keine Angabe'),
  ('category', 'helpfulness.very_helpful.display_name', 'de', 'Sehr hilfreich'),
  ('category', 'helpfulness.somewhat_helpful.display_name', 'de', 'Etwas hilfreich'),
  ('category', 'helpfulness.not_helpful.display_name', 'de', 'Nicht hilfreich'),
  ('category', 'helpfulness.could_not_contact.display_name', 'de', 'Kontakt nicht moeglich'),
  ('category', 'immigration_status.refugee.display_name', 'de', 'Fluechtling'),
  ('category', 'immigration_status.asylee.display_name', 'de', 'Asylberechtigte(r)'),
  ('category', 'immigration_status.siv.display_name', 'de', 'Spezialvisum fuer Einwanderer'),
  ('category', 'immigration_status.permanent_resident.display_name', 'de', 'Dauerhaft Aufenthaltsberechtigte(r)'),
  ('category', 'immigration_status.citizen.display_name', 'de', 'Staatsbuerger(in)'),
  ('category', 'immigration_status.other.display_name', 'de', 'Sonstiges/Unbekannt'),
  ('category', 'outcome.enrolled.display_name', 'de', 'In Dienstleistungen eingeschrieben'),
  ('category', 'outcome.received_info.display_name', 'de', 'Informationen erhalten'),
  ('category', 'outcome.referred_elsewhere.display_name', 'de', 'Anderweitig vermittelt'),
  ('category', 'outcome.no_action.display_name', 'de', 'Keine Massnahme ergriffen'),
  ('category', 'outcome.other.display_name', 'de', 'Sonstiges'),
  ('category', 'partner_type.organization.display_name', 'de', 'Organisation'),
  ('category', 'partner_type.individual.display_name', 'de', 'Einzelperson'),
  ('category', 'referral_type.warm.display_name', 'de', 'Persoenliche Vorstellung'),
  ('category', 'referral_type.info.display_name', 'de', 'Partnerinformation'),
  ('category', 'time_to_contact.same_day.display_name', 'de', 'Am selben Tag'),
  ('category', 'time_to_contact.1_2_days.display_name', 'de', '1-2 Tage'),
  ('category', 'time_to_contact.3_5_days.display_name', 'de', '3-5 Tage'),
  ('category', 'time_to_contact.more_than_5_days.display_name', 'de', 'Mehr als 5 Tage'),
  ('category', 'time_to_contact.unable_to_contact.display_name', 'de', 'Kontakt nicht moeglich')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — clients
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action', 'clients.activate.display_name', 'de', 'Klient aktivieren'),
  ('action', 'clients.activate.description', 'de', 'Bewertung abgeschlossen — Wechsel zu Aktiv'),
  ('action', 'clients.activate.confirmation_message', 'de', 'Diesen Klienten aktivieren? Dies bestaetigt, dass die Aufnahmebewertung abgeschlossen ist.'),
  ('action', 'clients.activate.success_message', 'de', 'Klient erfolgreich aktiviert.'),
  ('action', 'clients.reactivate.display_name', 'de', 'Klient reaktivieren'),
  ('action', 'clients.reactivate.description', 'de', 'Inaktiven Klienten in den aktiven Status zurueckversetzen'),
  ('action', 'clients.reactivate.confirmation_message', 'de', 'Diesen Klienten reaktivieren?'),
  ('action', 'clients.reactivate.success_message', 'de', 'Klient reaktiviert.'),
  ('action', 'clients.refer.display_name', 'de', 'Klient vermitteln'),
  ('action', 'clients.refer.description', 'de', 'Vermittlung an einen Dienstleistungspartner erstellen'),
  ('action', 'clients.refer.success_message', 'de', 'Vermittlung erfolgreich erstellt.'),
  ('action', 'clients.deactivate.display_name', 'de', 'Klient deaktivieren'),
  ('action', 'clients.deactivate.description', 'de', 'Klient als nicht mehr aktiv markieren'),
  ('action', 'clients.deactivate.confirmation_message', 'de', 'Diesen Klienten deaktivieren? Sein Vermittlungsverlauf bleibt erhalten.'),
  ('action', 'clients.deactivate.success_message', 'de', 'Klient deaktiviert.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — referrals
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action', 'referrals.complete.display_name', 'de', 'Als abgeschlossen markieren'),
  ('action', 'referrals.complete.description', 'de', 'Klient erfolgreich mit Partner verbunden'),
  ('action', 'referrals.complete.confirmation_message', 'de', 'Diese Vermittlung als abgeschlossen markieren?'),
  ('action', 'referrals.complete.success_message', 'de', 'Vermittlung als abgeschlossen markiert.'),
  ('action', 'referrals.not_completed.display_name', 'de', 'Als nicht abgeschlossen markieren'),
  ('action', 'referrals.not_completed.description', 'de', 'Klient konnte nicht verbunden werden oder Vermittlung gescheitert'),
  ('action', 'referrals.not_completed.success_message', 'de', 'Vermittlung als nicht abgeschlossen markiert.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTION PARAMS
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action_param', 'clients.refer.p_partner_id.display_name', 'de', 'Partner'),
  ('action_param', 'clients.refer.p_referral_type_id.display_name', 'de', 'Vermittlungsart'),
  ('action_param', 'clients.refer.p_referral_date.display_name', 'de', 'Vermittlungsdatum'),
  ('action_param', 'referrals.not_completed.p_outcome_notes.display_name', 'de', 'Ergebnisnotizen'),
  ('action_param', 'referrals.not_completed.p_outcome_notes.placeholder', 'de', 'Erlaeutern Sie, warum die Vermittlung nicht abgeschlossen wurde...')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- DASHBOARDS
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('dashboard', 'dashboard.1.display_name', 'de', 'Willkommen beim ICGF'),
  ('dashboard', 'dashboard.1.description', 'de', 'Oeffentliche Seite des Internationalen Zentrums von Greater Flint'),
  ('dashboard', 'dashboard.2.display_name', 'de', 'ICGF Aufnahme-Dashboard'),
  ('dashboard', 'dashboard.2.description', 'de', 'Klientenaufnahme, Vermittlungen und Umfrageverfolgung')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- DASHBOARD WIDGET TITLES
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('dashboard', 'dashboard.2.widget.2.title', 'de', 'Aufnahme ausstehend'),
  ('dashboard', 'dashboard.2.widget.3.title', 'de', 'Offene Vermittlungen'),
  ('dashboard', 'dashboard.2.widget.4.title', 'de', 'Ausstehende Umfragen'),
  ('dashboard', 'dashboard.2.widget.7.title', 'de', 'Vermittlungen pro Woche'),
  ('dashboard', 'dashboard.2.widget.5.title', 'de', 'Partnerstandorte')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- WIDGET CONFIG — Welcome page markdown content
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('widget_config', 'dashboard.1.widget.1.content', 'de',
'# Internationales Zentrum von Greater Flint

Das Internationale Zentrum von Greater Flint (ICGF) verbindet Einwanderer, Fluechtlinge und Gemeindemitglieder mit wesentlichen Dienstleistungen im Genesee County.

## Unsere Dienstleistungen

- **Klientenaufnahme und Bewertung** — Umfassende Bedarfsermittlung fuer Neuankoemmlinge und Gemeindemitglieder
- **Vermittlungen** — Personalisierte und informative Vermittlungen an ueberprueefte lokale Dienstleistungspartner
- **Nachverfolgung** — Umfragebasierte Ergebnisverfolgung zur Sicherstellung erfolgreicher Verbindungen

## Partnernetzwerk

Wir koordinieren mit einem Netzwerk lokaler Organisationen, die Folgendes anbieten:

- Englisch als Zweitsprache (ESL) Kurse
- Rechts- und Einwanderungshilfe
- Beschaeftigung und Stellenvermittlung
- Bildung und Berufsausbildung
- Gesundheits- und medizinische Dienste
- Wohnungshilfe
- Transport
- Uebersetzung und Dolmetschen
- Kinderbetreuung und Jugendprogramme
- Finanzbildung und Leistungsberatung

## Kontakt

**Internationales Zentrum von Greater Flint**
519 S. Saginaw St., Suite 104, Flint, MI 48502
Telefon: (810) 235-2596
Web: [icgflint.org](https://icgflint.org)

---

*Mitarbeiter: Bitte melden Sie sich an, um auf das Aufnahme-Dashboard und die Klientenverwaltungstools zuzugreifen.*')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;
