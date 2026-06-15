-- ============================================================================
-- NEH Script 32: Fix guided form wfcheck constraints
-- ============================================================================
-- building_use_requests and mek_requests have _wfcheck CHECK constraints that
-- block INSERT because is_guided_form_draft() evaluates to FALSE.
--
-- Root cause: After the status_id → guided_form_status_id rename (script 29),
-- either the constraint references the wrong column (the new business status_id
-- instead of guided_form_status_id), or the DEFAULT is missing so the column is
-- NULL at insert time and is_guided_form_draft(NULL) → FALSE.
--
-- Fix:
--   1. Ensure guided_form_status_id has correct DEFAULT on all GF parent tables
--   2. Rebuild wfcheck constraints via rebuild_guided_form_constraints()
--
-- tool_reservations has no validations/wfcheck constraints, so no fix needed.
-- ============================================================================

-- 1. Ensure guided_form_status_id DEFAULT is set correctly
ALTER TABLE building_use_requests
    ALTER COLUMN guided_form_status_id SET DEFAULT get_initial_status('guided_form');

ALTER TABLE mek_requests
    ALTER COLUMN guided_form_status_id SET DEFAULT get_initial_status('guided_form');

ALTER TABLE tool_reservations
    ALTER COLUMN guided_form_status_id SET DEFAULT get_initial_status('guided_form');

-- 2. Rebuild wfcheck constraints using the correct column (guided_form_status_id)
SELECT metadata.rebuild_guided_form_constraints('building_use_requests');
SELECT metadata.rebuild_guided_form_constraints('mek_requests');

-- 3. Schema decision (ADR)
-- Direct INSERT because init scripts run without JWT context.
INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, decision, decided_date
) VALUES (
    ARRAY['building_use_requests', 'mek_requests', 'tool_reservations']::NAME[], 'neh-32-fix-wfcheck',
    'Fix guided form wfcheck constraints after status column rename',
    'accepted',
    'After the status_id → guided_form_status_id rename (script 29), wfcheck CHECK constraints '
    'could reference the wrong column or the guided_form_status_id DEFAULT could be missing, '
    'causing is_guided_form_draft(NULL) → FALSE and blocking guided form creation. '
    'Fix: re-set DEFAULT get_initial_status(''guided_form'') on all three GF parent tables '
    'and rebuild wfcheck constraints via rebuild_guided_form_constraints().',
    CURRENT_DATE
);

NOTIFY pgrst, 'reload schema';
