-- Deploy v0-32-0-fix-database-search-path
-- Fix: Set database-level search_path to include plugins schema
--
-- The v0-24-0 schema reorganization moved extensions (pgcrypto, btree_gist)
-- to the `plugins` schema and updated search_path for application roles
-- (authenticator, web_anon, authenticated). However, it deliberately skipped
-- the postgres role (not alterable on managed databases) and did not set a
-- database-level default.
--
-- This causes failures for any connection that doesn't use one of those roles,
-- most notably the consolidated worker which connects as the database owner
-- (postgres) and calls gen_random_bytes() from pgcrypto for file ID generation.
--
-- Fix: ALTER DATABASE sets the default search_path for ALL new connections,
-- regardless of role. Role-level overrides (from v0-24-0) still take precedence.

BEGIN;

-- Set database-level search_path so all connections can find functions in
-- metadata, plugins, and postgis schemas without explicit qualification.
-- This uses current_database() so it works regardless of database name.
DO $$
BEGIN
    EXECUTE format(
        'ALTER DATABASE %I SET search_path = public, metadata, plugins, postgis',
        current_database()
    );
    RAISE NOTICE 'Database search_path updated to: public, metadata, plugins, postgis';
END;
$$;

COMMIT;
