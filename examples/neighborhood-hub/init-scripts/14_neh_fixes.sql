-- Neighborhood Engagement Hub - Post-deploy fixes
-- 1. Fix land_bank_status category rendering (missing category_entity_type)
-- 2. Fix nav_buttons: "label" → "text" on all dashboards, move to top
-- 3. Humanize property display names (remove "Id" suffixes from FK column headers)
-- 4. Fix entity display names (raw table_name → human-readable)
-- 5. Tool Reservation Guided Form fixes:
--    a. Add missing submitted_at column
--    b. Hide notes/site_review_completed from step 1
--    c. Widen timeslot to 2 columns
--    d. Rename step 2 "Tool Selection"
--    e. Show all tools except Mobile Event Kit (was showing only 5/83)
--    f. Hide "Qty Managed" from tool_types list
--    g. Rename step 3 "Parcel Selection", make non-skippable
--    h. Remove options_source_rpc from parcels M:M (42K rows caused Bad Request)
BEGIN;

-- ============================================================================
-- 1. Fix land_bank_status category rendering
--    Script 13 created the column and category group but didn't set
--    category_entity_type in metadata.properties, so the frontend renders
--    it as a plain integer FK instead of colored Category badges.
-- ============================================================================

UPDATE metadata.properties
SET category_entity_type = 'parcel_land_bank'
WHERE table_name = 'parcels' AND column_name = 'land_bank_status';

-- ============================================================================
-- 2. Fix nav_buttons widgets across all three NEH dashboards
--    Bug: Script 10 used "label" key but NavButtonsWidgetConfig expects "text".
--    All buttons render empty because {{ button.text }} resolves to undefined.
--    Also moves nav_buttons to sort_order 5 (top of dashboard) per UX feedback.
-- ============================================================================

-- 2a. Borrower dashboard: fix button text + move to top
UPDATE metadata.dashboard_widgets
SET sort_order = 5,
    config = '{"buttons": [{"text": "Request Tool", "url": "/create/tool_reservations", "variant": "primary"}, {"text": "Request Building Use", "url": "/create/building_use_requests", "variant": "primary"}, {"text": "Request Event Kit", "url": "/create/mek_requests", "variant": "primary"}]}'::jsonb
WHERE id = (
  SELECT dw.id FROM metadata.dashboard_widgets dw
  JOIN metadata.dashboards d ON d.id = dw.dashboard_id
  WHERE d.display_name = 'NEH Borrower' AND dw.widget_type = 'nav_buttons'
);

-- 2b. Staff dashboard: fix button text + move to top
UPDATE metadata.dashboard_widgets
SET sort_order = 5,
    config = '{"buttons": [{"text": "Approve Requests", "url": "/view/tool_reservations", "variant": "primary"}, {"text": "Create Reservation", "url": "/create/tool_reservations"}, {"text": "Manage Inventory", "url": "/view/tool_instances"}, {"text": "Building Use", "url": "/view/building_use_requests"}, {"text": "Event Kit Requests", "url": "/view/mek_requests"}]}'::jsonb
WHERE id = (
  SELECT dw.id FROM metadata.dashboard_widgets dw
  JOIN metadata.dashboards d ON d.id = dw.dashboard_id
  WHERE d.display_name = 'NEH Staff' AND dw.widget_type = 'nav_buttons'
);

-- 2c. Admin dashboard: fix button text + move to top
UPDATE metadata.dashboard_widgets
SET sort_order = 5,
    config = '{"buttons": [{"text": "Manage Users", "url": "/admin/users", "variant": "primary"}, {"text": "Permissions", "url": "/permissions"}, {"text": "Manage Inventory", "url": "/view/tool_instances"}, {"text": "Building Use", "url": "/view/building_use_requests"}, {"text": "Event Kit", "url": "/view/mek_requests"}]}'::jsonb
WHERE id = (
  SELECT dw.id FROM metadata.dashboard_widgets dw
  JOIN metadata.dashboards d ON d.id = dw.dashboard_id
  WHERE d.display_name = 'NEH Admin' AND dw.widget_type = 'nav_buttons'
);

-- 2d. Remove the generic "My Status" markdown widget from borrower dashboard
--     It just says "contact NEH if you need approval" — not actionable.
DELETE FROM metadata.dashboard_widgets
WHERE id = (
  SELECT dw.id FROM metadata.dashboard_widgets dw
  JOIN metadata.dashboards d ON d.id = dw.dashboard_id
  WHERE d.display_name = 'NEH Borrower' AND dw.widget_type = 'markdown'
    AND dw.config->>'content' LIKE '%My Status%'
);

-- ============================================================================
-- 3. Humanize FK property display names
--    FK columns auto-generate "Something Id" headers. The cell values already
--    show the related record's name — only the column header is wrong.
-- ============================================================================

INSERT INTO metadata.properties (table_name, column_name, display_name)
VALUES
  -- borrowers
  ('borrowers',              'user_id',              'Account'),
  -- building_use_requests
  ('building_use_requests',  'borrower_id',          'Applicant'),
  ('building_use_requests',  'status_id',            'Status'),
  -- checkout_instances
  ('checkout_instances',     'checkout_id',          'Checkout'),
  ('checkout_instances',     'tool_instance_id',     'Tool'),
  -- mek_requests
  ('mek_requests',           'borrower_id',          'Requester'),
  -- project_parcels
  ('project_parcels',        'parcel_id',            'Parcel'),
  ('project_parcels',        'project_id',           'Project'),
  -- tool_instances
  ('tool_instances',         'tool_type_id',         'Tool Type'),
  -- tool_reservations
  ('tool_reservations',      'borrower_id',          'Borrower'),
  -- tool_types
  ('tool_types',             'category_id',          'Category'),
  ('tool_types',             'inventory_module_id',  'Inventory Module'),
  -- training_records
  ('training_records',       'borrower_id',          'Trainee'),
  -- work_site_parcels
  ('work_site_parcels',      'parcel_id',            'Parcel'),
  ('work_site_parcels',      'work_site_id',         'Work Site')
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name;

-- ============================================================================
-- 4. Fix entity display names (raw table_name → human-readable)
-- ============================================================================

INSERT INTO metadata.entities (table_name, display_name)
VALUES
  ('checkout_instances', 'Checked Out Tools'),
  ('project_parcels',    'Project Parcels'),
  ('work_site_parcels',  'Work Site Parcels')
ON CONFLICT (table_name) DO UPDATE
SET display_name = EXCLUDED.display_name;

-- ============================================================================
-- 5. Tool Reservation Guided Form fixes
-- ============================================================================

-- 5a. Add submitted_at column (required by submit_guided_form RPC)
--     building_use_requests and mek_requests already have it; tool_reservations was missed.
ALTER TABLE tool_reservations ADD COLUMN submitted_at TIMESTAMPTZ;

-- 5b. Step 1: Hide "notes" and "site_review_completed" from create form
--     These are staff-managed fields, not borrower inputs.
INSERT INTO metadata.properties (table_name, column_name, show_on_create)
VALUES
  ('tool_reservations', 'notes', false),
  ('tool_reservations', 'site_review_completed', false)
ON CONFLICT (table_name, column_name) DO UPDATE
SET show_on_create = EXCLUDED.show_on_create;

-- 5c. Step 1: Widen timeslot to full width (column_width = 2) for readability
INSERT INTO metadata.properties (table_name, column_name, column_width)
VALUES ('tool_reservations', 'timeslot', 2)
ON CONFLICT (table_name, column_name) DO UPDATE
SET column_width = EXCLUDED.column_width;

-- 5d. Step 2: Rename "Select Tools" → "Tool Selection", move sort_order first
UPDATE metadata.guided_form_steps
SET display_name = 'Tool Selection'
WHERE guided_form_key = 'tool_reservation' AND step_key = 'tools';

-- 5e. Step 2: Show ALL tools except Mobile Event Kit (remove availability check)
--     Original RPC required is_qty_managed=true OR in-service instance, showing only 5/83 tools.
CREATE OR REPLACE FUNCTION public.get_available_tool_types(p_id TEXT DEFAULT NULL, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT tt.id, tt.display_name::TEXT
    FROM tool_types tt
    LEFT JOIN metadata.categories c ON tt.inventory_module_id = c.id
    WHERE c.category_key IS DISTINCT FROM 'event_kit'
    ORDER BY tt.display_name;
$$;

-- 5f. Step 2: Hide "Qty Managed" from tool_types list view
INSERT INTO metadata.properties (table_name, column_name, display_name, show_on_list)
VALUES ('tool_types', 'is_qty_managed', 'Qty Managed', false)
ON CONFLICT (table_name, column_name) DO UPDATE
SET show_on_list = EXCLUDED.show_on_list;

-- 5g. Step 3: Rename "Work Site" → "Parcel Selection", make non-skippable
UPDATE metadata.guided_form_steps
SET display_name = 'Parcel Selection',
    can_skip = false
WHERE guided_form_key = 'tool_reservation' AND step_key = 'work_site';

-- 5h. Step 3: Remove options_source_rpc from work_site_parcels M:M
--     get_eligible_parcels_new returns 42,510 rows — the frontend passes all IDs
--     as a filter param, exceeding URL length limits and causing Bad Request.
--     Without the RPC, the M:M editor shows all parcels with standard pagination.
UPDATE metadata.properties
SET options_source_rpc = NULL
WHERE table_name = 'tool_reservation_work_site'
  AND column_name = 'work_site_parcels_m2m';

COMMIT;
