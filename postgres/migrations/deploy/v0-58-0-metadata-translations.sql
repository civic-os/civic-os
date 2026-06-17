-- Deploy civic_os:v0-58-0-metadata-translations to pg
-- Phase 2 i18n: Wrap translatable VIEW columns with metadata.t() so instance-specific
-- metadata (entity names, property labels, status names, etc.) renders in the user's
-- preferred language via the Accept-Language header.
-- requires: v0-57-0-add-i18n

BEGIN;


-- ============================================================================
-- 0. UPDATE metadata.current_locale() for PostgREST 13+
-- ============================================================================
-- PostgREST 13 stores request headers in a single JSON GUC (request.headers)
-- rather than individual GUCs per header. The original v0.57.0 function read
-- request.header.accept-language which doesn't work because PostgreSQL GUC
-- names can't contain hyphens. Updated to read from the JSON headers blob
-- with a fallback to the legacy GUC for backwards compatibility.

CREATE OR REPLACE FUNCTION metadata.current_locale()
RETURNS TEXT AS $$
  SELECT COALESCE(
    -- PostgREST 13+: headers as JSON blob
    NULLIF(current_setting('request.headers', true)::json->>'accept-language', ''),
    -- Legacy fallback (PostgREST < 12 with db-use-legacy-gucs)
    NULLIF(current_setting('request.header.accept-language', true), ''),
    'en'
  );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION metadata.current_locale() IS
    'Returns the current request locale from Accept-Language header, defaulting to en. '
    'Updated in v0.58.0 to read from PostgREST 13 JSON headers blob.';


-- ============================================================================
-- 1a. RECREATE schema_entities VIEW with t() wrapping
-- ============================================================================
-- Wraps display_name and description with metadata.t('entity', ...).
-- Source key: table_name.display_name / table_name.description
-- NOTE: DROP + CREATE (not CREATE OR REPLACE) required because metadata.t()
-- returns TEXT with collation "C", but the original columns used "default".
-- schema_properties depends on schema_entities, so drop it first (recreated in 1b).

DROP VIEW IF EXISTS public.schema_properties CASCADE;
DROP VIEW IF EXISTS public.schema_entities CASCADE;

CREATE VIEW public.schema_entities AS
SELECT
    metadata.t('entity', tables.table_name::text || '.display_name',
      COALESCE(entities.display_name, tables.table_name::text)) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    metadata.t('entity', tables.table_name::text || '.description',
      entities.description) AS description,
    entities.search_fields,
    COALESCE(entities.show_map, false) AS show_map,
    entities.map_property_name,
    tables.table_name,
    has_permission(tables.table_name::text, 'create'::text) AS insert,
    has_permission(tables.table_name::text, 'read'::text) AS "select",
    has_permission(tables.table_name::text, 'update'::text) AS update,
    has_permission(tables.table_name::text, 'delete'::text) AS delete,
    COALESCE(entities.show_calendar, false) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    COALESCE(entities.enable_notes, false) AS enable_notes,
    COALESCE(entities.supports_recurring, false) AS supports_recurring,
    entities.recurring_property_name,
    (tables.table_type::text = 'VIEW'::text) AS is_view,
    entities.guided_form_key,
    COALESCE(entities.show_in_sidebar, true) AS show_in_sidebar,
    entities.map_color_property,
    COALESCE(entities.is_rich_junction, false) AS is_rich_junction,
    entities.fulltext_search_column,
    entities.substring_search_column
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text IN ('BASE TABLE', 'VIEW')
  AND (tables.table_type::text = 'BASE TABLE' OR entities.table_name IS NOT NULL)
  AND NOT (
    tables.table_type::text = 'VIEW' AND (
      tables.table_name::text LIKE 'schema_%'
      OR tables.table_name::text IN (
        'time_slot_series', 'time_slot_instances', 'civic_os_users', 'managed_users',
        'gallery_admin', 'photo_galleries', 'photo_gallery_files', 'photo_gallery_config'
      )
    )
  )
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view. Updated in v0.58.0 to wrap display_name and description '
    'with metadata.t() for multi-language support.';

GRANT SELECT ON public.schema_entities TO web_anon, authenticated;


-- ============================================================================
-- 1b. RECREATE schema_properties VIEW with t() wrapping
-- ============================================================================
-- Wraps display_name and description with metadata.t('property', ...).
-- Source key: table_name.column_name.display_name / table_name.column_name.description

-- schema_properties was already dropped above (1a) due to dependency on schema_entities
CREATE VIEW public.schema_properties AS
SELECT
  columns.table_catalog,
  columns.table_schema,
  columns.table_name,
  columns.column_name,
  metadata.t('property', columns.table_name::text || '.' || columns.column_name::text || '.display_name',
    COALESCE(properties.display_name, initcap(replace(columns.column_name::text, '_', ' ')))) AS display_name,
  metadata.t('property', columns.table_name::text || '.' || columns.column_name::text || '.description',
    properties.description) AS description,
  COALESCE(properties.sort_order, columns.ordinal_position::integer) AS sort_order,
  properties.column_width,
  COALESCE(properties.sortable, true) AS sortable,
  COALESCE(properties.filterable, false) AS filterable,
  COALESCE(properties.show_on_list,
    CASE WHEN columns.column_name IN ('id', 'civic_os_text_search', 'created_at', 'updated_at') THEN false ELSE true END
  ) AS show_on_list,
  COALESCE(properties.show_on_create,
    CASE WHEN columns.column_name IN ('id', 'civic_os_text_search', 'created_at', 'updated_at') THEN false ELSE true END
  ) AS show_on_create,
  COALESCE(properties.show_on_edit,
    CASE WHEN columns.column_name IN ('id', 'civic_os_text_search', 'created_at', 'updated_at') THEN false ELSE true END
  ) AS show_on_edit,
  COALESCE(properties.show_on_detail,
    CASE WHEN columns.column_name IN ('id', 'civic_os_text_search') THEN false
         WHEN columns.column_name IN ('created_at', 'updated_at') THEN true ELSE true END
  ) AS show_on_detail,
  columns.column_default,
  columns.is_nullable::text = 'YES' AS is_nullable,
  columns.data_type,
  columns.character_maximum_length,
  columns.udt_schema,
  COALESCE(pg_type_info.domain_name, columns.udt_name) AS udt_name,
  columns.is_self_referencing::text = 'YES' AS is_self_referencing,
  columns.is_identity::text = 'YES' AS is_identity,
  columns.is_generated::text = 'ALWAYS' AS is_generated,
  columns.is_updatable::text = 'YES' AS is_updatable,
  -- v0.28.0: 3-way COALESCE for FK detection
  COALESCE(table_relations.join_schema, view_relations.join_schema) AS join_schema,
  COALESCE(
    properties.join_table,
    view_relations.join_table,
    table_relations.join_table
  ) AS join_table,
  COALESCE(
    properties.join_column,
    view_relations.join_column,
    table_relations.join_column
  ) AS join_column,
  CASE
    WHEN columns.udt_name IN ('geography', 'geometry') THEN
      SUBSTRING(pg_type_info.formatted_type FROM '\(([A-Za-z]+)')
    ELSE NULL
  END AS geography_type,
  -- v0.28.0: Validation inheritance for VIEWs
  COALESCE(
    direct_validations.validation_rules,
    inherited_validations.validation_rules,
    '[]'::jsonb
  ) AS validation_rules,
  properties.status_entity_type,
  COALESCE(properties.is_recurring, false) AS is_recurring,
  -- v0.34.0: Category system configuration
  properties.category_entity_type,
  -- v0.44.0: Options source RPC configuration
  properties.options_source_rpc,
  properties.depends_on_columns,
  -- v0.45.0: FK search modal flag
  COALESCE(properties.fk_search_modal, false) AS fk_search_modal,
  -- v0.46.0: Inline M:M positioning
  COALESCE(properties.show_inline, false) AS show_inline,
  -- v0.53.0: Computed column filter for FK search modal
  properties.options_filter_column
FROM information_schema.columns
-- Table FK detection (existing pattern)
LEFT JOIN (SELECT * FROM schema_relations_func()) table_relations
  ON columns.table_schema::name = table_relations.src_schema
  AND columns.table_name::name = table_relations.src_table
  AND columns.column_name::name = table_relations.src_column
-- VIEW FK inheritance (v0.28.0)
LEFT JOIN (SELECT * FROM schema_view_relations_func()) view_relations
  ON columns.table_name::name = view_relations.view_name
  AND columns.column_name::name = view_relations.view_column
-- Manual metadata override
LEFT JOIN metadata.properties
  ON properties.table_name = columns.table_name::name
  AND properties.column_name = columns.column_name::name
-- Type info for domains/geography
LEFT JOIN (
  SELECT c.relname AS table_name, a.attname AS column_name,
         format_type(a.atttypid, a.atttypmod) AS formatted_type,
         CASE WHEN t.typtype = 'd' THEN t.typname ELSE NULL END AS domain_name
  FROM pg_attribute a
  JOIN pg_class c ON a.attrelid = c.oid
  JOIN pg_namespace n ON c.relnamespace = n.oid
  LEFT JOIN pg_type t ON a.atttypid = t.oid
  WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
) pg_type_info
  ON pg_type_info.table_name = columns.table_name::name
  AND pg_type_info.column_name = columns.column_name::name
-- Direct validation rules
LEFT JOIN (
  SELECT table_name, column_name,
         jsonb_agg(jsonb_build_object('type', validation_type, 'value', validation_value, 'message', error_message) ORDER BY sort_order) AS validation_rules
  FROM metadata.validations GROUP BY table_name, column_name
) direct_validations
  ON direct_validations.table_name = columns.table_name::name
  AND direct_validations.column_name = columns.column_name::name
-- Inherited validation rules from base table (for VIEWs, v0.28.0)
LEFT JOIN (SELECT * FROM schema_view_validations_func()) inherited_validations
  ON columns.table_name::name = inherited_validations.view_name
  AND columns.column_name::name = inherited_validations.view_column
WHERE columns.table_schema::name = 'public'
  AND columns.table_name::name IN (SELECT table_name FROM schema_entities);

COMMENT ON VIEW public.schema_properties IS
    'Property metadata view with FK COALESCE, validation inheritance, and all feature flags.
     Updated in v0.58.0 to wrap display_name and description with metadata.t() for i18n.';

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- ============================================================================
-- 1b2. RECREATE schema_entity_dependencies VIEW (dropped by CASCADE above)
-- ============================================================================
-- This VIEW depends on schema_properties (uses it in CTEs for M:M junction detection).
-- Latest definition from v0-33-0-causal-bindings.sql.

CREATE VIEW public.schema_entity_dependencies
WITH (security_invoker = true) AS
WITH
fk_deps AS (
    SELECT DISTINCT
        source_class.relname::NAME AS source_entity,
        target_class.relname::NAME AS target_entity,
        'foreign_key'::TEXT AS relationship_type,
        a.attname::TEXT AS via_column,
        NULL::NAME AS via_object,
        'structural'::TEXT AS category
    FROM pg_constraint con
    JOIN pg_class source_class ON source_class.oid = con.conrelid
    JOIN pg_class target_class ON target_class.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = source_class.relnamespace
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
    WHERE con.contype = 'f'
      AND ns.nspname = 'public'
),
m2m_deps AS (
    WITH junction_candidates AS (
        SELECT
            sp.table_name AS junction_table,
            array_agg(sp.column_name ORDER BY sp.column_name) AS fk_columns,
            array_agg(sp.join_table ORDER BY sp.column_name) AS related_tables
        FROM public.schema_properties sp
        WHERE sp.join_table IS NOT NULL
          AND sp.join_schema = 'public'
        GROUP BY sp.table_name
        HAVING COUNT(*) = 2
    ),
    validated_junctions AS (
        SELECT jc.*
        FROM junction_candidates jc
        WHERE NOT EXISTS (
            SELECT 1 FROM public.schema_properties sp
            WHERE sp.table_name = jc.junction_table
              AND sp.column_name NOT IN (
                  'id', 'created_at', 'updated_at',
                  jc.fk_columns[1], jc.fk_columns[2]
              )
        )
    )
    SELECT
        vj.related_tables[1]::NAME AS source_entity,
        vj.related_tables[2]::NAME AS target_entity,
        'many_to_many'::TEXT AS relationship_type,
        vj.fk_columns[1]::TEXT AS via_column,
        vj.junction_table::NAME AS via_object,
        'structural'::TEXT AS category
    FROM validated_junctions vj
    UNION ALL
    SELECT
        vj.related_tables[2]::NAME AS source_entity,
        vj.related_tables[1]::NAME AS target_entity,
        'many_to_many'::TEXT AS relationship_type,
        vj.fk_columns[2]::TEXT AS via_column,
        vj.junction_table::NAME AS via_object,
        'structural'::TEXT AS category
    FROM validated_junctions vj
),
rpc_deps AS (
    SELECT DISTINCT
        ea.table_name::NAME AS source_entity,
        ree.entity_table::NAME AS target_entity,
        'rpc_modifies'::TEXT AS relationship_type,
        NULL::TEXT AS via_column,
        rf.function_name::NAME AS via_object,
        'causal'::TEXT AS category
    FROM metadata.entity_actions ea
    JOIN metadata.rpc_functions rf ON rf.function_name = ea.rpc_function
    JOIN metadata.rpc_entity_effects ree ON ree.function_name = rf.function_name
    WHERE ree.entity_table != ea.table_name
      AND ree.effect_type != 'read'
),
trigger_deps AS (
    SELECT DISTINCT
        dt.table_name::NAME AS source_entity,
        tee.affected_table::NAME AS target_entity,
        'trigger_modifies'::TEXT AS relationship_type,
        NULL::TEXT AS via_column,
        dt.function_name::NAME AS via_object,
        'causal'::TEXT AS category
    FROM metadata.database_triggers dt
    JOIN metadata.trigger_entity_effects tee
        ON tee.trigger_name = dt.trigger_name
        AND tee.trigger_table = dt.table_name
        AND tee.trigger_schema = dt.schema_name
    WHERE tee.affected_table != dt.table_name
),
property_trigger_deps AS (
    SELECT DISTINCT
        pct.table_name::NAME AS source_entity,
        ree.entity_table::NAME AS target_entity,
        'property_trigger_modifies'::TEXT AS relationship_type,
        pct.property_name::TEXT AS via_column,
        pct.function_name::NAME AS via_object,
        'causal'::TEXT AS category
    FROM metadata.property_change_triggers pct
    JOIN metadata.rpc_entity_effects ree ON ree.function_name = pct.function_name
    WHERE ree.entity_table != pct.table_name
      AND ree.effect_type != 'read'
      AND pct.is_enabled = true
),
status_transition_deps AS (
    SELECT DISTINCT
        st.entity_type::NAME AS source_entity,
        ree.entity_table::NAME AS target_entity,
        'status_transition_modifies'::TEXT AS relationship_type,
        NULL::TEXT AS via_column,
        st.on_transition_rpc::NAME AS via_object,
        'causal'::TEXT AS category
    FROM metadata.status_transitions st
    JOIN metadata.rpc_entity_effects ree ON ree.function_name = st.on_transition_rpc
    WHERE st.on_transition_rpc IS NOT NULL
      AND st.is_enabled = true
      AND ree.effect_type != 'read'
),
all_deps AS (
    SELECT * FROM fk_deps
    UNION ALL SELECT * FROM m2m_deps
    UNION ALL SELECT * FROM rpc_deps
    UNION ALL SELECT * FROM trigger_deps
    UNION ALL SELECT * FROM property_trigger_deps
    UNION ALL SELECT * FROM status_transition_deps
)
SELECT *
FROM all_deps
WHERE public.has_permission(source_entity::TEXT, 'read')
  AND public.has_permission(target_entity::TEXT, 'read');

COMMENT ON VIEW public.schema_entity_dependencies IS
    'Unified view of all entity relationships: structural (FK, M:M) and causal (RPC, trigger, property change, status transition effects).';

GRANT SELECT ON public.schema_entity_dependencies TO authenticated, web_anon;


-- ============================================================================
-- 1c. RECREATE statuses VIEW with t() wrapping
-- ============================================================================
-- Wraps display_name and description with metadata.t('status', ...).
-- Source key: entity_type.status_key.display_name

DROP VIEW IF EXISTS public.statuses;

CREATE VIEW public.statuses AS
SELECT
  id,
  entity_type,
  status_key,
  metadata.t('status', entity_type || '.' || status_key || '.display_name', display_name) AS display_name,
  metadata.t('status', entity_type || '.' || status_key || '.description', description) AS description,
  color,
  sort_order,
  is_initial,
  is_terminal,
  created_at,
  updated_at
FROM metadata.statuses;

COMMENT ON VIEW public.statuses IS
  'Read-only view of metadata.statuses for PostgREST resource embedding.
   Includes status_key for programmatic reference. Updated in v0.58.0 to wrap
   display_name and description with metadata.t() for multi-language support.';

GRANT SELECT ON public.statuses TO web_anon, authenticated;


-- ============================================================================
-- 1d. RECREATE categories VIEW with t() wrapping
-- ============================================================================
-- Wraps display_name and description with metadata.t('category', ...).
-- Source key: entity_type.category_key.display_name

DROP VIEW IF EXISTS public.categories;

CREATE VIEW public.categories AS
SELECT
  id,
  entity_type,
  category_key,
  metadata.t('category', entity_type || '.' || category_key || '.display_name', display_name) AS display_name,
  metadata.t('category', entity_type || '.' || category_key || '.description', description) AS description,
  color,
  sort_order,
  created_at,
  updated_at
FROM metadata.categories;

COMMENT ON VIEW public.categories IS
  'Read-only view of metadata.categories for PostgREST resource embedding.
   Updated in v0.58.0 to wrap display_name and description with metadata.t()
   for multi-language support.';

GRANT SELECT ON public.categories TO web_anon, authenticated;


-- ============================================================================
-- 1e. RECREATE static_text VIEW with t() wrapping
-- ============================================================================
-- Wraps content with metadata.t('static_text', ...).
-- Source key: table_name.id

DROP VIEW IF EXISTS public.static_text;

CREATE VIEW public.static_text AS
SELECT
    id,
    table_name,
    metadata.t('static_text', table_name || '.' || id::text, content) AS content,
    sort_order,
    column_width,
    show_on_detail,
    show_on_create,
    show_on_edit,
    created_at,
    updated_at
FROM metadata.static_text;

COMMENT ON VIEW public.static_text IS
    'Read/write view of metadata.static_text for PostgREST access.
     RLS on underlying table handles permissions (everyone reads, admins modify).
     Updated in v0.58.0 to wrap content with metadata.t() for multi-language support.';

-- Preserve original grants
GRANT SELECT ON public.static_text TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.static_text TO authenticated;


-- ============================================================================
-- 1f. RECREATE schema_entity_actions VIEW with t() wrapping
-- ============================================================================
-- Wraps 5 action-level text columns + 2 param-level columns with metadata.t().
-- Action source key: table_name.action_name.column
-- Param source key: table_name.action_name.param_name.column

DROP VIEW IF EXISTS public.schema_entity_actions;

CREATE VIEW public.schema_entity_actions
WITH (security_invoker = true)
AS
SELECT
    ea.id,
    ea.table_name,
    ea.action_name,
    metadata.t('action', ea.table_name || '.' || ea.action_name || '.display_name', ea.display_name) AS display_name,
    metadata.t('action', ea.table_name || '.' || ea.action_name || '.description', ea.description) AS description,
    ea.icon,
    ea.button_style,
    ea.sort_order,
    ea.rpc_function,
    ea.requires_confirmation,
    metadata.t('action', ea.table_name || '.' || ea.action_name || '.confirmation_message', ea.confirmation_message) AS confirmation_message,
    ea.visibility_condition,
    ea.enabled_condition,
    metadata.t('action', ea.table_name || '.' || ea.action_name || '.disabled_tooltip', ea.disabled_tooltip) AS disabled_tooltip,
    metadata.t('action', ea.table_name || '.' || ea.action_name || '.success_message', ea.default_success_message) AS default_success_message,
    ea.default_navigate_to,
    ea.refresh_after_action,
    ea.show_on_detail,
    -- Permission check using entity_action_roles
    public.has_entity_action_permission(ea.id) AS can_execute,
    -- Embedded parameters (v0.32.0, updated v0.41.1, v0.54.0, v0.55.0, v0.58.0)
    COALESCE(
        (SELECT json_agg(
            json_build_object(
                'id', p.id,
                'param_name', p.param_name,
                'display_name', metadata.t('action_param', ea.table_name || '.' || ea.action_name || '.' || p.param_name || '.display_name', p.display_name),
                'param_type', p.param_type,
                'required', p.required,
                'sort_order', p.sort_order,
                'placeholder', metadata.t('action_param', ea.table_name || '.' || ea.action_name || '.' || p.param_name || '.placeholder', p.placeholder),
                'default_value', p.default_value,
                'join_table', p.join_table,
                'join_column', p.join_column,
                'status_entity_type', p.status_entity_type,
                'category_entity_type', p.category_entity_type,
                'file_type', p.file_type,
                'options_source_rpc', p.options_source_rpc,
                'depends_on_params', p.depends_on_params,
                'target_column', p.target_column
            ) ORDER BY p.sort_order
        )
        FROM metadata.entity_action_params p
        WHERE p.entity_action_id = ea.id),
        '[]'::json
    ) AS parameters
FROM metadata.entity_actions ea
WHERE ea.show_on_detail = true
ORDER BY ea.table_name, ea.sort_order;

COMMENT ON VIEW public.schema_entity_actions IS
    'Read-only view of entity actions with permission check results and embedded parameters.
     can_execute indicates whether the current user can execute the action.
     parameters contains JSON array of action parameter definitions.
     Uses security_invoker to evaluate permissions as the calling user.
     Updated in v0.58.0 to wrap text columns with metadata.t() for i18n.';

GRANT SELECT ON public.schema_entity_actions TO web_anon, authenticated;


-- ============================================================================
-- 1g. RECREATE schema_guided_form_steps VIEW with t() wrapping
-- ============================================================================
-- Wraps display_name and description with metadata.t('guided_form_step', ...).
-- Source key: guided_form_key.step_key.display_name

DROP VIEW IF EXISTS public.schema_guided_form_steps;

CREATE VIEW public.schema_guided_form_steps AS
SELECT
    ws.id,
    ws.guided_form_key,
    ws.step_key,
    metadata.t('guided_form_step', ws.guided_form_key || '.' || ws.step_key || '.display_name', ws.display_name) AS display_name,
    metadata.t('guided_form_step', ws.guided_form_key || '.' || ws.step_key || '.description', ws.description) AS description,
    ws.step_table,
    ws.parent_fk_column,
    ws.step_order,
    ws.can_skip,
    ws.track_key,
    COALESCE(
        (SELECT jsonb_agg(
            jsonb_build_object(
                'id', c.id,
                'condition_type', c.condition_type,
                'field', c.field,
                'operator', c.operator,
                'value', c.value
            ) ORDER BY c.sort_order
         ) FROM metadata.guided_form_step_conditions c WHERE c.guided_form_step_id = ws.id),
        '[]'::jsonb
    ) AS conditions
FROM metadata.guided_form_steps ws
ORDER BY ws.guided_form_key, ws.step_order;

ALTER VIEW public.schema_guided_form_steps SET (security_invoker = true);
GRANT SELECT ON public.schema_guided_form_steps TO web_anon, authenticated;

COMMENT ON VIEW public.schema_guided_form_steps IS
    'Guided form steps with conditions embedded as JSONB. Updated in v0.58.0 to wrap
     display_name and description with metadata.t() for multi-language support.';


-- ============================================================================
-- 1h. ADD MISSING ENGLISH UI KEYS to metadata.translations
-- ============================================================================
-- Phase 1 extracted 251 keys to en.translations.ts but only seeded 188 in the migration.
-- Insert the 63 missing keys for both en and es locales.

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
-- Actions
('ui', 'action.pay_now', 'en', 'Pay Now'),
('ui', 'action.pay_now', 'es', 'Pagar Ahora'),

-- Detail page
('ui', 'detail.add_note', 'en', 'Add a note...'),
('ui', 'detail.add_note', 'es', 'Agregar una nota...'),
('ui', 'detail.back_to_list', 'en', 'Back to {{entity}}'),
('ui', 'detail.back_to_list', 'es', 'Volver a {{entity}}'),
('ui', 'detail.confirm_action', 'en', 'Are you sure you want to perform this action?'),
('ui', 'detail.confirm_action', 'es', '¿Está seguro de que desea realizar esta acción?'),
('ui', 'detail.confirm_delete_named', 'en', 'Are you sure you want to delete "{{name}}"? This action cannot be undone.'),
('ui', 'detail.confirm_delete_named', 'es', '¿Está seguro de que desea eliminar "{{name}}"? Esta acción no se puede deshacer.'),
('ui', 'detail.details', 'en', 'Details'),
('ui', 'detail.details', 'es', 'Detalles'),
('ui', 'detail.large_relationship', 'en', 'This relationship has many records. Use the button below to view them all.'),
('ui', 'detail.large_relationship', 'es', 'Esta relación tiene muchos registros. Use el botón de abajo para verlos todos.'),
('ui', 'detail.no_boundary', 'en', 'No boundary'),
('ui', 'detail.no_boundary', 'es', 'Sin límite'),
('ui', 'detail.no_records', 'en', 'No records found'),
('ui', 'detail.no_records', 'es', 'No se encontraron registros'),
('ui', 'detail.not_found_message', 'en', 'Record not found or you do not have permission to view it.'),
('ui', 'detail.not_found_message', 'es', 'Registro no encontrado o no tiene permiso para verlo.'),
('ui', 'detail.processing', 'en', 'Processing...'),
('ui', 'detail.processing', 'es', 'Procesando...'),
('ui', 'detail.sign_in_message', 'en', 'Sign in to view this record.'),
('ui', 'detail.sign_in_message', 'es', 'Inicie sesión para ver este registro.'),
('ui', 'detail.system_note', 'en', 'System'),
('ui', 'detail.system_note', 'es', 'Sistema'),
('ui', 'detail.view_all_count', 'en', 'View all {{count}}'),
('ui', 'detail.view_all_count', 'es', 'Ver todos {{count}}'),
('ui', 'detail.view_all_records', 'en', 'View all {{count}} records'),
('ui', 'detail.view_all_records', 'es', 'Ver todos los {{count}} registros'),
('ui', 'detail.view_entity', 'en', 'View {{entity}}'),
('ui', 'detail.view_entity', 'es', 'Ver {{entity}}'),
('ui', 'detail.view_record', 'en', 'View record'),
('ui', 'detail.view_record', 'es', 'Ver registro'),
('ui', 'detail.view_source', 'en', 'View source code'),
('ui', 'detail.view_source', 'es', 'Ver código fuente'),

-- File
('ui', 'file.uploaded', 'en', 'Uploaded'),
('ui', 'file.uploaded', 'es', 'Subido'),
('ui', 'file.uploading', 'en', 'Uploading...'),
('ui', 'file.uploading', 'es', 'Subiendo...'),

-- Form
('ui', 'form.back_to_record', 'en', 'Back to record'),
('ui', 'form.back_to_record', 'es', 'Volver al registro'),
('ui', 'form.create_another', 'en', 'Create another {{entity}}'),
('ui', 'form.create_another', 'es', 'Crear otro {{entity}}'),
('ui', 'form.created', 'en', 'Created!'),
('ui', 'form.created', 'es', '¡Creado!'),
('ui', 'form.creating', 'en', 'Creating...'),
('ui', 'form.creating', 'es', 'Creando...'),
('ui', 'form.field_required', 'en', '{{field}} is required'),
('ui', 'form.field_required', 'es', '{{field}} es obligatorio'),
('ui', 'form.fix_errors', 'en', 'Please fix the errors below'),
('ui', 'form.fix_errors', 'es', 'Por favor corrija los errores a continuación'),
('ui', 'form.no', 'en', 'No'),
('ui', 'form.no', 'es', 'No'),
('ui', 'form.no_create_permission', 'en', 'You don''t have permission to create records for this entity.'),
('ui', 'form.no_create_permission', 'es', 'No tiene permiso para crear registros para esta entidad.'),
('ui', 'form.no_edit_permission', 'en', 'You don''t have permission to edit this record.'),
('ui', 'form.no_edit_permission', 'es', 'No tiene permiso para editar este registro.'),
('ui', 'form.phone_hint', 'en', 'Format: (555) 123-4567'),
('ui', 'form.phone_hint', 'es', 'Formato: (555) 123-4567'),
('ui', 'form.record_not_found', 'en', 'Record not found.'),
('ui', 'form.record_not_found', 'es', 'Registro no encontrado.'),
('ui', 'form.saved', 'en', 'Saved!'),
('ui', 'form.saved', 'es', '¡Guardado!'),
('ui', 'form.select_category', 'en', 'Select a category...'),
('ui', 'form.select_category', 'es', 'Seleccionar categoría...'),
('ui', 'form.select_status', 'en', 'Select a status...'),
('ui', 'form.select_status', 'es', 'Seleccionar estado...'),
('ui', 'form.sign_in_message', 'en', 'Sign in to create and edit records.'),
('ui', 'form.sign_in_message', 'es', 'Inicie sesión para crear y editar registros.'),
('ui', 'form.sign_in_to_create', 'en', 'Sign in to create'),
('ui', 'form.sign_in_to_create', 'es', 'Inicie sesión para crear'),
('ui', 'form.sign_in_to_edit', 'en', 'Sign in to edit'),
('ui', 'form.sign_in_to_edit', 'es', 'Inicie sesión para editar'),
('ui', 'form.success', 'en', 'Success!'),
('ui', 'form.success', 'es', '¡Éxito!'),
('ui', 'form.try_again', 'en', 'Try again'),
('ui', 'form.try_again', 'es', 'Intentar de nuevo'),
('ui', 'form.view_created', 'en', 'View {{entity}}'),
('ui', 'form.view_created', 'es', 'Ver {{entity}}'),
('ui', 'form.yes', 'en', 'Yes'),
('ui', 'form.yes', 'es', 'Sí'),

-- Guided form
('ui', 'guided_form.continue', 'en', 'Continue'),
('ui', 'guided_form.continue', 'es', 'Continuar'),
('ui', 'guided_form.edit_locked', 'en', 'Form is locked'),
('ui', 'guided_form.edit_locked', 'es', 'Formulario bloqueado'),
('ui', 'guided_form.save_and_continue', 'en', 'Save and continue'),
('ui', 'guided_form.save_and_continue', 'es', 'Guardar y continuar'),
('ui', 'guided_form.start_new', 'en', 'Start new'),
('ui', 'guided_form.start_new', 'es', 'Comenzar nuevo'),
('ui', 'guided_form.submit_another', 'en', 'Submit another'),
('ui', 'guided_form.submit_another', 'es', 'Enviar otro'),
('ui', 'guided_form.submitted_message', 'en', '{{entity}} submitted successfully!'),
('ui', 'guided_form.submitted_message', 'es', '¡{{entity}} enviado con éxito!'),
('ui', 'guided_form.unable_to_start', 'en', 'Unable to start'),
('ui', 'guided_form.unable_to_start', 'es', 'No se puede iniciar'),

-- Import/Export
('ui', 'import_export.exporting', 'en', 'Exporting...'),
('ui', 'import_export.exporting', 'es', 'Exportando...'),
('ui', 'import_export.include_notes', 'en', 'Include notes'),
('ui', 'import_export.include_notes', 'es', 'Incluir notas'),
('ui', 'import_export.include_notes_description', 'en', 'Export all entity notes and system notes with this record.'),
('ui', 'import_export.include_notes_description', 'es', 'Exportar todas las notas de la entidad y notas del sistema con este registro.'),

-- List
('ui', 'list.active_filters', 'en', 'Active filters'),
('ui', 'list.active_filters', 'es', 'Filtros activos'),
('ui', 'list.no_entries', 'en', 'No entries'),
('ui', 'list.no_entries', 'es', 'Sin registros'),
('ui', 'list.no_entries_message', 'en', 'There are no records to display.'),
('ui', 'list.no_entries_message', 'es', 'No hay registros para mostrar.'),
('ui', 'list.no_results_filtered', 'en', 'No results match your filters. Try adjusting your search criteria.'),
('ui', 'list.no_results_filtered', 'es', 'Ningún resultado coincide con sus filtros. Intente ajustar sus criterios de búsqueda.'),
('ui', 'list.sign_in_message', 'en', 'Sign in to view this list.'),
('ui', 'list.sign_in_message', 'es', 'Inicie sesión para ver esta lista.'),
('ui', 'list.sign_in_page_message', 'en', 'Sign in to view this page.'),
('ui', 'list.sign_in_page_message', 'es', 'Inicie sesión para ver esta página.'),

-- Navigation
('ui', 'nav.close_menu', 'en', 'Close navigation menu'),
('ui', 'nav.close_menu', 'es', 'Cerrar menú de navegación'),
('ui', 'nav.open_menu', 'en', 'Open navigation menu'),
('ui', 'nav.open_menu', 'es', 'Abrir menú de navegación'),

-- Pagination
('ui', 'pagination.to', 'en', 'to'),
('ui', 'pagination.to', 'es', 'a'),

-- Theme
('ui', 'theme.change', 'en', 'Change theme'),
('ui', 'theme.change', 'es', 'Cambiar tema'),

-- Time
('ui', 'time.end', 'en', 'End'),
('ui', 'time.end', 'es', 'Fin'),
('ui', 'time.start', 'en', 'Start'),
('ui', 'time.start', 'es', 'Inicio')

ON CONFLICT (source_type, source_key, locale) DO NOTHING;


-- NOTE: Instance-specific metadata translations (entity, property, status)
-- belong in the example's init-scripts/, not in core migrations.
-- See examples/pothole/init-scripts/13_spanish_translations.sql


-- ============================================================================
-- 1i. UPDATE schema_cache_versions VIEW
-- ============================================================================
-- Add 'translations' cache entry tracking metadata.translations.updated_at.

DROP VIEW IF EXISTS public.schema_cache_versions;

CREATE VIEW public.schema_cache_versions AS
SELECT 'entities' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.entities),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permissions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.roles),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permission_roles)
       ) AS version
UNION ALL
SELECT 'properties' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.properties),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.validations)
       ) AS version
UNION ALL
SELECT 'constraint_messages' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.constraint_messages) AS version
UNION ALL
SELECT 'introspection' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_functions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.database_triggers),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.trigger_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.notification_triggers)
       ) AS version
UNION ALL
SELECT 'categories' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.categories),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.category_groups)
       ) AS version
UNION ALL
SELECT 'translations' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.translations) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties,
     constraint_messages, introspection, categories, and translations.';

GRANT SELECT ON public.schema_cache_versions TO authenticated, web_anon;


COMMIT;
