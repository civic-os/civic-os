-- Deploy civic_os:v0-85-0-tree-parent-guard to pg
-- requires: v0-85-0-module-registry
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- A parent-cycle guard for any table with a self-referencing parent column, so every tree stays walkable.
-- Design: docs/notes/TREE_LIST_VIEW_DESIGN.md (Editing and cycle protection) and
-- docs/notes/IMPACT_REPORTING_DESIGN.md (Parent-cycle guard, decision 7).
--
--   metadata.tree_parent_guard()            row trigger function; key and parent column names as arguments
--   metadata._tree_cycle_rows()             keys of rows that are their own ancestor (existing cycles)
--   metadata._install_tree_parent_guard()   refuses a table that already holds a cycle, then installs the trigger
--   public.enable_tree_parent_guard()       installs it on a public base table; _is_db_admin()
--   tree_parent_cycle constraint message    friendly text, found by name through the existing error path
--   public.constraint_messages              error_message now goes through metadata.t('constraint_message', ...)
--
-- The trigger has no column list, so the parent column can still be dropped or renamed: the function reads
-- the row through to_jsonb() and returns at once when the column is gone. A cycle is refused with SQLSTATE
-- 23514 and a message in PostgreSQL's own check-violation form, which is how clients find the constraint
-- name (core's extractConstraintName() reads 'constraint "<name>"' from the message).

BEGIN;

-- ============================================================================
-- 1. metadata.tree_parent_guard()
-- ============================================================================
-- On insert only a parent equal to the row's own key is refused (a new row has no descendants). On an update
-- that changes the parent, the function takes a per-table advisory lock, so parent changes in one table run
-- one at a time, then walks ancestors from the new parent; reaching the row's key is a cycle. The walk uses
-- the CYCLE clause and a depth limit, so an existing cycle cannot make it loop. A definer, so RLS cannot hide
-- an ancestor from the walk.

CREATE FUNCTION metadata.tree_parent_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_key_col TEXT := TG_ARGV[0];
  v_parent_col TEXT := TG_ARGV[1];
  v_new JSONB := to_jsonb(NEW);
  v_key TEXT;
  v_parent TEXT;
  v_type TEXT;
  v_cycle BOOLEAN;
BEGIN
  -- the parent or key column was dropped or renamed: the guard is off until it is installed again
  IF NOT (v_new ? v_parent_col) OR NOT (v_new ? v_key_col) THEN
    RETURN NEW;
  END IF;

  v_parent := v_new ->> v_parent_col;
  IF v_parent IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) ->> v_parent_col) IS NOT DISTINCT FROM v_parent THEN
    RETURN NEW;
  END IF;

  v_key := v_new ->> v_key_col;

  IF v_parent = v_key THEN
    v_cycle := true;
  ELSIF TG_OP = 'INSERT' THEN
    v_cycle := false;
  ELSE
    PERFORM pg_advisory_xact_lock((hashtext('civic_os.tree_parent_guard')::bigint << 32) | TG_RELID::bigint);

    SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
    FROM pg_attribute a
    WHERE a.attrelid = TG_RELID AND a.attname = v_key_col AND NOT a.attisdropped;

    EXECUTE format(
      'WITH RECURSIVE anc(k, p, depth) AS ('
      '  SELECT t.%1$I, t.%2$I, 1 FROM %3$s t WHERE t.%1$I = $1::%4$s'
      '  UNION ALL'
      '  SELECT t.%1$I, t.%2$I, a.depth + 1 FROM %3$s t JOIN anc a ON t.%1$I = a.p WHERE a.depth < 10000'
      ') CYCLE k SET is_cycle USING path '
      'SELECT EXISTS (SELECT 1 FROM anc WHERE k = $2::%4$s)',
      v_key_col, v_parent_col, TG_RELID::regclass, v_type)
    INTO v_cycle
    USING v_parent, v_key;
  END IF;

  IF v_cycle THEN
    RAISE EXCEPTION 'new row for relation "%" violates check constraint "tree_parent_cycle"', TG_TABLE_NAME
      USING ERRCODE = '23514',
            CONSTRAINT = 'tree_parent_cycle',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            COLUMN = v_parent_col,
            DETAIL = 'A row cannot be placed under itself or one of its own descendants.';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION metadata.tree_parent_guard() IS
    'Row trigger (BEFORE INSERT OR UPDATE, no column list) that refuses a parent change creating a cycle: SQLSTATE 23514, constraint tree_parent_cycle. Arguments: key column, parent column. Returns at once when either column no longer exists. Installed by enable_tree_parent_guard() and register_dimension(). Added in v0.85.0.';

REVOKE EXECUTE ON FUNCTION metadata.tree_parent_guard() FROM PUBLIC;

-- ============================================================================
-- 2. metadata._tree_cycle_rows(): existing cycles
-- ============================================================================
-- Returns the keys (as text) of rows that are their own ancestor, up to p_limit, in key order.

CREATE FUNCTION metadata._tree_cycle_rows(
    p_table REGCLASS,
    p_key_column NAME,
    p_parent_column NAME,
    p_limit INT DEFAULT 20
)
RETURNS SETOF TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY EXECUTE format(
    'WITH RECURSIVE walk(start, k, p, depth) AS ('
    '  SELECT t.%1$I, t.%1$I, t.%2$I, 0 FROM %3$s t WHERE t.%2$I IS NOT NULL'
    '  UNION ALL'
    '  SELECT w.start, t.%1$I, t.%2$I, w.depth + 1 FROM walk w JOIN %3$s t ON t.%1$I = w.p'
    '  WHERE (w.depth = 0 OR w.k <> w.start) AND w.depth < 10000'
    ') CYCLE k SET is_cycle USING path '
    'SELECT DISTINCT start::text FROM walk WHERE depth > 0 AND k = start ORDER BY 1 LIMIT %4$s',
    p_key_column, p_parent_column, p_table, p_limit);
END;
$$;

COMMENT ON FUNCTION metadata._tree_cycle_rows(REGCLASS, NAME, NAME, INT) IS
    'Internal. Keys (as text) of rows that are their own ancestor through the parent column, up to p_limit. Added in v0.85.0.';

REVOKE EXECUTE ON FUNCTION metadata._tree_cycle_rows(REGCLASS, NAME, NAME, INT) FROM PUBLIC;

-- ============================================================================
-- 3. metadata._install_tree_parent_guard()
-- ============================================================================
-- Shared by enable_tree_parent_guard() and register_dimension(), after their own checks. Re-installing
-- replaces the trigger and refreshes its arguments, which repairs a guard after a column rename.

CREATE FUNCTION metadata._install_tree_parent_guard(
    p_table REGCLASS,
    p_key_column NAME,
    p_parent_column NAME
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_cycles TEXT[];
BEGIN
  SELECT array_agg(k) INTO v_cycles
  FROM metadata._tree_cycle_rows(p_table, p_key_column, p_parent_column) AS k;

  IF v_cycles IS NOT NULL THEN
    RAISE EXCEPTION 'new row for relation "%" violates check constraint "tree_parent_cycle"', p_table
      USING ERRCODE = '23514',
            CONSTRAINT = 'tree_parent_cycle',
            DETAIL = format('%s already contains a cycle through %s; rows in a cycle (first %s): %s',
                            p_table, p_parent_column, cardinality(v_cycles), array_to_string(v_cycles, ', ')),
            HINT = 'Set the parent of one row in each cycle to NULL or to a row outside the cycle, then install the guard again.';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE TRIGGER tree_parent_guard BEFORE INSERT OR UPDATE ON %s '
    'FOR EACH ROW EXECUTE FUNCTION metadata.tree_parent_guard(%L, %L)',
    p_table, p_key_column, p_parent_column);
END;
$$;

COMMENT ON FUNCTION metadata._install_tree_parent_guard(REGCLASS, NAME, NAME) IS
    'Internal. Refuses (23514, tree_parent_cycle) a table that already holds a cycle, naming its rows; otherwise creates or replaces the tree_parent_guard trigger with the given key and parent columns. Added in v0.85.0.';

REVOKE EXECUTE ON FUNCTION metadata._install_tree_parent_guard(REGCLASS, NAME, NAME) FROM PUBLIC;

-- ============================================================================
-- 4. public.enable_tree_parent_guard()
-- ============================================================================
-- Accepts only a base table in public (the tables schema_entities lists as base tables) and a parent column
-- with a single-column FK from the table to its own key column. Identifiers are quoted and only the fixed
-- trigger is installed, so the admin JWT path that _is_db_admin() admits cannot run other DDL.
-- SQLSTATEs: 42501 neither an admin JWT nor the deployment role; 22023 table or columns do not qualify;
-- 23514 the table already holds a cycle.

CREATE FUNCTION public.enable_tree_parent_guard(
    p_table NAME,
    p_parent_column NAME,
    p_key_column NAME DEFAULT 'id'
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_rel OID;
BEGIN
  IF NOT metadata._is_db_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT c.oid INTO v_rel
  FROM pg_catalog.pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname = p_table AND c.relkind IN ('r', 'p');
  IF v_rel IS NULL THEN
    RAISE EXCEPTION 'public.% is not a base table in public', p_table USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_attribute pa ON pa.attrelid = v_rel AND pa.attnum = k.conkey[1]
    JOIN pg_catalog.pg_attribute ka ON ka.attrelid = v_rel AND ka.attnum = k.confkey[1]
    WHERE k.conrelid = v_rel AND k.confrelid = v_rel AND k.contype = 'f'
      AND cardinality(k.conkey) = 1
      AND pa.attname = p_parent_column AND ka.attname = p_key_column
  ) THEN
    RAISE EXCEPTION 'public.%.% is not a foreign key to public.%.%', p_table, p_parent_column, p_table, p_key_column
      USING ERRCODE = '22023',
            HINT = 'The parent column needs a single-column foreign key from the table to its own key column.';
  END IF;

  PERFORM metadata._install_tree_parent_guard(v_rel::regclass, p_key_column, p_parent_column);
END;
$$;

COMMENT ON FUNCTION public.enable_tree_parent_guard(NAME, NAME, NAME) IS
    'Installs the tree_parent_guard trigger on a public base table whose parent column is a foreign key to its own key column, refusing a table that already holds a cycle. Admin JWT or the deployment role (metadata._is_db_admin()). Added in v0.85.0.';

REVOKE EXECUTE ON FUNCTION public.enable_tree_parent_guard(NAME, NAME, NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enable_tree_parent_guard(NAME, NAME, NAME) TO authenticated;

-- ============================================================================
-- 5. The tree_parent_cycle constraint message
-- ============================================================================
-- A framework constraint name, raised for any guarded table, so table_name is the '*' wildcard. The
-- English text is also seeded as the translation default (v0-85-0-registry-translations).

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES ('tree_parent_cycle', '*', NULL,
        'A record cannot be placed under itself or one of its own descendants. Choose a different parent.')
ON CONFLICT (constraint_name) DO NOTHING;

-- ============================================================================
-- 6. public.constraint_messages: translated error_message
-- ============================================================================
-- Same columns and grants as v0.9.0; error_message goes through metadata.t(), source type
-- 'constraint_message', key = constraint_name. English short-circuits to the stored text. Core already
-- re-reads constraint messages per locale and drops them when the translations cache version moves.

CREATE OR REPLACE VIEW public.constraint_messages AS
SELECT
  constraint_name,
  table_name,
  column_name,
  metadata.t('constraint_message', constraint_name::text, error_message) COLLATE "default" AS error_message
FROM metadata.constraint_messages;

COMMENT ON VIEW public.constraint_messages IS
  'User-friendly error messages for database constraint violations, translated through metadata.t() (source type constraint_message, key = constraint name) since v0.85.0. Read-only view of metadata.constraint_messages. Used by the frontend error handling to display friendly messages instead of PostgreSQL error codes.';

GRANT SELECT ON public.constraint_messages TO web_anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
