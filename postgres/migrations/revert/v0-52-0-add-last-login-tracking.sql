-- Revert civic_os:v0-52-0-add-last-login-tracking from pg

BEGIN;

-- ============================================================================
-- 1. RESTORE managed_users VIEW (v0-38-4 definition, without last_login_at)
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


-- ============================================================================
-- 2. RESTORE refresh_current_user() (v0-47-1 version, without last_login_at
--    or OIDC claims)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refresh_current_user()
RETURNS metadata.civic_os_users AS $$
DECLARE
  v_user_id UUID;
  v_display_name TEXT;
  v_email TEXT;
  v_phone TEXT;
  v_first_name TEXT;
  v_last_name TEXT;
  v_user_roles TEXT[];
  v_role_name TEXT;
  v_role_id SMALLINT;
  v_filtered_roles TEXT[] := '{}';
  v_result metadata.civic_os_users;
BEGIN
  v_user_id := public.current_user_id();
  v_display_name := public.current_user_name();
  v_email := public.current_user_email();
  v_phone := public.current_user_phone();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No authenticated user found in JWT';
  END IF;

  IF v_display_name IS NULL OR v_display_name = '' THEN
    RAISE EXCEPTION 'No display name found in JWT (name or preferred_username claim required)';
  END IF;

  -- Parse first_name/last_name from display_name using last-space split
  IF position(' ' IN TRIM(v_display_name)) > 0 THEN
    v_last_name := split_part(TRIM(v_display_name), ' ',
                     array_length(string_to_array(TRIM(v_display_name), ' '), 1));
    v_first_name := TRIM(LEFT(TRIM(v_display_name),
                     length(TRIM(v_display_name)) - length(v_last_name) - 1));
  ELSE
    v_first_name := TRIM(v_display_name);
    v_last_name := NULL;
  END IF;

  -- Upsert user record
  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = NOW();

  -- Upsert private user record (includes first_name/last_name)
  INSERT INTO metadata.civic_os_users_private (id, display_name, email, phone, first_name, last_name, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_phone, v_first_name, v_last_name, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        updated_at = NOW();

  -- FIX: Use get_real_user_roles() to ignore impersonation header
  v_user_roles := public.get_real_user_roles();

  -- Phase 1: Build filtered roles array (skip system roles, auto-create unknown)
  FOREACH v_role_name IN ARRAY v_user_roles
  LOOP
    IF metadata.is_keycloak_system_role(v_role_name) THEN
      CONTINUE;
    END IF;

    SELECT id INTO v_role_id
    FROM metadata.roles
    WHERE role_key = v_role_name;

    IF v_role_id IS NULL THEN
      INSERT INTO metadata.roles (display_name, role_key)
      VALUES (v_role_name, v_role_name)
      RETURNING id INTO v_role_id;

      RAISE NOTICE 'Auto-created role "%" from JWT', v_role_name;
    END IF;

    v_filtered_roles := array_append(v_filtered_roles, v_role_name);
  END LOOP;

  -- Phase 2: Delete roles no longer in JWT
  DELETE FROM metadata.user_roles
  WHERE user_id = v_user_id
    AND role_id NOT IN (
      SELECT id FROM metadata.roles WHERE role_key = ANY(v_filtered_roles)
    );

  -- Phase 3: Insert new roles from JWT
  INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
  SELECT v_user_id, r.id, NOW()
  FROM metadata.roles r
  WHERE r.role_key = ANY(v_filtered_roles)
    AND NOT EXISTS (
      SELECT 1 FROM metadata.user_roles ur
      WHERE ur.user_id = v_user_id AND ur.role_id = r.id
    );

  -- Phase 4: Touch synced_at on unchanged roles
  UPDATE metadata.user_roles SET synced_at = NOW()
  WHERE user_id = v_user_id
    AND role_id IN (SELECT id FROM metadata.roles WHERE role_key = ANY(v_filtered_roles));

  SELECT * INTO v_result
  FROM metadata.civic_os_users
  WHERE id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.refresh_current_user() IS
    'Sync current user data from JWT claims to database. Includes name, email,
     phone, first_name, last_name, and roles. Uses diff-based role sync (only
     inserts/deletes changed roles) to avoid trigger storms. Skips Keycloak
     system roles. Uses role_key for lookups. Fixed in v0.41.2 to use
     get_real_user_roles(). Fixed in v0.47.1 to restore first_name/last_name
     parsing that was dropped in v0.36.0.';


-- ============================================================================
-- 3. DROP JWT HELPER FUNCTIONS
-- ============================================================================

DROP FUNCTION IF EXISTS public.current_user_first_name();
DROP FUNCTION IF EXISTS public.current_user_last_name();

-- Note: No backfill revert — the data fix is harmless to keep.
-- Users with corrected first_name/last_name values will retain them.


-- ============================================================================
-- 4. DROP last_login_at COLUMN
-- ============================================================================

ALTER TABLE metadata.civic_os_users_private DROP COLUMN last_login_at;


-- ============================================================================
-- 5. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
