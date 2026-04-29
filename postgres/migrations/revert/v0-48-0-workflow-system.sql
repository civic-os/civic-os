-- Revert civic_os:v0-48-0-workflow-system from pg

BEGIN;

-- ============================================================================
-- 1. DROP RPCs (public schema)
-- ============================================================================

DROP FUNCTION IF EXISTS public.grant_guided_form_permissions(NAME, INTEGER, TEXT[]);
DROP FUNCTION IF EXISTS public.rebuild_guided_form_triggers();
DROP FUNCTION IF EXISTS public.get_guided_form_progress(NAME, BIGINT);
DROP FUNCTION IF EXISTS public.cancel_guided_form(NAME, BIGINT);
DROP FUNCTION IF EXISTS public.submit_guided_form(NAME, BIGINT);
DROP FUNCTION IF EXISTS public._check_guided_form_complete(NAME, BIGINT);
DROP FUNCTION IF EXISTS public.complete_guided_form_step(NAME, BIGINT, NAME);
DROP FUNCTION IF EXISTS public.start_guided_form(NAME);
DROP FUNCTION IF EXISTS public.add_guided_form_step_condition(NAME, NAME, TEXT, NAME, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public._all_steps_condition_skipped(NAME, BIGINT);
DROP FUNCTION IF EXISTS public.ensure_guided_form_step_record(NAME, BIGINT, NAME);
DROP FUNCTION IF EXISTS public.get_guided_form_context(NAME, NAME, BIGINT);
DROP FUNCTION IF EXISTS public.register_guided_form(NAME, NAME, TEXT, NAME, VARCHAR, TEXT, BOOLEAN, NAME, NAME);


-- ============================================================================
-- 2. DROP TRIGGER FUNCTIONS (metadata schema)
-- ============================================================================

DROP TRIGGER IF EXISTS validation_change_rebuild_insert ON metadata.validations;
DROP TRIGGER IF EXISTS validation_change_rebuild_update ON metadata.validations;
DROP TRIGGER IF EXISTS validation_change_rebuild_delete ON metadata.validations;
DROP FUNCTION IF EXISTS metadata.on_validation_change_rebuild_insert();
DROP FUNCTION IF EXISTS metadata.on_validation_change_rebuild_update();
DROP FUNCTION IF EXISTS metadata.on_validation_change_rebuild_delete();

DROP FUNCTION IF EXISTS metadata.block_submitted_update() CASCADE;
DROP FUNCTION IF EXISTS metadata.enforce_guided_form_lock() CASCADE;
DROP FUNCTION IF EXISTS metadata.cascade_guided_form_delete() CASCADE;

DROP FUNCTION IF EXISTS metadata.rebuild_guided_form_constraints(NAME);


-- ============================================================================
-- 3. DROP PUBLIC VIEWS
-- ============================================================================

DROP VIEW IF EXISTS public.guided_form_progress;
DROP VIEW IF EXISTS public.schema_guided_form_steps;
DROP VIEW IF EXISTS public.schema_guided_forms;


-- ============================================================================
-- 4. RESTORE schema_entities VIEW (without guided form columns)
-- ============================================================================
-- Must DROP first because CREATE OR REPLACE VIEW cannot remove columns
-- (guided_form_key, show_in_sidebar were added in v0.48.0).

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
    (tables.table_type::text = 'VIEW'::text) AS is_view
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
-- 4a. RESTORE schema_properties VIEW (dropped by CASCADE above)
-- ============================================================================
-- This VIEW depends on schema_entities, so DROP CASCADE on schema_entities also
-- drops it. Recreate the pre-v0.48.0 version (last updated in v0.46.0).

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
  COALESCE(properties.show_inline, false) AS show_inline
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
-- 4b-pre. RESTORE schema_entity_dependencies VIEW (dropped by CASCADE above)
-- ============================================================================
-- This VIEW depends on schema_properties, so DROP CASCADE on schema_entities also
-- drops it transitively. Recreate the pre-v0.48.0 version (last updated in v0.33.0).

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

GRANT SELECT ON public.schema_entity_dependencies TO web_anon, authenticated;


-- ============================================================================
-- 4b. RESTORE upsert_entity_metadata to pre-v0.48.0 signature (without show_in_sidebar)
-- ============================================================================

DROP FUNCTION IF EXISTS public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION public.upsert_entity_metadata(
  p_table_name NAME,
  p_display_name TEXT,
  p_description TEXT,
  p_sort_order INT,
  p_search_fields TEXT[] DEFAULT NULL,
  p_show_map BOOLEAN DEFAULT FALSE,
  p_map_property_name TEXT DEFAULT NULL,
  p_show_calendar BOOLEAN DEFAULT FALSE,
  p_calendar_property_name TEXT DEFAULT NULL,
  p_calendar_color_property TEXT DEFAULT NULL,
  p_enable_notes BOOLEAN DEFAULT FALSE,
  p_supports_recurring BOOLEAN DEFAULT FALSE,
  p_recurring_property_name TEXT DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  INSERT INTO metadata.entities (
    table_name, display_name, description, sort_order,
    search_fields, show_map, map_property_name,
    show_calendar, calendar_property_name, calendar_color_property,
    enable_notes, supports_recurring, recurring_property_name
  )
  VALUES (
    p_table_name, p_display_name, p_description, p_sort_order,
    p_search_fields, p_show_map, p_map_property_name,
    p_show_calendar, p_calendar_property_name, p_calendar_color_property,
    p_enable_notes, p_supports_recurring, p_recurring_property_name
  )
  ON CONFLICT (table_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    search_fields = COALESCE(EXCLUDED.search_fields, metadata.entities.search_fields),
    show_map = EXCLUDED.show_map,
    map_property_name = EXCLUDED.map_property_name,
    show_calendar = EXCLUDED.show_calendar,
    calendar_property_name = EXCLUDED.calendar_property_name,
    calendar_color_property = EXCLUDED.calendar_color_property,
    enable_notes = EXCLUDED.enable_notes,
    supports_recurring = EXCLUDED.supports_recurring,
    recurring_property_name = EXCLUDED.recurring_property_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT) TO authenticated;


-- ============================================================================
-- 5. REMOVE metadata.entities columns (before dropping guided_forms table)
-- ============================================================================
-- Must drop guided_form_key column FIRST because it has a FK constraint
-- referencing metadata.guided_forms. The table can't be dropped while
-- the FK still exists.

ALTER TABLE metadata.entities DROP COLUMN IF EXISTS guided_form_key;
ALTER TABLE metadata.entities DROP COLUMN IF EXISTS show_in_sidebar;


-- ============================================================================
-- 5b. DELETE seeded status data and DROP metadata tables
-- ============================================================================

DELETE FROM metadata.statuses WHERE entity_type = 'guided_form';
DELETE FROM metadata.status_types WHERE entity_type = 'guided_form';

DROP TABLE IF EXISTS metadata.guided_form_step_conditions;
DROP TABLE IF EXISTS metadata.guided_form_steps;
DROP TABLE IF EXISTS metadata.guided_form_progress;
DROP TABLE IF EXISTS metadata.guided_forms;


-- ============================================================================
-- 6. DROP HELPER FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS public.is_guided_form_draft(INTEGER) CASCADE;

-- ============================================================================
-- 6b. RESTORE get_statuses_for_entity without status_key
-- ============================================================================
-- Must DROP first because return type is changing (removing status_key column).
-- CREATE OR REPLACE cannot change return type of an existing function.

DROP FUNCTION IF EXISTS public.get_statuses_for_entity(TEXT);

CREATE OR REPLACE FUNCTION public.get_statuses_for_entity(p_entity_type TEXT)
RETURNS TABLE (
  id INT,
  display_name VARCHAR(50),
  description TEXT,
  color hex_color,
  sort_order INT,
  is_initial BOOLEAN,
  is_terminal BOOLEAN
)
LANGUAGE SQL
STABLE
AS $$
  SELECT id, display_name, description, color, sort_order, is_initial, is_terminal
  FROM metadata.statuses
  WHERE entity_type = p_entity_type
  ORDER BY sort_order, display_name;
$$;


NOTIFY pgrst, 'reload schema';

COMMIT;
