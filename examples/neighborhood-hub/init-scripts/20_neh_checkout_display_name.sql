-- Neighborhood Engagement Hub - Add display_name to checkout entities
-- Fixes: PostgREST error "column X.display_name does not exist"
--
-- Civic OS requires every entity to have a display_name column for FK references,
-- list views, and breadcrumbs. Four checkout-related tables were missing it:
--   1. tool_reservation_checkouts (1:1 with tool_reservations)
--   2. mek_checkouts (1:1 with mek_requests)
--   3. checkout_items (child of tool_reservation_checkouts)
--   4. mek_checkout_items (child of mek_checkouts)
BEGIN;

-- ============================================================================
-- 1. tool_reservation_checkouts — derive from parent reservation
-- ============================================================================

ALTER TABLE tool_reservation_checkouts
ADD COLUMN IF NOT EXISTS display_name TEXT;

UPDATE tool_reservation_checkouts trc
SET display_name = 'Checkout - ' || tr.display_name
FROM tool_reservations tr
WHERE tr.id = trc.tool_reservation_id
  AND trc.display_name IS NULL;

-- Update trigger to set display_name on auto-create
CREATE OR REPLACE FUNCTION public.auto_create_checkout_record()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_status_key TEXT;
    v_checkout_status_id INT;
BEGIN
    SELECT status_key INTO v_status_key
    FROM metadata.statuses WHERE id = NEW.workflow_status_id;

    IF v_status_key = 'checked_out' THEN
        SELECT id INTO v_checkout_status_id
        FROM metadata.statuses
        WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'checked_out';

        INSERT INTO public.tool_reservation_checkouts (tool_reservation_id, status_id, display_name)
        VALUES (NEW.id, v_checkout_status_id, 'Checkout - ' || NEW.display_name)
        ON CONFLICT (tool_reservation_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

-- ============================================================================
-- 2. mek_checkouts — derive from parent mek_request
-- ============================================================================

ALTER TABLE mek_checkouts
ADD COLUMN IF NOT EXISTS display_name TEXT;

UPDATE mek_checkouts mc
SET display_name = 'Checkout - ' || mr.display_name
FROM mek_requests mr
WHERE mr.id = mc.mek_request_id
  AND mc.display_name IS NULL;

-- Update MEK auto-create trigger to set display_name
CREATE OR REPLACE FUNCTION public.auto_create_mek_checkout_record()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_status_key TEXT;
    v_checkout_status_id INT;
BEGIN
    SELECT status_key INTO v_status_key
    FROM metadata.statuses WHERE id = NEW.status_id;

    IF v_status_key = 'checked_out' THEN
        SELECT id INTO v_checkout_status_id
        FROM metadata.statuses
        WHERE entity_type = 'mek_checkouts' AND status_key = 'checked_out';

        INSERT INTO mek_checkouts (mek_request_id, status_id, display_name)
        VALUES (NEW.id, v_checkout_status_id, 'Checkout - ' || NEW.display_name)
        ON CONFLICT DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

-- ============================================================================
-- 3. checkout_items — display as "Tool Name x Qty" or "Tool Name (Serial #)"
-- ============================================================================

ALTER TABLE checkout_items
ADD COLUMN IF NOT EXISTS display_name TEXT;

UPDATE checkout_items ci
SET display_name = CASE
    WHEN ci.tool_instance_id IS NOT NULL
        THEN tt.display_name || ' (' || COALESCE(
            (SELECT ti.display_name FROM tool_instances ti WHERE ti.id = ci.tool_instance_id),
            '#' || ci.tool_instance_id
        ) || ')'
    ELSE tt.display_name || ' x' || ci.quantity
END
FROM tool_types tt
WHERE tt.id = ci.tool_type_id
  AND ci.display_name IS NULL;

-- ============================================================================
-- 4. mek_checkout_items — same pattern
-- ============================================================================

ALTER TABLE mek_checkout_items
ADD COLUMN IF NOT EXISTS display_name TEXT;

UPDATE mek_checkout_items mci
SET display_name = CASE
    WHEN mci.tool_instance_id IS NOT NULL
        THEN tt.display_name || ' (' || COALESCE(
            (SELECT ti.display_name FROM tool_instances ti WHERE ti.id = mci.tool_instance_id),
            '#' || mci.tool_instance_id
        ) || ')'
    ELSE tt.display_name || ' x' || mci.quantity
END
FROM tool_types tt
WHERE tt.id = mci.tool_type_id
  AND mci.display_name IS NULL;

-- ============================================================================
-- 5. Update add_checkout_item RPCs to set display_name on insert
-- ============================================================================

-- Patch add_checkout_item (tool reservations)
CREATE OR REPLACE FUNCTION public.add_checkout_item(
    p_entity_id BIGINT,
    p_tool_type_id INT,
    p_tool_instance_id INT DEFAULT NULL,
    p_quantity INT DEFAULT 1,
    p_notes TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_type_name TEXT;
    v_is_qty_managed BOOLEAN;
    v_instance_name TEXT;
    v_instance_status_key TEXT;
    v_checked_out_status_id INT;
    v_display_name TEXT;
BEGIN
    -- Validate tool type exists
    SELECT display_name, is_qty_managed INTO v_type_name, v_is_qty_managed
    FROM tool_types WHERE id = p_tool_type_id;

    IF v_type_name IS NULL THEN
        RAISE EXCEPTION 'Tool type not found' USING ERRCODE = 'P0001';
    END IF;

    -- Validate based on management type
    IF NOT v_is_qty_managed THEN
        -- Serial: require instance_id
        IF p_tool_instance_id IS NULL THEN
            RAISE EXCEPTION 'Serial tool "%" requires a specific instance to be selected.', v_type_name
                USING ERRCODE = 'P0001';
        END IF;

        -- Verify instance belongs to this type and is available
        SELECT ti.display_name, s.status_key INTO v_instance_name, v_instance_status_key
        FROM tool_instances ti
        JOIN metadata.statuses s ON s.id = ti.status_id
        WHERE ti.id = p_tool_instance_id AND ti.tool_type_id = p_tool_type_id;

        IF v_instance_name IS NULL THEN
            RAISE EXCEPTION 'Tool instance not found.' USING ERRCODE = 'P0001';
        END IF;

        IF v_instance_status_key != 'available' THEN
            RETURN jsonb_build_object('success', false,
                'message', v_instance_name || ' is not available (current status: ' || v_instance_status_key || ').');
        END IF;

        -- Force quantity to 1 for serial tools
        p_quantity := 1;
    END IF;

    -- Build display_name
    IF p_tool_instance_id IS NOT NULL THEN
        v_display_name := v_type_name || ' (' || COALESCE(v_instance_name, '#' || p_tool_instance_id) || ')';
    ELSE
        v_display_name := v_type_name || ' x' || p_quantity;
    END IF;

    -- Insert checkout item
    INSERT INTO checkout_items (checkout_id, tool_type_id, tool_instance_id, quantity, notes, display_name)
    VALUES (p_entity_id, p_tool_type_id, p_tool_instance_id, p_quantity, p_notes, v_display_name);

    -- Mark serial instance as checked out
    IF NOT v_is_qty_managed AND p_tool_instance_id IS NOT NULL THEN
        SELECT id INTO v_checked_out_status_id
        FROM metadata.statuses
        WHERE entity_type = 'tool_instances' AND status_key = 'checked_out';

        UPDATE tool_instances SET status_id = v_checked_out_status_id
        WHERE id = p_tool_instance_id;
    END IF;

    RETURN jsonb_build_object('success', true,
        'message', v_type_name || ' added to checkout.');
END;
$$;

-- Patch add_mek_checkout_item (MEK requests)
-- DROP required: deployed version returns json, new version returns jsonb
DROP FUNCTION IF EXISTS public.add_mek_checkout_item(bigint, integer, integer, integer, text);
CREATE OR REPLACE FUNCTION public.add_mek_checkout_item(
    p_entity_id BIGINT,
    p_tool_type_id INT,
    p_tool_instance_id INT DEFAULT NULL,
    p_quantity INT DEFAULT 1,
    p_notes TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_type_name TEXT;
    v_is_qty_managed BOOLEAN;
    v_instance_name TEXT;
    v_instance_status_key TEXT;
    v_checked_out_status_id INT;
    v_display_name TEXT;
BEGIN
    -- Validate tool type exists
    SELECT display_name, is_qty_managed INTO v_type_name, v_is_qty_managed
    FROM tool_types WHERE id = p_tool_type_id;

    IF v_type_name IS NULL THEN
        RAISE EXCEPTION 'Tool type not found' USING ERRCODE = 'P0001';
    END IF;

    -- Validate based on management type
    IF NOT v_is_qty_managed THEN
        -- Serial: require instance_id
        IF p_tool_instance_id IS NULL THEN
            RAISE EXCEPTION 'Serial tool "%" requires a specific instance to be selected.', v_type_name
                USING ERRCODE = 'P0001';
        END IF;

        -- Verify instance belongs to this type and is available
        SELECT ti.display_name, s.status_key INTO v_instance_name, v_instance_status_key
        FROM tool_instances ti
        JOIN metadata.statuses s ON s.id = ti.status_id
        WHERE ti.id = p_tool_instance_id AND ti.tool_type_id = p_tool_type_id;

        IF v_instance_name IS NULL THEN
            RAISE EXCEPTION 'Tool instance not found.' USING ERRCODE = 'P0001';
        END IF;

        IF v_instance_status_key != 'available' THEN
            RETURN jsonb_build_object('success', false,
                'message', v_instance_name || ' is not available (current status: ' || v_instance_status_key || ').');
        END IF;

        -- Force quantity to 1 for serial tools
        p_quantity := 1;
    END IF;

    -- Build display_name
    IF p_tool_instance_id IS NOT NULL THEN
        v_display_name := v_type_name || ' (' || COALESCE(v_instance_name, '#' || p_tool_instance_id) || ')';
    ELSE
        v_display_name := v_type_name || ' x' || p_quantity;
    END IF;

    -- Insert checkout item (serial vs qty-managed)
    IF NOT v_is_qty_managed THEN
        INSERT INTO mek_checkout_items (checkout_id, tool_type_id, tool_instance_id, quantity, notes, display_name)
        VALUES (p_entity_id, p_tool_type_id, p_tool_instance_id, 1, p_notes, v_display_name);
    ELSE
        INSERT INTO mek_checkout_items (checkout_id, tool_type_id, quantity, notes, display_name)
        VALUES (p_entity_id, p_tool_type_id, p_quantity, p_notes, v_display_name);
    END IF;

    -- Mark serial instance as checked out
    IF NOT v_is_qty_managed AND p_tool_instance_id IS NOT NULL THEN
        SELECT id INTO v_checked_out_status_id
        FROM metadata.statuses
        WHERE entity_type = 'tool_instances' AND status_key = 'checked_out';

        UPDATE tool_instances SET status_id = v_checked_out_status_id
        WHERE id = p_tool_instance_id;
    END IF;

    RETURN jsonb_build_object('success', true,
        'message', v_type_name || ' added to checkout.');
END;
$$;

-- ============================================================================
-- Schema Decision (ADR)
-- ============================================================================

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['tool_reservation_checkouts', 'mek_checkouts', 'checkout_items', 'mek_checkout_items']::NAME[],
    '20_neh_checkout_display_name',
    'Add display_name column to all checkout entities',
    'accepted',
    'PostgREST returns 42703 error because Civic OS SchemaService always selects display_name from every entity. Four checkout tables (tool_reservation_checkouts, mek_checkouts, checkout_items, mek_checkout_items) were missing this column.',
    'Added display_name TEXT to all four tables. Parent checkouts derive from reservation/request name ("Checkout - {parent}"). Item records show tool name with instance or quantity ("DR Trimmer (Unit #1)" or "Folding Table x3"). Auto-create triggers and add_item RPCs updated to set display_name on insert.',
    'Civic OS requires display_name on every entity for FK references, list views, and breadcrumbs. Deriving from parent/tool data avoids user-facing data entry while providing meaningful identifiers.',
    'Display names are denormalized snapshots. If parent names or tool type names change, existing checkout records retain the original name. Acceptable because checkouts are historical records.',
    CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM metadata.schema_decisions WHERE migration_id = '20_neh_checkout_display_name');

COMMIT;
