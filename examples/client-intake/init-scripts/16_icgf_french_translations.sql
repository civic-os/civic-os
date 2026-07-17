-- ECS French (fr) Translations
-- Instance-specific metadata translations for Exemplary Community Services.
-- Framework UI strings are handled by the core v0-64-1 migration.
-- This script covers: entities, properties, statuses, categories, actions, dashboards, widgets.
--
-- Uses ON CONFLICT DO NOTHING so this script is idempotent.

-- ============================================================================
-- ENTITIES — display names
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('entity', 'clients.display_name', 'fr', 'Client'),
  ('entity', 'partners.display_name', 'fr', 'Partenaire'),
  ('entity', 'referrals.display_name', 'fr', 'Orientation'),
  ('entity', 'follow_up_surveys.display_name', 'fr', 'Enquete de suivi'),
  ('entity', 'service_categories.display_name', 'fr', 'Categorie de service'),
  ('entity', 'monthly_referral_summary.display_name', 'fr', 'Resume mensuel des orientations'),
  ('entity', 'client_contact_summary.display_name', 'fr', 'Resume des contacts clients'),
  ('entity', 'top_needs_report.display_name', 'fr', 'Rapport des besoins principaux'),
  ('entity', 'partner_utilization_report.display_name', 'fr', 'Utilisation des partenaires'),
  ('entity', 'time_lag_report.display_name', 'fr', 'Rapport de delai de reponse'),
  ('entity', 'referrals_per_week.display_name', 'fr', 'Orientations par semaine'),
  ('entity', 'client_service_needs.display_name', 'fr', 'Besoins de service du client'),
  ('entity', 'partner_service_categories.display_name', 'fr', 'Categories de service du partenaire'),
  ('entity', 'referral_service_categories.display_name', 'fr', 'Categories de service de l''orientation')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITIES — descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('entity', 'clients.description', 'fr', 'Membres de la communaute recherchant des services et programmes de soutien'),
  ('entity', 'partners.description', 'fr', 'Organisations et individus fournisseurs de services'),
  ('entity', 'referrals.description', 'fr', 'Enregistrements d''orientation des clients vers les partenaires'),
  ('entity', 'follow_up_surveys.description', 'fr', 'Enquetes de retour d''experience apres orientation'),
  ('entity', 'service_categories.description', 'fr', 'Types de services disponibles pour les clients et partenaires'),
  ('entity', 'monthly_referral_summary.description', 'fr', 'Volume, types et taux de completion des orientations par mois'),
  ('entity', 'client_contact_summary.description', 'fr', 'Nouvelles inscriptions de clients et statut d''accueil par mois'),
  ('entity', 'top_needs_report.description', 'fr', 'Demande de categories de service parmi les clients actifs'),
  ('entity', 'partner_utilization_report.description', 'fr', 'Volume d''orientations et taux de completion par partenaire'),
  ('entity', 'time_lag_report.description', 'fr', 'Detail du delai de contact par type d''orientation et partenaire')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — clients
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'clients.id.display_name', 'fr', 'Id'),
  ('property', 'clients.first_name.display_name', 'fr', 'Prenom'),
  ('property', 'clients.last_name.display_name', 'fr', 'Nom de famille'),
  ('property', 'clients.display_name.display_name', 'fr', 'Nom complet'),
  ('property', 'clients.email.display_name', 'fr', 'E-mail'),
  ('property', 'clients.phone.display_name', 'fr', 'Telephone'),
  ('property', 'clients.date_of_birth.display_name', 'fr', 'Date de naissance'),
  ('property', 'clients.gender_id.display_name', 'fr', 'Genre'),
  ('property', 'clients.preferred_comm_language.display_name', 'fr', 'Langue de communication preferee'),
  ('property', 'clients.household_size.display_name', 'fr', 'Taille du menage'),
  ('property', 'clients.status_id.display_name', 'fr', 'Statut'),
  ('property', 'clients.user_id.display_name', 'fr', 'Compte utilisateur lie'),
  ('property', 'clients.created_at.display_name', 'fr', 'Inscrit le'),
  ('property', 'clients.created_by.display_name', 'fr', 'Cree par'),
  ('property', 'clients.updated_at.display_name', 'fr', 'Mis a jour'),
  ('property', 'clients.search_vector.display_name', 'fr', 'Index de recherche')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — partners
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'partners.id.display_name', 'fr', 'Id'),
  ('property', 'partners.display_name.display_name', 'fr', 'Nom de l''organisation'),
  ('property', 'partners.partner_type_id.display_name', 'fr', 'Type'),
  ('property', 'partners.contact_name.display_name', 'fr', 'Personne de contact'),
  ('property', 'partners.email.display_name', 'fr', 'E-mail'),
  ('property', 'partners.phone.display_name', 'fr', 'Telephone'),
  ('property', 'partners.address.display_name', 'fr', 'Adresse'),
  ('property', 'partners.location.display_name', 'fr', 'Emplacement sur la carte'),
  ('property', 'partners.website.display_name', 'fr', 'Site web'),
  ('property', 'partners.location_text.display_name', 'fr', 'Texte de localisation'),
  ('property', 'partners.languages_supported.display_name', 'fr', 'Langues disponibles'),
  ('property', 'partners.capacity_notes.display_name', 'fr', 'Notes de capacite / disponibilite'),
  ('property', 'partners.description.display_name', 'fr', 'Description'),
  ('property', 'partners.active.display_name', 'fr', 'Actif'),
  ('property', 'partners.updated_at.display_name', 'fr', 'Mis a jour'),
  ('property', 'partners.created_at.display_name', 'fr', 'Ajoute le'),
  ('property', 'partners.search_vector.display_name', 'fr', 'Index de recherche')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — referrals
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'referrals.display_name.display_name', 'fr', 'Orientation'),
  ('property', 'referrals.id.display_name', 'fr', 'Id'),
  ('property', 'referrals.client_id.display_name', 'fr', 'Client'),
  ('property', 'referrals.partner_id.display_name', 'fr', 'Partenaire'),
  ('property', 'referrals.referral_type_id.display_name', 'fr', 'Type'),
  ('property', 'referrals.referral_date.display_name', 'fr', 'Date d''orientation'),
  ('property', 'referrals.referred_by.display_name', 'fr', 'Oriente par'),
  ('property', 'referrals.status_id.display_name', 'fr', 'Statut'),
  ('property', 'referrals.outcome_notes.display_name', 'fr', 'Notes de resultat'),
  ('property', 'referrals.completed_date.display_name', 'fr', 'Date de completion'),
  ('property', 'referrals.updated_at.display_name', 'fr', 'Mis a jour'),
  ('property', 'referrals.created_at.display_name', 'fr', 'Cree le')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — follow_up_surveys
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'follow_up_surveys.display_name.display_name', 'fr', 'Enquete'),
  ('property', 'follow_up_surveys.id.display_name', 'fr', 'Id'),
  ('property', 'follow_up_surveys.referral_id.display_name', 'fr', 'Orientation'),
  ('property', 'follow_up_surveys.status_id.display_name', 'fr', 'Statut'),
  ('property', 'follow_up_surveys.helpfulness_id.display_name', 'fr', 'La mise en relation avec le partenaire a-t-elle ete utile ?'),
  ('property', 'follow_up_surveys.time_to_contact_id.display_name', 'fr', 'Combien de temps pour contacter le partenaire ?'),
  ('property', 'follow_up_surveys.outcome_id.display_name', 'fr', 'Quel a ete le resultat avec le partenaire ?'),
  ('property', 'follow_up_surveys.open_feedback.display_name', 'fr', 'Commentaires supplementaires'),
  ('property', 'follow_up_surveys.completed_date.display_name', 'fr', 'Date de completion'),
  ('property', 'follow_up_surveys.updated_at.display_name', 'fr', 'Mis a jour'),
  ('property', 'follow_up_surveys.created_at.display_name', 'fr', 'Cree le')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — service_categories
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'service_categories.display_name.display_name', 'fr', 'Nom de la categorie'),
  ('property', 'service_categories.id.display_name', 'fr', 'Id'),
  ('property', 'service_categories.description.display_name', 'fr', 'Description'),
  ('property', 'service_categories.color.display_name', 'fr', 'Couleur'),
  ('property', 'service_categories.active.display_name', 'fr', 'Actif'),
  ('property', 'service_categories.sort_order.display_name', 'fr', 'Ordre d''affichage'),
  ('property', 'service_categories.created_at.display_name', 'fr', 'Cree le'),
  ('property', 'service_categories.updated_at.display_name', 'fr', 'Mis a jour')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — report views
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'client_contact_summary.month.display_name', 'fr', 'Mois'),
  ('property', 'client_contact_summary.new_clients.display_name', 'fr', 'Nouveaux clients'),
  ('property', 'client_contact_summary.intake_pending.display_name', 'fr', 'Accueil en attente'),
  ('property', 'client_contact_summary.active_clients.display_name', 'fr', 'Actifs'),
  ('property', 'monthly_referral_summary.month.display_name', 'fr', 'Mois'),
  ('property', 'monthly_referral_summary.total_referrals.display_name', 'fr', 'Total'),
  ('property', 'monthly_referral_summary.warm_referrals.display_name', 'fr', 'Directes'),
  ('property', 'monthly_referral_summary.info_referrals.display_name', 'fr', 'Informatives'),
  ('property', 'monthly_referral_summary.completed.display_name', 'fr', 'Completees'),
  ('property', 'monthly_referral_summary.not_completed.display_name', 'fr', 'Non completees'),
  ('property', 'monthly_referral_summary.open_referrals.display_name', 'fr', 'Ouvertes'),
  ('property', 'monthly_referral_summary.completion_rate_pct.display_name', 'fr', 'Taux de completion'),
  ('property', 'partner_utilization_report.partner_name.display_name', 'fr', 'Partenaire'),
  ('property', 'partner_utilization_report.partner_active.display_name', 'fr', 'Actif'),
  ('property', 'partner_utilization_report.referral_count.display_name', 'fr', 'Orientations'),
  ('property', 'partner_utilization_report.completed.display_name', 'fr', 'Completees'),
  ('property', 'partner_utilization_report.completion_rate_pct.display_name', 'fr', 'Taux de completion'),
  ('property', 'partner_utilization_report.service_categories.display_name', 'fr', 'Services'),
  ('property', 'time_lag_report.referral_type.display_name', 'fr', 'Type d''orientation'),
  ('property', 'time_lag_report.partner_name.display_name', 'fr', 'Partenaire'),
  ('property', 'time_lag_report.time_to_contact.display_name', 'fr', 'Delai de contact'),
  ('property', 'time_lag_report.response_count.display_name', 'fr', 'Reponses'),
  ('property', 'top_needs_report.service_category.display_name', 'fr', 'Categorie de service'),
  ('property', 'top_needs_report.color.display_name', 'fr', 'Couleur'),
  ('property', 'top_needs_report.client_count.display_name', 'fr', 'Nombre de clients'),
  ('property', 'top_needs_report.pct_of_active_clients.display_name', 'fr', '% de clients actifs'),
  ('property', 'referrals_per_week.week_start.display_name', 'fr', 'Debut de semaine'),
  ('property', 'referrals_per_week.week_label.display_name', 'fr', 'Libelle de semaine'),
  ('property', 'referrals_per_week.total_referrals.display_name', 'fr', 'Total d''orientations'),
  ('property', 'referrals_per_week.poor_outcome_referrals.display_name', 'fr', 'Orientations a resultat defavorable')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — junction tables (M:M)
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'client_service_needs.client_id.display_name', 'fr', 'Id du client'),
  ('property', 'client_service_needs.service_category_id.display_name', 'fr', 'Id de categorie de service'),
  ('property', 'partner_service_categories.partner_id.display_name', 'fr', 'Id du partenaire'),
  ('property', 'partner_service_categories.service_category_id.display_name', 'fr', 'Id de categorie de service'),
  ('property', 'referral_service_categories.referral_id.display_name', 'fr', 'Id de l''orientation'),
  ('property', 'referral_service_categories.service_category_id.display_name', 'fr', 'Id de categorie de service')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES — display names
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('status', 'client.intake_pending.display_name', 'fr', 'Accueil en attente'),
  ('status', 'client.active.display_name', 'fr', 'Actif'),
  ('status', 'client.inactive.display_name', 'fr', 'Inactif'),
  ('status', 'guided_form.draft.display_name', 'fr', 'Brouillon'),
  ('status', 'guided_form.complete.display_name', 'fr', 'Termine'),
  ('status', 'guided_form.submitted.display_name', 'fr', 'Soumis'),
  ('status', 'referral.referred.display_name', 'fr', 'Oriente'),
  ('status', 'referral.completed.display_name', 'fr', 'Complete'),
  ('status', 'referral.not_completed.display_name', 'fr', 'Non complete'),
  ('status', 'survey.pending.display_name', 'fr', 'En attente'),
  ('status', 'survey.completed.display_name', 'fr', 'Completee'),
  ('status', 'survey.expired.display_name', 'fr', 'Expiree')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES — descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('status', 'client.intake_pending.description', 'fr', 'En attente d''evaluation par le personnel'),
  ('status', 'client.active.description', 'fr', 'Evalue et recevant activement des services'),
  ('status', 'client.inactive.description', 'fr', 'Ne participe plus ou a demenage'),
  ('status', 'referral.referred.description', 'fr', 'Orientation creee, en attente de resultat'),
  ('status', 'referral.completed.description', 'fr', 'Client connecte avec succes au partenaire'),
  ('status', 'referral.not_completed.description', 'fr', 'Le client n''a pas pu etre connecte ou orientation echouee'),
  ('status', 'survey.pending.description', 'fr', 'En attente de la reponse du client'),
  ('status', 'survey.completed.description', 'fr', 'Le client a complete l''enquete'),
  ('status', 'survey.expired.description', 'fr', 'Pas de reponse apres tous les rappels')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- CATEGORIES
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('category', 'gender.male.display_name', 'fr', 'Homme'),
  ('category', 'gender.female.display_name', 'fr', 'Femme'),
  ('category', 'gender.non_binary.display_name', 'fr', 'Non-binaire'),
  ('category', 'gender.prefer_not_to_say.display_name', 'fr', 'Prefere ne pas dire'),
  ('category', 'helpfulness.very_helpful.display_name', 'fr', 'Tres utile'),
  ('category', 'helpfulness.somewhat_helpful.display_name', 'fr', 'Assez utile'),
  ('category', 'helpfulness.not_helpful.display_name', 'fr', 'Pas utile'),
  ('category', 'helpfulness.could_not_contact.display_name', 'fr', 'Impossible de contacter'),
  ('category', 'outcome.enrolled.display_name', 'fr', 'Inscrit aux services'),
  ('category', 'outcome.received_info.display_name', 'fr', 'A recu des informations'),
  ('category', 'outcome.referred_elsewhere.display_name', 'fr', 'Oriente ailleurs'),
  ('category', 'outcome.no_action.display_name', 'fr', 'Aucune action prise'),
  ('category', 'outcome.other.display_name', 'fr', 'Autre'),
  ('category', 'partner_type.organization.display_name', 'fr', 'Organisation'),
  ('category', 'partner_type.individual.display_name', 'fr', 'Individuel'),
  ('category', 'referral_type.warm.display_name', 'fr', 'Presentation directe'),
  ('category', 'referral_type.info.display_name', 'fr', 'Information du partenaire'),
  ('category', 'time_to_contact.same_day.display_name', 'fr', 'Le jour meme'),
  ('category', 'time_to_contact.1_2_days.display_name', 'fr', '1-2 jours'),
  ('category', 'time_to_contact.3_5_days.display_name', 'fr', '3-5 jours'),
  ('category', 'time_to_contact.more_than_5_days.display_name', 'fr', 'Plus de 5 jours'),
  ('category', 'time_to_contact.unable_to_contact.display_name', 'fr', 'Impossible de contacter')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — clients
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action', 'clients.activate.display_name', 'fr', 'Activer le client'),
  ('action', 'clients.activate.description', 'fr', 'Evaluation terminee; passage au statut Actif'),
  ('action', 'clients.activate.confirmation_message', 'fr', 'Activer ce client ? Cela confirme que l''evaluation d''accueil est terminee.'),
  ('action', 'clients.activate.success_message', 'fr', 'Client active avec succes.'),
  ('action', 'clients.reactivate.display_name', 'fr', 'Reactiver le client'),
  ('action', 'clients.reactivate.description', 'fr', 'Restaurer un client inactif au statut actif'),
  ('action', 'clients.reactivate.confirmation_message', 'fr', 'Reactiver ce client ?'),
  ('action', 'clients.reactivate.success_message', 'fr', 'Client reactive.'),
  ('action', 'clients.refer.display_name', 'fr', 'Orienter le client'),
  ('action', 'clients.refer.description', 'fr', 'Creer une orientation vers un partenaire de services'),
  ('action', 'clients.refer.success_message', 'fr', 'Orientation creee avec succes.'),
  ('action', 'clients.deactivate.display_name', 'fr', 'Desactiver le client'),
  ('action', 'clients.deactivate.description', 'fr', 'Marquer le client comme inactif'),
  ('action', 'clients.deactivate.confirmation_message', 'fr', 'Desactiver ce client ? Son historique d''orientations sera conserve.'),
  ('action', 'clients.deactivate.success_message', 'fr', 'Client desactive.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — referrals
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action', 'referrals.complete.display_name', 'fr', 'Marquer comme complete'),
  ('action', 'referrals.complete.description', 'fr', 'Client connecte avec succes au partenaire'),
  ('action', 'referrals.complete.confirmation_message', 'fr', 'Marquer cette orientation comme completee ?'),
  ('action', 'referrals.complete.success_message', 'fr', 'Orientation marquee comme completee.'),
  ('action', 'referrals.not_completed.display_name', 'fr', 'Marquer comme non complete'),
  ('action', 'referrals.not_completed.description', 'fr', 'Le client n''a pas pu etre connecte ou orientation echouee'),
  ('action', 'referrals.not_completed.success_message', 'fr', 'Orientation marquee comme non completee.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTION PARAMS
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action_param', 'clients.refer.p_partner_id.display_name', 'fr', 'Partenaire'),
  ('action_param', 'clients.refer.p_referral_type_id.display_name', 'fr', 'Type d''orientation'),
  ('action_param', 'clients.refer.p_referral_date.display_name', 'fr', 'Date d''orientation'),
  ('action_param', 'referrals.not_completed.p_outcome_notes.display_name', 'fr', 'Notes de resultat'),
  ('action_param', 'referrals.not_completed.p_outcome_notes.placeholder', 'fr', 'Expliquez pourquoi l''orientation n''a pas ete completee...')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- DASHBOARDS
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('dashboard', 'dashboard.1.display_name', 'fr', 'Bienvenue ECS'),
  ('dashboard', 'dashboard.1.description', 'fr', 'Page publique des Services Communautaires Exemplaires'),
  ('dashboard', 'dashboard.2.display_name', 'fr', 'Tableau de bord d''accueil ECS'),
  ('dashboard', 'dashboard.2.description', 'fr', 'Accueil des clients, orientations et suivi des enquetes')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- DASHBOARD WIDGET TITLES
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('dashboard', 'dashboard.2.widget.2.title', 'fr', 'Accueil en attente'),
  ('dashboard', 'dashboard.2.widget.3.title', 'fr', 'Orientations ouvertes'),
  ('dashboard', 'dashboard.2.widget.4.title', 'fr', 'Enquetes en attente'),
  ('dashboard', 'dashboard.2.widget.7.title', 'fr', 'Orientations par semaine'),
  ('dashboard', 'dashboard.2.widget.5.title', 'fr', 'Emplacements des partenaires')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- WIDGET CONFIG — Welcome page markdown content
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('widget_config', 'dashboard.1.widget.1.content', 'fr',
'# Services Communautaires Exemplaires

Les Services Communautaires Exemplaires (ECS) mettent en relation les membres de la communaute avec les services essentiels et les programmes de soutien.

## Nos services

- **Accueil et evaluation des clients**: Identification complete des besoins pour les membres de la communaute
- **Orientations**: Orientations personnalisees et informatives vers des partenaires de services locaux verifies
- **Suivi**: Suivi des resultats par enquetes pour assurer des connexions reussies

## Reseau de partenaires

Nous coordonnons avec un reseau d''organisations locales offrant :

- Emploi et placement professionnel
- Education et formation professionnelle
- Services de sante et medicaux
- Assistance au logement
- Transport
- Garde d''enfants et programmes pour les jeunes
- Litteratie financiere et orientation pour les prestations
- Assistance juridique
- Traduction et interpretation

## Contact

**Services Communautaires Exemplaires**
123 Main St., Suite 100, Anytown, US 00000
Telephone : (555) 555-0100
Web : [example.org](https://example.org)

---

*Personnel : veuillez vous connecter pour acceder au tableau de bord d''accueil et aux outils de gestion des clients.*')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;
