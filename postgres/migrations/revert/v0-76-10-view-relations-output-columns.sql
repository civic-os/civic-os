-- Revert civic_os:v0-76-10-view-relations-output-columns from pg
--
-- WARNING: restores the v0.41.0 body, which pairs every base column the view merely depends on
-- (JOIN conditions, WHERE clauses, expressions) with a same-named view column. Intended only for
-- round-trip migration testing.

BEGIN;

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
  WITH view_base_cols AS (
    -- Find base table columns that each public VIEW depends on
    SELECT DISTINCT
      v.relname        AS view_name,
      base_att.attname AS base_column,
      base_cl.oid      AS base_relid
    FROM pg_class v
    JOIN pg_namespace v_ns ON v_ns.oid = v.relnamespace
    -- View's rewrite rule
    JOIN pg_rewrite rw ON rw.ev_class = v.oid
    -- Dependencies of that rewrite rule on base table columns
    JOIN pg_depend d
      ON d.objid = rw.oid
     AND d.classid = 'pg_rewrite'::regclass
     AND d.refclassid = 'pg_class'::regclass
     AND d.deptype = 'n'          -- normal dependency
     AND d.refobjsubid > 0        -- column-level (subid > 0)
    -- Base table
    JOIN pg_class base_cl ON base_cl.oid = d.refobjid
    -- Base column
    JOIN pg_attribute base_att
      ON base_att.attrelid = d.refobjid
     AND base_att.attnum = d.refobjsubid
     AND NOT base_att.attisdropped
    WHERE v.relkind = 'v'
      AND v_ns.nspname = 'public'
      AND base_cl.relkind IN ('r', 'v', 'f', 'p')
  )
  SELECT DISTINCT ON (vbc.view_name, vbc.base_column)
    vbc.view_name,
    vbc.base_column   AS view_column,
    tgt_ns.nspname    AS join_schema,
    tgt_cl.relname    AS join_table,
    tgt_att.attname   AS join_column
  FROM view_base_cols vbc
  -- FK constraints on the base table
  JOIN pg_constraint con
    ON con.conrelid = vbc.base_relid
   AND con.contype = 'f'
  -- Unnest to find which FK column matches our base column
  JOIN LATERAL unnest(con.conkey, con.confkey)
       WITH ORDINALITY AS cols(src_attnum, tgt_attnum, ord) ON true
  JOIN pg_attribute src_att
    ON src_att.attrelid = con.conrelid
   AND src_att.attnum = cols.src_attnum
  -- Only rows where the FK source column matches our base column
  -- Target table/column
  JOIN pg_class tgt_cl ON tgt_cl.oid = con.confrelid
  JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt_cl.relnamespace
  JOIN pg_attribute tgt_att
    ON tgt_att.attrelid = con.confrelid
   AND tgt_att.attnum = cols.tgt_attnum
  WHERE src_att.attname = vbc.base_column
$$;

COMMENT ON FUNCTION public.schema_view_relations_func IS
    'Traces VIEW columns to base table FK constraints via pg_depend/pg_rewrite
     (50x faster than information_schema.view_column_usage).
     Returns: view_name, view_column, join_schema, join_table, join_column.
     Limitations: Does not work for computed columns or complex expressions.
     Rewritten in v0.41.0 for performance; return type unchanged from v0.28.0.';


DROP FUNCTION IF EXISTS metadata.view_rule_to_json(NAME, TEXT);

NOTIFY pgrst, 'reload schema';

COMMIT;
