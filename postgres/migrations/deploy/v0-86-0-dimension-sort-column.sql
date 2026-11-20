-- Deploy civic_os:v0-86-0-dimension-sort-column to pg
-- requires: v0-86-0-tree-select-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Sibling order for registered dimensions (v0.86.0). The integrator names the column that orders a dimension's
-- rows within each parent; clients request it through PostgREST (order=<sort_column>,<label>,<key>), so the
-- tree select and the planned tree list order siblings the same way.
-- Design: docs/notes/IMPACT_REPORTING_DESIGN.md (Build amendments) and docs/notes/TREE_LIST_VIEW_DESIGN.md
-- (Sibling order).
--
--   metadata.dimensions.sort_column     nullable; NULL orders by label
--   public.schema_dimensions            returns it (re-created; security_invoker repeated)
--   public.register_dimension()         gains a trailing p_sort_column (default NULL): checked to exist; when
--                                       omitted, a sort_order column is used if the table has one; it follows
--                                       the latest registration, like every setting but the default
--   public.compare_interface()          dimension elements accept the column role 'sort'
--
-- register_dimension() gains a parameter, so its v0.85.0 signature is dropped and the function re-created. No
-- instance runs v0.85.0, so no install script declares the old signature; calls by name or by position up to
-- p_sort_order are unaffected.

BEGIN;

-- ============================================================================
-- 1. metadata.dimensions.sort_column
-- ============================================================================

ALTER TABLE metadata.dimensions ADD COLUMN sort_column NAME;

COMMENT ON COLUMN metadata.dimensions.sort_column IS
    'Column that orders a dimension''s rows within each parent (then label, then key); NULL orders by label. Set by register_dimension(p_sort_column), or to sort_order by convention. Since v0.86.0.';

-- ============================================================================
-- 2. public.schema_dimensions
-- ============================================================================

DROP VIEW public.schema_dimensions;

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
    d.sort_order,
    d.sort_column
FROM metadata.dimensions d
ORDER BY d.sort_order, d.dimension_key;

COMMENT ON VIEW public.schema_dimensions IS
    'Registered dimensions for clients: table, column roles, default value and hide_when_single. Added in v0.85.0.';

GRANT SELECT ON public.schema_dimensions TO web_anon, authenticated;

-- ============================================================================
-- 3. public.register_dimension(..., p_sort_column)
-- ============================================================================

DROP FUNCTION public.register_dimension(TEXT, TEXT, NAME, NAME, NAME, NAME, NAME, NAME, NAME, BIGINT, BOOLEAN, INTEGER);

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
    p_sort_order INTEGER DEFAULT 0,
    p_sort_column NAME DEFAULT NULL
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
  v_sort_column NAME := p_sort_column;
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

  -- sibling order (v0.86.0): the given column, else a sort_order column by convention (Tree List View design,
  -- Sibling order) when the table has one, else none (clients order by label)
  IF v_sort_column IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = v_rel AND a.attname = v_sort_column
                     AND NOT a.attisdropped AND a.attnum > 0) THEN
      RAISE EXCEPTION 'Sort column %.% does not exist', v_qualified, v_sort_column USING ERRCODE = '22023';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = v_rel AND a.attname = 'sort_order'
                  AND NOT a.attisdropped AND a.attnum > 0) THEN
    v_sort_column := 'sort_order';
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
    -- drop a guard left from an earlier hierarchical registration; checked first so a flat registration is quiet
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = v_rel AND t.tgname = 'tree_parent_guard') THEN
      EXECUTE format('DROP TRIGGER tree_parent_guard ON %s', v_qualified);
    END IF;
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
    -- the column becomes the Dimension type, whose tree select ignores the FK dropdown settings (v0.86.0)
    IF v_ref.ref_schema = 'public' AND EXISTS (
         SELECT 1 FROM metadata.properties mp
         WHERE mp.table_name = v_ref.ref_table AND mp.column_name = v_ref.ref_column
           AND (coalesce(mp.fk_search_modal, false) OR mp.options_source_rpc IS NOT NULL
                OR coalesce(cardinality(mp.depends_on_columns), 0) > 0)) THEN
      RAISE NOTICE 'dimension %: %.% now shows a tree select, which ignores its fk_search_modal, options_source_rpc and depends_on_columns settings',
        p_dimension_key, v_ref.ref_table, v_ref.ref_column;
    END IF;
  END LOOP;

  -- ------------------------------------------------------------------
  -- The registry row
  -- ------------------------------------------------------------------
  INSERT INTO metadata.dimensions (
    dimension_key, display_name, table_schema, table_name, key_column, label_column, parent_column,
    active_column, external_id_column, default_value_id, hide_when_single, sort_order, sort_column)
  VALUES (
    p_dimension_key, p_display_name, p_table_schema, p_table_name, p_key_column, p_label_column, p_parent_column,
    p_active_column, p_external_id_column, p_default_value_id, coalesce(p_hide_when_single, true), coalesce(p_sort_order, 0),
    v_sort_column)
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
    sort_column        = EXCLUDED.sort_column,
    updated_at         = NOW();
END;
$$;

COMMENT ON FUNCTION public.register_dimension(TEXT, TEXT, NAME, NAME, NAME, NAME, NAME, NAME, NAME, BIGINT, BOOLEAN, INTEGER, NAME) IS
    'Registers (or re-registers) a lookup table as a dimension: checks the BIGINT key, the boolean active column and the parent FK; installs the delete guard, the parent-cycle guard and a default-fill trigger on every referencing FK column; upserts the registry row (a NULL default keeps the current one). p_sort_column (v0.86.0) orders siblings; when omitted, a sort_order column is used if the table has one. Admin JWT or the deployment role; over the API only public tables. Added in v0.85.0; p_sort_column in v0.86.0.';

REVOKE EXECUTE ON FUNCTION public.register_dimension(TEXT, TEXT, NAME, NAME, NAME, NAME, NAME, NAME, NAME, BIGINT, BOOLEAN, INTEGER, NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_dimension(TEXT, TEXT, NAME, NAME, NAME, NAME, NAME, NAME, NAME, BIGINT, BOOLEAN, INTEGER, NAME) TO authenticated;

-- ============================================================================
-- 4. public.compare_interface(): the 'sort' column role
-- ============================================================================

CREATE OR REPLACE FUNCTION public.compare_interface(p_declared JSONB)
RETURNS TABLE (
    template     TEXT,
    source       TEXT,
    element      TEXT,
    name         TEXT,
    column_name  TEXT,
    difference   TEXT,
    severity     TEXT,
    expected     TEXT,
    actual       TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_template TEXT;
  v_el JSONB;
  v_idx INT := 0;
  v_kind TEXT;
  v_name TEXT;
  v_source TEXT;
  v_parts TEXT[];
  v_rel OID;
  v_relkind "char";
  v_col JSONB;
  v_colname TEXT;
  v_attnum SMALLINT;
  v_atttypid OID;
  v_atttypmod INT;
  v_attnotnull BOOLEAN;
  v_decl_type OID;
  v_decl_typmod INT;
  v_diff TEXT;
  v_ref TEXT;
  v_ref_parts TEXT[];
  v_ref_rel OID;
  v_ref_attnum SMALLINT;
  v_live_ref TEXT;
  v_declared_cols TEXT[];
  v_key TEXT;
  v_arg JSONB;
  v_arg_types TEXT[];
  v_sig TEXT;
  v_proc OID;
  v_returns TEXT;
  v_live_returns TEXT;
  v_rec RECORD;
  v_rows JSONB := '[]'::jsonb;
  v_allowed TEXT[];
  v_returns_differ BOOLEAN;
  v_dimrow metadata.dimensions%ROWTYPE;
  v_regcol TEXT;
  v_declcol TEXT;
  v_live_rel OID;
  v_modver TEXT;
  v_decl_parts INT[];
  v_inst_parts INT[];
BEGIN
  -- ------------------------------------------------------------------
  -- Shape of the declaration
  -- ------------------------------------------------------------------
  IF p_declared IS NULL OR jsonb_typeof(p_declared) <> 'object' THEN
    RAISE EXCEPTION 'Interface declaration must be a JSON object' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_declared) LOOP
    IF v_key NOT IN ('template', 'elements') THEN
      RAISE EXCEPTION 'Interface declaration: unknown key "%"', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF p_declared ? 'template' AND jsonb_typeof(p_declared->'template') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'Interface declaration: "template" must be a string' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_declared->'elements') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Interface declaration: "elements" must be an array' USING ERRCODE = '22023';
  END IF;

  v_template := p_declared->>'template';

  FOR v_el IN SELECT e FROM jsonb_array_elements(p_declared->'elements') AS e LOOP
    v_idx := v_idx + 1;

    IF jsonb_typeof(v_el) <> 'object' THEN
      RAISE EXCEPTION 'Interface declaration: element % is not an object', v_idx USING ERRCODE = '22023';
    END IF;
    v_kind := v_el->>'element';
    IF v_kind IS NULL OR v_kind NOT IN ('table', 'dimension', 'module', 'rpc') THEN
      RAISE EXCEPTION 'Interface declaration: element % has unknown kind %', v_idx, coalesce(v_kind, '(none)')
        USING ERRCODE = '22023';
    END IF;
    -- (PL/pgSQL ends an IF condition at its first THEN, so a CASE is computed first)
    v_allowed := CASE v_kind
        WHEN 'table'     THEN ARRAY['element', 'name', 'source', 'columns', 'writes']
        WHEN 'dimension' THEN ARRAY['element', 'key', 'table', 'source', 'columns']
        WHEN 'module'    THEN ARRAY['element', 'key', 'version', 'source']
        ELSE                  ARRAY['element', 'name', 'args', 'returns', 'source']
      END;
    FOR v_key IN SELECT jsonb_object_keys(v_el) LOOP
      IF NOT v_key = ANY (v_allowed) THEN
        RAISE EXCEPTION 'Interface declaration: % element % has unknown key "%"', v_kind, v_idx, v_key
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
    IF v_el ? 'source' AND jsonb_typeof(v_el->'source') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'Interface declaration: element % "source" must be a string', v_idx USING ERRCODE = '22023';
    END IF;
    v_source := v_el->>'source';

    -- ----------------------------------------------------------------
    -- table
    -- ----------------------------------------------------------------
    IF v_kind = 'table' THEN
      v_name := v_el->>'name';
      v_parts := CASE WHEN v_name IS NULL THEN NULL ELSE parse_ident(v_name) END;
      IF v_name IS NULL OR jsonb_typeof(v_el->'name') <> 'string' OR array_length(v_parts, 1) IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'Interface declaration: table element % needs a schema-qualified "name"', v_idx
          USING ERRCODE = '22023';
      END IF;
      IF v_el ? 'columns' AND jsonb_typeof(v_el->'columns') <> 'array' THEN
        RAISE EXCEPTION 'Interface declaration: table % "columns" must be an array', v_name USING ERRCODE = '22023';
      END IF;
      IF v_el ? 'writes' AND jsonb_typeof(v_el->'writes') <> 'boolean' THEN
        RAISE EXCEPTION 'Interface declaration: table % "writes" must be a boolean', v_name USING ERRCODE = '22023';
      END IF;

      -- validate every column first, so a malformed declaration raises whatever the instance holds
      v_declared_cols := ARRAY[]::TEXT[];
      FOR v_col IN SELECT c FROM jsonb_array_elements(coalesce(v_el->'columns', '[]'::jsonb)) AS c LOOP
        IF jsonb_typeof(v_col) <> 'object' OR jsonb_typeof(v_col->'name') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'Interface declaration: table % has a column without a "name"', v_name USING ERRCODE = '22023';
        END IF;
        v_colname := v_col->>'name';
        FOR v_key IN SELECT jsonb_object_keys(v_col) LOOP
          IF v_key NOT IN ('name', 'type', 'nullable', 'references') THEN
            RAISE EXCEPTION 'Interface declaration: column %.% has unknown key "%"', v_name, v_colname, v_key
              USING ERRCODE = '22023';
          END IF;
        END LOOP;
        IF v_col ? 'type' AND (jsonb_typeof(v_col->'type') <> 'string' OR to_regtype(v_col->>'type') IS NULL) THEN
          RAISE EXCEPTION 'Interface declaration: column %.% has a type that does not resolve: %', v_name, v_colname, v_col->'type'
            USING ERRCODE = '22023';
        END IF;
        IF v_col ? 'nullable' AND jsonb_typeof(v_col->'nullable') <> 'boolean' THEN
          RAISE EXCEPTION 'Interface declaration: column %.% "nullable" must be a boolean', v_name, v_colname
            USING ERRCODE = '22023';
        END IF;
        IF v_col ? 'references' AND (jsonb_typeof(v_col->'references') <> 'string'
             OR array_length(parse_ident(v_col->>'references'), 1) IS DISTINCT FROM 3) THEN
          RAISE EXCEPTION 'Interface declaration: column %.% "references" must be schema.table.column', v_name, v_colname
            USING ERRCODE = '22023';
        END IF;
        v_declared_cols := v_declared_cols || v_colname;
      END LOOP;

      SELECT c.oid, c.relkind INTO v_rel, v_relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = v_parts[1] AND c.relname = v_parts[2];

      IF v_rel IS NULL THEN
        v_rows := v_rows || jsonb_build_object('element', 'table', 'name', v_name, 'source', v_source,
          'difference', 'missing_table', 'severity', 'error', 'expected', 'table');
        CONTINUE;
      END IF;
      IF v_relkind NOT IN ('r', 'p') THEN
        v_rows := v_rows || jsonb_build_object('element', 'table', 'name', v_name, 'source', v_source,
          'difference', 'kind_mismatch', 'severity', 'error', 'expected', 'table',
          'actual', CASE v_relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
                                   WHEN 'f' THEN 'foreign table' WHEN 'S' THEN 'sequence'
                                   WHEN 'c' THEN 'composite type' ELSE 'relation of kind ' || v_relkind::text END);
        v_rel := NULL;
        CONTINUE;
      END IF;

      FOR v_col IN SELECT c FROM jsonb_array_elements(coalesce(v_el->'columns', '[]'::jsonb)) AS c LOOP
        v_colname := v_col->>'name';

        SELECT a.attnum, a.atttypid, a.atttypmod, a.attnotnull
          INTO v_attnum, v_atttypid, v_atttypmod, v_attnotnull
        FROM pg_attribute a
        WHERE a.attrelid = v_rel AND a.attname = v_colname AND a.attnum > 0 AND NOT a.attisdropped;

        IF NOT FOUND THEN
          v_rows := v_rows || jsonb_build_object('element', 'table', 'name', v_name, 'source', v_source,
            'column_name', v_colname, 'difference', 'missing_column', 'severity', 'error',
            'expected', CASE WHEN v_col ? 'type'
                             THEN format_type(to_regtype(v_col->>'type'), to_regtypemod(v_col->>'type'))
                             ELSE 'column' END);
          CONTINUE;
        END IF;

        IF v_col ? 'type' THEN
          v_decl_type := to_regtype(v_col->>'type');
          v_decl_typmod := to_regtypemod(v_col->>'type');
          v_diff := metadata._interface_type_difference(v_decl_type, v_decl_typmod, v_atttypid, v_atttypmod);
          IF v_diff IS NOT NULL THEN
            v_rows := v_rows || jsonb_build_object('element', 'table', 'name', v_name, 'source', v_source,
              'column_name', v_colname, 'difference', v_diff,
              'severity', CASE WHEN v_diff = 'widened' THEN 'info' ELSE 'error' END,
              'expected', format_type(v_decl_type, v_decl_typmod),
              'actual', format_type(v_atttypid, v_atttypmod));
          END IF;
        END IF;

        IF v_col ? 'nullable' THEN
          IF (v_col->>'nullable')::boolean AND v_attnotnull THEN
            v_rows := v_rows || jsonb_build_object('element', 'table', 'name', v_name, 'source', v_source,
              'column_name', v_colname, 'difference', 'now_required', 'severity', 'info',
              'expected', 'nullable', 'actual', 'not null');
          ELSIF NOT (v_col->>'nullable')::boolean AND NOT v_attnotnull THEN
            v_rows := v_rows || jsonb_build_object('element', 'table', 'name', v_name, 'source', v_source,
              'column_name', v_colname, 'difference', 'nullability_mismatch', 'severity', 'error',
              'expected', 'not null', 'actual', 'nullable');
          END IF;
        END IF;

        IF v_col ? 'references' THEN
          v_ref := v_col->>'references';
          v_ref_parts := parse_ident(v_ref);
          v_ref_rel := NULL;
          v_ref_attnum := NULL;
          SELECT c.oid INTO v_ref_rel
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = v_ref_parts[1] AND c.relname = v_ref_parts[2];
          IF v_ref_rel IS NOT NULL THEN
            SELECT a.attnum INTO v_ref_attnum
            FROM pg_attribute a
            WHERE a.attrelid = v_ref_rel AND a.attname = v_ref_parts[3] AND a.attnum > 0 AND NOT a.attisdropped;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint k
            WHERE k.conrelid = v_rel AND k.contype = 'f' AND k.conkey = ARRAY[v_attnum]
              AND k.confrelid = v_ref_rel AND k.confkey = ARRAY[v_ref_attnum]
          ) THEN
            -- the column's single-column FK that points elsewhere, if any
            SELECT format('%s.%s.%s', fn.nspname, fc.relname, fa.attname) INTO v_live_ref
            FROM pg_constraint k
            JOIN pg_class fc ON fc.oid = k.confrelid
            JOIN pg_namespace fn ON fn.oid = fc.relnamespace
            JOIN pg_attribute fa ON fa.attrelid = k.confrelid AND fa.attnum = k.confkey[1]
            WHERE k.conrelid = v_rel AND k.contype = 'f' AND k.conkey = ARRAY[v_attnum]
            ORDER BY k.conname
            LIMIT 1;

            v_rows := v_rows || jsonb_build_object('element', 'table', 'name', v_name, 'source', v_source,
              'column_name', v_colname,
              'difference', CASE WHEN v_live_ref IS NULL THEN 'missing_reference' ELSE 'reference_mismatch' END,
              'severity', 'error', 'expected', v_ref, 'actual', v_live_ref);
            v_live_ref := NULL;
          END IF;
        END IF;
      END LOOP;

      -- a table the script writes: every undeclared column must accept an omitted value
      IF coalesce((v_el->>'writes')::boolean, false) THEN
        FOR v_rec IN
          SELECT a.attname::text AS attname, format_type(a.atttypid, a.atttypmod) AS typ
          FROM pg_attribute a
          WHERE a.attrelid = v_rel AND a.attnum > 0 AND NOT a.attisdropped
            AND NOT (a.attname::text = ANY (v_declared_cols))
            AND a.attnotnull AND NOT a.atthasdef AND a.attidentity = '' AND a.attgenerated = ''
        LOOP
          v_rows := v_rows || jsonb_build_object('element', 'table', 'name', v_name, 'source', v_source,
            'column_name', v_rec.attname, 'difference', 'missing_default', 'severity', 'error',
            'expected', 'nullable or a default', 'actual', v_rec.typ || ' not null, no default');
        END LOOP;
      END IF;

      v_rel := NULL;

    -- ----------------------------------------------------------------
    -- rpc
    -- ----------------------------------------------------------------
    ELSIF v_kind = 'rpc' THEN
      v_name := v_el->>'name';
      v_parts := CASE WHEN v_name IS NULL THEN NULL ELSE parse_ident(v_name) END;
      IF v_name IS NULL OR jsonb_typeof(v_el->'name') <> 'string' OR array_length(v_parts, 1) IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'Interface declaration: rpc element % needs a schema-qualified "name"', v_idx
          USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(v_el->'args') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Interface declaration: rpc % needs "args" (an array of types, possibly empty)', v_name
          USING ERRCODE = '22023';
      END IF;
      v_arg_types := ARRAY[]::TEXT[];
      FOR v_arg IN SELECT a FROM jsonb_array_elements(v_el->'args') AS a LOOP
        IF jsonb_typeof(v_arg) <> 'string' OR to_regtype(v_arg #>> '{}') IS NULL THEN
          RAISE EXCEPTION 'Interface declaration: rpc % has an argument type that does not resolve: %', v_name, v_arg
            USING ERRCODE = '22023';
        END IF;
        v_arg_types := v_arg_types || to_regtype(v_arg #>> '{}')::text;
      END LOOP;

      v_returns := NULL;
      IF v_el ? 'returns' THEN
        IF jsonb_typeof(v_el->'returns') <> 'string' THEN
          RAISE EXCEPTION 'Interface declaration: rpc % "returns" must be a string', v_name USING ERRCODE = '22023';
        END IF;
        v_returns := btrim(regexp_replace(v_el->>'returns', '\s+', ' ', 'g'));
        IF lower(v_returns) LIKE 'table(%' OR lower(v_returns) LIKE 'table (%' THEN
          v_returns := lower(regexp_replace(v_returns, '\s*([(),])\s*', '\1', 'g'));
        ELSIF lower(v_returns) LIKE 'setof %' THEN
          IF to_regtype(substr(v_returns, 7)) IS NULL THEN
            RAISE EXCEPTION 'Interface declaration: rpc % "returns" does not resolve: %', v_name, v_el->>'returns'
              USING ERRCODE = '22023';
          END IF;
          v_returns := 'SETOF ' || to_regtype(substr(v_returns, 7))::text;
        ELSE
          IF to_regtype(v_returns) IS NULL THEN
            RAISE EXCEPTION 'Interface declaration: rpc % "returns" does not resolve: %', v_name, v_el->>'returns'
              USING ERRCODE = '22023';
          END IF;
          v_returns := to_regtype(v_returns)::text;
        END IF;
      END IF;

      v_sig := format('%I.%I(%s)', v_parts[1], v_parts[2], array_to_string(v_arg_types, ','));
      v_proc := to_regprocedure(v_sig);

      IF v_proc IS NULL THEN
        v_rows := v_rows || jsonb_build_object('element', 'rpc', 'name', v_name, 'source', v_source,
          'difference', 'missing_rpc', 'severity', 'error',
          'expected', format('%s(%s)', v_name, array_to_string(v_arg_types, ', ')));
      ELSIF v_returns IS NOT NULL THEN
        v_live_returns := pg_get_function_result(v_proc);
        v_returns_differ := CASE WHEN v_returns LIKE 'table(%'
                THEN lower(regexp_replace(v_live_returns, '\s*([(),])\s*', '\1', 'g')) <> v_returns
                ELSE v_live_returns <> v_returns END;
        IF v_returns_differ THEN
          v_rows := v_rows || jsonb_build_object('element', 'rpc', 'name', v_name, 'source', v_source,
            'difference', 'type_mismatch', 'severity', 'error',
            'expected', v_el->>'returns', 'actual', v_live_returns);
        END IF;
      END IF;

    -- ----------------------------------------------------------------
    -- dimension
    -- ----------------------------------------------------------------
    ELSIF v_kind = 'dimension' THEN
      IF jsonb_typeof(v_el->'key') IS DISTINCT FROM 'string' OR btrim(v_el->>'key') = '' THEN
        RAISE EXCEPTION 'Interface declaration: dimension element % needs a "key"', v_idx USING ERRCODE = '22023';
      END IF;
      IF v_el ? 'table' AND (jsonb_typeof(v_el->'table') <> 'string'
           OR array_length(parse_ident(v_el->>'table'), 1) IS DISTINCT FROM 2) THEN
        RAISE EXCEPTION 'Interface declaration: dimension % "table" must be schema-qualified', v_el->>'key'
          USING ERRCODE = '22023';
      END IF;
      IF v_el ? 'columns' THEN
        IF jsonb_typeof(v_el->'columns') <> 'object' THEN
          RAISE EXCEPTION 'Interface declaration: dimension % "columns" must be an object of column roles', v_el->>'key'
            USING ERRCODE = '22023';
        END IF;
        FOR v_key IN SELECT jsonb_object_keys(v_el->'columns') LOOP
          IF v_key NOT IN ('key', 'label', 'parent', 'active', 'external_id', 'sort')
             OR jsonb_typeof(v_el->'columns'->v_key) <> 'string' THEN
            RAISE EXCEPTION 'Interface declaration: dimension % has an unknown or non-text column role "%"', v_el->>'key', v_key
              USING ERRCODE = '22023';
          END IF;
        END LOOP;
      END IF;

      SELECT * INTO v_dimrow FROM metadata.dimensions WHERE dimension_key = v_el->>'key';
      IF NOT FOUND THEN
        v_rows := v_rows || jsonb_build_object('element', 'dimension', 'name', v_el->>'key', 'source', v_source,
          'difference', 'missing_dimension', 'severity', 'error', 'expected', 'registered');
        CONTINUE;
      END IF;

      IF v_el ? 'table' THEN
        v_parts := parse_ident(v_el->>'table');
        IF v_parts[1] <> v_dimrow.table_schema OR v_parts[2] <> v_dimrow.table_name THEN
          v_rows := v_rows || jsonb_build_object('element', 'dimension', 'name', v_el->>'key', 'source', v_source,
            'difference', 'dimension_mismatch', 'severity', 'error',
            'expected', 'table ' || (v_el->>'table'),
            'actual', format('table %s.%s', v_dimrow.table_schema, v_dimrow.table_name));
        END IF;
      END IF;

      -- each declared column role names the same column as the registry, and that column exists
      v_live_rel := to_regclass(format('%I.%I', v_dimrow.table_schema, v_dimrow.table_name));
      FOR v_key IN SELECT jsonb_object_keys(coalesce(v_el->'columns', '{}'::jsonb)) ORDER BY 1 LOOP
        v_declcol := v_el->'columns'->>v_key;
        v_regcol := CASE v_key
            WHEN 'key'         THEN v_dimrow.key_column
            WHEN 'label'       THEN v_dimrow.label_column
            WHEN 'parent'      THEN v_dimrow.parent_column
            WHEN 'active'      THEN v_dimrow.active_column
            WHEN 'external_id' THEN v_dimrow.external_id_column
            ELSE                    v_dimrow.sort_column
          END;
        IF v_regcol IS DISTINCT FROM v_declcol THEN
          v_rows := v_rows || jsonb_build_object('element', 'dimension', 'name', v_el->>'key', 'source', v_source,
            'column_name', v_key, 'difference', 'dimension_mismatch', 'severity', 'error',
            'expected', 'column ' || v_declcol, 'actual', coalesce('column ' || v_regcol, 'no column'));
        ELSIF v_live_rel IS NULL OR NOT EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = v_live_rel AND a.attname = v_regcol AND a.attnum > 0 AND NOT a.attisdropped
        ) THEN
          v_rows := v_rows || jsonb_build_object('element', 'dimension', 'name', v_el->>'key', 'source', v_source,
            'column_name', v_key, 'difference', 'dimension_mismatch', 'severity', 'error',
            'expected', 'column ' || v_declcol, 'actual', 'the registry names a column the table no longer has');
        END IF;
      END LOOP;

    -- ----------------------------------------------------------------
    -- module
    -- ----------------------------------------------------------------
    ELSE
      IF jsonb_typeof(v_el->'key') IS DISTINCT FROM 'string' OR btrim(v_el->>'key') = '' THEN
        RAISE EXCEPTION 'Interface declaration: module element % needs a "key"', v_idx USING ERRCODE = '22023';
      END IF;
      IF v_el ? 'version' AND (jsonb_typeof(v_el->'version') <> 'string'
           OR v_el->>'version' !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') THEN
        RAISE EXCEPTION 'Interface declaration: module % "version" must be MAJOR.MINOR', v_el->>'key'
          USING ERRCODE = '22023';
      END IF;

      SELECT m.version INTO v_modver FROM metadata.modules m WHERE m.module_key = v_el->>'key';
      IF NOT FOUND THEN
        v_rows := v_rows || jsonb_build_object('element', 'module', 'name', v_el->>'key', 'source', v_source,
          'difference', 'missing_module', 'severity', 'error', 'expected', coalesce(v_el->>'version', 'installed'));
      ELSIF v_el ? 'version' THEN
        -- same major, minor at least the declared one (templates raise the major on any breaking change)
        v_decl_parts := string_to_array(v_el->>'version', '.')::int[];
        v_inst_parts := string_to_array(split_part(split_part(v_modver, '+', 1), '-', 1), '.')::int[];
        IF v_inst_parts[1] <> v_decl_parts[1] OR v_inst_parts[2] < v_decl_parts[2] THEN
          v_rows := v_rows || jsonb_build_object('element', 'module', 'name', v_el->>'key', 'source', v_source,
            'difference', 'module_version_mismatch', 'severity', 'error',
            'expected', v_el->>'version', 'actual', v_modver);
        END IF;
      END IF;
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT v_template, r->>'source', r->>'element', r->>'name', r->>'column_name', r->>'difference',
         r->>'severity', r->>'expected', r->>'actual'
  FROM jsonb_array_elements(v_rows) AS r
  ORDER BY r->>'element', r->>'name', r->>'column_name' NULLS FIRST, r->>'difference';
END;
$$;

COMMENT ON FUNCTION public.compare_interface(JSONB) IS
    'Compares the tables, columns, functions, dimensions and modules an install script declares it uses with the live schema; returns one row per difference (severity error or info) and none when the instance matches. Raises 22023 on a malformed declaration. See docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md. Added in v0.84.0; dimension and module elements compared since v0.85.0, the dimension sort role since v0.86.0.';

NOTIFY pgrst, 'reload schema';

COMMIT;
