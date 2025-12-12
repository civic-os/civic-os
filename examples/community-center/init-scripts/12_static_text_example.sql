-- ============================================================================
-- STATIC TEXT EXAMPLE: Rental Agreement on Reservation Requests
-- Demonstrates static text feature (v0.17.0)
-- ============================================================================
-- NOTE: This script requires the v0.17.0 migration to be applied first
-- ============================================================================

-- ============================================================================
-- SUBMISSION GUIDELINES (Top of Create Form)
-- Low sort_order places this at the top of the form
-- ============================================================================
INSERT INTO metadata.static_text (
  table_name,
  content,
  sort_order,
  show_on_detail,
  show_on_create,
  show_on_edit
)
VALUES (
  'reservation_requests',
  '### Before You Submit

Please have the following information ready:
- **Resource:** Which facility you would like to reserve
- **Date and time:** Your preferred reservation window
- **Expected attendees:** Number of people at your event
- **Event purpose:** Brief description of your planned activity

*Requests are typically reviewed within 2 business days.*',
  5,     -- Low sort_order = appears near top
  FALSE, -- Don''t show on detail (irrelevant after submission)
  TRUE,  -- Show on create (guide users before they fill out)
  FALSE  -- Don''t show on edit (staff shouldn''t see this)
);
-- Note: column_width defaults to 8 (full width)

-- ============================================================================
-- RENTAL AGREEMENT (Bottom of Detail/Create Pages)
-- High sort_order places this at the bottom after all fields
-- ============================================================================
INSERT INTO metadata.static_text (
  table_name,
  content,
  sort_order,
  show_on_detail,
  show_on_create,
  show_on_edit
)
VALUES (
  'reservation_requests',
  '---

## Rental Agreement

By submitting this reservation request, you agree to the following terms:

1. **Cancellation Policy**: Cancellations must be made at least 48 hours in advance for a full refund.

2. **Facility Care**: The renter is responsible for leaving the facility in the same condition as found. A cleaning fee of $150 will be charged for excessive mess.

3. **Capacity Limits**: Maximum occupancy must not exceed the facility''s rated capacity. Fire marshal regulations apply.

4. **Noise Ordinance**: All events must comply with local noise ordinances. Amplified music must end by 10:00 PM.

5. **Liability**: The City of Mott Park is not responsible for personal injury or property damage during your event. Renters may be required to provide proof of insurance for large events.

*For questions about these terms, contact Community Services at (555) 123-4567.*',
  999,   -- High sort_order = appears at bottom
  TRUE,  -- Show on detail (so users can reference after submission)
  TRUE,  -- Show on create (so users see terms before submitting)
  FALSE  -- Don''t show on edit (they''ve already agreed)
);
-- Note: column_width defaults to 8 (full width)

-- ============================================================================
-- SECTION DIVIDER EXAMPLE (Optional)
-- Demonstrates visual separation between form sections
-- ============================================================================
-- Uncomment to enable a visual divider between basic info and terms:
--
-- INSERT INTO metadata.static_text (
--   table_name,
--   content,
--   sort_order,
--   show_on_detail,
--   show_on_create,
--   show_on_edit
-- )
-- VALUES (
--   'reservation_requests',
--   '---',  -- Just a horizontal rule
--   500,    -- Mid-range sort_order
--   TRUE,
--   TRUE,
--   FALSE
-- );
-- Note: column_width defaults to 8 (full width)

-- ============================================================================
-- VERIFY STATIC TEXT WAS CREATED
-- ============================================================================
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM metadata.static_text
  WHERE table_name = 'reservation_requests';

  RAISE NOTICE 'Created % static text entries for reservation_requests', v_count;
END;
$$;
