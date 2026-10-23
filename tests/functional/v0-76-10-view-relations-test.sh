#!/bin/bash
# =============================================================================
# Functional Test: v0-76-10 view FK inference follows the view's output columns
# =============================================================================
# public.schema_view_relations_func() reports which public view columns inherit a foreign key.
# Before v0.76.10 it paired every base column with an FK that the view merely DEPENDED ON
# (JOIN conditions, WHERE clauses, expressions) with a view column of the same name, so
# staff_directory.id (an int8 from staff_members) was reported as an FK to civic_os_users.
# The function now reads the top-level target list of the view's rewrite rule and reports an FK
# only for a column the view outputs directly, under the view's own column name.
#
# Each case builds a small table pair and a public view, then asserts the function's rows for that
# view. Cases that pin documented limits (UNION, view over view, expressions) say so.
#
# All fixtures are created inside one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-76-10-view-relations-test.sh
#
# Environment overrides (the connecting user must be a superuser, to create fixtures):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

-- ---------------------------------------------------------------------------
-- Fixture tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.vr_parent (id int PRIMARY KEY, name text);
CREATE TABLE public.vr_other  (id int PRIMARY KEY);
CREATE TABLE public.vr_child (
  id       int PRIMARY KEY,
  ref_id   int REFERENCES public.vr_parent(id),
  other_id int REFERENCES public.vr_other(id),
  note     text
);
CREATE INDEX ON public.vr_child (ref_id);
CREATE INDEX ON public.vr_child (other_id);

-- the staff_directory shape: the profile table's PK is an FK to users, and the view joins on it
CREATE TABLE public.vr_users (id int PRIMARY KEY);
CREATE TABLE public.vr_member (id int PRIMARY KEY, user_id int REFERENCES public.vr_users(id));
CREATE TABLE public.vr_profile (id int PRIMARY KEY REFERENCES public.vr_users(id), display_name text);
CREATE INDEX ON public.vr_member (user_id);

-- composite FK
CREATE TABLE public.vr_comp_parent (a int, b int, PRIMARY KEY (a, b));
CREATE TABLE public.vr_comp_child (
  id int PRIMARY KEY, a int, b int,
  FOREIGN KEY (a, b) REFERENCES public.vr_comp_parent (a, b)
);

-- one column in two FKs: the alphabetically first constraint name wins
CREATE TABLE public.vr_dup (
  x int,
  CONSTRAINT zz_vr_dup_fk FOREIGN KEY (x) REFERENCES public.vr_parent(id),
  CONSTRAINT aa_vr_dup_fk FOREIGN KEY (x) REFERENCES public.vr_other(id)
);

-- ---------------------------------------------------------------------------
-- Fixture views
-- ---------------------------------------------------------------------------
-- plain column, aliased column, the same column twice, SELECT *
CREATE VIEW public.vr_plain AS SELECT c.id, c.ref_id FROM public.vr_child c;
CREATE VIEW public.vr_alias AS SELECT c.id, c.ref_id AS ref FROM public.vr_child c;
CREATE VIEW public.vr_twice AS SELECT c.ref_id, c.ref_id AS ref_again FROM public.vr_child c;
CREATE VIEW public.vr_star  AS SELECT * FROM public.vr_child;

-- JOIN-condition-only column whose base name equals an output column's name (the bug)
CREATE VIEW public.vr_join_only AS
  SELECT m.id, p.display_name
  FROM public.vr_member m JOIN public.vr_profile p ON p.id = m.user_id;
-- the same shape, but the view also outputs the FK column itself
CREATE VIEW public.vr_join_and_out AS
  SELECT m.id, m.user_id, p.display_name
  FROM public.vr_member m JOIN public.vr_profile p ON p.id = m.user_id;

-- output column named like an FK base column but fed from another table; the real FK column is aliased
CREATE VIEW public.vr_name_swap AS
  SELECT p.id AS ref_id, c.ref_id AS parent_ref
  FROM public.vr_child c JOIN public.vr_parent p ON p.id = c.ref_id;

-- expressions
CREATE VIEW public.vr_expr AS
  SELECT c.id,
         c.ref_id + 0               AS plus_zero,
         COALESCE(c.ref_id, 0)      AS coalesced,
         c.ref_id::bigint           AS widened,
         (c.ref_id)::int            AS same_type_cast
  FROM public.vr_child c;

-- subquery in FROM and CTE: the parser tracks the origin through both
CREATE VIEW public.vr_subquery AS
  SELECT s.ref_id, s.id FROM (SELECT id, ref_id FROM public.vr_child) s;
CREATE VIEW public.vr_cte AS
  WITH s AS (SELECT id, ref_id FROM public.vr_child) SELECT s.ref_id, s.id FROM s;

-- nested target lists whose names collide with the outer one must never be read as the outer list
CREATE VIEW public.vr_sublink_tlist AS
  SELECT c.id, (SELECT max(x.ref_id) FROM public.vr_child x) AS ref_id
  FROM public.vr_child c;
CREATE VIEW public.vr_sublink_where AS
  SELECT p.id AS ref_id FROM public.vr_parent p
  WHERE p.id IN (SELECT x.ref_id FROM public.vr_child x);
CREATE VIEW public.vr_cte_collide AS
  WITH s AS (SELECT c.ref_id AS id FROM public.vr_child c)
  SELECT p.id AS ref_id, p.name AS id FROM public.vr_parent p JOIN s ON s.id = p.id;

-- UNION: the top-level target list points at the set operation, not at a table
CREATE VIEW public.vr_union AS
  SELECT ref_id FROM public.vr_child UNION ALL SELECT ref_id FROM public.vr_child;

-- ORDER BY a column that is not selected adds a junk target entry
CREATE VIEW public.vr_order_junk AS
  SELECT c.id FROM public.vr_child c ORDER BY c.ref_id;

-- view over view: origin is the inner view, which has no FK constraint
CREATE VIEW public.vr_view_on_view AS SELECT ref_id FROM public.vr_plain;

-- column names with characters that the node-tree text escapes
CREATE VIEW public.vr_odd_names AS
  SELECT c.ref_id AS "ref id", c.other_id AS "a,b", c.ref_id AS "x{y}", c.other_id AS "p(q)",
         c.ref_id AS ":resno", c.other_id AS "back\slash"
  FROM public.vr_child c;

-- composite FK and duplicate-FK columns
CREATE VIEW public.vr_comp AS SELECT a, b FROM public.vr_comp_child;
CREATE VIEW public.vr_comp_half AS SELECT a FROM public.vr_comp_child;
CREATE VIEW public.vr_dup_view AS SELECT x FROM public.vr_dup;

-- ---------------------------------------------------------------------------
-- Helper: the function's rows for one view as 'col->schema.table.col' pairs, sorted
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.rels(p_view text) RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(view_column || '->' || join_schema || '.' || join_table || '.' || join_column,
                             ', ' ORDER BY view_column), '')
  FROM public.schema_view_relations_func() WHERE view_name = p_view
$$;

DO $$
BEGIN
  -- plain / alias / twice / star -------------------------------------------------------------
  ASSERT pg_temp.rels('vr_plain') = 'ref_id->public.vr_parent.id',
    'plain column must carry its FK: ' || pg_temp.rels('vr_plain');
  ASSERT pg_temp.rels('vr_alias') = 'ref->public.vr_parent.id',
    'aliased column must carry the FK under the view''s name: ' || pg_temp.rels('vr_alias');
  ASSERT pg_temp.rels('vr_twice') = 'ref_again->public.vr_parent.id, ref_id->public.vr_parent.id',
    'a column selected twice must carry the FK on both: ' || pg_temp.rels('vr_twice');
  ASSERT pg_temp.rels('vr_star') = 'other_id->public.vr_other.id, ref_id->public.vr_parent.id',
    'SELECT * must carry the FKs: ' || pg_temp.rels('vr_star');

  -- the bug: JOIN-condition-only columns --------------------------------------------------------
  ASSERT pg_temp.rels('vr_join_only') = '',
    'a column used only in a JOIN condition must not gain an FK on a same-named output column: ' || pg_temp.rels('vr_join_only');
  ASSERT pg_temp.rels('vr_join_and_out') = 'user_id->public.vr_users.id',
    'only the output FK column carries the FK when the view also joins on it: ' || pg_temp.rels('vr_join_and_out');
  ASSERT pg_temp.rels('vr_name_swap') = 'parent_ref->public.vr_parent.id',
    'an output column that merely shares a base FK column''s name gets nothing; the alias gets the FK: ' || pg_temp.rels('vr_name_swap');

  -- expressions ----------------------------------------------------------------------------------
  -- a widening cast and arithmetic are function calls, so they have no origin; a same-type cast
  -- is dropped by the parser and stays a direct column reference
  ASSERT pg_temp.rels('vr_expr') = 'same_type_cast->public.vr_parent.id',
    'expression columns must not carry an FK (same-type cast is still a direct reference): ' || pg_temp.rels('vr_expr');

  -- subquery in FROM and CTE: documented behaviour, the origin is tracked through both ----------
  ASSERT pg_temp.rels('vr_subquery') = 'ref_id->public.vr_parent.id',
    'column read through a FROM subquery keeps the FK: ' || pg_temp.rels('vr_subquery');
  ASSERT pg_temp.rels('vr_cte') = 'ref_id->public.vr_parent.id',
    'column read through a CTE keeps the FK: ' || pg_temp.rels('vr_cte');

  -- nested target lists must never be read as the top-level one -------------------------------
  ASSERT pg_temp.rels('vr_sublink_tlist') = '',
    'a scalar subquery in the target list is an expression: ' || pg_temp.rels('vr_sublink_tlist');
  ASSERT pg_temp.rels('vr_sublink_where') = '',
    'a subquery in WHERE must not leak its target list: ' || pg_temp.rels('vr_sublink_where');
  ASSERT pg_temp.rels('vr_cte_collide') = '',
    'CTE target lists with colliding names must not leak: ' || pg_temp.rels('vr_cte_collide');

  -- documented limits ----------------------------------------------------------------------------
  ASSERT pg_temp.rels('vr_union') = '',
    'UNION views carry no inferred FK: ' || pg_temp.rels('vr_union');
  ASSERT pg_temp.rels('vr_view_on_view') = '',
    'view-over-view chains are not followed: ' || pg_temp.rels('vr_view_on_view');
  ASSERT pg_temp.rels('vr_order_junk') = '',
    'a junk ORDER BY entry must not appear or break parsing: ' || pg_temp.rels('vr_order_junk');

  -- escaped characters in column names ------------------------------------------------------
  ASSERT pg_temp.rels('vr_odd_names') =
    ':resno->public.vr_parent.id, a,b->public.vr_other.id, back\slash->public.vr_other.id, '
    'p(q)->public.vr_other.id, ref id->public.vr_parent.id, x{y}->public.vr_parent.id',
    'odd column names must still map: ' || pg_temp.rels('vr_odd_names');

  -- composite FK (column by column, as before) and duplicate FKs --------------------------------
  ASSERT pg_temp.rels('vr_comp') = 'a->public.vr_comp_parent.a, b->public.vr_comp_parent.b',
    'composite FK columns map one by one: ' || pg_temp.rels('vr_comp');
  ASSERT pg_temp.rels('vr_comp_half') = 'a->public.vr_comp_parent.a',
    'a single composite FK column still maps: ' || pg_temp.rels('vr_comp_half');
  ASSERT pg_temp.rels('vr_dup_view') = 'x->public.vr_other.id',
    'a column in two FKs resolves to the first constraint name (aa_vr_dup_fk): ' || pg_temp.rels('vr_dup_view');

  -- the function never reports a column the view does not have ---------------------------------
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.schema_view_relations_func() r
    WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = ('public.' || quote_ident(r.view_name))::regclass
                        AND a.attname = r.view_column AND a.attnum > 0 AND NOT a.attisdropped)
  ), 'every reported view_column must be an output column of its view';

  -- no duplicate (view, column) pairs ----------------------------------------------------------
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.schema_view_relations_func()
    GROUP BY view_name, view_column HAVING count(*) > 1
  ), 'at most one row per view column';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: schema_view_relations_func() infers view FKs from output columns only"
else
  echo "FAIL: schema_view_relations_func() reported an unexpected FK (see error above)"
  exit 1
fi
