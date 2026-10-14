-- Verify civic_os:v0-4-0-baseline on pg

BEGIN;

-- =====================================================
-- Verify Civic OS v0.4.0 Baseline Schema
-- =====================================================
-- This script performs fast SQL checks to verify all core objects exist.
-- Revert correctness of newer changes is checked in CI by scripts/schema-roundtrip.sh stepwise.

-- Verify PostGIS extension and schema
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE EXCEPTION 'PostGIS extension not found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'postgis') THEN
    RAISE EXCEPTION 'PostGIS schema not found';
  END IF;
END $$;

-- Verify PostgREST roles
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_anon') THEN
    RAISE EXCEPTION 'Role web_anon not found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Role authenticated not found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    RAISE EXCEPTION 'Role authenticator not found';
  END IF;
END $$;

-- Verify metadata schema
SELECT 1/(COUNT(*))::int FROM pg_namespace WHERE nspname = 'metadata';

-- Verify custom domains
SELECT 1/(COUNT(*))::int FROM pg_type t
  JOIN pg_namespace n ON t.typnamespace = n.oid
  WHERE t.typname = 'hex_color' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_type t
  JOIN pg_namespace n ON t.typnamespace = n.oid
  WHERE t.typname = 'email_address' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_type t
  JOIN pg_namespace n ON t.typnamespace = n.oid
  WHERE t.typname = 'phone_number' AND n.nspname = 'public';

-- Verify metadata.permission type
SELECT 1/(COUNT(*))::int FROM pg_type t
  JOIN pg_namespace n ON t.typnamespace = n.oid
  WHERE t.typname = 'permission' AND n.nspname = 'metadata';

-- Verify metadata tables
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'entities';
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'properties';
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'permissions';
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'roles';
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'permission_roles';
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'validations';
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'constraint_messages';
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'civic_os_users';
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'civic_os_users_private';
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'widget_types';
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'dashboards';
SELECT 1/(COUNT(*))::int FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'dashboard_widgets';

-- Verify public views
SELECT 1/(COUNT(*))::int FROM pg_views WHERE schemaname = 'public' AND viewname = 'civic_os_users';
SELECT 1/(COUNT(*))::int FROM pg_views WHERE schemaname = 'public' AND viewname = 'schema_entities';
SELECT 1/(COUNT(*))::int FROM pg_views WHERE schemaname = 'public' AND viewname = 'schema_properties';
SELECT 1/(COUNT(*))::int FROM pg_views WHERE schemaname = 'public' AND viewname = 'schema_cache_versions';

-- Verify JWT helper functions
SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'current_user_id' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'current_user_email' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'current_user_name' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'format_public_display_name' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'check_jwt' AND n.nspname = 'public';

-- Verify RBAC functions
SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'get_user_roles' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'has_permission' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'is_admin' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'get_roles' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'get_role_permissions' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'set_role_permission' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'create_role' AND n.nspname = 'public';

-- Verify entity management functions
SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'refresh_current_user' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'schema_relations_func' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'upsert_entity_metadata' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'update_entity_sort_order' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'upsert_property_metadata' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'update_property_sort_order' AND n.nspname = 'public';

-- Verify utility functions
SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'set_created_at' AND n.nspname = 'public';

SELECT 1/(COUNT(*))::int FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'set_updated_at' AND n.nspname = 'public';

-- Verify default roles exist
SELECT 1/(COUNT(*))::int FROM metadata.roles WHERE display_name = 'anonymous';
SELECT 1/(COUNT(*))::int FROM metadata.roles WHERE display_name = 'user';
SELECT 1/(COUNT(*))::int FROM metadata.roles WHERE display_name = 'editor';
SELECT 1/(COUNT(*))::int FROM metadata.roles WHERE display_name = 'admin';

-- Verify triggers on metadata tables
SELECT 1/(COUNT(*))::int FROM pg_trigger
  WHERE tgname = 'set_updated_at_trigger'
  AND tgrelid = 'metadata.entities'::regclass;

SELECT 1/(COUNT(*))::int FROM pg_trigger
  WHERE tgname = 'set_updated_at_trigger'
  AND tgrelid = 'metadata.properties'::regclass;

SELECT 1/(COUNT(*))::int FROM pg_trigger
  WHERE tgname = 'set_updated_at_trigger'
  AND tgrelid = 'metadata.civic_os_users'::regclass;

SELECT 1/(COUNT(*))::int FROM pg_trigger
  WHERE tgname = 'set_updated_at_trigger'
  AND tgrelid = 'metadata.civic_os_users_private'::regclass;

ROLLBACK;
