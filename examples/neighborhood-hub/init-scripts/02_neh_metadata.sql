-- Neighborhood Engagement Hub - Entity & Property Metadata
-- NOTE: Uses direct INSERT instead of upsert_entity_metadata() because init scripts
-- run as postgres superuser, not through JWT auth (which is_admin() requires).

-- Entity display configuration
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES
  ('tool_categories',   'Tool Categories',   'Categories of tools available for borrowing', 1),
  ('tool_types',        'Tool Types',        'Specific types of tools within each category', 2),
  ('tool_instances',    'Tool Instances',    'Individual tools tracked for lending', 3),
  ('borrowers',         'Borrowers',         'Community members who borrow tools', 4),
  ('tool_reservations', 'Tool Reservations', 'Reservations for borrowing tools', 5),
  ('projects',          'Projects',          'Neighborhood improvement projects', 6),
  ('parcels',           'Parcels',           'Properties in the neighborhood', 7)
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- Property display configuration
-- Hide timestamps from list/create
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit)
VALUES
  ('tool_categories', 'created_at', false, false, false),
  ('tool_categories', 'updated_at', false, false, false),
  ('tool_types', 'created_at', false, false, false),
  ('tool_types', 'updated_at', false, false, false),
  ('borrowers', 'created_at', false, false, false),
  ('borrowers', 'updated_at', false, false, false),
  ('tool_reservations', 'created_at', false, false, false),
  ('tool_reservations', 'updated_at', false, false, false),
  ('projects', 'created_at', false, false, false),
  ('projects', 'updated_at', false, false, false),
  ('tool_instances', 'created_at', false, false, false),
  ('tool_instances', 'updated_at', false, false, false),
  ('parcels', 'created_at', false, false, false),
  ('parcels', 'updated_at', false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit;

-- Configure Status type columns
INSERT INTO metadata.properties (table_name, column_name, display_name, status_entity_type)
VALUES
  ('borrowers', 'status_id', 'Status', 'borrowers'),
  ('tool_instances', 'status_id', 'Condition', 'tool_instances')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      status_entity_type = EXCLUDED.status_entity_type;

-- ============================================================================
-- CATEGORIES (v0.34.0+)
-- ============================================================================

-- Parcel eligibility category group + values
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('parcel_eligibility', 'Parcel Eligibility');

INSERT INTO metadata.categories (entity_type, display_name, color, sort_order)
VALUES
  ('parcel_eligibility', 'Good',       '#22c55e', 1),
  ('parcel_eligibility', 'Few Issues', '#f59e0b', 2),
  ('parcel_eligibility', 'Ineligible', '#ef4444', 3);

-- Configure eligibility column as Category type
INSERT INTO metadata.properties (table_name, column_name, display_name, category_entity_type)
VALUES ('parcels', 'eligibility', 'Eligibility', 'parcel_eligibility')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      category_entity_type = EXCLUDED.category_entity_type;

-- Parcel property class category group + values (polygon color source)
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('parcel_property_class', 'Property Class');

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('parcel_property_class', 'Residential',  'residential',  '#22c55e', 1),
  ('parcel_property_class', 'Commercial',   'commercial',   '#3b82f6', 2),
  ('parcel_property_class', 'Industrial',   'industrial',   '#f59e0b', 3),
  ('parcel_property_class', 'Agricultural', 'agricultural', '#8b5cf6', 4);

-- Configure property_class column as Category type
INSERT INTO metadata.properties (table_name, column_name, display_name, category_entity_type)
VALUES ('parcels', 'property_class', 'Property Class', 'parcel_property_class')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      category_entity_type = EXCLUDED.category_entity_type;

-- Configure parcels for full-text search (expanded fields) and polygon map
UPDATE metadata.entities SET
  search_fields = '{display_name,parcel_number,prop_street,prop_zip}',
  show_map = true,
  map_property_name = 'boundary',
  map_color_property = 'property_class'
WHERE table_name = 'parcels';

-- Hide boundary from list view (the list page map already shows all polygons)
INSERT INTO metadata.properties (table_name, column_name, show_on_list)
VALUES ('parcels', 'boundary', false)
ON CONFLICT (table_name, column_name) DO UPDATE SET show_on_list = false;

-- Hide civic_os_text_search generated column
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES ('parcels', 'civic_os_text_search', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;

-- ============================================================================
-- PHOTO GALLERY (v0.47.0)
-- ============================================================================

-- Configure gallery constraints for projects.photos
INSERT INTO metadata.photo_gallery_config (table_name, column_name, max_images, allowed_types)
VALUES ('projects', 'photos', 10, 'image/jpeg,image/png,image/webp')
ON CONFLICT (table_name, column_name) DO NOTHING;

-- Configure photos property display
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width)
VALUES ('projects', 'photos', 'Photos', 50, 2)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width;

-- ============================================================================
-- M:M SEARCH MODAL + INLINE POSITIONING (v0.46.0)
-- ============================================================================

-- Enable search modal and inline positioning on project_parcels M:M
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, show_inline)
VALUES ('projects', 'project_parcels_m2m', true, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = true, show_inline = true;

-- Enable FK search modal on borrower_id (single-select modal)
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, join_table)
VALUES ('tool_reservations', 'borrower_id', true, 'borrowers')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = true, join_table = 'borrowers';
