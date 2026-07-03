-- Revert civic_os:v0-65-0-cup-phone-domain

BEGIN;

-- Drop VIEW first (it depends on user_fk_column), then drop the column
DROP VIEW IF EXISTS public.user_profile_extensions;
ALTER TABLE metadata.user_profile_extensions DROP COLUMN IF EXISTS user_fk_column;

-- Recreate VIEW without user_fk_column
CREATE OR REPLACE VIEW public.user_profile_extensions AS
SELECT id, table_name, sort_order, is_required, display_name, description,
       created_at, updated_at
FROM metadata.user_profile_extensions;

GRANT SELECT ON public.user_profile_extensions TO web_anon, authenticated;

-- Drop dependents before reverting column type
DROP TRIGGER IF EXISTS create_default_notification_preferences_trigger
    ON metadata.civic_os_users_private;

DROP VIEW IF EXISTS public.civic_os_users CASCADE;
DROP VIEW IF EXISTS public.managed_users;

-- Revert column type back to VARCHAR(255)
ALTER TABLE metadata.civic_os_users_private
  ALTER COLUMN phone TYPE VARCHAR(255);

-- Recreate trigger
CREATE TRIGGER create_default_notification_preferences_trigger
    AFTER INSERT OR UPDATE OF phone ON metadata.civic_os_users_private
    FOR EACH ROW
    EXECUTE FUNCTION create_default_notification_preferences();

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
      CASE WHEN p.phone ~ '^\d{10}$'
           THEN phone_search_tokens(p.phone::phone_number)
           ELSE COALESCE(p.phone::text, '') END)
    ELSE to_tsvector('english', COALESCE(u.display_name, ''))
  END AS civic_os_text_search
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id;

ALTER VIEW public.civic_os_users SET (security_invoker = true);

GRANT SELECT ON public.civic_os_users TO web_anon, authenticated;

-- Recreate payment_transactions VIEW (dropped by CASCADE)
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

-- Recreate payment_refunds VIEW (dropped by CASCADE)
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

-- Recreate managed_users VIEW
CREATE VIEW public.managed_users
WITH (security_invoker = true) AS
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

-- Revert create_default_notification_preferences() to v0-37-0 version (DO NOTHING)
CREATE OR REPLACE FUNCTION create_default_notification_preferences()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_formatted_phone TEXT;
BEGIN
    INSERT INTO metadata.notification_preferences (user_id, channel, enabled, email_address)
    VALUES (NEW.id, 'email', TRUE, NEW.email)
    ON CONFLICT (user_id, channel) DO NOTHING;

    IF NEW.phone IS NOT NULL THEN
        v_formatted_phone := regexp_replace(NEW.phone, '[^0-9]', '', 'g');
        IF length(v_formatted_phone) = 10 THEN
            INSERT INTO metadata.notification_preferences (user_id, channel, enabled, phone_number)
            VALUES (NEW.id, 'sms', FALSE, v_formatted_phone)
            ON CONFLICT (user_id, channel) DO NOTHING;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- Revert refresh_current_user() to v0-52-0 version (no phone sanitization)
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

  v_first_name := public.current_user_first_name();
  v_last_name := public.current_user_last_name();

  IF v_first_name IS NULL THEN
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

  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = NOW();

  INSERT INTO metadata.civic_os_users_private (id, display_name, email, phone, first_name, last_name, last_login_at, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_phone, v_first_name, v_last_name, NOW(), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        last_login_at = NOW(),
        updated_at = NOW();

  v_user_roles := public.get_real_user_roles();

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

  DELETE FROM metadata.user_roles
  WHERE user_id = v_user_id
    AND role_id NOT IN (
      SELECT id FROM metadata.roles WHERE role_key = ANY(v_filtered_roles)
    );

  INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
  SELECT v_user_id, r.id, NOW()
  FROM metadata.roles r
  WHERE r.role_key = ANY(v_filtered_roles)
    AND NOT EXISTS (
      SELECT 1 FROM metadata.user_roles ur
      WHERE ur.user_id = v_user_id AND ur.role_id = r.id
    );

  UPDATE metadata.user_roles SET synced_at = NOW()
  WHERE user_id = v_user_id
    AND role_id IN (SELECT id FROM metadata.roles WHERE role_key = ANY(v_filtered_roles));

  SELECT * INTO v_result
  FROM metadata.civic_os_users
  WHERE id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Revert update_own_profile() to v0-65-0-user-profile-extensions version
-- (email in River args, phone excluded — matches the state after v0-65-0 deployed)
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
  v_email TEXT;
BEGIN
  v_user_id := public.current_user_id();
  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  IF TRIM(COALESCE(p_first_name, '')) = '' OR TRIM(COALESCE(p_last_name, '')) = '' THEN
    RETURN json_build_object('success', false, 'error', 'First name and last name are required');
  END IF;

  v_full_name := TRIM(p_first_name) || ' ' || TRIM(p_last_name);
  v_public_display := public.format_public_display_name(v_full_name);

  UPDATE metadata.civic_os_users
  SET display_name = v_public_display,
      updated_at = NOW()
  WHERE id = v_user_id;

  UPDATE metadata.civic_os_users_private
  SET display_name = v_full_name,
      first_name = TRIM(p_first_name),
      last_name = TRIM(p_last_name),
      phone = CASE WHEN TRIM(COALESCE(p_phone, '')) = '' THEN NULL ELSE TRIM(p_phone) END,
      updated_at = NOW()
  WHERE id = v_user_id;

  SELECT email INTO v_email
  FROM metadata.civic_os_users_private
  WHERE id = v_user_id;

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

-- Revert update_user_info() to v0-47-1 version (email in River args, no phone sanitization)
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
  v_email TEXT;
BEGIN
  IF NOT public.has_permission('civic_os_users_private', 'update') THEN
    RETURN json_build_object('success', false, 'error', 'Permission denied');
  END IF;

  IF TRIM(COALESCE(p_first_name, '')) = '' OR TRIM(COALESCE(p_last_name, '')) = '' THEN
    RETURN json_build_object('success', false, 'error', 'First name and last name are required');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM metadata.civic_os_users WHERE id = p_user_id) THEN
    RETURN json_build_object('success', false, 'error', 'User not found');
  END IF;

  v_full_name := TRIM(p_first_name) || ' ' || TRIM(p_last_name);
  v_public_display := public.format_public_display_name(v_full_name);

  SELECT email INTO v_email
  FROM metadata.civic_os_users_private
  WHERE id = p_user_id;

  UPDATE metadata.civic_os_users
  SET display_name = v_public_display,
      updated_at = NOW()
  WHERE id = p_user_id;

  UPDATE metadata.civic_os_users_private
  SET display_name = v_full_name,
      first_name = TRIM(p_first_name),
      last_name = TRIM(p_last_name),
      phone = CASE WHEN TRIM(COALESCE(p_phone, '')) = '' THEN NULL ELSE TRIM(p_phone) END,
      updated_at = NOW()
  WHERE id = p_user_id;

  INSERT INTO metadata.river_job (args, kind, queue, state, priority, max_attempts)
  VALUES (
    json_build_object(
      'user_id', p_user_id::TEXT,
      'email', COALESCE(v_email::TEXT, ''),
      'first_name', TRIM(p_first_name),
      'last_name', TRIM(p_last_name),
      'phone', CASE WHEN TRIM(COALESCE(p_phone, '')) = '' THEN '' ELSE TRIM(p_phone) END
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

NOTIFY pgrst, 'reload schema';

COMMIT;
