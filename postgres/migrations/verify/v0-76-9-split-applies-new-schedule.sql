-- Verify civic_os:v0-76-9-split-applies-new-schedule

DO $$
DECLARE
    v_split oid := 'public.split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb, bigint, jsonb)'::regprocedure;
    v_ust oid := 'public.update_series_template(bigint, jsonb, boolean)'::regprocedure;
    v_internal oid[] := ARRAY[
        'metadata.apply_split_to_future_instances(bigint, date, timestamp without time zone, interval, jsonb, text)'::regprocedure,
        'metadata.mark_series_instance_modified()'::regprocedure,
        'metadata.ensure_series_modified_trigger(name)'::regprocedure,
        'metadata.series_status_columns(name)'::regprocedure,
        'metadata.strip_series_status_columns(name, jsonb)'::regprocedure,
        'metadata.validate_series_timezone()'::regprocedure,
        'metadata.attach_series_modified_trigger()'::regprocedure]::oid[];
BEGIN
    -- Entity writes require update permission and skip Status columns
    IF position('Requires %s:update permission' IN pg_get_functiondef(v_split)) = 0
       OR position('Requires %s:update permission' IN pg_get_functiondef(v_ust)) = 0 THEN
        RAISE EXCEPTION 'split_series_from_date / update_series_template lack the update-permission guard';
    END IF;
    IF position('strip_series_status_columns' IN pg_get_functiondef(v_ust)) = 0 THEN
        RAISE EXCEPTION 'update_series_template does not strip Status columns';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_split AND 'search_path=public, metadata, postgis' = ANY (proconfig))
       OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_ust AND 'search_path=public, metadata, postgis' = ANY (proconfig)) THEN
        RAISE EXCEPTION 'SECURITY DEFINER series functions must set search_path';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
               WHERE p.oid = ANY (v_internal || v_split || v_ust) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
        RAISE EXCEPTION 'series functions are executable by PUBLIC';
    END IF;
    IF NOT has_function_privilege('authenticated', v_split, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_ust, 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated cannot execute the series RPCs';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_internal) f WHERE has_function_privilege('authenticated', f, 'EXECUTE')) THEN
        RAISE EXCEPTION 'internal series helpers must not be callable by authenticated';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'attach_series_modified_trigger'
                   AND tgrelid = 'metadata.time_slot_series'::regclass) THEN
        RAISE EXCEPTION 'edit-trigger attachment trigger missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'validate_series_timezone'
                   AND tgrelid = 'metadata.time_slot_series'::regclass) THEN
        RAISE EXCEPTION 'timezone validation trigger missing';
    END IF;
    IF EXISTS (SELECT DISTINCT entity_table FROM metadata.time_slot_series s
               WHERE to_regclass(format('public.%I', s.entity_table)) IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM pg_trigger t
                                 WHERE t.tgname = 'zz_time_slot_series_instance_modified'
                                   AND t.tgrelid = format('public.%I', s.entity_table)::regclass)) THEN
        RAISE EXCEPTION 'an entity table with series lacks the edit trigger';
    END IF;
END $$;
