-- ============================================================================
-- MOTT PARK: FIX ADVANCE BOOKING CONSTRAINT
-- ============================================================================
-- This script fixes the 10-day advance booking CHECK constraint so that
-- managers can approve, deny, or cancel requests even after the event is
-- less than 10 days away.
--
-- PROBLEM:
-- The original constraint used CURRENT_DATE, which is evaluated on EVERY
-- INSERT and UPDATE. Once the event date approaches within 10 days, the
-- constraint fails on ANY update - including approvals, status changes,
-- and cancellations.
--
-- SOLUTION:
-- Use created_at instead of CURRENT_DATE. This validates that the ORIGINAL
-- submission was made at least 10 days in advance, but allows all subsequent
-- updates (approvals, denials, cancellations) regardless of current date.
--
-- Behavior After Fix:
-- | Action                                      | Before | After |
-- |---------------------------------------------|--------|-------|
-- | Create request 15 days out                  |   OK   |  OK   |
-- | Create request 5 days out                   | DENIED | DENIED|
-- | Approve request when event is 5 days away   | DENIED |  OK   |
-- | Cancel request when event is 3 days away    | DENIED |  OK   |
-- ============================================================================

-- ============================================================================
-- SECTION 1: DROP THE PROBLEMATIC CONSTRAINT
-- ============================================================================

ALTER TABLE reservation_requests
  DROP CONSTRAINT IF EXISTS min_advance_booking;

-- ============================================================================
-- SECTION 2: ADD FIXED CONSTRAINT USING created_at
-- ============================================================================
-- created_at is set once on INSERT (via DEFAULT NOW()) and never changes,
-- making it safe to use in CHECK constraints for time-based validations.

ALTER TABLE reservation_requests
  ADD CONSTRAINT min_advance_booking
  CHECK (
    lower(time_slot)::DATE >= (created_at::DATE + INTERVAL '10 days')::DATE
  );

-- Add comment explaining the constraint
COMMENT ON CONSTRAINT min_advance_booking ON reservation_requests IS
'Ensures reservations are requested at least 10 days in advance. Uses created_at
(immutable after INSERT) instead of CURRENT_DATE to allow managers to approve,
deny, or cancel requests even after the 10-day window has passed.';

-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA
-- ============================================================================

NOTIFY pgrst, 'reload schema';
