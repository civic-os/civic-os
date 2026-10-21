#!/bin/bash
# =============================================================================
# Functional Test: v0-76-10 civic_os_users keeps security_invoker
# =============================================================================
# v0-65-2 re-created public.civic_os_users with CREATE OR REPLACE VIEW, which reset the
# security_invoker option set by v0-55-2 and v0-65-0. The view masks private columns with CASE,
# so the regression was not directly exploitable, which is exactly why it went unnoticed.
# This test asserts both layers, as the `authenticated` / `web_anon` roles:
#   - the view option is set (RLS on civic_os_users_private is the primary barrier)
#   - the observable masking still holds: another user's email/phone/names are NULL, a user sees
#     their own, and anonymous callers see display names only
# Runs in one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-76-10-civic-os-users-security-invoker-test.sh
#
# Environment overrides:
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'civic_os_users'
      AND c.reloptions @> ARRAY['security_invoker=true']
  ), 'public.civic_os_users lost security_invoker (CREATE OR REPLACE VIEW resets view options)';
END $$;

INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'invoker test A'),
  ('00000000-0000-0000-0000-0000000000f2', 'invoker test B');
INSERT INTO metadata.civic_os_users_private (id, display_name, email, first_name, last_name, phone) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'Invoker A', 'a@example.invalid', 'Invoker', 'A', '5551230001'),
  ('00000000-0000-0000-0000-0000000000f2', 'Invoker B', 'b@example.invalid', 'Invoker', 'B', '5551230002');

-- Plain user A: sees own private data, not B's, but still sees B's public display name
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated","roles":["user"]}', true);

DO $$
DECLARE
  own public.civic_os_users;
  other public.civic_os_users;
BEGIN
  SELECT * INTO own FROM public.civic_os_users WHERE id = '00000000-0000-0000-0000-0000000000f1';
  SELECT * INTO other FROM public.civic_os_users WHERE id = '00000000-0000-0000-0000-0000000000f2';
  ASSERT own.email = 'a@example.invalid', 'a user must see their own email';
  ASSERT other.display_name = 'invoker test B', 'the public display name must stay visible';
  ASSERT other.email IS NULL AND other.phone IS NULL AND other.first_name IS NULL
         AND other.last_name IS NULL AND other.full_name IS NULL,
    'another user''s private columns must be NULL';
END $$;

-- Anonymous: display names only
RESET ROLE;
SET LOCAL ROLE web_anon;
SELECT set_config('request.jwt.claims', '{}', true);

DO $$
DECLARE
  anon public.civic_os_users;
BEGIN
  SELECT * INTO anon FROM public.civic_os_users WHERE id = '00000000-0000-0000-0000-0000000000f2';
  ASSERT anon.display_name = 'invoker test B', 'anonymous callers must still see display names';
  ASSERT anon.email IS NULL AND anon.phone IS NULL, 'anonymous callers must not see private columns';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: civic_os_users keeps security_invoker and masks private columns"
else
  echo "FAIL: civic_os_users regressed (see error above)"
  exit 1
fi
