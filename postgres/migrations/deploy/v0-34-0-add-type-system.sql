-- Deploy civic_os:v0-34-0-add-type-system to pg
-- requires: v0-33-0-add-nav-buttons-widget-type

BEGIN;

-- ============================================================================
-- TYPE SYSTEM (Rich Enums for Categorization)
-- ============================================================================
-- Version: v0.34.0
-- Purpose: Centralize non-workflow categorization values (types) to clean up ERD.
--          Parallel to the Status system (v0.15.0) but without workflow semantics
--          (no is_initial/is_terminal, no transitions, no causal bindings).
--
-- Use Types for: Building types, staff roles, category selectors, etc.
-- Use Statuses for: Workflow states (Pending → Approved → Completed)
--
-- Tables:
--   metadata.type_categories - Registry of valid type categories
--   metadata.types           - Type values (FK to type_categories)
--
-- Configuration:
--   metadata.properties.type_entity_type - Links columns to their type category
--
-- Pattern:
--   1. Register type category: INSERT INTO metadata.type_categories
--   2. Add type values: INSERT INTO metadata.types
--   3. Create table with FK: REFERENCES metadata.types(id)
--   4. Configure column: UPDATE metadata.properties SET type_entity_type = '...'
--   5. (Optional) Add trigger: EXECUTE FUNCTION validate_type_entity_type()
-- ============================================================================


-- ============================================================================
-- 1. TYPE_CATEGORIES REGISTRY TABLE
-- ============================================================================
-- Registry of valid type categories. Prevents typos in entity_type values.

CREATE TABLE metadata.type_categories (
  entity_type TEXT PRIMARY KEY,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata.type_categories IS
  'Registry of valid type categories for non-workflow categorization.
   Each entry defines a unique type domain (e.g., building_type, staff_role).
   Parallel to metadata.status_types but without workflow semantics.';

COMMENT ON COLUMN metadata.type_categories.entity_type IS
  'Unique identifier for this type category (e.g., building_type, staff_role)';

COMMENT ON COLUMN metadata.type_categories.description IS
  'Human-readable description of this type category';

-- Timestamps trigger
CREATE TRIGGER set_type_categories_updated_at
  BEFORE UPDATE ON metadata.type_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 2. TYPES TABLE
-- ============================================================================
-- Stores all type values for all type categories. FK to type_categories ensures
-- valid entity_type values.

CREATE TABLE metadata.types (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL REFERENCES metadata.type_categories(entity_type) ON DELETE CASCADE,
  display_name VARCHAR(50) NOT NULL,
  description TEXT,
  color hex_color DEFAULT '#3B82F6',
  sort_order INT NOT NULL DEFAULT 0,
  type_key VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unique display_name per entity_type
  UNIQUE (entity_type, display_name),
  -- Unique type_key per entity_type
  UNIQUE (entity_type, type_key)
);

COMMENT ON TABLE metadata.types IS
  'Centralized type values for non-workflow categorization. Replaces per-entity
   lookup tables (e.g., organization_types, building_types, staff_roles).
   Use simple FK to this table with trigger validation for type safety.
   Unlike statuses, types have no workflow semantics (no is_initial/is_terminal).';

COMMENT ON COLUMN metadata.types.entity_type IS
  'Type category this value belongs to. FK to type_categories ensures validity.';

COMMENT ON COLUMN metadata.types.display_name IS
  'User-visible name for this type (e.g., "Residential", "Commercial", "Clock In")';

COMMENT ON COLUMN metadata.types.color IS
  'Optional hex color for type badge display (e.g., #3B82F6 blue, #10B981 green)';

COMMENT ON COLUMN metadata.types.sort_order IS
  'Display order within the type category. Lower values appear first.';

COMMENT ON COLUMN metadata.types.type_key IS
  'Stable, snake_case identifier for programmatic reference. Auto-generated from
   display_name on insert if not provided. Use this instead of display_name in code.';

-- Performance indexes
CREATE INDEX idx_types_entity_type ON metadata.types(entity_type);
CREATE INDEX idx_types_entity_sort ON metadata.types(entity_type, sort_order);

-- Timestamps trigger
CREATE TRIGGER set_types_updated_at
  BEFORE UPDATE ON metadata.types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 3. AUTO-GENERATE type_key TRIGGER
-- ============================================================================
-- Mirror of metadata.set_status_key() from v0-25-1

CREATE OR REPLACE FUNCTION metadata.set_type_key()
RETURNS TRIGGER AS $$
BEGIN
  -- Only auto-generate if type_key is NULL or empty
  IF NEW.type_key IS NULL OR TRIM(NEW.type_key) = '' THEN
    NEW.type_key := LOWER(REGEXP_REPLACE(TRIM(NEW.display_name), '[^a-zA-Z0-9]+', '_', 'g'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_types_set_key
  BEFORE INSERT ON metadata.types
  FOR EACH ROW EXECUTE FUNCTION metadata.set_type_key();

COMMENT ON FUNCTION metadata.set_type_key() IS
  'Auto-generates type_key from display_name if not provided on INSERT.
   Converts to snake_case: "Clock In" → "clock_in"';


-- ============================================================================
-- 4. ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- type_categories: everyone reads, admins modify
ALTER TABLE metadata.type_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY type_categories_select ON metadata.type_categories
  FOR SELECT TO PUBLIC USING (true);

CREATE POLICY type_categories_insert ON metadata.type_categories
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY type_categories_update ON metadata.type_categories
  FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY type_categories_delete ON metadata.type_categories
  FOR DELETE TO authenticated USING (public.is_admin());

-- types: everyone reads, admins modify
ALTER TABLE metadata.types ENABLE ROW LEVEL SECURITY;

CREATE POLICY types_select ON metadata.types
  FOR SELECT TO PUBLIC USING (true);

CREATE POLICY types_insert ON metadata.types
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY types_update ON metadata.types
  FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY types_delete ON metadata.types
  FOR DELETE TO authenticated USING (public.is_admin());

-- Grants
GRANT SELECT ON metadata.type_categories TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.type_categories TO authenticated;

GRANT SELECT ON metadata.types TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.types TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.types_id_seq TO authenticated;


-- ============================================================================
-- 5. HELPER FUNCTIONS
-- ============================================================================

-- Get type ID by key (mirror get_status_id)
CREATE OR REPLACE FUNCTION public.get_type_id(
  p_entity_type TEXT,
  p_type_key TEXT
)
RETURNS INT
LANGUAGE SQL
STABLE
AS $$
  SELECT id FROM metadata.types
  WHERE entity_type = p_entity_type
    AND type_key = p_type_key
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_type_id(TEXT, TEXT) IS
  'Returns the type ID for a given entity_type and type_key.
   Example: SELECT get_type_id(''time_entry'', ''clock_in'');';

GRANT EXECUTE ON FUNCTION public.get_type_id(TEXT, TEXT) TO web_anon, authenticated;


-- Get all types for a category (mirror get_statuses_for_entity)
CREATE OR REPLACE FUNCTION public.get_types_for_entity(p_entity_type TEXT)
RETURNS TABLE (
  id INT,
  display_name VARCHAR(50),
  description TEXT,
  color hex_color,
  sort_order INT
)
LANGUAGE SQL
STABLE
AS $$
  SELECT id, display_name, description, color, sort_order
  FROM metadata.types
  WHERE entity_type = p_entity_type
  ORDER BY sort_order, display_name;
$$;

COMMENT ON FUNCTION public.get_types_for_entity(TEXT) IS
  'Returns all type values for a given entity_type, ordered by sort_order.
   Used by frontend to populate type dropdowns.
   Example: SELECT * FROM get_types_for_entity(''time_entry'');';

GRANT EXECUTE ON FUNCTION public.get_types_for_entity(TEXT) TO web_anon, authenticated;


-- ============================================================================
-- 6. ADD type_entity_type TO metadata.properties
-- ============================================================================

ALTER TABLE metadata.properties
  ADD COLUMN type_entity_type TEXT;

COMMENT ON COLUMN metadata.properties.type_entity_type IS
  'For Type columns: specifies the entity_type value in metadata.types
   to filter dropdown options by. Example: "time_entry" for an entry_type_id column.';


-- ============================================================================
-- 7. UPDATE schema_properties VIEW
-- ============================================================================
-- Add type_entity_type to the view so frontend can detect Type columns.

CREATE OR REPLACE VIEW public.schema_properties AS
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
  -- v0.34.0: Type system configuration
  properties.type_entity_type
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
    'Property metadata view with FK COALESCE, validation inheritance, and type system support.
     Updated in v0.34.0 to add type_entity_type for Type system detection.';

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- ============================================================================
-- 8. VALIDATION TRIGGER FUNCTION
-- ============================================================================
-- Validates type columns against their configured entity_type.
-- Mirror of validate_status_entity_type().

CREATE OR REPLACE FUNCTION public.validate_type_entity_type()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  col RECORD;
  type_val INT;
  actual_type TEXT;
BEGIN
  -- Find all type columns for this table from metadata.properties
  FOR col IN
    SELECT column_name, type_entity_type
    FROM metadata.properties
    WHERE table_name = TG_TABLE_NAME
      AND type_entity_type IS NOT NULL
  LOOP
    -- Get the type value from the NEW row
    EXECUTE format('SELECT ($1).%I', col.column_name) INTO type_val USING NEW;

    -- Validate if value is not null
    IF type_val IS NOT NULL THEN
      SELECT entity_type INTO actual_type
      FROM metadata.types
      WHERE id = type_val;

      IF actual_type IS DISTINCT FROM col.type_entity_type THEN
        RAISE EXCEPTION 'Invalid type for column %: expected entity_type %, got %',
          col.column_name, col.type_entity_type, COALESCE(actual_type, 'NULL (type not found)');
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.validate_type_entity_type() IS
  'Validates that type column values belong to the correct entity_type.
   Reads configuration from metadata.properties.type_entity_type.
   Usage: CREATE TRIGGER validate_myentity_type BEFORE INSERT OR UPDATE ON myentity
          FOR EACH ROW EXECUTE FUNCTION validate_type_entity_type();';

GRANT EXECUTE ON FUNCTION public.validate_type_entity_type() TO authenticated;


-- ============================================================================
-- 9. PUBLIC VIEW FOR POSTGREST EMBEDDING
-- ============================================================================
-- Expose metadata.types through public schema for PostgREST resource embedding.
-- This allows queries like: /time_entries?select=*,entry_type_id:types(id,display_name,color)

CREATE OR REPLACE VIEW public.types AS
SELECT
  id,
  entity_type,
  type_key,
  display_name,
  description,
  color,
  sort_order,
  created_at,
  updated_at
FROM metadata.types;

COMMENT ON VIEW public.types IS
  'Read-only view of metadata.types for PostgREST resource embedding.
   Type values are filtered by entity_type. Use get_types_for_entity(entity_type)
   RPC for dropdown population.';

GRANT SELECT ON public.types TO web_anon, authenticated;


-- ============================================================================
-- 10. UPDATE SCHEMA_CACHE_VERSIONS VIEW
-- ============================================================================
-- Add 'types' cache entry for frontend cache invalidation.

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
SELECT 'types' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.types),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.type_categories)
       ) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties, constraint_messages, introspection, and types.';

GRANT SELECT ON public.schema_cache_versions TO authenticated, web_anon;


-- ============================================================================
-- 11. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
