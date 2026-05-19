-- Neighborhood Engagement Hub - Action Param Filtered Dropdowns
--
-- Fixes three UX issues with checkout entity action modals:
--
-- 1. "Remove Item" shows a raw number input for p_checkout_item_id.
--    Staff must look up the ID manually. Changed to FK dropdown with
--    options_source_rpc that returns only items belonging to this checkout.
--
-- 2. "Add Item" Tool Instance dropdown shows ALL instances across all types.
--    Now uses options_source_rpc with depends_on_params=['p_tool_type_id']
--    so instances filter by the selected tool type.
--
-- 3. Button ordering: Confirm Checkout appears between Add and Remove (sort 15).
--    Reordered to: Add(10), Remove(20), Confirm(30).
--
-- Requires: v0.54.0 migration (options_source_rpc + depends_on_params columns)

BEGIN;

SET LOCAL request.jwt.claims = '{"sub":"init-script","realm_access":{"roles":["admin"]}}';

-- ============================================================================
-- 1. BUTTON REORDERING
--    Add(10), Remove(20), Confirm(30), Mark Returned(40), Report Damage(50)
-- ============================================================================

-- Tool reservation checkouts
UPDATE metadata.entity_actions SET sort_order = 30
WHERE table_name = 'tool_reservation_checkouts' AND action_name = 'confirm_checkout';

UPDATE metadata.entity_actions SET sort_order = 40
WHERE table_name = 'tool_reservation_checkouts' AND action_name = 'mark_returned';

UPDATE metadata.entity_actions SET sort_order = 50
WHERE table_name = 'tool_reservation_checkouts' AND action_name = 'report_damage';

-- MEK checkouts
UPDATE metadata.entity_actions SET sort_order = 30
WHERE table_name = 'mek_checkouts' AND action_name = 'confirm_checkout';

UPDATE metadata.entity_actions SET sort_order = 40
WHERE table_name = 'mek_checkouts' AND action_name = 'mark_returned';

UPDATE metadata.entity_actions SET sort_order = 50
WHERE table_name = 'mek_checkouts' AND action_name = 'report_damage';


-- ============================================================================
-- 2. CREATE RPCs FOR FILTERED OPTIONS
-- ============================================================================

-- 2a. get_checkout_items_options: returns items belonging to a specific checkout
CREATE OR REPLACE FUNCTION public.get_checkout_items_options(
    p_id BIGINT,
    p_depends_on JSONB DEFAULT '{}'
)
RETURNS TABLE(id BIGINT, display_name TEXT)
LANGUAGE sql STABLE
AS $$
    SELECT ci.id, ci.display_name
    FROM checkout_items ci
    WHERE ci.checkout_id = p_id
    ORDER BY ci.created_at;
$$;

-- 2b. get_mek_checkout_items_options: same for MEK checkouts
CREATE OR REPLACE FUNCTION public.get_mek_checkout_items_options(
    p_id BIGINT,
    p_depends_on JSONB DEFAULT '{}'
)
RETURNS TABLE(id BIGINT, display_name TEXT)
LANGUAGE sql STABLE
AS $$
    SELECT mci.id, mci.display_name
    FROM mek_checkout_items mci
    WHERE mci.checkout_id = p_id
    ORDER BY mci.created_at;
$$;

-- 2c. get_tool_instance_options: returns available instances for a given tool type
--     Reads p_tool_type_id from p_depends_on. Returns empty set if no type selected.
CREATE OR REPLACE FUNCTION public.get_tool_instance_options(
    p_id BIGINT,
    p_depends_on JSONB DEFAULT '{}'
)
RETURNS TABLE(id INT, display_name TEXT)
LANGUAGE sql STABLE
AS $$
    SELECT ti.id, ti.display_name
    FROM tool_instances ti
    JOIN metadata.statuses s ON ti.status_id = s.id
    WHERE ti.tool_type_id = (p_depends_on->>'p_tool_type_id')::INT
      AND s.status_key = 'in_service'
    ORDER BY ti.display_name;
$$;

-- 2d. get_mek_tool_instance_options: same pattern for MEK context
--     (identical logic — MEK checkouts share the same tool_instances table)
CREATE OR REPLACE FUNCTION public.get_mek_tool_instance_options(
    p_id BIGINT,
    p_depends_on JSONB DEFAULT '{}'
)
RETURNS TABLE(id INT, display_name TEXT)
LANGUAGE sql STABLE
AS $$
    SELECT ti.id, ti.display_name
    FROM tool_instances ti
    JOIN metadata.statuses s ON ti.status_id = s.id
    WHERE ti.tool_type_id = (p_depends_on->>'p_tool_type_id')::INT
      AND s.status_key = 'in_service'
    ORDER BY ti.display_name;
$$;

-- Grant execute to authenticated role
GRANT EXECUTE ON FUNCTION get_checkout_items_options(BIGINT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION get_mek_checkout_items_options(BIGINT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION get_tool_instance_options(BIGINT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION get_mek_tool_instance_options(BIGINT, JSONB) TO authenticated;


-- ============================================================================
-- 3. FIX "REMOVE ITEM" — number → foreign_key with options_source_rpc
-- ============================================================================

-- 3a. Tool reservation checkout: remove_item param
UPDATE metadata.entity_action_params
SET param_type = 'foreign_key',
    display_name = 'Item to Remove',
    join_table = 'checkout_items',
    join_column = 'id',
    options_source_rpc = 'get_checkout_items_options',
    placeholder = NULL
FROM metadata.entity_actions ea
WHERE entity_action_params.entity_action_id = ea.id
  AND ea.table_name = 'tool_reservation_checkouts'
  AND ea.action_name = 'remove_item'
  AND entity_action_params.param_name = 'p_checkout_item_id';

-- 3b. MEK checkout: remove_item param
UPDATE metadata.entity_action_params
SET param_type = 'foreign_key',
    display_name = 'Item to Remove',
    join_table = 'mek_checkout_items',
    join_column = 'id',
    options_source_rpc = 'get_mek_checkout_items_options',
    placeholder = NULL
FROM metadata.entity_actions ea
WHERE entity_action_params.entity_action_id = ea.id
  AND ea.table_name = 'mek_checkouts'
  AND ea.action_name = 'remove_item'
  AND entity_action_params.param_name = 'p_checkout_item_id';


-- ============================================================================
-- 4. TOOL INSTANCE CASCADING DROPDOWN — add options_source_rpc + depends_on_params
-- ============================================================================

-- 4a. Tool reservation checkout: add_item → p_tool_instance_id
UPDATE metadata.entity_action_params
SET options_source_rpc = 'get_tool_instance_options',
    depends_on_params = ARRAY['p_tool_type_id']
FROM metadata.entity_actions ea
WHERE entity_action_params.entity_action_id = ea.id
  AND ea.table_name = 'tool_reservation_checkouts'
  AND ea.action_name = 'add_item'
  AND entity_action_params.param_name = 'p_tool_instance_id';

-- 4b. MEK checkout: add_item → p_tool_instance_id
UPDATE metadata.entity_action_params
SET options_source_rpc = 'get_mek_tool_instance_options',
    depends_on_params = ARRAY['p_tool_type_id']
FROM metadata.entity_actions ea
WHERE entity_action_params.entity_action_id = ea.id
  AND ea.table_name = 'mek_checkouts'
  AND ea.action_name = 'add_item'
  AND entity_action_params.param_name = 'p_tool_instance_id';


-- ============================================================================
-- 5. SCHEMA DECISION (ADR)
-- ============================================================================

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['tool_reservation_checkouts', 'mek_checkouts', 'checkout_items', 'mek_checkout_items']::NAME[],
    '24_neh_action_param_filters',
    'Action param filtered dropdowns for checkout workflow',
    'accepted',
    'Three UX issues in checkout entity action modals: (1) Remove Item prompts for a raw numeric ID — staff must look up checkout_items.id manually. (2) Add Item''s Tool Instance dropdown shows all instances across all types and statuses, with no filtering by the selected Tool Type. (3) Confirm Checkout button appears between Add and Remove instead of after both.',
    'Added options_source_rpc and depends_on_params to entity_action_params (v0.54.0 migration). Created four RPCs: get_checkout_items_options (items for this checkout), get_mek_checkout_items_options (same for MEK), get_tool_instance_options (available instances filtered by p_tool_type_id), get_mek_tool_instance_options (same for MEK). Changed remove_item p_checkout_item_id from number to foreign_key with RPC. Added cascading dependency on p_tool_type_id for p_tool_instance_id. Reordered buttons: Add(10), Remove(20), Confirm(30).',
    'Mirrors the established options_source_rpc + depends_on_columns pattern from metadata.properties, adapted for action params. RPC signature (p_id, p_depends_on JSONB) matches the property-level convention. Separate RPCs for tool reservation vs MEK context in case future differences emerge, though current logic is identical.',
    'Frontend debounces dependency changes (300ms) and invalidates stale selections. When no tool type is selected, instance dropdown stays empty. get_tool_instance_options filters by in_service status, preventing checkout of already-checked-out instances.',
    CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM metadata.schema_decisions WHERE migration_id = '24_neh_action_param_filters');

COMMIT;

NOTIFY pgrst, 'reload schema';
