-- Verify civic_os:v0-10-0-add-river-queue on pg

BEGIN;

-- Verify River tables exist
SELECT 1/COUNT(*) FROM pg_catalog.pg_tables WHERE tablename = 'river_job' AND schemaname = 'metadata';
SELECT 1/COUNT(*) FROM pg_catalog.pg_tables WHERE tablename = 'river_leader' AND schemaname = 'metadata';
SELECT 1/COUNT(*) FROM pg_catalog.pg_tables WHERE tablename = 'river_queue' AND schemaname = 'metadata';
SELECT 1/COUNT(*) FROM pg_catalog.pg_tables WHERE tablename = 'river_migration' AND schemaname = 'metadata';
SELECT 1/COUNT(*) FROM pg_catalog.pg_tables WHERE tablename = 'river_client' AND schemaname = 'metadata';
SELECT 1/COUNT(*) FROM pg_catalog.pg_tables WHERE tablename = 'river_client_queue' AND schemaname = 'metadata';

-- Verify river_job_state enum type exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_type WHERE typname = 'river_job_state';

-- Verify river_job has all required columns
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'river_job' AND column_name = 'id';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'river_job' AND column_name = 'kind';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'river_job' AND column_name = 'queue';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'river_job' AND column_name = 'state';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'river_job' AND column_name = 'args';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'river_job' AND column_name = 'unique_key';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'river_job' AND column_name = 'unique_states';

-- Verify indexes exist
SELECT 1/COUNT(*) FROM pg_catalog.pg_indexes
WHERE tablename = 'river_job' AND indexname = 'river_job_kind';

SELECT 1/COUNT(*) FROM pg_catalog.pg_indexes
WHERE tablename = 'river_job' AND indexname = 'river_job_prioritized_fetching_index';

SELECT 1/COUNT(*) FROM pg_catalog.pg_indexes
WHERE tablename = 'river_job' AND indexname = 'river_job_args_index';

-- Verify River function exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc WHERE proname = 'river_job_state_in_bitmask';

-- Verify new River triggers exist
SELECT 1/COUNT(*) FROM pg_catalog.pg_trigger WHERE tgname = 'insert_s3_presign_job_trigger';
SELECT 1/COUNT(*) FROM pg_catalog.pg_trigger WHERE tgname = 'insert_thumbnail_job_trigger';

-- Verify new River trigger functions exist
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc WHERE proname = 'insert_s3_presign_job';
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc WHERE proname = 'insert_thumbnail_job';

-- Verify River migration tracking records exist
SELECT 1/COUNT(*) FROM metadata.river_migration WHERE line = 'main' AND version = 1;
SELECT 1/COUNT(*) FROM metadata.river_migration WHERE line = 'main' AND version = 6;

-- Verify grants for authenticated role
SELECT 1/COUNT(*) FROM information_schema.role_table_grants
WHERE grantee = 'authenticated' AND table_name = 'river_job' AND privilege_type = 'SELECT';

ROLLBACK;
