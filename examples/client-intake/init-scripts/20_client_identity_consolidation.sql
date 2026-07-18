-- =============================================================================
-- Script 20: Client User Link — Optional user_id with UNIQUE constraint
-- =============================================================================
-- Requires: Scripts 01-19 applied
--
-- Adds a UNIQUE constraint on clients.user_id so the profile extension
-- system (v0.65.0+) enforces at most one client per user. user_id remains
-- nullable: staff can create client records for walk-in clients who don't
-- yet have user accounts. Identity stays on the clients table
-- (first_name, last_name, email, phone).
--
-- Grants CUP read permission to staff roles so FK display name resolution
-- works when user_id is populated.
-- =============================================================================

BEGIN;

-- =============================================================================
-- A. GRANT civic_os_users_private:read TO STAFF ROLES
-- =============================================================================
-- Staff need to see client user accounts for FK display name resolution.
-- The existing RLS policy "Permitted roles see all private data" checks
-- has_permission(), so granting the permission is sufficient.

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'civic_os_users_private'
  AND p.permission = 'read'
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;


-- =============================================================================
-- B. ADD UNIQUE CONSTRAINT ON user_id (nullable — 0 or 1 client per user)
-- =============================================================================
-- PostgreSQL UNIQUE allows multiple NULLs, so unlinked clients are fine.
-- This replaces idx_clients_user_id for lookups.

ALTER TABLE clients ADD CONSTRAINT clients_user_id_unique UNIQUE (user_id);
DROP INDEX IF EXISTS idx_clients_user_id;


-- =============================================================================
-- C. SHOW user_id ON LIST PAGE
-- =============================================================================
-- Make user_id visible on list view so staff can see which clients are linked.

UPDATE metadata.properties
SET show_on_list = TRUE, sort_order = 2, display_name = 'User Account'
WHERE table_name = 'clients' AND column_name = 'user_id';


-- =============================================================================
-- D. CONSTRAINT MESSAGE
-- =============================================================================

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES ('clients_user_id_unique', 'clients', 'user_id',
        'This user is already linked to a client record.')
ON CONFLICT (constraint_name) DO UPDATE SET error_message = EXCLUDED.error_message;


-- =============================================================================
-- E. SCHEMA DECISION (ADR)
-- =============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
  ARRAY['clients']::NAME[], ARRAY['user_id']::NAME[], 'client-intake-20-user-link',
  'Add UNIQUE constraint on clients.user_id (keep identity columns)',
  'accepted',
  'The profile extension system (v0.65.0+) requires at most one record per user. '
  'However, ECS intake workflow requires staff to create client records for walk-in '
  'clients who may not have user accounts. Full identity consolidation (dropping '
  'first_name, last_name, email, phone) was rejected because it would prevent this workflow.',
  'Add UNIQUE constraint on user_id (nullable — PostgreSQL allows multiple NULLs). '
  'Keep all identity columns on clients table. Grant CUP read to staff roles for '
  'FK display name resolution when user_id is populated.',
  'Alternative: make user_id NOT NULL and drop identity columns (staff-portal precedent). '
  'Rejected because ECS needs to create clients before user accounts exist.',
  'user_id remains optional. Clients without user accounts use their own identity columns. '
  'Clients with user accounts get profile extension benefits (self-service profile page). '
  'Identity consolidation can be revisited once all clients have user accounts.',
  CURRENT_DATE
);


-- =============================================================================
-- F. POSTGREST RELOAD
-- =============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
