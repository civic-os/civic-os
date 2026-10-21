#!/bin/bash
# =============================================================================
# Functional Test: v0-76-9 restore security_invoker on public views
# =============================================================================
# public.notification_preferences and public.entity_notes are documented as relying on the
# base tables' RLS. A view without security_invoker runs as its (superuser) owner and bypasses
# that RLS. v0-70-0 undid v0-50-2's fix via CREATE OR REPLACE VIEW, and entity_notes never had
# the option, so this test asserts the observable behavior through the views as the
# `authenticated` role:
#   - a user without {entity}:notes:read sees no notes; with it, sees them
#   - a user without {entity}:notes:create cannot insert notes through the view
#   - a user sees only their own notification_preferences rows
#
# Everything runs in one transaction that is rolled back, so no data is left behind.
#
# Usage:
#   ./tests/functional/v0-76-9-view-security-invoker-test.sh
#
# Environment overrides (defaults match the local docker-compose stack):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'invoker test user A'),
  ('00000000-0000-0000-0000-0000000000c2', 'invoker test user B');

INSERT INTO metadata.permissions (table_name, permission)
VALUES ('invoker_test_ent:notes', 'read'), ('invoker_test_ent:notes', 'create')
ON CONFLICT DO NOTHING;

INSERT INTO metadata.permission_roles (role_id, permission_id)
SELECT (SELECT id FROM metadata.roles WHERE role_key = 'editor'), p.id
FROM metadata.permissions p
WHERE p.table_name = 'invoker_test_ent:notes'
ON CONFLICT DO NOTHING;

INSERT INTO metadata.entity_notes (entity_type, entity_id, author_id, content, note_type, is_internal)
VALUES ('invoker_test_ent', '1', '00000000-0000-0000-0000-0000000000c2', 'secret', 'note', true);

INSERT INTO metadata.notification_preferences (user_id, channel, enabled, email_address)
VALUES ('00000000-0000-0000-0000-0000000000c2', 'email', true, 'b@example.invalid');

SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n int;
BEGIN
  -- User A with only the default `user` role
  PERFORM set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","roles":["user"]}', true);

  SELECT count(*) INTO n FROM public.entity_notes;
  ASSERT n = 0, format('public.entity_notes leaked %s note(s) to a user without notes:read', n);

  SELECT count(*) INTO n FROM public.notification_preferences;
  ASSERT n = 0, format('public.notification_preferences leaked %s row(s) of another user', n);

  BEGIN
    INSERT INTO public.entity_notes (entity_type, entity_id, author_id, content, note_type)
    VALUES ('invoker_test_ent', '1', '00000000-0000-0000-0000-0000000000c1', 'x', 'note');
    RAISE EXCEPTION 'public.entity_notes accepted an INSERT from a user without notes:create';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;  -- expected: row-level security violation
  END;

  -- User A as editor, who holds notes:read and notes:create
  PERFORM set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","roles":["editor"]}', true);

  SELECT count(*) INTO n FROM public.entity_notes;
  ASSERT n = 1, format('editor with notes:read should see 1 note via the view, saw %s', n);

  INSERT INTO public.entity_notes (entity_type, entity_id, author_id, content, note_type)
  VALUES ('invoker_test_ent', '1', '00000000-0000-0000-0000-0000000000c1', 'mine', 'note');

  -- User B sees their own preferences
  PERFORM set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated","roles":["user"]}', true);

  SELECT count(*) INTO n FROM public.notification_preferences;
  ASSERT n = 1, format('owner should see their 1 notification_preferences row, saw %s', n);
END $$;

ROLLBACK;
SQL
then
  echo "PASS: notification_preferences and entity_notes views enforce RLS (security_invoker)"
else
  echo "FAIL: a view bypassed row-level security (see error above)"
  exit 1
fi
