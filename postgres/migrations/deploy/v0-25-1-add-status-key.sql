-- Deploy civic_os:v0-25-1-add-status-key to pg
-- requires: v0-24-0-schema-reorganization

BEGIN;

-- ============================================================================
-- STATUS KEY COLUMN
-- ============================================================================
-- Version: v0.25.1
-- Purpose: Add stable, system-internal identifier for statuses that can be
--          referenced in code/migrations without depending on display_name.
--
-- Problem: Using display_name for lookups is fragile because:
--   1. Display names may change (e.g., "Pending" → "Awaiting Review")
--   2. Creates hidden dependencies that break silently
--   3. Hard-coded IDs are environment-specific
--
-- Solution: Add status_key column - a snake_case identifier that:
--   1. Is auto-generated from display_name on insert
--   2. Never changes once set (immutable convention)
--   3. Provides stable reference for code/migrations
--
-- Usage:
--   -- Instead of: WHERE display_name = 'Pending'
--   -- Use: WHERE status_key = 'pending'
--   -- Or helper: SELECT get_status_id('reservation_payment', 'pending')
-- ============================================================================


-- ============================================================================
-- 1. ADD status_key COLUMN
-- ============================================================================

ALTER TABLE metadata.statuses
  ADD COLUMN IF NOT EXISTS status_key VARCHAR(50);

COMMENT ON COLUMN metadata.statuses.status_key IS
  'Stable, snake_case identifier for programmatic reference. Auto-generated from
   display_name on insert. Use this instead of display_name in code/migrations.
   Convention: lowercase, underscores, no spaces (e.g., pending, in_progress, waived).';


-- ============================================================================
-- 2. GENERATE status_key FOR EXISTING RECORDS
-- ============================================================================
-- Convert display_name to snake_case: "In Progress" → "in_progress"

UPDATE metadata.statuses
SET status_key = LOWER(REGEXP_REPLACE(TRIM(display_name), '\s+', '_', 'g'))
WHERE status_key IS NULL;


-- ============================================================================
-- 3. MAKE status_key NOT NULL AND ADD UNIQUE CONSTRAINT
-- ============================================================================

ALTER TABLE metadata.statuses
  ALTER COLUMN status_key SET NOT NULL;

-- Unique per entity_type (same key can exist in different entity_types)
ALTER TABLE metadata.statuses
  ADD CONSTRAINT statuses_entity_type_status_key_unique
  UNIQUE (entity_type, status_key);


-- ============================================================================
-- 4. ADD TRIGGER TO AUTO-GENERATE status_key ON INSERT
-- ============================================================================
-- If status_key is not provided, generate it from display_name

CREATE OR REPLACE FUNCTION metadata.set_status_key()
RETURNS TRIGGER AS $$
BEGIN
  -- Only auto-generate if status_key is NULL or empty
  IF NEW.status_key IS NULL OR TRIM(NEW.status_key) = '' THEN
    NEW.status_key := LOWER(REGEXP_REPLACE(TRIM(NEW.display_name), '\s+', '_', 'g'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_statuses_set_key ON metadata.statuses;
CREATE TRIGGER trg_statuses_set_key
  BEFORE INSERT ON metadata.statuses
  FOR EACH ROW EXECUTE FUNCTION metadata.set_status_key();

COMMENT ON FUNCTION metadata.set_status_key() IS
  'Auto-generates status_key from display_name if not provided on INSERT.
   Converts to snake_case: "In Progress" → "in_progress"';


-- ============================================================================
-- 5. ADD HELPER FUNCTION: get_status_id(entity_type, status_key)
-- ============================================================================
-- Cleaner than inline SELECT for migrations and RPC functions

CREATE OR REPLACE FUNCTION public.get_status_id(
  p_entity_type TEXT,
  p_status_key TEXT
)
RETURNS INT
LANGUAGE SQL
STABLE
AS $$
  SELECT id FROM metadata.statuses
  WHERE entity_type = p_entity_type
    AND status_key = p_status_key
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_status_id(TEXT, TEXT) IS
  'Returns the status ID for a given entity_type and status_key.
   Use this instead of display_name lookups for stable code references.
   Example: SELECT get_status_id(''reservation_payment'', ''pending'');';

GRANT EXECUTE ON FUNCTION public.get_status_id(TEXT, TEXT) TO web_anon, authenticated;


-- ============================================================================
-- 6. UPDATE public.statuses VIEW TO INCLUDE status_key
-- ============================================================================
-- Note: Must DROP and recreate because CREATE OR REPLACE cannot add columns
-- in the middle of the column list (PostgreSQL limitation).

DROP VIEW IF EXISTS public.statuses;

CREATE VIEW public.statuses AS
SELECT
  id,
  entity_type,
  status_key,
  display_name,
  description,
  color,
  sort_order,
  is_initial,
  is_terminal,
  created_at,
  updated_at
FROM metadata.statuses;

COMMENT ON VIEW public.statuses IS
  'Read-only view of metadata.statuses for PostgREST resource embedding.
   Includes status_key for programmatic reference. Use get_status_id() helper
   in migrations/RPC functions instead of display_name lookups.';

GRANT SELECT ON public.statuses TO web_anon, authenticated;


-- ============================================================================
-- 7. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
