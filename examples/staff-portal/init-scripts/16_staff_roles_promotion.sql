-- =============================================================================
-- Script 16: Promote Staff Roles to Public Table + Document Requirement M:M
-- =============================================================================
-- Migrates staff_role categories from metadata.categories to a dedicated
-- public.staff_roles table. Replaces the TEXT[] applies_to_roles column on
-- document_requirements with a proper junction table (document_requirement_roles)
-- so the M:M auto-detection system renders an editor on the detail page.
--
-- Trade-off: staff roles lose colored badge display (Category → ForeignKeyName).
--
-- Prerequisites: scripts 01-15 must have run.
-- Safe for live databases: preserves IDs so existing FK values remain valid.
-- =============================================================================

-- =============================================================================
-- 1. CREATE public.staff_roles TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS staff_roles (
  id SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 2. MIGRATE DATA FROM metadata.categories (preserving IDs)
-- =============================================================================

INSERT INTO staff_roles (id, display_name, sort_order, created_at, updated_at)
SELECT id, display_name, sort_order, created_at, updated_at
FROM metadata.categories
WHERE entity_type = 'staff_role'
ORDER BY id
ON CONFLICT (id) DO NOTHING;

-- Reset sequence to avoid conflicts with future inserts
SELECT setval('staff_roles_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM staff_roles), 1));

-- =============================================================================
-- 3. SWITCH FK ON staff_members.role_id
-- =============================================================================

ALTER TABLE staff_members DROP CONSTRAINT IF EXISTS staff_members_role_id_fkey;
ALTER TABLE staff_members ADD CONSTRAINT staff_members_role_id_fkey
  FOREIGN KEY (role_id) REFERENCES staff_roles(id);

-- =============================================================================
-- 4. SWITCH FK ON staff_tasks.assigned_to_role_id
-- =============================================================================

ALTER TABLE staff_tasks DROP CONSTRAINT IF EXISTS staff_tasks_assigned_to_role_id_fkey;
ALTER TABLE staff_tasks ADD CONSTRAINT staff_tasks_assigned_to_role_id_fkey
  FOREIGN KEY (assigned_to_role_id) REFERENCES staff_roles(id);

-- =============================================================================
-- 5. CREATE document_requirement_roles JUNCTION TABLE
-- =============================================================================
-- Composite PK (no surrogate ID), ON DELETE CASCADE, FK index on second column.

CREATE TABLE IF NOT EXISTS document_requirement_roles (
  document_requirement_id BIGINT NOT NULL REFERENCES document_requirements(id) ON DELETE CASCADE,
  staff_role_id INT NOT NULL REFERENCES staff_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (document_requirement_id, staff_role_id)
);

CREATE INDEX IF NOT EXISTS idx_drr_staff_role_id
  ON document_requirement_roles(staff_role_id);

-- =============================================================================
-- 6. MIGRATE applies_to_roles TEXT[] → JUNCTION ROWS
-- =============================================================================
-- Empty arrays produce no rows from unnest → correct "applies to all" semantic.

INSERT INTO document_requirement_roles (document_requirement_id, staff_role_id)
SELECT dr.id, sr.id
FROM document_requirements dr
CROSS JOIN LATERAL unnest(dr.applies_to_roles) AS role_name
JOIN staff_roles sr ON sr.display_name = role_name
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 7. DROP applies_to_roles COLUMN
-- =============================================================================

ALTER TABLE document_requirements DROP COLUMN IF EXISTS applies_to_roles;

DELETE FROM metadata.properties
WHERE table_name = 'document_requirements' AND column_name = 'applies_to_roles';

-- =============================================================================
-- 8. UPDATE auto_create_staff_documents() TRIGGER
-- =============================================================================
-- New logic: a requirement applies if it has NO junction rows (= all roles)
-- OR has a row matching the staff member's role_id.

CREATE OR REPLACE FUNCTION auto_create_staff_documents()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO staff_documents (staff_member_id, requirement_id)
  SELECT NEW.id, dr.id
  FROM document_requirements dr
  WHERE NOT EXISTS (
    SELECT 1 FROM document_requirement_roles drr
    WHERE drr.document_requirement_id = dr.id
  )
  OR EXISTS (
    SELECT 1 FROM document_requirement_roles drr
    WHERE drr.document_requirement_id = dr.id
      AND drr.staff_role_id = NEW.role_id
  );
  RETURN NEW;
END;
$$;

-- =============================================================================
-- 9. UPDATE staff_directory VIEW
-- =============================================================================
-- Must DROP + CREATE because the old VIEW's staff_role column is VARCHAR(50)
-- (from metadata.categories.display_name) but staff_roles.display_name is TEXT.
-- PostgreSQL does not allow CREATE OR REPLACE VIEW to change column types.

DROP VIEW IF EXISTS staff_directory;
CREATE VIEW staff_directory AS
SELECT
  sm.id,
  cup.display_name,
  cup.email,
  sm.role_id,
  sr.display_name AS staff_role,
  sm.site_id,
  s.display_name AS site_name
FROM staff_members sm
JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
LEFT JOIN staff_roles sr ON sr.id = sm.role_id
LEFT JOIN sites s ON s.id = sm.site_id;

-- Re-grant after CREATE OR REPLACE
GRANT SELECT ON staff_directory TO authenticated;

-- =============================================================================
-- 10. REGISTER staff_roles + junction TABLE IN METADATA
-- =============================================================================

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('staff_roles', 'Staff Roles', 'Position categories for program staff', 15)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, sort_order)
VALUES ('document_requirement_roles', 'Document Requirement Roles', 99)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name;

-- =============================================================================
-- 11. UPDATE METADATA FOR FK COLUMNS
-- =============================================================================
-- Remove category_entity_type; set join_table/join_column for ForeignKeyName.

UPDATE metadata.properties
SET category_entity_type = NULL,
    join_table = 'staff_roles',
    join_column = 'display_name'
WHERE table_name = 'staff_members' AND column_name = 'role_id';

UPDATE metadata.properties
SET join_table = 'staff_roles',
    join_column = 'display_name'
WHERE table_name = 'staff_tasks' AND column_name = 'assigned_to_role_id';

-- staff_directory.role_id — was category, now FK
UPDATE metadata.properties
SET category_entity_type = NULL,
    join_table = 'staff_roles',
    join_column = 'display_name'
WHERE table_name = 'staff_directory' AND column_name = 'role_id';

-- =============================================================================
-- 12. GRANTS + RLS + PERMISSIONS
-- =============================================================================

-- staff_roles: readable by all, manageable by admin/manager
GRANT SELECT ON staff_roles TO web_anon;
GRANT SELECT ON staff_roles TO authenticated;
GRANT INSERT, UPDATE, DELETE ON staff_roles TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE staff_roles_id_seq TO authenticated;

-- document_requirement_roles: readable by all, create/delete for M:M editor
GRANT SELECT ON document_requirement_roles TO web_anon;
GRANT SELECT, INSERT, DELETE ON document_requirement_roles TO authenticated;

-- RLS: staff_roles
ALTER TABLE staff_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_staff_roles ON staff_roles
  FOR SELECT USING (true);

CREATE POLICY manage_staff_roles ON staff_roles
  FOR ALL TO authenticated
  USING (is_admin() OR 'manager' = ANY(get_user_roles()));

-- RLS: document_requirement_roles
ALTER TABLE document_requirement_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_drr ON document_requirement_roles
  FOR SELECT USING (true);

CREATE POLICY manage_drr ON document_requirement_roles
  FOR ALL TO authenticated
  USING (is_admin() OR 'manager' = ANY(get_user_roles()));

-- Permission entries
INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('staff_roles', 'read'),
  ('staff_roles', 'create'),
  ('staff_roles', 'update'),
  ('staff_roles', 'delete'),
  ('document_requirement_roles', 'read'),
  ('document_requirement_roles', 'create'),
  ('document_requirement_roles', 'delete')
ON CONFLICT DO NOTHING;

-- Grant staff_roles read to all authenticated roles
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_roles'
  AND p.permission = 'read'
  AND r.role_key IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Grant staff_roles create/update/delete to admin only
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_roles'
  AND p.permission IN ('create', 'update', 'delete')
  AND r.role_key = 'admin'
ON CONFLICT DO NOTHING;

-- Grant document_requirement_roles read to all authenticated roles
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'document_requirement_roles'
  AND p.permission = 'read'
  AND r.role_key IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Grant document_requirement_roles create/delete to manager and admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'document_requirement_roles'
  AND p.permission IN ('create', 'delete')
  AND r.role_key IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 13. CLEAN UP OLD CATEGORIES
-- =============================================================================

DELETE FROM metadata.categories WHERE entity_type = 'staff_role';
DELETE FROM metadata.category_groups WHERE entity_type = 'staff_role';

-- =============================================================================
-- 14. SCHEMA DECISION (ADR)
-- =============================================================================

-- Direct INSERT (not RPC) because init scripts run without JWT context.
INSERT INTO metadata.schema_decisions (entity_types, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['staff_roles', 'document_requirements', 'document_requirement_roles']::NAME[],
    'staff-portal-16-roles-promotion',
    'Promote staff roles from metadata.categories to public table',
    'accepted',
    'Staff roles lived in metadata.categories (Category type) with colored badges. document_requirements.applies_to_roles used TEXT[] which is unsupported in the UI. Need M:M between document requirements and staff roles.',
    'Moved staff roles to a dedicated public.staff_roles table (ForeignKeyName type). Created document_requirement_roles junction table with composite PK. Empty junction rows = applies to all roles.',
    'Categories provide colored badge display but lack M:M support. Promoting to a public table enables the existing junction table auto-detection. Colored badges are lost — acceptable for this pilot. Framework-level M:M for categories is on the roadmap.',
    'Staff role dropdowns show plain text instead of colored badges. Document requirements detail page gains an M:M editor for role assignment. auto_create_staff_documents trigger updated to use junction table.',
    CURRENT_DATE
);
