-- Verify civic_os:v0-76-9-occurrence-date-local

DO $$
DECLARE
    v_fn oid := 'public.split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb)'::regprocedure;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'unique_series_occurrence'
          AND conrelid = 'metadata.time_slot_instances'::regclass
    ) THEN
        RAISE EXCEPTION 'unique_series_occurrence constraint missing';
    END IF;

    IF col_description('metadata.time_slot_instances'::regclass,
           (SELECT attnum FROM pg_attribute
            WHERE attrelid = 'metadata.time_slot_instances'::regclass AND attname = 'occurrence_date'))
       IS DISTINCT FROM 'Local calendar date of the scheduled occurrence in the series timezone' THEN
        RAISE EXCEPTION 'occurrence_date is not marked as converted to local dates';
    END IF;

    IF to_regclass('metadata.time_slot_date_repair') IS NULL
       OR to_regclass('metadata.time_slot_instance_date_repair') IS NULL THEN
        RAISE EXCEPTION 'occurrence date conversion tables missing';
    END IF;
    -- Every series of a group with unresolved rows is paused
    IF EXISTS (SELECT 1 FROM metadata.time_slot_date_repair r
               JOIN metadata.time_slot_series s ON s.id = r.series_id
               WHERE r.status = 'needs_attention' AND s.status <> 'needs_attention') THEN
        RAISE EXCEPTION 'a series with unresolved occurrence dates is not paused';
    END IF;

    -- The remedy is admin-only: guarded, not executable by PUBLIC, fixed search_path
    v_fn := 'metadata.resolve_occurrence_date(bigint, date)'::regprocedure;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn)
       OR position('is_admin()' IN pg_get_functiondef(v_fn)) = 0
       OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND 'search_path=public, metadata, postgis' = ANY (proconfig))
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'resolve_occurrence_date is not locked down';
    END IF;
    v_fn := 'public.split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb)'::regprocedure;

    IF position('SET series_id = v_new_series_id' IN pg_get_functiondef(v_fn)) = 0 THEN
        RAISE EXCEPTION 'split_series_from_date does not re-link future instances';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
        WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'split_series_from_date is executable by PUBLIC';
    END IF;

    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated cannot execute split_series_from_date';
    END IF;
END $$;
