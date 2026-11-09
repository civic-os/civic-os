#!/bin/bash
# =============================================================================
# Functional Test: v0-81-2 menu access
# =============================================================================
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Exercises per-caller menu visibility, the menu permission, the stale-save check and the target
# eligibility helper, the way PostgREST does (authenticator -> web_anon/authenticated, JWT in
# request.jwt.claims). Asserts:
#   rows      web_anon and a plain user read only what buildMenu renders for them: hidden subtrees end, an
#             entity node whose table they cannot read is dropped and its children lifted, an empty heading
#             is dropped, and each hidden entity node whose table they can read comes back as a stub (key and
#             target only). The table itself never returns stubs. Admins, menu editors and translators read
#             every node with its stored parent and labels.
#   buildMenu @civic-os/core's buildMenu over each non-full reader's rows equals buildMenu over the full rows
#             with that reader's entities, and its rendered tree equals the server's rows; checked on the
#             fixture tree and on the example's own menu (needs packages/core/dist: npm run build:packages)
#   eligible  metadata.menu_target_eligible() equals superuser schema_entities for every relation in public
#   writes    users without the permission get 42501 from save_menu_tree and from a direct INSERT, and change
#             nothing with UPDATE or DELETE; the permission holder saves; an admin whose role lost the
#             permission still saves (is_admin() escape valve); a translator reads everything but cannot save
#   version   a stale p_expected_version raises PT409 with the stored version in the hint; the current
#             version and NULL save; the returned version equals schema_cache_versions' menu row
#   lock      two sessions: the second save waits for the first one's advisory lock, then gets PT409; a
#             NULL-version save then succeeds. Runs against the real tree and saves it back unchanged, so only
#             the menu version (and created_at / updated_at) moves.
# Everything except the lock section runs in transactions that are rolled back.
#
# Usage: ./tests/functional/v0-81-2-menu-access-test.sh
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

# JSON export of one caller's view: its entities and its schema_menu_nodes rows, as the app reads them.
# Prints "JSON<TAB><label><TAB><json>"; only those lines reach the buildMenu check.
EXPORT_SQL="SELECT 'JSON', :'label', json_build_object(
  'entities', (SELECT COALESCE(json_agg(json_build_object('table_name', se.table_name, 'display_name', se.display_name,
                                                          'sort_order', se.sort_order)), '[]') FROM public.schema_entities se),
  'rows', (SELECT COALESCE(json_agg(row_to_json(m)), '[]') FROM public.schema_menu_nodes m));"

# -----------------------------------------------------------------------------
# rows, eligible, writes, version (fixture tree, rolled back)
# -----------------------------------------------------------------------------
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -At -F $'\t' -v export_sql="$EXPORT_SQL" > "$OUT/fixture.out" <<'SQL'
BEGIN;

INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'menu admin'),
  ('00000000-0000-0000-0000-0000000000f2', 'menu user'),
  ('00000000-0000-0000-0000-0000000000f3', 'menu editor'),
  ('00000000-0000-0000-0000-0000000000f4', 'translator')
ON CONFLICT DO NOTHING;

INSERT INTO metadata.roles (role_key, display_name) VALUES ('mt_menu_editor', 'Menu editor'), ('mt_translator', 'Translator');
INSERT INTO metadata.permission_roles (role_id, permission_id)
SELECT r.id, p.id FROM metadata.roles r CROSS JOIN metadata.permissions p
WHERE (r.role_key = 'mt_menu_editor' AND p.table_name = 'metadata.menu_nodes' AND p.permission = 'update')
   OR (r.role_key = 'mt_translator' AND p.table_name = 'metadata.translations' AND p.permission = 'update');

-- Tables: mt_pub* and mt_hid readable by everyone, mt_private* by signed-in users only.
CREATE TABLE public.mt_pub1 (id INT PRIMARY KEY);
CREATE TABLE public.mt_pub2 (id INT PRIMARY KEY);
CREATE TABLE public.mt_pub3 (id INT PRIMARY KEY);
CREATE TABLE public.mt_pub4 (id INT PRIMARY KEY);
CREATE TABLE public.mt_pub5 (id INT PRIMARY KEY);
CREATE TABLE public.mt_hid (id INT PRIMARY KEY);
CREATE TABLE public.mt_private (id INT PRIMARY KEY);
CREATE TABLE public.mt_private2 (id INT PRIMARY KEY);
CREATE TABLE public.mt_private3 (id INT PRIMARY KEY);
GRANT SELECT ON public.mt_pub1, public.mt_pub2, public.mt_pub3, public.mt_pub4, public.mt_pub5, public.mt_hid
  TO web_anon, authenticated;
GRANT SELECT ON public.mt_private, public.mt_private2, public.mt_private3 TO authenticated;

-- The tree (the example's nodes are removed; all rolled back):
--   mt_h_top (heading)               mt_h_hidden (heading, hidden)      mt_private (entity)
--     mt_h_sub (heading)               mt_hid "Secret label"              mt_pub3
--       mt_pub1                                                             mt_pub5
--     mt_pub2                        mt_h_priv (heading)                mt_pub4 (hidden root)
--                                      mt_private2                      mt_private3 (hidden root)
DELETE FROM metadata.menu_nodes;
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, icon, sort_order) VALUES ('mt_h_top', 'heading', 'Top', 'folder', 10);
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key, sort_order) VALUES ('mt_h_sub', 'heading', 'Sub', 'mt_h_top', 10);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order) VALUES ('mt_pub1', 'entity', 'mt_pub1', 'mt_h_sub', 10);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order) VALUES ('mt_pub2', 'entity', 'mt_pub2', 'mt_h_top', 20);
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, sort_order, is_hidden) VALUES ('mt_h_hidden', 'heading', 'Hidden heading', 20, TRUE);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, display_name, icon, parent_node_key, sort_order) VALUES ('mt_hid', 'entity', 'mt_hid', 'Secret label', 'lock', 'mt_h_hidden', 10);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, display_name, sort_order) VALUES ('mt_private', 'entity', 'mt_private', 'Private', 30);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order) VALUES ('mt_pub3', 'entity', 'mt_pub3', 'mt_private', 10);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order) VALUES ('mt_pub5', 'entity', 'mt_pub5', 'mt_pub3', 10);
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, sort_order) VALUES ('mt_h_priv', 'heading', 'Private heading', 40);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order) VALUES ('mt_private2', 'entity', 'mt_private2', 'mt_h_priv', 10);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, display_name, sort_order, is_hidden) VALUES ('mt_pub4', 'entity', 'mt_pub4', 'Hidden root', 50, TRUE);
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, sort_order, is_hidden) VALUES ('mt_private3', 'entity', 'mt_private3', 60, TRUE);

-- Shape of a caller's rows: key:parent:V (visible) or key:-:S (stub), in code point order.
CREATE FUNCTION public.mt_menu_shape() RETURNS TEXT LANGUAGE sql AS $$
  SELECT string_agg(node_key || ':' || COALESCE(parent_node_key, '-') || ':'
                    || CASE WHEN is_hidden THEN 'S' ELSE 'V' END, ' ' ORDER BY node_key COLLATE "C")
  FROM public.schema_menu_nodes $$;
CREATE FUNCTION public.mt_table_shape() RETURNS TEXT LANGUAGE sql AS $$
  SELECT string_agg(node_key, ' ' ORDER BY node_key COLLATE "C") FROM metadata.menu_nodes $$;
GRANT EXECUTE ON FUNCTION public.mt_menu_shape(), public.mt_table_shape() TO web_anon, authenticated;

-- ---------------------------------------------------------------------------
-- eligible: menu_target_eligible() equals superuser schema_entities for every relation in public
-- ---------------------------------------------------------------------------
CREATE VIEW public.mt_v_registered AS SELECT id FROM public.mt_pub1;
CREATE VIEW public.mt_v_unregistered AS SELECT id FROM public.mt_pub1;
CREATE VIEW public.schema_mt_v AS SELECT id FROM public.mt_pub1;
CREATE VIEW public.schemaxmt_v AS SELECT id FROM public.mt_pub1;   -- LIKE 'schema_%' matches it too
CREATE MATERIALIZED VIEW public.mt_mat AS SELECT id FROM public.mt_pub1;
CREATE TABLE public.mt_part (id INT) PARTITION BY RANGE (id);
CREATE TABLE public.mt_part_1 PARTITION OF public.mt_part FOR VALUES FROM (0) TO (10);
INSERT INTO metadata.entities (table_name, display_name) VALUES
  ('mt_v_registered', 'Registered view'), ('schema_mt_v', 'Schema-prefixed view'), ('schemaxmt_v', 'Prefix-like view'),
  ('mt_mat', 'Registered materialized view');
DO $$
DECLARE v_bad TEXT;
BEGIN
  SELECT string_agg(c.relname || '(' || c.relkind::TEXT || ')', ', ') INTO v_bad
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace
    AND metadata.menu_target_eligible(c.relname)
        IS DISTINCT FROM EXISTS (SELECT 1 FROM public.schema_entities se WHERE se.table_name = c.relname);
  ASSERT v_bad IS NULL, 'menu_target_eligible differs from schema_entities for: ' || v_bad;
  ASSERT metadata.menu_target_eligible('mt_v_registered') AND metadata.menu_target_eligible('mt_part')
     AND NOT metadata.menu_target_eligible('mt_v_unregistered') AND NOT metadata.menu_target_eligible('schemaxmt_v')
     AND NOT metadata.menu_target_eligible('mt_mat') AND NOT metadata.menu_target_eligible('mt_no_such_table'),
    'menu_target_eligible fixture cases';
END $$;

-- ---------------------------------------------------------------------------
-- rows: per caller
-- ---------------------------------------------------------------------------
-- anonymous
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE web_anon;
DO $$
DECLARE v TEXT;
BEGIN
  PERFORM set_config('request.headers', '{}', true);
  v := public.mt_menu_shape();
  ASSERT v = 'mt_h_sub:mt_h_top:V mt_h_top:-:V mt_hid:-:S mt_pub1:mt_h_sub:V mt_pub2:mt_h_top:V mt_pub3:-:V mt_pub4:-:S mt_pub5:mt_pub3:V',
    'anon rows, got ' || COALESCE(v, '<none>');
  ASSERT (SELECT bool_and(display_name IS NULL AND base_display_name IS NULL AND icon IS NULL AND parent_node_key IS NULL
                          AND sort_order IS NULL AND node_kind = 'entity' AND target_key::TEXT = node_key AND NOT collapsed_by_default)
          FROM public.schema_menu_nodes WHERE is_hidden), 'anon stubs carry only key and target';
  ASSERT (SELECT display_name FROM public.schema_menu_nodes WHERE node_key = 'mt_h_top') = 'Top'
     AND (SELECT icon FROM public.schema_menu_nodes WHERE node_key = 'mt_h_top') = 'folder', 'anon visible rows keep labels and icons';
  v := public.mt_table_shape();
  ASSERT v = 'mt_h_sub mt_h_top mt_pub1 mt_pub2 mt_pub3 mt_pub5', 'anon reads only rendered nodes from the table, got ' || COALESCE(v, '<none>');
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.menu_nodes WHERE display_name = 'Secret label'), 'anon never reads a hidden label';
END $$;
\set label fixture:anon
:export_sql
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- plain user: reads every fixture table, so only hidden nodes change
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["user"]}', true) IS NULL;
DO $$
DECLARE v TEXT;
BEGIN
  ASSERT NOT metadata.can_read_full_menu(), 'a plain user is not a full reader';
  v := public.mt_menu_shape();
  ASSERT v = 'mt_h_priv:-:V mt_h_sub:mt_h_top:V mt_h_top:-:V mt_hid:-:S mt_private:-:V mt_private2:mt_h_priv:V mt_private3:-:S '
             'mt_pub1:mt_h_sub:V mt_pub2:mt_h_top:V mt_pub3:mt_private:V mt_pub4:-:S mt_pub5:mt_pub3:V',
    'user rows, got ' || COALESCE(v, '<none>');
  ASSERT public.mt_table_shape() = 'mt_h_priv mt_h_sub mt_h_top mt_private mt_private2 mt_pub1 mt_pub2 mt_pub3 mt_pub5',
    'user reads only rendered nodes from the table';
END $$;
\set label fixture:user
:export_sql
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- full readers: admin, menu editor, translator
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated","roles":["admin"]}', true) IS NULL;
DO $$
BEGIN
  ASSERT metadata.can_read_full_menu() AND metadata.can_manage_menu(), 'admin manages the menu';
  ASSERT public.mt_menu_shape() = 'mt_h_hidden:-:S mt_h_priv:-:V mt_h_sub:mt_h_top:V mt_h_top:-:V mt_hid:mt_h_hidden:V '
                                'mt_private:-:V mt_private2:mt_h_priv:V mt_private3:-:S mt_pub1:mt_h_sub:V mt_pub2:mt_h_top:V '
                                'mt_pub3:mt_private:V mt_pub4:-:S mt_pub5:mt_pub3:V',
    'admin reads every node with its stored parent, got ' || public.mt_menu_shape();
  ASSERT (SELECT display_name = 'Secret label' AND icon = 'lock' FROM public.schema_menu_nodes WHERE node_key = 'mt_hid'),
    'admin reads hidden labels';
END $$;
\set label fixture:full
:export_sql
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f3","role":"authenticated","roles":["user","mt_menu_editor"]}', true) IS NULL;
DO $$
BEGIN
  ASSERT metadata.can_manage_menu() AND NOT public.is_admin(), 'the permission alone manages the menu';
  ASSERT (SELECT count(*) FROM public.schema_menu_nodes) = 13 AND public.mt_table_shape() LIKE 'mt_h_hidden %',
    'the menu editor reads every node';
END $$;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f4","role":"authenticated","roles":["user","mt_translator"]}', true) IS NULL;
DO $$
BEGIN
  ASSERT metadata.can_read_full_menu() AND NOT metadata.can_manage_menu(), 'a translator reads but does not manage';
  ASSERT (SELECT count(*) FROM public.schema_menu_nodes) = 13, 'the translator reads every node';
  ASSERT (SELECT parent_node_key FROM public.schema_menu_nodes WHERE node_key = 'mt_hid') = 'mt_h_hidden',
    'the translator reads stored parents';
  ASSERT EXISTS (SELECT 1 FROM public.get_translation_defaults() d
                 WHERE d.source_type = 'menu_node' AND d.source_key = 'mt_h_hidden.display_name'),
    'the translator gets hidden heading labels from get_translation_defaults()';
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- ---------------------------------------------------------------------------
-- writes
-- ---------------------------------------------------------------------------
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["user"]}', true) IS NULL;
DO $$
DECLARE n INT;
BEGIN
  BEGIN
    PERFORM public.save_menu_tree('[]'::jsonb);
    ASSERT false, 'user save_menu_tree must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name) VALUES ('mt_x', 'heading', 'x');
    ASSERT false, 'user direct insert must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE metadata.menu_nodes SET sort_order = 99 WHERE node_key = 'mt_pub1';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'user direct update must change nothing, changed ' || n;
  DELETE FROM metadata.menu_nodes WHERE node_key = 'mt_pub1';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'user direct delete must change nothing, deleted ' || n;
END $$;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f4","role":"authenticated","roles":["user","mt_translator"]}', true) IS NULL;
DO $$
BEGIN
  BEGIN
    PERFORM public.save_menu_tree('[]'::jsonb);
    ASSERT false, 'translator save_menu_tree must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM metadata.menu_nodes) = 13
     AND (SELECT sort_order FROM metadata.menu_nodes WHERE node_key = 'mt_pub1') = 10, 'denied writes changed nothing';
END $$;

-- version: the menu editor saves the tree back with the version it read
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f3","role":"authenticated","roles":["user","mt_menu_editor"]}', true) IS NULL;
DO $$
DECLARE
  v_tree JSONB := (SELECT jsonb_agg(to_jsonb(n) - 'created_at' - 'updated_at') FROM metadata.menu_nodes n);
  v0 TIMESTAMPTZ := (SELECT version FROM public.schema_cache_versions WHERE cache_name = 'menu');
  r JSONB;
  v_hint TEXT;
  v_state TEXT;
  n INT;
BEGIN
  r := public.save_menu_tree(v_tree, v0);
  ASSERT (r->>'nodes')::INT = 13, 'the editor saved the tree, got ' || r::TEXT;
  ASSERT (r->>'menu_version')::TIMESTAMPTZ = (SELECT version FROM public.schema_cache_versions WHERE cache_name = 'menu'),
    'the returned version is the cache version';
  ASSERT (r->>'menu_version')::TIMESTAMPTZ <> v0, 'the version moved';
  BEGIN
    PERFORM public.save_menu_tree(v_tree, v0);
    ASSERT false, 'a stale version must raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    ASSERT v_state = 'PT409', 'stale save raises PT409, got ' || v_state;
    ASSERT v_hint LIKE '%' || (SELECT changed_at FROM metadata.menu_version)::TEXT || '%', 'the hint names the stored version: ' || v_hint;
  END;
  r := public.save_menu_tree(v_tree, (r->>'menu_version')::TIMESTAMPTZ);
  ASSERT (r->>'nodes')::INT = 13, 'the current version saves';
  r := public.save_menu_tree(v_tree);
  ASSERT (r->>'nodes')::INT = 13 AND r->'skipped' = '[]'::jsonb, 'no version skips the check';
  UPDATE metadata.menu_nodes SET sort_order = 11 WHERE node_key = 'mt_pub1';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 1, 'the editor updates directly';
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- escape valve: an admin whose role lost the permission still saves
DELETE FROM metadata.permission_roles pr USING metadata.permissions p, metadata.roles r
WHERE pr.permission_id = p.id AND pr.role_id = r.id
  AND p.table_name = 'metadata.menu_nodes' AND r.role_key = 'admin';
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated","roles":["admin"]}', true) IS NULL;
DO $$
BEGIN
  ASSERT NOT public.has_permission('metadata.menu_nodes', 'update'), 'the admin role lost the permission';
  ASSERT (public.save_menu_tree((SELECT jsonb_agg(to_jsonb(n) - 'created_at' - 'updated_at') FROM metadata.menu_nodes n))->>'nodes')::INT = 13,
    'an admin without the permission still saves';
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

ROLLBACK;
SQL
echo "PASS: rows per caller (anon, user, admin, menu editor, translator), stubs, eligibility = schema_entities, writes, version check"

# -----------------------------------------------------------------------------
# the example's own menu, per caller (read-only, rolled back)
# -----------------------------------------------------------------------------
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -At -F $'\t' -v export_sql="$EXPORT_SQL" > "$OUT/example.out" <<'SQL'
BEGIN;
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE web_anon;
\set label example:anon
:export_sql
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["user"]}', true) IS NULL;
\set label example:user
:export_sql
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["user","editor"]}', true) IS NULL;
\set label example:editor
:export_sql
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["user","manager"]}', true) IS NULL;
\set label example:manager
:export_sql
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated","roles":["admin"]}', true) IS NULL;
\set label example:full
:export_sql
ROLLBACK;
SQL

# buildMenu over each non-full reader's rows equals buildMenu over the full rows with the same entities, and the
# rendered tree (keys and parents, unplaced entities aside) equals the server's visible rows.
grep -h '^JSON' "$OUT/fixture.out" "$OUT/example.out" | node --input-type=module -e '
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
const { buildMenu } = await import(process.argv[1]);
const exports = new Map(readFileSync(0, "utf8").trim().split("\n").map(l => { const [, label, json] = l.split("\t"); return [label, JSON.parse(json)]; }));
const flatten = (entries, parent, out) => { for (const e of entries) { out.push(`${e.key}:${parent ?? "-"}`); flatten(e.children, e.key, out); } return out; };
let failed = 0, checked = 0;
for (const [label, { entities, rows }] of exports) {
  const [group, caller] = label.split(":");
  if (caller === "full") continue;
  const full = exports.get(`${group}:full`).rows;
  const mine = buildMenu(entities, rows);
  if (!isDeepStrictEqual(mine, buildMenu(entities, full))) { failed++; console.log(`FAIL: ${label}: buildMenu differs from the full rows`); }
  const keys = new Set(rows.map(r => r.node_key));
  const rendered = flatten(mine.filter(e => keys.has(e.key)), null, []).sort();
  const server = rows.filter(r => !r.is_hidden).map(r => `${r.node_key}:${r.parent_node_key ?? "-"}`).sort();
  if (!isDeepStrictEqual(rendered, server)) { failed++; console.log(`FAIL: ${label}: server rows ${server} != rendered ${rendered}`); }
  checked++;
}
if (checked < 6) { console.log(`FAIL: only ${checked} callers exported`); process.exit(1); }
if (failed) process.exit(1);
console.log(`PASS: buildMenu equality and server tree = rendered tree for ${checked} callers (fixture and example)`);
' "$CORE"

# -----------------------------------------------------------------------------
# lock: two sessions save the current tree with the same version
# -----------------------------------------------------------------------------
ADMIN_SETUP="SET SESSION AUTHORIZATION authenticator; SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-0000-0000-0000000000f1\",\"role\":\"authenticated\",\"roles\":[\"admin\"]}', false) IS NULL;"
TREE="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "SELECT COALESCE(jsonb_agg(to_jsonb(n) - 'created_at' - 'updated_at'), '[]') FROM metadata.menu_nodes n")"
V0="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "SELECT changed_at FROM metadata.menu_version")"
printf '%s' "$TREE" > "$OUT/tree.json"

# A: saves with V0 and holds the transaction (and the advisory lock) open for 3 seconds.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -At -v tree="$TREE" -v v0="$V0" > "$OUT/a.out" 2>&1 <<SQL &
$ADMIN_SETUP
BEGIN;
SELECT 'A saved ' || ((public.save_menu_tree(:'tree'::jsonb, :'v0'::timestamptz))->>'nodes');
SELECT pg_sleep(3) IS NULL;
COMMIT;
SQL
A_PID=$!
sleep 1
START=$(date +%s)
set +e
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -At -v VERBOSITY=verbose -v tree="$TREE" -v v0="$V0" > "$OUT/b.out" 2>&1 <<SQL
\set VERBOSITY verbose
$ADMIN_SETUP
SELECT public.save_menu_tree(:'tree'::jsonb, :'v0'::timestamptz);
SQL
B_RC=$?
set -e
WAITED=$(( $(date +%s) - START ))
wait "$A_PID" || { echo "FAIL: lock: session A failed"; cat "$OUT/a.out"; exit 1; }
grep -q '^A saved ' "$OUT/a.out" || { echo "FAIL: lock: session A did not save"; cat "$OUT/a.out"; exit 1; }
[ "$B_RC" -ne 0 ] || { echo "FAIL: lock: session B saved with a stale version"; cat "$OUT/b.out"; exit 1; }
grep -q 'PT409' "$OUT/b.out" || { echo "FAIL: lock: session B did not get PT409"; cat "$OUT/b.out"; exit 1; }
V1="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "SELECT changed_at FROM metadata.menu_version")"
grep -qF "stored version $V1" "$OUT/b.out" || { echo "FAIL: lock: the hint does not name the stored version $V1"; cat "$OUT/b.out"; exit 1; }
[ "$WAITED" -ge 1 ] || { echo "FAIL: lock: session B did not wait for session A (${WAITED}s)"; exit 1; }
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -At -v tree="$TREE" > "$OUT/c.out" 2>&1 <<SQL || { echo "FAIL: lock: NULL-version save failed"; cat "$OUT/c.out"; exit 1; }
$ADMIN_SETUP
SELECT public.save_menu_tree(:'tree'::jsonb, NULL);
SQL
AFTER="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "SELECT COALESCE(jsonb_agg(to_jsonb(n) - 'created_at' - 'updated_at'), '[]') FROM metadata.menu_nodes n")"
[ "$(jq -S 'sort_by(.node_key)' <<<"$AFTER")" = "$(jq -S 'sort_by(.node_key)' "$OUT/tree.json")" ] \
  || { echo "FAIL: lock: the tree changed"; exit 1; }
echo "PASS: lock: the second save waited ${WAITED}s for the first, then got PT409 naming the stored version; a NULL-version save went through; the tree is unchanged"
