-- Verify civic_os:v0-81-0-menu-nodes
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

DO $$
BEGIN
  IF to_regclass('metadata.menu_nodes') IS NULL THEN
    RAISE EXCEPTION 'metadata.menu_nodes is missing';
  END IF;
  IF to_regclass('metadata.menu_version') IS NULL OR (SELECT count(*) FROM metadata.menu_version) <> 1 THEN
    RAISE EXCEPTION 'metadata.menu_version must exist with exactly one row';
  END IF;
  IF to_regclass('public.schema_menu_nodes') IS NULL THEN
    RAISE EXCEPTION 'public.schema_menu_nodes is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'metadata' AND indexname = 'idx_menu_nodes_parent_node_key') THEN
    RAISE EXCEPTION 'idx_menu_nodes_parent_node_key is missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'metadata.menu_nodes'::regclass AND NOT tgisinternal) < 4 THEN
    RAISE EXCEPTION 'metadata.menu_nodes is missing triggers (validate, updated_at, version stamp x2)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'metadata.menu_nodes'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on metadata.menu_nodes';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'metadata' AND table_name = 'entities' AND column_name = 'show_in_sidebar') THEN
    RAISE EXCEPTION 'metadata.entities.show_in_sidebar should be dropped';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'schema_entities' AND column_name = 'show_in_sidebar') THEN
    RAISE EXCEPTION 'public.schema_entities still exposes show_in_sidebar';
  END IF;
  IF to_regclass('public.schema_properties') IS NULL OR to_regclass('public.schema_entity_dependencies') IS NULL THEN
    RAISE EXCEPTION 'schema_entities dependents were not recreated';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid::regprocedure::text LIKE 'upsert_entity_metadata(%'
             AND pg_get_function_arguments(oid) LIKE '%p_show_in_sidebar%') THEN
    RAISE EXCEPTION 'upsert_entity_metadata still takes p_show_in_sidebar';
  END IF;

  -- Checks below hold both right after this change and once later changes are deployed (v0.81.2 makes
  -- save_menu_tree invoker with a second parameter, gates the view by RLS and grants authenticated
  -- writes), so they match functions by name and check security properties, not exact shapes.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid::regprocedure::text LIKE 'save_menu_tree(%'
                 AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'public.save_menu_tree is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'save_menu_tree' AND p.pronamespace = 'public'::regnamespace
             AND (NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('web_anon', p.oid, 'EXECUTE')
                  OR has_function_privilege('public', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'save_menu_tree must be executable by authenticated only (not web_anon, not PUBLIC)';
  END IF;
  -- The v0.81.0 signature, while it exists, is the definer one with the admin guard.
  -- to_regprocedure in both places: a '...'::regprocedure cast is folded at plan time and fails once the
  -- signature is gone, whatever the IS NOT NULL guard says.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.save_menu_tree(jsonb)') AND NOT prosecdef) THEN
    RAISE EXCEPTION 'save_menu_tree(jsonb) must be SECURITY DEFINER';
  END IF;

  IF has_table_privilege('web_anon', 'metadata.menu_nodes', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'web_anon must not write metadata.menu_nodes';
  END IF;
  IF NOT has_table_privilege('web_anon', 'metadata.menu_nodes', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'metadata.menu_nodes', 'SELECT') THEN
    RAISE EXCEPTION 'metadata.menu_nodes must grant SELECT to web_anon and authenticated';
  END IF;
  IF NOT has_table_privilege('web_anon', 'public.schema_menu_nodes', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.schema_menu_nodes', 'SELECT') THEN
    RAISE EXCEPTION 'public.schema_menu_nodes must grant SELECT to web_anon and authenticated';
  END IF;

  -- The views this change dropped and recreated around schema_entities kept their grants and options.
  IF NOT has_table_privilege('web_anon', 'public.schema_entities', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.schema_entities', 'SELECT')
     OR NOT has_table_privilege('web_anon', 'public.schema_properties', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.schema_properties', 'SELECT')
     OR NOT has_table_privilege('web_anon', 'public.schema_entity_dependencies', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.schema_entity_dependencies', 'SELECT') THEN
    RAISE EXCEPTION 'schema_entities, schema_properties and schema_entity_dependencies must grant SELECT to web_anon and authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.schema_entity_dependencies'::regclass
                 AND reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'public.schema_entity_dependencies lost security_invoker';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.schema_cache_versions WHERE cache_name = 'menu') THEN
    RAISE EXCEPTION 'schema_cache_versions has no menu row';
  END IF;
END $$;
