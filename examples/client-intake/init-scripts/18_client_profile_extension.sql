-- ============================================================================
-- REGISTER CLIENTS AS USER PROFILE EXTENSION
-- Requires Civic OS v0.65.0+ (User Profile Extension System)
-- ============================================================================
-- The clients table already has a UUID FK to civic_os_users via user_id.
-- This script:
--   1. Adds a UNIQUE constraint on clients.user_id (0-or-1 record per user)
--   2. Registers clients as a required profile extension
--   3. Documents the decision via create_schema_decision()
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. ADD UNIQUE CONSTRAINT ON clients.user_id
-- ============================================================================
-- Profile extensions require a 1:1 relationship (at most one record per user).
-- The existing index idx_clients_user_id covers query performance;
-- this constraint enforces the cardinality rule.

ALTER TABLE public.clients
  ADD CONSTRAINT unique_client_per_user UNIQUE (user_id);


-- ============================================================================
-- 2. REGISTER clients AS PROFILE EXTENSION
-- ============================================================================

INSERT INTO metadata.user_profile_extensions (table_name, sort_order, is_required, display_name, description, user_fk_column)
VALUES (
  'clients',
  1,
  true,
  'Client Profile',
  'Your client information for intake services',
  'user_id'
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


NOTIFY pgrst, 'reload schema';

COMMIT;
