-- ============================================================================
-- REGISTER CLIENTS AS USER PROFILE EXTENSION
-- Requires Civic OS v0.65.0+ (User Profile Extension System)
-- ============================================================================
-- The clients table already has a UUID FK to civic_os_users via user_id.
-- This script:
--   1. Registers clients as a required profile extension
--   2. Documents the decision via create_schema_decision()
-- Note: UNIQUE constraint on user_id is applied in script 20
-- (client_identity_consolidation) alongside NOT NULL.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. (DEFERRED) UNIQUE CONSTRAINT ON clients.user_id
-- ============================================================================
-- Profile extensions require a 1:1 relationship (at most one record per user).
-- The UNIQUE constraint is applied in script 20 (client_identity_consolidation)
-- as part of the identity consolidation that also makes user_id NOT NULL.
-- The existing index idx_clients_user_id covers query performance until then.


-- ============================================================================
-- 2. REGISTER clients AS PROFILE EXTENSION
-- ============================================================================

INSERT INTO metadata.user_profile_extensions (table_name, sort_order, is_required, display_name, description, user_fk_column, exempt_roles)
VALUES (
  'clients',
  1,
  true,
  'Client Profile',
  'Your client information for intake services',
  'user_id',
  '{admin,manager}'  -- Staff roles skip the completion guard (v0.66.1+)
)
ON CONFLICT (table_name) DO NOTHING;


-- ============================================================================
-- 3. SCHEMA DECISION
-- ============================================================================

-- Direct INSERT (not RPC) because init scripts run without JWT context.
INSERT INTO metadata.schema_decisions (title, decision, entity_types)
VALUES (
  'Register clients as required user profile extension',
  'The clients table has a natural 1:1 relationship with civic_os_users via user_id. '
  'Registering it as a required profile extension enables the v0.65.0 completion guard '
  'to block navigation until new users fill in their client intake record. This is the '
  'first real-world test of the profile extension system. The UNIQUE constraint on '
  'user_id enforces the 0-or-1 cardinality required by the extension framework.',
  ARRAY['clients']::NAME[]
);


-- ============================================================================
-- 4. SHOW user_id ON CREATE FORM
-- ============================================================================
-- By default, FK columns to civic_os_users have show_on_create=false (they're
-- usually auto-filled). For profile extensions, admins may create records on
-- behalf of users, so the FK dropdown must be visible. When navigated from
-- /profile, the query param pre-fills the current user automatically.

INSERT INTO metadata.properties (table_name, column_name, show_on_create)
VALUES ('clients', 'user_id', true)
ON CONFLICT (table_name, column_name) DO UPDATE
SET show_on_create = true;


NOTIFY pgrst, 'reload schema';

COMMIT;
