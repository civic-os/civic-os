-- =====================================================
-- Pot Hole Observation System - Seed Data
-- =====================================================

-- Seed IssueStatus data
INSERT INTO "public"."IssueStatus" ("id", "created_at", "display_name") VALUES
  ('1', '2024-12-14 20:58:32.638955+00', 'New'),
  ('2', '2024-12-14 21:02:44.44308+00', 'Verification'),
  ('3', '2024-12-14 21:04:23.589205+00', 'Re-estimate'),
  ('4', '2024-12-14 21:05:50.549546+00', 'Repair Queue'),
  ('5', '2024-12-14 21:06:05.12863+00', 'Batched for Quote'),
  ('6', '2024-12-14 21:06:15.078694+00', 'Bid Accepted'),
  ('7', '2024-12-14 21:06:24.374326+00', 'Completed'),
  ('8', '2024-12-14 21:06:28.683431+00', 'Duplicate');

-- Seed WorkPackageStatus data
INSERT INTO "public"."WorkPackageStatus" ("id", "created_at", "display_name") VALUES
  ('2', '2024-12-14 21:29:56.694099+00', 'New'),
  ('3', '2024-12-14 21:30:12.753812+00', 'Competitive'),
  ('4', '2024-12-14 21:30:47.936383+00', 'Awarded'),
  ('5', '2024-12-14 21:30:53.014772+00', 'Not Selected');

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
