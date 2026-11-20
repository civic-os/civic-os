-- Revert civic_os:v0-85-0-tree-parent-guard from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Drops every tree_parent_guard trigger (enable_tree_parent_guard() and register_dimension() installed
-- them on instance tables), the functions and the constraint message, and restores the v0.9.0
-- constraint_messages view.

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT t.tgname, t.tgrelid::regclass AS rel
    FROM pg_trigger t
    WHERE t.tgfoid = 'metadata.tree_parent_guard()'::regprocedure
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', r.tgname, r.rel);
  END LOOP;
END $$;

DROP FUNCTION public.enable_tree_parent_guard(NAME, NAME, NAME);
DROP FUNCTION metadata._install_tree_parent_guard(REGCLASS, NAME, NAME);
DROP FUNCTION metadata._tree_cycle_rows(REGCLASS, NAME, NAME, INT);
DROP FUNCTION metadata.tree_parent_guard();

DELETE FROM metadata.constraint_messages WHERE constraint_name = 'tree_parent_cycle';

CREATE OR REPLACE VIEW public.constraint_messages AS
SELECT
  constraint_name,
  table_name,
  column_name,
  error_message
FROM metadata.constraint_messages;

COMMENT ON VIEW public.constraint_messages IS
  'User-friendly error messages for database constraint violations. Read-only view of metadata.constraint_messages. Used by frontend ErrorService to display friendly messages instead of PostgreSQL error codes.';

GRANT SELECT ON public.constraint_messages TO web_anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
