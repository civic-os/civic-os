-- Verify v0-32-0-fix-database-search-path
-- Confirms that the database-level search_path includes plugins schema.

DO $$
DECLARE
    v_found BOOLEAN := FALSE;
    v_setting TEXT;
BEGIN
    -- Check if any database-level setting includes plugins in search_path
    SELECT c INTO v_setting
    FROM pg_catalog.pg_db_role_setting s
    JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
    CROSS JOIN LATERAL unnest(s.setconfig) AS c
    WHERE d.datname = current_database()
      AND s.setrole = 0
      AND c LIKE 'search_path=%plugins%';

    IF v_setting IS NULL THEN
        RAISE EXCEPTION 'Database-level search_path does not include plugins schema';
    END IF;

    RAISE NOTICE 'Database search_path verified: %', v_setting;
END;
$$;
