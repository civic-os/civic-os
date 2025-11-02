-- =====================================================
-- Broader Impacts Tracking System - Seed Data & Metadata
-- =====================================================
-- This file contains:
-- 1. Seed data for lookup tables
-- 2. Sample data for core entities
-- 3. Metadata configuration for UI customization
-- 4. Permission configuration

-- =====================================================
-- SEED DATA: ORGANIZATION TYPES
-- =====================================================

INSERT INTO public.organization_types (display_name, description) VALUES
  ('Academic', 'Universities, colleges, and research institutions'),
  ('Non-Profit', 'Non-profit organizations and NGOs'),
  ('Government', 'Government agencies and departments'),
  ('Corporate', 'For-profit companies and corporations'),
  ('Foundation', 'Philanthropic foundations and grant-making organizations');

-- =====================================================
-- SEED DATA: PROJECT STATUSES
-- =====================================================

INSERT INTO public.project_statuses (display_name, description) VALUES
  ('Planning', 'Project is in the planning phase'),
  ('Active', 'Project is currently active and ongoing'),
  ('Completed', 'Project has been successfully completed'),
  ('On Hold', 'Project is temporarily paused'),
  ('Cancelled', 'Project has been cancelled');

-- =====================================================
-- SEED DATA: INTEREST CENTERS
-- =====================================================

INSERT INTO public.interest_centers (display_name, description) VALUES
  ('Education & Outreach', 'Educational programs and community outreach initiatives'),
  ('Environmental Sustainability', 'Environmental conservation and sustainability projects'),
  ('Health & Wellness', 'Public health and wellness programs'),
  ('Economic Development', 'Economic growth and development initiatives'),
  ('Social Justice', 'Social equity and justice programs'),
  ('Arts & Culture', 'Cultural preservation and arts programs'),
  ('Technology & Innovation', 'Technological advancement and innovation projects'),
  ('Community Building', 'Community engagement and development initiatives');

-- =====================================================
-- SEED DATA: BROADER IMPACT CATEGORIES
-- =====================================================

INSERT INTO public.broader_impact_categories (display_name, description) VALUES
  ('K-12 Education', 'Programs targeting K-12 students and educators'),
  ('Undergraduate Education', 'Undergraduate student engagement and learning'),
  ('Graduate Education', 'Graduate student training and development'),
  ('Public Engagement', 'Engagement with the general public'),
  ('Diversity & Inclusion', 'Promoting diversity, equity, and inclusion'),
  ('Climate Change', 'Addressing climate change and adaptation'),
  ('Economic Opportunity', 'Creating economic opportunities and jobs'),
  ('Health Equity', 'Promoting health equity and access'),
  ('Environmental Justice', 'Environmental justice and equity'),
  ('STEM Workforce', 'Building the STEM workforce pipeline'),
  ('Policy Impact', 'Influencing public policy and decision-making'),
  ('International Collaboration', 'Cross-border and international partnerships'),
  ('Rural Communities', 'Supporting rural and underserved communities'),
  ('Urban Development', 'Urban planning and community development'),
  ('Indigenous Knowledge', 'Incorporating and preserving indigenous knowledge');

-- =====================================================
-- METADATA: ENTITIES CONFIGURATION
-- =====================================================

INSERT INTO metadata.entities (table_name, display_name, description, sort_order) VALUES
  ('organizations', 'Organizations', 'Organizations and institutions involved in broader impacts work', 10),
  ('contacts', 'Contacts', 'Individual contacts and collaborators', 20),
  ('projects', 'Projects', 'Research and engagement projects', 30),
  ('interest_centers', 'Interest Centers', 'Areas of focus and interest', 40),
  ('broader_impact_categories', 'Impact Categories', 'Categories of broader societal impact', 50),
  ('organization_types', 'Organization Types', 'Types of organizations (lookup table)', 60),
  ('project_statuses', 'Project Statuses', 'Project status values (lookup table)', 70)
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- =====================================================
-- METADATA: PROPERTIES CONFIGURATION
-- =====================================================

-- Organizations properties
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create) VALUES
  ('organizations', 'display_name', 'Organization Name', 'Name of the organization', 1, true, true),
  ('organizations', 'organization_type_id', 'Type', 'Type of organization', 2, true, true),
  ('organizations', 'email', 'Email', 'Contact email address', 3, true, true),
  ('organizations', 'phone', 'Phone', 'Contact phone number', 4, true, true),
  ('organizations', 'website', 'Website', 'Organization website URL', 5, true, true),
  ('organizations', 'address', 'Address', 'Physical address', 6, false, true),
  ('organizations', 'description', 'Description', 'Description of the organization', 7, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- Contacts properties
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create) VALUES
  ('contacts', 'first_name', 'First Name', 'Contact first name', 1, true, true),
  ('contacts', 'last_name', 'Last Name', 'Contact last name', 2, true, true),
  ('contacts', 'email', 'Email', 'Email address', 3, true, true),
  ('contacts', 'phone', 'Phone', 'Phone number', 4, true, true),
  ('contacts', 'organization_id', 'Organization', 'Associated organization', 5, true, true),
  ('contacts', 'title', 'Title', 'Job title or position', 6, false, true),
  ('contacts', 'description', 'Description', 'Additional information about the contact', 7, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- Projects properties
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create) VALUES
  ('projects', 'display_name', 'Project Name', 'Name of the project', 1, true, true),
  ('projects', 'organization_id', 'Organization', 'Lead organization', 2, true, true),
  ('projects', 'status_id', 'Status', 'Current project status', 3, true, true),
  ('projects', 'interest_center_id', 'Interest Center', 'Primary area of focus', 4, true, true),
  ('projects', 'start_date', 'Start Date', 'Project start date', 5, true, true),
  ('projects', 'end_date', 'End Date', 'Project end date', 6, true, true),
  ('projects', 'description', 'Description', 'Detailed project description', 7, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- Interest Centers properties
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create) VALUES
  ('interest_centers', 'display_name', 'Name', 'Interest center name', 1, true, true),
  ('interest_centers', 'description', 'Description', 'Description of this interest area', 2, true, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- Broader Impact Categories properties
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create) VALUES
  ('broader_impact_categories', 'display_name', 'Category Name', 'Impact category name', 1, true, true),
  ('broader_impact_categories', 'description', 'Description', 'Description of this impact category', 2, true, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- =====================================================
-- PERMISSIONS CONFIGURATION
-- =====================================================

-- Create permission entries for all tables
INSERT INTO metadata.permissions (table_name, permission)
SELECT t.table_name, p.permission::metadata.permission
FROM (VALUES
  ('organizations'),
  ('contacts'),
  ('projects'),
  ('interest_centers'),
  ('broader_impact_categories'),
  ('organization_types'),
  ('project_statuses'),
  ('organization_broader_impact_categories'),
  ('contact_projects'),
  ('contact_broader_impact_categories'),
  ('project_broader_impact_categories')
) AS t(table_name)
CROSS JOIN (VALUES ('create'), ('read'), ('update'), ('delete')) AS p(permission)
ON CONFLICT (table_name, permission) DO NOTHING;

-- Assign READ permissions to user and collaborator roles
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.permission = 'read'
  AND r.display_name IN ('user', 'collaborator')
ON CONFLICT (permission_id, role_id) DO NOTHING;

-- Assign FULL permissions to admin role
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE r.display_name = 'admin'
ON CONFLICT (permission_id, role_id) DO NOTHING;

-- =====================================================
-- NOTIFY POSTGREST
-- =====================================================

NOTIFY pgrst, 'reload schema';
