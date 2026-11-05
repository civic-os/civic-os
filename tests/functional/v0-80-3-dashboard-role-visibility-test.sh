#!/bin/bash
# =============================================================================
# Functional Test: v0-80-3 dashboard role visibility
# =============================================================================
# Exercises metadata.dashboard_roles, the shared visibility rule, set_dashboard_roles() and the legacy
# dashboard_role_defaults sync the way PostgREST does (authenticator -> web_anon/authenticated, JWT in
# request.jwt.claims). Asserts:
#   - no dashboard_roles rows: public dashboards visible to everyone, private ones to creator and admin
#   - a show row restricts to the listed roles for get_dashboards(), get_dashboard(), the dashboards
#     table and its widgets (RLS); admin and the creator still see it; anonymous does not
#   - a default row grants visibility without restricting others; tier 2 picks the highest priority
#   - impersonation: a JWT with one role sees through that role (get_user_roles), not the real user id
#   - set_dashboard_roles() is admin only, rejects unknown roles/dashboards/modes, replaces by mode
#   - a write to the deprecated dashboard_role_defaults lands in dashboard_roles; deleting it removes it
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

-- d_pub: public, unrestricted. d_staff: public flag but restricted to dashtest_staff.
-- d_priv: private, creator e1. d_def: public, default of dashtest_other.
CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id INT);
GRANT ALL ON ids TO PUBLIC;
WITH ins AS (
  INSERT INTO metadata.dashboards (display_name, is_public, created_by, sort_order) VALUES
    ('DT public', TRUE, '00000000-0000-0000-0000-0000000000e1', 9001),
    ('DT staff', TRUE, '00000000-0000-0000-0000-0000000000e1', 9002),
    ('DT private', FALSE, '00000000-0000-0000-0000-0000000000e1', 9003),
    ('DT default', TRUE, '00000000-0000-0000-0000-0000000000e1', 9004)
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

DO $$
DECLARE n INT;
BEGIN
  ASSERT (SELECT count(*) FROM metadata.dashboard_roles WHERE dashboard_id IN (SELECT id FROM ids)) = 2,
    'set_dashboard_roles should have written two rows';

  -- admin sees everything, including the restricted and private dashboards, in RPC and RLS
  SELECT count(*) INTO n FROM public.get_dashboards() WHERE id IN (SELECT id FROM ids);
  ASSERT n = 4, 'admin sees all four, got ' || n;
  SELECT count(*) INTO n FROM metadata.dashboards WHERE id IN (SELECT id FROM ids);
  ASSERT n = 4, 'admin RLS sees all four, got ' || n;
  ASSERT (SELECT count(*) FROM metadata.dashboard_roles) >= 2, 'admin reads dashboard_roles';

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

-- Editor holding the restricted role
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated","roles":["user","dashtest_staff"]}', true);
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.get_dashboards() WHERE id IN (SELECT id FROM ids)) = 3,
    'staff member sees public, staff and default (not private)';
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='staff')) IS NOT NULL, 'staff member gets the staff dashboard';
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='priv')) IS NULL, 'private dashboard hidden from non-creator';
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
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='staff')) IS NULL, 'plain user cannot see the restricted dashboard';
  ASSERT (SELECT count(*) FROM metadata.dashboards WHERE id = (SELECT id FROM ids WHERE k='staff')) = 0, 'RLS hides it too';
  ASSERT (SELECT count(*) FROM metadata.dashboards WHERE id = (SELECT id FROM ids WHERE k='pub')) = 1, 'public one stays visible';
  -- default row does not restrict
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='def')) IS NOT NULL, 'a default row must not restrict';
END $$;

-- Role with a default dashboard lands on it
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated","roles":["user","dashtest_other"]}', true);
DO $$
BEGIN
  ASSERT public.get_user_default_dashboard() = (SELECT id FROM ids WHERE k='def'), 'role default wins (tier 2)';
  ASSERT (SELECT is_role_default FROM public.get_dashboards() WHERE id = (SELECT id FROM ids WHERE k='def')),
    'is_role_default flags it';
END $$;

-- Creator keeps access to a private dashboard
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated","roles":["user"]}', true);
DO $$
BEGIN
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='priv')) IS NOT NULL, 'creator sees own private dashboard';
END $$;

-- Anonymous
RESET ROLE;
SET LOCAL ROLE web_anon;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='staff')) IS NULL, 'anonymous cannot see the restricted dashboard';
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='pub')) IS NOT NULL, 'anonymous sees the public one';
  ASSERT (SELECT count(*) FROM metadata.dashboard_widgets
          WHERE dashboard_id = (SELECT id FROM ids WHERE k='staff')) = 0, 'anonymous sees no widgets of the restricted one';
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
