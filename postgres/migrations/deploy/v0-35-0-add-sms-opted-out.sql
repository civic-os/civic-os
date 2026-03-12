-- Deploy civic_os:v0-35-0-add-sms-opted-out to pg
-- requires: v0-34-1-fix-recurring-series-worker

BEGIN;

-- ============================================================================
-- SMS OPT-OUT TRACKING (v0.35.0)
-- ============================================================================
-- Version: v0.35.0
-- Purpose: Track carrier-level SMS opt-outs separately from user preferences.
--
-- Background:
--   When a user texts STOP to a Telnyx number, the carrier blocks further
--   messages (TCPA compliance). This is different from the user toggling
--   their notification preference in settings:
--
--     enabled = false    → User's voluntary preference, reversible in settings
--     sms_opted_out = true → Carrier-level STOP block, reversed by texting START
--
--   The worker detects opted-out errors from Telnyx API responses and
--   passively syncs them back to this column. A future UI improvement can
--   show a warning when sms_opted_out = true so the user knows why SMS
--   is not being delivered even if they "enabled" it.
--
-- Changes:
--   1. Add sms_opted_out column to notification_preferences
--   2. Deprecate phone_number column (worker now reads from civic_os_users)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Add sms_opted_out column
-- ----------------------------------------------------------------------------
-- NOT NULL DEFAULT false is safe on PostgreSQL — no table rewrite required,
-- the default is stored in the catalog and returned for existing rows.

ALTER TABLE metadata.notification_preferences
    ADD COLUMN sms_opted_out BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN metadata.notification_preferences.sms_opted_out IS
    'Set to true when user texts STOP (carrier opt-out). Separate from enabled: '
    'enabled=false means user preference; sms_opted_out=true means carrier block. '
    'User must text START to their carrier to reverse this. '
    'Set automatically by the consolidated worker when Telnyx returns an opted_out error.';


-- ----------------------------------------------------------------------------
-- 2. Deprecate phone_number column
-- ----------------------------------------------------------------------------
-- The worker used to read phone_number from notification_preferences,
-- but civic_os_users (synced from Keycloak) is the canonical source.
-- This column is now deprecated and will be dropped in a future migration.

COMMENT ON COLUMN metadata.notification_preferences.phone_number IS
    'DEPRECATED (v0.35.0): Phone number for SMS. '
    'Worker now reads phone from civic_os_users (Keycloak-synced) instead. '
    'Do not write to this column. To be dropped in a future cleanup migration.';


COMMIT;
