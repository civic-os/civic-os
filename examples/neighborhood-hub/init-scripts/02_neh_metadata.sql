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
