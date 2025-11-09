-- Revert civic_os:v0-11-0-add-user-roles from pg
-- Restore previous refresh_current_user() and remove user_roles table

BEGIN;

-- Drop has_role() function
DROP FUNCTION IF EXISTS public.has_role(UUID, TEXT);

-- Drop user_roles table (CASCADE removes foreign keys and RLS policies)
DROP TABLE IF EXISTS metadata.user_roles CASCADE;

-- Restore previous version of refresh_current_user() (from v0-6-0)
CREATE OR REPLACE FUNCTION public.refresh_current_user()
RETURNS metadata.civic_os_users AS $$
DECLARE
  v_user_id UUID;
  v_display_name TEXT;
  v_email TEXT;
  v_phone TEXT;
  v_result metadata.civic_os_users;
BEGIN
  -- Get claims from JWT
  v_user_id := public.current_user_id();
  v_display_name := public.current_user_name();
  v_email := public.current_user_email();
  v_phone := public.current_user_phone();

  -- Validate we have required data
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No authenticated user found in JWT';
  END IF;

  IF v_display_name IS NULL OR v_display_name = '' THEN
    RAISE EXCEPTION 'No display name found in JWT (name or preferred_username claim required)';
  END IF;

  -- Upsert into civic_os_users (public profile)
  -- Store shortened name (e.g., "John D.") for privacy
  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = NOW();

  -- Upsert into civic_os_users_private (private profile)
  INSERT INTO metadata.civic_os_users_private (id, display_name, email, phone, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_phone, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        updated_at = NOW();

  -- Return the public user record
  SELECT * INTO v_result
  FROM metadata.civic_os_users
  WHERE id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.refresh_current_user() IS 'Sync current user data from JWT claims to database. Includes name, email, and phone.';

COMMIT;
