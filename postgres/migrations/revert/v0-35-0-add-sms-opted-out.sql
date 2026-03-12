-- Revert civic_os:v0-35-0-add-sms-opted-out from pg

BEGIN;

ALTER TABLE metadata.notification_preferences
    DROP COLUMN IF EXISTS sms_opted_out;

-- Restore original comment on phone_number column
COMMENT ON COLUMN metadata.notification_preferences.phone_number IS
    'Phone number for SMS notifications';

COMMIT;
