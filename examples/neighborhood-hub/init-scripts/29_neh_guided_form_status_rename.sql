-- ============================================================================
-- NEH Script 29: Guided Form Status Rename + Business Status Columns
-- ============================================================================
-- Runs AFTER all other NEH init scripts and core migration v0-55-2.
-- v0-55-2 makes core functions column-agnostic (they detect status_id OR
-- guided_form_status_id). This script does the actual rename and adds
-- business status columns.
--
-- Sections:
--   29-0: Fix submit_tool_reservation regression from script 28
--   29-1: Rename status_id → guided_form_status_id on all GF tables
--   29-2: Fix CHECK constraints to reference guided_form_status_id
--   29-3: Update metadata.properties for renamed columns
--   29-4: Add business status_id to mek_requests
--   29-5: Add business status_id to building_use_requests
--   29-6: Fix CHECK constraint from script 28
--   29-7: Hide guided_form_status_id on all parent tables
--   29-8: Recreate notification triggers from script 09 (failed during init)
--   29-9: Schema decision
--
-- No existing NEH init scripts are modified. This follows the migration-first
-- convention: new numbered scripts apply incremental changes on top of existing state.


-- ============================================================================
-- 29-0: Fix submit_tool_reservation regression from script 28
-- ============================================================================
-- Script 28 accidentally writes SET status_id (GF column) instead of
-- workflow_status_id (business column).
-- Fix: use workflow_status_id as script 16 originally intended.

CREATE OR REPLACE FUNCTION public.submit_tool_reservation(p_parent_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, metadata, pg_catalog
AS $$
DECLARE
    v_pending_status_id INT;
BEGIN
    -- Validate at least one tool selected
    IF NOT EXISTS (
        SELECT 1 FROM tool_reservation_tool_items trti
        JOIN tool_reservation_tools trt ON trt.id = trti.tool_reservation_tools_id
        WHERE trt.tool_reservation_id = p_parent_id
    ) THEN
        RAISE EXCEPTION 'At least one tool must be selected before submitting.';
    END IF;

    -- Validate at least one parcel selected
    IF NOT EXISTS (
        SELECT 1 FROM work_site_parcels wsp
        JOIN tool_reservation_work_site ws ON ws.id = wsp.work_site_id
        WHERE ws.tool_reservation_id = p_parent_id
    ) THEN
        RAISE EXCEPTION 'At least one parcel must be selected before submitting.';
    END IF;

    SELECT id INTO v_pending_status_id
    FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'pending';

    -- FIX: Set workflow_status_id (business column), NOT status_id/guided_form_status_id
    UPDATE public.tool_reservations
       SET workflow_status_id = v_pending_status_id,
           display_name = CASE
               WHEN display_name LIKE '% - Submitted' THEN display_name
               ELSE COALESCE(display_name, 'Tool Reservation') || ' - Submitted'
           END
     WHERE id = p_parent_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Your tool reservation has been submitted for review.',
        'navigate_to', '/view/tool_reservations/' || p_parent_id
    );
END;
$$;


-- ============================================================================
-- 29-1: Rename status_id → guided_form_status_id on all GF tables
-- ============================================================================
-- At this point, all init scripts (01-28) have completed and tables have
-- status_id columns. Core functions are column-agnostic (detect either name).
-- Now we do the actual rename.

DO $$ DECLARE rec RECORD; BEGIN
  -- Parent tables
  FOR rec IN SELECT DISTINCT parent_table FROM metadata.guided_forms LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name=rec.parent_table AND column_name='status_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name=rec.parent_table AND column_name='guided_form_status_id')
    THEN
      EXECUTE format('ALTER TABLE public.%I RENAME COLUMN status_id TO guided_form_status_id', rec.parent_table);
    END IF;
  END LOOP;

  -- Step tables (child tables with parent_fk_column set)
  FOR rec IN SELECT DISTINCT step_table FROM metadata.guided_form_steps WHERE parent_fk_column IS NOT NULL LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name=rec.step_table AND column_name='status_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name=rec.step_table AND column_name='guided_form_status_id')
    THEN
      EXECUTE format('ALTER TABLE public.%I RENAME COLUMN status_id TO guided_form_status_id', rec.step_table);
    END IF;
  END LOOP;
END $$;


-- ============================================================================
-- 29-2: Fix CHECK constraints referencing is_guided_form_draft(status_id)
-- ============================================================================
-- ALTER TABLE RENAME COLUMN doesn't update CHECK constraint text. Fix them.

DO $$ DECLARE
  v_con RECORD;
  v_new_expr TEXT;
BEGIN
  FOR v_con IN
    SELECT con.oid, con.conname, cls.relname AS table_name,
           pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
    WHERE con.contype = 'c'
      AND nsp.nspname = 'public'
      AND pg_get_constraintdef(con.oid) LIKE '%is_guided_form_draft(status_id)%'
  LOOP
    v_new_expr := replace(v_con.def, 'is_guided_form_draft(status_id)', 'is_guided_form_draft(guided_form_status_id)');
    v_new_expr := regexp_replace(v_new_expr, '^CHECK \((.*)\)$', '\1');
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_con.table_name, v_con.conname);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)', v_con.table_name, v_con.conname, v_new_expr);
  END LOOP;
END $$;


-- ============================================================================
-- 29-3: Update metadata.properties column references
-- ============================================================================

-- Parent tables: rename the GF status column entry
UPDATE metadata.properties
SET column_name = 'guided_form_status_id'
WHERE column_name = 'status_id'
  AND table_name IN (SELECT parent_table FROM metadata.guided_forms);

-- Step tables: rename hidden GF status column entry
UPDATE metadata.properties
SET column_name = 'guided_form_status_id'
WHERE column_name = 'status_id'
  AND table_name IN (SELECT step_table FROM metadata.guided_form_steps WHERE parent_fk_column IS NOT NULL);


-- ============================================================================
-- 29-4: mek_requests — Add business status_id column
-- ============================================================================
-- After the rename, the old dual-duty status_id is now guided_form_status_id.
-- Add a new status_id column for business workflow.

-- 29-4a: Add the column
ALTER TABLE mek_requests ADD COLUMN IF NOT EXISTS status_id INT REFERENCES metadata.statuses(id);
CREATE INDEX IF NOT EXISTS idx_mek_requests_business_status ON mek_requests(status_id);

-- 29-4b: Data migration — for submitted records, the old status_id (now
-- guided_form_status_id) holds the business status value (e.g., 'pending',
-- 'approved'). Move it to the new column and restore GF status to 'submitted'.
UPDATE mek_requests
SET status_id = guided_form_status_id,
    guided_form_status_id = (SELECT id FROM metadata.statuses
                             WHERE entity_type = 'guided_form' AND status_key = 'submitted')
WHERE submitted_at IS NOT NULL
  AND status_id IS NULL;

-- 29-4c: Metadata properties for the visible business status
INSERT INTO metadata.properties (table_name, column_name, display_name, status_entity_type,
    sort_order, show_on_list, show_on_detail, show_on_create, show_on_edit, filterable)
VALUES ('mek_requests', 'status_id', 'Status', 'mek_requests', 1,
    true, true, false, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    status_entity_type = EXCLUDED.status_entity_type,
    sort_order = EXCLUDED.sort_order,
    show_on_list = EXCLUDED.show_on_list,
    show_on_detail = EXCLUDED.show_on_detail,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit,
    filterable = EXCLUDED.filterable;

-- 29-4d: Recreate notification trigger on new business status_id
DROP TRIGGER IF EXISTS trg_mek_request_status_change ON mek_requests;
CREATE TRIGGER trg_mek_request_status_change
    AFTER UPDATE OF status_id ON public.mek_requests
    FOR EACH ROW
    WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION public.notify_mek_request_status_change();


-- ============================================================================
-- 29-5: building_use_requests — Add business status_id column
-- ============================================================================

-- 29-5a: Add the column
ALTER TABLE building_use_requests ADD COLUMN IF NOT EXISTS status_id INT REFERENCES metadata.statuses(id);
CREATE INDEX IF NOT EXISTS idx_building_use_requests_business_status ON building_use_requests(status_id);

-- 29-5b: Data migration
UPDATE building_use_requests
SET status_id = guided_form_status_id,
    guided_form_status_id = (SELECT id FROM metadata.statuses
                             WHERE entity_type = 'guided_form' AND status_key = 'submitted')
WHERE submitted_at IS NOT NULL
  AND status_id IS NULL;

-- 29-5c: Metadata properties for the visible business status
INSERT INTO metadata.properties (table_name, column_name, display_name, status_entity_type,
    sort_order, show_on_list, show_on_detail, show_on_create, show_on_edit, filterable)
VALUES ('building_use_requests', 'status_id', 'Status', 'building_use_requests', 1,
    true, true, false, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    status_entity_type = EXCLUDED.status_entity_type,
    sort_order = EXCLUDED.sort_order,
    show_on_list = EXCLUDED.show_on_list,
    show_on_detail = EXCLUDED.show_on_detail,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit,
    filterable = EXCLUDED.filterable;

-- 29-5d: Recreate triggers on new business status_id
DROP TRIGGER IF EXISTS trg_building_use_overlap ON building_use_requests;
CREATE TRIGGER trg_building_use_overlap
    BEFORE UPDATE OF status_id ON public.building_use_requests
    FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION public.check_building_use_approval_overlap();

DROP TRIGGER IF EXISTS trg_notify_building_use_request_update ON building_use_requests;
CREATE TRIGGER trg_notify_building_use_request_update
    AFTER UPDATE OF status_id ON public.building_use_requests
    FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION public.notify_building_use_request_status_change();


-- ============================================================================
-- 29-6: Fix CHECK constraint from script 28
-- ============================================================================
-- Script 28 adds mek_requests_timeslot_required_wfcheck with
-- is_guided_form_draft(status_id). After rename, status_id is the new
-- business column. Override to use guided_form_status_id.

ALTER TABLE mek_requests DROP CONSTRAINT IF EXISTS mek_requests_timeslot_required_wfcheck;
ALTER TABLE mek_requests ADD CONSTRAINT mek_requests_timeslot_required_wfcheck
    CHECK (is_guided_form_draft(guided_form_status_id) OR timeslot IS NOT NULL);


-- ============================================================================
-- 29-7: Hide guided_form_status_id on all parent tables
-- ============================================================================

UPDATE metadata.properties
SET show_on_list = false,
    show_on_detail = false,
    show_on_create = false,
    show_on_edit = false,
    filterable = false,
    display_name = 'Form Status'
WHERE column_name = 'guided_form_status_id'
  AND table_name IN ('tool_reservations', 'mek_requests', 'building_use_requests');


-- ============================================================================
-- 29-8: Recreate notification triggers from script 09
-- ============================================================================
-- Script 09 tried to create these triggers on status_id, but at that point
-- status_id had already been detected by register_guided_form(). Now the
-- column is renamed to guided_form_status_id, and business status_id exists
-- on mek_requests and building_use_requests (from 29-4, 29-5 above).
-- tool_reservations uses workflow_status_id for business (from script 16).

-- tool_reservations: notification trigger should fire on workflow_status_id
DROP TRIGGER IF EXISTS trg_notify_tool_reservation_update ON public.tool_reservations;
CREATE TRIGGER trg_notify_tool_reservation_update
    AFTER UPDATE OF workflow_status_id ON public.tool_reservations
    FOR EACH ROW WHEN (OLD.workflow_status_id IS DISTINCT FROM NEW.workflow_status_id)
    EXECUTE FUNCTION public.notify_tool_reservation_status_change();


-- ============================================================================
-- 29-9: Schema decision
-- ============================================================================

-- Direct INSERT (not create_schema_decision RPC) because init scripts run
-- without JWT context.
INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, decision, decided_date
) VALUES (
    ARRAY['tool_reservations', 'mek_requests', 'building_use_requests']::NAME[], 'neh-29-guided-form-status-rename',
    'Rename guided form status_id to guided_form_status_id (v0.55.2)',
    'accepted',
    'Renamed the framework-managed guided form lifecycle column from status_id to guided_form_status_id. '
    'This makes the column self-documenting and frees status_id for natural business workflow use. '
    'mek_requests and building_use_requests now have dual columns: guided_form_status_id (framework) '
    'and status_id (business). tool_reservations keeps workflow_status_id for business (too many references to rename).',
    CURRENT_DATE
);

NOTIFY pgrst, 'reload schema';
