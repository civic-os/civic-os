-- Deploy civic_os:v0-85-0-dimensions-registry to pg
-- requires: v0-85-0-tree-parent-guard
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- The dimensions registry: lookup tables that reports are cut by (program, site, department, ward). Owners
-- create their table wherever they like and register it; every FK to a registered table is a reporting axis.
-- Design: docs/notes/IMPACT_REPORTING_DESIGN.md (Dimensions, decisions 1, 1b, 7, 9, and the 2026-11-19 build
-- amendments: decisions 10 to 12).
--
--   metadata.dimensions               the registry; BIGINT keys; an active column is required
--   public.schema_dimensions          security_invoker view for clients
--   metadata.dimension_delete_guard() refuses every DELETE and TRUNCATE on a registered table (rows are retired)
--   metadata.dimension_default_fill() fills a NULL FK to the dimension with its active default on INSERT
--   public.register_dimension()       validates, installs the guards and fill triggers, upserts the row
--   public.set_dimension_default()    sets or clears the default after install
--   public.dimension_subtree()        the value and its descendants, with the CYCLE clause
--
-- register_dimension() generates DDL (triggers) as the function owner, so the admin JWT path that
-- _is_db_admin() admits is narrowed (decision 9): over the API only base tables in public are registered and
-- fill triggers go only on referencing base tables in public. The deployment role (metadata._is_deployer())
-- may register any schema. Identifiers are quoted and only the fixed triggers are installed.

BEGIN;

-- ============================================================================
-- 1. metadata.dimensions
-- ============================================================================

CREATE TABLE metadata.dimensions (
    dimension_key      TEXT PRIMARY KEY,
    display_name       TEXT NOT NULL,
    table_schema       NAME NOT NULL,
    table_name         NAME NOT NULL,
    key_column         NAME NOT NULL DEFAULT 'id',
    label_column       NAME NOT NULL DEFAULT 'display_name',
    parent_column      NAME,
    active_column      NAME NOT NULL,
    external_id_column NAME,
    default_value_id   BIGINT,
    hide_when_single   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order         INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT dimensions_key_format CHECK (dimension_key ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT dimensions_display_name_not_empty CHECK (btrim(display_name) <> ''),
    CONSTRAINT dimensions_one_per_table UNIQUE (table_schema, table_name)
);

COMMENT ON TABLE metadata.dimensions IS
    'Registered dimension tables: lookup tables reports are cut by. Every FK from an entity to a registered table is a reporting axis. Written only by register_dimension() and set_dimension_default(). Added in v0.85.0.';
COMMENT ON COLUMN metadata.dimensions.key_column IS 'BIGINT key column (primary key or unique), checked at registration.';
COMMENT ON COLUMN metadata.dimensions.parent_column IS 'Self-referencing BIGINT FK for a hierarchical dimension; NULL for a flat one. Guarded by tree_parent_guard.';
COMMENT ON COLUMN metadata.dimensions.active_column IS 'Boolean column; rows are retired (false), never deleted.';
COMMENT ON COLUMN metadata.dimensions.external_id_column IS 'Column holding an external system id (an accounting class, for example).';
COMMENT ON COLUMN metadata.dimensions.default_value_id IS 'Row filled into an empty FK on insert, unless it is retired. Changed with set_dimension_default().';
COMMENT ON COLUMN metadata.dimensions.hide_when_single IS 'With exactly one active row, clients hide the control on Create and Edit; the server fills the value.';

ALTER TABLE metadata.dimensions ENABLE ROW LEVEL SECURITY;

-- Everyone reads the registry (it holds table and column names, no data); writes only through definer RPCs.
CREATE POLICY dimensions_select ON metadata.dimensions FOR SELECT USING (true);
GRANT SELECT ON metadata.dimensions TO web_anon, authenticated;

-- ============================================================================
-- 2. public.schema_dimensions
-- ============================================================================

CREATE VIEW public.schema_dimensions
WITH (security_invoker = true) AS
SELECT
    d.dimension_key,
    d.display_name,
    d.table_schema,
    d.table_name,
    d.key_column,
    d.label_column,
    d.parent_column,
    d.active_column,
    d.external_id_column,
    d.default_value_id,
    d.hide_when_single,
    d.sort_order
FROM metadata.dimensions d
ORDER BY d.sort_order, d.dimension_key;

COMMENT ON VIEW public.schema_dimensions IS
    'Registered dimensions for clients: table, column roles, default value and hide_when_single. Added in v0.85.0.';

GRANT SELECT ON public.schema_dimensions TO web_anon, authenticated;

-- ============================================================================
-- 3. metadata.dimension_delete_guard()
-- ============================================================================
-- BEFORE DELETE (row) and BEFORE TRUNCATE (statement). Raised in PostgreSQL's check-violation form so the
-- dimension_row_delete constraint message is found by name. An instance owner may drop the trigger.

CREATE FUNCTION metadata.dimension_delete_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'delete on relation "%" violates check constraint "dimension_row_delete"', TG_TABLE_NAME
    USING ERRCODE = '23514',
          CONSTRAINT = 'dimension_row_delete',
          SCHEMA = TG_TABLE_SCHEMA,
          TABLE = TG_TABLE_NAME,
          DETAIL = format('%s.%s is the registered dimension "%s": rows are retired, not deleted.',
                          TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[0]),
          HINT = format('Set %s to false instead.', TG_ARGV[1]);
END;
$$;

COMMENT ON FUNCTION metadata.dimension_delete_guard() IS
    'Trigger installed by register_dimension(): refuses every DELETE and TRUNCATE on a registered dimension table (23514, constraint dimension_row_delete). Arguments: dimension key, active column. Added in v0.85.0.';

REVOKE EXECUTE ON FUNCTION metadata.dimension_delete_guard() FROM PUBLIC;

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES ('dimension_row_delete', '*', NULL,
        'This record is used for reporting and cannot be deleted. Mark it inactive instead.')
ON CONFLICT (constraint_name) DO NOTHING;

-- ============================================================================
-- 4. metadata.dimension_default_fill()
-- ============================================================================
-- BEFORE INSERT on a table with a FK column to a registered dimension. Fills only a NULL value (a column
-- DEFAULT the insert relied on is already in NEW), never on update, and skips a retired default. A definer:
-- it reads the registry and the dimension table whatever the inserting role may see. Reads the row through
-- to_jsonb(), so dropping or renaming the column leaves the trigger harmless.

CREATE FUNCTION metadata.dimension_default_fill()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_column TEXT := TG_ARGV[1];
  v_new JSONB := to_jsonb(NEW);
  v_dim metadata.dimensions%ROWTYPE;
  v_active BOOLEAN;
BEGIN
  IF NOT (v_new ? v_column) OR (v_new ->> v_column) IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_dim FROM metadata.dimensions WHERE dimension_key = TG_ARGV[0];
  IF NOT FOUND OR v_dim.default_value_id IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format('SELECT %I FROM %I.%I WHERE %I = $1',
                 v_dim.active_column, v_dim.table_schema, v_dim.table_name, v_dim.key_column)
    INTO v_active
    USING v_dim.default_value_id;
  IF v_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  NEW := jsonb_populate_record(NEW, jsonb_build_object(v_column, v_dim.default_value_id));
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION metadata.dimension_default_fill() IS
    'Trigger installed by register_dimension() on each table with a FK column to a registered dimension: on INSERT fills a NULL value with the dimension''s default_value_id unless that row is retired. Arguments: dimension key, column. Added in v0.85.0.';

REVOKE EXECUTE ON FUNCTION metadata.dimension_default_fill() FROM PUBLIC;

-- ============================================================================
-- 5. metadata._dimension_value_state(): exists / active check for a value
-- ============================================================================
-- 'missing', 'inactive' or 'active'. Internal to register_dimension() and set_dimension_default().

CREATE FUNCTION metadata._dimension_value_state(
    p_schema NAME, p_table NAME, p_key_column NAME, p_active_column NAME, p_value_id BIGINT
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_active BOOLEAN;
  v_rows INT;
BEGIN
  EXECUTE format('SELECT %I FROM %I.%I WHERE %I = $1', p_active_column, p_schema, p_table, p_key_column)
    INTO v_active
    USING p_value_id;
  -- EXECUTE does not set FOUND
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN 'missing';
  END IF;
  RETURN CASE WHEN v_active IS TRUE THEN 'active' ELSE 'inactive' END;
END;
$$;

REVOKE EXECUTE ON FUNCTION metadata._dimension_value_state(NAME, NAME, NAME, NAME, BIGINT) FROM PUBLIC;

-- ============================================================================
-- 6. public.register_dimension()
-- ============================================================================
-- Idempotent: re-registering refreshes the row, the parent guard's arguments and the fill triggers (so an
-- install script that adds a table with a FK to the dimension re-registers it afterwards). A NULL
-- p_default_value_id keeps the current default; set_dimension_default() clears it.
--
-- SQLSTATEs: 42501 neither an admin JWT nor the deployment role, or (over the API) a table outside public;
-- 22023 malformed input, a table or column that does not qualify, or an inactive default;
-- 23505 the key is registered for another table, or the table under another key;
-- 23503 the default row does not exist; 23514 the table already holds a parent cycle.

CREATE FUNCTION public.register_dimension(
    p_dimension_key TEXT,
    p_display_name TEXT,
    p_table_schema NAME,
    p_table_name NAME,
    p_key_column NAME DEFAULT 'id',
    p_label_column NAME DEFAULT 'display_name',
    p_parent_column NAME DEFAULT NULL,
    p_active_column NAME DEFAULT 'is_active',
    p_external_id_column NAME DEFAULT NULL,
    p_default_value_id BIGINT DEFAULT NULL,
    p_hide_when_single BOOLEAN DEFAULT TRUE,
    p_sort_order INTEGER DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_deployer BOOLEAN;
  v_rel OID;
  v_qualified TEXT;
  v_key_attnum SMALLINT;
  v_parent_attnum SMALLINT;
  v_existing metadata.dimensions%ROWTYPE;
  v_ref RECORD;
  v_trigger NAME;
BEGIN
  IF NOT metadata._is_db_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  v_deployer := metadata._is_deployer();

  -- ------------------------------------------------------------------
  -- Input and table
  -- ------------------------------------------------------------------
  IF p_dimension_key IS NULL OR p_dimension_key !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid dimension key %: lowercase letters, digits and underscores', p_dimension_key
      USING ERRCODE = '22023';
  END IF;
  IF p_display_name IS NULL OR btrim(p_display_name) = '' THEN
    RAISE EXCEPTION 'A dimension display name is required' USING ERRCODE = '22023';
  END IF;
  IF p_table_schema IS NULL OR p_table_name IS NULL OR p_key_column IS NULL OR p_label_column IS NULL
     OR p_active_column IS NULL THEN
    RAISE EXCEPTION 'Table schema, table name, key column, label column and active column are required'
      USING ERRCODE = '22023';
  END IF;

  IF NOT v_deployer AND p_table_schema <> 'public' THEN
    RAISE EXCEPTION 'Over the API, only tables in public can be registered as dimensions (got %.%)', p_table_schema, p_table_name
      USING ERRCODE = '42501',
            HINT = 'Register tables in other schemas from an install script run by the deployment role.';
  END IF;

  SELECT c.oid INTO v_rel
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = p_table_schema AND c.relname = p_table_name AND c.relkind IN ('r', 'p');
  IF v_rel IS NULL THEN
    RAISE EXCEPTION '%.% is not a base table', p_table_schema, p_table_name USING ERRCODE = '22023';
  END IF;
  v_qualified := format('%I.%I', p_table_schema, p_table_name);

  -- key: BIGINT, unique on its own
  SELECT a.attnum INTO v_key_attnum
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = v_rel AND a.attname = p_key_column AND NOT a.attisdropped AND a.attnum > 0
    AND a.atttypid = 'int8'::regtype;
  IF v_key_attnum IS NULL THEN
    RAISE EXCEPTION 'Key column %.% must exist and be BIGINT', v_qualified, p_key_column
      USING ERRCODE = '22023',
            HINT = 'Dimension tables use the instance convention id BIGSERIAL PRIMARY KEY, so one BIGINT column can hold a value from any dimension.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indrelid = v_rel AND i.indisunique AND i.indnkeyatts = 1 AND i.indkey[0] = v_key_attnum
      AND i.indpred IS NULL
  ) THEN
    RAISE EXCEPTION 'Key column %.% must be the primary key or unique on its own', v_qualified, p_key_column
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = v_rel AND a.attname = p_label_column
                   AND NOT a.attisdropped AND a.attnum > 0) THEN
    RAISE EXCEPTION 'Label column %.% does not exist', v_qualified, p_label_column USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = v_rel AND a.attname = p_active_column
                   AND NOT a.attisdropped AND a.attnum > 0 AND a.atttypid = 'bool'::regtype) THEN
    RAISE EXCEPTION 'Active column %.% must exist and be BOOLEAN', v_qualified, p_active_column
      USING ERRCODE = '22023',
            HINT = 'Rows of a registered table are retired through the active column, never deleted.';
  END IF;

  IF p_external_id_column IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = v_rel AND a.attname = p_external_id_column
         AND NOT a.attisdropped AND a.attnum > 0) THEN
    RAISE EXCEPTION 'External id column %.% does not exist', v_qualified, p_external_id_column USING ERRCODE = '22023';
  END IF;

  -- parent: a single-column FK from the table to its own key
  IF p_parent_column IS NOT NULL THEN
    SELECT a.attnum INTO v_parent_attnum
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = v_rel AND a.attname = p_parent_column AND NOT a.attisdropped AND a.attnum > 0;
    IF v_parent_attnum IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint k
      WHERE k.conrelid = v_rel AND k.confrelid = v_rel AND k.contype = 'f'
        AND k.conkey = ARRAY[v_parent_attnum] AND k.confkey = ARRAY[v_key_attnum]
    ) THEN
      RAISE EXCEPTION 'Parent column %.% must be a foreign key to %.%', v_qualified, p_parent_column, v_qualified, p_key_column
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- ------------------------------------------------------------------
  -- Registry conflicts and default
  -- ------------------------------------------------------------------
  SELECT * INTO v_existing FROM metadata.dimensions WHERE dimension_key = p_dimension_key;
  IF FOUND AND (v_existing.table_schema <> p_table_schema OR v_existing.table_name <> p_table_name) THEN
    RAISE EXCEPTION 'Dimension % is registered for %.%', p_dimension_key, v_existing.table_schema, v_existing.table_name
      USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM metadata.dimensions
             WHERE table_schema = p_table_schema AND table_name = p_table_name AND dimension_key <> p_dimension_key) THEN
    RAISE EXCEPTION '%.% is already registered as dimension %', p_table_schema, p_table_name,
        (SELECT dimension_key FROM metadata.dimensions WHERE table_schema = p_table_schema AND table_name = p_table_name)
      USING ERRCODE = '23505';
  END IF;

  IF p_default_value_id IS NOT NULL THEN
    CASE metadata._dimension_value_state(p_table_schema, p_table_name, p_key_column, p_active_column, p_default_value_id)
      WHEN 'missing' THEN
        RAISE EXCEPTION 'Default value % does not exist in %', p_default_value_id, v_qualified USING ERRCODE = '23503';
      WHEN 'inactive' THEN
        RAISE EXCEPTION 'Default value % in % is retired (% is false)', p_default_value_id, v_qualified, p_active_column
          USING ERRCODE = '22023';
      ELSE NULL;
    END CASE;
  END IF;

  -- ------------------------------------------------------------------
  -- Guards on the dimension table
  -- ------------------------------------------------------------------
  IF p_parent_column IS NOT NULL THEN
    PERFORM metadata._install_tree_parent_guard(v_rel::regclass, p_key_column, p_parent_column);
  ELSE
    EXECUTE format('DROP TRIGGER IF EXISTS tree_parent_guard ON %s', v_qualified);
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE TRIGGER dimension_delete_guard BEFORE DELETE ON %s '
    'FOR EACH ROW EXECUTE FUNCTION metadata.dimension_delete_guard(%L, %L)',
    v_qualified, p_dimension_key, p_active_column);
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER dimension_truncate_guard BEFORE TRUNCATE ON %s '
    'FOR EACH STATEMENT EXECUTE FUNCTION metadata.dimension_delete_guard(%L, %L)',
    v_qualified, p_dimension_key, p_active_column);

  -- ------------------------------------------------------------------
  -- Fill triggers on every referencing column (the table's own parent FK excluded)
  -- ------------------------------------------------------------------
  FOR v_ref IN
    SELECT n.nspname AS ref_schema, c.relname AS ref_table, a.attname AS ref_column
    FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
    WHERE k.contype = 'f' AND k.confrelid = v_rel AND k.confkey = ARRAY[v_key_attnum]
      AND cardinality(k.conkey) = 1 AND k.conrelid <> v_rel
      AND c.relkind IN ('r', 'p')
    ORDER BY n.nspname, c.relname, a.attname
  LOOP
    IF NOT v_deployer AND v_ref.ref_schema <> 'public' THEN
      RAISE NOTICE 'dimension %: no default fill on %.%.% (outside public); register from an install script to add it',
        p_dimension_key, v_ref.ref_schema, v_ref.ref_table, v_ref.ref_column;
      CONTINUE;
    END IF;
    v_trigger := left('dimension_default_' || v_ref.ref_column, 63);
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE INSERT ON %I.%I '
      'FOR EACH ROW EXECUTE FUNCTION metadata.dimension_default_fill(%L, %L)',
      v_trigger, v_ref.ref_schema, v_ref.ref_table, p_dimension_key, v_ref.ref_column);
  END LOOP;

  -- ------------------------------------------------------------------
  -- The registry row
  -- ------------------------------------------------------------------
  INSERT INTO metadata.dimensions (
    dimension_key, display_name, table_schema, table_name, key_column, label_column, parent_column,
    active_column, external_id_column, default_value_id, hide_when_single, sort_order)
  VALUES (
    p_dimension_key, p_display_name, p_table_schema, p_table_name, p_key_column, p_label_column, p_parent_column,
    p_active_column, p_external_id_column, p_default_value_id, coalesce(p_hide_when_single, true), coalesce(p_sort_order, 0))
  ON CONFLICT (dimension_key) DO UPDATE SET
    display_name       = EXCLUDED.display_name,
    key_column         = EXCLUDED.key_column,
    label_column       = EXCLUDED.label_column,
    parent_column      = EXCLUDED.parent_column,
    active_column      = EXCLUDED.active_column,
    external_id_column = EXCLUDED.external_id_column,
    default_value_id   = coalesce(EXCLUDED.default_value_id, metadata.dimensions.default_value_id),
    hide_when_single   = EXCLUDED.hide_when_single,
    sort_order         = EXCLUDED.sort_order,
    updated_at         = NOW();
END;
$$;

COMMENT ON FUNCTION public.register_dimension(TEXT, TEXT, NAME, NAME, NAME, NAME, NAME, NAME, NAME, BIGINT, BOOLEAN, INTEGER) IS
    'Registers (or re-registers) a lookup table as a dimension: checks the BIGINT key, the boolean active column and the parent FK; installs the delete guard, the parent-cycle guard and a default-fill trigger on every referencing FK column; upserts the registry row (a NULL default keeps the current one). Admin JWT or the deployment role; over the API only public tables. Added in v0.85.0.';

REVOKE EXECUTE ON FUNCTION public.register_dimension(TEXT, TEXT, NAME, NAME, NAME, NAME, NAME, NAME, NAME, BIGINT, BOOLEAN, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_dimension(TEXT, TEXT, NAME, NAME, NAME, NAME, NAME, NAME, NAME, BIGINT, BOOLEAN, INTEGER) TO authenticated;

-- ============================================================================
-- 7. public.set_dimension_default()
-- ============================================================================
-- Generates no DDL, so the admin JWT path needs no narrowing. NULL clears the default.
-- SQLSTATEs: 42501 not admin; 22023 unknown dimension or an inactive row; 23503 the row does not exist.

CREATE FUNCTION public.set_dimension_default(p_dimension_key TEXT, p_value_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_dim metadata.dimensions%ROWTYPE;
BEGIN
  IF NOT metadata._is_db_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_dim FROM metadata.dimensions WHERE dimension_key = p_dimension_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dimension % is not registered', p_dimension_key USING ERRCODE = '22023';
  END IF;

  IF p_value_id IS NOT NULL THEN
    CASE metadata._dimension_value_state(v_dim.table_schema, v_dim.table_name, v_dim.key_column, v_dim.active_column, p_value_id)
      WHEN 'missing' THEN
        RAISE EXCEPTION 'Value % does not exist in %.%', p_value_id, v_dim.table_schema, v_dim.table_name
          USING ERRCODE = '23503';
      WHEN 'inactive' THEN
        RAISE EXCEPTION 'Value % in %.% is retired (% is false)', p_value_id, v_dim.table_schema, v_dim.table_name, v_dim.active_column
          USING ERRCODE = '22023';
      ELSE NULL;
    END CASE;
  END IF;

  UPDATE metadata.dimensions
  SET default_value_id = p_value_id, updated_at = NOW()
  WHERE dimension_key = p_dimension_key;
END;
$$;

COMMENT ON FUNCTION public.set_dimension_default(TEXT, BIGINT) IS
    'Sets (or, with NULL, clears) the row a dimension fills into empty FKs on insert; refuses a missing or retired row. Admin JWT or the deployment role. Added in v0.85.0.';

REVOKE EXECUTE ON FUNCTION public.set_dimension_default(TEXT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_dimension_default(TEXT, BIGINT) TO authenticated;

-- ============================================================================
-- 8. public.dimension_subtree()
-- ============================================================================
-- The value and its descendants. Runs as the caller, so RLS on the dimension table applies: a hidden row
-- and the rows below it are not returned. The CYCLE clause and a depth limit bound the walk even if the
-- guard was dropped and a cycle exists. A flat dimension returns the value alone (when the caller sees it).

CREATE FUNCTION public.dimension_subtree(p_dimension_key TEXT, p_value_id BIGINT)
RETURNS SETOF BIGINT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_dim metadata.dimensions%ROWTYPE;
BEGIN
  SELECT * INTO v_dim FROM metadata.dimensions WHERE dimension_key = p_dimension_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dimension % is not registered', p_dimension_key USING ERRCODE = '22023';
  END IF;

  IF v_dim.parent_column IS NULL THEN
    RETURN QUERY EXECUTE format('SELECT %1$I FROM %2$I.%3$I WHERE %1$I = $1',
                                v_dim.key_column, v_dim.table_schema, v_dim.table_name)
      USING p_value_id;
    RETURN;
  END IF;

  RETURN QUERY EXECUTE format(
    'WITH RECURSIVE sub(k, depth) AS ('
    '  SELECT t.%1$I, 0 FROM %3$I.%4$I t WHERE t.%1$I = $1'
    '  UNION ALL'
    '  SELECT t.%1$I, s.depth + 1 FROM %3$I.%4$I t JOIN sub s ON t.%2$I = s.k WHERE s.depth < 10000'
    ') CYCLE k SET is_cycle USING path '
    'SELECT DISTINCT k FROM sub',
    v_dim.key_column, v_dim.parent_column, v_dim.table_schema, v_dim.table_name)
    USING p_value_id;
END;
$$;

COMMENT ON FUNCTION public.dimension_subtree(TEXT, BIGINT) IS
    'The given dimension value and all its descendants that the caller can read (RLS applies). Bounded by the CYCLE clause and a depth limit. Added in v0.85.0.';

REVOKE EXECUTE ON FUNCTION public.dimension_subtree(TEXT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dimension_subtree(TEXT, BIGINT) TO web_anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
