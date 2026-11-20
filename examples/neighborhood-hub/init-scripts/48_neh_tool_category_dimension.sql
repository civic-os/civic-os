-- Neighborhood Engagement Hub - Tool categories as a nested dimension
-- 48: Dimensions registry (metadata.dimensions, v0.85.0+; Dimension property type, v0.86.0+)
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Reverses 31_neh_tool_category_migration.sql, which collapsed tool_categories into the Category system
-- (metadata.categories, entity_type 'tool_category'). The flat Category list could not group ~80 tool types,
-- and the dimensions registry now gives a lookup table everything that move was for, plus a hierarchy:
--   - tool_categories is a table again (BIGINT key, as the registry requires), with parent_id, is_active and
--     sort_order, holding the 5 top-level categories and nested sub-categories up to three levels
--     (Hand Tools > Digging & Soil > Shovels);
--   - tool_types.category_id points at it (INT to BIGINT) and becomes the Dimension property type: a searchable
--     tree select ordered by sort_order; the category's own Parent field gets the same control, with a
--     category and its descendants disabled, and parent cycles are refused by the server;
--   - categories are retired by clearing is_active (deleting one is refused);
--   - the 5 metadata.categories rows (entity_type 'tool_category') and their group are removed.
-- The Category badges' colors are kept in a color column, but the Dimension control does not show them.

BEGIN;

-- ============================================================================
-- 1. The table
-- ============================================================================

CREATE TABLE public.tool_categories (
    id BIGSERIAL PRIMARY KEY,
    parent_id BIGINT REFERENCES public.tool_categories(id),
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    color hex_color DEFAULT '#3B82F6',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON public.tool_categories(parent_id);

-- Top level: the 5 categories, carried over from metadata.categories with their order and colors
INSERT INTO public.tool_categories (display_name, description, color, sort_order)
SELECT c.display_name, c.description, c.color, c.sort_order
FROM metadata.categories c
WHERE c.entity_type = 'tool_category'
ORDER BY c.sort_order;

-- Nested levels: (parent, name, description, sort_order), parents before children
INSERT INTO public.tool_categories (parent_id, display_name, description, sort_order)
SELECT p.id, v.name, v.description, v.sort_order
FROM (VALUES
  ('Power Tools',      'Mowers & Trimmers',  'Mowing, trimming and edging',            1),
  ('Power Tools',      'Saws & Cutting',     'Chainsaws and powered saws',             2),
  ('Power Tools',      'Tilling & Blowing',  'Tillers and leaf blowers',               3),
  ('Hand Tools',       'Digging & Soil',     'Digging, cultivating and planting',      1),
  ('Hand Tools',       'Pruning & Cutting',  'Pruning, lopping and hand saws',         2),
  ('Hand Tools',       'Raking & Cleanup',   'Rakes, brooms and scrapers',             3),
  ('Mobile Event Kit', 'Games',              'Lawn and party games',                   1),
  ('Mobile Event Kit', 'Tents & Furniture',  'Shelter, tables and seating',            2)
) AS v(parent, name, description, sort_order)
JOIN public.tool_categories p ON p.display_name = v.parent AND p.parent_id IS NULL;

INSERT INTO public.tool_categories (parent_id, display_name, description, sort_order)
SELECT p.id, 'Shovels', 'Flat and round shovels', 1
FROM public.tool_categories p WHERE p.display_name = 'Digging & Soil';

-- ============================================================================
-- 2. tool_types.category_id: from metadata.categories to tool_categories, INT to BIGINT
-- ============================================================================

ALTER TABLE public.tool_types DROP CONSTRAINT tool_types_category_id_fkey;

UPDATE public.tool_types tt
SET category_id = tc.id
FROM metadata.categories mc
JOIN public.tool_categories tc ON tc.display_name = mc.display_name AND tc.parent_id IS NULL
WHERE mc.entity_type = 'tool_category' AND tt.category_id = mc.id;

ALTER TABLE public.tool_types ALTER COLUMN category_id TYPE BIGINT;
ALTER TABLE public.tool_types
  ADD CONSTRAINT tool_types_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.tool_categories(id);

-- Move tool types into the sub-categories
UPDATE public.tool_types tt
SET category_id = tc.id
FROM (VALUES
  ('Mowers & Trimmers', ARRAY['Push Mower', 'Riding Mower', 'Zero Turn Mower', 'Brush Hog', 'DR Trimmer', 'String Trimmer',
                              'Stihl Weed Trimmer', 'Edger (Electric)', 'Edger (Gas)', 'Hedge Hog Edger']),
  ('Saws & Cutting',    ARRAY['Chainsaw 16"', 'Chainsaw 20"', 'Circular Saw', 'Porter Cable Tiger Saw']),
  ('Tilling & Blowing', ARRAY['Mantis Tiller', 'Power Mate Roto Tiller', 'Leaf Blower (Electric)', 'Leaf Blower (Gas)']),
  ('Digging & Soil',    ARRAY['Broadfork', 'Cultivator', 'Hoe', 'Stirrup Hoe', 'Pitchfork', 'Post Hole Digger', 'Trowel',
                              'Weeder', 'Pick-Ax']),
  ('Shovels',           ARRAY['Shovel (Flat)', 'Shovel (Round)']),
  ('Pruning & Cutting', ARRAY['Hedge Shears', 'Loppers', 'Pole Saw', 'Pruners', 'Saw (Hand)', 'Ax', 'Weed Whip']),
  ('Raking & Cleanup',  ARRAY['Rake (Bow)', 'Rake (Garden)', 'Rake (Leaf)', 'Push Broom', 'Scraper']),
  ('Games',             ARRAY['Bucket Ball Game', 'Corn-Hole Games', 'Giant Connect-Four', 'Spike Ball Game']),
  ('Tents & Furniture', ARRAY['Folding Chair', 'Folding Table', 'Tent 10x10', 'Tent 10x20'])
) AS v(category, tool_names)
JOIN public.tool_categories tc ON tc.display_name = v.category
WHERE tt.display_name = ANY (v.tool_names);

-- tool_types.category_id is no longer a Category column (the Dimension type follows from the FK target)
UPDATE metadata.properties SET category_entity_type = NULL
WHERE table_name = 'tool_types' AND column_name = 'category_id';

DELETE FROM metadata.categories WHERE entity_type = 'tool_category';
DELETE FROM metadata.category_groups WHERE entity_type = 'tool_category';

-- ============================================================================
-- 3. Grants, permissions, entity metadata and menu (as in 02, 04 and 46)
-- ============================================================================

GRANT SELECT ON public.tool_categories TO web_anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tool_categories TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.tool_categories_id_seq TO authenticated;

INSERT INTO metadata.permissions (table_name, permission)
SELECT 'tool_categories', p::metadata.permission FROM unnest(ARRAY['read', 'create', 'update', 'delete']) p
ON CONFLICT (table_name, permission) DO NOTHING;

-- admin, editor and neh_admin: everything; neh_staff: all but delete; neh_borrower and anonymous: read
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT pm.id, r.id
FROM metadata.permissions pm
JOIN metadata.roles r ON
     r.role_key IN ('admin', 'editor', 'neh_admin')
  OR (r.role_key = 'neh_staff' AND pm.permission <> 'delete')
  OR (r.role_key IN ('neh_borrower', 'anonymous') AND pm.permission = 'read')
WHERE pm.table_name = 'tool_categories'
ON CONFLICT (permission_id, role_id) DO NOTHING;

INSERT INTO metadata.entities (table_name, display_name, description, search_fields, sort_order)
VALUES ('tool_categories', 'Tool Categories', 'Nested categories of tools available for borrowing', '{display_name}', 4)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name, description = EXCLUDED.description,
  search_fields = EXCLUDED.search_fields, sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('tool_categories', 'display_name', 'Name',        1, TRUE,  TRUE,  TRUE,  TRUE),
  ('tool_categories', 'parent_id',    'Parent',      2, TRUE,  TRUE,  TRUE,  TRUE),
  ('tool_categories', 'description',  'Description', 3, FALSE, TRUE,  TRUE,  TRUE),
  ('tool_categories', 'color',        'Color',       4, FALSE, TRUE,  TRUE,  TRUE),
  ('tool_categories', 'is_active',    'Active',      5, TRUE,  FALSE, TRUE,  TRUE),
  ('tool_categories', 'sort_order',   'Sort Order',  6, FALSE, TRUE,  TRUE,  TRUE),
  ('tool_categories', 'created_at',   'Created',     7, FALSE, FALSE, FALSE, FALSE),
  ('tool_categories', 'updated_at',   'Updated',     8, FALSE, FALSE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name, sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list, show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit, show_on_detail = EXCLUDED.show_on_detail;

-- In the menu next to Tool Types, under the Inventory heading
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES ('tool_categories', 'entity', 'tool_categories', 'inventory', 20)
ON CONFLICT (node_key) DO UPDATE SET parent_node_key = EXCLUDED.parent_node_key, sort_order = EXCLUDED.sort_order;

-- ============================================================================
-- 4. Register the dimension and record the decision
-- ============================================================================

-- sort_order is picked up by convention; no default (a tool type always names its category)
SELECT public.register_dimension(
  p_dimension_key := 'tool_category',
  p_display_name  := 'Tool Category',
  p_table_schema  := 'public',
  p_table_name    := 'tool_categories',
  p_parent_column := 'parent_id');

-- The init scripts run as the deployment role, which create_schema_decision() admits since v0.84.0.
SELECT public.create_schema_decision(
  p_title          := 'Tool categories are a nested dimension',
  p_entity_types   := ARRAY['tool_categories', 'tool_types']::NAME[],
  p_property_names := ARRAY['category_id', 'parent_id']::NAME[],
  p_context        := 'Script 31 collapsed tool_categories into the Category system to drop a standalone entity. With about 80 tool types, a flat list of 5 categories cannot group them, and the dimensions registry (v0.85.0) now provides a hierarchical lookup with a tree select, retirement instead of deletion and parent-cycle protection.',
  p_decision       := 'Re-create tool_categories as a table with parent_id, is_active and sort_order, nest sub-categories up to three levels, repoint tool_types.category_id to it as BIGINT, register it as the tool_category dimension, and remove the tool_category Category values.',
  p_rationale      := 'A nested dimension groups tool types where a flat Category list cannot, and the Dimension property type gives every category picker a searchable tree.',
  p_consequences   := 'Tool categories are managed at /view/tool_categories again, not /admin/categories. Categories cannot be deleted (clear Active instead). The colored Category badges on tool types become plain category names; colors stay in tool_categories.color.',
  p_migration_id   := 'neighborhood-hub/48_neh_tool_category_dimension',
  p_supersedes_id  := (SELECT id FROM metadata.schema_decisions WHERE title = 'Migrate tool_categories to metadata.categories' ORDER BY id DESC LIMIT 1));

COMMIT;

NOTIFY pgrst, 'reload schema';
