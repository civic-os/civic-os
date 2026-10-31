-- Verify civic_os:v0-78-1-end-series-from-date

DO $$
DECLARE
    v_end oid := 'public.end_series_from_date(bigint, date)'::regprocedure;
    v_guarded oid[] := ARRAY[
        'public.end_series_from_date(bigint, date)'::regprocedure,
        'public.delete_series_with_instances(bigint)'::regprocedure,
        'public.delete_series_group(bigint)'::regprocedure,
        'public.cancel_series_occurrence(name, bigint, text)'::regprocedure]::oid[];
BEGIN
    -- Entity deletes require delete permission
    IF EXISTS (SELECT 1 FROM unnest(v_guarded) f
               WHERE position('Requires %s:delete permission' IN pg_get_functiondef(f)) = 0) THEN
        RAISE EXCEPTION 'a series delete RPC lacks the delete-permission guard';
    END IF;
    -- cancel_series_occurrence checks it before telling members from other records
    IF position('Requires %s:delete permission' IN pg_get_functiondef(v_guarded[4]))
       > position('FROM metadata.time_slot_instances' IN pg_get_functiondef(v_guarded[4])) THEN
        RAISE EXCEPTION 'cancel_series_occurrence checks delete permission only for records outside a series';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_guarded) f
               WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f
                                 AND 'search_path=public, metadata, postgis' = ANY (p.proconfig))) THEN
        RAISE EXCEPTION 'SECURITY DEFINER series delete functions must set search_path';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
               WHERE p.oid = ANY (v_guarded) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
        RAISE EXCEPTION 'series delete functions are executable by PUBLIC';
    END IF;
    IF NOT has_function_privilege('authenticated', v_end, 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated cannot execute end_series_from_date';
    END IF;
    IF has_function_privilege('web_anon', v_end, 'EXECUTE') THEN
        RAISE EXCEPTION 'web_anon can execute end_series_from_date';
    END IF;
END $$;
