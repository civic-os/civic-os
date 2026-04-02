-- Revert civic_os:v0-4-0-baseline from pg

BEGIN;

-- =====================================================
-- Revert Civic OS v0.4.0 Baseline Schema
-- =====================================================
-- This script removes all core Civic OS objects in reverse order.
-- WARNING: This will destroy all metadata and core functionality.

-- Revoke all grants
REVOKE ALL ON FUNCTION public.update_property_sort_order(NAME, NAME, INT) FROM authenticated;
REVOKE ALL ON FUNCTION public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) FROM authenticated;
REVOKE ALL ON FUNCTION public.update_entity_sort_order(NAME, INT) FROM authenticated;
REVOKE ALL ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.refresh_current_user() FROM authenticated;
REVOKE ALL ON FUNCTION public.schema_relations_func() FROM web_anon, authenticated;
REVOKE ALL ON FUNCTION public.create_role(TEXT, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.set_role_permission(SMALLINT, TEXT, TEXT, BOOLEAN) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_role_permissions(SMALLINT) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_roles() FROM authenticated;
REVOKE ALL ON FUNCTION public.is_admin() FROM web_anon, authenticated;
REVOKE ALL ON FUNCTION public.has_permission(TEXT, TEXT) FROM web_anon, authenticated;
REVOKE ALL ON FUNCTION public.get_user_roles() FROM web_anon, authenticated;
REVOKE ALL ON FUNCTION public.format_public_display_name(TEXT) FROM web_anon, authenticated;
REVOKE ALL ON FUNCTION public.current_user_name() FROM web_anon, authenticated;
REVOKE ALL ON FUNCTION public.current_user_email() FROM web_anon, authenticated;
REVOKE ALL ON FUNCTION public.current_user_id() FROM web_anon, authenticated;

REVOKE SELECT ON public.schema_cache_versions FROM web_anon, authenticated;
REVOKE SELECT ON public.schema_properties FROM web_anon, authenticated;
REVOKE SELECT ON public.schema_entities FROM web_anon, authenticated;
REVOKE SELECT ON public.civic_os_users FROM web_anon, authenticated;

REVOKE SELECT ON metadata.dashboard_widgets FROM web_anon, authenticated;
REVOKE SELECT ON metadata.dashboards FROM web_anon, authenticated;
REVOKE SELECT ON metadata.widget_types FROM web_anon, authenticated;

REVOKE INSERT, UPDATE ON metadata.civic_os_users_private FROM authenticated;
REVOKE INSERT, UPDATE ON metadata.civic_os_users FROM authenticated;
REVOKE SELECT ON metadata.civic_os_users_private FROM web_anon, authenticated;
REVOKE SELECT ON metadata.civic_os_users FROM web_anon, authenticated;

REVOKE SELECT ON metadata.constraint_messages FROM web_anon, authenticated;
REVOKE SELECT ON metadata.validations FROM web_anon, authenticated;
REVOKE SELECT ON metadata.permission_roles FROM web_anon, authenticated;
REVOKE SELECT ON metadata.roles FROM web_anon, authenticated;
REVOKE SELECT ON metadata.permissions FROM web_anon, authenticated;
REVOKE SELECT ON metadata.properties FROM web_anon, authenticated;
REVOKE UPDATE, INSERT ON metadata.entities FROM authenticated;
REVOKE SELECT ON metadata.entities FROM web_anon, authenticated;

REVOKE USAGE ON SCHEMA public FROM web_anon, authenticated;
REVOKE USAGE ON SCHEMA metadata FROM web_anon, authenticated;

-- Drop views
DROP VIEW IF EXISTS public.schema_cache_versions CASCADE;
DROP VIEW IF EXISTS public.schema_properties CASCADE;
DROP VIEW IF EXISTS public.schema_entities CASCADE;
DROP VIEW IF EXISTS public.civic_os_users CASCADE;

-- Drop RPC functions
DROP FUNCTION IF EXISTS public.update_property_sort_order(NAME, NAME, INT) CASCADE;
DROP FUNCTION IF EXISTS public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) CASCADE;
DROP FUNCTION IF EXISTS public.update_entity_sort_order(NAME, INT) CASCADE;
DROP FUNCTION IF EXISTS public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.set_updated_at() CASCADE;
DROP FUNCTION IF EXISTS public.set_created_at() CASCADE;
DROP FUNCTION IF EXISTS public.refresh_current_user() CASCADE;
DROP FUNCTION IF EXISTS public.schema_relations_func() CASCADE;
DROP FUNCTION IF EXISTS public.create_role(TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.get_role_permissions(SMALLINT) CASCADE;
DROP FUNCTION IF EXISTS public.get_roles() CASCADE;
DROP FUNCTION IF EXISTS public.set_role_permission(SMALLINT, TEXT, TEXT, BOOLEAN) CASCADE;
DROP FUNCTION IF EXISTS public.is_admin() CASCADE;
DROP FUNCTION IF EXISTS public.has_permission(TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.get_user_roles() CASCADE;
DROP FUNCTION IF EXISTS public.format_public_display_name(TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.check_jwt() CASCADE;
DROP FUNCTION IF EXISTS public.current_user_name() CASCADE;
DROP FUNCTION IF EXISTS public.current_user_email() CASCADE;
DROP FUNCTION IF EXISTS public.current_user_id() CASCADE;

-- Drop metadata tables (in reverse order of dependencies)
DROP TABLE IF EXISTS metadata.dashboard_widgets CASCADE;
DROP TABLE IF EXISTS metadata.dashboards CASCADE;
DROP TABLE IF EXISTS metadata.widget_types CASCADE;
DROP TABLE IF EXISTS metadata.constraint_messages CASCADE;
DROP TABLE IF EXISTS metadata.validations CASCADE;
DROP TABLE IF EXISTS metadata.permission_roles CASCADE;
DROP TABLE IF EXISTS metadata.permissions CASCADE;
DROP TABLE IF EXISTS metadata.roles CASCADE;
DROP TABLE IF EXISTS metadata.properties CASCADE;
DROP TABLE IF EXISTS metadata.entities CASCADE;
DROP TABLE IF EXISTS metadata.civic_os_users_private CASCADE;
DROP TABLE IF EXISTS metadata.civic_os_users CASCADE;

-- Drop custom types
DROP TYPE IF EXISTS metadata.permission CASCADE;

-- Drop domains
DROP DOMAIN IF EXISTS phone_number CASCADE;
DROP DOMAIN IF EXISTS email_address CASCADE;
DROP DOMAIN IF EXISTS hex_color CASCADE;

-- Drop metadata schema
DROP SCHEMA IF EXISTS metadata CASCADE;

-- Drop PostgREST roles
-- NOTE: In multi-tenant deployments, web_anon and authenticated roles are shared
--       across multiple Civic OS schemas and should NOT be dropped when reverting
--       a single tenant's schema. The authenticator role was created manually
--       and is also NOT dropped by this migration.
--
-- To fully clean up roles in a single-tenant scenario, run manually:
--   DROP ROLE IF EXISTS authenticated;
--   DROP ROLE IF EXISTS web_anon;
--   DROP ROLE IF EXISTS authenticator;

REVOKE authenticated FROM authenticator;
REVOKE web_anon FROM authenticator;

-- PostGIS cleanup
-- NOTE: PostGIS is installed by the container/host, not by this migration.
-- Only revoke the USAGE grant we added; do NOT drop the extension or schema
-- as that can hang on large databases and is not ours to remove.
REVOKE USAGE ON SCHEMA postgis FROM PUBLIC;

COMMIT;
