-- =====================================================
-- Pot Hole Observation System - Seed Data
-- =====================================================
-- NOTE: IssueStatus and WorkPackageStatus data is now managed by the
-- framework Status Type System (metadata.statuses) and seeded in
-- 01_pot_hole_schema.sql.

-- =====================================================
-- STATUS ENTITY TYPE CONFIGURATION
-- =====================================================
-- Configure status columns to use the Status Type System so the frontend
-- renders colored badge dropdowns via the framework RPCs

INSERT INTO metadata.properties (table_name, column_name, status_entity_type)
VALUES ('Issue', 'status', 'issue')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET status_entity_type = EXCLUDED.status_entity_type;

INSERT INTO metadata.properties (table_name, column_name, status_entity_type)
VALUES ('WorkPackage', 'status', 'work_package')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET status_entity_type = EXCLUDED.status_entity_type;

-- Seed Tag data (for many-to-many relationship example)
INSERT INTO public."Tag" (display_name, color, description) VALUES
  ('Urgent', '#EF4444', 'Requires immediate attention'),
  ('Intersection', '#F59E0B', 'Located at an intersection'),
  ('School Zone', '#EAB308', 'Near a school'),
  ('Sidewalk', '#3B82F6', 'Sidewalk-related issue'),
  ('Road Surface', '#6366F1', 'Road surface damage'),
  ('Drainage', '#06B6D4', 'Water drainage problem'),
  ('Lighting', '#8B5CF6', 'Street lighting issue'),
  ('Signage', '#EC4899', 'Traffic sign or street sign');

-- Metadata: Configure display name and description for Tag entity
INSERT INTO metadata.entities (table_name, display_name, description, sort_order) VALUES
  ('Tag', 'Tags', 'Categorization tags for issues', 60)
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
