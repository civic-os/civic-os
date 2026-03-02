-- Revert v0-32-0-fix-database-search-path
-- Resets database-level search_path to PostgreSQL default.
-- Role-level search_path settings from v0-24-0 remain in effect.

BEGIN;

DO $$
BEGIN
    EXECUTE format(
        'ALTER DATABASE %I RESET search_path',
        current_database()
    );
    RAISE NOTICE 'Database search_path reset to default';
END;
$$;

COMMIT;
