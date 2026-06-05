-- Revert civic_os:v0-58-0-metadata-translations from pg
-- Restores all VIEWs to their pre-t() definitions.

BEGIN;


-- ============================================================================
-- Restore metadata.current_locale() to v0.57.0 version
-- ============================================================================

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
-- Restore schema_entities VIEW (from v0-55-2)
-- ============================================================================
-- DROP + CREATE (not CREATE OR REPLACE) required due to collation mismatch
-- between metadata.t() output (collation "C") and original columns ("default").

DROP VIEW IF EXISTS public.schema_properties CASCADE;
DROP VIEW IF EXISTS public.schema_entities CASCADE;

CREATE VIEW public.schema_entities AS
SELECT
    COALESCE(entities.display_name, tables.table_name::text) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    entities.description,
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

GRANT SELECT ON public.schema_entities TO web_anon, authenticated;


-- ============================================================================
-- Restore schema_properties VIEW (from v0-53-0)
-- ============================================================================
-- schema_properties was already dropped above due to dependency on schema_entities

CREATE VIEW public.schema_properties AS
SELECT
  columns.table_catalog,
  columns.table_schema,
  columns.table_name,
  columns.column_name,
  COALESCE(properties.display_name, initcap(replace(columns.column_name::text, '_', ' '))) AS display_name,
  properties.description,
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
  COALESCE(
    direct_validations.validation_rules,
    inherited_validations.validation_rules,
    '[]'::jsonb
  ) AS validation_rules,
  properties.status_entity_type,
  COALESCE(properties.is_recurring, false) AS is_recurring,
  properties.category_entity_type,
  properties.options_source_rpc,
  properties.depends_on_columns,
  COALESCE(properties.fk_search_modal, false) AS fk_search_modal,
  COALESCE(properties.show_inline, false) AS show_inline,
  properties.options_filter_column
FROM information_schema.columns
LEFT JOIN (SELECT * FROM schema_relations_func()) table_relations
  ON columns.table_schema::name = table_relations.src_schema
  AND columns.table_name::name = table_relations.src_table
  AND columns.column_name::name = table_relations.src_column
LEFT JOIN (SELECT * FROM schema_view_relations_func()) view_relations
  ON columns.table_name::name = view_relations.view_name
  AND columns.column_name::name = view_relations.view_column
LEFT JOIN metadata.properties
  ON properties.table_name = columns.table_name::name
  AND properties.column_name = columns.column_name::name
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
LEFT JOIN (
  SELECT table_name, column_name,
         jsonb_agg(jsonb_build_object('type', validation_type, 'value', validation_value, 'message', error_message) ORDER BY sort_order) AS validation_rules
  FROM metadata.validations GROUP BY table_name, column_name
) direct_validations
  ON direct_validations.table_name = columns.table_name::name
  AND direct_validations.column_name = columns.column_name::name
LEFT JOIN (SELECT * FROM schema_view_validations_func()) inherited_validations
  ON columns.table_name::name = inherited_validations.view_name
  AND columns.column_name::name = inherited_validations.view_column
WHERE columns.table_schema::name = 'public'
  AND columns.table_name::name IN (SELECT table_name FROM schema_entities);

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- ============================================================================
-- Restore schema_entity_dependencies VIEW (dropped by CASCADE above)
-- ============================================================================
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
-- Restore statuses VIEW (from v0-25-1)
-- ============================================================================

DROP VIEW IF EXISTS public.statuses;

CREATE VIEW public.statuses AS
SELECT
  id,
  entity_type,
  status_key,
  display_name,
  description,
  color,
  sort_order,
  is_initial,
  is_terminal,
  created_at,
  updated_at
FROM metadata.statuses;

GRANT SELECT ON public.statuses TO web_anon, authenticated;


-- ============================================================================
-- Restore categories VIEW (from v0-34-0)
-- ============================================================================

DROP VIEW IF EXISTS public.categories;

CREATE VIEW public.categories AS
SELECT
  id,
  entity_type,
  category_key,
  display_name,
  description,
  color,
  sort_order,
  created_at,
  updated_at
FROM metadata.categories;

GRANT SELECT ON public.categories TO web_anon, authenticated;


-- ============================================================================
-- Restore static_text VIEW (from v0-17-0)
-- ============================================================================

DROP VIEW IF EXISTS public.static_text;

CREATE VIEW public.static_text AS
SELECT
    id,
    table_name,
    content,
    sort_order,
    column_width,
    show_on_detail,
    show_on_create,
    show_on_edit,
    created_at,
    updated_at
FROM metadata.static_text;

GRANT SELECT ON public.static_text TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.static_text TO authenticated;


-- ============================================================================
-- Restore schema_entity_actions VIEW (from v0-55-0)
-- ============================================================================

DROP VIEW IF EXISTS public.schema_entity_actions;

CREATE VIEW public.schema_entity_actions
WITH (security_invoker = true)
AS
SELECT
    ea.id,
    ea.table_name,
    ea.action_name,
    ea.display_name,
    ea.description,
    ea.icon,
    ea.button_style,
    ea.sort_order,
    ea.rpc_function,
    ea.requires_confirmation,
    ea.confirmation_message,
    ea.visibility_condition,
    ea.enabled_condition,
    ea.disabled_tooltip,
    ea.default_success_message,
    ea.default_navigate_to,
    ea.refresh_after_action,
    ea.show_on_detail,
    public.has_entity_action_permission(ea.id) AS can_execute,
    COALESCE(
        (SELECT json_agg(
            json_build_object(
                'id', p.id,
                'param_name', p.param_name,
                'display_name', p.display_name,
                'param_type', p.param_type,
                'required', p.required,
                'sort_order', p.sort_order,
                'placeholder', p.placeholder,
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

GRANT SELECT ON public.schema_entity_actions TO web_anon, authenticated;


-- ============================================================================
-- Restore schema_guided_form_steps VIEW (from v0-48-0)
-- ============================================================================

DROP VIEW IF EXISTS public.schema_guided_form_steps;

CREATE VIEW public.schema_guided_form_steps AS
SELECT
    ws.id,
    ws.guided_form_key,
    ws.step_key,
    ws.display_name,
    ws.description,
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


-- ============================================================================
-- Restore schema_cache_versions VIEW (from v0-34-0, without translations)
-- ============================================================================

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
       ) AS version;

GRANT SELECT ON public.schema_cache_versions TO authenticated, web_anon;


-- ============================================================================
-- Remove seeded translations (keep table and functions from v0.57.0)
-- ============================================================================
-- Remove pothole metadata translations and missing UI keys added in this migration.
-- The v0.57.0 migration handles its own seeds.

DELETE FROM metadata.translations WHERE source_type IN ('entity', 'property', 'status', 'category', 'static_text', 'action', 'action_param', 'guided_form_step');

DELETE FROM metadata.translations WHERE source_type = 'ui' AND source_key IN (
  'action.pay_now', 'detail.add_note', 'detail.back_to_list', 'detail.confirm_action',
  'detail.confirm_delete_named', 'detail.details', 'detail.large_relationship',
  'detail.no_boundary', 'detail.no_records', 'detail.not_found_message', 'detail.processing',
  'detail.sign_in_message', 'detail.system_note', 'detail.view_all_count',
  'detail.view_all_records', 'detail.view_entity', 'detail.view_record', 'detail.view_source',
  'file.uploaded', 'file.uploading', 'form.back_to_record', 'form.create_another',
  'form.created', 'form.creating', 'form.field_required', 'form.fix_errors', 'form.no',
  'form.no_create_permission', 'form.no_edit_permission', 'form.phone_hint',
  'form.record_not_found', 'form.saved', 'form.select_category', 'form.select_status',
  'form.sign_in_message', 'form.sign_in_to_create', 'form.sign_in_to_edit', 'form.success',
  'form.try_again', 'form.view_created', 'form.yes',
  'guided_form.continue', 'guided_form.edit_locked', 'guided_form.save_and_continue',
  'guided_form.start_new', 'guided_form.submit_another', 'guided_form.submitted_message',
  'guided_form.unable_to_start',
  'import_export.exporting', 'import_export.include_notes', 'import_export.include_notes_description',
  'list.active_filters', 'list.no_entries', 'list.no_entries_message',
  'list.no_results_filtered', 'list.sign_in_message', 'list.sign_in_page_message',
  'nav.close_menu', 'nav.open_menu', 'pagination.to', 'theme.change',
  'time.end', 'time.start'
);


COMMIT;
