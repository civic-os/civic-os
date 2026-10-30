-- Revert civic_os:v0-79-0-instance-config from pg

BEGIN;

-- Restore schema_cache_versions to its v0.65.2 form (without instance_config)
DROP VIEW public.schema_cache_versions;

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
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.constraint_messages) AS version
UNION ALL
SELECT 'introspection' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_functions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.database_triggers),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.trigger_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.notification_triggers)
       ) AS version
UNION ALL
SELECT 'categories' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.categories),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.category_groups)
       ) AS version
UNION ALL
SELECT 'translations' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.translations) AS version
UNION ALL
SELECT 'profile_extensions' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)
        FROM metadata.user_profile_extensions) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties,
     constraint_messages, introspection, categories, translations, and profile_extensions.';

GRANT SELECT ON public.schema_cache_versions TO authenticated, web_anon;

-- Drop the config store (the view and functions first, then the tables)
DROP VIEW public.instance_config;
DROP FUNCTION public.set_instance_config(TEXT, TEXT);
DROP FUNCTION public.get_config(TEXT);
DROP TRIGGER instance_config_normalize_trigger ON metadata.instance_config;
DROP TRIGGER instance_config_default_trigger ON metadata.instance_config;
DROP FUNCTION metadata.instance_config_normalize();
DROP TABLE metadata.instance_config;
DROP TABLE metadata.instance_config_groups;

-- Remove the permission and its role mappings
DELETE FROM metadata.permission_roles
WHERE permission_id IN (SELECT id FROM metadata.permissions WHERE table_name = 'metadata.instance_config');
DELETE FROM metadata.permissions WHERE table_name = 'metadata.instance_config';

NOTIFY pgrst, 'reload schema';

COMMIT;
