#!/bin/bash
# =============================================================================
# Functional Test: v0-85-0 parent-cycle guard
# =============================================================================
# Covers metadata.tree_parent_guard(), enable_tree_parent_guard(), the tree_parent_cycle constraint message
# and the translated public.constraint_messages view:
#   1. (rolled back) A parent equal to the row is refused on insert and update; a re-parent under a
#      descendant is refused; legal moves, NULL parents and updates that leave the parent alone pass; the error
#      is 23514 in PostgreSQL's check-violation form naming "tree_parent_cycle". A table that already holds a
#      cycle is refused, naming the rows. The parent column can still be dropped, and inserts keep working.
#      Re-enabling after a rename refreshes the trigger arguments. Only public base tables with a self FK
#      qualify (22023 otherwise). A non-admin JWT is refused (42501); an admin JWT is admitted. RLS that
#      hides an ancestor from the writer does not hide it from the walk. The view returns the English text,
#      and the Spanish translation for an es request.
#   2. (committed, cleaned up) Two concurrent re-parents that together would form a cycle: the second waits
#      for the first and is refused.
#   3. (committed, cleaned up) Over PostgREST with a Keycloak token: a PATCH that creates a cycle answers 400
#      with code 23514 and a message naming the constraint, which is how the frontend finds the friendly text;
#      /constraint_messages returns it translated for Accept-Language: es.
#
# Usage:
#   ./tests/functional/v0-85-0-tree-parent-guard-test.sh
#
# Environment overrides (the psql user must be a superuser):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
#   POSTGREST_URL  http://localhost:3000     KEYCLOAK_URL  http://localhost:8082
#   SKIP_API=1     skip section 3 (no PostgREST or Keycloak running)
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -uo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"
POSTGREST_URL="${POSTGREST_URL:-http://localhost:3000}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8082}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-civic-os-dev}"
KEYCLOAK_CLIENT="${KEYCLOAK_CLIENT:-civic-os-dev-client}"

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0
pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
check_contains() { case "$3" in *"$2"*) pass "$1";; *) fail "$1 (expected to contain '$2', got '$3')";; esac; }
q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atq -c "$1"; }

# -----------------------------------------------------------------------------
echo -e "${BOLD}1. Guard rules (rolled back)${NC}"
# -----------------------------------------------------------------------------
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

CREATE FUNCTION pg_temp.expect_sqlstate(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE = p_state;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_sqlstate(text, text) TO PUBLIC;

-- a tree: 1 > 2 > 3, and a second root 4
CREATE TABLE public.tg_nodes (id BIGSERIAL PRIMARY KEY, parent_id BIGINT REFERENCES public.tg_nodes(id), name TEXT);
CREATE INDEX ON public.tg_nodes(parent_id);
INSERT INTO public.tg_nodes (id, parent_id, name) VALUES (1, NULL, 'root'), (2, 1, 'child'), (3, 2, 'grandchild'), (4, NULL, 'other');

DO $$
DECLARE
  v_msg text; v_state text; v_detail text;
BEGIN
  PERFORM public.enable_tree_parent_guard('tg_nodes', 'parent_id');
  ASSERT (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.tg_nodes'::regclass AND tgname = 'tree_parent_guard') = 1,
    'the trigger is installed';
  ASSERT (SELECT tgattr = ''::int2vector FROM pg_trigger WHERE tgrelid = 'public.tg_nodes'::regclass AND tgname = 'tree_parent_guard'),
    'the trigger has no column list';

  -- the error shape
  BEGIN
    UPDATE public.tg_nodes SET parent_id = 3 WHERE id = 1;
    RAISE EXCEPTION 'no error';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
  END;
  ASSERT v_state = '23514', format('a cycle is 23514, got %s', v_state);
  ASSERT v_msg = 'new row for relation "tg_nodes" violates check constraint "tree_parent_cycle"', format('message: %s', v_msg);
  ASSERT v_detail = 'A row cannot be placed under itself or one of its own descendants.', format('detail: %s', v_detail);

  ASSERT pg_temp.expect_sqlstate('INSERT INTO public.tg_nodes (id, parent_id) VALUES (10, 10)', '23514'), 'insert under itself';
  ASSERT pg_temp.expect_sqlstate('UPDATE public.tg_nodes SET parent_id = 2 WHERE id = 2', '23514'), 'update under itself';
  ASSERT pg_temp.expect_sqlstate('UPDATE public.tg_nodes SET parent_id = 2 WHERE id = 1', '23514'), 'under a child';
  ASSERT (SELECT parent_id FROM public.tg_nodes WHERE id = 1) IS NULL, 'refused updates changed nothing';

  INSERT INTO public.tg_nodes (id, parent_id, name) VALUES (5, 3, 'leaf');
  UPDATE public.tg_nodes SET parent_id = 4 WHERE id = 2;      -- move a subtree under another root
  UPDATE public.tg_nodes SET parent_id = 5 WHERE id = 1;      -- 1 under 5 (5 > 3 > 2 > 4): legal now
  UPDATE public.tg_nodes SET name = 'renamed' WHERE id = 1;   -- parent unchanged
  UPDATE public.tg_nodes SET parent_id = NULL WHERE id = 1;
  ASSERT pg_temp.expect_sqlstate('UPDATE public.tg_nodes SET parent_id = 5 WHERE id = 4', '23514'),
    'the root under its deepest descendant';
END $$;

-- a table that already holds a cycle is refused, naming the rows
CREATE TABLE public.tg_cyclic (id BIGSERIAL PRIMARY KEY, parent_id BIGINT REFERENCES public.tg_cyclic(id));
INSERT INTO public.tg_cyclic VALUES (1, NULL), (2, 1), (3, 2), (7, NULL);
UPDATE public.tg_cyclic SET parent_id = 3 WHERE id = 1;
UPDATE public.tg_cyclic SET parent_id = 7 WHERE id = 7;
DO $$
DECLARE
  v_state text; v_detail text;
BEGIN
  BEGIN
    PERFORM public.enable_tree_parent_guard('tg_cyclic', 'parent_id');
    RAISE EXCEPTION 'no error';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
  END;
  ASSERT v_state = '23514', format('an existing cycle is 23514, got %s', v_state);
  ASSERT v_detail LIKE '%rows in a cycle (first 4): 1, 2, 3, 7', format('the rows are named: %s', v_detail);
  ASSERT NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.tg_cyclic'::regclass AND tgname = 'tree_parent_guard'),
    'no trigger on a refused table';
END $$;

-- dropping and renaming the parent column
DO $$
BEGIN
  ALTER TABLE public.tg_nodes RENAME COLUMN parent_id TO up_id;
  UPDATE public.tg_nodes SET up_id = 1 WHERE id = 1;   -- the guard is off until re-installed (documented)
  UPDATE public.tg_nodes SET up_id = NULL WHERE id = 1;
  PERFORM public.enable_tree_parent_guard('tg_nodes', 'up_id');
  ASSERT (SELECT encode(tgargs, 'escape') FROM pg_trigger WHERE tgrelid = 'public.tg_nodes'::regclass AND tgname = 'tree_parent_guard')
    = E'id\\000up_id\\000', 're-enabling refreshes the arguments';
  ASSERT pg_temp.expect_sqlstate('UPDATE public.tg_nodes SET up_id = 1 WHERE id = 1', '23514'), 'and the guard is back';

  ALTER TABLE public.tg_nodes DROP COLUMN up_id;   -- no CASCADE needed
  INSERT INTO public.tg_nodes (id, name) VALUES (20, 'flat');
  UPDATE public.tg_nodes SET name = 'still works' WHERE id = 20;
END $$;

-- which tables and columns qualify
CREATE SCHEMA tg_fx;
CREATE TABLE tg_fx.nodes (id BIGSERIAL PRIMARY KEY, parent_id BIGINT REFERENCES tg_fx.nodes(id));
CREATE TABLE public.tg_other (id BIGSERIAL PRIMARY KEY);
CREATE TABLE public.tg_bad (id BIGSERIAL PRIMARY KEY, parent_id BIGINT, other_id BIGINT REFERENCES public.tg_other(id));
CREATE VIEW public.tg_view AS SELECT id, parent_id FROM public.tg_bad;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.enable_tree_parent_guard('nodes', 'parent_id')$q$, '22023'), 'not in public';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.enable_tree_parent_guard('tg_view', 'parent_id')$q$, '22023'), 'a view';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.enable_tree_parent_guard('tg_bad', 'parent_id')$q$, '22023'), 'no FK';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.enable_tree_parent_guard('tg_bad', 'other_id')$q$, '22023'), 'FK to another table';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.enable_tree_parent_guard('tg_cyclic', 'parent_id', 'nope')$q$, '22023'), 'wrong key column';
END $$;

-- RLS hides an ancestor from the writer, not from the walk: V1 (visible) > H (hidden) > V2 (visible)
CREATE TABLE public.tg_rls (id BIGSERIAL PRIMARY KEY, parent_id BIGINT REFERENCES public.tg_rls(id), visible BOOLEAN NOT NULL);
INSERT INTO public.tg_rls VALUES (1, NULL, true), (2, 1, false), (3, 2, true);
ALTER TABLE public.tg_rls ENABLE ROW LEVEL SECURITY;
CREATE POLICY tg_rls_read ON public.tg_rls FOR SELECT USING (visible);
CREATE POLICY tg_rls_write ON public.tg_rls FOR UPDATE USING (visible);
GRANT SELECT, UPDATE ON public.tg_rls TO authenticated;
SELECT public.enable_tree_parent_guard('tg_rls', 'parent_id');

-- PostgREST's login role
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000085b1","role":"authenticated","roles":["manager"]}', true);
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.tg_rls) = 2, 'the writer sees two of three rows';
  ASSERT pg_temp.expect_sqlstate('UPDATE public.tg_rls SET parent_id = 3 WHERE id = 1', '23514'),
    'a cycle through a hidden row is refused';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.enable_tree_parent_guard('tg_bad', 'parent_id')$q$, '42501'),
    'a non-admin JWT cannot enable the guard (42501)';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000085b2","role":"authenticated","roles":["admin"]}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.enable_tree_parent_guard('tg_rls', 'parent_id');   -- re-install over the API
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

-- the view translates the message
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  PERFORM set_config('request.headers', '{"accept-language":"en"}', true);
  ASSERT (SELECT error_message FROM public.constraint_messages WHERE constraint_name = 'tree_parent_cycle')
    = 'A record cannot be placed under itself or one of its own descendants. Choose a different parent.', 'English';
  PERFORM set_config('request.headers', '{"accept-language":"es-MX,es;q=0.9"}', true);
  ASSERT (SELECT error_message FROM public.constraint_messages WHERE constraint_name = 'tree_parent_cycle') LIKE 'Un registro no puede%',
    'Spanish for an es request';
  ASSERT (SELECT error_message FROM public.constraint_messages WHERE constraint_name = 'dimension_row_delete') LIKE 'Este registro%',
    'the dimension delete message too';
END $$;
RESET ROLE;

ROLLBACK;
SQL
then
  pass "insert/update rules, error shape, existing cycles, drop and rename, qualifying tables, RLS, JWT guard, translation"
else
  fail "guard rules (see the assertion above)"
fi

# -----------------------------------------------------------------------------
echo -e "${BOLD}2. Concurrent re-parents${NC}"
# -----------------------------------------------------------------------------
q "DROP TABLE IF EXISTS public.tg_conc;
   CREATE TABLE public.tg_conc (id BIGSERIAL PRIMARY KEY, parent_id BIGINT REFERENCES public.tg_conc(id));
   CREATE INDEX ON public.tg_conc(parent_id);
   INSERT INTO public.tg_conc VALUES (1, NULL), (2, NULL);
   SELECT public.enable_tree_parent_guard('tg_conc', 'parent_id');" >/dev/null
trap 'q "DROP TABLE IF EXISTS public.tg_conc" >/dev/null' EXIT

OUT_A=$(mktemp)
psql "$DATABASE_URL" -Atq -v ON_ERROR_STOP=1 > "$OUT_A" 2>&1 <<'SQL' &
BEGIN;
UPDATE public.tg_conc SET parent_id = 2 WHERE id = 1;
SELECT pg_sleep(2);
COMMIT;
SQL
PID_A=$!
sleep 0.7
OUT_B=$(psql "$DATABASE_URL" -Atq -c "UPDATE public.tg_conc SET parent_id = 1 WHERE id = 2" 2>&1)
wait $PID_A
check "the first re-parent commits" "" "$(grep -v '^$' "$OUT_A")"
check_contains "the second waits for it and is refused" 'violates check constraint "tree_parent_cycle"' "$OUT_B"
check "no cycle was committed" "2|" "$(q "SELECT string_agg(coalesce(parent_id::text, ''), '|' ORDER BY id) FROM public.tg_conc")"
rm -f "$OUT_A"
q "DROP TABLE public.tg_conc" >/dev/null
trap - EXIT

# -----------------------------------------------------------------------------
echo -e "${BOLD}3. Over PostgREST${NC}"
# -----------------------------------------------------------------------------
if [ "${SKIP_API:-0}" = "1" ]; then
  echo "  (skipped: SKIP_API=1)"
else
  q "DROP TABLE IF EXISTS public.tg_api;
     CREATE TABLE public.tg_api (id BIGSERIAL PRIMARY KEY, parent_id BIGINT REFERENCES public.tg_api(id), name TEXT);
     CREATE INDEX ON public.tg_api(parent_id);
     GRANT SELECT, UPDATE ON public.tg_api TO authenticated;
     INSERT INTO public.tg_api VALUES (1, NULL, 'a'), (2, 1, 'b');
     SELECT public.enable_tree_parent_guard('tg_api', 'parent_id');
     NOTIFY pgrst, 'reload schema';" >/dev/null
  trap 'q "DROP TABLE IF EXISTS public.tg_api; NOTIFY pgrst, '"'"'reload schema'"'"';" >/dev/null' EXIT
  sleep 2
  TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
    -d grant_type=password -d client_id="$KEYCLOAK_CLIENT" -d username=testadmin -d password=testadmin |
    python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
  BODY=$(mktemp)
  STATUS=$(curl -s -o "$BODY" -w "%{http_code}" -X PATCH "$POSTGREST_URL/tg_api?id=eq.1" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"parent_id":2}')
  check "a cycle over the API is a 400" "400" "$STATUS"
  check "with code 23514" "23514" "$(python3 -c "import json;print(json.load(open('$BODY'))['code'])")"
  check_contains "and a message the frontend matches by constraint name" 'constraint "tree_parent_cycle"' \
    "$(python3 -c "import json;print(json.load(open('$BODY'))['message'])")"
  rm -f "$BODY"
  check "the row is unchanged" "" "$(q "SELECT coalesce(parent_id::text, '') FROM public.tg_api WHERE id = 1")"
  check_contains "the friendly message, in Spanish for Accept-Language: es" "Un registro no puede" \
    "$(curl -s "$POSTGREST_URL/constraint_messages?constraint_name=eq.tree_parent_cycle&select=error_message" -H "Accept-Language: es")"
  q "DROP TABLE public.tg_api; NOTIFY pgrst, 'reload schema';" >/dev/null
  trap - EXIT
fi

echo ""
echo -e "${BOLD}Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
[ "$FAIL" -eq 0 ]
