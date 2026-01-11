-- Revert civic_os:v0-25-1-add-status-key from pg

BEGIN;

-- ============================================================================
-- 6. RESTORE public.statuses VIEW (remove status_key column)
-- ============================================================================

CREATE OR REPLACE VIEW public.statuses AS
SELECT
  id,
  entity_type,
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
   Status values are filtered by entity_type (e.g., ''reservation_request'', ''issue'').
   Use get_statuses_for_entity(entity_type) RPC for dropdown population.';

GRANT SELECT ON public.statuses TO web_anon, authenticated;


-- ============================================================================
-- 5. DROP HELPER FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_status_id(TEXT, TEXT);


-- ============================================================================
-- 4. DROP TRIGGER AND FUNCTION
-- ============================================================================

DROP TRIGGER IF EXISTS trg_statuses_set_key ON metadata.statuses;
DROP FUNCTION IF EXISTS metadata.set_status_key();


-- ============================================================================
-- 3. DROP UNIQUE CONSTRAINT
-- ============================================================================

ALTER TABLE metadata.statuses
  DROP CONSTRAINT IF EXISTS statuses_entity_type_status_key_unique;


-- ============================================================================
-- 2 & 1. DROP status_key COLUMN (also removes NOT NULL)
-- ============================================================================

ALTER TABLE metadata.statuses
  DROP COLUMN IF EXISTS status_key;


-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
