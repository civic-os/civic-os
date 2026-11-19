#!/bin/bash
# =============================================================================
# Functional Test: v0-83-0 dashboards in the menu
# =============================================================================
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Exercises dashboard nodes and heading links in metadata.menu_nodes the way PostgREST does
# (authenticator -> web_anon/authenticated, JWT in request.jwt.claims). Asserts:
#   rules     the table CHECKs and the trigger: a dashboard node's key is dashboard:<id>, it has a dashboard
#             and no target; an entity node has no dashboard; one node per dashboard (dashboard node or heading
#             link); nothing sits under a dashboard node (insert and move); a dashboard node sits at the root,
#             under a heading or under an entity node; the kind cannot change; the dashboard must exist
#   rows      per caller (anonymous, user, a role with a show row, the dashboard's creator, admin, a non-admin
#             menu editor, a translator): a dashboard node shows only to callers who can see the dashboard; a
#             heading links (dashboard_display_name set) only for them, stays unlinked for the others when it
#             has entries, and is dropped when its link was all it had; a hidden dashboard node leaves no stub;
#             full readers read every node, with a NULL title where they cannot see the dashboard
#   version   the menu cache version moves when a dashboard in the menu changes title, is_public or created_by,
#             or gains or loses a dashboard_roles row (directly, through set_dashboard_roles() and through
#             dashboard_role_defaults), and not for other columns or dashboards outside the menu
#   delete    deleting a dashboard deletes its dashboard node and clears a heading's link (its subtree stays),
#             moving the version; deleting one outside the menu does not; a stale draft holding the deleted
#             node gets PT409 with its version and a foreign key error without
#   save      save_menu_tree() round-trips dashboard nodes and links; a menu editor saves back a node for a
#             dashboard they cannot see
#   buildMenu @civic-os/core's buildMenu over each non-full caller's rows equals buildMenu over the full rows
#             with that caller's dashboard visibility applied, and its rendered tree equals the server's rows
#             (needs packages/core/dist: npm run build:packages)
# Everything runs in one transaction that is rolled back.
#
# Usage: ./tests/functional/v0-83-0-menu-dashboard-nodes-test.sh
# Environment: DATABASE_URL (superuser)
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CORE="$ROOT/packages/core/dist/index.js"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

if [ ! -f "$CORE" ]; then
  echo "FAIL: $CORE is missing; run npm run build:packages first"
  exit 1
fi

# One caller's view: its entities, its schema_menu_nodes rows and the ids of the dashboards it can see.
# Prints "JSON<TAB><label><TAB><json>"; only those lines reach the buildMenu check.
EXPORT_SQL="SELECT 'JSON', :'label', json_build_object(
  'entities', (SELECT COALESCE(json_agg(json_build_object('table_name', se.table_name, 'display_name', se.display_name,
                                                          'sort_order', se.sort_order)), '[]') FROM public.schema_entities se),
  'rows', (SELECT COALESCE(json_agg(row_to_json(m)), '[]') FROM public.schema_menu_nodes m),
  'dashboards', (SELECT COALESCE(json_agg(d.id), '[]') FROM metadata.dashboards d));"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -At -F $'\t' -v export_sql="$EXPORT_SQL" > "$OUT/fixture.out" <<'SQL'
BEGIN;

INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'md admin'),
  ('00000000-0000-0000-0000-0000000000d2', 'md user'),
  ('00000000-0000-0000-0000-0000000000d3', 'md menu editor'),
  ('00000000-0000-0000-0000-0000000000d5', 'md creator')
ON CONFLICT DO NOTHING;

INSERT INTO metadata.roles (role_key, display_name) VALUES
  ('md_viewer', 'Dashboard viewer'), ('md_menu_editor', 'Menu editor'), ('md_translator', 'Translator');
INSERT INTO metadata.permission_roles (role_id, permission_id)
SELECT r.id, p.id FROM metadata.roles r CROSS JOIN metadata.permissions p
WHERE (r.role_key = 'md_menu_editor' AND p.table_name = 'metadata.menu_nodes' AND p.permission = 'update')
   OR (r.role_key = 'md_translator' AND p.table_name = 'metadata.translations' AND p.permission = 'update');

CREATE TABLE public.md_pub (id INT PRIMARY KEY);
CREATE TABLE public.md_pub2 (id INT PRIMARY KEY);
GRANT SELECT ON public.md_pub, public.md_pub2 TO web_anon, authenticated;

-- Dashboards: three public, one for the md_viewer role, one owned by the creator, two private
INSERT INTO metadata.dashboards (display_name, is_public, created_by) VALUES
  ('MD Pub', TRUE, NULL), ('MD Pub2', TRUE, NULL), ('MD Pub3', TRUE, NULL),
  ('MD Role', FALSE, NULL), ('MD Own', FALSE, '00000000-0000-0000-0000-0000000000d5'),
  ('MD Priv', FALSE, NULL), ('MD Priv2', FALSE, NULL), ('MD Unplaced', TRUE, NULL);
INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode)
SELECT d.id, r.id, 'show' FROM metadata.dashboards d, metadata.roles r
WHERE d.display_name = 'MD Role' AND r.role_key = 'md_viewer';

-- Short names for keys and ids, readable by every test role (the dashboards table is not)
CREATE TABLE public.md_names (id INT PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO public.md_names SELECT id, replace(lower(display_name), 'md ', '') FROM metadata.dashboards WHERE display_name LIKE 'MD %';
GRANT SELECT ON public.md_names TO web_anon, authenticated;
CREATE FUNCTION public.md_id(p_name TEXT) RETURNS INT LANGUAGE sql STABLE AS $$ SELECT id FROM public.md_names WHERE name = p_name $$;
CREATE FUNCTION public.md_key(p_name TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT 'dashboard:' || public.md_id(p_name) $$;
GRANT EXECUTE ON FUNCTION public.md_id(TEXT), public.md_key(TEXT) TO web_anon, authenticated;

-- The tree (the example's nodes are removed; all rolled back):
--   h_mod (heading "Module", opens Role)     h_only (heading "Only", opens Own, no entries)
--     md_pub (entity)                        h_dead (heading "Dead", opens Priv2, no entries)
--       dashboard:pub2                       h_hidden (heading, hidden)
--     dashboard:pub                            dashboard:pub3
--     dashboard:priv "Private board"
DELETE FROM metadata.menu_nodes;
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, sort_order, dashboard_id)
VALUES ('h_mod', 'heading', 'Module', 10, public.md_id('role'));
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES ('md_pub', 'entity', 'md_pub', 'h_mod', 10);
INSERT INTO metadata.menu_nodes (node_key, node_kind, dashboard_id, parent_node_key, sort_order)
VALUES (public.md_key('pub2'), 'dashboard', public.md_id('pub2'), 'md_pub', 10),
       (public.md_key('pub'), 'dashboard', public.md_id('pub'), 'h_mod', 20);
INSERT INTO metadata.menu_nodes (node_key, node_kind, dashboard_id, display_name, parent_node_key, sort_order)
VALUES (public.md_key('priv'), 'dashboard', public.md_id('priv'), 'Private board', 'h_mod', 30);
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, sort_order, dashboard_id) VALUES
  ('h_only', 'heading', 'Only', 20, public.md_id('own')),
  ('h_dead', 'heading', 'Dead', 30, public.md_id('priv2'));
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, sort_order, is_hidden) VALUES ('h_hidden', 'heading', 'Hidden', 40, TRUE);
INSERT INTO metadata.menu_nodes (node_key, node_kind, dashboard_id, parent_node_key, sort_order)
VALUES (public.md_key('pub3'), 'dashboard', public.md_id('pub3'), 'h_hidden', 10);

-- A caller's rows: key:parent:title, dashboard keys by short name, in code point order. title is the
-- dashboard_display_name the caller gets ("-" when none).
CREATE FUNCTION public.md_shape() RETURNS TEXT LANGUAGE sql AS $$
  SELECT string_agg(k.key || ':' || COALESCE(k.parent, '-') || ':' || COALESCE(m.dashboard_display_name, '-'), ' ' ORDER BY k.key COLLATE "C")
  FROM public.schema_menu_nodes m
  CROSS JOIN LATERAL (
    SELECT COALESCE((SELECT 'd_' || n.name FROM public.md_names n WHERE 'dashboard:' || n.id = m.node_key), m.node_key) AS key,
           COALESCE((SELECT 'd_' || n.name FROM public.md_names n WHERE 'dashboard:' || n.id = m.parent_node_key), m.parent_node_key) AS parent
  ) k $$;
GRANT EXECUTE ON FUNCTION public.md_shape() TO web_anon, authenticated;

-- The SQLSTATE a statement raises, or 'ok'
CREATE FUNCTION public.md_raises(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;

CREATE FUNCTION public.md_version() RETURNS TIMESTAMPTZ LANGUAGE sql AS $$ SELECT changed_at FROM metadata.menu_version $$;
GRANT EXECUTE ON FUNCTION public.md_version() TO authenticated;

-- ---------------------------------------------------------------------------
-- rules (superuser; each failing statement runs in its own subtransaction)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_ins CONSTANT TEXT := 'INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, dashboard_id, parent_node_key) VALUES ';
BEGIN
  ASSERT public.md_raises(v_ins || format('(%L, ''dashboard'', NULL, %s, NULL)', 'dash_x', public.md_id('unplaced'))) = '23514',
    'a dashboard node key other than dashboard:<id> is rejected';
  ASSERT public.md_raises(v_ins || format('(%L, ''dashboard'', ''md_pub2'', %s, NULL)', public.md_key('unplaced'), public.md_id('unplaced'))) = '23514',
    'a dashboard node with a target is rejected';
  ASSERT public.md_raises(v_ins || '(''dashboard:0'', ''dashboard'', NULL, NULL, NULL)') = '23514',
    'a dashboard node without a dashboard is rejected';
  ASSERT public.md_raises(v_ins || format('(''md_pub2'', ''entity'', ''md_pub2'', %s, NULL)', public.md_id('unplaced'))) = '23514',
    'an entity node with a dashboard is rejected';
  ASSERT public.md_raises(v_ins || '(''pg'', ''page'', NULL, NULL, NULL)') = '23514', 'an unknown kind is rejected';
  ASSERT public.md_raises(v_ins || format('(%L, ''dashboard'', NULL, %s, NULL)', public.md_key('role'), public.md_id('role'))) = '23505',
    'a dashboard a heading links to cannot also get a dashboard node';
  ASSERT public.md_raises(format('INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, dashboard_id) VALUES (''h_dup'', ''heading'', ''Dup'', %s)',
    public.md_id('pub'))) = '23505', 'a dashboard with a node cannot also be a heading link';
  ASSERT public.md_raises(v_ins || '(''dashboard:999999'', ''dashboard'', NULL, 999999, NULL)') = '23503',
    'the dashboard must exist';
  ASSERT public.md_raises(v_ins || format('(''md_pub2'', ''entity'', ''md_pub2'', NULL, %L)', public.md_key('pub'))) = '23514',
    'an entity node cannot sit under a dashboard node';
  ASSERT public.md_raises(format('INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key) VALUES (''h_under'', ''heading'', ''Under'', %L)',
    public.md_key('pub'))) = '23514', 'a heading cannot sit under a dashboard node';
  ASSERT public.md_raises(v_ins || format('(%L, ''dashboard'', NULL, %s, %L)', public.md_key('unplaced'), public.md_id('unplaced'), public.md_key('pub'))) = '23514',
    'a dashboard node cannot sit under a dashboard node';
  ASSERT public.md_raises(format('UPDATE metadata.menu_nodes SET parent_node_key = %L WHERE node_key = ''md_pub''', public.md_key('pub'))) = '23514',
    'moving a node under a dashboard node is rejected';
  ASSERT public.md_raises(format('UPDATE metadata.menu_nodes SET node_kind = ''entity'', target_key = ''md_pub2'', dashboard_id = NULL WHERE node_key = %L',
    public.md_key('pub'))) = '23514', 'a dashboard node cannot change kind';
  ASSERT public.md_raises(v_ins || format('(%L, ''dashboard'', NULL, %s, ''h_only'')', public.md_key('unplaced'), public.md_id('unplaced'))) = 'ok',
    'a dashboard node sits under a heading (the fixture holds one under an entity node and none at the root yet)';
  ASSERT public.md_raises(format('UPDATE metadata.menu_nodes SET parent_node_key = NULL WHERE node_key = %L', public.md_key('unplaced'))) = 'ok',
    'a dashboard node sits at the root';
  DELETE FROM metadata.menu_nodes WHERE node_key = public.md_key('unplaced');
END $$;

-- ---------------------------------------------------------------------------
-- rows: per caller
-- ---------------------------------------------------------------------------
-- anonymous: sees Pub and Pub2 only; Module stays (it has an entity) but is not linked; Only and Dead are dropped
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE web_anon;
DO $$
DECLARE v TEXT;
BEGIN
  PERFORM set_config('request.headers', '{}', true);
  v := public.md_shape();
  ASSERT v = 'd_pub:h_mod:MD Pub d_pub2:md_pub:MD Pub2 h_mod:-:- md_pub:h_mod:-', 'anon rows, got ' || COALESCE(v, '<none>');
  ASSERT (SELECT dashboard_id FROM public.schema_menu_nodes WHERE node_key = 'h_mod') = public.md_id('role'),
    'the heading row keeps its dashboard id; only the title is withheld';
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.menu_nodes WHERE display_name = 'Private board'), 'anon never reads an unseen dashboard node';
END $$;
\set label fixture:anon
:export_sql
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- plain user: the same dashboards as anonymous
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated","roles":["user"]}', true) IS NULL;
DO $$
DECLARE v TEXT;
BEGIN
  v := public.md_shape();
  ASSERT v = 'd_pub:h_mod:MD Pub d_pub2:md_pub:MD Pub2 h_mod:-:- md_pub:h_mod:-', 'user rows, got ' || COALESCE(v, '<none>');
END $$;
\set label fixture:user
:export_sql

-- a role with a show row on Role: the Module heading links
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated","roles":["user","md_viewer"]}', true) IS NULL;
DO $$
DECLARE v TEXT;
BEGIN
  v := public.md_shape();
  ASSERT v = 'd_pub:h_mod:MD Pub d_pub2:md_pub:MD Pub2 h_mod:-:MD Role md_pub:h_mod:-', 'viewer rows, got ' || COALESCE(v, '<none>');
END $$;
\set label fixture:viewer
:export_sql

-- the creator of Own: the Only heading is kept by its link alone
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d5","role":"authenticated","roles":["user"]}', true) IS NULL;
DO $$
DECLARE v TEXT;
BEGIN
  v := public.md_shape();
  ASSERT v = 'd_pub:h_mod:MD Pub d_pub2:md_pub:MD Pub2 h_mod:-:- h_only:-:MD Own md_pub:h_mod:-', 'creator rows, got ' || COALESCE(v, '<none>');
END $$;
\set label fixture:creator
:export_sql

-- a creator without any readable entity: Module is dropped, Only stays
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d5","role":"authenticated","roles":["user"]}', true) IS NULL;
RESET ROLE;
RESET SESSION AUTHORIZATION;
REVOKE SELECT ON public.md_pub FROM authenticated;
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
DECLARE v TEXT;
BEGIN
  v := public.md_shape();
  ASSERT v = 'd_pub:h_mod:MD Pub d_pub2:h_mod:MD Pub2 h_mod:-:- h_only:-:MD Own',
    'creator rows without md_pub: Pub2 is lifted to Module, which its dashboard nodes keep, got ' || COALESCE(v, '<none>');
END $$;
\set label fixture:creator_no_entity
:export_sql
RESET ROLE;
RESET SESSION AUTHORIZATION;
GRANT SELECT ON public.md_pub TO authenticated;

-- full readers: admin sees every title; a menu editor and a translator see every node, NULL where they cannot see
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated","roles":["admin"]}', true) IS NULL;
DO $$
DECLARE v TEXT;
BEGIN
  v := public.md_shape();
  ASSERT v = 'd_priv:h_mod:MD Priv d_pub:h_mod:MD Pub d_pub2:md_pub:MD Pub2 d_pub3:h_hidden:MD Pub3 h_dead:-:MD Priv2 h_hidden:-:- '
             'h_mod:-:MD Role h_only:-:MD Own md_pub:h_mod:-', 'admin rows, got ' || COALESCE(v, '<none>');
END $$;
\set label fixture:full
:export_sql

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated","roles":["user","md_menu_editor"]}', true) IS NULL;
DO $$
DECLARE v TEXT;
BEGIN
  v := public.md_shape();
  ASSERT v = 'd_priv:h_mod:- d_pub:h_mod:MD Pub d_pub2:md_pub:MD Pub2 d_pub3:h_hidden:MD Pub3 h_dead:-:- h_hidden:-:- '
             'h_mod:-:- h_only:-:- md_pub:h_mod:-', 'menu editor rows, got ' || COALESCE(v, '<none>');
END $$;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated","roles":["user","md_translator"]}', true) IS NULL;
DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM public.schema_menu_nodes) = 9, 'a translator reads every node';
  ASSERT (SELECT dashboard_display_name FROM public.schema_menu_nodes WHERE node_key = public.md_key('priv')) IS NULL,
    'a translator gets no title for a dashboard they cannot see';
  ASSERT EXISTS (SELECT 1 FROM public.get_translation_defaults()
                 WHERE source_type = 'menu_node' AND source_key = public.md_key('priv') || '.display_name' AND default_text = 'Private board'),
    'a dashboard node label is listed with the menu labels';
END $$;

-- ---------------------------------------------------------------------------
-- save: a menu editor saves back a node for a dashboard they cannot see
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated","roles":["user","md_menu_editor"]}', true) IS NULL;
DO $$
DECLARE r JSONB;
BEGIN
  r := public.save_menu_tree((
    SELECT jsonb_agg(jsonb_build_object(
      'node_key', m.node_key, 'node_kind', m.node_kind, 'target_key', m.target_key, 'display_name', m.base_display_name,
      'icon', m.icon, 'parent_node_key', m.parent_node_key, 'sort_order', m.sort_order, 'is_hidden', m.is_hidden,
      'collapsed_by_default', m.collapsed_by_default, 'dashboard_id', m.dashboard_id, 'dashboard_display_name', m.dashboard_display_name))
    FROM public.schema_menu_nodes m), public.md_version());
  ASSERT (r->>'nodes')::INT = 9 AND r->'skipped' = '[]'::jsonb, 'the menu editor saves the tree back: ' || r::TEXT;
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;
DO $$
BEGIN
  ASSERT (SELECT dashboard_id FROM metadata.menu_nodes WHERE node_key = public.md_key('priv')) = public.md_id('priv')
     AND (SELECT display_name FROM metadata.menu_nodes WHERE node_key = public.md_key('priv')) = 'Private board'
     AND (SELECT dashboard_id FROM metadata.menu_nodes WHERE node_key = 'h_dead') = public.md_id('priv2')
     AND (SELECT parent_node_key FROM metadata.menu_nodes WHERE node_key = public.md_key('pub2')) = 'md_pub',
    'dashboard nodes and links survive the save unchanged';
END $$;

-- ---------------------------------------------------------------------------
-- version: changes of dashboards in the menu move it, other changes do not
-- ---------------------------------------------------------------------------
DO $$
DECLARE v TIMESTAMPTZ;
BEGIN
  v := public.md_version();
  UPDATE metadata.dashboards SET description = 'changed', sort_order = 99, show_in_selector = FALSE WHERE id = public.md_id('pub');
  ASSERT public.md_version() = v, 'description, sort_order and show_in_selector do not move the menu version';
  UPDATE metadata.dashboards SET display_name = 'MD Unplaced 2' WHERE id = public.md_id('unplaced');
  INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode)
  SELECT public.md_id('unplaced'), id, 'show' FROM metadata.roles WHERE role_key = 'md_viewer';
  ASSERT public.md_version() = v, 'changes of a dashboard outside the menu do not move the menu version';

  UPDATE metadata.dashboards SET display_name = 'MD Pub renamed' WHERE id = public.md_id('pub');
  ASSERT public.md_version() > v, 'a placed dashboard''s title moves the version';
  v := public.md_version();
  UPDATE metadata.dashboards SET is_public = TRUE WHERE id = public.md_id('role');
  ASSERT public.md_version() > v, 'a linked dashboard''s is_public moves the version';
  v := public.md_version();
  UPDATE metadata.dashboards SET created_by = '00000000-0000-0000-0000-0000000000d2' WHERE id = public.md_id('own');
  ASSERT public.md_version() > v, 'a linked dashboard''s created_by moves the version';
  v := public.md_version();
  INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode)
  SELECT public.md_id('priv'), id, 'show' FROM metadata.roles WHERE role_key = 'md_viewer';
  ASSERT public.md_version() > v, 'a show row on a placed dashboard moves the version';
  v := public.md_version();
  DELETE FROM metadata.dashboard_roles WHERE dashboard_id = public.md_id('priv');
  ASSERT public.md_version() > v, 'removing it moves the version';
  v := public.md_version();
  INSERT INTO metadata.dashboard_role_defaults (role_id, dashboard_id, priority)
  SELECT id, public.md_id('priv2'), 0 FROM metadata.roles WHERE role_key = 'md_viewer';
  ASSERT public.md_version() > v, 'a legacy default row on a linked dashboard moves the version (through the sync)';
END $$;

SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated","roles":["admin"]}', true) IS NULL;
DO $$
DECLARE v TIMESTAMPTZ;
BEGIN
  v := (SELECT version FROM public.schema_cache_versions WHERE cache_name = 'menu');
  PERFORM public.set_dashboard_roles(public.md_id('pub2'), ARRAY['md_viewer'], 'show');
  ASSERT (SELECT version FROM public.schema_cache_versions WHERE cache_name = 'menu') > v,
    'set_dashboard_roles() on a placed dashboard moves the menu row of schema_cache_versions';
END $$;

-- ---------------------------------------------------------------------------
-- delete (as an admin through the API roles, so the dashboards policies apply)
-- ---------------------------------------------------------------------------
DO $$
DECLARE v TIMESTAMPTZ; v_stale JSONB; v_old TIMESTAMPTZ; v_state TEXT;
BEGIN
  v := public.md_version();
  DELETE FROM metadata.dashboards WHERE id = public.md_id('unplaced');
  ASSERT public.md_version() = v, 'deleting a dashboard outside the menu does not move the version';

  v_old := public.md_version();
  v_stale := (SELECT jsonb_agg(to_jsonb(n) - 'created_at' - 'updated_at') FROM metadata.menu_nodes n);
  DELETE FROM metadata.dashboards WHERE id = public.md_id('pub3');
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.menu_nodes WHERE node_key = public.md_key('pub3')), 'the dashboard node goes with its dashboard';
  ASSERT EXISTS (SELECT 1 FROM metadata.menu_nodes WHERE node_key = 'h_hidden'), 'its parent stays';
  ASSERT public.md_version() > v_old, 'deleting a placed dashboard moves the version';

  v := public.md_version();
  DELETE FROM metadata.dashboards WHERE id = public.md_id('role');
  ASSERT (SELECT dashboard_id FROM metadata.menu_nodes WHERE node_key = 'h_mod') IS NULL, 'a linked heading loses its link';
  ASSERT (SELECT COUNT(*) FROM metadata.menu_nodes WHERE parent_node_key = 'h_mod') = 3, 'and keeps its entries';
  ASSERT public.md_version() > v, 'deleting a linked dashboard moves the version';

  BEGIN
    PERFORM public.save_menu_tree(v_stale, v_old);
    v_state := 'ok';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  ASSERT v_state = 'PT409', 'a draft loaded before the delete is stale, got ' || v_state;
  BEGIN
    PERFORM public.save_menu_tree(v_stale);
    v_state := 'ok';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  ASSERT v_state = '23503', 'without a version the deleted dashboard fails the foreign key, got ' || v_state;
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

ROLLBACK;
SQL
echo "PASS: rules, rows per caller (anon, user, viewer, creator, admin, menu editor, translator), save, version, delete"

# buildMenu over each non-full caller's rows equals buildMenu over the full rows with that caller's dashboard
# visibility applied (titles of dashboards the caller cannot see nulled), and the rendered tree (keys and
# parents, unplaced entities aside) equals the server's visible rows.
grep -h '^JSON' "$OUT/fixture.out" | node --input-type=module -e '
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
const { buildMenu } = await import(process.argv[1]);
const exports = new Map(readFileSync(0, "utf8").trim().split("\n").map(l => { const [, label, json] = l.split("\t"); return [label, JSON.parse(json)]; }));
const flatten = (entries, parent, out) => { for (const e of entries) { out.push(`${e.key}:${parent ?? "-"}`); flatten(e.children, e.key, out); } return out; };
let failed = 0, checked = 0;
for (const [label, { entities, rows, dashboards }] of exports) {
  const [group, caller] = label.split(":");
  if (caller === "full") continue;
  const seen = new Set(dashboards);
  const full = exports.get(`${group}:full`).rows.map(r => ({ ...r, dashboard_display_name: seen.has(r.dashboard_id) ? r.dashboard_display_name : null }));
  const mine = buildMenu(entities, rows);
  if (!isDeepStrictEqual(mine, buildMenu(entities, full))) { failed++; console.log(`FAIL: ${label}: buildMenu differs from the full rows`); }
  const keys = new Set(rows.map(r => r.node_key));
  const rendered = flatten(mine.filter(e => keys.has(e.key)), null, []).sort();
  const server = rows.filter(r => !r.is_hidden).map(r => `${r.node_key}:${r.parent_node_key ?? "-"}`).sort();
  if (!isDeepStrictEqual(rendered, server)) { failed++; console.log(`FAIL: ${label}: server rows ${server} != rendered ${rendered}`); }
  checked++;
}
if (checked < 5) { console.log(`FAIL: only ${checked} callers exported`); process.exit(1); }
if (failed) process.exit(1);
console.log(`PASS: buildMenu equality and server tree = rendered tree for ${checked} callers`);
' "$CORE"
