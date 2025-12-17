-- =============================================================================
-- Recurring Schedule Integration Tests
-- =============================================================================
-- Tests for v0.19.0 recurring time slot functionality
-- Run with: psql $DATABASE_URL -f test_recurring_schedule.sql
--
-- These tests verify:
-- 1. Series creation queues expansion job
-- 2. Template merging (preserves required fields on partial updates)
-- 3. Series splitting for "this and future" edits
-- 4. Cancel occurrence behavior
-- 5. Update series template behavior
-- 6. Delete series cleanup
--
-- NOTE: Actual instance expansion is done by Go worker (not tested here).
-- These tests verify RPC correctness and River job queuing.
-- =============================================================================

\set ON_ERROR_STOP on

-- Helper function for assertions
CREATE OR REPLACE FUNCTION _test_assert(
    condition BOOLEAN,
    message TEXT
) RETURNS VOID AS $$
BEGIN
    IF NOT condition THEN
        RAISE EXCEPTION 'ASSERTION FAILED: %', message;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Helper function to set test user context
CREATE OR REPLACE FUNCTION _test_set_user(user_id UUID) RETURNS VOID AS $$
BEGIN
    PERFORM set_config('request.jwt.claim.sub', user_id::TEXT, TRUE);
    PERFORM set_config('request.jwt.claim.civic_os_roles', 'admin', TRUE);
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- TEST SETUP: Create test entity table
-- =============================================================================
DO $$
BEGIN
    -- Clean up any previous test data first
    DELETE FROM metadata.time_slot_instances WHERE entity_table = '_test_bookings';
    DELETE FROM metadata.time_slot_series WHERE entity_table = '_test_bookings';
    DELETE FROM metadata.time_slot_series_groups WHERE display_name LIKE 'Test%';

    -- Drop and recreate test table to ensure clean state
    DROP TABLE IF EXISTS public._test_bookings CASCADE;

    CREATE TABLE public._test_bookings (
        id BIGSERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL,
        purpose TEXT NOT NULL,
        time_slot time_slot NOT NULL,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Grant permissions
    GRANT ALL ON public._test_bookings TO authenticated;
    GRANT USAGE, SELECT ON SEQUENCE _test_bookings_id_seq TO authenticated;

    -- Register in metadata.entities (required for template validation)
    DELETE FROM metadata.entities WHERE table_name = '_test_bookings';
    INSERT INTO metadata.entities (table_name, display_name)
    VALUES ('_test_bookings', 'Test Bookings');

    -- Register properties in metadata (show_on_edit=TRUE allows template validation)
    DELETE FROM metadata.properties WHERE table_name = '_test_bookings';
    INSERT INTO metadata.properties (table_name, column_name, show_on_edit)
    VALUES
        ('_test_bookings', 'room_id', TRUE),
        ('_test_bookings', 'purpose', TRUE),
        ('_test_bookings', 'time_slot', TRUE),
        ('_test_bookings', 'notes', TRUE);

    -- Clean up any orphaned River jobs
    DELETE FROM metadata.river_job WHERE kind = 'expand_recurring_series'
        AND (args->>'series_id')::TEXT IN (
            SELECT id::TEXT FROM metadata.time_slot_series WHERE entity_table = '_test_bookings'
        );

    RAISE NOTICE 'Test setup complete';
END $$;


-- =============================================================================
-- TEST 1: Create recurring series queues expansion job
-- =============================================================================
DO $$
DECLARE
    v_result JSONB;
    v_group_id BIGINT;
    v_series_id BIGINT;
    v_job_count INT;
    v_template JSONB;
BEGIN
    RAISE NOTICE '--- TEST 1: Create recurring series ---';

    -- Set test user
    PERFORM _test_set_user('00000000-0000-0000-0000-000000000001'::UUID);

    -- Create a weekly series (using named parameters to match function signature)
    v_result := public.create_recurring_series(
        p_group_name := 'Test Weekly Series',
        p_group_description := 'Test description',
        p_group_color := '#FF0000',
        p_entity_table := '_test_bookings',
        p_entity_template := '{"room_id": 1, "purpose": "Weekly Meeting", "notes": "Test notes"}'::JSONB,
        p_rrule := 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
        p_dtstart := '2026-01-05T10:00:00Z'::TIMESTAMPTZ,
        p_duration := '01:00:00'::INTERVAL,
        p_timezone := 'America/New_York',
        p_time_slot_property := 'time_slot',
        p_expand_now := TRUE,  -- Queue expansion job
        p_skip_conflicts := FALSE
    );

    -- Verify success
    PERFORM _test_assert(
        (v_result->>'success')::BOOLEAN = TRUE,
        format('create_recurring_series should succeed: %s', v_result->>'message')
    );

    v_group_id := (v_result->>'group_id')::BIGINT;
    v_series_id := (v_result->>'series_id')::BIGINT;

    -- Verify group was created
    PERFORM _test_assert(
        EXISTS(SELECT 1 FROM metadata.time_slot_series_groups WHERE id = v_group_id),
        'Series group should exist'
    );

    -- Verify series was created with correct template
    SELECT entity_template INTO v_template
    FROM metadata.time_slot_series
    WHERE id = v_series_id;

    PERFORM _test_assert(
        v_template ? 'room_id' AND v_template ? 'purpose' AND v_template ? 'notes',
        'Series template should have all fields'
    );

    -- Verify River job was queued
    SELECT COUNT(*) INTO v_job_count
    FROM metadata.river_job
    WHERE kind = 'expand_recurring_series'
      AND (args->>'series_id')::BIGINT = v_series_id;

    PERFORM _test_assert(
        v_job_count > 0,
        'Expansion job should be queued in River'
    );

    RAISE NOTICE 'TEST 1: PASSED - Created series %, queued expansion job', v_series_id;
END $$;


-- =============================================================================
-- TEST 2: Template merge on split_series_from_date
-- =============================================================================
DO $$
DECLARE
    v_series_id BIGINT;
    v_new_series_id BIGINT;
    v_result JSONB;
    v_original_template JSONB;
    v_new_template JSONB;
BEGIN
    RAISE NOTICE '--- TEST 2: Template merge on split ---';

    PERFORM _test_set_user('00000000-0000-0000-0000-000000000001'::UUID);

    -- Get the series we created in test 1
    SELECT id, entity_template INTO v_series_id, v_original_template
    FROM metadata.time_slot_series
    WHERE entity_table = '_test_bookings'
    ORDER BY id
    LIMIT 1;

    -- Verify original has room_id
    PERFORM _test_assert(
        v_original_template ? 'room_id',
        'Original template should have room_id'
    );

    -- Split with PARTIAL template (missing room_id!)
    v_result := public.split_series_from_date(
        v_series_id,
        '2026-01-19'::DATE,
        '2026-01-19T14:00:00Z'::TIMESTAMPTZ,
        '01:30:00'::INTERVAL,
        '{"purpose": "Updated Meeting", "notes": "Changed to afternoon"}'::JSONB  -- NO room_id!
    );

    PERFORM _test_assert(
        (v_result->>'success')::BOOLEAN = TRUE,
        format('split_series_from_date should succeed: %s', v_result->>'message')
    );

    v_new_series_id := (v_result->>'new_series_id')::BIGINT;

    -- Get new series template
    SELECT entity_template INTO v_new_template
    FROM metadata.time_slot_series
    WHERE id = v_new_series_id;

    -- CRITICAL: Verify room_id was preserved (the bug we fixed!)
    PERFORM _test_assert(
        v_new_template ? 'room_id',
        'New template should preserve room_id from original'
    );

    PERFORM _test_assert(
        (v_new_template->>'room_id')::INT = 1,
        format('room_id should be 1, got %s', v_new_template->>'room_id')
    );

    -- Verify updated fields took effect
    PERFORM _test_assert(
        v_new_template->>'purpose' = 'Updated Meeting',
        'purpose should be updated'
    );

    -- Verify both series are in same group
    PERFORM _test_assert(
        (SELECT group_id FROM metadata.time_slot_series WHERE id = v_series_id) =
        (SELECT group_id FROM metadata.time_slot_series WHERE id = v_new_series_id),
        'Split series should be in same group'
    );

    RAISE NOTICE 'TEST 2: PASSED - Template merge preserved room_id';
END $$;


-- =============================================================================
-- TEST 3: Template merge on update_series_template
-- =============================================================================
DO $$
DECLARE
    v_series_id BIGINT;
    v_result JSONB;
    v_template_before JSONB;
    v_template_after JSONB;
BEGIN
    RAISE NOTICE '--- TEST 3: Template merge on update ---';

    PERFORM _test_set_user('00000000-0000-0000-0000-000000000001'::UUID);

    -- Create a series with instances for this test (we need entity records to update)
    -- First create a new series
    v_result := public.create_recurring_series(
        p_group_name := 'Test Update Series',
        p_entity_table := '_test_bookings',
        p_entity_template := '{"room_id": 2, "purpose": "Update Test Series", "notes": "Original notes"}'::JSONB,
        p_rrule := 'FREQ=DAILY;COUNT=2',
        p_dtstart := '2026-03-01T09:00:00Z'::TIMESTAMPTZ,
        p_duration := '00:30:00'::INTERVAL,
        p_timezone := 'UTC',
        p_time_slot_property := 'time_slot'
    );

    v_series_id := (v_result->>'series_id')::BIGINT;

    -- Get template before update
    SELECT entity_template INTO v_template_before
    FROM metadata.time_slot_series
    WHERE id = v_series_id;

    PERFORM _test_assert(
        v_template_before ? 'room_id',
        'Template should have room_id before update'
    );

    -- Update with PARTIAL template (missing room_id!)
    v_result := public.update_series_template(
        v_series_id,
        '{"purpose": "Renamed Test Series", "notes": "Updated notes"}'::JSONB
    );

    PERFORM _test_assert(
        (v_result->>'success')::BOOLEAN = TRUE,
        format('update_series_template should succeed: %s', v_result->>'message')
    );

    -- Get updated template
    SELECT entity_template INTO v_template_after
    FROM metadata.time_slot_series
    WHERE id = v_series_id;

    -- CRITICAL: Verify room_id was preserved
    PERFORM _test_assert(
        v_template_after ? 'room_id',
        'Template should preserve room_id after partial update'
    );

    PERFORM _test_assert(
        (v_template_after->>'room_id')::INT = 2,
        format('room_id should still be 2, got %s', v_template_after->>'room_id')
    );

    -- Verify updates applied
    PERFORM _test_assert(
        v_template_after->>'purpose' = 'Renamed Test Series',
        'purpose should be updated'
    );

    RAISE NOTICE 'TEST 3: PASSED - Template merge on update preserved room_id';
END $$;


-- =============================================================================
-- TEST 4: Cancel occurrence (with manually created instance)
-- =============================================================================
DO $$
DECLARE
    v_series_id BIGINT;
    v_entity_id BIGINT;
    v_instance_id BIGINT;
    v_result JSONB;
    v_is_exception BOOLEAN;
    v_exception_type TEXT;
    v_entity_exists BOOLEAN;
BEGIN
    RAISE NOTICE '--- TEST 4: Cancel occurrence ---';

    PERFORM _test_set_user('00000000-0000-0000-0000-000000000001'::UUID);

    -- Get a series
    SELECT id INTO v_series_id
    FROM metadata.time_slot_series
    WHERE entity_table = '_test_bookings'
    ORDER BY id
    LIMIT 1;

    -- Manually create an entity and instance for testing cancel
    INSERT INTO public._test_bookings (room_id, purpose, time_slot, notes)
    VALUES (1, 'Test Cancel Booking', tstzrange('2026-01-05 10:00:00+00', '2026-01-05 11:00:00+00', '[)'), 'For cancel test')
    RETURNING id INTO v_entity_id;

    INSERT INTO metadata.time_slot_instances (series_id, occurrence_date, entity_table, entity_id, is_exception)
    VALUES (v_series_id, '2026-01-05', '_test_bookings', v_entity_id, FALSE)
    RETURNING id INTO v_instance_id;

    -- Verify entity exists before cancel
    SELECT EXISTS(SELECT 1 FROM public._test_bookings WHERE id = v_entity_id)
    INTO v_entity_exists;

    PERFORM _test_assert(v_entity_exists, 'Entity should exist before cancel');

    -- Cancel the occurrence
    v_result := public.cancel_series_occurrence(
        '_test_bookings',
        v_entity_id,
        'Test cancellation reason'
    );

    PERFORM _test_assert(
        (v_result->>'success')::BOOLEAN = TRUE,
        format('cancel_series_occurrence should succeed: %s', v_result->>'message')
    );

    -- Verify entity was deleted
    SELECT EXISTS(SELECT 1 FROM public._test_bookings WHERE id = v_entity_id)
    INTO v_entity_exists;

    PERFORM _test_assert(
        NOT v_entity_exists,
        'Entity should be deleted after cancel'
    );

    -- Verify instance marked as cancelled exception
    SELECT is_exception, exception_type
    INTO v_is_exception, v_exception_type
    FROM metadata.time_slot_instances
    WHERE id = v_instance_id;

    PERFORM _test_assert(
        v_is_exception = TRUE,
        'Instance should be marked as exception'
    );

    PERFORM _test_assert(
        v_exception_type = 'cancelled',
        format('Exception type should be cancelled, got %s', v_exception_type)
    );

    RAISE NOTICE 'TEST 4: PASSED - Cancel deleted entity, marked instance as cancelled';
END $$;


-- =============================================================================
-- TEST 5: Delete series with instances
-- =============================================================================
DO $$
DECLARE
    v_result JSONB;
    v_series_id BIGINT;
    v_entity_id BIGINT;
BEGIN
    RAISE NOTICE '--- TEST 5: Delete series with instances ---';

    PERFORM _test_set_user('00000000-0000-0000-0000-000000000001'::UUID);

    -- Create a series for deletion test (using named parameters)
    v_result := public.create_recurring_series(
        p_group_name := 'Test Delete Series',
        p_entity_table := '_test_bookings',
        p_entity_template := '{"room_id": 3, "purpose": "Delete Test"}'::JSONB,
        p_rrule := 'FREQ=DAILY;COUNT=1',
        p_dtstart := '2026-04-01T10:00:00Z'::TIMESTAMPTZ,
        p_duration := '01:00:00'::INTERVAL,
        p_timezone := 'UTC',
        p_time_slot_property := 'time_slot'
    );

    v_series_id := (v_result->>'series_id')::BIGINT;

    -- Manually create an instance with entity
    INSERT INTO public._test_bookings (room_id, purpose, time_slot)
    VALUES (3, 'Delete Test', tstzrange('2026-04-01 10:00:00+00', '2026-04-01 11:00:00+00', '[)'))
    RETURNING id INTO v_entity_id;

    INSERT INTO metadata.time_slot_instances (series_id, occurrence_date, entity_table, entity_id, is_exception)
    VALUES (v_series_id, '2026-04-01', '_test_bookings', v_entity_id, FALSE);

    -- Delete the series
    v_result := public.delete_series_with_instances(v_series_id);

    PERFORM _test_assert(
        (v_result->>'success')::BOOLEAN = TRUE,
        format('delete_series_with_instances should succeed: %s', v_result->>'message')
    );

    -- Verify series deleted
    PERFORM _test_assert(
        NOT EXISTS(SELECT 1 FROM metadata.time_slot_series WHERE id = v_series_id),
        'Series should be deleted'
    );

    -- Verify instances deleted
    PERFORM _test_assert(
        NOT EXISTS(SELECT 1 FROM metadata.time_slot_instances WHERE series_id = v_series_id),
        'Instances should be deleted'
    );

    -- Verify entity record deleted
    PERFORM _test_assert(
        NOT EXISTS(SELECT 1 FROM public._test_bookings WHERE id = v_entity_id),
        'Entity record should be deleted'
    );

    RAISE NOTICE 'TEST 5: PASSED - Delete cleaned up series, instances, and entities';
END $$;


-- =============================================================================
-- TEST 6: Series membership check
-- =============================================================================
DO $$
DECLARE
    v_result JSONB;
    v_series_id BIGINT;
    v_entity_id BIGINT;
BEGIN
    RAISE NOTICE '--- TEST 6: Series membership check ---';

    PERFORM _test_set_user('00000000-0000-0000-0000-000000000001'::UUID);

    -- Get a series
    SELECT id INTO v_series_id
    FROM metadata.time_slot_series
    WHERE entity_table = '_test_bookings'
    ORDER BY id
    LIMIT 1;

    -- Create entity and instance
    INSERT INTO public._test_bookings (room_id, purpose, time_slot)
    VALUES (1, 'Membership Test', tstzrange('2026-05-01 10:00:00+00', '2026-05-01 11:00:00+00', '[)'))
    RETURNING id INTO v_entity_id;

    INSERT INTO metadata.time_slot_instances (series_id, occurrence_date, entity_table, entity_id, is_exception)
    VALUES (v_series_id, '2026-05-01', '_test_bookings', v_entity_id, FALSE);

    -- Check membership for existing entity
    v_result := public.get_series_membership('_test_bookings', v_entity_id);

    PERFORM _test_assert(
        (v_result->>'is_member')::BOOLEAN = TRUE,
        'Entity should be a series member'
    );

    PERFORM _test_assert(
        (v_result->>'series_id')::BIGINT = v_series_id,
        'Should return correct series_id'
    );

    -- Check non-member
    v_result := public.get_series_membership('_test_bookings', 999999);

    PERFORM _test_assert(
        (v_result->>'is_member')::BOOLEAN = FALSE,
        'Non-existent entity should not be a member'
    );

    RAISE NOTICE 'TEST 6: PASSED - Membership check works correctly';
END $$;


-- =============================================================================
-- TEST 7: Update series schedule queues expansion job
-- =============================================================================
DO $$
DECLARE
    v_series_id BIGINT;
    v_result JSONB;
    v_job_count_before INT;
    v_job_count_after INT;
BEGIN
    RAISE NOTICE '--- TEST 7: Update schedule queues expansion ---';

    PERFORM _test_set_user('00000000-0000-0000-0000-000000000001'::UUID);

    -- Get a series
    SELECT id INTO v_series_id
    FROM metadata.time_slot_series
    WHERE entity_table = '_test_bookings'
    ORDER BY id
    LIMIT 1;

    -- Count jobs before
    SELECT COUNT(*) INTO v_job_count_before
    FROM metadata.river_job
    WHERE kind = 'expand_recurring_series';

    -- Update schedule
    v_result := public.update_series_schedule(
        v_series_id,
        '2026-02-01T11:00:00Z'::TIMESTAMPTZ,
        '01:30:00'::INTERVAL,
        'FREQ=WEEKLY;BYDAY=TU;COUNT=8'
    );

    PERFORM _test_assert(
        (v_result->>'success')::BOOLEAN = TRUE,
        format('update_series_schedule should succeed: %s', v_result->>'message')
    );

    -- Count jobs after
    SELECT COUNT(*) INTO v_job_count_after
    FROM metadata.river_job
    WHERE kind = 'expand_recurring_series';

    PERFORM _test_assert(
        v_job_count_after > v_job_count_before,
        'Should queue new expansion job'
    );

    -- Verify series was updated
    PERFORM _test_assert(
        EXISTS(
            SELECT 1 FROM metadata.time_slot_series
            WHERE id = v_series_id
            AND rrule = 'FREQ=WEEKLY;BYDAY=TU;COUNT=8'
        ),
        'Series RRULE should be updated'
    );

    RAISE NOTICE 'TEST 7: PASSED - Update schedule queued expansion job';
END $$;


-- =============================================================================
-- TEST 8: Delete series group validates existence
-- =============================================================================
DO $$
DECLARE
    v_result JSONB;
BEGIN
    RAISE NOTICE '--- TEST 8: Delete non-existent group ---';

    PERFORM _test_set_user('00000000-0000-0000-0000-000000000001'::UUID);

    -- Try to delete non-existent group
    v_result := public.delete_series_group(999999);

    PERFORM _test_assert(
        (v_result->>'success')::BOOLEAN = FALSE,
        'Should fail for non-existent group'
    );

    PERFORM _test_assert(
        v_result->>'message' LIKE '%not found%',
        format('Should return not found message, got: %s', v_result->>'message')
    );

    RAISE NOTICE 'TEST 8: PASSED - Delete validates group existence';
END $$;


-- =============================================================================
-- CLEANUP
-- =============================================================================
DO $$
DECLARE
    v_group_id BIGINT;
BEGIN
    RAISE NOTICE '--- CLEANUP ---';

    -- Set test user for cleanup operations
    PERFORM _test_set_user('00000000-0000-0000-0000-000000000001'::UUID);

    -- Delete series groups using the proper RPC (which handles cascade)
    FOR v_group_id IN
        SELECT id FROM metadata.time_slot_series_groups
        WHERE display_name LIKE 'Test%'
    LOOP
        PERFORM public.delete_series_group(v_group_id);
    END LOOP;

    -- Clean up any orphaned instances that might remain
    DELETE FROM metadata.time_slot_instances WHERE entity_table = '_test_bookings';

    -- Clean up test entity records
    DELETE FROM public._test_bookings;

    -- Clean up River jobs
    DELETE FROM metadata.river_job WHERE kind = 'expand_recurring_series';

    -- Clean up metadata registrations
    DELETE FROM metadata.properties WHERE table_name = '_test_bookings';
    DELETE FROM metadata.entities WHERE table_name = '_test_bookings';

    -- Drop test table
    DROP TABLE IF EXISTS public._test_bookings CASCADE;

    -- Drop helper functions
    DROP FUNCTION IF EXISTS _test_assert(BOOLEAN, TEXT);
    DROP FUNCTION IF EXISTS _test_set_user(UUID);

    RAISE NOTICE 'Cleanup complete';
    RAISE NOTICE '';
    RAISE NOTICE '==========================================';
    RAISE NOTICE 'ALL RECURRING SCHEDULE TESTS PASSED';
    RAISE NOTICE '==========================================';
END $$;
