-- Deploy civic_os:v0-37-0-fix-sms-preference-trigger
-- Fix: SMS notification preference row is only created on INSERT, not when
-- a phone number is added later via UPDATE (e.g., admin adds phone in User Management).
--
-- Changes:
--   1. Update trigger function to handle phone-added-on-update case
--   2. Change trigger from AFTER INSERT to AFTER INSERT OR UPDATE OF phone

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Update function: handle both INSERT and UPDATE
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_default_notification_preferences()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_formatted_phone TEXT;
BEGIN
    -- Create default email preference using email from civic_os_users_private
    INSERT INTO metadata.notification_preferences (user_id, channel, enabled, email_address)
    VALUES (NEW.id, 'email', TRUE, NEW.email)
    ON CONFLICT (user_id, channel) DO NOTHING;

    -- Create default SMS preference if phone number provided
    -- Strip non-numeric characters and validate 10-digit format
    IF NEW.phone IS NOT NULL THEN
        -- Remove all non-digit characters
        v_formatted_phone := regexp_replace(NEW.phone, '[^0-9]', '', 'g');

        -- Only create preference if result is exactly 10 digits
        IF length(v_formatted_phone) = 10 THEN
            INSERT INTO metadata.notification_preferences (user_id, channel, enabled, phone_number)
            VALUES (NEW.id, 'sms', FALSE, v_formatted_phone)
            ON CONFLICT (user_id, channel) DO NOTHING;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Replace trigger: INSERT → INSERT OR UPDATE OF phone
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS create_default_notification_preferences_trigger
    ON metadata.civic_os_users_private;

CREATE TRIGGER create_default_notification_preferences_trigger
    AFTER INSERT OR UPDATE OF phone ON metadata.civic_os_users_private
    FOR EACH ROW
    EXECUTE FUNCTION create_default_notification_preferences();

COMMENT ON FUNCTION create_default_notification_preferences() IS
    'Trigger function: Creates default notification preferences on user insert or when phone number is added/changed.';

-- ---------------------------------------------------------------------------
-- 3. Backfill: create SMS preference for existing users with phone numbers
--    who are missing an SMS preference row.
-- ---------------------------------------------------------------------------

INSERT INTO metadata.notification_preferences (user_id, channel, enabled, phone_number)
SELECT
    up.id,
    'sms',
    FALSE,
    regexp_replace(up.phone, '[^0-9]', '', 'g')
FROM metadata.civic_os_users_private up
WHERE up.phone IS NOT NULL
  AND length(regexp_replace(up.phone, '[^0-9]', '', 'g')) = 10
  AND NOT EXISTS (
    SELECT 1 FROM metadata.notification_preferences np
    WHERE np.user_id = up.id AND np.channel = 'sms'
  );

COMMIT;
