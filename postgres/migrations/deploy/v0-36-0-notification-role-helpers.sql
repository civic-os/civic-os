-- Deploy v0-36-0-notification-role-helpers
-- Requires: v0-36-0-add-role-key

BEGIN;

-- ============================================================================
-- HELPER 1: metadata.get_users_by_role(role_keys TEXT[])
--
-- Returns user IDs for all users that have ANY of the specified roles.
-- Uses role_key for stable lookups (immune to display_name renames).
--
-- Lives in metadata schema (not exposed via PostgREST API).
-- Callable from SECURITY DEFINER functions (triggers, scheduled jobs, RPCs).
--
-- Example (inside a function):
--   SELECT * FROM metadata.get_users_by_role(ARRAY['manager', 'admin']);
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.get_users_by_role(p_role_keys TEXT[])
RETURNS TABLE (user_id UUID)
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = metadata, public
AS $$
  SELECT DISTINCT u.id
  FROM metadata.civic_os_users u
  INNER JOIN metadata.user_roles ur ON ur.user_id = u.id
  INNER JOIN metadata.roles r ON r.id = ur.role_id
  WHERE r.role_key = ANY(p_role_keys);
$$;

COMMENT ON FUNCTION metadata.get_users_by_role(TEXT[]) IS
  'Return user IDs for all users holding any of the given role_keys. Internal helper — not exposed via PostgREST.';

-- ============================================================================
-- HELPER 2: metadata.send_notification_to_role(...)
--
-- Sends a notification to every user holding ANY of the given roles.
-- Replaces the common pattern:
--
--   FOR v_user_id IN
--     SELECT DISTINCT u.id
--     FROM metadata.civic_os_users u
--     JOIN metadata.user_roles ur ON u.id = ur.user_id
--     JOIN metadata.roles r ON ur.role_id = r.id
--     WHERE r.role_key IN ('manager', 'admin')
--   LOOP
--     PERFORM create_notification(v_user_id, ...);
--   END LOOP;
--
-- With a single call:
--
--   PERFORM metadata.send_notification_to_role(
--     ARRAY['manager', 'admin'],
--     'template_name',
--     'entity_type',
--     entity_id::text,
--     entity_data_jsonb
--   );
--
-- Lives in metadata schema (not exposed via PostgREST API).
-- Callable from SECURITY DEFINER functions (triggers, scheduled jobs, RPCs).
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.send_notification_to_role(
  p_role_keys   TEXT[],
  p_template_name VARCHAR,
  p_entity_type VARCHAR DEFAULT NULL,
  p_entity_id   VARCHAR DEFAULT NULL,
  p_entity_data JSONB   DEFAULT NULL,
  p_channels    TEXT[]  DEFAULT '{email}'
)
RETURNS INT  -- number of notifications created
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_user_id UUID;
  v_count   INT := 0;
BEGIN
  FOR v_user_id IN
    SELECT user_id FROM metadata.get_users_by_role(p_role_keys)
  LOOP
    PERFORM create_notification(
      p_user_id       := v_user_id,
      p_template_name := p_template_name,
      p_entity_type   := p_entity_type,
      p_entity_id     := p_entity_id,
      p_entity_data   := p_entity_data,
      p_channels      := p_channels
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION metadata.send_notification_to_role(TEXT[], VARCHAR, VARCHAR, VARCHAR, JSONB, TEXT[]) IS
  'Send a notification to every user holding any of the given role_keys. Returns count. Internal helper — not exposed via PostgREST.';

-- ============================================================================
-- SCHEMA RELOAD
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
