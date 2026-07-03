-- Deploy civic_os:v0-65-0-cup-phone-domain
-- Requires: v0-65-0-user-profile-extensions
--
-- v0.65.0 — Migrate civic_os_users_private.phone from VARCHAR(255) to phone_number domain:
--   1. Sanitize existing phone data (strip formatting, handle country codes)
--   2. ALTER COLUMN to phone_number domain
--   3. Recreate civic_os_users VIEW (+ cascade-dropped payment views)
--   4. Update refresh_current_user() — REMOVE phone sync from JWT (database is authority)
--   5. Update update_own_profile() with phone sanitization, remove phone from Keycloak sync
--   6. Update update_user_info() with phone sanitization, remove phone from Keycloak sync
--   7. Fix notification preferences trigger: update phone/email on change, disable SMS on NULL phone
--   8. Schema decision documenting JWT phone sync deprecation

BEGIN;

-- ============================================================================
-- 0. ADD user_fk_column OVERRIDE TO PROFILE EXTENSIONS CONFIG
-- ============================================================================
-- Many tables have both a user-ownership FK (e.g., user_id) AND a created_by
-- audit FK to civic_os_users. Auto-discovery picks the wrong one. Adding an
-- explicit override column lets integrators specify which FK to use.

ALTER TABLE metadata.user_profile_extensions
  ADD COLUMN IF NOT EXISTS user_fk_column NAME;

COMMENT ON COLUMN metadata.user_profile_extensions.user_fk_column IS
    'Optional: explicit FK column name referencing civic_os_users. If NULL,
     auto-discovered from information_schema (excluding created_by).';

-- Recreate the VIEW to include the new column (must DROP + CREATE since column order changed)
DROP VIEW IF EXISTS public.user_profile_extensions;

CREATE VIEW public.user_profile_extensions AS
SELECT id, table_name, sort_order, is_required, display_name, description,
       user_fk_column, created_at, updated_at
FROM metadata.user_profile_extensions;

GRANT SELECT ON public.user_profile_extensions TO web_anon, authenticated;


-- ============================================================================
-- 1. SANITIZE EXISTING DATA
-- ============================================================================
-- Strip non-digits, handle 11-digit US numbers (leading 1), NULL invalid values.

UPDATE metadata.civic_os_users_private
SET phone = CASE
  -- Pure 10-digit: keep as-is after stripping non-digits
  WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^\d{10}$'
    THEN regexp_replace(phone, '[^0-9]', '', 'g')
  -- 11-digit with leading 1 (US country code): strip the 1
  WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^\d{11}$'
    AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '1%'
    THEN substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 2)
  -- Everything else: NULL (can't safely convert)
  ELSE NULL
END
WHERE phone IS NOT NULL;


-- ============================================================================
-- 2. DROP DEPENDENTS + ALTER COLUMN TYPE
-- ============================================================================
-- Must drop the notification preferences trigger (references UPDATE OF phone)
-- and civic_os_users VIEW (references phone column) before ALTER COLUMN TYPE.
-- DROP VIEW CASCADE also drops payment_transactions and payment_refunds views.

DROP TRIGGER IF EXISTS create_default_notification_preferences_trigger
    ON metadata.civic_os_users_private;

DROP VIEW IF EXISTS public.civic_os_users CASCADE;
DROP VIEW IF EXISTS public.managed_users;

ALTER TABLE metadata.civic_os_users_private
  ALTER COLUMN phone TYPE phone_number;

-- Recreate trigger temporarily (will be replaced in section 7 with updated function)
CREATE TRIGGER create_default_notification_preferences_trigger
    AFTER INSERT OR UPDATE OF phone, email ON metadata.civic_os_users_private
    FOR EACH ROW
    EXECUTE FUNCTION create_default_notification_preferences();


-- ============================================================================
-- 3. RECREATE civic_os_users VIEW
-- ============================================================================
-- Definitions from v0-57-0-add-i18n.sql.

CREATE VIEW public.civic_os_users AS
SELECT
  u.id,
  u.display_name,
  u.created_at,
  u.updated_at,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.display_name
    ELSE NULL
  END AS full_name,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.email
    ELSE NULL
  END AS email,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.phone
    ELSE NULL
  END AS phone,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.locale
    ELSE NULL
  END AS locale,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN to_tsvector('english',
      COALESCE(u.display_name, '') || ' ' ||
      COALESCE(p.display_name, '') || ' ' ||
      COALESCE(replace(replace(p.email::text, '@', ' '), '.', ' '), '') || ' ' ||
      CASE WHEN p.phone IS NOT NULL
           THEN phone_search_tokens(p.phone)
           ELSE '' END)
    ELSE to_tsvector('english', COALESCE(u.display_name, ''))
  END AS civic_os_text_search
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id;

ALTER VIEW public.civic_os_users SET (security_invoker = true);

GRANT SELECT ON public.civic_os_users TO web_anon, authenticated;


-- 3a. Recreate payment_transactions VIEW (dropped by CASCADE)
-- Verbatim from v0-57-0-add-i18n.sql

CREATE VIEW public.payment_transactions AS
SELECT
    t.id,
    t.user_id,
    u.display_name AS user_display_name,
    u.full_name AS user_full_name,
    u.email AS user_email,
    t.amount,
    t.processing_fee,
    t.total_amount,
    t.max_refundable,
    t.fee_percent,
    t.fee_flat_cents,
    t.fee_refundable,
    t.currency,
    t.status,
    t.provider_payment_id,
    COALESCE(r_agg.total_refunded, 0) AS total_refunded,
    COALESCE(r_agg.refund_count, 0) AS refund_count,
    COALESCE(r_agg.pending_count, 0) AS pending_refund_count,
    CASE
        WHEN r_agg.total_refunded >= t.max_refundable THEN 'refunded'
        WHEN r_agg.total_refunded > 0 THEN 'partially_refunded'
        WHEN r_agg.pending_count > 0 THEN 'refund_pending'
        ELSE COALESCE(t.status, 'unpaid')
    END AS effective_status,
    t.error_message,
    t.provider,
    t.provider_client_secret,
    t.description,
    t.display_name,
    t.created_at,
    t.updated_at,
    t.entity_type,
    t.entity_id,
    COALESCE(e.display_name, t.entity_type) AS entity_display_name
FROM payments.transactions t
LEFT JOIN public.civic_os_users u ON t.user_id = u.id
LEFT JOIN metadata.entities e ON t.entity_type = e.table_name
LEFT JOIN LATERAL (
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0) AS total_refunded,
        COUNT(*) FILTER (WHERE status = 'succeeded') AS refund_count,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
    FROM payments.refunds
    WHERE transaction_id = t.id
) r_agg ON true;

GRANT SELECT ON public.payment_transactions TO authenticated, web_anon;


-- 3b. Recreate payment_refunds VIEW (dropped by CASCADE)
-- Verbatim from v0-57-0-add-i18n.sql

CREATE VIEW public.payment_refunds AS
SELECT
    r.id,
    r.transaction_id,
    r.amount,
    r.reason,
    r.initiated_by,
    u.display_name AS initiated_by_name,
    r.provider_refund_id,
    r.status,
    r.error_message,
    r.created_at,
    r.processed_at,
    t.amount AS payment_amount,
    t.description AS payment_description,
    t.provider_payment_id
FROM payments.refunds r
LEFT JOIN public.civic_os_users u ON r.initiated_by = u.id
LEFT JOIN payments.transactions t ON r.transaction_id = t.id;

GRANT SELECT ON public.payment_refunds TO authenticated;


-- 3c. Recreate managed_users VIEW (dropped because it references CUP.phone)
-- Verbatim from v0-52-0-add-last-login-tracking.sql

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
    np_sms.sms_opted_out,
    p.last_login_at
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
    NULL::BOOLEAN AS sms_opted_out,
    NULL::TIMESTAMPTZ AS last_login_at
FROM metadata.user_provisioning up
WHERE up.status NOT IN ('completed');

GRANT SELECT ON public.managed_users TO authenticated;


-- ============================================================================
-- 4. UPDATE refresh_current_user() — REMOVE PHONE SYNC FROM JWT
-- ============================================================================
-- Phone is no longer synced from JWT. The database (profile page, admin UI)
-- is the authority for phone. Keycloak doesn't include phone scope by default,
-- so JWT phone_number is always NULL — previously wiping user-entered phones.

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

  -- Upsert user record
  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = NOW();

  -- Upsert private user record (includes first_name/last_name and last_login_at)
  -- NOTE: phone is intentionally excluded — database is the authority for phone,
  -- not JWT claims. Phone is managed via profile page and admin UI.
  INSERT INTO metadata.civic_os_users_private (id, display_name, email, first_name, last_name, last_login_at, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_first_name, v_last_name, NOW(), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        last_login_at = NOW(),
        updated_at = NOW();

  -- FIX: Use get_real_user_roles() to ignore impersonation header
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
    IF v_role_id IS NULL THEN
      INSERT INTO metadata.roles (display_name, role_key)
      VALUES (v_role_name, v_role_name)
      RETURNING id INTO v_role_id;

      RAISE NOTICE 'Auto-created role "%" from JWT', v_role_name;
    END IF;

    v_filtered_roles := array_append(v_filtered_roles, v_role_name);
  END LOOP;

  -- Phase 2: Delete roles no longer in JWT (triggers fire revoke jobs)
  DELETE FROM metadata.user_roles
  WHERE user_id = v_user_id
    AND role_id NOT IN (
      SELECT id FROM metadata.roles WHERE role_key = ANY(v_filtered_roles)
    );

  -- Phase 3: Insert new roles from JWT (triggers fire assign jobs)
  INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
  SELECT v_user_id, r.id, NOW()
  FROM metadata.roles r
  WHERE r.role_key = ANY(v_filtered_roles)
    AND NOT EXISTS (
      SELECT 1 FROM metadata.user_roles ur
      WHERE ur.user_id = v_user_id AND ur.role_id = r.id
    );

  -- Phase 4: Touch synced_at on unchanged roles (no trigger fires)
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
     first_name, last_name, last_login_at, and roles. Phone is NOT synced from JWT —
     database is the authority for phone (managed via profile page and admin UI).
     Uses OIDC given_name/family_name claims with fallback to last-space split.
     Uses diff-based role sync. Skips Keycloak system roles. Uses role_key for lookups.
     v0.65.0: deprecated JWT phone sync.';


-- ============================================================================
-- 5. UPDATE update_own_profile() — ADD PHONE SANITIZATION + REMOVE PHONE FROM KC SYNC
-- ============================================================================
-- Phone sanitization for database storage; phone excluded from Keycloak sync args.

CREATE OR REPLACE FUNCTION public.update_own_profile(
  p_first_name TEXT,
  p_last_name TEXT,
  p_phone TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_user_id UUID;
  v_full_name TEXT;
  v_public_display TEXT;
  v_phone TEXT;
  v_email TEXT;
BEGIN
  -- Get current user ID from JWT
  v_user_id := public.current_user_id();
  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Validate required fields
  IF TRIM(COALESCE(p_first_name, '')) = '' OR TRIM(COALESCE(p_last_name, '')) = '' THEN
    RETURN json_build_object('success', false, 'error', 'First name and last name are required');
  END IF;

  -- Sanitize phone input
  IF TRIM(COALESCE(p_phone, '')) = '' THEN
    v_phone := NULL;
  ELSE
    v_phone := regexp_replace(p_phone, '[^0-9]', '', 'g');
    IF length(v_phone) = 11 AND v_phone LIKE '1%' THEN
      v_phone := substring(v_phone FROM 2);
    END IF;
    IF v_phone !~ '^\d{10}$' THEN
      RETURN json_build_object('success', false, 'error', 'Phone must be a valid 10-digit US number');
    END IF;
  END IF;

  -- Build full name and public display name
  v_full_name := TRIM(p_first_name) || ' ' || TRIM(p_last_name);
  v_public_display := public.format_public_display_name(v_full_name);

  -- Update civic_os_users (public profile)
  UPDATE metadata.civic_os_users
  SET display_name = v_public_display,
      updated_at = NOW()
  WHERE id = v_user_id;

  -- Update civic_os_users_private (private profile)
  UPDATE metadata.civic_os_users_private
  SET display_name = v_full_name,
      first_name = TRIM(p_first_name),
      last_name = TRIM(p_last_name),
      phone = v_phone,
      updated_at = NOW()
  WHERE id = v_user_id;

  -- Fetch current email for Keycloak sync (v0.47.1 pattern: Keycloak PUT
  -- treats missing fields as null, so email must be included in args)
  SELECT email INTO v_email
  FROM metadata.civic_os_users_private
  WHERE id = v_user_id;

  -- Enqueue River job for async Keycloak sync (phone excluded — database is authority)
  INSERT INTO metadata.river_job (args, kind, queue, state, priority, max_attempts)
  VALUES (
    json_build_object(
      'user_id', v_user_id::TEXT,
      'email', COALESCE(v_email::TEXT, ''),
      'first_name', TRIM(p_first_name),
      'last_name', TRIM(p_last_name)
    )::JSONB,
    'update_keycloak_user',
    'user_provisioning',
    'available',
    1,
    5
  );

  RETURN json_build_object('success', true, 'message', 'Profile updated');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.update_own_profile(TEXT, TEXT, TEXT) IS
    'Self-service profile update. Updates name/phone for the current user.
     Phone is sanitized to 10-digit format; invalid phones return an error.
     Enqueues Keycloak sync (name/email only — phone excluded, database is authority).
     No permission check — JWT identity only. Added in v0.65.0.';


-- ============================================================================
-- 6. UPDATE update_user_info() — ADD PHONE SANITIZATION + REMOVE PHONE FROM KC SYNC
-- ============================================================================
-- Phone sanitization for database storage; phone excluded from Keycloak sync args.

CREATE OR REPLACE FUNCTION public.update_user_info(
  p_user_id UUID,
  p_first_name TEXT,
  p_last_name TEXT,
  p_phone TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_full_name TEXT;
  v_public_display TEXT;
  v_phone TEXT;
  v_email TEXT;
BEGIN
  -- Permission check: must have civic_os_users_private:update permission
  IF NOT public.has_permission('civic_os_users_private', 'update') THEN
    RETURN json_build_object('success', false, 'error', 'Permission denied');
  END IF;

  -- Validate required fields
  IF TRIM(COALESCE(p_first_name, '')) = '' OR TRIM(COALESCE(p_last_name, '')) = '' THEN
    RETURN json_build_object('success', false, 'error', 'First name and last name are required');
  END IF;

  -- Verify user exists
  IF NOT EXISTS (SELECT 1 FROM metadata.civic_os_users WHERE id = p_user_id) THEN
    RETURN json_build_object('success', false, 'error', 'User not found');
  END IF;

  -- Sanitize phone input
  IF TRIM(COALESCE(p_phone, '')) = '' THEN
    v_phone := NULL;
  ELSE
    v_phone := regexp_replace(p_phone, '[^0-9]', '', 'g');
    IF length(v_phone) = 11 AND v_phone LIKE '1%' THEN
      v_phone := substring(v_phone FROM 2);
    END IF;
    IF v_phone !~ '^\d{10}$' THEN
      RETURN json_build_object('success', false, 'error', 'Phone must be a valid 10-digit US number');
    END IF;
  END IF;

  -- Build full name and public display name
  v_full_name := TRIM(p_first_name) || ' ' || TRIM(p_last_name);
  v_public_display := public.format_public_display_name(v_full_name);

  -- Update civic_os_users (public profile)
  UPDATE metadata.civic_os_users
  SET display_name = v_public_display,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Update civic_os_users_private (private profile)
  UPDATE metadata.civic_os_users_private
  SET display_name = v_full_name,
      first_name = TRIM(p_first_name),
      last_name = TRIM(p_last_name),
      phone = v_phone,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Fetch current email for Keycloak sync (v0.47.1 pattern: Keycloak PUT
  -- treats missing fields as null, so email must be included in args)
  SELECT email INTO v_email
  FROM metadata.civic_os_users_private
  WHERE id = p_user_id;

  -- Enqueue River job for async Keycloak sync (phone excluded — database is authority)
  INSERT INTO metadata.river_job (args, kind, queue, state, priority, max_attempts)
  VALUES (
    json_build_object(
      'user_id', p_user_id::TEXT,
      'email', COALESCE(v_email::TEXT, ''),
      'first_name', TRIM(p_first_name),
      'last_name', TRIM(p_last_name)
    )::JSONB,
    'update_keycloak_user',
    'user_provisioning',
    'available',
    1,
    5
  );

  RETURN json_build_object('success', true, 'message', 'User info updated');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.update_user_info(UUID, TEXT, TEXT, TEXT) IS
    'Update user profile info (name, phone) and enqueue Keycloak sync (name/email only).
     Phone is sanitized to 10-digit format; invalid phones return an error.
     Phone excluded from Keycloak sync — database is authority.
     Requires civic_os_users_private:update permission.
     Added in v0.31.0, phone sanitization added in v0.65.0.';


-- ============================================================================
-- 7. FIX NOTIFICATION PREFERENCES TRIGGER
-- ============================================================================
-- The v0-37-0 trigger used ON CONFLICT DO NOTHING for SMS, so changing phone
-- didn't update notification_preferences.phone_number. Fix:
--   a) SMS: DO UPDATE SET phone_number (preserves user's enabled toggle)
--   b) Handle phone cleared to NULL: disable SMS and clear phone_number
--   c) Email: DO UPDATE SET email_address (sync email changes too)
--   d) Expand trigger to fire on email changes

-- Drop existing trigger first (already dropped in section 2, but safe to re-drop)
DROP TRIGGER IF EXISTS create_default_notification_preferences_trigger
    ON metadata.civic_os_users_private;

CREATE OR REPLACE FUNCTION create_default_notification_preferences()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_formatted_phone TEXT;
BEGIN
    -- Create/update email preference
    INSERT INTO metadata.notification_preferences (user_id, channel, enabled, email_address)
    VALUES (NEW.id, 'email', TRUE, NEW.email)
    ON CONFLICT (user_id, channel) DO UPDATE
      SET email_address = EXCLUDED.email_address;

    -- Handle SMS preference based on phone state
    IF NEW.phone IS NOT NULL THEN
        -- Remove all non-digit characters
        v_formatted_phone := regexp_replace(NEW.phone::TEXT, '[^0-9]', '', 'g');

        -- Only create/update preference if result is exactly 10 digits
        IF length(v_formatted_phone) = 10 THEN
            INSERT INTO metadata.notification_preferences (user_id, channel, enabled, phone_number)
            VALUES (NEW.id, 'sms', FALSE, v_formatted_phone)
            ON CONFLICT (user_id, channel) DO UPDATE
              SET phone_number = EXCLUDED.phone_number;
        END IF;
    ELSE
        -- Phone cleared to NULL: disable SMS and clear phone_number
        UPDATE metadata.notification_preferences
        SET phone_number = NULL, enabled = FALSE
        WHERE user_id = NEW.id AND channel = 'sms';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION create_default_notification_preferences() IS
    'Trigger function: Creates/updates notification preferences on user insert or when
     phone/email changes. SMS phone_number syncs on change; cleared phone disables SMS.
     Email address syncs on change. v0.65.0: replaced DO NOTHING with DO UPDATE.';

-- Recreate trigger: fire on INSERT, phone change, AND email change
CREATE TRIGGER create_default_notification_preferences_trigger
    AFTER INSERT OR UPDATE OF phone, email ON metadata.civic_os_users_private
    FOR EACH ROW
    EXECUTE FUNCTION create_default_notification_preferences();


-- ============================================================================
-- 8. ADD i18n TRANSLATION FOR PHONE VALIDATION
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.phone_invalid', 'en', 'Phone must be exactly 10 digits'),
('ui', 'profile.phone_invalid', 'es', 'El teléfono debe tener exactamente 10 dígitos'),
('ui', 'profile.phone_invalid', 'ar', 'يجب أن يكون رقم الهاتف 10 أرقام بالضبط'),
('ui', 'profile.phone_invalid', 'ps', 'تلیفون باید دقیقاً ۱۰ عدده وي'),
('ui', 'profile.phone_invalid', 'fr', 'Le téléphone doit comporter exactement 10 chiffres'),
('ui', 'profile.phone_invalid', 'de', 'Die Telefonnummer muss genau 10 Ziffern haben')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;


-- ============================================================================
-- 9. FIX get_user_profile_extensions() CROSS-SCHEMA FK LOOKUP
-- ============================================================================
-- The v0.65.0 RPCs used tc.table_schema = ccu.table_schema in the JOIN to
-- constraint_column_usage. This fails when the extension table (public) has
-- a FK to civic_os_users which lives in metadata schema. Fix: use
-- constraint_schema instead of table_schema for the CCU join.

CREATE OR REPLACE FUNCTION public.get_user_profile_extensions()
RETURNS TABLE(
  table_name NAME,
  sort_order INT,
  is_required BOOLEAN,
  display_name TEXT,
  description TEXT,
  user_fk_column NAME,
  has_record BOOLEAN
)
SECURITY DEFINER
SET search_path = public, metadata
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id UUID;
  v_ext RECORD;
  v_fk_col NAME;
  v_has BOOLEAN;
BEGIN
  v_user_id := public.current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;  -- Return empty for unauthenticated users
  END IF;

  FOR v_ext IN
    SELECT e.table_name AS tbl, e.sort_order, e.is_required,
           COALESCE(e.display_name, ent.display_name, e.table_name::TEXT) AS disp_name,
           e.description, e.user_fk_column AS cfg_fk_col
    FROM metadata.user_profile_extensions e
    LEFT JOIN metadata.entities ent ON ent.table_name = e.table_name
    ORDER BY e.sort_order, e.table_name
  LOOP
    -- Use explicit FK column if configured, otherwise auto-discover
    IF v_ext.cfg_fk_col IS NOT NULL THEN
      v_fk_col := v_ext.cfg_fk_col;
    ELSE
      -- Discover FK column: find column in the extension table that references civic_os_users
      -- Excludes created_by (audit column). Uses constraint_schema for cross-schema FKs.
      SELECT kcu.column_name INTO v_fk_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.constraint_schema = ccu.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = v_ext.tbl::TEXT
        AND ccu.table_name = 'civic_os_users'
        AND kcu.column_name != 'created_by'
      LIMIT 1;
    END IF;

    -- If no FK found, skip this extension
    IF v_fk_col IS NULL THEN
      CONTINUE;
    END IF;

    -- Check if the current user has a record in this extension table
    EXECUTE format(
      'SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I = $1)',
      v_ext.tbl, v_fk_col
    ) INTO v_has USING v_user_id;

    table_name := v_ext.tbl;
    sort_order := v_ext.sort_order;
    is_required := v_ext.is_required;
    display_name := v_ext.disp_name;
    description := v_ext.description;
    user_fk_column := v_fk_col;
    has_record := v_has;
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.get_user_profile_extensions() IS
    'Self-service: returns profile extensions with completion status for the current user.
     v0.65.0: fixed cross-schema FK lookup, added user_fk_column override, excludes created_by.';


CREATE OR REPLACE FUNCTION public.get_user_profile_extensions_admin(p_user_id UUID)
RETURNS TABLE(
  table_name NAME,
  sort_order INT,
  is_required BOOLEAN,
  display_name TEXT,
  description TEXT,
  user_fk_column NAME,
  has_record BOOLEAN
)
SECURITY DEFINER
SET search_path = public, metadata
LANGUAGE plpgsql
AS $$
DECLARE
  v_ext RECORD;
  v_fk_col NAME;
  v_has BOOLEAN;
BEGIN
  -- Permission check: must have civic_os_users_private:update permission
  IF NOT public.has_permission('civic_os_users_private', 'update') THEN
    RAISE EXCEPTION 'Permission denied: requires civic_os_users_private:update';
  END IF;

  FOR v_ext IN
    SELECT e.table_name AS tbl, e.sort_order, e.is_required,
           COALESCE(e.display_name, ent.display_name, e.table_name::TEXT) AS disp_name,
           e.description, e.user_fk_column AS cfg_fk_col
    FROM metadata.user_profile_extensions e
    LEFT JOIN metadata.entities ent ON ent.table_name = e.table_name
    ORDER BY e.sort_order, e.table_name
  LOOP
    -- Use explicit FK column if configured, otherwise auto-discover
    IF v_ext.cfg_fk_col IS NOT NULL THEN
      v_fk_col := v_ext.cfg_fk_col;
    ELSE
      SELECT kcu.column_name INTO v_fk_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.constraint_schema = ccu.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = v_ext.tbl::TEXT
        AND ccu.table_name = 'civic_os_users'
        AND kcu.column_name != 'created_by'
      LIMIT 1;
    END IF;

    IF v_fk_col IS NULL THEN
      CONTINUE;
    END IF;

    -- Check if the target user has a record
    EXECUTE format(
      'SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I = $1)',
      v_ext.tbl, v_fk_col
    ) INTO v_has USING p_user_id;

    table_name := v_ext.tbl;
    sort_order := v_ext.sort_order;
    is_required := v_ext.is_required;
    display_name := v_ext.disp_name;
    description := v_ext.description;
    user_fk_column := v_fk_col;
    has_record := v_has;
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.get_user_profile_extensions_admin(UUID) IS
    'Admin: returns profile extensions with completion status for a specific user.
     Requires civic_os_users_private:update permission.
     v0.65.0: fixed cross-schema FK lookup, added user_fk_column override, excludes created_by.';


-- ============================================================================
-- 10. SCHEMA DECISION — DEPRECATE JWT PHONE SYNC
-- ============================================================================

INSERT INTO metadata.schema_decisions (title, decision, entity_types, migration_id, status)
VALUES (
    'Deprecate phone sync from Keycloak JWT',
    'refresh_current_user() no longer writes phone from JWT phone_number claim. ' ||
    'The Keycloak client does not include the phone scope, so JWT phone_number was always ' ||
    'NULL — wiping any phone set via the profile page or admin UI on every page load. ' ||
    'The database is now the sole authority for phone numbers, managed via the self-service ' ||
    'profile page (v0.65.0) and admin User Management. Keycloak does not need phone for ' ||
    'authentication (Civic OS has its own SMS system via the consolidated worker). ' ||
    'The notification_preferences trigger was also fixed to DO UPDATE instead of DO NOTHING ' ||
    'so phone changes propagate to SMS preference rows.',
    ARRAY['civic_os_users_private']::NAME[],
    'v0-65-0-cup-phone-domain',
    'accepted'
);


NOTIFY pgrst, 'reload schema';

COMMIT;
