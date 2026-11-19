#!/bin/bash
# =============================================================================
# Functional Test: v0-82-0 unlisted dashboards (metadata.dashboards.show_in_selector)
# =============================================================================
# show_in_selector only decides whether the dashboard selector lists a dashboard; it never changes who can
# open it. Runs the way PostgREST does (authenticator -> web_anon/authenticated, JWT in request.jwt.claims).
# Asserts:
#   - the column defaults to true, and get_dashboards() / get_dashboard() return it
#   - get_dashboards() still returns unlisted dashboards the caller can see (the selector filters)
#   - listing is not access: an unlisted public dashboard opens for everyone (RPC, dashboards RLS, widgets
#     RLS, anonymous too), an unlisted non-public one only for a role with a dashboard_roles row
#   - get_user_default_dashboard(): tiers 1-3 (preference, role default, is_default) return an unlisted
#     dashboard; tier 4 prefers a listed dashboard over an unlisted one with a lower sort_order, and falls
#     back to an unlisted one when nothing listed is visible
#   - narrowing the JWT roles (as impersonation does) changes what is visible and where the user lands
# Everything runs in one transaction that is rolled back.
#
# Usage: ./tests/functional/v0-82-0-dashboard-show-in-selector-test.sh
# Environment: DATABASE_URL (superuser, to create fixtures)
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'unlisted creator'),
  ('00000000-0000-0000-0000-0000000000f2', 'unlisted viewer'),
  ('00000000-0000-0000-0000-0000000000f3', 'unlisted pref user');

INSERT INTO metadata.roles (role_key, display_name) VALUES ('unlisted_lane', 'Unlisted test lane');

-- Only the fixtures may be visible to the test users, so every tier is observable: the instance's own
-- dashboards become private to nobody (no creator, not public, no grants, not the system default).
DELETE FROM metadata.dashboard_role_defaults;
DELETE FROM metadata.dashboard_roles;
UPDATE metadata.dashboards SET is_public = FALSE, is_default = FALSE, created_by = NULL;

-- lst: listed, public. unl: unlisted, public, sorted before lst. lane: unlisted, non-public, shown to
-- unlisted_lane, sorted first of all. lst is inserted without the column to exercise the default.
CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id INT);
GRANT ALL ON ids TO PUBLIC;
WITH ins AS (
  INSERT INTO metadata.dashboards (display_name, is_public, created_by, sort_order) VALUES
    ('UT listed', TRUE, '00000000-0000-0000-0000-0000000000f1', 9002)
  RETURNING id)
INSERT INTO ids SELECT 'lst', id FROM ins;
WITH ins AS (
  INSERT INTO metadata.dashboards (display_name, is_public, created_by, sort_order, show_in_selector) VALUES
    ('UT unlisted', TRUE, '00000000-0000-0000-0000-0000000000f1', 9001, FALSE),
    ('UT lane', FALSE, '00000000-0000-0000-0000-0000000000f1', 9000, FALSE)
  RETURNING id, display_name)
INSERT INTO ids SELECT CASE display_name WHEN 'UT unlisted' THEN 'unl' ELSE 'lane' END, id FROM ins;

INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, config, sort_order)
SELECT id, 'markdown', '{"content":"x"}', 1 FROM ids;

INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode)
SELECT (SELECT id FROM ids WHERE k='lane'), id, 'show' FROM metadata.roles WHERE role_key = 'unlisted_lane';

DO $$
BEGIN
  ASSERT (SELECT show_in_selector FROM metadata.dashboards WHERE id = (SELECT id FROM ids WHERE k='lst')),
    'show_in_selector defaults to true';
END $$;

-- ---------------------------------------------------------------------------
-- Signed-in user without the lane role
-- ---------------------------------------------------------------------------
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["user"]}', true);

DO $$
DECLARE j JSON;
BEGIN
  -- get_dashboards() returns listed and unlisted dashboards alike, with the flag
  ASSERT (SELECT show_in_selector FROM public.get_dashboards() WHERE id = (SELECT id FROM ids WHERE k='lst')) IS TRUE,
    'listed dashboard returned with show_in_selector = true';
  ASSERT (SELECT show_in_selector FROM public.get_dashboards() WHERE id = (SELECT id FROM ids WHERE k='unl')) IS FALSE,
    'unlisted public dashboard still returned, with show_in_selector = false';
  ASSERT NOT EXISTS (SELECT 1 FROM public.get_dashboards() WHERE id = (SELECT id FROM ids WHERE k='lane')),
    'unlisted non-public dashboard without a grant is not returned';

  -- Listing is not access: the unlisted public dashboard opens through every path
  j := public.get_dashboard((SELECT id FROM ids WHERE k='unl'));
  ASSERT j IS NOT NULL, 'get_dashboard opens an unlisted public dashboard';
  ASSERT (j->>'show_in_selector')::BOOLEAN IS FALSE, 'get_dashboard returns show_in_selector = false';
  ASSERT json_array_length(j->'widgets') = 1, 'get_dashboard returns the unlisted dashboard''s widgets';
  ASSERT (public.get_dashboard((SELECT id FROM ids WHERE k='lst'))->>'show_in_selector')::BOOLEAN IS TRUE,
    'get_dashboard returns show_in_selector = true for a listed dashboard';
  ASSERT EXISTS (SELECT 1 FROM metadata.dashboards WHERE id = (SELECT id FROM ids WHERE k='unl')),
    'dashboards RLS shows the unlisted public dashboard';
  ASSERT (SELECT count(*) FROM metadata.dashboard_widgets WHERE dashboard_id = (SELECT id FROM ids WHERE k='unl')) = 1,
    'widgets RLS shows the unlisted public dashboard''s widgets';

  -- and still denies a dashboard the caller cannot see
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='lane')) IS NULL,
    'get_dashboard denies an unlisted non-public dashboard without a grant';
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.dashboards WHERE id = (SELECT id FROM ids WHERE k='lane')),
    'dashboards RLS hides the unlisted non-public dashboard';
  ASSERT (SELECT count(*) FROM metadata.dashboard_widgets WHERE dashboard_id = (SELECT id FROM ids WHERE k='lane')) = 0,
    'widgets RLS hides its widgets';

  -- Tier 4 prefers the listed dashboard although the unlisted one sorts first
  ASSERT public.get_user_default_dashboard() = (SELECT id FROM ids WHERE k='lst'),
    'tier 4 lands on the listed dashboard, not the unlisted one with a lower sort_order';
END $$;

-- ---------------------------------------------------------------------------
-- Same user with the JWT roles narrowed to the lane role (as impersonation does)
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["unlisted_lane"]}', true);

DO $$
DECLARE j JSON;
BEGIN
  ASSERT (SELECT show_in_selector FROM public.get_dashboards() WHERE id = (SELECT id FROM ids WHERE k='lane')) IS FALSE,
    'the show row grants the unlisted non-public dashboard, still flagged unlisted';
  j := public.get_dashboard((SELECT id FROM ids WHERE k='lane'));
  ASSERT j IS NOT NULL AND (j->>'show_in_selector')::BOOLEAN IS FALSE, 'the lane role opens it';
  ASSERT (SELECT count(*) FROM metadata.dashboard_widgets WHERE dashboard_id = (SELECT id FROM ids WHERE k='lane')) = 1,
    'widgets RLS follows the grant';
  -- Tier 4 still prefers the listed one over the visible unlisted ones
  ASSERT public.get_user_default_dashboard() = (SELECT id FROM ids WHERE k='lst'),
    'tier 4 prefers listed with more unlisted dashboards visible';
END $$;

-- ---------------------------------------------------------------------------
-- Tier 4 falls back to an unlisted dashboard when nothing listed is visible
-- ---------------------------------------------------------------------------
RESET ROLE;
RESET SESSION AUTHORIZATION;
UPDATE metadata.dashboards SET show_in_selector = FALSE WHERE id = (SELECT id FROM ids WHERE k='lst');
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["user"]}', true);
DO $$
BEGIN
  ASSERT public.get_user_default_dashboard() = (SELECT id FROM ids WHERE k='unl'),
    'tier 4 falls back to the first visible unlisted dashboard';
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;
UPDATE metadata.dashboards SET show_in_selector = TRUE WHERE id = (SELECT id FROM ids WHERE k='lst');

-- ---------------------------------------------------------------------------
-- Tiers 1-3 return an unlisted dashboard
-- ---------------------------------------------------------------------------
-- Tier 2: an unlisted role default (through the legacy table, which syncs into dashboard_roles)
INSERT INTO metadata.dashboard_role_defaults (role_id, dashboard_id, priority)
SELECT id, (SELECT id FROM ids WHERE k='unl'), 5 FROM metadata.roles WHERE role_key = 'unlisted_lane';
-- Tier 1: an unlisted saved preference for f3
INSERT INTO metadata.user_dashboard_preferences (user_id, default_dashboard_id)
VALUES ('00000000-0000-0000-0000-0000000000f3', (SELECT id FROM ids WHERE k='unl'));

SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["unlisted_lane"]}', true);
DO $$
BEGIN
  ASSERT public.get_user_default_dashboard() = (SELECT id FROM ids WHERE k='unl'),
    'tier 2 lands on an unlisted role default';
END $$;

SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["user"]}', true);
DO $$
BEGIN
  ASSERT public.get_user_default_dashboard() = (SELECT id FROM ids WHERE k='lst'),
    'narrowed back to user: no role default, tier 4 again';
END $$;

SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f3","role":"authenticated","roles":["user"]}', true);
DO $$
BEGIN
  ASSERT public.get_user_default_dashboard() = (SELECT id FROM ids WHERE k='unl'),
    'tier 1 lands on an unlisted saved preference';
END $$;

-- Tier 3: an unlisted system default
RESET ROLE;
RESET SESSION AUTHORIZATION;
UPDATE metadata.dashboards SET is_default = TRUE WHERE id = (SELECT id FROM ids WHERE k='unl');
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated","roles":["user"]}', true);
DO $$
BEGIN
  ASSERT public.get_user_default_dashboard() = (SELECT id FROM ids WHERE k='unl'),
    'tier 3 lands on an unlisted system default';
END $$;

-- ---------------------------------------------------------------------------
-- Anonymous visitors
-- ---------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE web_anon;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  ASSERT (SELECT show_in_selector FROM public.get_dashboards() WHERE id = (SELECT id FROM ids WHERE k='unl')) IS FALSE,
    'anonymous get_dashboards returns the unlisted public dashboard, flagged';
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='unl')) IS NOT NULL, 'anonymous opens the unlisted public dashboard';
  ASSERT (SELECT count(*) FROM metadata.dashboard_widgets WHERE dashboard_id = (SELECT id FROM ids WHERE k='unl')) = 1,
    'anonymous reads its widgets';
  ASSERT public.get_dashboard((SELECT id FROM ids WHERE k='lane')) IS NULL, 'anonymous cannot open the non-public one';
  ASSERT public.get_user_default_dashboard() = (SELECT id FROM ids WHERE k='unl'), 'anonymous lands on the unlisted system default';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: show_in_selector lists or unlists dashboards without changing who can open them, and landing tiers honor it"
else
  echo "FAIL: unlisted dashboards are incomplete (see error above)"
  exit 1
fi
