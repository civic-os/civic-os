-- ============================================================================
-- NEH Script 33: Fix complete_step crash + restructure building use form
-- ============================================================================
-- Two issues addressed:
--
--   1. "column id does not exist" when completing parent step — room_selection
--      step uses junction table (composite PK, no id column) which is incompatible
--      with ensure_guided_form_step_record()
--
--   2. Parent step has 23 fields — too many for one page. Split event logistics
--      into a new "Event Details" child step.
--
-- Changes:
--   33-1: Remove broken room_selection step (M:M stays inline on parent)
--   33-2: Create building_use_event_details child table
--   33-3: Migrate existing data from parent to child table
--   33-4: Drop moved columns from parent table
--   33-5: Register Event Details as guided form step 1
--   33-6: Update metadata (properties, validations)
--   33-7: Add skip_if condition for private events on new step
--   33-8: Schema decision (ADR)
-- ============================================================================


-- ============================================================================
-- 33-1: Remove broken room_selection step
-- ============================================================================
-- building_use_request_rooms is a composite-PK junction table (no id column).
-- ensure_guided_form_step_record() does SELECT id FROM step_table → crash.
-- Room selection already works via inline M:M (show_inline = true on parent).

DELETE FROM metadata.guided_form_step_conditions
WHERE guided_form_step_id IN (
    SELECT id FROM metadata.guided_form_steps
    WHERE guided_form_key = 'building_use_request' AND step_key = 'room_selection'
);

DELETE FROM metadata.guided_form_progress
WHERE guided_form_key = 'building_use_request' AND step_key = 'room_selection';

DELETE FROM metadata.guided_form_steps
WHERE guided_form_key = 'building_use_request' AND step_key = 'room_selection';

-- Clean up stale artifacts from add_guided_form_step on the junction table:
-- 1. guided_form_status_id column (added by add_guided_form_step, useless on M:M junction)
ALTER TABLE building_use_request_rooms DROP COLUMN IF EXISTS guided_form_status_id;
ALTER TABLE building_use_request_rooms DROP COLUMN IF EXISTS status_id;

-- 2. Stale entity metadata (add_guided_form_step sets guided_form_key + show_in_sidebar)
UPDATE metadata.entities
   SET guided_form_key = NULL
 WHERE table_name = 'building_use_request_rooms';

-- 3. Stale GF status property metadata
DELETE FROM metadata.properties
WHERE table_name = 'building_use_request_rooms'
  AND column_name IN ('guided_form_status_id', 'status_id');

-- 4. Stale RLS policies created by add_guided_form_step
DROP POLICY IF EXISTS gf_child_select ON building_use_request_rooms;
DROP POLICY IF EXISTS gf_child_insert ON building_use_request_rooms;
DROP POLICY IF EXISTS gf_child_update ON building_use_request_rooms;
DROP POLICY IF EXISTS gf_child_delete ON building_use_request_rooms;
DROP POLICY IF EXISTS gf_child_rbac_select ON building_use_request_rooms;
DROP POLICY IF EXISTS gf_child_rbac_insert ON building_use_request_rooms;
DROP POLICY IF EXISTS gf_child_rbac_update ON building_use_request_rooms;
DROP POLICY IF EXISTS gf_child_rbac_delete ON building_use_request_rooms;


-- ============================================================================
-- 33-2: Create building_use_event_details child table
-- ============================================================================
-- Moves event logistics out of the parent step into its own page.
-- Parent keeps: identity, contact, scheduling, legal agreements, room selection.

CREATE TABLE IF NOT EXISTS public.building_use_event_details (
    id BIGSERIAL PRIMARY KEY,
    building_use_request_id BIGINT NOT NULL REFERENCES building_use_requests(id) ON DELETE CASCADE,
    event_title VARCHAR(255),
    event_description TEXT,
    frequency_of_use VARCHAR(255),
    event_scope INTEGER REFERENCES metadata.categories(id),
    charges_fee INTEGER REFERENCES metadata.categories(id),
    equipment_needs TEXT,
    setup_needs TEXT,
    needs_av_equipment BOOLEAN DEFAULT FALSE,
    accessibility_needs TEXT,
    guided_form_status_id INT REFERENCES metadata.statuses(id) DEFAULT get_initial_status('guided_form'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_building_use_event_details_parent
    ON building_use_event_details(building_use_request_id);
CREATE INDEX IF NOT EXISTS idx_building_use_event_details_event_scope
    ON building_use_event_details(event_scope);
CREATE INDEX IF NOT EXISTS idx_building_use_event_details_charges_fee
    ON building_use_event_details(charges_fee);
CREATE INDEX IF NOT EXISTS idx_building_use_event_details_gf_status
    ON building_use_event_details(guided_form_status_id);

-- Grants (same pattern as parent)
GRANT SELECT ON public.building_use_event_details TO web_anon;
GRANT ALL ON public.building_use_event_details TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE building_use_event_details_id_seq TO authenticated;


-- ============================================================================
-- 33-3: Migrate existing data from parent to child table
-- ============================================================================

INSERT INTO building_use_event_details (
    building_use_request_id, event_title, event_description,
    frequency_of_use, event_scope, charges_fee,
    equipment_needs, setup_needs, needs_av_equipment, accessibility_needs,
    guided_form_status_id, created_at
)
SELECT
    id, event_title, event_description,
    frequency_of_use, event_scope, charges_fee,
    equipment_needs, setup_needs, needs_av_equipment, accessibility_needs,
    guided_form_status_id, created_at
FROM building_use_requests
WHERE id NOT IN (SELECT building_use_request_id FROM building_use_event_details);


-- ============================================================================
-- 33-4: Drop moved columns from parent table
-- ============================================================================

ALTER TABLE building_use_requests DROP COLUMN IF EXISTS event_title;
ALTER TABLE building_use_requests DROP COLUMN IF EXISTS event_description;
ALTER TABLE building_use_requests DROP COLUMN IF EXISTS frequency_of_use;
ALTER TABLE building_use_requests DROP COLUMN IF EXISTS event_scope;
ALTER TABLE building_use_requests DROP COLUMN IF EXISTS charges_fee;
ALTER TABLE building_use_requests DROP COLUMN IF EXISTS equipment_needs;
ALTER TABLE building_use_requests DROP COLUMN IF EXISTS setup_needs;
ALTER TABLE building_use_requests DROP COLUMN IF EXISTS needs_av_equipment;
ALTER TABLE building_use_requests DROP COLUMN IF EXISTS accessibility_needs;


-- ============================================================================
-- 33-5: Register Event Details as guided form step 1
-- ============================================================================

SELECT public.add_guided_form_step(
    'building_use_request'::name,
    'event_details'::name,
    'Event Details'::varchar,
    1,
    'building_use_event_details'::name,
    'building_use_request_id'::name,
    'Describe your event, scheduling needs, and any equipment or accessibility requirements.'::text,
    FALSE   -- can_skip = FALSE (required step)
);


-- ============================================================================
-- 33-6: Update metadata (properties + validations)
-- ============================================================================

-- Remove stale properties for dropped parent columns
DELETE FROM metadata.properties
WHERE table_name = 'building_use_requests'
  AND column_name IN (
    'event_title', 'event_description', 'frequency_of_use',
    'event_scope', 'charges_fee', 'equipment_needs',
    'setup_needs', 'needs_av_equipment', 'accessibility_needs'
);

-- Properties for new child table
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail, category_entity_type, join_table, join_column)
VALUES
    ('building_use_event_details', 'event_title',         'Event Title',          1, 2, false, true, true, true, NULL, NULL, NULL),
    ('building_use_event_details', 'event_description',   'Event Description',    2, 2, false, true, true, true, NULL, NULL, NULL),
    ('building_use_event_details', 'event_scope',         'Internal/External',    3, 1, false, true, true, true, 'building_use_event_scope', 'categories', 'id'),
    ('building_use_event_details', 'charges_fee',         'Charges a Fee?',       4, 1, false, true, true, true, 'building_use_charges_fee', 'categories', 'id'),
    ('building_use_event_details', 'frequency_of_use',    'Frequency of Use',     5, 1, false, true, true, true, NULL, NULL, NULL),
    ('building_use_event_details', 'equipment_needs',     'Equipment Needs',      10, 2, false, true, true, true, NULL, NULL, NULL),
    ('building_use_event_details', 'setup_needs',         'Setup Needs',          11, 2, false, true, true, true, NULL, NULL, NULL),
    ('building_use_event_details', 'needs_av_equipment',  'Needs AV Equipment',   12, 1, false, true, true, true, NULL, NULL, NULL),
    ('building_use_event_details', 'accessibility_needs', 'Accessibility Needs',  13, 2, false, true, true, true, NULL, NULL, NULL)
ON CONFLICT (table_name, column_name) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        sort_order = EXCLUDED.sort_order,
        column_width = EXCLUDED.column_width,
        show_on_list = EXCLUDED.show_on_list,
        show_on_create = EXCLUDED.show_on_create,
        show_on_edit = EXCLUDED.show_on_edit,
        show_on_detail = EXCLUDED.show_on_detail,
        category_entity_type = EXCLUDED.category_entity_type,
        join_table = EXCLUDED.join_table,
        join_column = EXCLUDED.join_column;

-- Hide system columns on child table
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
    ('building_use_event_details', 'building_use_request_id', false, false, false, false),
    ('building_use_event_details', 'guided_form_status_id', false, false, false, false),
    ('building_use_event_details', 'created_at', false, false, false, false),
    ('building_use_event_details', 'updated_at', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
    SET show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;

-- Move validations: remove old parent refs for moved columns, keep estimated_attendees
DELETE FROM metadata.validations
WHERE table_name = 'building_use_requests'
  AND column_name IN ('event_title');

-- Add validation on child table
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
    ('building_use_event_details', 'event_title', 'required', NULL, 'Event title is required', 1)
ON CONFLICT DO NOTHING;

-- Rebuild wfcheck constraints on child table
SELECT metadata.rebuild_guided_form_constraints('building_use_event_details');
-- Rebuild parent constraints (columns were dropped, stale constraints need cleanup)
SELECT metadata.rebuild_guided_form_constraints('building_use_requests');

-- Hide child table from sidebar
INSERT INTO metadata.entities (table_name, display_name, show_in_sidebar, guided_form_key)
VALUES ('building_use_event_details', 'Event Details', FALSE, 'building_use_request')
ON CONFLICT (table_name) DO UPDATE SET
    show_in_sidebar = FALSE,
    guided_form_key = 'building_use_request';


-- ============================================================================
-- 33-7: Add skip_if condition for private events on event_details step
-- ============================================================================
-- Private events auto-submit (no data steps needed). Same condition as old room_selection.

INSERT INTO metadata.guided_form_step_conditions (guided_form_step_id, condition_type, field, operator, value, sort_order)
SELECT gs.id, 'skip_if', 'group_type', 'eq',
    (SELECT id::text FROM metadata.categories WHERE entity_type = 'building_use_group_type' AND category_key = 'private_event'),
    0
FROM metadata.guided_form_steps gs
WHERE gs.guided_form_key = 'building_use_request' AND gs.step_key = 'event_details';


-- ============================================================================
-- 33-8: Schema decision (ADR)
-- ============================================================================

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, decision, decided_date
) VALUES (
    ARRAY['building_use_requests', 'building_use_event_details']::NAME[],
    'neh-33-building-use-restructure',
    'Remove broken room_selection step, split parent into two guided form steps',
    'accepted',
    'Two fixes: (1) Remove room_selection guided form step — junction tables (composite PK, no id '
    'column) are incompatible with ensure_guided_form_step_record(). Room selection stays as inline '
    'M:M on parent via show_inline=true. (2) Split 23-field parent step into two pages: Group & '
    'Contact info stays on parent (identity, contact, scheduling, legal, rooms), Event Details '
    '(title, description, scope, fees, equipment, accessibility) moved to new child table '
    'building_use_event_details registered as step 1. Existing data migrated.',
    CURRENT_DATE
);


NOTIFY pgrst, 'reload schema';
