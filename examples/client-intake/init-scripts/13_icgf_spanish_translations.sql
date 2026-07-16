-- ECS Spanish Translations
-- Comprehensive Spanish (es) translations for all ECS instance metadata.
-- Framework UI strings (279 keys) are already translated via the v0.57.0 migration.
-- This script covers instance-specific: entities, properties, statuses, categories,
-- entity actions, dashboards, dashboard widgets, and widget content.
--
-- Uses ON CONFLICT DO NOTHING so this script is idempotent.
-- To update an existing translation, use the Translation Admin page (/admin/translations).

-- ============================================================================
-- CLEANUP — Remove stale pothole example translations from v0.57.0 migration
-- These were seeded by the core i18n migration but reference entities that
-- don't exist in the ECS schema (Issue, Bid, Inspector, Tag, WorkPackage, Pot_Hole).
-- ============================================================================
DELETE FROM metadata.translations
WHERE locale = 'es'
AND source_type = 'entity'
AND source_key LIKE ANY(ARRAY[
  'Bid.%', 'Inspector.%', 'Issue.%', 'issue_status_summary.%',
  'Pot_Hole.%', 'Tag.%', 'WorkPackage.%'
]);

DELETE FROM metadata.translations
WHERE locale = 'es'
AND source_type = 'property'
AND source_key LIKE ANY(ARRAY[
  'Bid.%', 'Inspector.%', 'Issue.%', 'Tag.%', 'WorkPackage.%'
]);

DELETE FROM metadata.translations
WHERE locale = 'es'
AND source_type = 'status'
AND source_key LIKE ANY(ARRAY[
  'issue.%', 'work_package.%'
]);

-- ============================================================================
-- ENTITIES — display names
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('entity', 'clients.display_name', 'es', 'Cliente'),
  ('entity', 'partners.display_name', 'es', 'Socio'),
  ('entity', 'referrals.display_name', 'es', 'Referencia'),
  ('entity', 'follow_up_surveys.display_name', 'es', 'Encuesta de Seguimiento'),
  ('entity', 'service_categories.display_name', 'es', 'Categoría de Servicio'),
  ('entity', 'monthly_referral_summary.display_name', 'es', 'Resumen Mensual de Referencias'),
  ('entity', 'client_contact_summary.display_name', 'es', 'Resumen de Contacto de Clientes'),
  ('entity', 'top_needs_report.display_name', 'es', 'Informe de Principales Necesidades'),
  ('entity', 'partner_utilization_report.display_name', 'es', 'Utilización de Socios'),
  ('entity', 'time_lag_report.display_name', 'es', 'Informe de Tiempo de Respuesta'),
  ('entity', 'referrals_per_week.display_name', 'es', 'Referencias por Semana'),
  ('entity', 'client_service_needs.display_name', 'es', 'Necesidades de Servicio del Cliente'),
  ('entity', 'partner_service_categories.display_name', 'es', 'Categorías de Servicio del Socio'),
  ('entity', 'referral_service_categories.display_name', 'es', 'Categorías de Servicio de la Referencia')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITIES — descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('entity', 'clients.description', 'es', 'Miembros de la comunidad que buscan servicios y programas de apoyo'),
  ('entity', 'partners.description', 'es', 'Organizaciones e individuos proveedores de servicios'),
  ('entity', 'referrals.description', 'es', 'Registros de referencias de clientes a socios'),
  ('entity', 'follow_up_surveys.description', 'es', 'Encuestas de retroalimentación post-referencia'),
  ('entity', 'service_categories.description', 'es', 'Tipos de servicios disponibles para clientes y socios'),
  ('entity', 'monthly_referral_summary.description', 'es', 'Volumen de referencias, tipos y tasas de finalización por mes'),
  ('entity', 'client_contact_summary.description', 'es', 'Nuevos registros de clientes y estado de ingreso por mes'),
  ('entity', 'top_needs_report.description', 'es', 'Demanda de categorías de servicio entre la población activa de clientes'),
  ('entity', 'partner_utilization_report.description', 'es', 'Volumen de referencias y tasas de finalización por socio'),
  ('entity', 'time_lag_report.description', 'es', 'Desglose del tiempo de contacto por tipo de referencia y socio')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — clients
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'clients.id.display_name', 'es', 'Id'),
  ('property', 'clients.first_name.display_name', 'es', 'Nombre'),
  ('property', 'clients.last_name.display_name', 'es', 'Apellido'),
  ('property', 'clients.display_name.display_name', 'es', 'Nombre Completo'),
  ('property', 'clients.email.display_name', 'es', 'Correo Electrónico'),
  ('property', 'clients.phone.display_name', 'es', 'Teléfono'),
  ('property', 'clients.date_of_birth.display_name', 'es', 'Fecha de Nacimiento'),
  ('property', 'clients.gender_id.display_name', 'es', 'Género'),
  ('property', 'clients.preferred_comm_language.display_name', 'es', 'Idioma Preferido de Comunicación'),
  ('property', 'clients.household_size.display_name', 'es', 'Tamaño del Hogar'),
  ('property', 'clients.status_id.display_name', 'es', 'Estado'),
  ('property', 'clients.user_id.display_name', 'es', 'Cuenta de Usuario Vinculada'),
  ('property', 'clients.created_at.display_name', 'es', 'Registrado'),
  ('property', 'clients.created_by.display_name', 'es', 'Creado Por'),
  ('property', 'clients.updated_at.display_name', 'es', 'Actualizado'),
  ('property', 'clients.search_vector.display_name', 'es', 'Índice de Búsqueda')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — partners
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'partners.id.display_name', 'es', 'Id'),
  ('property', 'partners.display_name.display_name', 'es', 'Nombre de la Organización'),
  ('property', 'partners.partner_type_id.display_name', 'es', 'Tipo'),
  ('property', 'partners.contact_name.display_name', 'es', 'Persona de Contacto'),
  ('property', 'partners.email.display_name', 'es', 'Correo Electrónico'),
  ('property', 'partners.phone.display_name', 'es', 'Teléfono'),
  ('property', 'partners.address.display_name', 'es', 'Dirección'),
  ('property', 'partners.location.display_name', 'es', 'Ubicación en Mapa'),
  ('property', 'partners.website.display_name', 'es', 'Sitio Web'),
  ('property', 'partners.location_text.display_name', 'es', 'Texto de Ubicación'),
  ('property', 'partners.languages_supported.display_name', 'es', 'Idiomas Disponibles'),
  ('property', 'partners.capacity_notes.display_name', 'es', 'Notas de Capacidad / Disponibilidad'),
  ('property', 'partners.description.display_name', 'es', 'Descripción'),
  ('property', 'partners.active.display_name', 'es', 'Activo'),
  ('property', 'partners.updated_at.display_name', 'es', 'Actualizado'),
  ('property', 'partners.created_at.display_name', 'es', 'Agregado'),
  ('property', 'partners.search_vector.display_name', 'es', 'Índice de Búsqueda')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — referrals
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'referrals.display_name.display_name', 'es', 'Referencia'),
  ('property', 'referrals.id.display_name', 'es', 'Id'),
  ('property', 'referrals.client_id.display_name', 'es', 'Cliente'),
  ('property', 'referrals.partner_id.display_name', 'es', 'Socio'),
  ('property', 'referrals.referral_type_id.display_name', 'es', 'Tipo'),
  ('property', 'referrals.referral_date.display_name', 'es', 'Fecha de Referencia'),
  ('property', 'referrals.referred_by.display_name', 'es', 'Referido Por'),
  ('property', 'referrals.status_id.display_name', 'es', 'Estado'),
  ('property', 'referrals.outcome_notes.display_name', 'es', 'Notas del Resultado'),
  ('property', 'referrals.completed_date.display_name', 'es', 'Fecha de Finalización'),
  ('property', 'referrals.updated_at.display_name', 'es', 'Actualizado'),
  ('property', 'referrals.created_at.display_name', 'es', 'Creado')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — follow_up_surveys
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'follow_up_surveys.display_name.display_name', 'es', 'Encuesta'),
  ('property', 'follow_up_surveys.id.display_name', 'es', 'Id'),
  ('property', 'follow_up_surveys.referral_id.display_name', 'es', 'Referencia'),
  ('property', 'follow_up_surveys.status_id.display_name', 'es', 'Estado'),
  ('property', 'follow_up_surveys.helpfulness_id.display_name', 'es', '¿Fue útil la conexión con el socio?'),
  ('property', 'follow_up_surveys.time_to_contact_id.display_name', 'es', '¿Cuánto tiempo tardó en contactar al socio?'),
  ('property', 'follow_up_surveys.outcome_id.display_name', 'es', '¿Cuál fue el resultado con el socio?'),
  ('property', 'follow_up_surveys.open_feedback.display_name', 'es', 'Comentarios Adicionales'),
  ('property', 'follow_up_surveys.completed_date.display_name', 'es', 'Fecha de Finalización'),
  ('property', 'follow_up_surveys.updated_at.display_name', 'es', 'Actualizado'),
  ('property', 'follow_up_surveys.created_at.display_name', 'es', 'Creado')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — service_categories
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'service_categories.display_name.display_name', 'es', 'Nombre de Categoría'),
  ('property', 'service_categories.id.display_name', 'es', 'Id'),
  ('property', 'service_categories.description.display_name', 'es', 'Descripción'),
  ('property', 'service_categories.color.display_name', 'es', 'Color'),
  ('property', 'service_categories.active.display_name', 'es', 'Activo'),
  ('property', 'service_categories.sort_order.display_name', 'es', 'Orden de Visualización'),
  ('property', 'service_categories.created_at.display_name', 'es', 'Creado'),
  ('property', 'service_categories.updated_at.display_name', 'es', 'Actualizado')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — report views
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- client_contact_summary
  ('property', 'client_contact_summary.month.display_name', 'es', 'Mes'),
  ('property', 'client_contact_summary.new_clients.display_name', 'es', 'Nuevos Clientes'),
  ('property', 'client_contact_summary.intake_pending.display_name', 'es', 'Ingreso Pendiente'),
  ('property', 'client_contact_summary.active_clients.display_name', 'es', 'Activos'),
  -- monthly_referral_summary
  ('property', 'monthly_referral_summary.month.display_name', 'es', 'Mes'),
  ('property', 'monthly_referral_summary.total_referrals.display_name', 'es', 'Total'),
  ('property', 'monthly_referral_summary.warm_referrals.display_name', 'es', 'Cálidas'),
  ('property', 'monthly_referral_summary.info_referrals.display_name', 'es', 'Información'),
  ('property', 'monthly_referral_summary.completed.display_name', 'es', 'Completadas'),
  ('property', 'monthly_referral_summary.not_completed.display_name', 'es', 'No Completadas'),
  ('property', 'monthly_referral_summary.open_referrals.display_name', 'es', 'Abiertas'),
  ('property', 'monthly_referral_summary.completion_rate_pct.display_name', 'es', '% de Finalización'),
  -- partner_utilization_report
  ('property', 'partner_utilization_report.partner_name.display_name', 'es', 'Socio'),
  ('property', 'partner_utilization_report.partner_active.display_name', 'es', 'Activo'),
  ('property', 'partner_utilization_report.referral_count.display_name', 'es', 'Referencias'),
  ('property', 'partner_utilization_report.completed.display_name', 'es', 'Completadas'),
  ('property', 'partner_utilization_report.completion_rate_pct.display_name', 'es', '% de Finalización'),
  ('property', 'partner_utilization_report.service_categories.display_name', 'es', 'Servicios'),
  -- time_lag_report
  ('property', 'time_lag_report.referral_type.display_name', 'es', 'Tipo de Referencia'),
  ('property', 'time_lag_report.partner_name.display_name', 'es', 'Socio'),
  ('property', 'time_lag_report.time_to_contact.display_name', 'es', 'Tiempo de Contacto'),
  ('property', 'time_lag_report.response_count.display_name', 'es', 'Respuestas'),
  -- top_needs_report
  ('property', 'top_needs_report.service_category.display_name', 'es', 'Categoría de Servicio'),
  ('property', 'top_needs_report.color.display_name', 'es', 'Color'),
  ('property', 'top_needs_report.client_count.display_name', 'es', 'Cantidad de Clientes'),
  ('property', 'top_needs_report.pct_of_active_clients.display_name', 'es', '% de Clientes Activos'),
  -- referrals_per_week
  ('property', 'referrals_per_week.week_start.display_name', 'es', 'Inicio de Semana'),
  ('property', 'referrals_per_week.week_label.display_name', 'es', 'Etiqueta de Semana'),
  ('property', 'referrals_per_week.total_referrals.display_name', 'es', 'Total de Referencias'),
  ('property', 'referrals_per_week.poor_outcome_referrals.display_name', 'es', 'Referencias con Resultado Deficiente')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — junction tables (M:M)
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'client_service_needs.client_id.display_name', 'es', 'Id de Cliente'),
  ('property', 'client_service_needs.service_category_id.display_name', 'es', 'Id de Categoría de Servicio'),
  ('property', 'partner_service_categories.partner_id.display_name', 'es', 'Id de Socio'),
  ('property', 'partner_service_categories.service_category_id.display_name', 'es', 'Id de Categoría de Servicio'),
  ('property', 'referral_service_categories.referral_id.display_name', 'es', 'Id de Referencia'),
  ('property', 'referral_service_categories.service_category_id.display_name', 'es', 'Id de Categoría de Servicio')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- client statuses
  ('status', 'client.intake_pending.display_name', 'es', 'Ingreso Pendiente'),
  ('status', 'client.active.display_name', 'es', 'Activo'),
  ('status', 'client.inactive.display_name', 'es', 'Inactivo'),
  -- guided_form statuses
  ('status', 'guided_form.draft.display_name', 'es', 'Borrador'),
  ('status', 'guided_form.complete.display_name', 'es', 'Completo'),
  ('status', 'guided_form.submitted.display_name', 'es', 'Enviado'),
  -- referral statuses
  ('status', 'referral.referred.display_name', 'es', 'Referido'),
  ('status', 'referral.completed.display_name', 'es', 'Completado'),
  ('status', 'referral.not_completed.display_name', 'es', 'No Completado'),
  -- survey statuses
  ('status', 'survey.pending.display_name', 'es', 'Pendiente'),
  ('status', 'survey.completed.display_name', 'es', 'Completada'),
  ('status', 'survey.expired.display_name', 'es', 'Expirada')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES — descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- client statuses
  ('status', 'client.intake_pending.description', 'es', 'En espera de evaluación del personal'),
  ('status', 'client.active.description', 'es', 'Evaluado y recibiendo servicios activamente'),
  ('status', 'client.inactive.description', 'es', 'Ya no participa o se mudó'),
  -- referral statuses
  ('status', 'referral.referred.description', 'es', 'Referencia creada, en espera de resultado'),
  ('status', 'referral.completed.description', 'es', 'Cliente conectado exitosamente con el socio'),
  ('status', 'referral.not_completed.description', 'es', 'Cliente no pudo conectar o referencia sin éxito'),
  -- survey statuses
  ('status', 'survey.pending.description', 'es', 'En espera de respuesta del cliente'),
  ('status', 'survey.completed.description', 'es', 'El cliente completó la encuesta'),
  ('status', 'survey.expired.description', 'es', 'Sin respuesta después de todos los recordatorios')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- CATEGORIES
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- gender
  ('category', 'gender.male.display_name', 'es', 'Masculino'),
  ('category', 'gender.female.display_name', 'es', 'Femenino'),
  ('category', 'gender.non_binary.display_name', 'es', 'No Binario'),
  ('category', 'gender.prefer_not_to_say.display_name', 'es', 'Prefiere No Decir'),
  -- helpfulness
  ('category', 'helpfulness.very_helpful.display_name', 'es', 'Muy Útil'),
  ('category', 'helpfulness.somewhat_helpful.display_name', 'es', 'Algo Útil'),
  ('category', 'helpfulness.not_helpful.display_name', 'es', 'No Fue Útil'),
  ('category', 'helpfulness.could_not_contact.display_name', 'es', 'No Se Pudo Contactar'),
  -- outcome
  ('category', 'outcome.enrolled.display_name', 'es', 'Inscrito en Servicios'),
  ('category', 'outcome.received_info.display_name', 'es', 'Recibió Información'),
  ('category', 'outcome.referred_elsewhere.display_name', 'es', 'Referido a Otro Lugar'),
  ('category', 'outcome.no_action.display_name', 'es', 'Sin Acción Tomada'),
  ('category', 'outcome.other.display_name', 'es', 'Otro'),
  -- partner_type
  ('category', 'partner_type.organization.display_name', 'es', 'Organización'),
  ('category', 'partner_type.individual.display_name', 'es', 'Individual'),
  -- referral_type
  ('category', 'referral_type.warm.display_name', 'es', 'Presentación Mutua'),
  ('category', 'referral_type.info.display_name', 'es', 'Información del Socio'),
  -- time_to_contact
  ('category', 'time_to_contact.same_day.display_name', 'es', 'Mismo Día'),
  ('category', 'time_to_contact.1_2_days.display_name', 'es', '1-2 Días'),
  ('category', 'time_to_contact.3_5_days.display_name', 'es', '3-5 Días'),
  ('category', 'time_to_contact.more_than_5_days.display_name', 'es', 'Más de 5 Días'),
  ('category', 'time_to_contact.unable_to_contact.display_name', 'es', 'No Se Pudo Contactar')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — clients
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- activate
  ('action', 'clients.activate.display_name', 'es', 'Activar Cliente'),
  ('action', 'clients.activate.description', 'es', 'Evaluación completa; transición a Activo'),
  ('action', 'clients.activate.confirmation_message', 'es', '¿Activar este cliente? Esto confirma que su evaluación de ingreso está completa.'),
  ('action', 'clients.activate.success_message', 'es', 'Cliente activado exitosamente.'),
  -- reactivate
  ('action', 'clients.reactivate.display_name', 'es', 'Reactivar Cliente'),
  ('action', 'clients.reactivate.description', 'es', 'Restaurar cliente inactivo a estado activo'),
  ('action', 'clients.reactivate.confirmation_message', 'es', '¿Reactivar este cliente?'),
  ('action', 'clients.reactivate.success_message', 'es', 'Cliente reactivado.'),
  -- refer
  ('action', 'clients.refer.display_name', 'es', 'Referir Cliente'),
  ('action', 'clients.refer.description', 'es', 'Crear una referencia a un socio de servicios'),
  ('action', 'clients.refer.success_message', 'es', 'Referencia creada exitosamente.'),
  -- deactivate
  ('action', 'clients.deactivate.display_name', 'es', 'Desactivar Cliente'),
  ('action', 'clients.deactivate.description', 'es', 'Marcar cliente como ya no activo'),
  ('action', 'clients.deactivate.confirmation_message', 'es', '¿Desactivar este cliente? Su historial de referencias será preservado.'),
  ('action', 'clients.deactivate.success_message', 'es', 'Cliente desactivado.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — referrals
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- complete
  ('action', 'referrals.complete.display_name', 'es', 'Marcar como Completado'),
  ('action', 'referrals.complete.description', 'es', 'Cliente conectado exitosamente con el socio'),
  ('action', 'referrals.complete.confirmation_message', 'es', '¿Marcar esta referencia como completada?'),
  ('action', 'referrals.complete.success_message', 'es', 'Referencia marcada como completada.'),
  -- not_completed
  ('action', 'referrals.not_completed.display_name', 'es', 'Marcar como No Completado'),
  ('action', 'referrals.not_completed.description', 'es', 'Cliente no pudo conectar o referencia sin éxito'),
  ('action', 'referrals.not_completed.success_message', 'es', 'Referencia marcada como no completada.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTION PARAMS
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- clients.refer params
  ('action_param', 'clients.refer.p_partner_id.display_name', 'es', 'Socio'),
  ('action_param', 'clients.refer.p_referral_type_id.display_name', 'es', 'Tipo de Referencia'),
  ('action_param', 'clients.refer.p_referral_date.display_name', 'es', 'Fecha de Referencia'),
  -- referrals.not_completed params
  ('action_param', 'referrals.not_completed.p_outcome_notes.display_name', 'es', 'Notas del Resultado'),
  ('action_param', 'referrals.not_completed.p_outcome_notes.placeholder', 'es', 'Explique por qué la referencia no fue completada...')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- DASHBOARDS
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('dashboard', 'dashboard.1.display_name', 'es', 'Bienvenida ECS'),
  ('dashboard', 'dashboard.1.description', 'es', 'Página pública de Servicios Comunitarios Ejemplares'),
  ('dashboard', 'dashboard.2.display_name', 'es', 'Panel de Ingreso ECS'),
  ('dashboard', 'dashboard.2.description', 'es', 'Ingreso de clientes, referencias y seguimiento de encuestas')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- DASHBOARD WIDGET TITLES
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('dashboard', 'dashboard.2.widget.2.title', 'es', 'Ingreso Pendiente'),
  ('dashboard', 'dashboard.2.widget.3.title', 'es', 'Referencias Abiertas'),
  ('dashboard', 'dashboard.2.widget.4.title', 'es', 'Encuestas Pendientes'),
  ('dashboard', 'dashboard.2.widget.7.title', 'es', 'Referencias por Semana'),
  ('dashboard', 'dashboard.2.widget.5.title', 'es', 'Ubicaciones de Socios')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- WIDGET CONFIG — Welcome page markdown content
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('widget_config', 'dashboard.1.widget.1.content', 'es',
'# Servicios Comunitarios Ejemplares

Servicios Comunitarios Ejemplares (ECS) conecta a miembros de la comunidad con servicios esenciales y programas de apoyo.

## Nuestros Servicios

- **Ingreso y Evaluación de Clientes**: Identificación integral de necesidades para miembros de la comunidad
- **Referencias**: Referencias personalizadas e informativas a socios de servicios locales verificados
- **Seguimiento**: Seguimiento de resultados basado en encuestas para asegurar conexiones exitosas

## Red de Socios

Coordinamos con una red de organizaciones locales que proveen:

- Empleo y Colocación Laboral
- Educación y Capacitación Laboral
- Servicios de Salud y Médicos
- Asistencia de Vivienda
- Transporte
- Cuidado Infantil y Programas Juveniles
- Educación Financiera y Navegación de Beneficios
- Asistencia Legal
- Traducción e Interpretación

## Contacto

**Servicios Comunitarios Ejemplares**
123 Main St., Suite 100, Anytown, US 00000
Teléfono: (555) 555-0100
Web: [example.org](https://example.org)

---

*Personal: por favor inicie sesión para acceder al Panel de Ingreso y las herramientas de gestión de clientes.*')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;
