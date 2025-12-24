-- ============================================================================
-- MOTT PARK - PUBLIC CALENDAR EVENTS TABLE
-- ============================================================================
-- Creates a separate entity for public calendar display with limited columns.
-- Synced from reservation_requests via trigger when status = Approved/Completed.
--
-- Architecture:
--   reservation_requests (staff-only, full CRUD, all columns)
--          │
--          │ trigger sync on INSERT/UPDATE/DELETE
--          ▼
--   public_calendar_events (public read-only, limited columns)
--          │
--          └── Simple RLS: all authenticated users can read
--          └── Has its own List and Detail pages
--          └── Private events show "Private Event" with no contact info
--          └── Public events show full contact details
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: PUBLIC CALENDAR EVENTS TABLE
-- ============================================================================

CREATE TABLE public_calendar_events (
  -- Same ID as reservation_requests for reference (not FK - sync is one-way)
  id BIGINT PRIMARY KEY,

  -- Time slot for calendar display
  time_slot time_slot NOT NULL,

  -- Display info (conditional based on is_public_event in source)
  display_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  is_public_event BOOLEAN NOT NULL,

  -- Public event details (NULL for private events)
  organization_name TEXT,
  contact_name TEXT,
  contact_phone phone_number,
  attendee_ages TEXT,
  is_admission_charged BOOLEAN,

  -- Sync tracking
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public_calendar_events IS
  'Public-facing calendar events synced from reservation_requests.
   Shows approved/completed events with privacy-aware column visibility.
   Private events show only time slot and "Private Event" label.
   Public events show full contact details.';

-- Index for calendar queries
CREATE INDEX idx_public_calendar_events_time_slot ON public_calendar_events USING GIST (time_slot);

-- Exclusion constraint: prevent overlapping approved events (double-booking protection)
-- When staff approves a request, the sync trigger INSERTs here.
-- If time_slot overlaps with existing entry, this constraint fails and blocks approval.
ALTER TABLE public_calendar_events
  ADD CONSTRAINT no_overlapping_approved_events
  EXCLUDE USING GIST (time_slot WITH &&);

COMMENT ON CONSTRAINT no_overlapping_approved_events ON public_calendar_events IS
  'Prevents double-booking: only one approved/completed event can exist for any time slot.
   Multiple pending requests CAN overlap; this only blocks when approving would create a conflict.';

-- ============================================================================
-- SECTION 2: SYNC TRIGGER FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_public_calendar_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_approved_ids INT[];
BEGIN
  -- Get approved/completed status IDs
  SELECT ARRAY_AGG(id) INTO v_approved_ids
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request'
  AND display_name IN ('Approved', 'Completed');

  -- DELETE: Remove from public calendar
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public_calendar_events WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  -- INSERT or UPDATE: Sync if approved, remove if not
  IF NEW.status_id = ANY(v_approved_ids) THEN
    INSERT INTO public_calendar_events (
      id, time_slot, display_name, event_type, is_public_event,
      organization_name, contact_name, contact_phone, attendee_ages,
      is_admission_charged, synced_at
    ) VALUES (
      NEW.id,
      NEW.time_slot,
      -- Display name: show details for public, mask for private
      CASE WHEN NEW.is_public_event
        THEN COALESCE(NEW.organization_name, NEW.requestor_name) || ' - ' || NEW.event_type
        ELSE 'Private Event'
      END,
      -- Event type: show for public, mask for private
      CASE WHEN NEW.is_public_event THEN NEW.event_type ELSE 'Private Event' END,
      NEW.is_public_event,
      -- Contact info: only for public events
      CASE WHEN NEW.is_public_event THEN NEW.organization_name END,
      CASE WHEN NEW.is_public_event THEN NEW.requestor_name END,
      CASE WHEN NEW.is_public_event THEN NEW.requestor_phone END,
      CASE WHEN NEW.is_public_event THEN NEW.attendee_ages END,
      CASE WHEN NEW.is_public_event THEN NEW.is_admission_charged END,
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      time_slot = EXCLUDED.time_slot,
      display_name = EXCLUDED.display_name,
      event_type = EXCLUDED.event_type,
      is_public_event = EXCLUDED.is_public_event,
      organization_name = EXCLUDED.organization_name,
      contact_name = EXCLUDED.contact_name,
      contact_phone = EXCLUDED.contact_phone,
      attendee_ages = EXCLUDED.attendee_ages,
      is_admission_charged = EXCLUDED.is_admission_charged,
      synced_at = NOW();
  ELSE
    -- Not approved: remove from public calendar
    DELETE FROM public_calendar_events WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Attach trigger to reservation_requests
CREATE TRIGGER sync_to_public_calendar
  AFTER INSERT OR UPDATE OR DELETE ON reservation_requests
  FOR EACH ROW EXECUTE FUNCTION sync_public_calendar_event();

-- ============================================================================
-- SECTION 3: ROW LEVEL SECURITY
-- ============================================================================

-- Enable RLS
ALTER TABLE public_calendar_events ENABLE ROW LEVEL SECURITY;

-- Simple policy: everyone can read (this is the public calendar)
CREATE POLICY "Public calendar events are readable by all"
  ON public_calendar_events FOR SELECT
  TO authenticated, web_anon
  USING (true);

-- No INSERT/UPDATE/DELETE policies - sync only via trigger

-- ============================================================================
-- SECTION 4: GRANTS
-- ============================================================================

-- Everyone can read (RLS enforces which records)
GRANT SELECT ON public_calendar_events TO web_anon, authenticated;

-- ============================================================================
-- SECTION 5: ENTITY METADATA
-- ============================================================================

-- Register as an entity for UI discovery
INSERT INTO metadata.entities (
  table_name, display_name, description, sort_order,
  search_fields, show_calendar, calendar_property_name
) VALUES (
  'public_calendar_events',
  'Public Events',
  'Public calendar of approved events',
  5,
  ARRAY['display_name', 'event_type', 'organization_name'],
  TRUE,
  'time_slot'
) ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  search_fields = EXCLUDED.search_fields,
  show_calendar = EXCLUDED.show_calendar,
  calendar_property_name = EXCLUDED.calendar_property_name;

-- Configure properties for List and Detail pages
INSERT INTO metadata.properties (
  table_name, column_name, display_name, description, sort_order,
  show_on_list, show_on_create, show_on_edit, show_on_detail, column_width
) VALUES
  -- Time slot - main calendar field
  ('public_calendar_events', 'time_slot', 'When', 'Event date and time', 1,
   TRUE, FALSE, FALSE, TRUE, 2),
  -- Display name - shows in list
  ('public_calendar_events', 'display_name', 'Event', 'Event name', 2,
   TRUE, FALSE, FALSE, TRUE, 2),
  -- Event type
  ('public_calendar_events', 'event_type', 'Type', 'Type of event', 3,
   TRUE, FALSE, FALSE, TRUE, 1),
  -- Is public flag (hidden but used for filtering)
  ('public_calendar_events', 'is_public_event', 'Public Event', 'Whether event details are public', 4,
   FALSE, FALSE, FALSE, FALSE, 1),
  -- Contact info - only visible on Detail page
  ('public_calendar_events', 'organization_name', 'Organization', 'Hosting organization', 10,
   FALSE, FALSE, FALSE, TRUE, 1),
  ('public_calendar_events', 'contact_name', 'Contact', 'Contact person', 11,
   FALSE, FALSE, FALSE, TRUE, 1),
  ('public_calendar_events', 'contact_phone', 'Phone', 'Contact phone', 12,
   FALSE, FALSE, FALSE, TRUE, 1),
  ('public_calendar_events', 'attendee_ages', 'Ages', 'Age group for attendees', 13,
   FALSE, FALSE, FALSE, TRUE, 1),
  ('public_calendar_events', 'is_admission_charged', 'Admission', 'Whether admission is charged', 14,
   FALSE, FALSE, FALSE, TRUE, 1),
  -- Hide sync tracking from UI
  ('public_calendar_events', 'synced_at', 'Synced At', 'When record was last synced', 99,
   FALSE, FALSE, FALSE, FALSE, 1)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail,
  column_width = EXCLUDED.column_width;

-- ============================================================================
-- SECTION 6: CONSTRAINT MESSAGES
-- ============================================================================

-- Human-readable error message for the overlap constraint
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'no_overlapping_approved_events',
  'public_calendar_events',
  'time_slot',
  'Cannot approve this reservation: the requested time slot conflicts with an existing approved event. Please check the calendar for availability or contact the requestor to reschedule.'
) ON CONFLICT (constraint_name) DO UPDATE SET
  error_message = EXCLUDED.error_message;

-- ============================================================================
-- SECTION 7: PERMISSIONS
-- ============================================================================

-- Create permission entries
INSERT INTO metadata.permissions (table_name, permission)
VALUES
  ('public_calendar_events', 'read')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant read to all roles (including user - this is the public calendar)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'public_calendar_events'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- SECTION 8: INITIAL SYNC
-- ============================================================================
-- Populate public_calendar_events from existing approved/completed reservations

INSERT INTO public_calendar_events (
  id, time_slot, display_name, event_type, is_public_event,
  organization_name, contact_name, contact_phone, attendee_ages,
  is_admission_charged, synced_at
)
SELECT
  r.id,
  r.time_slot,
  CASE WHEN r.is_public_event
    THEN COALESCE(r.organization_name, r.requestor_name) || ' - ' || r.event_type
    ELSE 'Private Event'
  END,
  CASE WHEN r.is_public_event THEN r.event_type ELSE 'Private Event' END,
  r.is_public_event,
  CASE WHEN r.is_public_event THEN r.organization_name END,
  CASE WHEN r.is_public_event THEN r.requestor_name END,
  CASE WHEN r.is_public_event THEN r.requestor_phone END,
  CASE WHEN r.is_public_event THEN r.attendee_ages END,
  CASE WHEN r.is_public_event THEN r.is_admission_charged END,
  NOW()
FROM reservation_requests r
WHERE r.status_id IN (
  SELECT id FROM metadata.statuses
  WHERE entity_type = 'reservation_request'
  AND display_name IN ('Approved', 'Completed')
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ROLLBACK;