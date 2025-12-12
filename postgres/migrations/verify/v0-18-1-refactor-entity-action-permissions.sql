-- Verify civic_os:v0-18-1-refactor-entity-action-permissions on pg

BEGIN;

-- Verify new table exists (composite PK, no id column)
SELECT entity_action_id, role_id, created_at
FROM metadata.entity_action_roles
WHERE false;

-- Verify new functions exist
SELECT has_column FROM (SELECT public.has_entity_action_permission(1) as has_column) t;
SELECT entity_action_id FROM public.get_entity_action_roles(1) LIMIT 0;
SELECT success FROM (SELECT public.grant_entity_action_permission(1, 1) as j) t, LATERAL jsonb_to_record(t.j) AS x(success BOOLEAN) LIMIT 0;
SELECT success FROM (SELECT public.revoke_entity_action_permission(1, 1) as j) t, LATERAL jsonb_to_record(t.j) AS x(success BOOLEAN) LIMIT 0;

-- Verify view uses new permission check
SELECT can_execute FROM public.schema_entity_actions WHERE false;

-- Verify old tables are gone
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'metadata' AND table_name = 'protected_rpcs') THEN
        RAISE EXCEPTION 'protected_rpcs table still exists';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'metadata' AND table_name = 'protected_rpc_roles') THEN
        RAISE EXCEPTION 'protected_rpc_roles table still exists';
    END IF;
END $$;

-- Verify old function is gone
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'has_rpc_permission') THEN
        RAISE EXCEPTION 'has_rpc_permission function still exists';
    END IF;
END $$;

ROLLBACK;
