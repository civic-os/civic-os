-- Verify civic_os:v0-17-0-add-static-text on pg

BEGIN;

-- ============================================================================
-- Verify Table Exists with Correct Structure
-- ============================================================================

SELECT id, table_name, content, sort_order, column_width,
       show_on_detail, show_on_create, show_on_edit,
       created_at, updated_at
FROM metadata.static_text
WHERE FALSE;


-- ============================================================================
-- Verify Indexes Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'static_text' AND indexname = 'idx_static_text_table';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'static_text' AND indexname = 'idx_static_text_sort';


-- ============================================================================
-- Verify Row Level Security is Enabled
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'static_text' AND rowsecurity = true;


-- ============================================================================
-- Verify RLS Policies Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'static_text' AND policyname = 'static_text_select';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'static_text' AND policyname = 'static_text_insert';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'static_text' AND policyname = 'static_text_update';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'static_text' AND policyname = 'static_text_delete';


-- ============================================================================
-- Verify Public View Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'static_text';


-- ============================================================================
-- Verify Constraints Exist
-- ============================================================================

DO $$
BEGIN
    ASSERT EXISTS(
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_not_empty'
          AND conrelid = 'metadata.static_text'::regclass
    ), 'content_not_empty constraint missing';

    ASSERT EXISTS(
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_max_length'
          AND conrelid = 'metadata.static_text'::regclass
    ), 'content_max_length constraint missing';

    ASSERT EXISTS(
        SELECT 1 FROM pg_constraint
        WHERE conname = 'valid_column_width'
          AND conrelid = 'metadata.static_text'::regclass
    ), 'valid_column_width constraint missing';
END $$;


-- ============================================================================
-- Verify Default Values
-- ============================================================================

DO $$
DECLARE
    v_defaults RECORD;
BEGIN
    -- Get column defaults
    SELECT
        (SELECT column_default FROM information_schema.columns WHERE table_schema = 'metadata' AND table_name = 'static_text' AND column_name = 'sort_order') AS sort_order_default,
        (SELECT column_default FROM information_schema.columns WHERE table_schema = 'metadata' AND table_name = 'static_text' AND column_name = 'column_width') AS column_width_default,
        (SELECT column_default FROM information_schema.columns WHERE table_schema = 'metadata' AND table_name = 'static_text' AND column_name = 'show_on_detail') AS show_on_detail_default,
        (SELECT column_default FROM information_schema.columns WHERE table_schema = 'metadata' AND table_name = 'static_text' AND column_name = 'show_on_create') AS show_on_create_default,
        (SELECT column_default FROM information_schema.columns WHERE table_schema = 'metadata' AND table_name = 'static_text' AND column_name = 'show_on_edit') AS show_on_edit_default
    INTO v_defaults;

    -- Verify defaults exist (exact values may vary by Postgres version format)
    ASSERT v_defaults.sort_order_default IS NOT NULL, 'sort_order should have a default';
    ASSERT v_defaults.column_width_default IS NOT NULL, 'column_width should have a default';
    ASSERT v_defaults.show_on_detail_default IS NOT NULL, 'show_on_detail should have a default';
    ASSERT v_defaults.show_on_create_default IS NOT NULL, 'show_on_create should have a default';
    ASSERT v_defaults.show_on_edit_default IS NOT NULL, 'show_on_edit should have a default';
END $$;


ROLLBACK;
