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

  IF NOT has_function_privilege('authenticated', 'public.save_menu_tree(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute save_menu_tree';
  END IF;
  IF has_function_privilege('web_anon', 'public.save_menu_tree(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'web_anon must not execute save_menu_tree';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.save_menu_tree(jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'save_menu_tree must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.schema_cache_versions WHERE cache_name = 'menu') THEN
    RAISE EXCEPTION 'schema_cache_versions has no menu row';
  END IF;
END $$;
