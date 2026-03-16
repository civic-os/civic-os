-- Deploy v0-38-4-fix-role-key-view
-- Fix managed_users VIEW to return role_key values instead of display_name
-- in the roles array, and add UPDATE immutability trigger for role_key.
--
-- Problem: The roles column contained display_name values but the frontend
-- filters and compares using role_key. For built-in roles (admin, user, editor)
-- these are identical, but custom roles with multi-word display names
-- (e.g., "Content Editor" vs role_key "content_editor") would break filtering
-- and edit modal checkbox state.
--
-- Fix: Switch roles array to aggregate role_key values. Frontend already has
-- manageableRoles() loaded with both key and display_name for badge rendering.

BEGIN;

-- ============================================================================
-- 1. ADD UPDATE IMMUTABILITY TRIGGER FOR role_key
-- ============================================================================
-- The INSERT trigger (set_role_key) auto-generates role_key, but nothing
-- prevented a direct UPDATE. This trigger enforces true immutability.

CREATE OR REPLACE FUNCTION metadata.protect_role_key()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role_key IS DISTINCT FROM OLD.role_key THEN
    RAISE EXCEPTION 'role_key is immutable and cannot be changed after creation'
      USING HINT = 'Create a new role instead of renaming the key';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_roles_protect_key
  BEFORE UPDATE ON metadata.roles
  FOR EACH ROW EXECUTE FUNCTION metadata.protect_role_key();

COMMENT ON FUNCTION metadata.protect_role_key() IS
  'Prevents UPDATE of role_key column. role_key is set once on INSERT
   and must remain stable for JWT matching and Keycloak sync.';


-- ============================================================================
-- 2. RECREATE managed_users VIEW WITH role_key IN roles ARRAY
-- ============================================================================

DROP VIEW IF EXISTS public.managed_users;

CREATE VIEW public.managed_users
WITH (security_invoker = true) AS

-- Active users (fully provisioned, have Keycloak accounts)
SELECT
    u.id,
    u.display_name,
    p.display_name AS full_name,
    p.first_name,
    p.last_name,
    p.email::TEXT AS email,
    p.phone::TEXT AS phone,
    'active'::TEXT AS status,
    NULL::TEXT AS error_message,
    COALESCE(
        (SELECT array_agg(r.role_key ORDER BY r.role_key)
         FROM metadata.user_roles ur
         JOIN metadata.roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id
           AND NOT metadata.is_keycloak_system_role(r.display_name)
           AND r.role_key != 'anonymous'),
        (SELECT up2.initial_roles
         FROM metadata.user_provisioning up2
         WHERE up2.keycloak_user_id = u.id
         ORDER BY up2.completed_at DESC NULLS LAST
         LIMIT 1)
    ) AS roles,
    u.created_at,
    NULL::BIGINT AS provision_id,
    np_email.enabled AS email_notif_enabled,
    np_sms.enabled AS sms_notif_enabled,
    np_sms.sms_opted_out
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id
LEFT JOIN metadata.notification_preferences np_email
    ON np_email.user_id = u.id AND np_email.channel = 'email'
LEFT JOIN metadata.notification_preferences np_sms
    ON np_sms.user_id = u.id AND np_sms.channel = 'sms'

UNION ALL

-- Pending/failed provisioning requests (not yet in civic_os_users)
SELECT
    up.keycloak_user_id AS id,
    (up.first_name || ' ' || substring(up.last_name from 1 for 1) || '.')::TEXT AS display_name,
    (up.first_name || ' ' || up.last_name)::TEXT AS full_name,
    up.first_name,
    up.last_name,
    up.email::TEXT,
    up.phone::TEXT,
    up.status::TEXT,
    up.error_message,
    up.initial_roles AS roles,
    up.created_at,
    up.id AS provision_id,
    NULL::BOOLEAN AS email_notif_enabled,
    NULL::BOOLEAN AS sms_notif_enabled,
    NULL::BOOLEAN AS sms_opted_out
FROM metadata.user_provisioning up
WHERE up.status NOT IN ('completed');

COMMENT ON VIEW public.managed_users IS
    'Combined view of all users for admin User Management page. Active users
     from civic_os_users UNION pending/failed provisioning requests.
     roles array contains role_key values (stable programmatic identifiers).
     Updated in v0.38.4.';

GRANT SELECT ON public.managed_users TO authenticated;


-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
