-- Verify civic_os:v0-35-0-add-sms-opted-out on pg

SELECT sms_opted_out
FROM metadata.notification_preferences
LIMIT 0;
