#!/bin/bash
# =============================================================================
# Functional Test: v0-80-2 user management always admits is_admin()
# =============================================================================
# has_permission() has no admin bypass, so an admin whose civic_os_users_private grants were removed
# (for example by revoking them from the `user` role while admin held them only through it) used to
# be locked out of User Management. This test strips every civic_os_users_private permission from
# the admin role inside a transaction, then calls the user management RPCs as an admin and as an
# editor, exercising them the way PostgREST does (authenticator -> authenticated, JWT in
# request.jwt.claims). Asserts:
#   admin without the permission: update_user_info, retry_user_provisioning,
#     create_provisioned_user, bulk_provision_users pass their guard; the notification preference
#     RPCs do not deny; the user_roles manager policy shows every user's roles
#   editor without the permission: every one of them is still denied
# Everything runs in one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-80-2-admin-user-management-escape-valve-test.sh
#
# Environment overrides (the connecting user must be a superuser, to create fixtures):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

-- Fixtures: a target user, the acting admin (d2) and editor (d3), which user_provisioning.requested_by
-- references, plus a role row to read through the user_roles policy
INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'escape valve target'),
  ('00000000-0000-0000-0000-0000000000d2', 'escape valve admin'),
  ('00000000-0000-0000-0000-0000000000d3', 'escape valve editor');
INSERT INTO metadata.civic_os_users_private (id, display_name, email, first_name, last_name)
VALUES ('00000000-0000-0000-0000-0000000000d1', 'Escape Target', 'ev@example.invalid', 'Escape', 'Target');
INSERT INTO metadata.user_roles (user_id, role_id)
SELECT '00000000-0000-0000-0000-0000000000d1', id FROM metadata.roles WHERE role_key = 'user'
ON CONFLICT DO NOTHING;

-- The failure state: admin holds no civic_os_users_private permission at all
DELETE FROM metadata.permission_roles
 WHERE role_id = (SELECT id FROM metadata.roles WHERE role_key = 'admin')
   AND permission_id IN (SELECT id FROM metadata.permissions WHERE table_name = 'civic_os_users_private');

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM metadata.permission_roles pr
    JOIN metadata.permissions p ON p.id = pr.permission_id
    WHERE pr.role_id = (SELECT id FROM metadata.roles WHERE role_key = 'admin')
      AND p.table_name = 'civic_os_users_private'
  ), 'fixture: admin must hold no civic_os_users_private permission';
END $$;

SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;

-- ===========================================================================
-- Admin without civic_os_users_private grants
-- ===========================================================================
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated","roles":["admin"]}', true);

DO $$
DECLARE
  r JSON;
BEGIN
  r := public.update_user_info('00000000-0000-0000-0000-0000000000d1', 'Escape', 'Renamed', NULL);
  ASSERT (r->>'success')::boolean, 'update_user_info: admin without the permission must succeed, got ' || r::text;

  r := public.retry_user_provisioning(-1);
  ASSERT r->>'error' = 'Provisioning record not found',
    'retry_user_provisioning: admin must pass the guard, got ' || r::text;

  r := public.create_provisioned_user('ev-admin@example.invalid', 'Ev', 'Admin');
  ASSERT (r->>'success')::boolean, 'create_provisioned_user: admin must succeed, got ' || r::text;

  r := public.bulk_provision_users('[{"email":"ev-bulk@example.invalid","first_name":"Ev","last_name":"Bulk"}]'::json);
  ASSERT (r->>'success')::boolean, 'bulk_provision_users: admin must succeed, got ' || r::text;

  PERFORM * FROM public.admin_get_user_notification_preferences('00000000-0000-0000-0000-0000000000d1');

  r := public.admin_update_notification_preference('00000000-0000-0000-0000-0000000000d1', 'email', true, false);
  ASSERT r->>'error' IS DISTINCT FROM 'Permission denied',
    'admin_update_notification_preference: admin must pass the guard, got ' || r::text;

  ASSERT (SELECT count(*) FROM metadata.user_roles
          WHERE user_id = '00000000-0000-0000-0000-0000000000d1') >= 1,
    'user_roles: admin must see every user''s roles through the manager policy';
END $$;

-- ===========================================================================
-- Editor without civic_os_users_private:update or :create stays denied
-- ===========================================================================
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated","roles":["editor"]}', true);

DO $$
DECLARE
  r JSON;
BEGIN
  r := public.update_user_info('00000000-0000-0000-0000-0000000000d1', 'No', 'Access', NULL);
  ASSERT r->>'error' = 'Permission denied', 'update_user_info: editor must be denied, got ' || r::text;

  r := public.retry_user_provisioning(-1);
  ASSERT r->>'error' = 'Permission denied', 'retry_user_provisioning: editor must be denied, got ' || r::text;

  r := public.create_provisioned_user('ev-editor@example.invalid', 'Ev', 'Editor');
  ASSERT r->>'error' = 'Permission denied', 'create_provisioned_user: editor must be denied, got ' || r::text;

  r := public.bulk_provision_users('[]'::json);
  ASSERT r->>'error' = 'Permission denied', 'bulk_provision_users: editor must be denied, got ' || r::text;

  r := public.admin_update_notification_preference('00000000-0000-0000-0000-0000000000d1', 'email', true, false);
  ASSERT r->>'error' = 'Permission denied', 'admin_update_notification_preference: editor must be denied, got ' || r::text;

  BEGIN
    PERFORM * FROM public.admin_get_user_notification_preferences('00000000-0000-0000-0000-0000000000d1');
    ASSERT false, 'admin_get_user_notification_preferences: editor must be denied';
  EXCEPTION WHEN raise_exception THEN
    NULL;
  END;
END $$;

ROLLBACK;
SQL
then
  echo "PASS: user management RPCs and the user_roles policy admit is_admin() without grants and still deny other roles"
else
  echo "FAIL: admin escape valve for user management is incomplete (see error above)"
  exit 1
fi
