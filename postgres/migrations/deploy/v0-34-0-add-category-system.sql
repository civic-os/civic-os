-- Deploy civic_os:v0-34-0-add-category-system to pg
-- requires: v0-33-0-add-nav-buttons-widget-type

BEGIN;

-- ============================================================================
-- CATEGORY SYSTEM (Rich Enums for Categorization)
-- ============================================================================
-- Version: v0.34.0
-- Purpose: Centralize non-workflow categorization values (categories) to clean up ERD.
--          Parallel to the Status system (v0.15.0) but without workflow semantics
--          (no is_initial/is_terminal, no transitions, no causal bindings).
--
-- Use Categories for: Building types, staff roles, category selectors, etc.
-- Use Statuses for: Workflow states (Pending → Approved → Completed)
--
-- Tables:
--   metadata.category_groups - Registry of valid category groups
--   metadata.categories      - Category values (FK to category_groups)
--
-- Configuration:
--   metadata.properties.category_entity_type - Links columns to their category group
--
-- Pattern:
--   1. Register category group: INSERT INTO metadata.category_groups
--   2. Add category values: INSERT INTO metadata.categories
--   3. Create table with FK: REFERENCES metadata.categories(id)
--   4. Configure column: UPDATE metadata.properties SET category_entity_type = '...'
--   5. (Optional) Add trigger: EXECUTE FUNCTION validate_category_entity_type()
-- ============================================================================


-- ============================================================================
-- 1. CATEGORY_GROUPS REGISTRY TABLE
-- ============================================================================
-- Registry of valid category groups. Prevents typos in entity_type values.

CREATE TABLE metadata.category_groups (
  entity_type TEXT PRIMARY KEY,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata.category_groups IS
  'Registry of valid category groups for non-workflow categorization.
   Each entry defines a unique category domain (e.g., building_type, staff_role).
   Parallel to metadata.status_types but without workflow semantics.';

COMMENT ON COLUMN metadata.category_groups.entity_type IS
  'Unique identifier for this category group (e.g., building_type, staff_role)';

COMMENT ON COLUMN metadata.category_groups.description IS
  'Human-readable description of this category group';

-- Timestamps trigger
CREATE TRIGGER set_category_groups_updated_at
  BEFORE UPDATE ON metadata.category_groups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 2. CATEGORIES TABLE
-- ============================================================================
-- Stores all category values for all category groups. FK to category_groups ensures
-- valid entity_type values.

CREATE TABLE metadata.categories (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL REFERENCES metadata.category_groups(entity_type) ON DELETE CASCADE,
  display_name VARCHAR(50) NOT NULL,
  description TEXT,
  color hex_color DEFAULT '#3B82F6',
  sort_order INT NOT NULL DEFAULT 0,
  category_key VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unique display_name per entity_type
  UNIQUE (entity_type, display_name),
  -- Unique category_key per entity_type
  UNIQUE (entity_type, category_key)
);

COMMENT ON TABLE metadata.categories IS
  'Centralized category values for non-workflow categorization. Replaces per-entity
   lookup tables (e.g., organization_types, building_types, staff_roles).
   Use simple FK to this table with trigger validation for category safety.
   Unlike statuses, categories have no workflow semantics (no is_initial/is_terminal).';

COMMENT ON COLUMN metadata.categories.entity_type IS
  'Category group this value belongs to. FK to category_groups ensures validity.';

COMMENT ON COLUMN metadata.categories.display_name IS
  'User-visible name for this category (e.g., "Residential", "Commercial", "Clock In")';

COMMENT ON COLUMN metadata.categories.color IS
  'Optional hex color for category badge display (e.g., #3B82F6 blue, #10B981 green)';

COMMENT ON COLUMN metadata.categories.sort_order IS
  'Display order within the category group. Lower values appear first.';

COMMENT ON COLUMN metadata.categories.category_key IS
  'Stable, snake_case identifier for programmatic reference. Auto-generated from
   display_name on insert if not provided. Use this instead of display_name in code.';

-- Performance indexes
CREATE INDEX idx_categories_entity_type ON metadata.categories(entity_type);
CREATE INDEX idx_categories_entity_sort ON metadata.categories(entity_type, sort_order);

-- Timestamps trigger
CREATE TRIGGER set_categories_updated_at
  BEFORE UPDATE ON metadata.categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 3. AUTO-GENERATE category_key TRIGGER
-- ============================================================================
-- Mirror of metadata.set_status_key() from v0-25-1

CREATE OR REPLACE FUNCTION metadata.set_category_key()
RETURNS TRIGGER AS $$
BEGIN
  -- Only auto-generate if category_key is NULL or empty
  IF NEW.category_key IS NULL OR TRIM(NEW.category_key) = '' THEN
    NEW.category_key := LOWER(REGEXP_REPLACE(TRIM(NEW.display_name), '[^a-zA-Z0-9]+', '_', 'g'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_categories_set_key
  BEFORE INSERT ON metadata.categories
  FOR EACH ROW EXECUTE FUNCTION metadata.set_category_key();

COMMENT ON FUNCTION metadata.set_category_key() IS
  'Auto-generates category_key from display_name if not provided on INSERT.
   Converts to snake_case: "Clock In" → "clock_in"';


-- ============================================================================
-- 4. ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- category_groups: everyone reads, admins modify
ALTER TABLE metadata.category_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY category_groups_select ON metadata.category_groups
  FOR SELECT TO PUBLIC USING (true);

CREATE POLICY category_groups_insert ON metadata.category_groups
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY category_groups_update ON metadata.category_groups
  FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY category_groups_delete ON metadata.category_groups
  FOR DELETE TO authenticated USING (public.is_admin());

-- categories: everyone reads, admins modify
ALTER TABLE metadata.categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY categories_select ON metadata.categories
  FOR SELECT TO PUBLIC USING (true);

CREATE POLICY categories_insert ON metadata.categories
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY categories_update ON metadata.categories
  FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY categories_delete ON metadata.categories
  FOR DELETE TO authenticated USING (public.is_admin());

-- Grants
GRANT SELECT ON metadata.category_groups TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.category_groups TO authenticated;

GRANT SELECT ON metadata.categories TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.categories TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.categories_id_seq TO authenticated;


-- ============================================================================
-- 5. HELPER FUNCTIONS
-- ============================================================================

-- Get category ID by key (mirror get_status_id)
CREATE OR REPLACE FUNCTION public.get_category_id(
  p_entity_type TEXT,
  p_category_key TEXT
)
RETURNS INT
LANGUAGE SQL
STABLE
AS $$
  SELECT id FROM metadata.categories
  WHERE entity_type = p_entity_type
    AND category_key = p_category_key
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_category_id(TEXT, TEXT) IS
  'Returns the category ID for a given entity_type and category_key.
   Example: SELECT get_category_id(''time_entry'', ''clock_in'');';

GRANT EXECUTE ON FUNCTION public.get_category_id(TEXT, TEXT) TO web_anon, authenticated;


-- Get all categories for a group (mirror get_statuses_for_entity)
CREATE OR REPLACE FUNCTION public.get_categories_for_entity(p_entity_type TEXT)
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
  FROM metadata.categories
  WHERE entity_type = p_entity_type
  ORDER BY sort_order, display_name;
$$;

COMMENT ON FUNCTION public.get_categories_for_entity(TEXT) IS
  'Returns all category values for a given entity_type, ordered by sort_order.
   Used by frontend to populate category dropdowns.
   Example: SELECT * FROM get_categories_for_entity(''time_entry'');';

GRANT EXECUTE ON FUNCTION public.get_categories_for_entity(TEXT) TO web_anon, authenticated;


-- ============================================================================
-- 6. ADD category_entity_type TO metadata.properties
-- ============================================================================

ALTER TABLE metadata.properties
  ADD COLUMN category_entity_type TEXT;

COMMENT ON COLUMN metadata.properties.category_entity_type IS
  'For Category columns: specifies the entity_type value in metadata.categories
   to filter dropdown options by. Example: "time_entry" for an entry_type_id column.';


-- ============================================================================
-- 7. UPDATE schema_properties VIEW
-- ============================================================================
-- Add category_entity_type to the view so frontend can detect Category columns.

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
  -- v0.34.0: Category system configuration
  properties.category_entity_type
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
    'Property metadata view with FK COALESCE, validation inheritance, and category system support.
     Updated in v0.34.0 to add category_entity_type for Category system detection.';

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- ============================================================================
-- 8. VALIDATION TRIGGER FUNCTION
-- ============================================================================
-- Validates category columns against their configured entity_type.
-- Mirror of validate_status_entity_type().

CREATE OR REPLACE FUNCTION public.validate_category_entity_type()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  col RECORD;
  category_val INT;
  actual_category TEXT;
BEGIN
  -- Find all category columns for this table from metadata.properties
  FOR col IN
    SELECT column_name, category_entity_type
    FROM metadata.properties
    WHERE table_name = TG_TABLE_NAME
      AND category_entity_type IS NOT NULL
  LOOP
    -- Get the category value from the NEW row
    EXECUTE format('SELECT ($1).%I', col.column_name) INTO category_val USING NEW;

    -- Validate if value is not null
    IF category_val IS NOT NULL THEN
      SELECT entity_type INTO actual_category
      FROM metadata.categories
      WHERE id = category_val;

      IF actual_category IS DISTINCT FROM col.category_entity_type THEN
        RAISE EXCEPTION 'Invalid category for column %: expected entity_type %, got %',
          col.column_name, col.category_entity_type, COALESCE(actual_category, 'NULL (category not found)');
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.validate_category_entity_type() IS
  'Validates that category column values belong to the correct entity_type.
   Reads configuration from metadata.properties.category_entity_type.
   Usage: CREATE TRIGGER validate_myentity_category BEFORE INSERT OR UPDATE ON myentity
          FOR EACH ROW EXECUTE FUNCTION validate_category_entity_type();';

GRANT EXECUTE ON FUNCTION public.validate_category_entity_type() TO authenticated;


-- ============================================================================
-- 9. PUBLIC VIEW FOR POSTGREST EMBEDDING
-- ============================================================================
-- Expose metadata.categories through public schema for PostgREST resource embedding.
-- This allows queries like: /time_entries?select=*,entry_type_id:categories(id,display_name,color)

CREATE OR REPLACE VIEW public.categories AS
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

COMMENT ON VIEW public.categories IS
  'Read-only view of metadata.categories for PostgREST resource embedding.
   Category values are filtered by entity_type. Use get_categories_for_entity(entity_type)
   RPC for dropdown population.';

GRANT SELECT ON public.categories TO web_anon, authenticated;


-- ============================================================================
-- 10. UPDATE SCHEMA_CACHE_VERSIONS VIEW
-- ============================================================================
-- Add 'categories' cache entry for frontend cache invalidation.

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

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties, constraint_messages, introspection, and categories.';

GRANT SELECT ON public.schema_cache_versions TO authenticated, web_anon;


-- ============================================================================
-- 11. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
