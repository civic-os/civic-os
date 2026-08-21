-- Revert civic_os:v0-35-0-add-sms-opted-out from pg

BEGIN;

-- Drop public VIEW that depends on the column we're about to remove
DROP VIEW IF EXISTS public.notification_preferences;

ALTER TABLE metadata.notification_preferences
    DROP COLUMN IF EXISTS sms_opted_out;

-- Recreate public VIEW without the removed column
CREATE OR REPLACE VIEW public.notification_preferences AS
    SELECT * FROM metadata.notification_preferences;

-- Restore original comment on phone_number column
COMMENT ON COLUMN metadata.notification_preferences.phone_number IS
    'Phone number for SMS notifications';

COMMIT;
