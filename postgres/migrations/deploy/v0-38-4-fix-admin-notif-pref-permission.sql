-- Deploy civic_os:v0-38-4-fix-admin-notif-pref-permission
-- requires: v0-38-0-add-static-assets
--
-- Fix: admin_get_user_notification_preferences used civic_os_users_private:read
-- which is granted to all authenticated users. It should use :update (admin-only)
-- to match the write RPC and frontend access gate.

BEGIN;

CREATE OR REPLACE FUNCTION admin_get_user_notification_preferences(p_user_id UUID)
RETURNS TABLE(
    channel TEXT,
    enabled BOOLEAN,
    email_address TEXT,
    phone_number TEXT,
    sms_opted_out BOOLEAN,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
BEGIN
    -- Permission check: civic_os_users_private:update (admin-only, matches write RPC)
    IF NOT public.has_permission('civic_os_users_private', 'update') THEN
        RAISE EXCEPTION 'Permission denied: civic_os_users_private:update required';
    END IF;

    RETURN QUERY
    SELECT
        np.channel::TEXT,
        np.enabled,
        np.email_address::TEXT,
        np.phone_number::TEXT,
        np.sms_opted_out,
        np.created_at,
        np.updated_at
    FROM metadata.notification_preferences np
    WHERE np.user_id = p_user_id
    ORDER BY np.channel;
END;
$$;

COMMENT ON FUNCTION admin_get_user_notification_preferences IS
    'Get notification preferences for any user. Requires civic_os_users_private:update (admin-only). Bypasses RLS.';

COMMIT;
