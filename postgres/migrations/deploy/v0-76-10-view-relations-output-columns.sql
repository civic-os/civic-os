-- Deploy civic_os:v0-76-10-view-relations-output-columns to pg
-- requires: v0-76-9-split-applies-new-schedule

BEGIN;

-- ============================================================================
-- schema_view_relations_func(): infer view FKs from the view's OUTPUT columns
-- ============================================================================
-- Only views registered in metadata.entities are inferred (the function returns no rows for
-- any other view): schema_properties exposes only registered entities, and an unregistered
-- view is not an entity at all. The rest of this note describes how the FK of a registered
-- view's column is inferred.
--
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
-- Fallback: the text-to-JSON conversion lives in metadata.view_rule_to_json(), a plpgsql
-- helper that catches a failed conversion, raises a WARNING naming the view and returns
-- NULL. A view whose conversion fails (an internal node-tree format this parser does not
-- know) falls back, as a whole, to the v0.41.0 pg_depend name matching: it keeps that
-- behavior, including its false positives, instead of taking down schema_properties for
-- every view. The trigger is a failed conversion only; a view that parses but yields no FK
-- for a column does NOT fall back (that is the correct answer, and falling back per column
-- would bring the join-only false positive back).
--
-- Cost: parsing is the expensive part, so only views that can matter are parsed. First,
-- views registered in metadata.entities: the only consumer, schema_properties, keeps rows
-- for tables in schema_entities, and a view is in schema_entities only with a
-- metadata.entities row, so the function now returns rows only for registered views
-- (registering a view was already required for it to appear at all). The large schema_*
-- system views are skipped this way. Second, views whose rule depends on at least one FK
-- source column; any column a view outputs from a base table is such a dependency, so no
-- other view can be given an FK. Both filters sit in view_rules, which the fallback branch
-- reads too.
--
-- Limits: direct column references only; no view-over-view chains (the origin of a
-- column read through another view is that view, which has no FK constraint); no
-- UNION views; composite FKs map column by column, as before. When a column carries
-- more than one FK, the one with the alphabetically first constraint name wins, so the
-- output is deterministic (the old body had no ORDER BY). Explicit join settings in
-- metadata.properties still win over this inference (schema_properties COALESCE order).

-- ============================================================================
-- metadata.view_rule_to_json(): pg_rewrite.ev_action text -> JSON, NULL on failure
-- ============================================================================
-- Internal helper (metadata schema, not exposed through PostgREST). plpgsql because a
-- SQL function cannot catch the error raised by an invalid ::json cast. Called only from
-- schema_view_relations_func(), which is SECURITY DEFINER and runs as the owner, so
-- EXECUTE is revoked from PUBLIC and nothing is granted.
--
-- Conversion steps (the text is rewritten into JSON that keeps the node nesting plus the
-- four fields needed):
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
-- A result without a top-level targetList is treated as a failed conversion too.

CREATE OR REPLACE FUNCTION metadata.view_rule_to_json(p_view_name NAME, p_rule_text TEXT)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_json JSON;
BEGIN
  v_json := replace(replace(replace(replace(replace(replace(replace(
    regexp_replace(
      replace(replace(replace(
        regexp_replace(
          replace(regexp_replace(regexp_replace(p_rule_text, '\\.|,', '', 'g'),
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
    ' ', ',')::json;

  IF json_typeof(v_json -> 0 -> 'targetList') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'no top-level targetList found';
  END IF;

  RETURN v_json;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'schema_view_relations_func: cannot read the rewrite rule of view public.% (%); using dependency-based FK inference for it',
    p_view_name, SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION metadata.view_rule_to_json(NAME, TEXT) FROM PUBLIC;

COMMENT ON FUNCTION metadata.view_rule_to_json IS
    'Internal helper for public.schema_view_relations_func(): converts a view''s pg_rewrite.ev_action
     text to JSON (node nesting plus targetList/resno/resorigtbl/resorigcol). Returns NULL and raises
     a WARNING naming the view when the conversion fails. Added in v0.76.10.';


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
    -- One row per public view that depends on at least one FK source column, with its
    -- rewrite rule as JSON. Every base column a view outputs is a dependency of its rule,
    -- so a view without such a dependency cannot be given an FK and is not parsed at all
    -- (parsing is the expensive part). rule_json is NULL when the helper could not convert
    -- the rule; that view then takes the fallback branch below.
    SELECT
      v.oid     AS view_oid,
      v.relname AS view_name,
      metadata.view_rule_to_json(v.relname, rw.ev_action::text) AS rule_json
    FROM pg_class v
    JOIN pg_namespace v_ns ON v_ns.oid = v.relnamespace
    JOIN pg_rewrite rw ON rw.ev_class = v.oid
    WHERE v.relkind = 'v'
      AND v_ns.nspname = 'public'
      AND rw.rulename = '_RETURN'
      -- only registered views: schema_properties, the only consumer, keeps rows for tables
      -- in schema_entities, and a view is in schema_entities only with a metadata.entities row
      AND EXISTS (SELECT 1 FROM metadata.entities e WHERE e.table_name = v.relname)
      AND EXISTS (
        SELECT 1
        FROM pg_depend d
        JOIN pg_constraint fk
          ON fk.conrelid = d.refobjid
         AND fk.contype = 'f'
         AND d.refobjsubid::int2 = ANY (fk.conkey)
        WHERE d.objid = rw.oid
          AND d.classid = 'pg_rewrite'::regclass
          AND d.refclassid = 'pg_class'::regclass
          AND d.deptype = 'n'
          AND d.refobjsubid > 0
      )
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
    WHERE vr.rule_json IS NOT NULL
      AND (te ->> 'resorigtbl')::oid <> 0   -- 0 = expression, not a column reference
  ),
  inferred AS (
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
  ),
  -- Fallback (v0.41.0 body) for views whose rule could not be converted: base columns the
  -- view depends on, paired with a same-named view column
  view_base_cols AS (
    SELECT DISTINCT
      v.relname        AS view_name,
      base_att.attname AS base_column,
      base_cl.oid      AS base_relid
    FROM view_rules vr
    JOIN pg_class v ON v.oid = vr.view_oid
    JOIN pg_rewrite rw ON rw.ev_class = v.oid AND rw.rulename = '_RETURN'
    JOIN pg_depend d
      ON d.objid = rw.oid
     AND d.classid = 'pg_rewrite'::regclass
     AND d.refclassid = 'pg_class'::regclass
     AND d.deptype = 'n'
     AND d.refobjsubid > 0
    JOIN pg_class base_cl ON base_cl.oid = d.refobjid
    JOIN pg_attribute base_att
      ON base_att.attrelid = d.refobjid
     AND base_att.attnum = d.refobjsubid
     AND NOT base_att.attisdropped
    WHERE vr.rule_json IS NULL
      AND base_cl.relkind IN ('r', 'v', 'f', 'p')
  ),
  fallback AS (
  SELECT DISTINCT ON (vbc.view_name, vbc.base_column)
    vbc.view_name,
    vbc.base_column   AS view_column,
    tgt_ns.nspname    AS join_schema,
    tgt_cl.relname    AS join_table,
    tgt_att.attname   AS join_column
  FROM view_base_cols vbc
  JOIN pg_constraint con
    ON con.conrelid = vbc.base_relid
   AND con.contype = 'f'
  JOIN LATERAL unnest(con.conkey, con.confkey)
       AS cols(src_attnum, tgt_attnum) ON true
  JOIN pg_attribute src_att
    ON src_att.attrelid = con.conrelid
   AND src_att.attnum = cols.src_attnum
  JOIN pg_class tgt_cl ON tgt_cl.oid = con.confrelid
  JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt_cl.relnamespace
  JOIN pg_attribute tgt_att
    ON tgt_att.attrelid = con.confrelid
   AND tgt_att.attnum = cols.tgt_attnum
  WHERE src_att.attname = vbc.base_column
  ORDER BY vbc.view_name, vbc.base_column, con.conname
  )
  SELECT * FROM inferred
  UNION ALL
  SELECT * FROM fallback
  ORDER BY view_name, view_column
$$;

COMMENT ON FUNCTION public.schema_view_relations_func IS
    'Returns rows only for views registered in metadata.entities (what schema_properties
     exposes); an unregistered view gets no inferred FKs.
     Infers FKs on public VIEW columns from the view''s output columns: a view column
     gets the FK of the base column it outputs directly, under the view''s own column name
     (aliases included). Columns used only in JOIN/WHERE clauses or in expressions get none.
     Reads the top-level target list (resorigtbl/resorigcol) from pg_rewrite.ev_action via
     metadata.view_rule_to_json(). A view whose rule cannot be converted (WARNING logged) falls
     back, whole, to the v0.41.0 pg_depend name matching.
     Returns: view_name, view_column, join_schema, join_table, join_column.
     Limitations: direct column references only; no view-over-view chains or UNION views.
     Rewritten in v0.76.10 (was pg_depend name matching since v0.41.0).';

NOTIFY pgrst, 'reload schema';

COMMIT;
