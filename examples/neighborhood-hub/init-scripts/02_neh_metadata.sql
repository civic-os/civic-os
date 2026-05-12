-- Neighborhood Engagement Hub - Entity & Property Metadata
-- NOTE: Uses direct INSERT instead of upsert_entity_metadata() because init scripts
-- run as postgres superuser, not through JWT auth (which is_admin() requires).

-- Entity display configuration
INSERT INTO metadata.entities (table_name, display_name, description, search_fields, sort_order)
VALUES
  ('tool_categories',   'Tool Categories',   'Categories of tools available for borrowing', '{display_name}', 1),
  ('tool_types',        'Tool Types',        'Specific types of tools within each category', '{display_name}', 2),
  ('tool_instances',    'Tool Instances',    'Individual tools tracked for lending', '{display_name}', 3),
  ('borrowers',         'Borrowers',         'Community members who borrow tools', '{display_name,phone,email}', 4),
  ('tool_reservations', 'Tool Reservations', 'Reservations for borrowing tools', '{display_name}', 5),
  ('tool_reservation_tools', 'Tool Selection', 'Selected tools for reservation', NULL, 5),
  ('tool_reservation_work_site', 'Work Site', 'Parcel selections for reservation', NULL, 5),
  ('tool_reservation_checkouts', 'Checkouts', 'Checkout records for tool reservations', NULL, 5),
  ('projects',          'Projects',          'Neighborhood improvement projects', '{display_name}', 6),
  ('parcels',           'Parcels',           'Properties in the neighborhood', '{display_name,parcel_number,prop_street,prop_zip}', 7),
  ('census_block_groups', 'Census Block Groups', 'HUD CDBG Low-to-Moderate Income block group boundaries', '{display_name,geoid}', 8),
  ('training_records',  'Training Records',  'Certification and training records for borrowers', '{display_name}', 9)
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      search_fields = EXCLUDED.search_fields,
      sort_order = EXCLUDED.sort_order;

-- Property display configuration
-- Hide timestamps from list/create
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('tool_categories', 'created_at', false, false, false, false),
  ('tool_categories', 'updated_at', false, false, false, false),
  ('tool_types', 'created_at', false, false, false, false),
  ('tool_types', 'updated_at', false, false, false, false),
  ('borrowers', 'created_at', false, false, false, false),
  ('borrowers', 'updated_at', false, false, false, false),
  ('tool_reservations', 'created_at', false, false, false, false),
  ('tool_reservations', 'updated_at', false, false, false, false),
  ('projects', 'created_at', false, false, false, false),
  ('projects', 'updated_at', false, false, false, false),
  ('tool_instances', 'created_at', false, false, false, false),
  ('tool_instances', 'updated_at', false, false, false, false),
  ('parcels', 'created_at', false, false, false, false),
  ('parcels', 'updated_at', false, false, false, false),
  -- Census block groups (timestamps hidden)
  ('census_block_groups', 'created_at', false, false, false, false),
  ('census_block_groups', 'updated_at', false, false, false, false),
  -- Step table: tool_reservation_tools (timestamps + FK hidden)
  ('tool_reservation_tools', 'created_at', false, false, false, false),
  ('tool_reservation_tools', 'updated_at', false, false, false, false),
  ('tool_reservation_tools', 'tool_reservation_id', false, false, false, false),
  -- Step table: tool_reservation_work_site (timestamps + FK hidden)
  ('tool_reservation_work_site', 'created_at', false, false, false, false),
  ('tool_reservation_work_site', 'updated_at', false, false, false, false),
  ('tool_reservation_work_site', 'tool_reservation_id', false, false, false, false),
  -- Checkout entity (timestamps + FK hidden)
  ('tool_reservation_checkouts', 'created_at', false, false, false, false),
  ('tool_reservation_checkouts', 'updated_at', false, false, false, false),
  ('tool_reservation_checkouts', 'tool_reservation_id', false, false, false, false),
  -- Training records (timestamps hidden)
  ('training_records', 'created_at', false, false, false, false),
  ('training_records', 'updated_at', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit,
      show_on_detail = EXCLUDED.show_on_detail;

-- Configure Status type columns
INSERT INTO metadata.properties (table_name, column_name, display_name, status_entity_type)
VALUES
  ('borrowers', 'status_id', 'Status', 'borrowers'),
  ('tool_instances', 'status_id', 'Condition', 'tool_instances'),
  ('tool_reservation_checkouts', 'status_id', 'Checkout Status', 'tool_reservation_checkouts'),
  ('training_records', 'status_id', 'Status', 'training_records')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      status_entity_type = EXCLUDED.status_entity_type;

-- Hide display_name from create (auto-generated by trigger) and reserved_date (redundant with timeslot)
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('tool_reservations', 'display_name', true, false, false, false),
  ('tool_reservations', 'reserved_date', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit,
      show_on_detail = EXCLUDED.show_on_detail;

-- Remove stale metadata for deleted columns (category_id, tool_type_id, quantity, checkout_photos, etc.)
DELETE FROM metadata.properties
WHERE table_name = 'tool_reservations'
  AND column_name IN ('category_id', 'tool_type_id', 'quantity', 'checkout_photos', 'return_photos', 'checkout_notes', 'return_notes');

-- Remove stale metadata for renamed borrower columns
DELETE FROM metadata.validations
WHERE table_name = 'borrowers'
  AND column_name IN ('drivers_license_front', 'drivers_license_back');
DELETE FROM metadata.properties
WHERE table_name = 'borrowers'
  AND column_name IN ('drivers_license_front', 'drivers_license_back');

-- ============================================================================
-- CATEGORIES (v0.34.0+)
-- ============================================================================

-- Add category group for inventory module
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('inventory_module', 'Inventory Module')
ON CONFLICT (entity_type) DO NOTHING;

-- Register categories for Tool Shed and Event Kit
INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('inventory_module', 'Tool Shed', 'tool_shed', '#22c55e', 1),
  ('inventory_module', 'Event Kit', 'event_kit', '#3b82f6', 2)
ON CONFLICT (entity_type, display_name) DO NOTHING;

-- Borrower type category group (T-1)
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('borrower_type', 'Borrower Type')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('borrower_type', 'Resident',        'resident',        '#22c55e', 1),
  ('borrower_type', 'Non-Resident',    'non_resident',    '#f59e0b', 2),
  ('borrower_type', 'Volunteer Group', 'volunteer_group', '#3b82f6', 3)
ON CONFLICT (entity_type, display_name) DO NOTHING;

-- Training type category group (T-5)
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('training_type', 'Training Type')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('training_type', 'Zero-Turn Mower', 'zero_turn_mower', '#dc2626', 1),
  ('training_type', 'Brush Hog',       'brush_hog',       '#f97316', 2),
  ('training_type', 'Tiller',          'tiller',          '#eab308', 3),
  ('training_type', 'General Safety',  'general_safety',  '#22c55e', 4)
ON CONFLICT (entity_type, display_name) DO NOTHING;

-- Parcel eligibility category group + values
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('parcel_eligibility', 'Parcel Eligibility');

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('parcel_eligibility', 'Good',       'good',       '#22c55e', 1),
  ('parcel_eligibility', 'Few Issues', 'few_issues', '#f59e0b', 2),
  ('parcel_eligibility', 'Ineligible', 'ineligible', '#ef4444', 3);

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

-- LMI Status category group + values (drives census block group map colors)
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('lmi_status', 'LMI Status');

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('lmi_status', 'LMI Qualified', 'lmi_qualified', '#22c55e', 1),  -- green
  ('lmi_status', 'Not LMI',       'not_lmi',       '#ef4444', 2);  -- red

-- Configure parcels for full-text search (expanded fields) and polygon map
UPDATE metadata.entities SET
  search_fields = '{display_name,parcel_number,prop_street,prop_zip}',
  show_map = true,
  map_property_name = 'boundary',
  map_color_property = 'lmi_status'
WHERE table_name = 'parcels';

-- Configure lmi_status column as Category type (RPC-populated, not user-editable)
INSERT INTO metadata.properties (table_name, column_name, display_name, category_entity_type,
  sort_order, column_width, show_on_list, show_on_create, show_on_edit, filterable)
VALUES ('parcels', 'lmi_status', 'LMI Status', 'lmi_status', 12, 1, true, false, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, category_entity_type = EXCLUDED.category_entity_type,
      sort_order = EXCLUDED.sort_order, column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list, show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit, filterable = EXCLUDED.filterable;

-- Hide boundary from list view (the list page map already shows all polygons)
INSERT INTO metadata.properties (table_name, column_name, show_on_list)
VALUES ('parcels', 'boundary', false)
ON CONFLICT (table_name, column_name) DO UPDATE SET show_on_list = false;

-- Hide civic_os_text_search generated column
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('parcels', 'civic_os_text_search', false, false, false, false),
  ('borrowers', 'civic_os_text_search', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;

-- ============================================================================
-- CENSUS BLOCK GROUPS METADATA
-- ============================================================================

-- Configure census_block_groups for full-text search and polygon map
UPDATE metadata.entities SET
  search_fields = '{display_name,geoid}',
  show_map = true,
  map_property_name = 'boundary',
  map_color_property = 'lmi_status'
WHERE table_name = 'census_block_groups';

-- Configure lmi_status column as Category type
INSERT INTO metadata.properties (table_name, column_name, display_name, category_entity_type, sort_order, column_width, show_on_list)
VALUES ('census_block_groups', 'lmi_status', 'LMI Status', 'lmi_status', 5, 1, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      category_entity_type = EXCLUDED.category_entity_type,
      sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list;

-- Property labels and visibility
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES
  ('census_block_groups', 'geoid', 'GEOID', 10, 1, true, true, true, true),
  ('census_block_groups', 'lowmod_pct', 'LMI Percentage', 15, 1, true, true, true, true),
  ('census_block_groups', 'lowmod', 'LMI Persons', 20, 1, false, true, true, true),
  ('census_block_groups', 'lowmod_universe', 'Total Population', 25, 1, false, true, true, true),
  ('census_block_groups', 'low', 'Low-Income Persons', 30, 1, false, true, true, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width, show_on_list = EXCLUDED.show_on_list,
      show_on_detail = EXCLUDED.show_on_detail, show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit;

-- Hide boundary and civic_os_text_search from list/create
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('census_block_groups', 'boundary', false, true, true, true),
  ('census_block_groups', 'civic_os_text_search', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  show_on_list = EXCLUDED.show_on_list, show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit, show_on_detail = EXCLUDED.show_on_detail;

-- ============================================================================
-- BORROWER PROPERTY METADATA
-- ============================================================================

-- Borrower display_name: auto-generated, show on list but not create/edit
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES ('borrowers', 'display_name', true, false, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = true, show_on_create = false, show_on_edit = false, show_on_detail = true;

-- user_id: system-managed, hidden from create/edit
INSERT INTO metadata.properties (table_name, column_name, show_on_create, show_on_edit)
VALUES ('borrowers', 'user_id', false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_create = false, show_on_edit = false;

-- Status: sort 5, show on list + detail + edit
INSERT INTO metadata.properties (table_name, column_name, display_name, status_entity_type, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES ('borrowers', 'status_id', 'Status', 'borrowers', 5, true, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, status_entity_type = EXCLUDED.status_entity_type,
      sort_order = EXCLUDED.sort_order, show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create, show_on_edit = EXCLUDED.show_on_edit;

-- Borrower type: sort 10, category dropdown
INSERT INTO metadata.properties (table_name, column_name, display_name, category_entity_type, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('borrowers', 'borrower_type', 'Borrower Type', 'borrower_type', 10, 1, true, true, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, category_entity_type = EXCLUDED.category_entity_type,
      sort_order = EXCLUDED.sort_order, column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list, show_on_detail = EXCLUDED.show_on_detail,
      show_on_create = EXCLUDED.show_on_create, show_on_edit = EXCLUDED.show_on_edit;

-- Phone/email: synced from user profile, show on list but not editable
INSERT INTO metadata.properties (table_name, column_name, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES
  ('borrowers', 'phone', 15, 1, true, true, false, false),
  ('borrowers', 'email', 16, 1, true, true, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order, column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list, show_on_detail = EXCLUDED.show_on_detail,
      show_on_create = EXCLUDED.show_on_create, show_on_edit = EXCLUDED.show_on_edit;

-- Phone verified: staff checkbox
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('borrowers', 'phone_verified', 'Phone Verified', 17, 1, false, true, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, sort_order = EXCLUDED.sort_order, column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list, show_on_detail = EXCLUDED.show_on_detail,
      show_on_create = EXCLUDED.show_on_create, show_on_edit = EXCLUDED.show_on_edit;

-- Address fields: staff enters during approval
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES
  ('borrowers', 'street', 'Street', 20, 2, false, true, false, true),
  ('borrowers', 'city', 'City', 21, 1, false, true, false, true),
  ('borrowers', 'state', 'State', 22, 1, false, true, false, true),
  ('borrowers', 'zip', 'Zip Code', 23, 1, false, true, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, sort_order = EXCLUDED.sort_order, column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list, show_on_detail = EXCLUDED.show_on_detail,
      show_on_create = EXCLUDED.show_on_create, show_on_edit = EXCLUDED.show_on_edit;

-- Photo ID / Address Proof / Liability Waiver: FileImage uploads
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES
  ('borrowers', 'photo_id', 'Photo ID', 60, 1, false, true, false, true),
  ('borrowers', 'address_proof', 'Address Proof', 61, 1, false, true, false, true),
  ('borrowers', 'liability_waiver', 'Liability Waiver', 62, 1, false, true, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, sort_order = EXCLUDED.sort_order, column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list, show_on_detail = EXCLUDED.show_on_detail,
      show_on_create = EXCLUDED.show_on_create, show_on_edit = EXCLUDED.show_on_edit;

-- File validations for borrower ID documents (updated from drivers_license to photo_id/address_proof)
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('borrowers', 'photo_id', 'fileType', 'image/*', 'Only image files are allowed', 1),
  ('borrowers', 'photo_id', 'maxFileSize', '5242880', 'File size must not exceed 5 MB', 2),
  ('borrowers', 'address_proof', 'fileType', 'image/*', 'Only image files are allowed', 1),
  ('borrowers', 'address_proof', 'maxFileSize', '5242880', 'File size must not exceed 5 MB', 2),
  ('borrowers', 'liability_waiver', 'fileType', 'image/*', 'Only image files are allowed', 1),
  ('borrowers', 'liability_waiver', 'maxFileSize', '5242880', 'File size must not exceed 5 MB', 2)
ON CONFLICT (table_name, column_name, validation_type) DO NOTHING;

-- ============================================================================
-- TOOL RESERVATIONS PROPERTY METADATA
-- ============================================================================

-- Site review completed: staff-only editable flag (T-6)
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('tool_reservations', 'site_review_completed', 'Site Review Completed', 35, 1, false, true, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, sort_order = EXCLUDED.sort_order, column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list, show_on_detail = EXCLUDED.show_on_detail,
      show_on_create = EXCLUDED.show_on_create, show_on_edit = EXCLUDED.show_on_edit;

-- ============================================================================
-- TRAINING RECORDS PROPERTY METADATA
-- ============================================================================

-- Training records entity: show in sidebar
UPDATE metadata.entities SET show_in_sidebar = true WHERE table_name = 'training_records';

-- Training record properties
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES
  ('training_records', 'borrower_id', NULL, 5, NULL, true, true, true, false),
  ('training_records', 'training_type', NULL, 10, 1, true, true, true, true),
  ('training_records', 'status_id', 'Status', 11, 1, true, true, false, true),
  ('training_records', 'date_earned', 'Date Earned', 15, 1, true, true, true, true),
  ('training_records', 'expiry_date', 'Expiry Date', 16, 1, true, true, true, true),
  ('training_records', 'trainer', 'Trainer Name', 20, 1, false, true, true, true),
  ('training_records', 'notes', 'Notes', 25, 2, false, true, true, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, sort_order = EXCLUDED.sort_order, column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list, show_on_detail = EXCLUDED.show_on_detail,
      show_on_create = EXCLUDED.show_on_create, show_on_edit = EXCLUDED.show_on_edit;

-- Configure training_type as Category property
INSERT INTO metadata.properties (table_name, column_name, display_name, category_entity_type)
VALUES ('training_records', 'training_type', 'Certification Type', 'training_type')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      category_entity_type = EXCLUDED.category_entity_type;

-- Configure training status
INSERT INTO metadata.properties (table_name, column_name, display_name, status_entity_type, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES ('training_records', 'status_id', 'Status', 'training_records', 11, true, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, status_entity_type = EXCLUDED.status_entity_type,
      sort_order = EXCLUDED.sort_order, show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create, show_on_edit = EXCLUDED.show_on_edit;

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

-- Configure photo gallery for checkout entity
INSERT INTO metadata.photo_gallery_config (table_name, column_name, max_images, allowed_types)
VALUES
  ('tool_reservation_checkouts', 'checkout_photos', 10, 'image/jpeg,image/png,image/webp'),
  ('tool_reservation_checkouts', 'return_photos', 10, 'image/jpeg,image/png,image/webp')
ON CONFLICT (table_name, column_name) DO NOTHING;

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width)
VALUES
  ('tool_reservation_checkouts', 'checkout_photos', 'Checkout Photos', 50, 2),
  ('tool_reservation_checkouts', 'return_photos', 'Return Photos', 51, 2)
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

-- Enable FK search modal on borrower_id with role-aware RPC filter
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, join_table, options_source_rpc)
VALUES ('tool_reservations', 'borrower_id', true, 'borrowers', 'get_borrowers_for_reservation')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = true, join_table = 'borrowers', options_source_rpc = 'get_borrowers_for_reservation';

-- Step 1: Tools M:M (inline search modal with available-only RPC filter)
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, show_inline, options_source_rpc)
VALUES ('tool_reservation_tools', 'tool_reservation_tool_items_m2m', true, true, 'get_available_tool_types')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = true, show_inline = true, options_source_rpc = 'get_available_tool_types';

-- Step 2: Parcels M:M (inline search modal with eligibility RPC filter)
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, show_inline, options_source_rpc)
VALUES ('tool_reservation_work_site', 'work_site_parcels_m2m', true, true, 'get_eligible_parcels_new')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = true, show_inline = true, options_source_rpc = 'get_eligible_parcels_new';

-- Checkout instances M:M (FK search modal for instance selection)
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, show_inline)
VALUES ('tool_reservation_checkouts', 'checkout_instances_m2m', true, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = true, show_inline = true;

-- Enable search modal on borrower_id FK for building use requests
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, join_table, options_source_rpc)
VALUES
  ('building_use_requests', 'borrower_id', true, 'borrowers', 'get_borrowers_for_reservation')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = true, join_table = 'borrowers', options_source_rpc = 'get_borrowers_for_reservation';

-- Mark tool_reservation_tool_items as a rich junction (has `quantity` extra column)
INSERT INTO metadata.entities (table_name, display_name, is_rich_junction, show_in_sidebar)
VALUES ('tool_reservation_tool_items', 'Tool Items', true, false)
ON CONFLICT (table_name) DO UPDATE
  SET is_rich_junction = true, show_in_sidebar = false;

-- Configure quantity display and hide timestamps on junction table
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order)
VALUES ('tool_reservation_tool_items', 'quantity', 'Quantity', 1)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = 'Quantity', sort_order = 1;

INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES ('tool_reservation_tool_items', 'created_at', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;

-- Hide checkout entity from sidebar (accessed via tool reservation detail page)
UPDATE metadata.entities SET show_in_sidebar = false WHERE table_name = 'tool_reservation_checkouts';
