-- Deploy civic_os:v0-15-0-add-status-type to pg
-- requires: v0-14-0-add-payment-admin

BEGIN;

-- ============================================================================
-- STATUS TYPE SYSTEM
-- ============================================================================
-- Version: v0.15.0
-- Purpose: Centralize simple multi-select values (statuses) to clean up ERD
--          by replacing per-entity lookup tables with a single metadata.statuses
--          table. Uses simple FK with trigger-based validation for type safety.
--
-- Tables:
--   metadata.status_types - Registry of valid status categories
--   metadata.statuses     - Status values (FK to status_types)
--
-- Configuration:
--   metadata.properties.status_entity_type - Links columns to their status type
--
-- Pattern:
--   1. Register status type: INSERT INTO metadata.status_types
--   2. Add status values: INSERT INTO metadata.statuses
--   3. Create table with FK: REFERENCES metadata.statuses(id)
--   4. Configure column: UPDATE metadata.properties SET status_entity_type = '...'
--   5. (Optional) Add trigger: EXECUTE FUNCTION validate_status_entity_type()
-- ============================================================================


-- ============================================================================
-- 1. STATUS_TYPES REGISTRY TABLE
-- ============================================================================
-- Registry of valid status categories. Prevents typos in entity_type values.
-- Convention: 'tablename_columnname' (e.g., 'issues_status', 'issues_priority')

CREATE TABLE metadata.status_types (
  entity_type TEXT PRIMARY KEY,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata.status_types IS
  'Registry of valid status categories. Each entry defines a unique status domain
   (e.g., issues_status, issues_priority). Prevents typos via FK constraint from
   metadata.statuses. Convention: tablename_columnname format.';

COMMENT ON COLUMN metadata.status_types.entity_type IS
  'Unique identifier for this status category. Convention: tablename_columnname
   (e.g., issues_status, issues_priority, workpackages_status)';

COMMENT ON COLUMN metadata.status_types.description IS
  'Human-readable description of this status category';

-- Timestamps trigger
CREATE TRIGGER set_status_types_updated_at
  BEFORE UPDATE ON metadata.status_types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 2. STATUSES TABLE
-- ============================================================================
-- Stores all status values for all status types. FK to status_types ensures
-- valid entity_type values.

CREATE TABLE metadata.statuses (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL REFERENCES metadata.status_types(entity_type) ON DELETE CASCADE,
  display_name VARCHAR(50) NOT NULL,
  description TEXT,
  color hex_color DEFAULT '#3B82F6',
  sort_order INT NOT NULL DEFAULT 0,
  is_initial BOOLEAN NOT NULL DEFAULT FALSE,
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unique display_name per entity_type
  UNIQUE (entity_type, display_name)
);

COMMENT ON TABLE metadata.statuses IS
  'Centralized status values replacing per-entity lookup tables (e.g., IssueStatus,
   WorkPackageStatus). Use simple FK to this table with trigger validation for
   type safety. Cleans up ERD by consolidating status tables.';

COMMENT ON COLUMN metadata.statuses.entity_type IS
  'Status category this value belongs to. FK to status_types ensures validity.';

COMMENT ON COLUMN metadata.statuses.display_name IS
  'User-visible name for this status (e.g., "New", "In Progress", "Resolved")';

COMMENT ON COLUMN metadata.statuses.color IS
  'Optional hex color for status badge display (e.g., #3B82F6 blue, #10B981 green)';

COMMENT ON COLUMN metadata.statuses.sort_order IS
  'Display order within the status type. Lower values appear first.';

COMMENT ON COLUMN metadata.statuses.is_initial IS
  'If TRUE, this is the default status for new records. Only ONE per entity_type.';

COMMENT ON COLUMN metadata.statuses.is_terminal IS
  'If TRUE, records in this status cannot transition to other statuses (future use).';

-- Ensure only ONE initial status per entity_type
CREATE UNIQUE INDEX idx_statuses_single_initial
  ON metadata.statuses (entity_type) WHERE is_initial = TRUE;

-- Performance indexes
CREATE INDEX idx_statuses_entity_type ON metadata.statuses(entity_type);
CREATE INDEX idx_statuses_entity_sort ON metadata.statuses(entity_type, sort_order);

-- Timestamps trigger
CREATE TRIGGER set_statuses_updated_at
  BEFORE UPDATE ON metadata.statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 3. ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- status_types: everyone reads, admins modify
ALTER TABLE metadata.status_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY status_types_select ON metadata.status_types
  FOR SELECT TO PUBLIC USING (true);

CREATE POLICY status_types_insert ON metadata.status_types
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY status_types_update ON metadata.status_types
  FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY status_types_delete ON metadata.status_types
  FOR DELETE TO authenticated USING (public.is_admin());

-- statuses: everyone reads, admins modify
ALTER TABLE metadata.statuses ENABLE ROW LEVEL SECURITY;

CREATE POLICY statuses_select ON metadata.statuses
  FOR SELECT TO PUBLIC USING (true);

CREATE POLICY statuses_insert ON metadata.statuses
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY statuses_update ON metadata.statuses
  FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY statuses_delete ON metadata.statuses
  FOR DELETE TO authenticated USING (public.is_admin());

-- Grants
GRANT SELECT ON metadata.status_types TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.status_types TO authenticated;

GRANT SELECT ON metadata.statuses TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.statuses TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.statuses_id_seq TO authenticated;


-- ============================================================================
-- 4. HELPER FUNCTIONS
-- ============================================================================

-- Get initial status ID for an entity_type (for new record defaults)
CREATE OR REPLACE FUNCTION public.get_initial_status(p_entity_type TEXT)
RETURNS INT
LANGUAGE SQL
STABLE
AS $$
  SELECT id FROM metadata.statuses
  WHERE entity_type = p_entity_type AND is_initial = TRUE
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_initial_status(TEXT) IS
  'Returns the ID of the initial status for a given entity_type.
   Used to set default status when creating new records.
   Example: SELECT get_initial_status(''issues_status'');';

GRANT EXECUTE ON FUNCTION public.get_initial_status(TEXT) TO web_anon, authenticated;


-- Get all statuses for an entity_type (for dropdown population)
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

COMMENT ON FUNCTION public.get_statuses_for_entity(TEXT) IS
  'Returns all status values for a given entity_type, ordered by sort_order.
   Used by frontend to populate status dropdowns.
   Example: SELECT * FROM get_statuses_for_entity(''issues_status'');';

GRANT EXECUTE ON FUNCTION public.get_statuses_for_entity(TEXT) TO web_anon, authenticated;


-- Get distinct entity_types with status counts (for Admin UI)
CREATE OR REPLACE FUNCTION public.get_status_entity_types()
RETURNS TABLE (
  entity_type TEXT,
  description TEXT,
  status_count BIGINT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  SELECT
    st.entity_type,
    st.description,
    COUNT(s.id) AS status_count
  FROM metadata.status_types st
  LEFT JOIN metadata.statuses s ON s.entity_type = st.entity_type
  GROUP BY st.entity_type, st.description
  ORDER BY st.entity_type;
$$;

COMMENT ON FUNCTION public.get_status_entity_types() IS
  'Returns all registered status types with their status counts.
   Used by Admin UI to populate entity_type dropdown.
   Example: SELECT * FROM get_status_entity_types();';

GRANT EXECUTE ON FUNCTION public.get_status_entity_types() TO authenticated;


-- ============================================================================
-- 5. ADD status_entity_type TO metadata.properties
-- ============================================================================
-- This column links a status column to its entity_type in metadata.statuses.
-- Frontend uses this to filter dropdown options.

ALTER TABLE metadata.properties
  ADD COLUMN status_entity_type TEXT;

COMMENT ON COLUMN metadata.properties.status_entity_type IS
  'For Status type columns: specifies the entity_type value in metadata.statuses
   to filter dropdown options by. Example: "issues_status" for a status_id column.';


-- ============================================================================
-- 6. UPDATE schema_properties VIEW
-- ============================================================================
-- Add status_entity_type to the view so frontend can detect Status type columns.

CREATE OR REPLACE VIEW public.schema_properties AS
SELECT
  columns.table_catalog,
  columns.table_schema,
  columns.table_name,
  columns.column_name,
  COALESCE(
    properties.display_name,
    initcap(replace(columns.column_name::text, '_'::text, ' '::text))
  ) AS display_name,
  properties.description,
  COALESCE(
    properties.sort_order,
    columns.ordinal_position::integer
  ) AS sort_order,
  properties.column_width,
  COALESCE(properties.sortable, true) AS sortable,
  COALESCE(properties.filterable, false) AS filterable,
  -- Smart defaults: system fields hidden by default, but can be overridden via metadata
  COALESCE(properties.show_on_list,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search', 'created_at', 'updated_at')
      THEN false
      ELSE true
    END
  ) AS show_on_list,
  COALESCE(properties.show_on_create,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search', 'created_at', 'updated_at')
      THEN false
      ELSE true
    END
  ) AS show_on_create,
  COALESCE(properties.show_on_edit,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search', 'created_at', 'updated_at')
      THEN false
      ELSE true
    END
  ) AS show_on_edit,
  COALESCE(properties.show_on_detail,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search') THEN false
         WHEN columns.column_name::text IN ('created_at', 'updated_at') THEN true
         ELSE true
    END
  ) AS show_on_detail,
  columns.column_default,
  columns.is_nullable::text = 'YES'::text AS is_nullable,
  columns.data_type,
  columns.character_maximum_length,
  columns.udt_schema,
  COALESCE(pg_type_info.domain_name, columns.udt_name) AS udt_name,
  columns.is_self_referencing::text = 'YES'::text AS is_self_referencing,
  columns.is_identity::text = 'YES'::text AS is_identity,
  columns.is_generated::text = 'ALWAYS'::text AS is_generated,
  columns.is_updatable::text = 'YES'::text AS is_updatable,
  relations.join_schema,
  relations.join_table,
  relations.join_column,
  -- Extract geography/geometry subtype (e.g., 'Point' from 'geography(Point,4326)')
  CASE
    WHEN columns.udt_name::text IN ('geography', 'geometry') THEN
      SUBSTRING(
        pg_type_info.formatted_type
        FROM '\(([A-Za-z]+)'
      )
    ELSE NULL
  END AS geography_type,
  -- Validation rules as JSONB array
  COALESCE(
    validation_rules_agg.validation_rules,
    '[]'::jsonb
  ) AS validation_rules,
  -- Status type configuration (v0.15.0)
  properties.status_entity_type
FROM information_schema.columns
LEFT JOIN (
  SELECT
    schema_relations_func.src_schema,
    schema_relations_func.src_table,
    schema_relations_func.src_column,
    schema_relations_func.constraint_schema,
    schema_relations_func.constraint_name,
    schema_relations_func.join_schema,
    schema_relations_func.join_table,
    schema_relations_func.join_column
  FROM schema_relations_func() schema_relations_func(
    src_schema,
    src_table,
    src_column,
    constraint_schema,
    constraint_name,
    join_schema,
    join_table,
    join_column
  )
) relations
  ON columns.table_schema::name = relations.src_schema
  AND columns.table_name::name = relations.src_table
  AND columns.column_name::name = relations.src_column
LEFT JOIN metadata.properties
  ON properties.table_name = columns.table_name::name
  AND properties.column_name = columns.column_name::name
LEFT JOIN (
  SELECT
    c.relname AS table_name,
    a.attname AS column_name,
    format_type(a.atttypid, a.atttypmod) AS formatted_type,
    CASE WHEN t.typtype = 'd' THEN t.typname ELSE NULL END AS domain_name
  FROM pg_attribute a
  JOIN pg_class c ON a.attrelid = c.oid
  JOIN pg_namespace n ON c.relnamespace = n.oid
  LEFT JOIN pg_type t ON a.atttypid = t.oid
  WHERE n.nspname = 'public'
    AND a.attnum > 0
    AND NOT a.attisdropped
) pg_type_info
  ON pg_type_info.table_name = columns.table_name::name
  AND pg_type_info.column_name = columns.column_name::name
LEFT JOIN (
  SELECT
    table_name,
    column_name,
    jsonb_agg(
      jsonb_build_object(
        'type', validation_type,
        'value', validation_value,
        'message', error_message
      )
      ORDER BY sort_order
    ) AS validation_rules
  FROM metadata.validations
  GROUP BY table_name, column_name
) validation_rules_agg
  ON validation_rules_agg.table_name = columns.table_name::name
  AND validation_rules_agg.column_name = columns.column_name::name
WHERE columns.table_schema::name = 'public'::name
  AND columns.table_name::name IN (
    SELECT schema_entities.table_name FROM schema_entities
  );

ALTER VIEW public.schema_properties SET (security_invoker = true);

COMMENT ON VIEW public.schema_properties IS
  'Exposes property metadata including status_entity_type for Status type detection.
   Frontend detects Status type when: join_table = ''statuses'' AND join_schema = ''metadata''
   AND status_entity_type IS NOT NULL. Updated in v0.15.0 to add status_entity_type.';


-- ============================================================================
-- 7. VALIDATION TRIGGER FUNCTION
-- ============================================================================
-- Framework-provided reusable function that validates status columns against
-- their configured entity_type. Integrators create per-table triggers that
-- call this function.

CREATE OR REPLACE FUNCTION public.validate_status_entity_type()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  col RECORD;
  status_val INT;
  actual_type TEXT;
BEGIN
  -- Find all status columns for this table from metadata.properties
  FOR col IN
    SELECT column_name, status_entity_type
    FROM metadata.properties
    WHERE table_name = TG_TABLE_NAME
      AND status_entity_type IS NOT NULL
  LOOP
    -- Get the status value from the NEW row
    EXECUTE format('SELECT ($1).%I', col.column_name) INTO status_val USING NEW;

    -- Validate if value is not null
    IF status_val IS NOT NULL THEN
      SELECT entity_type INTO actual_type
      FROM metadata.statuses
      WHERE id = status_val;

      IF actual_type IS DISTINCT FROM col.status_entity_type THEN
        RAISE EXCEPTION 'Invalid status for column %: expected entity_type %, got %',
          col.column_name, col.status_entity_type, COALESCE(actual_type, 'NULL (status not found)');
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.validate_status_entity_type() IS
  'Validates that status column values belong to the correct entity_type.
   Reads configuration from metadata.properties.status_entity_type.
   Usage: CREATE TRIGGER validate_myentity_status BEFORE INSERT OR UPDATE ON myentity
          FOR EACH ROW EXECUTE FUNCTION validate_status_entity_type();';

GRANT EXECUTE ON FUNCTION public.validate_status_entity_type() TO authenticated;


-- ============================================================================
-- 8. PUBLIC VIEW FOR POSTGREST EMBEDDING
-- ============================================================================
-- Expose metadata.statuses through public schema for PostgREST resource embedding.
-- This allows queries like: /reservation_requests?select=*,status:statuses(display_name,color)
-- RLS on metadata.statuses handles permissions (SELECT allowed for all, modify for admins only).

CREATE OR REPLACE VIEW public.statuses AS
SELECT
  id,
  entity_type,
  display_name,
  description,
  color,
  sort_order,
  is_initial,
  is_terminal,
  created_at,
  updated_at
FROM metadata.statuses;

COMMENT ON VIEW public.statuses IS
  'Read-only view of metadata.statuses for PostgREST resource embedding.
   Status values are filtered by entity_type (e.g., ''reservation_request'', ''issue'').
   Use get_statuses_for_entity(entity_type) RPC for dropdown population.';

-- Grant SELECT to all roles (RLS on underlying table handles permissions)
GRANT SELECT ON public.statuses TO web_anon, authenticated;


-- ============================================================================
-- 9. UPDATE SCHEMA_CACHE_VERSIONS VIEW
-- ============================================================================
-- Add 'statuses' cache entry so frontend knows when to refresh cached status data.
-- When admins add/modify statuses, the frontend will detect the change and refresh.

DROP VIEW IF EXISTS public.schema_cache_versions;

CREATE VIEW public.schema_cache_versions AS
SELECT
  'entities' as cache_name,
  GREATEST(
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.entities),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.properties),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.validations)
  ) as last_updated
UNION ALL
SELECT
  'constraint_messages' as cache_name,
  (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.constraint_messages) as last_updated
UNION ALL
SELECT
  'statuses' as cache_name,
  GREATEST(
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.statuses),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.status_types)
  ) as last_updated;

COMMENT ON VIEW public.schema_cache_versions IS
  'Cache versioning for frontend schema data. Returns max(updated_at) timestamp for each cache bucket.
   Frontend checks these timestamps to detect stale caches and trigger refresh.
   Caches: entities (schema metadata), constraint_messages (error messages), statuses (status definitions).';

GRANT SELECT ON public.schema_cache_versions TO web_anon, authenticated;


-- ============================================================================
-- 10. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
