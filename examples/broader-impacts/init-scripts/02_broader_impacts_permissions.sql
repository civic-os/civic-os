-- =====================================================
-- Broader Impacts Tracking System - Permissions
-- =====================================================
-- This file defines Row Level Security (RLS) policies for all tables
-- Permission Model:
--   - anonymous: No access to tables
--   - user: Read-only access
--   - collaborator: Read-only access (can be enhanced later for field-level differences)
--   - admin: Full CRUD access

-- =====================================================
-- ENSURE COLLABORATOR ROLE EXISTS
-- =====================================================

-- Insert collaborator role if it doesn't exist
INSERT INTO metadata.roles (display_name, description)
SELECT 'collaborator', 'Collaborator with full read access to all data'
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.roles WHERE display_name = 'collaborator'
);

-- Note: This deployment uses existing Civic OS RBAC functions:
--   - public.get_user_roles() - returns array of role names
--   - public.is_admin() - checks if user has admin role
--   - public.has_permission(table_name, permission) - checks table-level permissions

-- =====================================================
-- RLS POLICIES: ORGANIZATION TYPES
-- =====================================================

CREATE POLICY "organization_types: read permission" ON "public"."organization_types"
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('organization_types', 'read'));

CREATE POLICY "organization_types: create permission" ON "public"."organization_types"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('organization_types', 'create'));

CREATE POLICY "organization_types: update permission" ON "public"."organization_types"
  FOR UPDATE
  TO PUBLIC
  USING (public.has_permission('organization_types', 'update'))
  WITH CHECK (public.has_permission('organization_types', 'update'));

CREATE POLICY "organization_types: delete permission" ON "public"."organization_types"
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('organization_types', 'delete'));

-- =====================================================
-- RLS POLICIES: ORGANIZATIONS
-- =====================================================

CREATE POLICY "organizations: read permission" ON "public"."organizations"
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('organizations', 'read'));

CREATE POLICY "organizations: create permission" ON "public"."organizations"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('organizations', 'create'));

CREATE POLICY "organizations: update permission" ON "public"."organizations"
  FOR UPDATE
  TO PUBLIC
  USING (public.has_permission('organizations', 'update'))
  WITH CHECK (public.has_permission('organizations', 'update'));

CREATE POLICY "organizations: delete permission" ON "public"."organizations"
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('organizations', 'delete'));

-- =====================================================
-- RLS POLICIES: CONTACTS
-- =====================================================

CREATE POLICY "contacts: read permission" ON "public"."contacts"
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('contacts', 'read'));

CREATE POLICY "contacts: create permission" ON "public"."contacts"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('contacts', 'create'));

CREATE POLICY "contacts: update permission" ON "public"."contacts"
  FOR UPDATE
  TO PUBLIC
  USING (public.has_permission('contacts', 'update'))
  WITH CHECK (public.has_permission('contacts', 'update'));

CREATE POLICY "contacts: delete permission" ON "public"."contacts"
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('contacts', 'delete'));

-- =====================================================
-- RLS POLICIES: PROJECT STATUSES
-- =====================================================

CREATE POLICY "project_statuses: read permission" ON "public"."project_statuses"
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('project_statuses', 'read'));

CREATE POLICY "project_statuses: create permission" ON "public"."project_statuses"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('project_statuses', 'create'));

CREATE POLICY "project_statuses: update permission" ON "public"."project_statuses"
  FOR UPDATE
  TO PUBLIC
  USING (public.has_permission('project_statuses', 'update'))
  WITH CHECK (public.has_permission('project_statuses', 'update'));

CREATE POLICY "project_statuses: delete permission" ON "public"."project_statuses"
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('project_statuses', 'delete'));

-- =====================================================
-- RLS POLICIES: INTEREST CENTERS
-- =====================================================

CREATE POLICY "interest_centers: read permission" ON "public"."interest_centers"
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('interest_centers', 'read'));

CREATE POLICY "interest_centers: create permission" ON "public"."interest_centers"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('interest_centers', 'create'));

CREATE POLICY "interest_centers: update permission" ON "public"."interest_centers"
  FOR UPDATE
  TO PUBLIC
  USING (public.has_permission('interest_centers', 'update'))
  WITH CHECK (public.has_permission('interest_centers', 'update'));

CREATE POLICY "interest_centers: delete permission" ON "public"."interest_centers"
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('interest_centers', 'delete'));

-- =====================================================
-- RLS POLICIES: PROJECTS
-- =====================================================

CREATE POLICY "projects: read permission" ON "public"."projects"
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('projects', 'read'));

CREATE POLICY "projects: create permission" ON "public"."projects"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('projects', 'create'));

CREATE POLICY "projects: update permission" ON "public"."projects"
  FOR UPDATE
  TO PUBLIC
  USING (public.has_permission('projects', 'update'))
  WITH CHECK (public.has_permission('projects', 'update'));

CREATE POLICY "projects: delete permission" ON "public"."projects"
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('projects', 'delete'));

-- =====================================================
-- RLS POLICIES: BROADER IMPACT CATEGORIES
-- =====================================================

CREATE POLICY "broader_impact_categories: read permission" ON "public"."broader_impact_categories"
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('broader_impact_categories', 'read'));

CREATE POLICY "broader_impact_categories: create permission" ON "public"."broader_impact_categories"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('broader_impact_categories', 'create'));

CREATE POLICY "broader_impact_categories: update permission" ON "public"."broader_impact_categories"
  FOR UPDATE
  TO PUBLIC
  USING (public.has_permission('broader_impact_categories', 'update'))
  WITH CHECK (public.has_permission('broader_impact_categories', 'update'));

CREATE POLICY "broader_impact_categories: delete permission" ON "public"."broader_impact_categories"
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('broader_impact_categories', 'delete'));

-- =====================================================
-- RLS POLICIES: ORGANIZATION <-> BROADER IMPACT CATEGORIES
-- =====================================================

CREATE POLICY "org_bic: read permission" ON "public"."organization_broader_impact_categories"
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('organization_broader_impact_categories', 'read'));

CREATE POLICY "org_bic: create permission" ON "public"."organization_broader_impact_categories"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('organization_broader_impact_categories', 'create'));

CREATE POLICY "org_bic: delete permission" ON "public"."organization_broader_impact_categories"
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('organization_broader_impact_categories', 'delete'));

-- =====================================================
-- RLS POLICIES: CONTACT <-> PROJECTS
-- =====================================================

CREATE POLICY "contact_projects: read permission" ON "public"."contact_projects"
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('contact_projects', 'read'));

CREATE POLICY "contact_projects: create permission" ON "public"."contact_projects"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('contact_projects', 'create'));

CREATE POLICY "contact_projects: delete permission" ON "public"."contact_projects"
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('contact_projects', 'delete'));

-- =====================================================
-- RLS POLICIES: CONTACT <-> BROADER IMPACT CATEGORIES
-- =====================================================

CREATE POLICY "contact_bic: read permission" ON "public"."contact_broader_impact_categories"
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('contact_broader_impact_categories', 'read'));

CREATE POLICY "contact_bic: create permission" ON "public"."contact_broader_impact_categories"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('contact_broader_impact_categories', 'create'));

CREATE POLICY "contact_bic: delete permission" ON "public"."contact_broader_impact_categories"
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('contact_broader_impact_categories', 'delete'));

-- =====================================================
-- RLS POLICIES: PROJECT <-> BROADER IMPACT CATEGORIES
-- =====================================================

CREATE POLICY "project_bic: read permission" ON "public"."project_broader_impact_categories"
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('project_broader_impact_categories', 'read'));

CREATE POLICY "project_bic: create permission" ON "public"."project_broader_impact_categories"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('project_broader_impact_categories', 'create'));

CREATE POLICY "project_bic: delete permission" ON "public"."project_broader_impact_categories"
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('project_broader_impact_categories', 'delete'));
