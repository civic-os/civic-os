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

    IF to_regclass('metadata.time_slot_instances_utc_dates') IS NULL THEN
        RAISE EXCEPTION 'metadata.time_slot_instances_utc_dates (revert backup) missing';
    END IF;

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
