-- Deploy v0-59-0-send-email-rpc
-- Requires: v0-58-0-metadata-translations

BEGIN;

-- ============================================================================
-- metadata.send_email() — Flexible multi-recipient email via River queue
--
-- Enqueues a River job that sends a single SMTP email with proper TO/CC
-- headers to any email addresses. Does NOT require a civic_os_users row.
--
-- This is an internal-only function:
--   - Lives in metadata schema (NOT exposed via PostgREST)
--   - No GRANTs to authenticated/web_anon
--   - Callable from triggers, RPCs, SECURITY DEFINER functions
--
-- Reuses existing notification_templates for rendering.
--
-- Example (inside a trigger or RPC):
--   PERFORM metadata.send_email(
--     p_to_addresses  := ARRAY['applicant@gmail.com', 'co-applicant@gmail.com'],
--     p_template_name := 'application_received',
--     p_cc_addresses  := ARRAY['manager@city.gov'],
--     p_entity_type   := 'building_use_applications',
--     p_entity_id     := NEW.id::text,
--     p_entity_data   := jsonb_build_object(
--       'applicant_name', NEW.applicant_name,
--       'address', NEW.address
--     ),
--     p_reply_to      := 'permits@city.gov'
--   );
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.send_email(
    p_to_addresses    TEXT[],
    p_template_name   VARCHAR,
    p_cc_addresses    TEXT[]    DEFAULT '{}',
    p_entity_type     VARCHAR   DEFAULT NULL,
    p_entity_id       VARCHAR   DEFAULT NULL,
    p_entity_data     JSONB     DEFAULT NULL,
    p_reply_to        TEXT      DEFAULT NULL
)
RETURNS void
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_addr TEXT;
BEGIN
    -- Validate: at least one TO address required
    IF p_to_addresses IS NULL OR array_length(p_to_addresses, 1) IS NULL THEN
        RAISE EXCEPTION 'send_email: p_to_addresses must contain at least one email address';
    END IF;

    -- Validate: template must exist
    IF NOT EXISTS (
        SELECT 1 FROM metadata.notification_templates WHERE name = p_template_name
    ) THEN
        RAISE EXCEPTION 'send_email: template "%" not found', p_template_name;
    END IF;

    -- Validate: basic email format for TO addresses
    FOREACH v_addr IN ARRAY p_to_addresses LOOP
        IF v_addr IS NULL OR position('@' IN v_addr) = 0 THEN
            RAISE EXCEPTION 'send_email: invalid email address in p_to_addresses: "%"', COALESCE(v_addr, 'NULL');
        END IF;
    END LOOP;

    -- Validate: basic email format for CC addresses (if any)
    IF p_cc_addresses IS NOT NULL AND array_length(p_cc_addresses, 1) IS NOT NULL THEN
        FOREACH v_addr IN ARRAY p_cc_addresses LOOP
            IF v_addr IS NULL OR position('@' IN v_addr) = 0 THEN
                RAISE EXCEPTION 'send_email: invalid email address in p_cc_addresses: "%"', COALESCE(v_addr, 'NULL');
            END IF;
        END LOOP;
    END IF;

    -- Validate: reply_to format (if provided)
    IF p_reply_to IS NOT NULL AND position('@' IN p_reply_to) = 0 THEN
        RAISE EXCEPTION 'send_email: invalid reply_to email address: "%"', p_reply_to;
    END IF;

    -- Enqueue River job
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'send_email',
        jsonb_build_object(
            'to',            to_jsonb(p_to_addresses),
            'cc',            to_jsonb(COALESCE(p_cc_addresses, '{}'::TEXT[])),
            'template_name', p_template_name,
            'entity_type',   p_entity_type,
            'entity_id',     p_entity_id,
            'entity_data',   COALESCE(p_entity_data, '{}'::jsonb),
            'reply_to',      COALESCE(p_reply_to, '')
        ),
        'notifications',  -- Same queue as send_notification
        2,                -- Priority 2 (slightly lower than system notifications at 1)
        5,                -- Max attempts
        NOW(),            -- Schedule immediately
        'available'       -- Job state
    );
END;
$$;

COMMENT ON FUNCTION metadata.send_email(TEXT[], VARCHAR, TEXT[], VARCHAR, VARCHAR, JSONB, TEXT) IS
  'Enqueue a multi-recipient email via River. Internal only — not exposed via PostgREST. Supports TO/CC arrays, template rendering, and optional reply-to override.';

-- ============================================================================
-- SCHEMA RELOAD
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
