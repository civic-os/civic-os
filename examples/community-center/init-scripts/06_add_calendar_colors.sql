-- =====================================================================
-- Add Calendar Color Support to Reservation Requests
-- =====================================================================
-- This script adds a generated color_hex column to reservation_requests
-- that maps status_id to visual colors for calendar display.
--
-- Status Color Mapping:
--   1 (Pending)   -> #F59E0B (amber)
--   2 (Approved)  -> #22C55E (green)
--   3 (Denied)    -> #EF4444 (red)
--   4 (Cancelled) -> #6B7280 (gray)
-- =====================================================================

-- Add generated color_hex column based on status_id
ALTER TABLE reservation_requests
  ADD COLUMN color_hex hex_color GENERATED ALWAYS AS (
    CASE status_id
      WHEN 1 THEN '#F59E0B'::hex_color  -- Pending: amber
      WHEN 2 THEN '#22C55E'::hex_color  -- Approved: green
      WHEN 3 THEN '#EF4444'::hex_color  -- Denied: red
      WHEN 4 THEN '#6B7280'::hex_color  -- Cancelled: gray
      ELSE '#9CA3AF'::hex_color         -- Fallback: light gray
    END
  ) STORED;

-- Enable calendar view for reservation requests
UPDATE metadata.entities SET
  show_calendar = TRUE,
  calendar_property_name = 'time_slot',
  calendar_color_property = 'color_hex',
  description = 'Member booking requests with status-based calendar view'
WHERE table_name = 'reservation_requests';

-- Add metadata for the color_hex property (hidden from forms, visible on detail)
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_create, show_on_edit, show_on_list, show_on_detail)
VALUES ('reservation_requests', 'color_hex', 'Status Color', 15, FALSE, FALSE, FALSE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_list = EXCLUDED.show_on_list,
  show_on_detail = EXCLUDED.show_on_detail;
