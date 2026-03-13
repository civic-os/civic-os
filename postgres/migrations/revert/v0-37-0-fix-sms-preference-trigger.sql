-- Revert civic_os:v0-37-0-fix-sms-preference-trigger
-- Restore INSERT-only trigger (original v0-11-0 behavior)

BEGIN;

DROP TRIGGER IF EXISTS create_default_notification_preferences_trigger
    ON metadata.civic_os_users_private;

CREATE TRIGGER create_default_notification_preferences_trigger
    AFTER INSERT ON metadata.civic_os_users_private
    FOR EACH ROW
    EXECUTE FUNCTION create_default_notification_preferences();

COMMENT ON FUNCTION create_default_notification_preferences() IS
    'Trigger function: Creates default email notification preference when user is created.';

-- Note: backfilled SMS preference rows are NOT removed on revert.
-- They are harmless and removing them could delete user-modified preferences.

COMMIT;
