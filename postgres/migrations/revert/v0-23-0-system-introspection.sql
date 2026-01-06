-- Revert civic-os:v0-23-0-system-introspection from pg

BEGIN;

-- Drop views first (in dependency order)
-- IMPORTANT: schema_cache_versions must be dropped BEFORE notification_triggers table
-- because v0.23.0 added a dependency on notification_triggers to the view
DROP VIEW IF EXISTS public.schema_cache_versions;
DROP VIEW IF EXISTS public.schema_scheduled_functions;
DROP VIEW IF EXISTS public.schema_permissions_matrix;
DROP VIEW IF EXISTS public.schema_notifications;
DROP VIEW IF EXISTS public.schema_entity_dependencies;
DROP VIEW IF EXISTS public.schema_triggers;
DROP VIEW IF EXISTS public.schema_functions;

-- Drop helper functions
DROP FUNCTION IF EXISTS metadata.auto_register_all_rpcs();
DROP FUNCTION IF EXISTS metadata.auto_register_function(NAME, VARCHAR, TEXT, VARCHAR);
DROP FUNCTION IF EXISTS metadata.analyze_function_dependencies(NAME);

-- Drop triggers
DROP TRIGGER IF EXISTS update_notification_triggers_timestamp ON metadata.notification_triggers;
DROP TRIGGER IF EXISTS update_trigger_entity_effects_timestamp ON metadata.trigger_entity_effects;
DROP TRIGGER IF EXISTS update_rpc_entity_effects_timestamp ON metadata.rpc_entity_effects;
DROP TRIGGER IF EXISTS update_database_triggers_timestamp ON metadata.database_triggers;
DROP TRIGGER IF EXISTS update_rpc_functions_timestamp ON metadata.rpc_functions;

DROP FUNCTION IF EXISTS metadata.update_introspection_timestamp();

-- Drop tables (in dependency order)
DROP TABLE IF EXISTS metadata.notification_triggers;
DROP TABLE IF EXISTS metadata.trigger_entity_effects;
DROP TABLE IF EXISTS metadata.rpc_entity_effects;
DROP TABLE IF EXISTS metadata.database_triggers;
DROP TABLE IF EXISTS metadata.rpc_functions;

-- Restore original schema_cache_versions without introspection
-- (view was already dropped at the top due to dependency on notification_triggers)

CREATE VIEW public.schema_cache_versions AS
SELECT 'entities' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.entities),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permissions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.roles),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permission_roles)
       ) AS version
UNION ALL
SELECT 'properties' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.properties),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.validations)
       ) AS version
UNION ALL
SELECT 'constraint_messages' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.constraint_messages) AS version;

GRANT SELECT ON public.schema_cache_versions TO authenticated, web_anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
