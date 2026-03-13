-- Revert v0-36-0-notification-role-helpers

BEGIN;

DROP FUNCTION IF EXISTS metadata.send_notification_to_role(TEXT[], VARCHAR, VARCHAR, VARCHAR, JSONB, TEXT[]);
DROP FUNCTION IF EXISTS metadata.get_users_by_role(TEXT[]);

NOTIFY pgrst, 'reload schema';

COMMIT;
