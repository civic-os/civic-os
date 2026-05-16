-- Revert civic_os:v0-53-0-options-filter-column from pg

BEGIN;

-- ============================================================================
-- 1. RESTORE schema_properties VIEW (v0.46.0 definition, without options_filter_column)
-- NOTE: DROP + CREATE required because CREATE OR REPLACE cannot remove columns.
-- CASCADE drops schema_entity_dependencies (depends on schema_properties) — recreated in step 3.
-- ============================================================================

DROP VIEW IF EXISTS public.schema_properties CASCADE;
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

COMMENT ON VIEW public.schema_properties IS
    'Property metadata view with FK COALESCE, validation inheritance, category system, options_source_rpc, fk_search_modal, and show_inline support.
     Updated in v0.46.0 to add show_inline flag for inline M:M positioning.';

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- ============================================================================
-- 2. RESTORE schema_m2m_properties VIEW (v0.46.0 definition)
-- NOTE: DROP + CREATE required because CREATE OR REPLACE cannot remove columns.
-- ============================================================================

DROP VIEW IF EXISTS public.schema_m2m_properties;
CREATE VIEW public.schema_m2m_properties AS
SELECT
  p.table_name,
  p.column_name,
  p.options_source_rpc,
  p.depends_on_columns,
  COALESCE(p.fk_search_modal, false) AS fk_search_modal,
  COALESCE(p.show_inline, false) AS show_inline,
  p.display_name,
  p.sort_order,
  p.column_width,
  p.show_on_list,
  p.show_on_create,
  p.show_on_edit,
  p.show_on_detail
FROM metadata.properties p
WHERE p.column_name LIKE '%\_m2m';

COMMENT ON VIEW public.schema_m2m_properties IS
    'Metadata for synthetic M:M columns. Bridges metadata.properties flags '
    '(options_source_rpc, fk_search_modal, show_inline) to virtual M:M columns '
    'that don''t exist in information_schema.columns. Added in v0.46.0.';

GRANT SELECT ON public.schema_m2m_properties TO web_anon, authenticated;


-- ============================================================================
-- 3. RECREATE schema_entity_dependencies (dropped by CASCADE in step 1)
-- Definition from v0-33-0-causal-bindings (latest migration defining this view)
-- ============================================================================

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
-- 4. DROP options_filter_column from metadata.properties
-- ============================================================================

ALTER TABLE metadata.properties DROP COLUMN options_filter_column;


-- ============================================================================
-- 5. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
