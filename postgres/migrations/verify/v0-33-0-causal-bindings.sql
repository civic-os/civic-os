-- Verify civic_os:v0-33-0-causal-bindings on pg

BEGIN;

-- ============================================================================
-- 1. VERIFY status_transitions TABLE EXISTS WITH EXPECTED COLUMNS
-- ============================================================================

SELECT id, entity_type, from_status_id, to_status_id,
       on_transition_rpc, display_name, description,
       sort_order, is_enabled, created_at, updated_at
FROM metadata.status_transitions WHERE FALSE;


-- ============================================================================
-- 2. VERIFY property_change_triggers TABLE EXISTS WITH EXPECTED COLUMNS
-- ============================================================================

SELECT id, table_name, property_name, change_type, change_value,
       function_name, display_name, description,
       sort_order, is_enabled, created_at, updated_at
FROM metadata.property_change_triggers WHERE FALSE;


-- ============================================================================
-- 3. VERIFY RLS IS ENABLED ON BOTH TABLES
-- ============================================================================

DO $$
BEGIN
    -- status_transitions RLS
    ASSERT (
        SELECT relrowsecurity FROM pg_class
        WHERE relname = 'status_transitions'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'metadata')
    ), 'RLS not enabled on metadata.status_transitions';

    -- property_change_triggers RLS
    ASSERT (
        SELECT relrowsecurity FROM pg_class
        WHERE relname = 'property_change_triggers'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'metadata')
    ), 'RLS not enabled on metadata.property_change_triggers';
END;
$$;


-- ============================================================================
-- 4. VERIFY RLS POLICIES EXIST (4 per table = 8 total)
-- ============================================================================

DO $$
DECLARE
    v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM pg_policies
    WHERE schemaname = 'metadata'
      AND tablename = 'status_transitions';
    ASSERT v_count = 4,
        format('Expected 4 RLS policies on status_transitions, found %s', v_count);

    SELECT COUNT(*) INTO v_count
    FROM pg_policies
    WHERE schemaname = 'metadata'
      AND tablename = 'property_change_triggers';
    ASSERT v_count = 4,
        format('Expected 4 RLS policies on property_change_triggers, found %s', v_count);
END;
$$;


-- ============================================================================
-- 5. VERIFY INDEXES EXIST
-- ============================================================================

DO $$
BEGIN
    -- status_transitions indexes
    ASSERT EXISTS(
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'metadata' AND indexname = 'idx_status_transitions_entity_type'
    ), 'Missing index: idx_status_transitions_entity_type';

    ASSERT EXISTS(
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'metadata' AND indexname = 'idx_status_transitions_from'
    ), 'Missing index: idx_status_transitions_from';

    ASSERT EXISTS(
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'metadata' AND indexname = 'idx_status_transitions_to'
    ), 'Missing index: idx_status_transitions_to';

    ASSERT EXISTS(
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'metadata' AND indexname = 'idx_status_transitions_rpc'
    ), 'Missing index: idx_status_transitions_rpc';

    -- property_change_triggers indexes
    ASSERT EXISTS(
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'metadata' AND indexname = 'idx_property_change_triggers_unique'
    ), 'Missing index: idx_property_change_triggers_unique';

    ASSERT EXISTS(
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'metadata' AND indexname = 'idx_property_change_triggers_table'
    ), 'Missing index: idx_property_change_triggers_table';

    ASSERT EXISTS(
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'metadata' AND indexname = 'idx_property_change_triggers_table_property'
    ), 'Missing index: idx_property_change_triggers_table_property';

    ASSERT EXISTS(
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'metadata' AND indexname = 'idx_property_change_triggers_function'
    ), 'Missing index: idx_property_change_triggers_function';
END;
$$;


-- ============================================================================
-- 6. VERIFY HELPER FUNCTIONS EXIST
-- ============================================================================

DO $$
BEGIN
    ASSERT EXISTS(
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'add_status_transition'
    ), 'Missing function: public.add_status_transition';

    ASSERT EXISTS(
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'add_property_change_trigger'
    ), 'Missing function: public.add_property_change_trigger';
END;
$$;


-- ============================================================================
-- 7. VERIFY 'causal' CATEGORY IN schema_entity_dependencies
-- ============================================================================
-- The view should now use 'causal' instead of 'behavioral' for RPC/trigger deps.
-- We verify by checking the view definition contains 'causal'.

DO $$
DECLARE
    v_def TEXT;
BEGIN
    SELECT pg_get_viewdef('public.schema_entity_dependencies'::regclass) INTO v_def;
    ASSERT v_def LIKE '%causal%',
        'schema_entity_dependencies view should contain ''causal'' category';
    ASSERT v_def NOT LIKE '%behavioral%',
        'schema_entity_dependencies view should not contain ''behavioral'' category';
END;
$$;


-- ============================================================================
-- 8. VERIFY schema_entity_dependencies VIEW STILL WORKS
-- ============================================================================

SELECT source_entity, target_entity, relationship_type, via_column, via_object, category
FROM public.schema_entity_dependencies WHERE FALSE;


ROLLBACK;
