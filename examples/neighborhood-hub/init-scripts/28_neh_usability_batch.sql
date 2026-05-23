-- Neighborhood Engagement Hub — Usability Batch Fixes
--
-- Combined script for post-v0.55 usability issues surfaced during NEH staff testing.
-- Sections are numbered 28-N for cross-reference with the planning document.
--
-- Sections:
--   28-0: MEK timeslot nullable for guided form drafts (absorbed from old script 28)
--   28-0b: MEK checkouts status FK constraint fix
--   28-1: Show all parcels on parcel select
--   28-3: Parcel search split indexing (requires F1 name_search_tokens migration)
--   28-4: Enforce ≥1 tool before submit (tool reservations + MEK)
--   28-7: Organization field on tool reservations
--   28-8: Remove Report Damage, add damage+notes to Mark Returned
--   28-9: Add checkout_notes to Confirm Checkout
--   28-10: Qty-managed checkout item cascading params
--   28-11: Update Address borrower action
--   28-12: Filter checkout "Add Item" tool type dropdowns by inventory module

BEGIN;

-- ============================================================================
-- 28-0: MEK TIMESLOT NULLABLE FOR GUIDED FORM DRAFTS
-- ============================================================================
-- (Previously 28_neh_mek_timeslot_nullable.sql — absorbed into combined script)
-- Problem: mek_requests.timeslot is NOT NULL with no default. Guided forms create
-- a draft row on the first step before the borrower fills in the timeslot.

DO $$
BEGIN
    -- Only run if column is still NOT NULL (idempotent for re-runs)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'mek_requests' AND column_name = 'timeslot' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE mek_requests ALTER COLUMN timeslot DROP NOT NULL;
    END IF;
END $$;

-- Add CHECK constraint if it doesn't already exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'mek_requests_timeslot_required_wfcheck'
    ) THEN
        ALTER TABLE mek_requests ADD CONSTRAINT mek_requests_timeslot_required_wfcheck
            CHECK (is_guided_form_draft(status_id) OR timeslot IS NOT NULL);
    END IF;
END $$;


-- ============================================================================
-- 28-0b: MEK CHECKOUTS STATUS FK CONSTRAINT
-- ============================================================================
-- Bug: mek_checkouts.status_id was created as plain INT without REFERENCES
-- metadata.statuses(id). Without the FK, schema_properties can't auto-detect
-- the join, so status renders as raw ID and visibility_condition dot-notation
-- (status_id.status_key) fails — hiding all action buttons.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'mek_checkouts' AND constraint_name = 'mek_checkouts_status_id_fkey'
    ) THEN
        ALTER TABLE mek_checkouts
        ADD CONSTRAINT mek_checkouts_status_id_fkey
        FOREIGN KEY (status_id) REFERENCES metadata.statuses(id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mek_checkouts_status ON mek_checkouts(status_id);

-- Also set status_entity_type (missing from original script 18)
INSERT INTO metadata.properties (table_name, column_name, status_entity_type)
VALUES ('mek_checkouts', 'status_id', 'mek_checkouts')
ON CONFLICT (table_name, column_name) DO UPDATE SET status_entity_type = EXCLUDED.status_entity_type;


-- ============================================================================
-- 28-1: SHOW ALL PARCELS ON PARCEL SELECT
-- ============================================================================
-- Remove options_filter_column = 'is_eligible' so all parcels are selectable
-- in the work site M:M search modal.

UPDATE metadata.properties
SET options_filter_column = NULL
WHERE table_name = 'tool_reservation_work_site'
  AND column_name = 'work_site_parcels_m2m'
  AND options_filter_column IS NOT NULL;


-- ============================================================================
-- 28-3: PARCEL SEARCH SPLIT INDEXING
-- ============================================================================
-- Add name_search_tokens() to parcel address components for better partial
-- matching. Depends on F1 migration (name_search_tokens function).
--
-- NOTE: This uses DO block with exception handling to gracefully skip if
-- name_search_tokens() doesn't exist yet (migration not deployed).

DO $$
BEGIN
    -- Verify name_search_tokens exists before trying to use it
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'name_search_tokens') THEN
        ALTER TABLE parcels DROP COLUMN IF EXISTS civic_os_text_search;
        EXECUTE '
            ALTER TABLE parcels ADD COLUMN civic_os_text_search tsvector GENERATED ALWAYS AS (
                to_tsvector(''english'',
                    coalesce(prop_num, '''') || '' '' ||
                    coalesce(prop_dir, '''') || '' '' ||
                    coalesce(prop_street, '''') || '' '' ||
                    coalesce(name_search_tokens(prop_street), '''') || '' '' ||
                    coalesce(prop_zip, '''') || '' '' ||
                    coalesce(parcel_search_tokens(parcel_number), ''''))
            ) STORED
        ';
        CREATE INDEX IF NOT EXISTS idx_parcels_text_search ON parcels USING GIN(civic_os_text_search);
        RAISE NOTICE '28-3: Parcel search updated with name_search_tokens';
    ELSE
        RAISE NOTICE '28-3: SKIPPED — name_search_tokens() not found. Deploy F1 migration first.';
    END IF;
END $$;


-- ============================================================================
-- 28-4: ENFORCE ≥1 TOOL/PARCEL BEFORE SUBMIT
-- ============================================================================
-- Add validation to on_submit RPCs. These RPCs run inside submit_guided_form()
-- transaction, so RAISE EXCEPTION rolls back the entire submission.

-- 28-4a: submit_tool_reservation — require ≥1 tool AND ≥1 parcel
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

    UPDATE public.tool_reservations
       SET status_id = v_pending_status_id,
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

-- 28-4b: submit_mek_request — require ≥1 equipment item
CREATE OR REPLACE FUNCTION public.submit_mek_request(p_parent_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, metadata, pg_catalog
AS $$
DECLARE
    v_pending_status_id INT;
BEGIN
    -- Validate at least one equipment item selected
    IF NOT EXISTS (
        SELECT 1 FROM mek_request_equipment_items mrei
        JOIN mek_request_equipment mre ON mre.id = mrei.mek_request_equipment_id
        WHERE mre.mek_request_id = p_parent_id
    ) THEN
        RAISE EXCEPTION 'At least one equipment item must be selected before submitting.';
    END IF;

    SELECT id INTO v_pending_status_id
    FROM metadata.statuses
    WHERE entity_type = 'mek_requests' AND status_key = 'pending';

    UPDATE public.mek_requests
       SET status_id = v_pending_status_id,
           submitted_at = NOW(),
           display_name = CASE
               WHEN display_name LIKE '% - Submitted' THEN display_name
               ELSE COALESCE(display_name, 'Event Kit Request') || ' - Submitted'
           END
     WHERE id = p_parent_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Your event kit request has been submitted for review.',
        'navigate_to', '/view/mek_requests/' || p_parent_id
    );
END;
$$;


-- ============================================================================
-- 28-7: ORGANIZATION FIELD ON TOOL RESERVATIONS
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tool_reservations' AND column_name = 'organization_name'
    ) THEN
        ALTER TABLE tool_reservations ADD COLUMN organization_name VARCHAR(255);
    END IF;
END $$;

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width,
    show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('tool_reservations', 'organization_name', 'Organization', 5, 2,
    false, true, true, true)
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 28-8: REMOVE REPORT DAMAGE, ADD DAMAGE+NOTES TO MARK RETURNED
-- ============================================================================
-- Staff reported that "Report Damage" as a separate button is confusing.
-- They want to report damage AND add return notes as part of the "Mark Returned"
-- workflow. The damage_reported and return_notes columns already exist on both
-- checkout tables.

-- 28-8a: Delete report_damage entity actions (both checkout types)
DELETE FROM metadata.entity_action_params
WHERE entity_action_id IN (
    SELECT id FROM metadata.entity_actions
    WHERE action_name = 'report_damage'
      AND table_name IN ('tool_reservation_checkouts', 'mek_checkouts')
);
DELETE FROM metadata.entity_action_roles
WHERE entity_action_id IN (
    SELECT id FROM metadata.entity_actions
    WHERE action_name = 'report_damage'
      AND table_name IN ('tool_reservation_checkouts', 'mek_checkouts')
);
DELETE FROM metadata.entity_actions
WHERE action_name = 'report_damage'
  AND table_name IN ('tool_reservation_checkouts', 'mek_checkouts');

-- 28-8b: Drop report damage RPC functions
DROP FUNCTION IF EXISTS public.report_checkout_damage(BIGINT);
DROP FUNCTION IF EXISTS public.report_mek_checkout_damage(BIGINT);

-- 28-8c: Add damage+notes params to mark_returned (tool_reservation_checkouts)
INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order)
SELECT ea.id, 'p_damage_reported', 'Damage Reported?', 'boolean', FALSE, 5
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservation_checkouts' AND ea.action_name = 'mark_returned'
  AND NOT EXISTS (
    SELECT 1 FROM metadata.entity_action_params eap
    WHERE eap.entity_action_id = ea.id AND eap.param_name = 'p_damage_reported'
  );

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order)
SELECT ea.id, 'p_return_notes', 'Return Notes', 'text', FALSE, 10
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservation_checkouts' AND ea.action_name = 'mark_returned'
  AND NOT EXISTS (
    SELECT 1 FROM metadata.entity_action_params eap
    WHERE eap.entity_action_id = ea.id AND eap.param_name = 'p_return_notes'
  );

-- 28-8d: Add damage+notes params to mark_returned (mek_checkouts)
INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order)
SELECT ea.id, 'p_damage_reported', 'Damage Reported?', 'boolean', FALSE, 5
FROM metadata.entity_actions ea
WHERE ea.table_name = 'mek_checkouts' AND ea.action_name = 'mark_returned'
  AND NOT EXISTS (
    SELECT 1 FROM metadata.entity_action_params eap
    WHERE eap.entity_action_id = ea.id AND eap.param_name = 'p_damage_reported'
  );

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order)
SELECT ea.id, 'p_return_notes', 'Return Notes', 'text', FALSE, 10
FROM metadata.entity_actions ea
WHERE ea.table_name = 'mek_checkouts' AND ea.action_name = 'mark_returned'
  AND NOT EXISTS (
    SELECT 1 FROM metadata.entity_action_params eap
    WHERE eap.entity_action_id = ea.id AND eap.param_name = 'p_return_notes'
  );

-- 28-8e: Update return_checkout RPC to accept damage+notes
DROP FUNCTION IF EXISTS public.return_checkout(BIGINT, UUID);
CREATE OR REPLACE FUNCTION public.return_checkout(
    p_entity_id BIGINT,
    p_return_photos UUID DEFAULT NULL,
    p_damage_reported BOOLEAN DEFAULT FALSE,
    p_return_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'metadata', 'pg_temp'
AS $$
DECLARE
    v_checkout RECORD;
    v_returned_status_id INT;
    v_in_service_status_id INT;
    v_maintenance_status_id INT;
    v_reservation_returned_id INT;
    v_items_count INT;
    v_reservation_name TEXT;
BEGIN
    SELECT c.*, s.status_key INTO v_checkout
    FROM tool_reservation_checkouts c
    JOIN metadata.statuses s ON c.status_id = s.id
    WHERE c.id = p_entity_id;

    IF v_checkout IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Checkout not found.');
    END IF;

    IF v_checkout.status_key != 'checked_out' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Checkout is not in active state.');
    END IF;

    SELECT id INTO v_returned_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'returned';

    SELECT id INTO v_in_service_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'in_service';

    SELECT id INTO v_maintenance_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'maintenance';

    SELECT id INTO v_reservation_returned_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'returned';

    SELECT tr.display_name INTO v_reservation_name
    FROM tool_reservations tr
    WHERE tr.id = v_checkout.tool_reservation_id;

    -- Return serial instances: to maintenance if damaged, to in_service otherwise
    IF COALESCE(p_damage_reported, FALSE) THEN
        UPDATE tool_instances ti
        SET status_id = v_maintenance_status_id
        FROM checkout_items ci
        WHERE ci.checkout_id = p_entity_id
          AND ci.tool_instance_id = ti.id;
    ELSE
        UPDATE tool_instances ti
        SET status_id = v_in_service_status_id
        FROM checkout_items ci
        WHERE ci.checkout_id = p_entity_id
          AND ci.tool_instance_id = ti.id;
    END IF;

    GET DIAGNOSTICS v_items_count = ROW_COUNT;

    -- Insert system notes on returned tool instances
    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', ci.tool_instance_id::text,
        CASE WHEN COALESCE(p_damage_reported, FALSE)
            THEN 'Returned (DAMAGED) — Reservation: '
            ELSE 'Returned — Reservation: '
        END || COALESCE(v_reservation_name, '#' || v_checkout.tool_reservation_id),
        'system', current_user_id()
    FROM checkout_items ci
    WHERE ci.checkout_id = p_entity_id
      AND ci.tool_instance_id IS NOT NULL;

    -- Mark checkout as returned + store damage/notes
    UPDATE tool_reservation_checkouts
    SET status_id = v_returned_status_id,
        damage_reported = COALESCE(p_damage_reported, FALSE),
        return_notes = p_return_notes
    WHERE id = p_entity_id;

    -- Back-flow: set parent reservation to returned
    UPDATE tool_reservations
    SET workflow_status_id = v_reservation_returned_id
    WHERE id = v_checkout.tool_reservation_id;

    -- Link return photos gallery if provided (v0.55.0)
    IF p_return_photos IS NOT NULL THEN
        PERFORM link_gallery_to_entity(
            p_return_photos,
            'tool_reservation_checkouts',
            p_entity_id::TEXT,
            'return_photos'
        );
    END IF;

    RETURN jsonb_build_object('success', true,
        'message', 'Checkout marked as returned.' ||
            CASE WHEN v_items_count > 0
                THEN ' ' || v_items_count || ' instance(s) returned to ' ||
                    CASE WHEN COALESCE(p_damage_reported, FALSE) THEN 'maintenance.' ELSE 'service.' END
                ELSE ''
            END);
END;
$$;

-- 28-8f: Update return_mek_checkout RPC to accept damage+notes
DROP FUNCTION IF EXISTS public.return_mek_checkout(BIGINT, UUID);
CREATE OR REPLACE FUNCTION public.return_mek_checkout(
    p_entity_id BIGINT,
    p_return_photos UUID DEFAULT NULL,
    p_damage_reported BOOLEAN DEFAULT FALSE,
    p_return_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_returned_status_id INT;
    v_in_service_status_id INT;
    v_maintenance_status_id INT;
    v_released INT := 0;
    v_request_name TEXT;
    v_mek_request_id BIGINT;
BEGIN
    SELECT id INTO v_returned_status_id
    FROM metadata.statuses WHERE entity_type = 'mek_checkouts' AND status_key = 'returned';

    SELECT id INTO v_in_service_status_id
    FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service';

    SELECT id INTO v_maintenance_status_id
    FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'maintenance';

    SELECT mc.mek_request_id, mr.display_name INTO v_mek_request_id, v_request_name
    FROM mek_checkouts mc
    JOIN mek_requests mr ON mr.id = mc.mek_request_id
    WHERE mc.id = p_entity_id;

    -- Mark checkout as returned + store damage/notes
    UPDATE mek_checkouts
    SET status_id = v_returned_status_id,
        damage_reported = COALESCE(p_damage_reported, FALSE),
        return_notes = p_return_notes,
        updated_at = now()
    WHERE id = p_entity_id;

    -- Release serial instances: to maintenance if damaged, to in_service otherwise
    IF COALESCE(p_damage_reported, FALSE) THEN
        UPDATE tool_instances
        SET status_id = v_maintenance_status_id
        WHERE id IN (
            SELECT tool_instance_id FROM mek_checkout_items
            WHERE checkout_id = p_entity_id AND tool_instance_id IS NOT NULL
        );
    ELSE
        UPDATE tool_instances
        SET status_id = v_in_service_status_id
        WHERE id IN (
            SELECT tool_instance_id FROM mek_checkout_items
            WHERE checkout_id = p_entity_id AND tool_instance_id IS NOT NULL
        );
    END IF;
    GET DIAGNOSTICS v_released = ROW_COUNT;

    -- Insert system notes on returned tool instances
    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', mci.tool_instance_id::text,
        CASE WHEN COALESCE(p_damage_reported, FALSE)
            THEN 'Returned (DAMAGED, MEK) — Request: '
            ELSE 'Returned (MEK) — Request: '
        END || COALESCE(v_request_name, '#' || v_mek_request_id),
        'system', current_user_id()
    FROM mek_checkout_items mci
    WHERE mci.checkout_id = p_entity_id
      AND mci.tool_instance_id IS NOT NULL;

    -- Back-flow: update parent mek_request status to returned
    UPDATE mek_requests
    SET status_id = (SELECT id FROM metadata.statuses WHERE entity_type='mek_requests' AND status_key='returned')
    WHERE id = v_mek_request_id;

    -- Link return photos gallery if provided (v0.55.0)
    IF p_return_photos IS NOT NULL THEN
        PERFORM link_gallery_to_entity(
            p_return_photos,
            'mek_checkouts',
            p_entity_id::TEXT,
            'return_photos'
        );
    END IF;

    RETURN jsonb_build_object('success', true, 'message',
        'Checkout marked as returned. ' || v_released || ' instance(s) returned to ' ||
            CASE WHEN COALESCE(p_damage_reported, FALSE) THEN 'maintenance.' ELSE 'service.' END);
END;
$$;


-- ============================================================================
-- 28-9: ADD CHECKOUT_NOTES TO CONFIRM CHECKOUT
-- ============================================================================
-- Staff want to add notes at checkout time (e.g., "borrower mentioned they
-- need tools through the weekend").

-- 28-9a: Add p_checkout_notes param to confirm_checkout (tool_reservation_checkouts)
INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order)
SELECT ea.id, 'p_checkout_notes', 'Checkout Notes', 'text', FALSE, 5
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservation_checkouts' AND ea.action_name = 'confirm_checkout'
  AND NOT EXISTS (
    SELECT 1 FROM metadata.entity_action_params eap
    WHERE eap.entity_action_id = ea.id AND eap.param_name = 'p_checkout_notes'
  );

-- 28-9b: Add p_checkout_notes param to confirm_checkout (mek_checkouts)
INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order)
SELECT ea.id, 'p_checkout_notes', 'Checkout Notes', 'text', FALSE, 5
FROM metadata.entity_actions ea
WHERE ea.table_name = 'mek_checkouts' AND ea.action_name = 'confirm_checkout'
  AND NOT EXISTS (
    SELECT 1 FROM metadata.entity_action_params eap
    WHERE eap.entity_action_id = ea.id AND eap.param_name = 'p_checkout_notes'
  );

-- 28-9c: Update confirm_checkout RPC to accept and store checkout_notes
DROP FUNCTION IF EXISTS public.confirm_checkout(BIGINT, UUID);
CREATE OR REPLACE FUNCTION public.confirm_checkout(
    p_entity_id BIGINT,
    p_checkout_photos UUID DEFAULT NULL,
    p_checkout_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'metadata', 'pg_temp'
AS $$
DECLARE
    v_checkout RECORD;
    v_checked_out_status_id INT;
    v_parent_checked_out_id INT;
    v_instance_checked_out_id INT;
BEGIN
    SELECT trc.id, trc.tool_reservation_id, s.status_key,
           tr.display_name AS reservation_name
    INTO v_checkout
    FROM tool_reservation_checkouts trc
    JOIN metadata.statuses s ON s.id = trc.status_id
    JOIN tool_reservations tr ON tr.id = trc.tool_reservation_id
    WHERE trc.id = p_entity_id;

    IF v_checkout.status_key IS DISTINCT FROM 'preparing' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only checkouts in preparing status can be confirmed.');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM checkout_items WHERE checkout_id = p_entity_id) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Add at least one item before confirming checkout.');
    END IF;

    SELECT id INTO v_checked_out_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'checked_out';

    SELECT id INTO v_parent_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'checked_out';

    SELECT id INTO v_instance_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'checked_out';

    -- Mark serial tool instances as checked_out (commit point)
    UPDATE tool_instances SET status_id = v_instance_checked_out_id
    WHERE id IN (
        SELECT ci.tool_instance_id FROM checkout_items ci
        WHERE ci.checkout_id = p_entity_id
          AND ci.tool_instance_id IS NOT NULL
    );

    -- Transition checkout to checked_out + store notes
    UPDATE tool_reservation_checkouts
    SET status_id = v_checked_out_status_id,
        checkout_notes = p_checkout_notes
    WHERE id = p_entity_id;

    UPDATE tool_reservations SET workflow_status_id = v_parent_checked_out_id
    WHERE id = v_checkout.tool_reservation_id;

    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', ci.tool_instance_id::text,
        'Checked out — Reservation: ' || COALESCE(v_checkout.reservation_name, '#' || v_checkout.tool_reservation_id),
        'system', current_user_id()
    FROM checkout_items ci
    WHERE ci.checkout_id = p_entity_id
      AND ci.tool_instance_id IS NOT NULL;

    -- Link checkout photos gallery if provided (v0.55.0)
    IF p_checkout_photos IS NOT NULL THEN
        PERFORM link_gallery_to_entity(
            p_checkout_photos,
            'tool_reservation_checkouts',
            p_entity_id::TEXT,
            'checkout_photos'
        );
    END IF;

    RETURN jsonb_build_object('success', true,
        'message', 'Checkout confirmed. Tools are now checked out.');
END;
$$;

-- 28-9d: Update confirm_mek_checkout RPC to accept and store checkout_notes
DROP FUNCTION IF EXISTS public.confirm_mek_checkout(BIGINT, UUID);
CREATE OR REPLACE FUNCTION public.confirm_mek_checkout(
    p_entity_id BIGINT,
    p_checkout_photos UUID DEFAULT NULL,
    p_checkout_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'metadata', 'pg_temp'
AS $$
DECLARE
    v_checkout RECORD;
    v_checked_out_status_id INT;
    v_parent_checked_out_id INT;
    v_instance_checked_out_id INT;
BEGIN
    SELECT mc.id, mc.mek_request_id, s.status_key,
           mr.display_name AS request_name
    INTO v_checkout
    FROM mek_checkouts mc
    JOIN metadata.statuses s ON s.id = mc.status_id
    JOIN mek_requests mr ON mr.id = mc.mek_request_id
    WHERE mc.id = p_entity_id;

    IF v_checkout.status_key IS DISTINCT FROM 'preparing' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only checkouts in preparing status can be confirmed.');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM mek_checkout_items WHERE checkout_id = p_entity_id) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Add at least one item before confirming checkout.');
    END IF;

    SELECT id INTO v_checked_out_status_id FROM metadata.statuses
    WHERE entity_type = 'mek_checkouts' AND status_key = 'checked_out';

    SELECT id INTO v_parent_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'mek_requests' AND status_key = 'checked_out';

    SELECT id INTO v_instance_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'checked_out';

    -- Mark serial tool instances as checked_out (commit point)
    UPDATE tool_instances SET status_id = v_instance_checked_out_id
    WHERE id IN (
        SELECT mci.tool_instance_id FROM mek_checkout_items mci
        WHERE mci.checkout_id = p_entity_id
          AND mci.tool_instance_id IS NOT NULL
    );

    -- Transition checkout to checked_out + store notes
    UPDATE mek_checkouts
    SET status_id = v_checked_out_status_id,
        checkout_notes = p_checkout_notes
    WHERE id = p_entity_id;

    UPDATE mek_requests SET status_id = v_parent_checked_out_id
    WHERE id = v_checkout.mek_request_id;

    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', mci.tool_instance_id::text,
        'Checked out (MEK) — Request: ' || COALESCE(v_checkout.request_name, '#' || v_checkout.mek_request_id),
        'system', current_user_id()
    FROM mek_checkout_items mci
    WHERE mci.checkout_id = p_entity_id
      AND mci.tool_instance_id IS NOT NULL;

    -- Link checkout photos gallery if provided (v0.55.0)
    IF p_checkout_photos IS NOT NULL THEN
        PERFORM link_gallery_to_entity(
            p_checkout_photos,
            'mek_checkouts',
            p_entity_id::TEXT,
            'checkout_photos'
        );
    END IF;

    RETURN jsonb_build_object('success', true,
        'message', 'Checkout confirmed. Items are now checked out.');
END;
$$;


-- ============================================================================
-- 28-10: QTY-MANAGED CHECKOUT ITEM — ADD depends_on_params
-- ============================================================================
-- The p_tool_instance_id FK dropdown shows all instances regardless of selected
-- tool type. Add depends_on_params so it cascades from p_tool_type_id, and uses
-- an options_source_rpc that returns instances for the selected type (empty for
-- qty-managed types).

-- Create options RPC for tool instances filtered by tool type
CREATE OR REPLACE FUNCTION public.get_instances_for_type(
    p_id TEXT DEFAULT NULL,
    p_depends_on JSONB DEFAULT '{}'
)
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_type_id INT;
    v_is_qty_managed BOOLEAN;
BEGIN
    v_type_id := (p_depends_on->>'p_tool_type_id')::INT;

    IF v_type_id IS NULL THEN
        RETURN;  -- No type selected yet, return empty
    END IF;

    SELECT tt.is_qty_managed INTO v_is_qty_managed FROM tool_types tt WHERE tt.id = v_type_id;

    IF v_is_qty_managed THEN
        RETURN;  -- Qty-managed types have no instances to select
    END IF;

    -- Return in_service instances for the selected serial tool type
    RETURN QUERY
    SELECT ti.id, ti.display_name::TEXT
    FROM tool_instances ti
    JOIN metadata.statuses s ON s.id = ti.status_id
    WHERE ti.tool_type_id = v_type_id
      AND s.status_key = 'in_service'
    ORDER BY ti.display_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_instances_for_type(TEXT, JSONB) TO authenticated;

-- Update p_tool_instance_id action params to use cascading dropdown
-- (tool_reservation_checkouts add_item)
UPDATE metadata.entity_action_params eap
SET options_source_rpc = 'get_instances_for_type',
    depends_on_params = ARRAY['p_tool_type_id']
FROM metadata.entity_actions ea
WHERE ea.id = eap.entity_action_id
  AND ea.table_name = 'tool_reservation_checkouts'
  AND ea.action_name = 'add_item'
  AND eap.param_name = 'p_tool_instance_id';

-- (mek_checkouts add_item)
UPDATE metadata.entity_action_params eap
SET options_source_rpc = 'get_instances_for_type',
    depends_on_params = ARRAY['p_tool_type_id']
FROM metadata.entity_actions ea
WHERE ea.id = eap.entity_action_id
  AND ea.table_name = 'mek_checkouts'
  AND ea.action_name = 'add_item'
  AND eap.param_name = 'p_tool_instance_id';


-- ============================================================================
-- 28-11: UPDATE ADDRESS BORROWER ACTION
-- ============================================================================

-- 28-11a: Enable entity notes on borrowers
SELECT enable_entity_notes('borrowers');

-- Grant notes permissions to neh_staff and neh_admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'borrowers:notes'
  AND p.permission IN ('read', 'create')
  AND r.role_key IN ('neh_staff', 'neh_admin')
ON CONFLICT DO NOTHING;

-- 28-11b: Create update_borrower_address RPC
CREATE OR REPLACE FUNCTION public.update_borrower_address(
    p_entity_id BIGINT,
    p_street VARCHAR DEFAULT NULL,
    p_city VARCHAR DEFAULT NULL,
    p_state VARCHAR DEFAULT NULL,
    p_zip VARCHAR DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_old RECORD;
    v_note TEXT := 'Address updated:';
    v_has_changes BOOLEAN := FALSE;
BEGIN
    SELECT street, city, state, zip INTO v_old FROM borrowers WHERE id = p_entity_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Borrower not found.');
    END IF;

    -- Build change note tracking old → new values
    IF p_street IS NOT NULL AND p_street IS DISTINCT FROM v_old.street THEN
        v_note := v_note || E'\n- Street: "' || COALESCE(v_old.street, '') || '" → "' || p_street || '"';
        v_has_changes := TRUE;
    END IF;
    IF p_city IS NOT NULL AND p_city IS DISTINCT FROM v_old.city THEN
        v_note := v_note || E'\n- City: "' || COALESCE(v_old.city, '') || '" → "' || p_city || '"';
        v_has_changes := TRUE;
    END IF;
    IF p_state IS NOT NULL AND p_state IS DISTINCT FROM v_old.state THEN
        v_note := v_note || E'\n- State: "' || COALESCE(v_old.state, '') || '" → "' || p_state || '"';
        v_has_changes := TRUE;
    END IF;
    IF p_zip IS NOT NULL AND p_zip IS DISTINCT FROM v_old.zip THEN
        v_note := v_note || E'\n- Zip: "' || COALESCE(v_old.zip, '') || '" → "' || p_zip || '"';
        v_has_changes := TRUE;
    END IF;

    IF NOT v_has_changes THEN
        RETURN jsonb_build_object('success', true, 'message', 'No address changes detected.', 'refresh', true);
    END IF;

    -- Update only the fields that were provided (COALESCE preserves existing values)
    UPDATE borrowers
    SET street = COALESCE(p_street, street),
        city = COALESCE(p_city, city),
        state = COALESCE(p_state, state),
        zip = COALESCE(p_zip, zip),
        updated_at = NOW()
    WHERE id = p_entity_id;

    -- Create audit note
    PERFORM create_entity_note('borrowers', p_entity_id::TEXT, v_note, 'system');

    RETURN jsonb_build_object('success', true, 'message', 'Address updated.', 'refresh', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_borrower_address(BIGINT, VARCHAR, VARCHAR, VARCHAR, VARCHAR) TO authenticated;

-- 28-11c: Register entity action
INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, icon, button_style,
    sort_order, rpc_function, requires_confirmation, refresh_after_action, show_on_detail
) VALUES (
    'borrowers', 'update_address', 'Update Address', 'Update the borrower''s address on file',
    'home', 'secondary', 20, 'update_borrower_address', false, true, true
)
ON CONFLICT (table_name, action_name) DO NOTHING;

-- 28-11d: Add action params (street, city, state, zip)
INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder)
SELECT ea.id, 'p_street', 'Street', 'text', FALSE, 1, 'e.g., 123 Main St'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'borrowers' AND ea.action_name = 'update_address'
  AND NOT EXISTS (
    SELECT 1 FROM metadata.entity_action_params eap
    WHERE eap.entity_action_id = ea.id AND eap.param_name = 'p_street'
  );

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder)
SELECT ea.id, 'p_city', 'City', 'text_short', FALSE, 2, 'e.g., Flint'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'borrowers' AND ea.action_name = 'update_address'
  AND NOT EXISTS (
    SELECT 1 FROM metadata.entity_action_params eap
    WHERE eap.entity_action_id = ea.id AND eap.param_name = 'p_city'
  );

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder)
SELECT ea.id, 'p_state', 'State', 'text_short', FALSE, 3, 'e.g., MI'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'borrowers' AND ea.action_name = 'update_address'
  AND NOT EXISTS (
    SELECT 1 FROM metadata.entity_action_params eap
    WHERE eap.entity_action_id = ea.id AND eap.param_name = 'p_state'
  );

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder)
SELECT ea.id, 'p_zip', 'Zip', 'text_short', FALSE, 4, 'e.g., 48502'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'borrowers' AND ea.action_name = 'update_address'
  AND NOT EXISTS (
    SELECT 1 FROM metadata.entity_action_params eap
    WHERE eap.entity_action_id = ea.id AND eap.param_name = 'p_zip'
  );

-- 28-11e: Grant entity action to neh_staff and neh_admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'borrowers' AND ea.action_name = 'update_address'
  AND r.role_key IN ('neh_staff', 'neh_admin')
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 28-12: FILTER CHECKOUT "ADD ITEM" TOOL TYPE BY INVENTORY MODULE
-- ============================================================================
-- Both checkout "Add Item" actions have a p_tool_type_id FK param that shows
-- all 83 tool types. MEK staff shouldn't see Tool Shed tools (and vice versa).
-- get_available_tool_types() already filters to Tool Shed only (script 05/14).
-- Create inverse for Event Kit and wire both via options_source_rpc.

-- 28-12a: Create Event Kit tool types RPC (inverse of get_available_tool_types)
CREATE OR REPLACE FUNCTION public.get_event_kit_tool_types(
    p_id TEXT DEFAULT NULL,
    p_depends_on JSONB DEFAULT '{}'
)
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT tt.id, tt.display_name::TEXT
    FROM tool_types tt
    JOIN metadata.categories c ON tt.inventory_module_id = c.id
    WHERE c.category_key = 'event_kit'
    ORDER BY tt.display_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_event_kit_tool_types(TEXT, JSONB) TO authenticated;

-- 28-12b: MEK checkout "Add Item" → Event Kit tool types only
UPDATE metadata.entity_action_params eap
SET options_source_rpc = 'get_event_kit_tool_types'
FROM metadata.entity_actions ea
WHERE ea.id = eap.entity_action_id
  AND ea.table_name = 'mek_checkouts'
  AND ea.action_name = 'add_item'
  AND eap.param_name = 'p_tool_type_id';

-- 28-12c: Tool Reservation checkout "Add Item" → Tool Shed tool types only
UPDATE metadata.entity_action_params eap
SET options_source_rpc = 'get_available_tool_types'
FROM metadata.entity_actions ea
WHERE ea.id = eap.entity_action_id
  AND ea.table_name = 'tool_reservation_checkouts'
  AND ea.action_name = 'add_item'
  AND eap.param_name = 'p_tool_type_id';


-- ============================================================================
-- ADR: Document all changes
-- ============================================================================

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, decision, decided_date
) VALUES (
    ARRAY['tool_reservations', 'mek_requests', 'tool_reservation_checkouts',
          'mek_checkouts', 'borrowers', 'parcels']::NAME[],
    'neh-28-usability-batch',
    'NEH usability batch: submit validation, return damage+notes, address action, cascading params',
    'accepted',
    'Combined batch of usability fixes from staff testing: (1) Enforce ≥1 tool + ≥1 parcel in '
        'submit_tool_reservation, ≥1 equipment in submit_mek_request. (2) Remove separate Report Damage '
        'action; add damage_reported boolean + return_notes text params to Mark Returned. Damaged tools '
        'go to maintenance status. (3) Add checkout_notes text param to Confirm Checkout. (4) Organization '
        'field on tool_reservations. (5) Cascading p_tool_instance_id dropdown via get_instances_for_type '
        'options RPC — returns empty for qty-managed types. (6) Update Address borrower action with audit '
        'notes. (7) Enable entity notes on borrowers. (8) MEK timeslot nullable for guided form drafts. '
        '(9) Remove parcel is_eligible filter. (10) Add name_search_tokens to parcel tsvector. '
        '(11) Filter checkout Add Item tool type dropdowns by inventory module — MEK→Event Kit, '
        'Tool Reservation→Tool Shed via options_source_rpc.',
    CURRENT_DATE
);


COMMIT;

NOTIFY pgrst, 'reload schema';
