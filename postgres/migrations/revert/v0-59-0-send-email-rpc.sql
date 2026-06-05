-- Revert v0-59-0-send-email-rpc

BEGIN;

DROP FUNCTION IF EXISTS metadata.send_email(TEXT[], VARCHAR, TEXT[], VARCHAR, VARCHAR, JSONB, TEXT);

NOTIFY pgrst, 'reload schema';

COMMIT;
