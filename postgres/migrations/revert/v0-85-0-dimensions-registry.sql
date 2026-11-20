-- Revert civic_os:v0-85-0-dimensions-registry from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Drops the guard and fill triggers register_dimension() installed (found by their functions), then the
-- registry. The tree_parent_guard triggers it installed on hierarchical dimensions stay: the guard function
-- belongs to v0-85-0-tree-parent-guard, whose revert drops every such trigger.

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT t.tgname, t.tgrelid::regclass AS rel
    FROM pg_trigger t
    WHERE t.tgfoid IN ('metadata.dimension_delete_guard()'::regprocedure, 'metadata.dimension_default_fill()'::regprocedure)
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', r.tgname, r.rel);
  END LOOP;
END $$;

DROP FUNCTION public.dimension_subtree(TEXT, BIGINT);
DROP FUNCTION public.set_dimension_default(TEXT, BIGINT);
DROP FUNCTION public.register_dimension(TEXT, TEXT, NAME, NAME, NAME, NAME, NAME, NAME, NAME, BIGINT, BOOLEAN, INTEGER);
DROP FUNCTION metadata._dimension_value_state(NAME, NAME, NAME, NAME, BIGINT);
DROP FUNCTION metadata.dimension_default_fill();
DROP FUNCTION metadata.dimension_delete_guard();
DROP VIEW public.schema_dimensions;
DROP TABLE metadata.dimensions;

DELETE FROM metadata.constraint_messages WHERE constraint_name = 'dimension_row_delete';

NOTIFY pgrst, 'reload schema';

COMMIT;
