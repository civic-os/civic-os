-- Deploy civic_os:v0-74-0-fix-role-sync-cascade to pg
-- Fix: refresh_current_user() performed continuous bidirectional sync between
-- JWT and database, creating two feedback loops:
--   Loop A (role loss): JWT transiently missing role → DELETE from DB → trigger →
--     River job revokes from Keycloak → next JWT permanently missing
--   Loop B (revocation undone): Admin revokes role → syncs to Keycloak → cached JWT
--     still has role → next login re-INSERTs → trigger re-assigns in Keycloak
--
-- Solution: Convert from continuous sync to first-login-only bootstrapper.
-- After first login, Civic OS DB is the sole authority for user data and roles.
-- Users edit profiles via /profile page, admins via User Management.

BEGIN;

-- ============================================================================
-- Replace refresh_current_user() with first-login bootstrapper
-- ============================================================================
-- Based on v0-65-0 version (latest). Changes:
--   a) User upserts: ON CONFLICT DO UPDATE → ON CONFLICT DO NOTHING
--      Name, email, first/last name set on first login only. After that,
--      admin manages via User Management, users via /profile page.
--   b) Role sync: Only runs for genuinely new users (no civic_os_users record
--      before this call). Phase 2 (DELETE) removed entirely — no more cascade.
--      Phase 4 (touch synced_at) removed — unnecessary on first login.
--   c) get_real_user_roles() preserved (v0.41.2 impersonation fix).
--   d) last_login_at: Still updated on every login (not gated by first-login
--      check) since it's a tracking field, not user-editable data.

CREATE OR REPLACE FUNCTION public.refresh_current_user()
RETURNS metadata.civic_os_users AS $$
DECLARE
  v_user_id UUID;
  v_display_name TEXT;
  v_email TEXT;
  v_first_name TEXT;
  v_last_name TEXT;
  v_user_roles TEXT[];
  v_role_name TEXT;
  v_role_id SMALLINT;
  v_filtered_roles TEXT[] := '{}';
  v_result metadata.civic_os_users;
  v_rows_inserted INT;
BEGIN
  v_user_id := public.current_user_id();
  v_display_name := public.current_user_name();
  v_email := public.current_user_email();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No authenticated user found in JWT';
  END IF;

  IF v_display_name IS NULL OR v_display_name = '' THEN
    RAISE EXCEPTION 'No display name found in JWT (name or preferred_username claim required)';
  END IF;

  -- Read first_name/last_name from JWT given_name/family_name claims (OIDC standard)
  -- Fall back to last-space split of display_name for non-OIDC providers
  v_first_name := public.current_user_first_name();
  v_last_name := public.current_user_last_name();

  IF v_first_name IS NULL THEN
    -- Fallback: parse from display_name (supports non-Keycloak providers)
    -- "John Michael Doe" → first="John Michael", last="Doe"
    -- "SingleName" → first="SingleName", last=NULL
    IF position(' ' IN TRIM(v_display_name)) > 0 THEN
      v_last_name := split_part(TRIM(v_display_name), ' ',
                       array_length(string_to_array(TRIM(v_display_name), ' '), 1));
      v_first_name := TRIM(LEFT(TRIM(v_display_name),
                       length(TRIM(v_display_name)) - length(v_last_name) - 1));
    ELSE
      v_first_name := TRIM(v_display_name);
      v_last_name := NULL;
    END IF;
  END IF;

  -- Insert-only user record (no update on conflict).
  -- First login: creates the record. Subsequent logins: no-op.
  -- After first login, profile data is managed by:
  --   Users: /profile page → update_own_profile() RPC
  --   Admins: User Management → update_user_info() RPC
  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;

  -- Track whether this is a genuinely new user (not just zero roles).
  -- ROW_COUNT from INSERT ... ON CONFLICT DO NOTHING: 1 = new user, 0 = existing.
  -- Checking civic_os_users (not user_roles) is deliberate: an admin could revoke
  -- ALL roles, making the user look "new" if we checked user_roles, and
  -- re-bootstrapping from JWT would undo the admin's revocation.
  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;

  -- Insert-only private user record (same rationale as above).
  -- NOTE: phone is intentionally excluded — database is the authority for phone,
  -- not JWT claims. Phone is managed via profile page and admin UI (since v0.65.0).
  -- last_login_at is set on INSERT but also updated below for returning users.
  INSERT INTO metadata.civic_os_users_private (id, display_name, email, first_name, last_name, last_login_at, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_first_name, v_last_name, NOW(), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET last_login_at = NOW();

  -- Existing user: skip all role sync. Civic OS admin manages roles after first login.
  IF v_rows_inserted = 0 THEN
    SELECT * INTO v_result FROM metadata.civic_os_users WHERE id = v_user_id;
    RETURN v_result;
  END IF;

  -- === FIRST LOGIN ONLY: Bootstrap roles from JWT ===

  -- Use get_real_user_roles() to ignore impersonation header (v0.41.2 fix)
  v_user_roles := public.get_real_user_roles();

  -- Phase 1: Build filtered roles array (skip system roles, auto-create unknown)
  FOREACH v_role_name IN ARRAY v_user_roles
  LOOP
    IF metadata.is_keycloak_system_role(v_role_name) THEN
      CONTINUE;
    END IF;

    -- Lookup role_id by role_key (JWT role names match role_key)
    SELECT id INTO v_role_id
    FROM metadata.roles
    WHERE role_key = v_role_name;

    -- If role doesn't exist, auto-create it from JWT claim.
    -- Explicitly set role_key = display_name to match the Keycloak role name
    -- (bypasses trigger's snake_case transformation for JWT-sourced roles).
    IF v_role_id IS NULL THEN
      INSERT INTO metadata.roles (display_name, role_key)
      VALUES (v_role_name, v_role_name)
      RETURNING id INTO v_role_id;

      RAISE NOTICE 'Auto-created role "%" from JWT', v_role_name;
    END IF;

    v_filtered_roles := array_append(v_filtered_roles, v_role_name);
  END LOOP;

  -- Phase 2 (DELETE) removed entirely — this was the cascade bug.
  -- Roles are only removed by admin action (revoke_user_role RPC),
  -- which correctly syncs to Keycloak via trigger + worker.

  -- Phase 3: Insert roles from JWT (first login only; triggers fire assign jobs)
  INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
  SELECT v_user_id, r.id, NOW()
  FROM metadata.roles r
  WHERE r.role_key = ANY(v_filtered_roles)
    AND NOT EXISTS (
      SELECT 1 FROM metadata.user_roles ur
      WHERE ur.user_id = v_user_id AND ur.role_id = r.id
    );

  -- Phase 4 (touch synced_at) removed — unnecessary on first login.

  SELECT * INTO v_result
  FROM metadata.civic_os_users
  WHERE id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.refresh_current_user() IS
    'First-login bootstrapper: creates user record and syncs roles from JWT on
     first login only. Subsequent logins only update last_login_at. Civic OS is
     the sole authority for user data and roles after initial bootstrap. Users
     update their own profile via /profile page (update_own_profile RPC), admins
     via User Management (update_user_info RPC). Role changes flow one way:
     Civic OS DB → Keycloak via trigger + worker pipeline. Phone excluded from
     JWT sync since v0.65.0 (database is the authority for phone).
     Fixed in v0.74.0 to eliminate the role sync cascade bug (see
     docs/notes/ROLE_SYNC_CASCADE_BUG.md). Preserves v0.41.2 fix:
     uses get_real_user_roles() to prevent impersonation poisoning.';


-- ============================================================================
-- SCHEMA DECISION: Document the rationale
-- ============================================================================

INSERT INTO metadata.schema_decisions (title, decision, rationale, migration_id)
VALUES (
  'Fix role sync cascade — make Civic OS the single authority',
  'Convert refresh_current_user() from continuous bidirectional sync to first-login-only '
  'bootstrapper. User upserts changed to INSERT ON CONFLICT DO NOTHING (except '
  'last_login_at which always updates). Role sync only runs for genuinely new users '
  '(no existing civic_os_users record). Phase 2 (DELETE) removed entirely.',
  'refresh_current_user() performed continuous bidirectional sync between JWT and '
  'database on every login. This created two feedback loops: (A) JWT transiently '
  'missing a role caused permanent role loss via DELETE → trigger → Keycloak revoke → '
  'next JWT missing role; (B) admin role revocations were undone when cached JWT still '
  'had the role on next login. After first login, all user data flows one way: '
  'Civic OS DB → Keycloak.',
  'v0-74-0-fix-role-sync-cascade'
);


-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================
NOTIFY pgrst, 'reload schema';

COMMIT;
