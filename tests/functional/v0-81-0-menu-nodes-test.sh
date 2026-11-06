#!/bin/bash
# =============================================================================
# Functional Test: v0-81-0 menu nodes
# =============================================================================
# Exercises metadata.menu_nodes, its trigger rules, the schema_menu_nodes bridge view, save_menu_tree(),
# the menu cache version, and the hard move off metadata.entities.show_in_sidebar, the way PostgREST does
# (authenticator -> web_anon/authenticated, JWT in request.jwt.claims). Asserts:
#   D6   depth 4, heading under an entity, cycle via UPDATE (and a move that pushes a subtree past depth 3),
#        unregistered view, unknown target, duplicate entity node, bad heading key, kind change: each raises;
#        deleting a heading leaves its entities unplaced
#   D7   anon and authenticated read schema_menu_nodes (es labels translate); save_menu_tree is denied for
#        anon and non-admins and works for admin; direct writes to menu_nodes are denied to API roles
#   D8   (DB half) the menu version moves on save, single-row DELETE, DELETE of all rows and TRUNCATE, and the
#        entities cache version does not
#   D15  add_guided_form_step on a new table creates a hidden node (keeping an existing sort_order), and
#        upsert_entity_metadata works without the old parameter (the old overload is gone)
#   misc the show_in_sidebar column is gone from metadata.entities and schema_entities; save_menu_tree is
#        atomic on bad input
# D13 (deploy / revert / redeploy round trip) needs sqitch, so it only runs when SQITCH_CONTAINER names a
# postgres container with the migrations mounted at /civic-os-migrations (SQITCH_TARGET defaults to
# db:pg://postgres@localhost:5432/civic_os_db). It snapshots the entity order, reverts the change, checks the
# flat order, redeploys with --verify and compares the restored object definitions.
# Everything else runs in one transaction that is rolled back.
#
# Usage: ./tests/functional/v0-81-0-menu-nodes-test.sh
# Environment: DATABASE_URL (superuser, to create fixtures), optional SQITCH_CONTAINER / SQITCH_TARGET
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

# D13 state snapshot (see the D13 section at the end).
STATE_SQL="SELECT 'order ' || table_name || '|' || NOT show_in_sidebar FROM public.schema_entities ORDER BY sort_order, table_name;
SELECT 'view ' || c.relname || ' ' || md5(pg_get_viewdef(c.oid) || '|' || COALESCE(c.reloptions::TEXT, '') || '|'
       || COALESCE((SELECT string_agg(a::TEXT, ',' ORDER BY a::TEXT) FROM unnest(c.relacl) a), '') || '|'
       || COALESCE(obj_description(c.oid, 'pg_class'), ''))
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' ORDER BY c.relname;
SELECT 'function ' || p.oid::regprocedure::TEXT || ' ' || md5(pg_get_functiondef(p.oid) || '|'
       || COALESCE((SELECT string_agg(a::TEXT, ',' ORDER BY a::TEXT) FROM unnest(p.proacl) a), ''))
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('upsert_entity_metadata', 'add_guided_form_step', 'get_translation_defaults')
ORDER BY 1;"

if [ "${1:-}" = "--print-state" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At <<<"$STATE_SQL"
  exit 0
fi


if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'menu admin'),
  ('00000000-0000-0000-0000-0000000000f2', 'menu user');

-- Fixtures: four tables, a registered view, an unregistered view.
CREATE TABLE public.mt_a (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE public.mt_b (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE public.mt_c (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE public.mt_d (id SERIAL PRIMARY KEY, name TEXT);
CREATE VIEW public.mt_view_registered AS SELECT id, name FROM public.mt_a;
CREATE VIEW public.mt_view_unregistered AS SELECT id, name FROM public.mt_a;
INSERT INTO metadata.entities (table_name, display_name, sort_order) VALUES ('mt_view_registered', 'Registered view', 5);

-- The fixtures use their own keys, so the example's nodes do not affect the assertions (all rolled back).
DO $$
BEGIN
  -- The copy (a hidden node per hidden metadata.entities row) is checked by D13's redeploy: on a fresh
  -- stack the example init scripts run after the migration and write their own hidden nodes.
  -- the column is gone from the table and the view
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'entities' AND table_schema = 'metadata' AND column_name = 'show_in_sidebar'),
    'metadata.entities.show_in_sidebar should be dropped';
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'schema_entities' AND table_schema = 'public' AND column_name = 'show_in_sidebar'),
    'schema_entities should not expose show_in_sidebar';
END $$;

DELETE FROM metadata.menu_nodes;

-- ---------------------------------------------------------------------------
-- D6: DB rules
-- ---------------------------------------------------------------------------
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, sort_order) VALUES ('mt_h1', 'heading', 'Heading one', 10);
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key, sort_order) VALUES ('mt_h2', 'heading', 'Heading two', 'mt_h1', 10);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order) VALUES ('mt_a', 'entity', 'mt_a', 'mt_h2', 10);

DO $$
BEGIN
  -- depth 4: an entity under the depth-3 entity node
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key) VALUES ('mt_b', 'entity', 'mt_b', 'mt_a');
    ASSERT false, 'depth 4 insert must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- a heading under an entity
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name) VALUES ('mt_h3', 'heading', 'x');
    UPDATE metadata.menu_nodes SET parent_node_key = 'mt_a' WHERE node_key = 'mt_h3';
    ASSERT false, 'heading under an entity must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;
  DELETE FROM metadata.menu_nodes WHERE node_key = 'mt_h3';

  -- a cycle via UPDATE
  BEGIN
    UPDATE metadata.menu_nodes SET parent_node_key = 'mt_h2' WHERE node_key = 'mt_h1';
    ASSERT false, 'cycle via UPDATE must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE metadata.menu_nodes SET parent_node_key = 'mt_h1' WHERE node_key = 'mt_h1';
    ASSERT false, 'self parent must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- moving a subtree so that it would pass depth 3
  INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name) VALUES ('mt_h4', 'heading', 'Heading four');
  INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key) VALUES ('mt_h5', 'heading', 'Heading five', 'mt_h4');
  BEGIN
    UPDATE metadata.menu_nodes SET parent_node_key = 'mt_h2' WHERE node_key = 'mt_h4';
    ASSERT false, 'a move that pushes the subtree to depth 5 must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;
  DELETE FROM metadata.menu_nodes WHERE node_key = 'mt_h4';

  -- an unregistered view, a table that does not exist, an entity in another schema
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key) VALUES ('mt_view_unregistered', 'entity', 'mt_view_unregistered');
    ASSERT false, 'unregistered view must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key) VALUES ('mt_nope', 'entity', 'mt_nope');
    ASSERT false, 'unknown target must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- a registered view is fine
  INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key) VALUES ('mt_view_registered', 'entity', 'mt_view_registered');

  -- a duplicate entity node (second node key for the same target is rejected by the key rule and uniqueness)
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key) VALUES ('mt_a', 'entity', 'mt_a');
    ASSERT false, 'duplicate entity node must raise';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key) VALUES ('mt_a_again', 'entity', 'mt_a');
    ASSERT false, 'entity node whose key differs from its target must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- bad heading keys
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name) VALUES ('Bad Key', 'heading', 'x');
    ASSERT false, 'uppercase/space heading key must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name) VALUES ('1abc', 'heading', 'x');
    ASSERT false, 'heading key starting with a digit must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind) VALUES ('mt_nolabel', 'heading');
    ASSERT false, 'a heading needs a display_name';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- kind cannot change
  BEGIN
    UPDATE metadata.menu_nodes SET node_kind = 'entity' WHERE node_key = 'mt_h2';
    ASSERT false, 'kind change must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- unknown parent
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key) VALUES ('mt_orphan', 'heading', 'x', 'mt_missing');
    ASSERT false, 'unknown parent must raise';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;

  -- an entity under an entity at depth 2 is allowed; moving it under a heading is allowed
  INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key) VALUES ('mt_b', 'entity', 'mt_b', 'mt_view_registered');
  UPDATE metadata.menu_nodes SET parent_node_key = 'mt_h1' WHERE node_key = 'mt_b';

  -- deleting a heading removes its subtree; the entities become unplaced (no node), not hidden
  DELETE FROM metadata.menu_nodes WHERE node_key = 'mt_h1';
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.menu_nodes WHERE node_key IN ('mt_h1', 'mt_h2', 'mt_a', 'mt_b')),
    'deleting a heading removes its subtree';
  ASSERT EXISTS (SELECT 1 FROM public.schema_entities WHERE table_name = 'mt_a'),
    'an unplaced entity is still an entity';
END $$;

-- ---------------------------------------------------------------------------
-- D7: access (PostgREST role emulation)
-- ---------------------------------------------------------------------------
DELETE FROM metadata.menu_nodes;
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, sort_order) VALUES ('mt_h1', 'heading', 'Heading one', 10);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order) VALUES ('mt_a', 'entity', 'mt_a', 'mt_h1', 10);
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text)
VALUES ('menu_node', 'mt_h1.display_name', 'es', 'Encabezado uno');

-- anonymous
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE web_anon;
DO $$
DECLARE n INT;
BEGIN
  PERFORM set_config('request.headers', '{}', true);
  SELECT count(*) INTO n FROM public.schema_menu_nodes WHERE node_key IN ('mt_h1', 'mt_a');
  ASSERT n = 2, 'anon reads schema_menu_nodes, got ' || n;
  ASSERT (SELECT display_name FROM public.schema_menu_nodes WHERE node_key = 'mt_h1') = 'Heading one', 'English label by default';
  PERFORM set_config('request.headers', '{"accept-language":"es"}', true);
  ASSERT (SELECT display_name FROM public.schema_menu_nodes WHERE node_key = 'mt_h1') = 'Encabezado uno', 'es label translates';
  ASSERT (SELECT base_display_name FROM public.schema_menu_nodes WHERE node_key = 'mt_h1') = 'Heading one', 'base label stays untranslated under es';
  PERFORM set_config('request.headers', '{"accept-language":"fr"}', true);
  ASSERT (SELECT display_name FROM public.schema_menu_nodes WHERE node_key = 'mt_h1') = 'Heading one', 'missing translation falls back to English';
  PERFORM set_config('request.headers', '{}', true);

  BEGIN
    PERFORM public.save_menu_tree('[]'::jsonb);
    ASSERT false, 'anon save_menu_tree must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name) VALUES ('mt_x', 'heading', 'x');
    ASSERT false, 'anon direct insert must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- signed-in non-admin (also an editor and a manager)
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["user","editor","manager"]}', true);
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.schema_menu_nodes WHERE node_key IN ('mt_h1', 'mt_a')) = 2, 'user reads schema_menu_nodes';
  ASSERT (SELECT count(*) FROM metadata.menu_nodes WHERE node_key IN ('mt_h1', 'mt_a')) = 2, 'user reads the table through RLS';
  BEGIN
    PERFORM public.save_menu_tree('[]'::jsonb);
    ASSERT false, 'non-admin save_menu_tree must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE metadata.menu_nodes SET is_hidden = TRUE WHERE node_key = 'mt_a';
    ASSERT false, 'non-admin direct update must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  ASSERT (SELECT count(*) FROM metadata.menu_nodes WHERE node_key IN ('mt_h1', 'mt_a')) = 2, 'a denied save changed nothing';
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- admin: save_menu_tree replaces the whole tree in one transaction, parents first, whatever the input order
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated","roles":["admin"]}', true);
DO $$
DECLARE r JSONB;
BEGIN
  r := public.save_menu_tree('[
    {"node_key":"mt_b","node_kind":"entity","target_key":"mt_b","parent_node_key":"mt_h9","sort_order":20},
    {"node_key":"mt_c","node_kind":"entity","target_key":"mt_c","parent_node_key":"mt_b","is_hidden":true},
    {"node_key":"mt_h9","node_kind":"heading","display_name":"Nine","icon":"folder","collapsed_by_default":true,"sort_order":1}
  ]'::jsonb);
  ASSERT (r->>'nodes')::INT = 3, 'save reports three nodes, got ' || r::text;
  ASSERT r->>'menu_version' IS NOT NULL, 'save reports the menu version';
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.menu_nodes WHERE node_key IN ('mt_h1', 'mt_a')), 'save replaced the old tree';
  ASSERT (SELECT is_hidden FROM metadata.menu_nodes WHERE node_key = 'mt_c'), 'is_hidden saved';
  ASSERT (SELECT collapsed_by_default AND icon = 'folder' FROM metadata.menu_nodes WHERE node_key = 'mt_h9'), 'heading flags saved';
  ASSERT (SELECT parent_node_key FROM metadata.menu_nodes WHERE node_key = 'mt_c') = 'mt_b', 'nesting saved';

  -- atomic: bad input (depth 4, cycle, unknown parent, unknown target) leaves the tree untouched
  BEGIN
    PERFORM public.save_menu_tree('[
      {"node_key":"mt_h1","node_kind":"heading","display_name":"a"},
      {"node_key":"mt_h2","node_kind":"heading","display_name":"b","parent_node_key":"mt_h1"},
      {"node_key":"mt_h3","node_kind":"heading","display_name":"c","parent_node_key":"mt_h2"},
      {"node_key":"mt_h4","node_kind":"heading","display_name":"d","parent_node_key":"mt_h3"}]'::jsonb);
    ASSERT false, 'depth 4 save must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM public.save_menu_tree('[
      {"node_key":"mt_h1","node_kind":"heading","display_name":"a","parent_node_key":"mt_h2"},
      {"node_key":"mt_h2","node_kind":"heading","display_name":"b","parent_node_key":"mt_h1"}]'::jsonb);
    ASSERT false, 'cyclic save must raise';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    PERFORM public.save_menu_tree('[{"node_key":"mt_h1","node_kind":"heading","display_name":"a","parent_node_key":"nobody"}]'::jsonb);
    ASSERT false, 'unknown parent save must raise';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    PERFORM public.save_menu_tree('[{"node_key":"mt_view_unregistered","node_kind":"entity","target_key":"mt_view_unregistered"}]'::jsonb);
    ASSERT false, 'unregistered target save must raise';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM public.save_menu_tree('{"not":"an array"}'::jsonb);
    ASSERT false, 'non-array save must raise';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  ASSERT (SELECT count(*) FROM metadata.menu_nodes) = 3, 'failed saves left the tree untouched';
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- ---------------------------------------------------------------------------
-- D8 (DB half): the menu version moves on every kind of write, the entities version does not
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE vers (k TEXT PRIMARY KEY, menu TIMESTAMPTZ, entities TIMESTAMPTZ);
GRANT ALL ON vers TO PUBLIC;
CREATE FUNCTION pg_temp.snap(p_k TEXT) RETURNS VOID LANGUAGE sql AS $f$
  INSERT INTO vers SELECT p_k,
    (SELECT version FROM public.schema_cache_versions WHERE cache_name = 'menu'),
    (SELECT version FROM public.schema_cache_versions WHERE cache_name = 'entities')
  ON CONFLICT (k) DO UPDATE SET menu = EXCLUDED.menu, entities = EXCLUDED.entities
$f$;

SELECT pg_temp.snap('v0');
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name) VALUES ('mt_h7', 'heading', 'Seven');
SELECT pg_temp.snap('insert');
UPDATE metadata.menu_nodes SET icon = 'x' WHERE node_key = 'mt_h7';
SELECT pg_temp.snap('update');
DELETE FROM metadata.menu_nodes WHERE node_key = 'mt_h7';
SELECT pg_temp.snap('delete1');
DELETE FROM metadata.menu_nodes;
SELECT pg_temp.snap('delete_all');
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name) VALUES ('mt_h8', 'heading', 'Eight');
SELECT pg_temp.snap('v1');
TRUNCATE metadata.menu_nodes;
SELECT pg_temp.snap('truncate');
-- a DELETE that matches no rows still runs the statement trigger; that is harmless (a refetch), not required.

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.f, p.t, x.menu AS m0, y.menu AS m1, x.entities AS e0, y.entities AS e1
    FROM (VALUES ('v0','insert'), ('insert','update'), ('update','delete1'),
                 ('delete1','delete_all'), ('v1','truncate')) AS p(f, t)
    JOIN vers x ON x.k = p.f JOIN vers y ON y.k = p.t
  LOOP
    ASSERT r.m1 > r.m0, format('menu version must move from %s to %s', r.f, r.t);
    ASSERT r.e1 IS NOT DISTINCT FROM r.e0, format('entities version must not move from %s to %s', r.f, r.t);
  END LOOP;
  ASSERT (SELECT count(*) FROM metadata.menu_version) = 1, 'menu_version stays a single row';
END $$;

-- ---------------------------------------------------------------------------
-- D15: guided forms and upsert_entity_metadata
-- ---------------------------------------------------------------------------
CREATE TABLE public.mt_gf_parent (id BIGSERIAL PRIMARY KEY, name TEXT, created_by UUID DEFAULT current_user_id());
CREATE TABLE public.mt_gf_step (id BIGSERIAL PRIMARY KEY, parent_id BIGINT REFERENCES public.mt_gf_parent(id), note TEXT);
CREATE TABLE public.mt_gf_step2 (id BIGSERIAL PRIMARY KEY, parent_id BIGINT REFERENCES public.mt_gf_parent(id), note TEXT);

SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated","roles":["admin"]}', true);
DO $$
DECLARE r JSONB;
BEGIN
  r := public.register_guided_form('mt_gf', 'mt_gf_parent');
  ASSERT (r->>'success')::boolean, 'register_guided_form: ' || r::text;

  -- an existing visible node keeps its sort_order and parent when a step hides it
  PERFORM public.save_menu_tree('[
    {"node_key":"mt_h1","node_kind":"heading","display_name":"Group","sort_order":1},
    {"node_key":"mt_gf_step2","node_kind":"entity","target_key":"mt_gf_step2","parent_node_key":"mt_h1","sort_order":42}]'::jsonb);

  r := public.add_guided_form_step('mt_gf', 'step_one', 'Step one', 1, 'mt_gf_step', 'parent_id');
  ASSERT (r->>'success')::boolean, 'add_guided_form_step (new table): ' || r::text;
  ASSERT (SELECT is_hidden AND parent_node_key IS NULL FROM metadata.menu_nodes WHERE node_key = 'mt_gf_step' AND node_kind = 'entity'),
    'a new step table gets a hidden root node';

  r := public.add_guided_form_step('mt_gf', 'step_two', 'Step two', 2, 'mt_gf_step2', 'parent_id');
  ASSERT (r->>'success')::boolean, 'add_guided_form_step (existing node): ' || r::text;
  ASSERT (SELECT is_hidden AND sort_order = 42 AND parent_node_key = 'mt_h1' FROM metadata.menu_nodes WHERE node_key = 'mt_gf_step2'),
    'an existing node is hidden in place, keeping sort_order and parent';

  -- upsert_entity_metadata without p_show_in_sidebar; the 17-argument overload is gone
  PERFORM public.upsert_entity_metadata('mt_c', 'Menu C', 'desc', 33);
  ASSERT (SELECT display_name = 'Menu C' AND sort_order = 33 FROM metadata.entities WHERE table_name = 'mt_c'), 'upsert_entity_metadata writes';
  BEGIN
    EXECUTE $q$SELECT public.upsert_entity_metadata('mt_c', 'x', 'y', 1, p_show_in_sidebar => false)$q$;
    ASSERT false, 'p_show_in_sidebar must no longer exist';
  EXCEPTION WHEN undefined_function THEN NULL; END;
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'upsert_entity_metadata') = 1, 'exactly one upsert_entity_metadata overload';
  ASSERT NOT has_function_privilege('web_anon', 'public.upsert_entity_metadata(name,text,text,integer,text[],boolean,text,boolean,text,text,boolean,boolean,text,text,name,name)', 'EXECUTE'),
    'upsert_entity_metadata is not executable by anon';
  ASSERT NOT has_function_privilege('web_anon', 'public.save_menu_tree(jsonb)', 'EXECUTE'), 'save_menu_tree is not executable by anon';
  ASSERT has_function_privilege('authenticated', 'public.save_menu_tree(jsonb)', 'EXECUTE'), 'save_menu_tree is executable by authenticated';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: menu node rules, access, versioning and guided-form / upsert changes behave as designed"
else
  echo "FAIL: menu nodes are incomplete (see error above)"
  exit 1
fi

# -----------------------------------------------------------------------------
# D13: deploy / revert / redeploy round trip (optional; needs sqitch)
# -----------------------------------------------------------------------------
# Leaves the database deployed, but with a metadata.entities row for every eligible entity and renumbered
# sort_order values, so run it last on a disposable stack.
#
# STATE_SQL (defined at the top) prints the entity order with the hidden flag (schema_entities order, values ignored), then a
# hash of every public view (definition, options, grants, comment) and of every function this change
# replaces. Run "$0 --print-state" against a v0.80.3 stack of the same example to get a baseline, and pass
# it as D13_BASE_STATE to compare the reverted database with it.
if [ -z "${SQITCH_CONTAINER:-}" ]; then
  echo "SKIP: D13 round trip (set SQITCH_CONTAINER to a postgres container with the migrations mounted)"
  exit 0
fi

SQITCH_TARGET="${SQITCH_TARGET:-db:pg://postgres@localhost:5432/civic_os_db}"
Q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At "$@"; }
SQ() { docker exec -w /civic-os-migrations "$SQITCH_CONTAINER" sqitch "$@" "$SQITCH_TARGET"; }
fail() { echo "FAIL: D13 $1"; [ -n "${2:-}" ] && diff <(printf '%s\n' "$2") <(printf '%s\n' "$3") || true; exit 1; }

# 1. Revert: the flat state the menu reverts to. Compared with a v0.80.3 baseline when one is given.
SQ revert -y --to @HEAD^ >/dev/null
P1="$(Q <<<"$STATE_SQL")"
if [ -n "${D13_BASE_STATE:-}" ]; then
  BASE="$(cat "$D13_BASE_STATE")"
  [ "$BASE" = "$P1" ] || fail "reverted state differs from the v0.80.3 baseline (order, hidden set or definitions)" "$BASE" "$P1"
fi

# 2. Deploy and revert again: the round trip is stable.
SQ deploy --verify >/dev/null
SQ revert -y --to @HEAD^ >/dev/null
P2="$(Q <<<"$STATE_SQL")"
[ "$P1" = "$P2" ] || fail "second round trip changed the order, hidden set or definitions" "$P1" "$P2"

# 3. Nested tree: a hidden heading first at the root, holding the last two entities, one nested under the
#    other. The flat order becomes a, b, then the rest; a and b become hidden.
SQ deploy --verify >/dev/null
ORDER="$(printf '%s\n' "$P1" | sed -n 's/^order //p')"
[ "$(printf '%s\n' "$ORDER" | grep -c .)" -ge 3 ] || fail "needs at least three entities"
A="$(printf '%s\n' "$ORDER" | tail -1 | cut -d'|' -f1)"
B="$(printf '%s\n' "$ORDER" | tail -2 | head -1 | cut -d'|' -f1)"
Q -q <<SQL
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, sort_order, is_hidden)
VALUES ('d13_group', 'heading', 'D13 group', -1000000, TRUE);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES ('$A', 'entity', '$A', 'd13_group', 1)
ON CONFLICT (node_key) DO UPDATE SET parent_node_key = 'd13_group', sort_order = 1;
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES ('$B', 'entity', '$B', '$A', 1)
ON CONFLICT (node_key) DO UPDATE SET parent_node_key = '$A', sort_order = 1;
SQL
EXPECTED="$(printf '%s|true\n%s|true\n' "$A" "$B"; printf '%s\n' "$ORDER" | grep -v -e "^$A|" -e "^$B|")"
SQ revert -y --to @HEAD^ >/dev/null
NESTED="$(Q <<<"$STATE_SQL" | sed -n 's/^order //p')"
[ "$EXPECTED" = "$NESTED" ] || fail "nested tree did not flatten to its depth-first order and hidden set" "$EXPECTED" "$NESTED"

# 4. Redeploy: --verify passes and the copy makes one hidden root node per hidden eligible entity, none for
#    visible ones (they follow the root nodes in their sort_order, as on a fresh install).
HIDDEN="$(Q -c "SELECT string_agg(e.table_name, ',' ORDER BY e.table_name COLLATE \"C\") FROM metadata.entities e WHERE NOT e.show_in_sidebar AND EXISTS (SELECT 1 FROM public.schema_entities s WHERE s.table_name = e.table_name)")"
SQ deploy --verify >/dev/null
NODES="$(Q -c "SELECT string_agg(node_key, ',' ORDER BY node_key COLLATE \"C\") FROM metadata.menu_nodes WHERE node_kind = 'entity' AND is_hidden AND parent_node_key IS NULL")"
ALL="$(Q -c "SELECT count(*) FROM metadata.menu_nodes")"
[ "$NODES" = "$HIDDEN" ] || fail "redeploy did not copy exactly the hidden entities" "$HIDDEN" "$NODES"
[ "$ALL" = "$(printf '%s' "$HIDDEN" | awk -F, 'NF{print NF} !NF{print 0}')" ] || fail "redeploy made $ALL nodes, expected only the hidden entities"
echo "PASS: D13 revert flattens the menu (order, hidden set, definitions); nested tree flattens depth first; redeploy --verify passes"
