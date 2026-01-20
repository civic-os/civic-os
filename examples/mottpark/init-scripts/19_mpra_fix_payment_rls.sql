-- Fix: Allow manager role to insert/update reservation payments
--
-- Problem: The live database has an old "admin modify" (ALL) policy using is_admin()
-- instead of separate INSERT/UPDATE/DELETE policies. This prevented managers from
-- recording manual payments.
--
-- Run this in the mottpark database to apply the fix without reinitializing.

-- Drop the old policies (handles both old "admin modify" and newer separate policies)
DROP POLICY IF EXISTS "admin modify" ON reservation_payments;
DROP POLICY IF EXISTS "reservation_payments: admin insert" ON reservation_payments;
DROP POLICY IF EXISTS "reservation_payments: authorized insert" ON reservation_payments;
DROP POLICY IF EXISTS "reservation_payments: authorized update" ON reservation_payments;
DROP POLICY IF EXISTS "reservation_payments: admin delete" ON reservation_payments;
DROP POLICY IF EXISTS "reservation_payments: read own or manager" ON reservation_payments;
DROP POLICY IF EXISTS "reservation_payments: authorized read" ON reservation_payments;

-- SELECT: Users see own payments, or anyone with read permission
CREATE POLICY "reservation_payments: authorized read" ON reservation_payments
  FOR SELECT TO authenticated
  USING (
    -- Users can see payments for their own reservations
    EXISTS (
      SELECT 1 FROM reservation_requests rr
      WHERE rr.id = reservation_request_id
      AND rr.requestor_id = current_user_id()
    )
    -- OR anyone with read permission
    OR has_permission('reservation_payments', 'read')
  );

-- INSERT: Managers can record manual payments
CREATE POLICY "reservation_payments: authorized insert" ON reservation_payments
  FOR INSERT TO authenticated
  WITH CHECK (has_permission('reservation_payments', 'create'));

-- UPDATE: Managers can update payment details (status, notes, waivers)
CREATE POLICY "reservation_payments: authorized update" ON reservation_payments
  FOR UPDATE TO authenticated
  USING (has_permission('reservation_payments', 'update'))
  WITH CHECK (has_permission('reservation_payments', 'update'));

-- DELETE: Only admins can delete payments
CREATE POLICY "reservation_payments: admin delete" ON reservation_payments
  FOR DELETE TO authenticated
  USING (is_admin());

-- Verify the fix
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'reservation_payments'
ORDER BY policyname;
