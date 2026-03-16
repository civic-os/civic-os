-- Revert civic_os:v0-38-4-fix-admin-notif-pref-permission
-- Restore the original :read permission check

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
    IF NOT public.has_permission('civic_os_users_private', 'read') THEN
        RAISE EXCEPTION 'Permission denied: civic_os_users_private:read required';
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
    'Get notification preferences for any user. Requires civic_os_users_private:read. Bypasses RLS.';

COMMIT;
