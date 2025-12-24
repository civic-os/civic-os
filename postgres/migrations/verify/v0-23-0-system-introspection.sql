-- Verify civic-os:v0-23-0-system-introspection on pg

BEGIN;

-- Verify tables exist
SELECT id FROM metadata.rpc_entity_effects WHERE false;
SELECT id FROM metadata.trigger_entity_effects WHERE false;
SELECT id FROM metadata.notification_triggers WHERE false;
SELECT function_name FROM metadata.rpc_functions WHERE false;
SELECT trigger_name, table_name, schema_name FROM metadata.database_triggers WHERE false;

-- Verify functions exist
SELECT has_function_privilege('metadata.analyze_function_dependencies(name)', 'execute');
SELECT has_function_privilege('metadata.auto_register_function(name, varchar, text, varchar)', 'execute');
SELECT has_function_privilege('metadata.auto_register_all_rpcs()', 'execute');

-- Verify views exist
SELECT function_name FROM public.schema_functions WHERE false;
SELECT trigger_name FROM public.schema_triggers WHERE false;
SELECT source_entity, target_entity FROM public.schema_entity_dependencies WHERE false;
SELECT id FROM public.schema_notifications WHERE false;
SELECT table_name, role_id FROM public.schema_permissions_matrix WHERE false;
SELECT function_name FROM public.schema_scheduled_functions WHERE false;

-- Verify introspection cache type in schema_cache_versions
SELECT 1 FROM public.schema_cache_versions WHERE cache_name = 'introspection';

ROLLBACK;
