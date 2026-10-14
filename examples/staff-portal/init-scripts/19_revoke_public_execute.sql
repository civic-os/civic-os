-- 19_revoke_public_execute.sql
-- Staff Portal example: revoke PUBLIC EXECUTE and fix NULL-unsafe clock-in/out guards.
--
-- Findings addressed:
--   - staff_clock_in/staff_clock_out compared the target with "<>" against the caller's staff
--     member id. For an anonymous or non-staff caller that id is NULL, the comparison is NULL,
--     the guard is skipped, and time entries could be forged for any staff member.
--   - get_users_with_role / get_site_lead_email returned user ids and emails to any caller.
--
-- Companion to core migration v0-76-5-revoke-public-execute. PostgreSQL grants EXECUTE to
-- PUBLIC on every new function, so a bare GRANT ... TO authenticated never removed anonymous
-- (web_anon) access. This script revokes PUBLIC from this example's non-anonymous functions,
-- and adds in-body authorization checks to SECURITY DEFINER RPCs that had none.
--
-- Safe to re-run: REVOKE/GRANT are idempotent and CREATE OR REPLACE keeps existing ACLs.

BEGIN;

-- ===========================================================================
-- 1. Authorization guards (CREATE OR REPLACE keeps the existing ACL)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.staff_clock_in(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_time_text TEXT;
BEGIN
  -- Authorization guard
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to clock in';
  END IF;

  -- Verify caller is the staff member (prevent clocking in for others)
  IF get_current_staff_member_id() IS NULL
     OR p_entity_id <> get_current_staff_member_id() THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'You can only clock in for yourself'
    );
  END IF;

  -- Create time entry (denormalize trigger fills staff_name and site_name)
  INSERT INTO time_entries (staff_member_id, entry_type_id, entry_time)
  VALUES (p_entity_id, get_category_id('time_entry', 'clock_in'), NOW());

  v_time_text := TO_CHAR(NOW(), 'HH:MI AM');

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Clocked in at ' || v_time_text,
    'refresh', true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_clock_out(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_time_text TEXT;
BEGIN
  -- Authorization guard
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to clock out';
  END IF;

  -- Verify caller is the staff member (prevent clocking out for others)
  IF get_current_staff_member_id() IS NULL
     OR p_entity_id <> get_current_staff_member_id() THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'You can only clock out for yourself'
    );
  END IF;

  -- Create time entry (denormalize trigger fills staff_name and site_name)
  INSERT INTO time_entries (staff_member_id, entry_type_id, entry_time)
  VALUES (p_entity_id, get_category_id('time_entry', 'clock_out'), NOW());

  v_time_text := TO_CHAR(NOW(), 'HH:MI AM');

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Clocked out at ' || v_time_text,
    'refresh', true
  );
END;
$$;

-- ===========================================================================
-- 2. REVOKE EXECUTE FROM PUBLIC - authenticated-only functions
-- (explicit GRANT ... TO authenticated from the earlier scripts stays in place; the RLS helpers
-- and column DEFAULTs are evaluated as the logged-in user)
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.get_current_staff_member_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_current_staff_member_site_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_user_is_site_lead() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_lead_of_site(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_site_id_for_staff(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.staff_clock_in(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.staff_clock_out(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_time_off(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deny_time_off(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_staff_document(bigint, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_staff_document(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_document_revision(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_reimbursement(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deny_reimbursement(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.start_staff_task(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_staff_task(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cancel_staff_task(bigint, text) FROM PUBLIC;

-- ===========================================================================
-- 3. Internal helpers - only called by SECURITY DEFINER notification triggers (run as owner)
-- ===========================================================================

-- Both return user ids + emails: must not be callable through the API.
REVOKE EXECUTE ON FUNCTION public.get_users_with_role(text) FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_site_lead_email(bigint) FROM PUBLIC, authenticated;

-- ===========================================================================
-- 4. Internal trigger functions
-- Trigger functions: EXECUTE is only checked when a trigger is created, never when it fires,
-- so revoking PUBLIC here does not affect the triggers.
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.set_staff_document_display_name() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.denormalize_time_entry() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_time_entry_display_name() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_reimbursement_display_name() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_offboarding_display_name() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auto_create_staff_documents() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.staff_document_status_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_onboarding_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_document_status_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_time_off_submitted() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_time_off_status_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_reimbursement_submitted() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_reimbursement_status_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_incident_report_filed() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_onboarding_complete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_task_assigned() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_staff_member_display_name() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cascade_user_name_to_staff_member() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cascade_site_name_to_staff_members() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.expand_staff_task_assignment() FROM PUBLIC;

COMMIT;
