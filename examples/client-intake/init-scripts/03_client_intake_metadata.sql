-- =====================================================
-- Client Intake & Referral - Metadata Configuration
-- =====================================================
-- Configures display names, descriptions, property visibility,
-- sorting/filtering, status types, category types, and validations.

BEGIN;

-- =====================================================
-- ENTITY METADATA
-- =====================================================

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, fulltext_search_column)
VALUES ('service_categories', 'Service Category', 'Service types available for clients and partners', 1, NULL)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, fulltext_search_column, substring_search_column)
VALUES ('clients', 'Client', 'Community members seeking services', 2, 'search_vector', 'display_name')
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  fulltext_search_column = EXCLUDED.fulltext_search_column,
  substring_search_column = EXCLUDED.substring_search_column;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, fulltext_search_column)
VALUES ('partners', 'Partner', 'Service provider organizations and individuals', 3, 'search_vector')
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  fulltext_search_column = EXCLUDED.fulltext_search_column;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('referrals', 'Referral', 'Client-to-partner referral records', 4)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_in_sidebar)
VALUES ('follow_up_surveys', 'Follow-Up Survey', 'Post-referral client feedback surveys', 5, TRUE)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_in_sidebar = EXCLUDED.show_in_sidebar;

-- =====================================================
-- PROPERTY METADATA (service_categories)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('service_categories', 'display_name', 'Category Name', 1, 1, TRUE, TRUE, TRUE, TRUE),
  ('service_categories', 'description', 'Description', 2, 2, FALSE, TRUE, TRUE, TRUE),
  ('service_categories', 'color', 'Color', 3, 1, TRUE, TRUE, TRUE, TRUE),
  ('service_categories', 'active', 'Active', 4, 1, TRUE, TRUE, TRUE, TRUE),
  ('service_categories', 'sort_order', 'Display Order', 5, 1, FALSE, TRUE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (clients)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  -- Identity (half-width pairs)
  ('clients', 'first_name', 'First Name', 1, 1, FALSE, TRUE, TRUE, TRUE),
  ('clients', 'last_name', 'Last Name', 2, 1, FALSE, TRUE, TRUE, TRUE),
  ('clients', 'display_name', 'Full Name', 3, 1, TRUE, FALSE, FALSE, FALSE),
  -- Contact
  ('clients', 'email', 'Email', 4, 1, TRUE, TRUE, TRUE, TRUE),
  ('clients', 'phone', 'Phone', 5, 1, TRUE, TRUE, TRUE, TRUE),
  -- Demographics
  ('clients', 'date_of_birth', 'Date of Birth', 6, 1, FALSE, TRUE, TRUE, TRUE),
  ('clients', 'gender_id', 'Gender', 7, 1, FALSE, TRUE, TRUE, TRUE),
  ('clients', 'preferred_comm_language', 'Preferred Communication Language', 8, 2, FALSE, TRUE, TRUE, TRUE),
  ('clients', 'household_size', 'Household Size', 9, 1, FALSE, TRUE, TRUE, TRUE),
  -- Status & ownership
  ('clients', 'status_id', 'Status', 10, 1, TRUE, FALSE, FALSE, TRUE),
  ('clients', 'user_id', 'Linked User Account', 11, 1, FALSE, FALSE, TRUE, TRUE),
  ('clients', 'created_at', 'Registered', 20, 1, FALSE, FALSE, FALSE, TRUE),
  -- Hidden internal fields (framework defaults would show these)
  ('clients', 'search_vector', 'Search Index', 99, 1, FALSE, FALSE, FALSE, FALSE),
  ('clients', 'updated_at', 'Updated', 98, 1, FALSE, FALSE, FALSE, FALSE),
  ('clients', 'created_by', 'Created By', 97, 1, FALSE, FALSE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (partners)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('partners', 'display_name', 'Organization Name', 1, 1, TRUE, TRUE, TRUE, TRUE),
  ('partners', 'partner_type_id', 'Type', 2, 1, TRUE, TRUE, TRUE, TRUE),
  ('partners', 'contact_name', 'Contact Person', 3, 1, TRUE, TRUE, TRUE, TRUE),
  ('partners', 'email', 'Email', 4, 1, FALSE, TRUE, TRUE, TRUE),
  ('partners', 'phone', 'Phone', 5, 1, FALSE, TRUE, TRUE, TRUE),
  ('partners', 'address', 'Address', 6, 2, FALSE, TRUE, TRUE, TRUE),
  ('partners', 'location', 'Map Location', 7, 2, FALSE, TRUE, TRUE, TRUE),
  ('partners', 'website', 'Website', 8, 1, FALSE, TRUE, TRUE, TRUE),
  ('partners', 'languages_supported', 'Languages Supported', 9, 1, FALSE, TRUE, TRUE, TRUE),
  ('partners', 'capacity_notes', 'Capacity / Availability Notes', 10, 2, FALSE, TRUE, TRUE, TRUE),
  ('partners', 'description', 'Description', 11, 2, FALSE, TRUE, TRUE, TRUE),
  ('partners', 'active', 'Active', 12, 1, TRUE, TRUE, TRUE, TRUE),
  ('partners', 'created_at', 'Added', 20, 1, FALSE, FALSE, FALSE, TRUE),
  -- Hidden internal fields
  ('partners', 'location_text', 'Location Text', 98, 1, FALSE, FALSE, FALSE, FALSE),
  ('partners', 'search_vector', 'Search Index', 99, 1, FALSE, FALSE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (referrals)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('referrals', 'display_name', 'Referral', 1, 1, TRUE, FALSE, FALSE, TRUE),
  ('referrals', 'client_id', 'Client', 2, 1, TRUE, TRUE, FALSE, TRUE),
  ('referrals', 'partner_id', 'Partner', 3, 1, TRUE, TRUE, TRUE, TRUE),
  ('referrals', 'referral_type_id', 'Type', 4, 1, TRUE, TRUE, TRUE, TRUE),
  ('referrals', 'referral_date', 'Referral Date', 5, 1, TRUE, TRUE, TRUE, TRUE),
  ('referrals', 'referred_by', 'Referred By', 6, 1, FALSE, FALSE, FALSE, TRUE),
  ('referrals', 'status_id', 'Status', 7, 1, TRUE, FALSE, FALSE, TRUE),
  ('referrals', 'outcome_notes', 'Outcome Notes', 8, 2, FALSE, FALSE, TRUE, TRUE),
  ('referrals', 'completed_date', 'Completed Date', 9, 1, FALSE, FALSE, TRUE, TRUE),
  ('referrals', 'created_at', 'Created', 20, 1, FALSE, FALSE, FALSE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (follow_up_surveys)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('follow_up_surveys', 'display_name', 'Survey', 1, 1, TRUE, FALSE, FALSE, TRUE),
  ('follow_up_surveys', 'referral_id', 'Referral', 2, 1, TRUE, FALSE, FALSE, TRUE),
  ('follow_up_surveys', 'status_id', 'Status', 3, 1, TRUE, FALSE, FALSE, TRUE),
  ('follow_up_surveys', 'helpfulness_id', 'Was the connection helpful?', 4, 2, TRUE, FALSE, TRUE, TRUE),
  ('follow_up_surveys', 'time_to_contact_id', 'How long to make contact?', 5, 2, TRUE, FALSE, TRUE, TRUE),
  ('follow_up_surveys', 'outcome_id', 'What was the outcome?', 6, 2, TRUE, FALSE, TRUE, TRUE),
  ('follow_up_surveys', 'open_feedback', 'Additional Feedback', 7, 2, FALSE, FALSE, TRUE, TRUE),
  ('follow_up_surveys', 'completed_date', 'Completed Date', 8, 1, FALSE, FALSE, FALSE, TRUE),
  ('follow_up_surveys', 'created_at', 'Created', 20, 1, FALSE, FALSE, FALSE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- STATUS ENTITY TYPE BINDINGS
-- =====================================================

UPDATE metadata.properties SET status_entity_type = 'client'
WHERE table_name = 'clients' AND column_name = 'status_id';

UPDATE metadata.properties SET status_entity_type = 'referral'
WHERE table_name = 'referrals' AND column_name = 'status_id';

UPDATE metadata.properties SET status_entity_type = 'survey'
WHERE table_name = 'follow_up_surveys' AND column_name = 'status_id';

-- =====================================================
-- CATEGORY ENTITY TYPE BINDINGS
-- =====================================================

UPDATE metadata.properties SET category_entity_type = 'gender'
WHERE table_name = 'clients' AND column_name = 'gender_id';

UPDATE metadata.properties SET category_entity_type = 'partner_type'
WHERE table_name = 'partners' AND column_name = 'partner_type_id';

UPDATE metadata.properties SET category_entity_type = 'referral_type'
WHERE table_name = 'referrals' AND column_name = 'referral_type_id';

UPDATE metadata.properties SET category_entity_type = 'helpfulness'
WHERE table_name = 'follow_up_surveys' AND column_name = 'helpfulness_id';

UPDATE metadata.properties SET category_entity_type = 'time_to_contact'
WHERE table_name = 'follow_up_surveys' AND column_name = 'time_to_contact_id';

UPDATE metadata.properties SET category_entity_type = 'outcome'
WHERE table_name = 'follow_up_surveys' AND column_name = 'outcome_id';

-- =====================================================
-- M:M INLINE CONFIGURATION
-- =====================================================
-- M:M properties are registered on the parent table with a virtual column
-- name following the pattern: {junction_table}_m2m

-- Show service need checkboxes inline on client create/edit forms
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, show_inline)
VALUES ('clients', 'client_service_needs_m2m', false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = false, show_inline = true;

-- Show service category checkboxes inline on partner create/edit forms
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, show_inline)
VALUES ('partners', 'partner_service_categories_m2m', false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = false, show_inline = true;

-- Show service category checkboxes inline on referral create/edit forms,
-- filtered to intersection of client needs AND partner offerings (dual cascade)
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, show_inline, options_source_rpc, depends_on_columns)
VALUES ('referrals', 'referral_service_categories_m2m', false, true, 'get_referral_service_options', '{client_id,partner_id}')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = false, show_inline = true,
      options_source_rpc = 'get_referral_service_options',
      depends_on_columns = '{client_id,partner_id}';

-- =====================================================
-- OPTIONS SOURCE RPC CONFIGURATION
-- =====================================================

-- Referral partner dropdown: filter by client's identified service needs
-- When client changes, partner list re-queries via depends_on_columns
UPDATE metadata.properties
SET options_source_rpc = 'get_partners_for_client_needs',
    depends_on_columns = '{client_id}'
WHERE table_name = 'referrals' AND column_name = 'partner_id';

-- =====================================================
-- FILTERABLE & SORTABLE PROPERTIES
-- =====================================================

-- clients
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'clients' AND column_name IN ('status_id', 'gender_id');

UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'clients' AND column_name IN ('display_name', 'created_at');

-- partners
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'partners' AND column_name IN ('partner_type_id', 'active');

UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'partners' AND column_name IN ('display_name', 'created_at');

-- referrals
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'referrals' AND column_name IN ('client_id', 'partner_id', 'referral_type_id', 'status_id');

UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'referrals' AND column_name IN ('referral_date', 'created_at');

-- follow_up_surveys
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'follow_up_surveys' AND column_name IN ('status_id', 'helpfulness_id', 'outcome_id');

UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'follow_up_surveys' AND column_name IN ('created_at');

-- service_categories
UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'service_categories' AND column_name IN ('display_name', 'sort_order');

-- =====================================================
-- VALIDATIONS
-- =====================================================

INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message) VALUES
  ('clients', 'first_name', 'required', 'true', 'First name is required'),
  ('clients', 'last_name', 'required', 'true', 'Last name is required'),
  ('clients', 'first_name', 'minLength', '1', 'First name cannot be empty'),
  ('clients', 'last_name', 'minLength', '1', 'Last name cannot be empty'),
  ('clients', 'household_size', 'min', '1', 'Household size must be at least 1'),
  ('clients', 'household_size', 'max', '50', 'Household size seems too large'),
  ('partners', 'display_name', 'required', 'true', 'Organization name is required'),
  ('partners', 'display_name', 'minLength', '2', 'Organization name must be at least 2 characters'),
  ('referrals', 'client_id', 'required', 'true', 'Client is required'),
  ('referrals', 'partner_id', 'required', 'true', 'Partner is required'),
  ('service_categories', 'display_name', 'required', 'true', 'Category name is required')
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE SET
  validation_value = EXCLUDED.validation_value,
  error_message = EXCLUDED.error_message;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
