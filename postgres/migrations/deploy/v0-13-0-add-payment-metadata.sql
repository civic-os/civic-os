-- Deploy civic-os:v0-13-0-add-payment-metadata to pg
-- requires: v0-13-0-add-payments-poc

BEGIN;

-- ============================================================================
-- PAYMENT METADATA CONFIGURATION
-- ============================================================================
-- Add payment configuration columns to metadata.entities to enable metadata-driven
-- payment initiation. This allows any entity to support payments by:
-- 1. Adding a payment_transaction_id column (UUID FK to payments.transactions)
-- 2. Creating a domain-specific payment initiation RPC
-- 3. Configuring the RPC name and capture mode in metadata.entities

-- Add payment_initiation_rpc column
-- Stores the name of the RPC function to call when user clicks "Pay Now" button
-- RPC must follow standardized pattern:
--   - Accept p_entity_id parameter (BIGINT or TEXT depending on entity PK type)
--   - Return UUID (payment_id from payments.transactions)
--   - Perform domain-specific validation and cost calculation
ALTER TABLE metadata.entities
  ADD COLUMN payment_initiation_rpc VARCHAR(255);

COMMENT ON COLUMN metadata.entities.payment_initiation_rpc IS
  'Name of RPC function to initiate payment for this entity (e.g., ''initiate_reservation_request_payment''). RPC must accept p_entity_id parameter and return UUID. If NULL, entity does not support payment initiation.';

-- Add payment_capture_mode column
-- Controls when funds are captured: 'immediate' (at authorization) or 'deferred' (manual capture later)
ALTER TABLE metadata.entities
  ADD COLUMN payment_capture_mode VARCHAR(20) DEFAULT 'immediate'
    CHECK (payment_capture_mode IN ('immediate', 'deferred'));

COMMENT ON COLUMN metadata.entities.payment_capture_mode IS
  'Payment capture timing: ''immediate'' (capture funds at authorization, default) or ''deferred'' (manual capture later, useful for reservations that may be canceled). Only applies if payment_initiation_rpc is configured.';

-- ============================================================================
-- UPDATE CACHE VERSIONING VIEW
-- ============================================================================
-- Recreate schema_cache_versions to include updated_at from metadata.entities
-- This ensures frontend refreshes when payment metadata changes

-- Drop existing view
DROP VIEW IF EXISTS public.schema_cache_versions CASCADE;

-- Recreate with all tables that affect schema cache
CREATE VIEW public.schema_cache_versions AS
SELECT
  'entities' as cache_name,
  GREATEST(
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.entities),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.properties),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.validations)
  ) as last_updated
UNION ALL
SELECT
  'constraint_messages' as cache_name,
  (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.constraint_messages) as last_updated;

COMMENT ON VIEW public.schema_cache_versions IS
  'Cache versioning for frontend schema data. Returns max(updated_at) timestamp for each cache bucket. Frontend checks these timestamps to detect stale caches and trigger refresh.';

-- Grant read access
GRANT SELECT ON public.schema_cache_versions TO web_anon, authenticated;

-- ============================================================================
-- UPDATE SCHEMA_ENTITIES VIEW TO EXPOSE PAYMENT METADATA
-- ============================================================================
-- CRITICAL: Frontend queries schema_entities view (not metadata.entities table directly)
-- Must recreate view to include new payment columns for frontend consumption
-- ============================================================================

CREATE OR REPLACE VIEW public.schema_entities AS
SELECT
  COALESCE(entities.display_name, tables.table_name::text) AS display_name,
  COALESCE(entities.sort_order, 0) AS sort_order,
  entities.description,
  entities.search_fields,
  COALESCE(entities.show_map, FALSE) AS show_map,
  entities.map_property_name,
  tables.table_name,
  public.has_permission(tables.table_name::text, 'create') AS insert,
  public.has_permission(tables.table_name::text, 'read') AS "select",
  public.has_permission(tables.table_name::text, 'update') AS update,
  public.has_permission(tables.table_name::text, 'delete') AS delete,
  COALESCE(entities.show_calendar, FALSE) AS show_calendar,
  entities.calendar_property_name,
  entities.calendar_color_property,
  -- Payment columns added at end (v0.13.0)
  entities.payment_initiation_rpc,
  entities.payment_capture_mode
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text = 'BASE TABLE'::text
ORDER BY COALESCE(entities.sort_order, 0), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
  'Exposes entity metadata including payment configuration. Updated in v0.13.0 to add payment_initiation_rpc and payment_capture_mode columns.';

-- ============================================================================
-- EXAMPLE CONFIGURATION (COMMENTED OUT)
-- ============================================================================
-- Integrators should configure payment metadata in their init scripts, not migrations.
-- Example for reservation system:
--
-- UPDATE metadata.entities
-- SET
--   payment_initiation_rpc = 'initiate_reservation_request_payment',
--   payment_capture_mode = 'immediate'
-- WHERE table_name = 'reservation_requests';

COMMIT;
