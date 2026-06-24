-- Deploy civic_os:v0-57-0-add-i18n to pg
-- Adds internationalization (i18n) foundation: translations table, lookup functions,
-- user locale preference, and seed data for English/Spanish UI strings.
-- requires: v0-56-1-fix-managed-db-admin-guard

BEGIN;


-- ============================================================================
-- 1. metadata.translations table
-- ============================================================================
-- Central store for all translatable strings. source_type discriminates between
-- UI strings, entity names, property labels, status values, etc.

CREATE TABLE metadata.translations (
  id SERIAL PRIMARY KEY,
  source_type VARCHAR(50) NOT NULL,     -- 'ui', 'entity', 'property', 'status', etc.
  source_key TEXT NOT NULL,              -- 'nav.home', 'entities.display_name.42'
  locale VARCHAR(10) NOT NULL,           -- 'en', 'es', 'es-MX'
  translated_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source_type, source_key, locale)
);

-- Explicit index on the lookup triple (the unique constraint creates one, but be explicit)
CREATE INDEX idx_translations_lookup
  ON metadata.translations (source_type, source_key, locale);

-- Reuse the existing set_updated_at trigger pattern
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.translations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- RLS: everyone can read, only admins can write
ALTER TABLE metadata.translations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Everyone can read translations"
  ON metadata.translations
  FOR SELECT
  TO web_anon, authenticated
  USING (true);

CREATE POLICY "Admins can insert translations"
  ON metadata.translations
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update translations"
  ON metadata.translations
  FOR UPDATE
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins can delete translations"
  ON metadata.translations
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- GRANTs
GRANT SELECT ON metadata.translations TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.translations TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.translations_id_seq TO authenticated;


-- ============================================================================
-- 2. metadata.current_locale() helper
-- ============================================================================
-- Reads the Accept-Language header set by PostgREST. Falls back to 'en'.

CREATE OR REPLACE FUNCTION metadata.current_locale()
RETURNS TEXT AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.header.accept-language', true), ''),
    'en'
  );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION metadata.current_locale() IS
    'Returns the current request locale from Accept-Language header, defaulting to en. Added in v0.57.0.';


-- ============================================================================
-- 3. metadata.t() — core translation lookup
-- ============================================================================
-- Three-tier fallback: exact locale → base language → default text.
-- Short-circuits for English (default) with zero overhead.

CREATE OR REPLACE FUNCTION metadata.t(
  p_source_type TEXT, p_source_key TEXT, p_default_text TEXT
) RETURNS TEXT AS $$
DECLARE
  v_locale TEXT;
  v_result TEXT;
  v_base_locale TEXT;
BEGIN
  v_locale := metadata.current_locale();

  -- Short-circuit for English (default) - zero overhead
  IF v_locale = 'en' OR v_locale IS NULL THEN
    RETURN p_default_text;
  END IF;

  -- Try exact locale match
  SELECT translated_text INTO v_result
  FROM metadata.translations
  WHERE source_type = p_source_type
    AND source_key = p_source_key
    AND locale = v_locale;

  IF v_result IS NOT NULL THEN
    RETURN v_result;
  END IF;

  -- Try base language fallback (es-MX -> es)
  v_base_locale := split_part(v_locale, '-', 1);
  IF v_base_locale != v_locale THEN
    SELECT translated_text INTO v_result
    FROM metadata.translations
    WHERE source_type = p_source_type
      AND source_key = p_source_key
      AND locale = v_base_locale;

    IF v_result IS NOT NULL THEN
      RETURN v_result;
    END IF;
  END IF;

  -- Final fallback: return default text
  RETURN p_default_text;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION metadata.t(TEXT, TEXT, TEXT) IS
    'Core translation lookup with three-tier fallback: exact locale → base language → default text. '
    'Short-circuits for English with zero overhead. Added in v0.57.0.';


-- ============================================================================
-- 4. Add locale column to civic_os_users_private
-- ============================================================================

ALTER TABLE metadata.civic_os_users_private ADD COLUMN locale VARCHAR(10);


-- ============================================================================
-- 5. Recreate civic_os_users VIEW with locale column
-- ============================================================================
-- DROP CASCADE will also drop payment_transactions and payment_refunds views
-- that depend on civic_os_users. They must be recreated afterward.

DROP VIEW IF EXISTS public.civic_os_users CASCADE;

CREATE VIEW public.civic_os_users AS
SELECT
  u.id,
  u.display_name,
  u.created_at,
  u.updated_at,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.display_name
    ELSE NULL
  END AS full_name,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.email
    ELSE NULL
  END AS email,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.phone
    ELSE NULL
  END AS phone,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.locale
    ELSE NULL
  END AS locale,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN to_tsvector('english',
      COALESCE(u.display_name, '') || ' ' ||
      COALESCE(p.display_name, '') || ' ' ||
      COALESCE(replace(replace(p.email::text, '@', ' '), '.', ' '), '') || ' ' ||
      CASE WHEN p.phone ~ '^\d{10}$'
           THEN phone_search_tokens(p.phone::phone_number)
           ELSE COALESCE(p.phone::text, '') END)
    ELSE to_tsvector('english', COALESCE(u.display_name, ''))
  END AS civic_os_text_search
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id;

ALTER VIEW public.civic_os_users SET (security_invoker = true);

GRANT SELECT ON public.civic_os_users TO web_anon, authenticated;


-- ============================================================================
-- 5a. Recreate payment_transactions VIEW (dropped by CASCADE)
-- ============================================================================
-- Restored from v0-55-2-submit-form-status-fix (verbatim)

CREATE VIEW public.payment_transactions AS
SELECT
    t.id,
    t.user_id,
    u.display_name AS user_display_name,
    u.full_name AS user_full_name,
    u.email AS user_email,
    t.amount,
    t.processing_fee,
    t.total_amount,
    t.max_refundable,
    t.fee_percent,
    t.fee_flat_cents,
    t.fee_refundable,
    t.currency,
    t.status,
    t.provider_payment_id,
    COALESCE(r_agg.total_refunded, 0) AS total_refunded,
    COALESCE(r_agg.refund_count, 0) AS refund_count,
    COALESCE(r_agg.pending_count, 0) AS pending_refund_count,
    CASE
        WHEN r_agg.total_refunded >= t.max_refundable THEN 'refunded'
        WHEN r_agg.total_refunded > 0 THEN 'partially_refunded'
        WHEN r_agg.pending_count > 0 THEN 'refund_pending'
        ELSE COALESCE(t.status, 'unpaid')
    END AS effective_status,
    t.error_message,
    t.provider,
    t.provider_client_secret,
    t.description,
    t.display_name,
    t.created_at,
    t.updated_at,
    t.entity_type,
    t.entity_id,
    COALESCE(e.display_name, t.entity_type) AS entity_display_name
FROM payments.transactions t
LEFT JOIN public.civic_os_users u ON t.user_id = u.id
LEFT JOIN metadata.entities e ON t.entity_type = e.table_name
LEFT JOIN LATERAL (
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0) AS total_refunded,
        COUNT(*) FILTER (WHERE status = 'succeeded') AS refund_count,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
    FROM payments.refunds
    WHERE transaction_id = t.id
) r_agg ON true;

GRANT SELECT ON public.payment_transactions TO authenticated, web_anon;


-- ============================================================================
-- 5b. Recreate payment_refunds VIEW (dropped by CASCADE)
-- ============================================================================
-- Restored from v0-55-2-submit-form-status-fix (verbatim)

CREATE VIEW public.payment_refunds AS
SELECT
    r.id,
    r.transaction_id,
    r.amount,
    r.reason,
    r.initiated_by,
    u.display_name AS initiated_by_name,
    r.provider_refund_id,
    r.status,
    r.error_message,
    r.created_at,
    r.processed_at,
    t.amount AS payment_amount,
    t.description AS payment_description,
    t.provider_payment_id
FROM payments.refunds r
LEFT JOIN public.civic_os_users u ON r.initiated_by = u.id
LEFT JOIN payments.transactions t ON r.transaction_id = t.id;

GRANT SELECT ON public.payment_refunds TO authenticated;


-- ============================================================================
-- 6. public.translations VIEW
-- ============================================================================
-- Exposes metadata.translations via PostgREST with security_invoker.

CREATE VIEW public.translations
WITH (security_invoker = true)
AS SELECT id, source_type, source_key, locale, translated_text, created_at, updated_at
FROM metadata.translations;

GRANT SELECT ON public.translations TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.translations TO authenticated;


-- ============================================================================
-- 7. RPCs
-- ============================================================================

-- 7a. get_translations_for_locale — bulk fetch for a locale
CREATE OR REPLACE FUNCTION public.get_translations_for_locale(p_locale TEXT)
RETURNS TABLE(source_type TEXT, source_key TEXT, translated_text TEXT)
AS $$
  SELECT source_type::TEXT, source_key, translated_text
  FROM metadata.translations
  WHERE locale = p_locale;
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION public.get_translations_for_locale(TEXT) TO web_anon, authenticated;

COMMENT ON FUNCTION public.get_translations_for_locale(TEXT) IS
    'Bulk fetch all translations for a given locale. Called on app init. Added in v0.57.0.';


-- 7b. upsert_translations — bulk upsert (admin only)
CREATE OR REPLACE FUNCTION public.upsert_translations(p_translations JSONB)
RETURNS JSONB AS $$
DECLARE
  v_item JSONB;
  v_count INT := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_translations)
  LOOP
    INSERT INTO metadata.translations (source_type, source_key, locale, translated_text)
    VALUES (
      v_item->>'source_type',
      v_item->>'source_key',
      v_item->>'locale',
      v_item->>'translated_text'
    )
    ON CONFLICT (source_type, source_key, locale) DO UPDATE
    SET translated_text = EXCLUDED.translated_text,
        updated_at = NOW();
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'upserted', v_count);
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION public.upsert_translations(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_translations(JSONB) TO authenticated;

COMMENT ON FUNCTION public.upsert_translations(JSONB) IS
    'Bulk upsert translations from JSONB array. Admin only. Added in v0.57.0.';


-- 7c. get_missing_translations — find untranslated strings
CREATE OR REPLACE FUNCTION public.get_missing_translations(p_target_locale TEXT)
RETURNS TABLE(source_type TEXT, source_key TEXT, default_text TEXT)
AS $$
  SELECT DISTINCT t1.source_type::TEXT, t1.source_key, t1.translated_text AS default_text
  FROM metadata.translations t1
  WHERE t1.locale = 'en'
    AND NOT EXISTS (
      SELECT 1 FROM metadata.translations t2
      WHERE t2.source_type = t1.source_type
        AND t2.source_key = t1.source_key
        AND t2.locale = p_target_locale
    );
$$ LANGUAGE sql STABLE;

REVOKE EXECUTE ON FUNCTION public.get_missing_translations(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_missing_translations(TEXT) TO authenticated;

COMMENT ON FUNCTION public.get_missing_translations(TEXT) IS
    'Find English strings that have no translation for the target locale. Admin tool. Added in v0.57.0.';


-- ============================================================================
-- 8. Seed UI strings — English and Spanish
-- ============================================================================

-- Navigation
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'nav.home', 'en', 'Home'),
('ui', 'nav.home', 'es', 'Inicio'),
('ui', 'nav.data', 'en', 'Data'),
('ui', 'nav.data', 'es', 'Datos'),
('ui', 'nav.about', 'en', 'About'),
('ui', 'nav.about', 'es', 'Acerca de'),
('ui', 'nav.admin', 'en', 'Admin'),
('ui', 'nav.admin', 'es', 'Administración'),
('ui', 'nav.skip_to_content', 'en', 'Skip to main content'),
('ui', 'nav.skip_to_content', 'es', 'Ir al contenido principal');

-- Sidebar
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'sidebar.database_schema', 'en', 'Database Schema'),
('ui', 'sidebar.database_schema', 'es', 'Esquema de Base de Datos'),
('ui', 'sidebar.entities', 'en', 'Entities'),
('ui', 'sidebar.entities', 'es', 'Entidades'),
('ui', 'sidebar.properties', 'en', 'Properties'),
('ui', 'sidebar.properties', 'es', 'Propiedades'),
('ui', 'sidebar.permissions', 'en', 'Permissions'),
('ui', 'sidebar.permissions', 'es', 'Permisos'),
('ui', 'sidebar.statuses', 'en', 'Statuses'),
('ui', 'sidebar.statuses', 'es', 'Estados'),
('ui', 'sidebar.categories', 'en', 'Categories'),
('ui', 'sidebar.categories', 'es', 'Categorías'),
('ui', 'sidebar.notifications', 'en', 'Notifications'),
('ui', 'sidebar.notifications', 'es', 'Notificaciones'),
('ui', 'sidebar.functions', 'en', 'Functions & RPCs'),
('ui', 'sidebar.functions', 'es', 'Funciones y RPCs'),
('ui', 'sidebar.policies', 'en', 'Security Policies'),
('ui', 'sidebar.policies', 'es', 'Políticas de Seguridad'),
('ui', 'sidebar.users', 'en', 'Users'),
('ui', 'sidebar.users', 'es', 'Usuarios'),
('ui', 'sidebar.static_assets', 'en', 'Static Assets'),
('ui', 'sidebar.static_assets', 'es', 'Recursos Estáticos'),
('ui', 'sidebar.files', 'en', 'Files'),
('ui', 'sidebar.files', 'es', 'Archivos'),
('ui', 'sidebar.galleries', 'en', 'Galleries'),
('ui', 'sidebar.galleries', 'es', 'Galerías'),
('ui', 'sidebar.recurring_schedules', 'en', 'Recurring Schedules'),
('ui', 'sidebar.recurring_schedules', 'es', 'Horarios Recurrentes'),
('ui', 'sidebar.payments', 'en', 'Payments'),
('ui', 'sidebar.payments', 'es', 'Pagos');

-- Actions
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'action.save', 'en', 'Save'),
('ui', 'action.save', 'es', 'Guardar'),
('ui', 'action.cancel', 'en', 'Cancel'),
('ui', 'action.cancel', 'es', 'Cancelar'),
('ui', 'action.edit', 'en', 'Edit'),
('ui', 'action.edit', 'es', 'Editar'),
('ui', 'action.delete', 'en', 'Delete'),
('ui', 'action.delete', 'es', 'Eliminar'),
('ui', 'action.create', 'en', 'Create'),
('ui', 'action.create', 'es', 'Crear'),
('ui', 'action.update', 'en', 'Update'),
('ui', 'action.update', 'es', 'Actualizar'),
('ui', 'action.close', 'en', 'Close'),
('ui', 'action.close', 'es', 'Cerrar'),
('ui', 'action.confirm', 'en', 'Confirm'),
('ui', 'action.confirm', 'es', 'Confirmar'),
('ui', 'action.back', 'en', 'Back'),
('ui', 'action.back', 'es', 'Volver'),
('ui', 'action.search', 'en', 'Search'),
('ui', 'action.search', 'es', 'Buscar'),
('ui', 'action.filter', 'en', 'Filter'),
('ui', 'action.filter', 'es', 'Filtrar'),
('ui', 'action.export', 'en', 'Export'),
('ui', 'action.export', 'es', 'Exportar'),
('ui', 'action.import', 'en', 'Import'),
('ui', 'action.import', 'es', 'Importar'),
('ui', 'action.refresh', 'en', 'Refresh'),
('ui', 'action.refresh', 'es', 'Actualizar'),
('ui', 'action.submit', 'en', 'Submit'),
('ui', 'action.submit', 'es', 'Enviar'),
('ui', 'action.approve', 'en', 'Approve'),
('ui', 'action.approve', 'es', 'Aprobar'),
('ui', 'action.reject', 'en', 'Reject'),
('ui', 'action.reject', 'es', 'Rechazar'),
('ui', 'action.upload', 'en', 'Upload'),
('ui', 'action.upload', 'es', 'Subir'),
('ui', 'action.download', 'en', 'Download'),
('ui', 'action.download', 'es', 'Descargar'),
('ui', 'action.remove', 'en', 'Remove'),
('ui', 'action.remove', 'es', 'Quitar'),
('ui', 'action.add', 'en', 'Add'),
('ui', 'action.add', 'es', 'Agregar'),
('ui', 'action.clear', 'en', 'Clear'),
('ui', 'action.clear', 'es', 'Limpiar'),
('ui', 'action.select', 'en', 'Select'),
('ui', 'action.select', 'es', 'Seleccionar'),
('ui', 'action.view', 'en', 'View'),
('ui', 'action.view', 'es', 'Ver'),
('ui', 'action.login', 'en', 'Log In'),
('ui', 'action.login', 'es', 'Iniciar Sesión'),
('ui', 'action.logout', 'en', 'Logout'),
('ui', 'action.logout', 'es', 'Cerrar Sesión');

-- States
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'state.loading', 'en', 'Loading...'),
('ui', 'state.loading', 'es', 'Cargando...'),
('ui', 'state.no_results', 'en', 'No results found'),
('ui', 'state.no_results', 'es', 'No se encontraron resultados'),
('ui', 'state.no_data', 'en', 'No data available'),
('ui', 'state.no_data', 'es', 'No hay datos disponibles'),
('ui', 'state.error', 'en', 'An error occurred'),
('ui', 'state.error', 'es', 'Ocurrió un error'),
('ui', 'state.not_set', 'en', 'Not Set'),
('ui', 'state.not_set', 'es', 'No establecido'),
('ui', 'state.none', 'en', 'None'),
('ui', 'state.none', 'es', 'Ninguno'),
('ui', 'state.empty', 'en', 'Empty'),
('ui', 'state.empty', 'es', 'Vacío'),
('ui', 'state.saving', 'en', 'Saving...'),
('ui', 'state.saving', 'es', 'Guardando...'),
('ui', 'state.deleting', 'en', 'Deleting...'),
('ui', 'state.deleting', 'es', 'Eliminando...'),
('ui', 'state.sign_in_prompt', 'en', 'Sign in to view this record'),
('ui', 'state.sign_in_prompt', 'es', 'Inicie sesión para ver este registro');

-- Pagination
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'pagination.showing', 'en', 'Showing'),
('ui', 'pagination.showing', 'es', 'Mostrando'),
('ui', 'pagination.of', 'en', 'of'),
('ui', 'pagination.of', 'es', 'de'),
('ui', 'pagination.previous', 'en', 'Previous'),
('ui', 'pagination.previous', 'es', 'Anterior'),
('ui', 'pagination.next', 'en', 'Next'),
('ui', 'pagination.next', 'es', 'Siguiente'),
('ui', 'pagination.first', 'en', 'First'),
('ui', 'pagination.first', 'es', 'Primera'),
('ui', 'pagination.last', 'en', 'Last'),
('ui', 'pagination.last', 'es', 'Última'),
('ui', 'pagination.page', 'en', 'Page'),
('ui', 'pagination.page', 'es', 'Página'),
('ui', 'pagination.per_page', 'en', 'per page'),
('ui', 'pagination.per_page', 'es', 'por página'),
('ui', 'pagination.items', 'en', 'items'),
('ui', 'pagination.items', 'es', 'elementos');

-- Detail page
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'detail.overview', 'en', 'Overview'),
('ui', 'detail.overview', 'es', 'Descripción General'),
('ui', 'detail.related', 'en', 'Related Records'),
('ui', 'detail.related', 'es', 'Registros Relacionados'),
('ui', 'detail.notes', 'en', 'Notes'),
('ui', 'detail.notes', 'es', 'Notas'),
('ui', 'detail.confirm_delete', 'en', 'Are you sure you want to delete this record?'),
('ui', 'detail.confirm_delete', 'es', '¿Está seguro de que desea eliminar este registro?'),
('ui', 'detail.delete_warning', 'en', 'This action cannot be undone.'),
('ui', 'detail.delete_warning', 'es', 'Esta acción no se puede deshacer.'),
('ui', 'detail.created_at', 'en', 'Created'),
('ui', 'detail.created_at', 'es', 'Creado'),
('ui', 'detail.updated_at', 'en', 'Updated'),
('ui', 'detail.updated_at', 'es', 'Actualizado'),
('ui', 'detail.actions', 'en', 'Actions'),
('ui', 'detail.actions', 'es', 'Acciones'),
('ui', 'detail.no_location', 'en', 'No location set'),
('ui', 'detail.no_location', 'es', 'Sin ubicación establecida');

-- Forms (create/edit)
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'form.required', 'en', 'This field is required'),
('ui', 'form.required', 'es', 'Este campo es obligatorio'),
('ui', 'form.invalid_email', 'en', 'Please enter a valid email address'),
('ui', 'form.invalid_email', 'es', 'Ingrese una dirección de correo válida'),
('ui', 'form.min_length', 'en', 'Minimum length: {{min}}'),
('ui', 'form.min_length', 'es', 'Longitud mínima: {{min}}'),
('ui', 'form.max_length', 'en', 'Maximum length: {{max}}'),
('ui', 'form.max_length', 'es', 'Longitud máxima: {{max}}'),
('ui', 'form.min_value', 'en', 'Minimum value: {{min}}'),
('ui', 'form.min_value', 'es', 'Valor mínimo: {{min}}'),
('ui', 'form.max_value', 'en', 'Maximum value: {{max}}'),
('ui', 'form.max_value', 'es', 'Valor máximo: {{max}}'),
('ui', 'form.pattern_mismatch', 'en', 'Invalid format'),
('ui', 'form.pattern_mismatch', 'es', 'Formato inválido'),
('ui', 'form.create_title', 'en', 'Create {{entity}}'),
('ui', 'form.create_title', 'es', 'Crear {{entity}}'),
('ui', 'form.edit_title', 'en', 'Edit {{entity}}'),
('ui', 'form.edit_title', 'es', 'Editar {{entity}}'),
('ui', 'form.select_option', 'en', 'Select...'),
('ui', 'form.select_option', 'es', 'Seleccionar...'),
('ui', 'form.search_placeholder', 'en', 'Search...'),
('ui', 'form.search_placeholder', 'es', 'Buscar...'),
('ui', 'form.no_options', 'en', 'No options available'),
('ui', 'form.no_options', 'es', 'No hay opciones disponibles'),
('ui', 'form.create_success', 'en', 'Record created successfully'),
('ui', 'form.create_success', 'es', 'Registro creado exitosamente'),
('ui', 'form.update_success', 'en', 'Record updated successfully'),
('ui', 'form.update_success', 'es', 'Registro actualizado exitosamente'),
('ui', 'form.delete_success', 'en', 'Record deleted successfully'),
('ui', 'form.delete_success', 'es', 'Registro eliminado exitosamente');

-- Settings
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'settings.title', 'en', 'Settings'),
('ui', 'settings.title', 'es', 'Configuración'),
('ui', 'settings.preferences', 'en', 'Preferences'),
('ui', 'settings.preferences', 'es', 'Preferencias'),
('ui', 'settings.colors', 'en', 'Colors'),
('ui', 'settings.colors', 'es', 'Colores'),
('ui', 'settings.language', 'en', 'Language'),
('ui', 'settings.language', 'es', 'Idioma'),
('ui', 'settings.privacy', 'en', 'Privacy'),
('ui', 'settings.privacy', 'es', 'Privacidad'),
('ui', 'settings.notifications', 'en', 'Notifications'),
('ui', 'settings.notifications', 'es', 'Notificaciones'),
('ui', 'settings.analytics_label', 'en', 'Share anonymous usage data to help improve {{appTitle}}'),
('ui', 'settings.analytics_label', 'es', 'Compartir datos de uso anónimos para mejorar {{appTitle}}'),
('ui', 'settings.analytics_description', 'en', 'We collect page views and feature usage statistics. No personal information or data content is tracked. You can change this preference at any time.'),
('ui', 'settings.analytics_description', 'es', 'Recopilamos estadísticas de vistas de página y uso de funciones. No se rastrea información personal ni contenido de datos. Puede cambiar esta preferencia en cualquier momento.'),
('ui', 'settings.email_notifications', 'en', 'Email notifications'),
('ui', 'settings.email_notifications', 'es', 'Notificaciones por correo'),
('ui', 'settings.sms_notifications', 'en', 'SMS notifications'),
('ui', 'settings.sms_notifications', 'es', 'Notificaciones por SMS'),
('ui', 'settings.send_to', 'en', 'Send notifications to:'),
('ui', 'settings.send_to', 'es', 'Enviar notificaciones a:'),
('ui', 'settings.sms_consent', 'en', 'By enabling SMS notifications, you consent to receive transactional text messages from {{appTitle}}. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help.'),
('ui', 'settings.sms_consent', 'es', 'Al habilitar las notificaciones por SMS, acepta recibir mensajes de texto transaccionales de {{appTitle}}. Pueden aplicarse tarifas de mensaje y datos. Responda STOP para cancelar, HELP para ayuda.'),
('ui', 'settings.no_preferences', 'en', 'No notification preferences found. They will be created on your next login.'),
('ui', 'settings.no_preferences', 'es', 'No se encontraron preferencias de notificación. Se crearán en su próximo inicio de sesión.'),
('ui', 'settings.loading_preferences', 'en', 'Loading preferences...'),
('ui', 'settings.loading_preferences', 'es', 'Cargando preferencias...');

-- Impersonation
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'impersonation.title', 'en', 'Admin: Role Impersonation'),
('ui', 'impersonation.title', 'es', 'Admin: Suplantación de Roles'),
('ui', 'impersonation.description', 'en', 'Test the app as if you only have specific roles. Your real identity is preserved.'),
('ui', 'impersonation.description', 'es', 'Pruebe la aplicación como si solo tuviera roles específicos. Su identidad real se conserva.'),
('ui', 'impersonation.active', 'en', 'Impersonation Active'),
('ui', 'impersonation.active', 'es', 'Suplantación Activa'),
('ui', 'impersonation.viewing_as', 'en', 'Currently viewing as:'),
('ui', 'impersonation.viewing_as', 'es', 'Actualmente viendo como:'),
('ui', 'impersonation.stop', 'en', 'Stop Impersonation'),
('ui', 'impersonation.stop', 'es', 'Detener Suplantación'),
('ui', 'impersonation.select_roles', 'en', 'Select roles to impersonate:'),
('ui', 'impersonation.select_roles', 'es', 'Seleccione roles para suplantar:'),
('ui', 'impersonation.start', 'en', 'Start Impersonation'),
('ui', 'impersonation.start', 'es', 'Iniciar Suplantación'),
('ui', 'impersonation.impersonating', 'en', 'Impersonating'),
('ui', 'impersonation.impersonating', 'es', 'Suplantando');

-- Auth/Profile
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'auth.preferences', 'en', 'Preferences'),
('ui', 'auth.preferences', 'es', 'Preferencias'),
('ui', 'auth.account_settings', 'en', 'Account Settings'),
('ui', 'auth.account_settings', 'es', 'Configuración de Cuenta'),
('ui', 'auth.viewing_as', 'en', 'Viewing as:'),
('ui', 'auth.viewing_as', 'es', 'Viendo como:'),
('ui', 'auth.stop_impersonation', 'en', 'Stop Impersonation'),
('ui', 'auth.stop_impersonation', 'es', 'Detener Suplantación'),
('ui', 'auth.about', 'en', 'About {{appTitle}}'),
('ui', 'auth.about', 'es', 'Acerca de {{appTitle}}');

-- Errors
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'error.generic', 'en', 'An error occurred'),
('ui', 'error.generic', 'es', 'Ocurrió un error'),
('ui', 'error.not_found', 'en', 'Record not found'),
('ui', 'error.not_found', 'es', 'Registro no encontrado'),
('ui', 'error.unauthorized', 'en', 'You are not authorized to perform this action'),
('ui', 'error.unauthorized', 'es', 'No está autorizado para realizar esta acción'),
('ui', 'error.forbidden', 'en', 'Access denied'),
('ui', 'error.forbidden', 'es', 'Acceso denegado'),
('ui', 'error.validation', 'en', 'Validation error'),
('ui', 'error.validation', 'es', 'Error de validación'),
('ui', 'error.network', 'en', 'Network error. Please check your connection.'),
('ui', 'error.network', 'es', 'Error de red. Verifique su conexión.'),
('ui', 'error.server', 'en', 'Server error. Please try again later.'),
('ui', 'error.server', 'es', 'Error del servidor. Intente de nuevo más tarde.'),
('ui', 'error.constraint', 'en', 'A database constraint was violated'),
('ui', 'error.constraint', 'es', 'Se violó una restricción de base de datos'),
('ui', 'error.duplicate', 'en', 'A record with these values already exists'),
('ui', 'error.duplicate', 'es', 'Ya existe un registro con estos valores'),
('ui', 'error.foreign_key', 'en', 'This record is referenced by other records'),
('ui', 'error.foreign_key', 'es', 'Este registro está referenciado por otros registros'),
('ui', 'error.permission', 'en', 'You do not have permission for this action'),
('ui', 'error.permission', 'es', 'No tiene permiso para esta acción'),
('ui', 'error.rls', 'en', 'Row-level security policy denied this operation'),
('ui', 'error.rls', 'es', 'La política de seguridad de nivel de fila denegó esta operación'),
('ui', 'error.timeout', 'en', 'Request timed out'),
('ui', 'error.timeout', 'es', 'La solicitud expiró'),
('ui', 'error.unknown_category', 'en', 'Unknown error'),
('ui', 'error.unknown_category', 'es', 'Error desconocido');

-- List page
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'list.search_placeholder', 'en', 'Search {{entity}}...'),
('ui', 'list.search_placeholder', 'es', 'Buscar {{entity}}...'),
('ui', 'list.no_records', 'en', 'No {{entity}} found'),
('ui', 'list.no_records', 'es', 'No se encontraron {{entity}}'),
('ui', 'list.add_new', 'en', 'Add New'),
('ui', 'list.add_new', 'es', 'Agregar Nuevo'),
('ui', 'list.filters', 'en', 'Filters'),
('ui', 'list.filters', 'es', 'Filtros'),
('ui', 'list.clear_filters', 'en', 'Clear Filters'),
('ui', 'list.clear_filters', 'es', 'Limpiar Filtros'),
('ui', 'list.columns', 'en', 'Columns'),
('ui', 'list.columns', 'es', 'Columnas'),
('ui', 'list.sort_by', 'en', 'Sort by'),
('ui', 'list.sort_by', 'es', 'Ordenar por'),
('ui', 'list.ascending', 'en', 'Ascending'),
('ui', 'list.ascending', 'es', 'Ascendente'),
('ui', 'list.descending', 'en', 'Descending'),
('ui', 'list.descending', 'es', 'Descendente');

-- Import/Export
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'import_export.export_excel', 'en', 'Export to Excel'),
('ui', 'import_export.export_excel', 'es', 'Exportar a Excel'),
('ui', 'import_export.import_excel', 'en', 'Import from Excel'),
('ui', 'import_export.import_excel', 'es', 'Importar desde Excel'),
('ui', 'import_export.import_title', 'en', 'Import Data'),
('ui', 'import_export.import_title', 'es', 'Importar Datos'),
('ui', 'import_export.import_instructions', 'en', 'Upload an Excel file to import records'),
('ui', 'import_export.import_instructions', 'es', 'Suba un archivo Excel para importar registros'),
('ui', 'import_export.importing', 'en', 'Importing...'),
('ui', 'import_export.importing', 'es', 'Importando...'),
('ui', 'import_export.import_success', 'en', 'Successfully imported {{count}} records'),
('ui', 'import_export.import_success', 'es', 'Se importaron {{count}} registros exitosamente'),
('ui', 'import_export.import_error', 'en', 'Error importing data'),
('ui', 'import_export.import_error', 'es', 'Error al importar datos');

-- Dashboard
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'dashboard.no_dashboards', 'en', 'No dashboards configured'),
('ui', 'dashboard.no_dashboards', 'es', 'No hay tableros configurados'),
('ui', 'dashboard.select', 'en', 'Select Dashboard'),
('ui', 'dashboard.select', 'es', 'Seleccionar Tablero'),
('ui', 'dashboard.default', 'en', 'Default Dashboard'),
('ui', 'dashboard.default', 'es', 'Tablero Predeterminado');

-- Guided forms
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'guided_form.draft', 'en', 'Draft'),
('ui', 'guided_form.draft', 'es', 'Borrador'),
('ui', 'guided_form.complete', 'en', 'Complete'),
('ui', 'guided_form.complete', 'es', 'Completo'),
('ui', 'guided_form.submitted', 'en', 'Submitted'),
('ui', 'guided_form.submitted', 'es', 'Enviado'),
('ui', 'guided_form.review', 'en', 'Review & Submit'),
('ui', 'guided_form.review', 'es', 'Revisar y Enviar'),
('ui', 'guided_form.review_intro', 'en', 'Review your responses before submitting'),
('ui', 'guided_form.review_intro', 'es', 'Revise sus respuestas antes de enviar'),
('ui', 'guided_form.step', 'en', 'Step'),
('ui', 'guided_form.step', 'es', 'Paso'),
('ui', 'guided_form.next_step', 'en', 'Next Step'),
('ui', 'guided_form.next_step', 'es', 'Siguiente Paso'),
('ui', 'guided_form.previous_step', 'en', 'Previous Step'),
('ui', 'guided_form.previous_step', 'es', 'Paso Anterior'),
('ui', 'guided_form.save_draft', 'en', 'Save Draft'),
('ui', 'guided_form.save_draft', 'es', 'Guardar Borrador'),
('ui', 'guided_form.submit', 'en', 'Submit'),
('ui', 'guided_form.submit', 'es', 'Enviar'),
('ui', 'guided_form.locked', 'en', 'This form has been submitted and is locked'),
('ui', 'guided_form.locked', 'es', 'Este formulario ha sido enviado y está bloqueado'),
('ui', 'guided_form.skip', 'en', 'Skip this step'),
('ui', 'guided_form.skip', 'es', 'Omitir este paso'),
('ui', 'guided_form.required_step', 'en', 'This step is required'),
('ui', 'guided_form.required_step', 'es', 'Este paso es obligatorio'),
('ui', 'guided_form.all_steps_complete', 'en', 'All steps complete'),
('ui', 'guided_form.all_steps_complete', 'es', 'Todos los pasos completados'),
('ui', 'guided_form.incomplete_steps', 'en', 'Some steps are incomplete'),
('ui', 'guided_form.incomplete_steps', 'es', 'Algunos pasos están incompletos');

-- Photo gallery
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'gallery.upload', 'en', 'Upload Photos'),
('ui', 'gallery.upload', 'es', 'Subir Fotos'),
('ui', 'gallery.remove', 'en', 'Remove Photo'),
('ui', 'gallery.remove', 'es', 'Quitar Foto'),
('ui', 'gallery.counter', 'en', '{{current}} of {{total}}'),
('ui', 'gallery.counter', 'es', '{{current}} de {{total}}'),
('ui', 'gallery.empty', 'en', 'No photos yet'),
('ui', 'gallery.empty', 'es', 'Sin fotos aún'),
('ui', 'gallery.drag_reorder', 'en', 'Drag to reorder'),
('ui', 'gallery.drag_reorder', 'es', 'Arrastre para reordenar'),
('ui', 'gallery.max_photos', 'en', 'Maximum {{max}} photos'),
('ui', 'gallery.max_photos', 'es', 'Máximo {{max}} fotos'),
('ui', 'gallery.max_size', 'en', 'Maximum file size: {{size}}MB'),
('ui', 'gallery.max_size', 'es', 'Tamaño máximo: {{size}}MB'),
('ui', 'gallery.lightbox_close', 'en', 'Close'),
('ui', 'gallery.lightbox_close', 'es', 'Cerrar'),
('ui', 'gallery.lightbox_prev', 'en', 'Previous'),
('ui', 'gallery.lightbox_prev', 'es', 'Anterior'),
('ui', 'gallery.lightbox_next', 'en', 'Next'),
('ui', 'gallery.lightbox_next', 'es', 'Siguiente');

-- Map
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'map.click_to_set', 'en', 'Click on the map to set location'),
('ui', 'map.click_to_set', 'es', 'Haga clic en el mapa para establecer ubicación'),
('ui', 'map.clear_location', 'en', 'Clear Location'),
('ui', 'map.clear_location', 'es', 'Limpiar Ubicación'),
('ui', 'map.draw_polygon', 'en', 'Draw polygon'),
('ui', 'map.draw_polygon', 'es', 'Dibujar polígono'),
('ui', 'map.edit_polygon', 'en', 'Edit polygon'),
('ui', 'map.edit_polygon', 'es', 'Editar polígono'),
('ui', 'map.delete_polygon', 'en', 'Delete polygon'),
('ui', 'map.delete_polygon', 'es', 'Eliminar polígono');

-- File
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'file.upload', 'en', 'Upload File'),
('ui', 'file.upload', 'es', 'Subir Archivo'),
('ui', 'file.remove', 'en', 'Remove File'),
('ui', 'file.remove', 'es', 'Quitar Archivo'),
('ui', 'file.no_file', 'en', 'No file uploaded'),
('ui', 'file.no_file', 'es', 'Sin archivo subido'),
('ui', 'file.max_size', 'en', 'Maximum file size: {{size}}MB'),
('ui', 'file.max_size', 'es', 'Tamaño máximo: {{size}}MB'),
('ui', 'file.download', 'en', 'Download'),
('ui', 'file.download', 'es', 'Descargar');

-- Calendar
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'calendar.today', 'en', 'Today'),
('ui', 'calendar.today', 'es', 'Hoy'),
('ui', 'calendar.month', 'en', 'Month'),
('ui', 'calendar.month', 'es', 'Mes'),
('ui', 'calendar.week', 'en', 'Week'),
('ui', 'calendar.week', 'es', 'Semana'),
('ui', 'calendar.day', 'en', 'Day'),
('ui', 'calendar.day', 'es', 'Día');

-- Reload PostgREST schema cache so new RPCs are discoverable
NOTIFY pgrst, 'reload schema';

COMMIT;
