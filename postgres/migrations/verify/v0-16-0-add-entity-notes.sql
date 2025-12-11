-- Verify civic_os:v0-16-0-add-entity-notes on pg

BEGIN;

-- ============================================================================
-- Verify Table Exists with Correct Structure
-- ============================================================================

SELECT id, entity_type, entity_id, author_id, content, note_type,
       is_internal, created_at, updated_at, deleted_at
FROM metadata.entity_notes
WHERE FALSE;


-- ============================================================================
-- Verify Indexes Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'entity_notes' AND indexname = 'idx_entity_notes_entity';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'entity_notes' AND indexname = 'idx_entity_notes_author';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'entity_notes' AND indexname = 'idx_entity_notes_created';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'entity_notes' AND indexname = 'idx_entity_notes_active';


-- ============================================================================
-- Verify Functions Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'create_entity_note';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'enable_entity_notes';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'add_status_change_note';


-- ============================================================================
-- Verify Row Level Security is Enabled
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'entity_notes' AND rowsecurity = true;


-- ============================================================================
-- Verify RLS Policies Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'entity_notes' AND policyname = 'entity_notes_select';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'entity_notes' AND policyname = 'entity_notes_insert';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'entity_notes' AND policyname = 'entity_notes_update';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'entity_notes' AND policyname = 'entity_notes_delete';


-- ============================================================================
-- Verify metadata.entities Has enable_notes Column
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'entities' AND column_name = 'enable_notes';


-- ============================================================================
-- Verify schema_entities View Includes enable_notes
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'schema_entities' AND column_name = 'enable_notes';


-- ============================================================================
-- Verify public.entity_notes View Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'entity_notes';


-- ============================================================================
-- Verify Constraints Exist
-- ============================================================================

DO $$
BEGIN
    ASSERT EXISTS(
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_not_empty'
          AND conrelid = 'metadata.entity_notes'::regclass
    ), 'content_not_empty constraint missing';

    ASSERT EXISTS(
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_max_length'
          AND conrelid = 'metadata.entity_notes'::regclass
    ), 'content_max_length constraint missing';

    ASSERT EXISTS(
        SELECT 1 FROM pg_constraint
        WHERE conname = 'valid_note_type'
          AND conrelid = 'metadata.entity_notes'::regclass
    ), 'valid_note_type constraint missing';
END $$;


-- ============================================================================
-- Test Functions Actually Work
-- ============================================================================

-- Test create_entity_note() fails gracefully when notes not enabled
DO $$
DECLARE
    v_error_raised BOOLEAN := FALSE;
BEGIN
    BEGIN
        PERFORM create_entity_note('nonexistent_table', '1', 'test');
    EXCEPTION WHEN OTHERS THEN
        v_error_raised := TRUE;
    END;
    ASSERT v_error_raised, 'create_entity_note should raise error for disabled entity';
END $$;

-- Test enable_entity_notes() doesn't error on nonexistent table
-- (it inserts into metadata.entities, which is valid)
DO $$
BEGIN
    -- This should work without error (creates metadata entry)
    PERFORM enable_entity_notes('test_notes_verify_table');

    -- Clean up
    DELETE FROM metadata.permission_roles
    WHERE permission_id IN (
        SELECT id FROM metadata.permissions
        WHERE table_name = 'test_notes_verify_table:notes'
    );
    DELETE FROM metadata.permissions WHERE table_name = 'test_notes_verify_table:notes';
    DELETE FROM metadata.entities WHERE table_name = 'test_notes_verify_table';
END $$;


ROLLBACK;
