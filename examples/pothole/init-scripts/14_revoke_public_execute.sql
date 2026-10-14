-- 14_revoke_public_execute.sql
-- Pothole example: revoke PUBLIC EXECUTE on internal functions.
--
-- Only the two notification trigger functions need work. location_text("Issue") is the
-- GeoPoint computed field for the anon-readable Issue table and keeps its explicit grant
-- to web_anon and authenticated (01_pot_hole_schema.sql), so it is intentionally untouched.
--
-- Companion to core migration v0-76-5-revoke-public-execute. PostgreSQL grants EXECUTE to
-- PUBLIC on every new function, so a bare GRANT ... TO authenticated never removed anonymous
-- (web_anon) access. This script revokes PUBLIC from this example's non-anonymous functions.
--
-- Safe to re-run: REVOKE/GRANT are idempotent and CREATE OR REPLACE keeps existing ACLs.

BEGIN;

-- ===========================================================================
-- Internal trigger functions
-- Trigger functions: EXECUTE is only checked when a trigger is created, never when it fires,
-- so revoking PUBLIC here does not affect the triggers.
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.notify_issue_created() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_issue_status_changed() FROM PUBLIC;

COMMIT;
