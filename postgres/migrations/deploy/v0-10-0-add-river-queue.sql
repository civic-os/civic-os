-- Deploy civic_os:v0-10-0-add-river-queue to pg
-- requires: v0-9-0-add-constraint-messages-view

BEGIN;

-- =============================================================================
-- River Job Queue Schema (v0.0.19)
-- =============================================================================
-- This migration includes the complete River schema from migrations 001-006.
-- River is a PostgreSQL-based job queue library for Go that provides:
-- - At-least-once delivery guarantees
-- - Automatic retries with exponential backoff
-- - Row-level locking (no global lock like LISTEN/NOTIFY)
-- - Full monitoring via SQL queries
-- - Dead-letter queue for failed jobs
-- =============================================================================

-- Migration 001: Create river_migration table
CREATE TABLE metadata.river_migration(
    id bigserial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    version bigint NOT NULL,
    line text NOT NULL DEFAULT 'main',
    CONSTRAINT version CHECK (version >= 1)
);

-- Migration 002: Initial schema (river_job, river_leader)
CREATE TYPE metadata.river_job_state AS ENUM(
    'available',
    'cancelled',
    'completed',
    'discarded',
    'retryable',
    'running',
    'scheduled'
);

CREATE TABLE metadata.river_job(
    id bigserial PRIMARY KEY,
    state metadata.river_job_state NOT NULL DEFAULT 'available',
    attempt smallint NOT NULL DEFAULT 0,
    max_attempts smallint NOT NULL,
    attempted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    finalized_at timestamptz,
    scheduled_at timestamptz NOT NULL DEFAULT NOW(),
    priority smallint NOT NULL DEFAULT 1,
    args jsonb,
    attempted_by text[],
    errors jsonb[],
    kind text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}',
    queue text NOT NULL DEFAULT 'default',
    tags varchar(255)[],
    CONSTRAINT finalized_or_finalized_at_null CHECK ((state IN ('cancelled', 'completed', 'discarded') AND finalized_at IS NOT NULL) OR finalized_at IS NULL),
    CONSTRAINT max_attempts_is_positive CHECK (max_attempts > 0),
    CONSTRAINT priority_in_range CHECK (priority >= 1 AND priority <= 4),
    CONSTRAINT queue_length CHECK (char_length(queue) > 0 AND char_length(queue) < 128),
    CONSTRAINT kind_length CHECK (char_length(kind) > 0 AND char_length(kind) < 128)
);

CREATE INDEX river_job_kind ON metadata.river_job USING btree(kind);
CREATE INDEX river_job_state_and_finalized_at_index ON metadata.river_job USING btree(state, finalized_at) WHERE finalized_at IS NOT NULL;
CREATE INDEX river_job_prioritized_fetching_index ON metadata.river_job USING btree(state, queue, priority, scheduled_at, id);
CREATE INDEX river_job_args_index ON metadata.river_job USING GIN(args);
CREATE INDEX river_job_metadata_index ON metadata.river_job USING GIN(metadata);

CREATE UNLOGGED TABLE metadata.river_leader(
    elected_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    leader_id text NOT NULL,
    name text PRIMARY KEY,
    CONSTRAINT name_length CHECK (char_length(name) > 0 AND char_length(name) < 128),
    CONSTRAINT leader_id_length CHECK (char_length(leader_id) > 0 AND char_length(leader_id) < 128)
);

-- Migration 003: Make tags non-null
ALTER TABLE metadata.river_job ALTER COLUMN tags SET DEFAULT '{}';
UPDATE metadata.river_job SET tags = '{}' WHERE tags IS NULL;
ALTER TABLE metadata.river_job ALTER COLUMN tags SET NOT NULL;

-- Migration 004: Add pending state and river_queue table
ALTER TABLE metadata.river_job ALTER COLUMN args SET DEFAULT '{}';
UPDATE metadata.river_job SET args = '{}' WHERE args IS NULL;
ALTER TABLE metadata.river_job ALTER COLUMN args SET NOT NULL;
ALTER TABLE metadata.river_job ALTER COLUMN args DROP DEFAULT;

ALTER TABLE metadata.river_job ALTER COLUMN metadata SET DEFAULT '{}';
UPDATE metadata.river_job SET metadata = '{}' WHERE metadata IS NULL;
ALTER TABLE metadata.river_job ALTER COLUMN metadata SET NOT NULL;

ALTER TYPE metadata.river_job_state ADD VALUE IF NOT EXISTS 'pending' AFTER 'discarded';

ALTER TABLE metadata.river_job DROP CONSTRAINT finalized_or_finalized_at_null;
ALTER TABLE metadata.river_job ADD CONSTRAINT finalized_or_finalized_at_null CHECK (
    (finalized_at IS NULL AND state NOT IN ('cancelled', 'completed', 'discarded')) OR
    (finalized_at IS NOT NULL AND state IN ('cancelled', 'completed', 'discarded'))
);

CREATE TABLE metadata.river_queue (
    name text PRIMARY KEY NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}' ::jsonb,
    paused_at timestamptz,
    updated_at timestamptz NOT NULL
);

ALTER TABLE metadata.river_leader
    ALTER COLUMN name SET DEFAULT 'default',
    DROP CONSTRAINT name_length,
    ADD CONSTRAINT name_length CHECK (name = 'default');

-- Migration 005: Add unique_key and client tracking tables
-- Restructure river_migration with composite primary key
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'metadata' AND tablename = 'river_migration'
    ) THEN
        ALTER TABLE metadata.river_migration DROP CONSTRAINT river_migration_pkey;
        ALTER TABLE metadata.river_migration ADD PRIMARY KEY (line, version);

        -- Backfill existing records with 'main' line
        UPDATE metadata.river_migration SET line = 'main' WHERE line = '';
    END IF;
END;
$$;

-- Add unique_key column to river_job
ALTER TABLE metadata.river_job ADD COLUMN IF NOT EXISTS unique_key bytea;
CREATE UNIQUE INDEX IF NOT EXISTS river_job_kind_unique_key_idx ON metadata.river_job (kind, unique_key) WHERE unique_key IS NOT NULL;

-- Create client tracking tables
CREATE UNLOGGED TABLE metadata.river_client (
    id text PRIMARY KEY NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}' ::jsonb,
    paused_at timestamptz,
    updated_at timestamptz NOT NULL
);

CREATE UNLOGGED TABLE metadata.river_client_queue (
    river_client_id text NOT NULL REFERENCES metadata.river_client(id) ON DELETE CASCADE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    max_workers bigint NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}' ::jsonb,
    num_jobs_completed bigint NOT NULL DEFAULT 0,
    num_jobs_running bigint NOT NULL DEFAULT 0,
    paused_at timestamptz,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (river_client_id, name)
);

-- Migration 006: Bulk unique with state bitmask
CREATE OR REPLACE FUNCTION metadata.river_job_state_in_bitmask(bitmask BIT(8), state metadata.river_job_state)
RETURNS boolean
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT CASE state
        WHEN 'available' THEN get_bit(bitmask, 7)
        WHEN 'cancelled' THEN get_bit(bitmask, 6)
        WHEN 'completed' THEN get_bit(bitmask, 5)
        WHEN 'discarded' THEN get_bit(bitmask, 4)
        WHEN 'pending'   THEN get_bit(bitmask, 3)
        WHEN 'retryable' THEN get_bit(bitmask, 2)
        WHEN 'running'   THEN get_bit(bitmask, 1)
        WHEN 'scheduled' THEN get_bit(bitmask, 0)
        ELSE 0
    END = 1;
$$;

ALTER TABLE metadata.river_job ADD COLUMN IF NOT EXISTS unique_states BIT(8);

CREATE UNIQUE INDEX IF NOT EXISTS river_job_unique_idx ON metadata.river_job (unique_key)
    WHERE unique_key IS NOT NULL
      AND unique_states IS NOT NULL
      AND metadata.river_job_state_in_bitmask(unique_states, state);

DROP INDEX IF EXISTS river_job_kind_unique_key_idx;

-- Insert River migration tracking records
INSERT INTO metadata.river_migration (line, version) VALUES
    ('main', 1),
    ('main', 2),
    ('main', 3),
    ('main', 4),
    ('main', 5),
    ('main', 6);

-- =============================================================================
-- Performance Tuning: Aggressive Autovacuum for High-Throughput Queue
-- =============================================================================
-- River job tables have high churn (frequent INSERT/DELETE). Without aggressive
-- autovacuum, dead tuples accumulate causing table bloat and query slowdowns.
-- These settings ensure vacuum runs at 1% dead tuples (vs default 20%).

ALTER TABLE metadata.river_job SET (
    autovacuum_vacuum_scale_factor = 0.01,  -- Vacuum at 1% dead tuples (default: 20%)
    autovacuum_vacuum_cost_delay = 1        -- Aggressive cleanup (default: 20ms)
);

-- Note: autovacuum_naptime is a server-level setting (postgresql.conf), not table-level.
-- For production, consider: autovacuum_naptime = 20s in postgresql.conf (default: 60s)

-- =============================================================================
-- Update File Storage Triggers to use River instead of LISTEN/NOTIFY
-- =============================================================================

-- Drop existing LISTEN/NOTIFY triggers (may exist from v0-5-0 or previous revert attempts)
DROP TRIGGER IF EXISTS file_uploaded_trigger ON metadata.files;
DROP TRIGGER IF EXISTS notify_upload_url_request ON metadata.file_upload_requests;

-- Drop the old LISTEN/NOTIFY functions
DROP FUNCTION IF EXISTS notify_file_uploaded() CASCADE;
DROP FUNCTION IF EXISTS notify_upload_url_request() CASCADE;

-- Create new River job insertion trigger for S3 Signer
CREATE OR REPLACE FUNCTION insert_s3_presign_job()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts)
    VALUES (
        's3_presign',
        jsonb_build_object(
            'request_id', NEW.id::text,
            'file_name', NEW.file_name,
            'file_type', NEW.file_type,
            'entity_type', NEW.entity_type,
            'entity_id', NEW.entity_id::text
        ),
        's3_signer',
        1,
        25
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER insert_s3_presign_job_trigger
    AFTER INSERT ON metadata.file_upload_requests
    FOR EACH ROW
    EXECUTE FUNCTION insert_s3_presign_job();

-- Create new River job insertion trigger for Thumbnail Worker
CREATE OR REPLACE FUNCTION insert_thumbnail_job()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    -- Only create job if thumbnail_status is 'pending'
    IF NEW.thumbnail_status = 'pending' THEN
        INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts)
        VALUES (
            'thumbnail_generate',
            jsonb_build_object(
                'file_id', NEW.id::text,
                's3_key', NEW.s3_original_key,
                'file_type', NEW.file_type,
                'bucket', 'civic-os-files'
            ),
            'thumbnails',
            1,
            25
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER insert_thumbnail_job_trigger
    AFTER INSERT ON metadata.files
    FOR EACH ROW
    EXECUTE FUNCTION insert_thumbnail_job();

-- =============================================================================
-- Grants for River Tables
-- =============================================================================
-- The authenticated role needs SELECT access to monitor job status
-- River workers use a dedicated service account, not the authenticated role

GRANT SELECT ON metadata.river_job TO authenticated;
GRANT SELECT ON metadata.river_migration TO authenticated;
GRANT SELECT ON metadata.river_queue TO authenticated;

-- River workers will use their own database user (created during deployment)
-- Example: CREATE USER river_worker WITH PASSWORD 'secure_password';
--          GRANT ALL ON metadata.river_job, metadata.river_leader, metadata.river_queue, metadata.river_client, metadata.river_client_queue TO river_worker;

COMMENT ON TABLE metadata.river_job IS 'River job queue table - stores all background jobs for S3 signing and thumbnail generation';
COMMENT ON TABLE metadata.river_leader IS 'River leader election table - ensures only one leader per queue';
COMMENT ON TABLE metadata.river_queue IS 'River queue configuration table';
COMMENT ON TABLE metadata.river_migration IS 'River migration tracking table';

COMMIT;
