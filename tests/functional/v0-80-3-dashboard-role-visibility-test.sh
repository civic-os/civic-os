#!/bin/bash
# =============================================================================
# Functional Test: v0-80-3 dashboard role visibility
# =============================================================================
# Exercises metadata.dashboard_roles, the shared visibility rule, set_dashboard_roles() and the legacy
# dashboard_role_defaults sync the way PostgREST does (authenticator -> web_anon/authenticated, JWT in
# request.jwt.claims). Rows only grant; is_public = false is the only restriction switch. Asserts:
#   - public dashboards are visible to everyone; non-public ones to creator, admin and roles with a row
#   - a show row grants a role access to a non-public dashboard (RPCs, dashboards table, widgets)
#   - a default row grants visibility too (show + default) and tier 2 picks the landing dashboard
#   - an anonymous row grants signed-out visitors, not signed-in users
#   - set_dashboard_roles(..., 'show') never deletes default rows; 'default' writes through
#     dashboard_role_defaults (and clears it); non-admins are denied; bad input raises
#   - a direct write to the deprecated dashboard_role_defaults lands in dashboard_roles
#   - get_user_default_dashboard() falls back to the first visible dashboard
#   - impersonation: narrowed JWT roles change what is visible
#   - dashboard_roles is unreadable to non-admins
# Everything runs in one transaction that is rolled back.
#
# Usage: ./tests/functional/v0-80-3-dashboard-role-visibility-test.sh
# Environment: DATABASE_URL (superuser, to create fixtures)
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'dash creator'),
  ('00000000-0000-0000-0000-0000000000e2', 'dash editor'),
  ('00000000-0000-0000-0000-0000000000e3', 'dash admin');

INSERT INTO metadata.roles (role_key, display_name) VALUES
  ('dashtest_staff', 'Dash test staff'), ('dashtest_other', 'Dash test other');

-- pub: public. staff: non-public, shown to dashtest_staff. priv: non-public, creator e1.
-- def: non-public, default of dashtest_other.
-- Neutralize tier 3 (is_default) so the fallback tier can be observed.
UPDATE metadata.dashboards SET is_default = FALSE;
CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id INT);
GRANT ALL ON ids TO PUBLIC;
WITH ins AS (
  INSERT INTO metadata.dashboards (display_name, is_public, created_by, sort_order) VALUES
    ('DT public', TRUE, '00000000-0000-0000-0000-0000000000e1', 9001),
    ('DT staff', FALSE, '00000000-0000-0000-0000-0000000000e1', 9002),
    ('DT private', FALSE, '00000000-0000-0000-0000-0000000000e1', 9003),
    ('DT default', FALSE, '00000000-0000-0000-0000-0000000000e1', 9004)
  RETURNING id, display_name)
INSERT INTO ids SELECT CASE display_name WHEN 'DT public' THEN 'pub' WHEN 'DT staff' THEN 'staff'
  WHEN 'DT private' THEN 'priv' ELSE 'def' END, id FROM ins;

INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, config, sort_order)
SELECT id, 'markdown', '{"content":"x"}', 1 FROM ids;

-- Admin-style setup through the RPC (as admin e3)
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e3","role":"authenticated","roles":["admin"]}', true);

SELECT public.set_dashboard_roles((SELECT id FROM ids WHERE k='staff'), ARRAY['dashtest_staff']);
SELECT public.set_dashboard_roles((SELECT id FROM ids WHERE k='def'), ARRAY['dashtest_other'], 'default', 5);
SELECT public.set_dashboard_roles((SELECT id FROM ids WHERE k='priv'), ARRAY['anonymous']);

DO $$
DECLARE n INT;
BEGIN
  ASSERT (SELECT count(*) FROM metadata.dashboard_roles WHERE dashboard_id IN (SELECT id FROM ids)) = 3,
    'set_dashboard_roles should have written three rows';

  -- default mode wrote through the legacy table
  ASSERT EXISTS (SELECT 1 FROM metadata.dashboard_role_defaults drd JOIN metadata.roles r ON r.id = drd.role_id
                 WHERE r.role_key = 'dashtest_other' AND drd.priority = 5
                   AND drd.dashboard_id = (SELECT id FROM ids WHERE k='def')), 'default write-through reached the legacy table';

  -- show mode never deletes default rows, and a role may hold a show row and a default row together
  PERFORM public.set_dashboard_roles((SELECT id FROM ids WHERE k='def'), ARRAY['dashtest_other', 'dashtest_staff']);
  ASSERT EXISTS (SELECT 1 FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
                 WHERE r.role_key = 'dashtest_other' AND dr.mode = 'default'
                   AND dr.dashboard_id = (SELECT id FROM ids WHERE k='def')), 'show write left the default row alone';
  ASSERT EXISTS (SELECT 1 FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
                 WHERE r.role_key = 'dashtest_staff' AND dr.mode = 'show'
                   AND dr.dashboard_id = (SELECT id FROM ids WHERE k='def')), 'show row written for the other role';
  ASSERT EXISTS (SELECT 1 FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
                 WHERE r.role_key = 'dashtest_other' AND dr.mode = 'show'
                   AND dr.dashboard_id = (SELECT id FROM ids WHERE k='def')), 'a role with a default also gets its show row';
  PERFORM public.set_dashboard_roles((SELECT id FROM ids WHERE k='def'), NULL, 'show');
  ASSERT EXISTS (SELECT 1 FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
                 WHERE r.role_key = 'dashtest_other' AND dr.mode = 'default'
                   AND dr.dashboard_id = (SELECT id FROM ids WHERE k='def')), 'clearing show rows keeps the default row';
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.dashboard_roles
                     WHERE dashboard_id = (SELECT id FROM ids WHERE k='def') AND mode = 'show'), 'show rows cleared';

  -- show, then default, then clear default: the show grant survives (nothing folds a show row into a default)
  PERFORM public.set_dashboard_roles((SELECT id FROM ids WHERE k='pub'), ARRAY['dashtest_staff']);
  PERFORM public.set_dashboard_roles((SELECT id FROM ids WHERE k='pub'), ARRAY['dashtest_staff'], 'default', 5);
  ASSERT EXISTS (SELECT 1 FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
                 WHERE r.role_key = 'dashtest_staff' AND dr.mode = 'show'
                   AND dr.dashboard_id = (SELECT id FROM ids WHERE k='pub')), 'default write kept the show row';
  ASSERT EXISTS (SELECT 1 FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
                 WHERE r.role_key = 'dashtest_staff' AND dr.mode = 'default'
                   AND dr.dashboard_id = (SELECT id FROM ids WHERE k='pub')), 'default row written';
  PERFORM public.set_dashboard_roles((SELECT id FROM ids WHERE k='pub'), NULL, 'default');
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.dashboard_role_defaults drd JOIN metadata.roles r ON r.id = drd.role_id
                     WHERE r.role_key = 'dashtest_staff'), 'clearing default cleared the legacy row';
  ASSERT EXISTS (SELECT 1 FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
                 WHERE r.role_key = 'dashtest_staff' AND dr.mode = 'show'
                   AND dr.dashboard_id = (SELECT id FROM ids WHERE k='pub')), 'show grant survives moving and clearing the default';
  PERFORM public.set_dashboard_roles((SELECT id FROM ids WHERE k='pub'), NULL, 'show');

  -- admin sees everything, including non-public and other people's dashboards, in RPC and RLS
  SELECT count(*) INTO n FROM public.get_dashboards() WHERE id IN (SELECT id FROM ids);
  ASSERT n = 4, 'admin sees all four, got ' || n;
  SELECT count(*) INTO n FROM metadata.dashboards WHERE id IN (SELECT id FROM ids);
  ASSERT n = 4, 'admin RLS sees all four, got ' || n;
  ASSERT (SELECT count(*) FROM metadata.dashboard_roles) >= 3, 'admin reads dashboard_roles';

  -- validation
  BEGIN
    PERFORM public.set_dashboard_roles((SELECT id FROM ids WHERE k='pub'), ARRAY['no_such_role']);
    ASSERT false, 'unknown role key must raise';
  EXCEPTION WHEN sqlstate '22023' THEN NULL; END;
  BEGIN
    PERFORM public.set_dashboard_roles(-1, ARRAY['dashtest_staff']);
    ASSERT false, 'unknown dashboard must raise';
  EXCEPTION WHEN sqlstate '22023' THEN NULL; END;
  BEGIN
    PERFORM public.set_dashboard_roles((SELECT id FROM ids WHERE k='pub'), ARRAY['dashtest_staff'], 'bogus');
    ASSERT false, 'bad mode must raise';
  EXCEPTION WHEN sqlstate '22023' THEN NULL; END;
END $$;

-- Member of the show role
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated","roles":["user","dashtest_staff"]}', true);
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.get_dashboards() WHERE id IN (SELECT id FROM ids)) = 2,
    'staff member sees public and staff only (not private, not the other role''s default)';
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='staff')) IS NOT NULL, 'staff member gets the staff dashboard';
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='priv')) IS NULL, 'non-public dashboard hidden from non-creator';
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='def')) IS NULL, 'a default row for another role grants nothing here';
  ASSERT (SELECT count(*) FROM metadata.dashboard_widgets WHERE dashboard_id = (SELECT id FROM ids WHERE k='staff')) = 1,
    'widgets follow the dashboard through RLS';
  ASSERT (SELECT count(*) FROM metadata.dashboard_roles) = 0, 'dashboard_roles is admin-read only';
  BEGIN
    PERFORM public.set_dashboard_roles((SELECT id FROM ids WHERE k='pub'), ARRAY['dashtest_staff']);
    ASSERT false, 'non-admin set_dashboard_roles must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;

-- Impersonation: same user id, JWT roles narrowed to plain user -> the staff dashboard disappears
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated","roles":["user"]}', true);
DO $$
BEGIN
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='staff')) IS NULL, 'plain user cannot see the non-public dashboard';
  ASSERT (SELECT count(*) FROM metadata.dashboards WHERE id = (SELECT id FROM ids WHERE k='staff')) = 0, 'RLS hides it too';
  ASSERT (SELECT count(*) FROM metadata.dashboards WHERE id = (SELECT id FROM ids WHERE k='pub')) = 1, 'public one stays visible';
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='priv')) IS NULL, 'the anonymous row does not reach signed-in users';
END $$;

-- Role with a default dashboard: the default row grants visibility and tier 2 lands on it
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated","roles":["user","dashtest_other"]}', true);
DO $$
BEGIN
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='def')) IS NOT NULL, 'a default row grants visibility';
  ASSERT public.get_user_default_dashboard() = (SELECT id FROM ids WHERE k='def'), 'role default wins (tier 2)';
  ASSERT (SELECT is_role_default FROM public.get_dashboards() WHERE id = (SELECT id FROM ids WHERE k='def')),
    'is_role_default flags it';
END $$;

-- Fallback tier: no preference, no role default, no is_default dashboard -> first visible by sort_order, id
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated","roles":["dashtest_none"]}', true);
DO $$
BEGIN
  ASSERT public.get_user_default_dashboard() IS NOT NULL, 'fallback tier returns a dashboard';
  ASSERT public.get_user_default_dashboard() =
    (SELECT id FROM metadata.dashboards ORDER BY sort_order, id LIMIT 1), 'fallback is the first visible dashboard';
END $$;

-- Creator keeps access to a non-public dashboard
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated","roles":["user"]}', true);
DO $$
BEGIN
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='priv')) IS NOT NULL, 'creator sees own non-public dashboard';
END $$;

-- Anonymous: the anonymous row grants priv; nothing else non-public
RESET ROLE;
SET LOCAL ROLE web_anon;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='staff')) IS NULL, 'anonymous cannot see the non-public dashboard';
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='pub')) IS NOT NULL, 'anonymous sees the public one';
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='priv')) IS NOT NULL, 'anonymous row grants signed-out visitors';
  ASSERT (SELECT count(*) FROM metadata.dashboard_widgets
          WHERE dashboard_id = (SELECT id FROM ids WHERE k='staff')) = 0, 'anonymous sees no widgets of the non-public one';
END $$;

-- Clearing default mode through the RPC clears the legacy table too (as admin)
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e3","role":"authenticated","roles":["admin"]}', true);
SELECT public.set_dashboard_roles((SELECT id FROM ids WHERE k='def'), NULL, 'default');
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.dashboard_role_defaults
                     WHERE dashboard_id = (SELECT id FROM ids WHERE k='def')), 'clearing default cleared the legacy table';
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.dashboard_roles
                     WHERE dashboard_id = (SELECT id FROM ids WHERE k='def') AND mode = 'default'), 'and the new table';
END $$;

-- Legacy table sync (superuser)
RESET ROLE;
RESET SESSION AUTHORIZATION;
INSERT INTO metadata.dashboard_role_defaults (role_id, dashboard_id, priority)
SELECT id, (SELECT id FROM ids WHERE k='pub'), 7 FROM metadata.roles WHERE role_key = 'dashtest_staff'
ON CONFLICT (role_id) DO UPDATE SET dashboard_id = EXCLUDED.dashboard_id, priority = EXCLUDED.priority;
DO $$
BEGIN
  ASSERT EXISTS (SELECT 1 FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
                 WHERE r.role_key = 'dashtest_staff' AND dr.mode = 'default' AND dr.priority = 7
                   AND dr.dashboard_id = (SELECT id FROM ids WHERE k='pub')), 'legacy insert copied';
END $$;
DELETE FROM metadata.dashboard_role_defaults
 WHERE role_id = (SELECT id FROM metadata.roles WHERE role_key = 'dashtest_staff');
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
                     WHERE r.role_key = 'dashtest_staff' AND dr.mode = 'default'), 'legacy delete removed the default row';
  -- the show row for that role survived (different mode)
  ASSERT EXISTS (SELECT 1 FROM metadata.dashboard_roles dr JOIN metadata.roles r ON r.id = dr.role_id
                 WHERE r.role_key = 'dashtest_staff' AND dr.mode = 'show'), 'show row untouched by legacy sync';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: dashboard role visibility rule, RPCs, RLS, set_dashboard_roles and legacy sync behave as designed"
else
  echo "FAIL: dashboard role visibility is incomplete (see error above)"
  exit 1
fi
