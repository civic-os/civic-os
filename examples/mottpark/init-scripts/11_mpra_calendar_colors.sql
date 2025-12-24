-- ============================================================================
-- MOTT PARK - CALENDAR COLOR SYSTEM
-- ============================================================================
-- Adds status-based colors to reservation_requests for the manager calendar.
--
-- How it works:
--   1. Add a `color` column (hex_color domain) to reservation_requests
--   2. Trigger syncs color from status when status_id changes
--   3. Entity metadata points to color column for calendar rendering
--
-- Colors are derived from metadata.statuses:
--   Pending   → #F59E0B (amber)
--   Approved  → #22C55E (green)
--   Denied    → #EF4444 (red)
--   Cancelled → #6B7280 (gray)
--   Completed → #3B82F6 (blue)
--   Closed    → #8B5CF6 (purple)
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: ADD COLOR COLUMN TO RESERVATION_REQUESTS
-- ============================================================================

ALTER TABLE reservation_requests
  ADD COLUMN IF NOT EXISTS color hex_color;

-- Populate existing rows with their status color
UPDATE reservation_requests r
SET color = s.color
FROM metadata.statuses s
WHERE r.status_id = s.id
  AND r.color IS NULL;

-- ============================================================================
-- SECTION 2: CREATE TRIGGER TO SYNC COLOR FROM STATUS
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_reservation_color_from_status()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- Only update if status changed
  IF TG_OP = 'INSERT' OR NEW.status_id IS DISTINCT FROM OLD.status_id THEN
    SELECT color INTO NEW.color
    FROM metadata.statuses
    WHERE id = NEW.status_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_reservation_color_trigger ON reservation_requests;

CREATE TRIGGER sync_reservation_color_trigger
  BEFORE INSERT OR UPDATE OF status_id ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION sync_reservation_color_from_status();

-- ============================================================================
-- SECTION 3: UPDATE ENTITY METADATA
-- ============================================================================

-- Set calendar_color_property for reservation_requests
UPDATE metadata.entities
SET calendar_color_property = 'color'
WHERE table_name = 'reservation_requests';

-- ============================================================================
-- SECTION 4: HIDE COLOR COLUMN FROM FORMS (auto-managed)
-- ============================================================================

INSERT INTO metadata.properties (
  table_name, column_name, display_name, description, sort_order,
  show_on_list, show_on_create, show_on_edit, show_on_detail
) VALUES
  ('reservation_requests', 'color', 'Status Color',
   'Auto-synced from status for calendar display', 999,
   FALSE, FALSE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  show_on_list = FALSE,
  show_on_create = FALSE,
  show_on_edit = FALSE,
  show_on_detail = FALSE;

-- ============================================================================
-- SECTION 5: VERIFICATION
-- ============================================================================

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM reservation_requests WHERE color IS NOT NULL;

  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE 'CALENDAR COLOR SYSTEM INSTALLED';
  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE '';
  RAISE NOTICE 'reservation_requests with color: %', v_count;
  RAISE NOTICE '';
  RAISE NOTICE 'Colors will auto-sync when status changes.';
  RAISE NOTICE 'Manager calendar will show status colors for events.';
  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════';
END;
$$;

COMMIT;

-- Notify PostgREST to refresh
NOTIFY pgrst, 'reload schema';
