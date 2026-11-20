-- Deploy civic_os:v0-84-0-compare-interface to pg
-- requires: v0-84-0-install-path-guards
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Interface comparison for install scripts: before any change, a script declares the tables, columns and
-- functions it uses, and core compares them with the live schema.
-- Design: docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md (section 1, Phasing step 2).
--
--   public.compare_interface(jsonb)          one row per difference (none when the instance matches)
--   public.assert_interface(jsonb)           NOTICE per info row; SQLSTATE 55000 if any error row
--   metadata._interface_type_difference()    the type-widening rules, shared by both
--
-- Element kinds: table and rpc are compared. dimension and module elements are validated and reported as
-- missing_core_feature while metadata.dimensions and metadata.modules do not exist (they arrive in v0.85.0).
-- A malformed declaration (unknown element or key, missing name, unresolvable type) is a bug in the script,
-- not a difference in the instance: both functions raise 22023 at once.
--
-- Both read pg_catalog only (information_schema is filtered by the caller's privileges, and schema_properties
-- covers only public), write nothing and are SECURITY INVOKER: they reveal catalog facts any role can read.

BEGIN;

-- ============================================================================
-- 1. metadata._interface_type_difference(): declared type -> live type
-- ============================================================================
-- Returns NULL when the types are the same, 'widened' for an accepted read-safe widening, else
-- 'type_mismatch'. Accepted widenings (and nothing else; an addition is a design change):
--   varchar(n) -> varchar(m) with m >= n, unbounded varchar, or text
--   numeric(p,s) -> numeric(p',s') with s' >= s and p'-s' >= p-s, or unconstrained numeric
--   smallint -> integer -> bigint
-- A domain matches only itself, so text <-> email_address is a mismatch.

CREATE FUNCTION metadata._interface_type_difference(
    p_declared_type OID,
    p_declared_typmod INT,
    p_live_type OID,
    p_live_typmod INT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_dp INT; v_ds INT; v_lp INT; v_ls INT;
BEGIN
  IF p_declared_type = p_live_type AND p_declared_typmod = p_live_typmod THEN
    RETURN NULL;
  END IF;

  -- varchar: typmod is the length + 4 (VARHDRSZ); -1 is unbounded
  IF p_declared_type = 'varchar'::regtype THEN
    IF p_live_type = 'text'::regtype THEN
      RETURN 'widened';
    END IF;
    IF p_live_type = 'varchar'::regtype THEN
      IF p_live_typmod = -1 THEN
        RETURN 'widened';
      END IF;
      IF p_declared_typmod <> -1 AND p_live_typmod >= p_declared_typmod THEN
        RETURN 'widened';
      END IF;
    END IF;
    RETURN 'type_mismatch';
  END IF;

  -- numeric: typmod is ((precision << 16) | scale) + 4, the scale an 11-bit signed field; -1 is unconstrained
  IF p_declared_type = 'numeric'::regtype AND p_live_type = 'numeric'::regtype THEN
    IF p_live_typmod = -1 THEN
      RETURN 'widened';
    END IF;
    IF p_declared_typmod = -1 THEN
      RETURN 'type_mismatch';
    END IF;
    v_dp := ((p_declared_typmod - 4) >> 16) & 65535;
    v_ds := (((p_declared_typmod - 4) & 2047) # 1024) - 1024;
    v_lp := ((p_live_typmod - 4) >> 16) & 65535;
    v_ls := (((p_live_typmod - 4) & 2047) # 1024) - 1024;
    IF v_ls >= v_ds AND (v_lp - v_ls) >= (v_dp - v_ds) THEN
      RETURN 'widened';
    END IF;
    RETURN 'type_mismatch';
  END IF;

  -- integer widths
  IF (p_declared_type = 'int2'::regtype AND p_live_type IN ('int4'::regtype, 'int8'::regtype))
     OR (p_declared_type = 'int4'::regtype AND p_live_type = 'int8'::regtype) THEN
    RETURN 'widened';
  END IF;

  RETURN 'type_mismatch';
END;
$$;

COMMENT ON FUNCTION metadata._interface_type_difference(OID, INT, OID, INT) IS
    'Internal to compare_interface(). NULL when a declared column type equals the live one; ''widened'' for a read-safe widening (longer varchar or text, wider numeric, smallint to integer to bigint); otherwise ''type_mismatch''. Added in v0.84.0.';

REVOKE EXECUTE ON FUNCTION metadata._interface_type_difference(OID, INT, OID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metadata._interface_type_difference(OID, INT, OID, INT) TO authenticated;

-- ============================================================================
-- 2. public.compare_interface(jsonb)
-- ============================================================================
-- Input:
--   { "template": "people_served@1.1.0",
--     "elements": [
--       { "element": "table", "name": "public.programs", "source": "shared/program", "writes": false,
--         "columns": [ { "name": "parent_id", "type": "bigint", "nullable": true,
--                        "references": "public.programs.id" } ] },
--       { "element": "rpc", "name": "public.dimension_subtree", "args": ["text", "bigint"],
--         "returns": "setof bigint" },
--       { "element": "dimension", "key": "program", "table": "public.programs",
--         "columns": { "key": "id", "parent": "parent_id" } },
--       { "element": "module", "key": "people_served", "version": "1.2" } ] }
-- Every property given is checked; every property left out is not. Columns a table element does not list
-- are never looked at, except with "writes": true, where each must accept an omitted value.

CREATE FUNCTION public.compare_interface(p_declared JSONB)
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
          IF v_key NOT IN ('key', 'label', 'parent', 'active', 'external_id')
             OR jsonb_typeof(v_el->'columns'->v_key) <> 'string' THEN
            RAISE EXCEPTION 'Interface declaration: dimension % has an unknown or non-text column role "%"', v_el->>'key', v_key
              USING ERRCODE = '22023';
          END IF;
        END LOOP;
      END IF;

      IF to_regclass('metadata.dimensions') IS NULL THEN
        v_rows := v_rows || jsonb_build_object('element', 'dimension', 'name', v_el->>'key', 'source', v_source,
          'difference', 'missing_core_feature', 'severity', 'error', 'expected', 'metadata.dimensions');
      ELSE
        RAISE EXCEPTION 'compare_interface() does not compare dimension elements in this core version'
          USING ERRCODE = '0A000';
      END IF;

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

      IF to_regclass('metadata.modules') IS NULL THEN
        v_rows := v_rows || jsonb_build_object('element', 'module', 'name', v_el->>'key', 'source', v_source,
          'difference', 'missing_core_feature', 'severity', 'error', 'expected', 'metadata.modules');
      ELSE
        RAISE EXCEPTION 'compare_interface() does not compare module elements in this core version'
          USING ERRCODE = '0A000';
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
    'Compares the tables, columns, functions, dimensions and modules an install script declares it uses with the live schema; returns one row per difference (severity error or info) and none when the instance matches. Raises 22023 on a malformed declaration. See docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md. Added in v0.84.0.';

REVOKE EXECUTE ON FUNCTION public.compare_interface(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compare_interface(JSONB) TO authenticated;

-- ============================================================================
-- 3. public.assert_interface(jsonb)
-- ============================================================================
-- Prints each info row as a NOTICE and, if any row is an error, raises SQLSTATE 55000 with the template
-- and the error count in the message and one line per error in DETAIL:
--   ERROR:  interface check failed for people_served@1.1.0: 1 difference
--   DETAIL: public.programs.external_id: type integer, required text (required by shared/program)

CREATE FUNCTION public.assert_interface(p_declared JSONB)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row RECORD;
  v_line TEXT;
  v_errors TEXT[] := ARRAY[]::TEXT[];
  v_template TEXT;
BEGIN
  FOR v_row IN SELECT * FROM public.compare_interface(p_declared) LOOP
    v_template := v_row.template;
    v_line := v_row.name || coalesce('.' || v_row.column_name, '') || ': ' ||
      CASE v_row.difference
        WHEN 'missing_table'           THEN 'table is missing'
        WHEN 'kind_mismatch'           THEN format('is a %s, required a table', v_row.actual)
        WHEN 'missing_column'          THEN 'column is missing'
        WHEN 'type_mismatch'           THEN format('type %s, required %s', v_row.actual, v_row.expected)
        WHEN 'widened'                 THEN format('type %s, declared %s (widened, accepted)', v_row.actual, v_row.expected)
        WHEN 'nullability_mismatch'    THEN 'nullable, required NOT NULL'
        WHEN 'now_required'            THEN 'NOT NULL, declared nullable (accepted)'
        WHEN 'missing_reference'       THEN format('no foreign key to %s', v_row.expected)
        WHEN 'reference_mismatch'      THEN format('foreign key to %s, required %s', v_row.actual, v_row.expected)
        WHEN 'missing_default'         THEN format('%s; the script inserts rows without this column', v_row.actual)
        WHEN 'missing_dimension'       THEN 'dimension is not registered'
        WHEN 'dimension_mismatch'      THEN format('%s, required %s', v_row.actual, v_row.expected)
        WHEN 'missing_module'          THEN 'module is not installed'
        WHEN 'module_version_mismatch' THEN format('version %s, required %s', v_row.actual, v_row.expected)
        WHEN 'missing_rpc'             THEN format('function %s is missing', v_row.expected)
        WHEN 'missing_core_feature'    THEN format('requires %s, which this core version does not have', v_row.expected)
        ELSE v_row.difference
      END ||
      coalesce(' (required by ' || v_row.source || ')', '');

    IF v_row.severity = 'info' THEN
      RAISE NOTICE 'interface check for %: %', coalesce(v_template, '(unnamed)'), v_line;
    ELSE
      v_errors := v_errors || v_line;
    END IF;
  END LOOP;

  IF cardinality(v_errors) > 0 THEN
    RAISE EXCEPTION 'interface check failed for %: % %',
        coalesce(v_template, '(unnamed)'), cardinality(v_errors),
        CASE WHEN cardinality(v_errors) = 1 THEN 'difference' ELSE 'differences' END
      USING ERRCODE = '55000', DETAIL = array_to_string(v_errors, E'\n');
  END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_interface(JSONB) IS
    'Runs compare_interface(): prints info rows as NOTICEs and raises SQLSTATE 55000 (one DETAIL line per difference) if any row is an error. An install script calls it before any change. Added in v0.84.0.';

REVOKE EXECUTE ON FUNCTION public.assert_interface(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_interface(JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
