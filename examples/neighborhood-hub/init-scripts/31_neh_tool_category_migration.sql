-- Neighborhood Engagement Hub - Migrate tool_categories to metadata.categories
--
-- Collapses the standalone tool_categories table into the Civic OS Category
-- system (v0.34.0+). The 5 tool categories become metadata.categories rows
-- with entity_type = 'tool_category', managed via /admin/categories instead
-- of a dedicated CRUD page.
--
-- Also fixes inventory_module_id which was missing category_entity_type,
-- causing the dropdown to show all 37 categories instead of just 2.

BEGIN;

-- ============================================================================
-- STEP 1: Create tool_category group + 5 values in metadata.categories
-- ============================================================================

INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('tool_category', 'Tool Category')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, category_key, description, color, sort_order)
VALUES
  ('tool_category', 'Power Tools',         'power_tools',         'Motorized and electric tools',          '#dc2626', 1),
  ('tool_category', 'Hand Tools',          'hand_tools',          'Manual tools for yard and garden work', '#22c55e', 2),
  ('tool_category', 'Accessibility Tools', 'accessibility_tools', 'Ergonomic and adaptive tools',          '#8b5cf6', 3),
  ('tool_category', 'Snow Removal',        'snow_removal',        'Snow clearing equipment',               '#3b82f6', 4),
  ('tool_category', 'Mobile Event Kit',    'mobile_event_kit',    'Equipment for community events',        '#f59e0b', 5)
ON CONFLICT (entity_type, display_name) DO NOTHING;

-- ============================================================================
-- STEP 2: Remap tool_types.category_id FK from tool_categories → metadata.categories
-- ============================================================================

-- Drop old FK constraint
ALTER TABLE tool_types DROP CONSTRAINT tool_types_category_id_fkey;

-- Remap IDs: join on display_name to map old tool_categories IDs → new metadata.categories IDs
UPDATE tool_types tt
SET category_id = mc.id
FROM tool_categories tc
JOIN metadata.categories mc
  ON mc.display_name = tc.display_name
  AND mc.entity_type = 'tool_category'
WHERE tt.category_id = tc.id;

-- Add new FK constraint pointing to metadata.categories
ALTER TABLE tool_types
  ADD CONSTRAINT tool_types_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES metadata.categories(id);

-- ============================================================================
-- STEP 3: Set category_entity_type on tool_types.category_id
-- ============================================================================
-- This tells the frontend to render colored Category badges instead of a
-- plain FK dropdown, and scopes the dropdown to only tool_category values.

INSERT INTO metadata.properties (table_name, column_name, display_name, category_entity_type)
VALUES ('tool_types', 'category_id', 'Category', 'tool_category')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      category_entity_type = EXCLUDED.category_entity_type;

-- ============================================================================
-- STEP 4: Fix inventory_module_id (bonus)
-- ============================================================================
-- Pre-existing bug: inventory_module_id FKs to metadata.categories but has no
-- category_entity_type set, so the dropdown shows all 37 categories instead
-- of just Tool Shed and Event Kit.

UPDATE metadata.properties
SET category_entity_type = 'inventory_module'
WHERE table_name = 'tool_types' AND column_name = 'inventory_module_id';

-- ============================================================================
-- STEP 5: Clean up tool_categories entity
-- ============================================================================

-- 5a: Remove metadata.entities registration (removes sidebar entry + CRUD page)
DELETE FROM metadata.entities WHERE table_name = 'tool_categories';

-- 5b: Remove metadata.properties rows
DELETE FROM metadata.properties WHERE table_name = 'tool_categories';

-- 5c: Remove RBAC permissions
DELETE FROM metadata.permission_roles WHERE permission_id IN (
  SELECT id FROM metadata.permissions WHERE table_name = 'tool_categories'
);
DELETE FROM metadata.permissions WHERE table_name = 'tool_categories';

-- 5d: Revoke database grants
REVOKE ALL ON tool_categories FROM web_anon;
REVOKE ALL ON tool_categories FROM authenticated;
REVOKE ALL ON SEQUENCE tool_categories_id_seq FROM authenticated;

-- 5e: Drop the table
DROP TABLE tool_categories;

-- ============================================================================
-- STEP 6: ADR - Record the decision
-- ============================================================================

-- Direct INSERT because create_schema_decision() requires JWT admin context,
-- which isn't available in init scripts (they run as postgres superuser).
INSERT INTO metadata.schema_decisions (entity_types, property_names, title, decision, context, rationale, consequences)
VALUES (
  ARRAY['tool_types']::name[],
  ARRAY['category_id']::name[],
  'Migrate tool_categories to metadata.categories',
  'Collapsed standalone tool_categories table into the Civic OS Category system (entity_type = tool_category). Tool categories are now managed via /admin/categories.',
  'tool_categories had 5 rows with its own CRUD page, sidebar entry, grants, and RBAC permissions — all overhead for what is structurally identical to metadata.categories. NEH is in prod but pre-launch, making this the ideal time to simplify.',
  'The Category system (v0.34.0) already provides colored badges, admin UI (/admin/categories), and scoped dropdowns via category_entity_type. Using it eliminates a standalone entity, its permissions matrix, and a sidebar entry. Also fixed inventory_module_id missing category_entity_type.',
  'Tool Categories no longer appear in the sidebar. Staff manage categories via /admin/categories instead. The tool_categories table no longer exists — any direct SQL references must use metadata.categories with entity_type = tool_category.'
);

COMMIT;
