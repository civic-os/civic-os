-- Deploy civic_os:v0-76-10-view-relations-output-columns to pg
-- requires: v0-76-9-split-applies-new-schedule

BEGIN;

-- ============================================================================
-- schema_view_relations_func(): infer view FKs from the view's OUTPUT columns
-- ============================================================================
-- What was wrong (v0.41.0 body): the function walked pg_rewrite -> pg_depend to every
-- base column the view's rule depends on, then reported each base column that has an FK
-- under the SAME NAME on the view. pg_depend also lists columns used only in JOIN
-- conditions, WHERE clauses and expressions, and nothing checked that the view outputs
-- that column. Example: staff_directory outputs sm.id and joins
-- civic_os_users_private cup ON cup.id = sm.user_id. cup.id is an FK to civic_os_users,
-- so staff_directory.id (an int8) was reported as an FK to civic_os_users. The opposite
-- gap: an aliased column (t.user_id AS owner) got no FK.
--
-- The rule now: a view column gets an inferred FK only when the view outputs a base
-- column DIRECTLY, under whatever name the view gives it. The parser records the origin
-- of every plain column reference on the top-level target list entry
-- (resorigtbl / resorigcol, both 0 for expressions); PostgreSQL has no catalog column
-- for it, so it is read from pg_rewrite.ev_action. Origins are tracked through JOINs,
-- subqueries in FROM and CTEs, but not through UNION/INTERSECT/EXCEPT or expressions.
--
-- Parsing: ev_action is a pg_node_tree whose top-level Query holds the view's target
-- list, while subqueries, CTEs and sublinks hold target lists of their own. Only a
-- structure-aware read is safe, so the text is rewritten into JSON that keeps the
-- node nesting plus the four fields needed, and the top-level object's targetList is
-- read from that. The approach follows PostgREST's "view key dependencies" query
-- (SchemaCache.hs, allViewsKeyDependencies), which resolves views the same way.
--
-- Limits: direct column references only; no view-over-view chains (the origin of a
-- column read through another view is that view, which has no FK constraint); no
-- UNION views; composite FKs map column by column, as before. When a column carries
-- more than one FK, the one with the alphabetically first constraint name wins, so the
-- output is deterministic (the old body had no ORDER BY). Explicit join settings in
-- metadata.properties still win over this inference (schema_properties COALESCE order).

CREATE OR REPLACE FUNCTION public.schema_view_relations_func()
RETURNS TABLE (
  view_name NAME,
  view_column NAME,
  join_schema NAME,
  join_table NAME,
  join_column NAME
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
  WITH view_rules AS (
    -- One row per public view with its rewrite rule as text, cleaned for JSON conversion:
    --   1. drop backslash-escaped characters (escaped spaces, braces and parens inside
    --      names) and commas, which are not escaped but would break the JSON below, then
    --      drop any ':token' that directly follows a field name: field values are never
    --      omitted, so it is a string value (a column alias such as ':resno') and not a field
    --   2. a null node ('<>') becomes an empty list
    --   3. keep the four fields we read as JSON keys: ' :resno 3' -> ',"resno":3'
    --   4. '{' becomes '{ :' so the node type name is swallowed with the unused fields
    --   5. protect node lists ('({' and '((') from the next step with a leading '{'
    --   6. every other field (' :name value...', up to the next brace or comma) is
    --      replaced by an empty key
    --   7. tidy up empty keys, unprotect lists, then lists -> arrays and spaces -> commas
    SELECT
      v.oid     AS view_oid,
      v.relname AS view_name,
      replace(replace(replace(replace(replace(replace(replace(
        regexp_replace(
          replace(replace(replace(
            regexp_replace(
              replace(regexp_replace(regexp_replace(rw.ev_action::text, '\\.|,', '', 'g'),
                                     '( :[a-z_]+) :[^ ]*', '\1', 'g'), '<>', '()'),
              ' :(targetList|resno|resorigtbl|resorigcol) ', ',"\1":', 'g'),
            '{', '{ :'),
            '((', '{(('),
            '({', '{({'),
          ' :[^}{,]+', ',"":', 'g'),
        ',"":}', '}'),
        ',"":,', ','),
        '{(', '('),
        '{,', '{'),
        '(', '['),
        ')', ']'),
        ' ', ',')::json AS rule_json
    FROM pg_class v
    JOIN pg_namespace v_ns ON v_ns.oid = v.relnamespace
    JOIN pg_rewrite rw ON rw.ev_class = v.oid
    WHERE v.relkind = 'v'
      AND v_ns.nspname = 'public'
      AND rw.rulename = '_RETURN'
  ),
  view_output_cols AS (
    -- Top-level target list: (view column position, base relation, base column). The
    -- rule is a one-element list holding the Query node; subquery and CTE target lists
    -- sit in nested objects and are never reached through this key.
    SELECT
      vr.view_name,
      va.attname       AS view_column,
      (te ->> 'resorigtbl')::oid AS base_relid,
      (te ->> 'resorigcol')::int AS base_attnum
    FROM view_rules vr
    CROSS JOIN LATERAL json_array_elements(vr.rule_json -> 0 -> 'targetList') AS te
    -- The view column is the attribute at the entry's position; this also drops
    -- resjunk entries (e.g. an ORDER BY column that is not selected).
    JOIN pg_attribute va
      ON va.attrelid = vr.view_oid
     AND va.attnum = (te ->> 'resno')::int
     AND NOT va.attisdropped
    WHERE (te ->> 'resorigtbl')::oid <> 0   -- 0 = expression, not a column reference
  )
  SELECT DISTINCT ON (voc.view_name, voc.view_column)
    voc.view_name,
    voc.view_column,
    tgt_ns.nspname    AS join_schema,
    tgt_cl.relname    AS join_table,
    tgt_att.attname   AS join_column
  FROM view_output_cols voc
  -- FK constraints on the base table
  JOIN pg_constraint con
    ON con.conrelid = voc.base_relid
   AND con.contype = 'f'
  -- Pair each FK source column with its target column; keep the one for our column
  JOIN LATERAL unnest(con.conkey, con.confkey)
       AS cols(src_attnum, tgt_attnum)
    ON cols.src_attnum = voc.base_attnum
  -- Target table/column
  JOIN pg_class tgt_cl ON tgt_cl.oid = con.confrelid
  JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt_cl.relnamespace
  JOIN pg_attribute tgt_att
    ON tgt_att.attrelid = con.confrelid
   AND tgt_att.attnum = cols.tgt_attnum
  ORDER BY voc.view_name, voc.view_column, con.conname
$$;

COMMENT ON FUNCTION public.schema_view_relations_func IS
    'Infers FKs on public VIEW columns from the view''s output columns: a view column
     gets the FK of the base column it outputs directly, under the view''s own column name
     (aliases included). Columns used only in JOIN/WHERE clauses or in expressions get none.
     Reads the top-level target list (resorigtbl/resorigcol) from pg_rewrite.ev_action.
     Returns: view_name, view_column, join_schema, join_table, join_column.
     Limitations: direct column references only; no view-over-view chains or UNION views.
     Rewritten in v0.76.10 (was pg_depend name matching since v0.41.0).';

NOTIFY pgrst, 'reload schema';

COMMIT;
