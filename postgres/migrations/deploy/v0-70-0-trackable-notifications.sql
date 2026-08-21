-- Deploy civic_os:v0-70-0-trackable-notifications to pg
-- requires: v0-70-0-add-markdown-domain

BEGIN;

-- =============================================================================
-- 1. New table: notification_tracking_tokens
--    One row per recipient per bulk email sent. Join point between "what was
--    sent" and "what happened after."
-- =============================================================================

CREATE TABLE metadata.notification_tracking_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_email TEXT NOT NULL,
    template_name VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100),
    entity_id VARCHAR(100),
    entity_data_snapshot JSONB,
    unsubscribed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ntt_recipient ON metadata.notification_tracking_tokens(recipient_email);
CREATE INDEX idx_ntt_entity ON metadata.notification_tracking_tokens(entity_type, entity_id);
CREATE INDEX idx_ntt_template ON metadata.notification_tracking_tokens(template_name);
CREATE INDEX idx_ntt_created ON metadata.notification_tracking_tokens(created_at DESC);

-- =============================================================================
-- 2. New table: notification_events
--    Event-sourced engagement log (open, click, unsubscribe, bounce).
-- =============================================================================

CREATE TABLE metadata.notification_events (
    id BIGSERIAL PRIMARY KEY,
    tracking_token UUID NOT NULL
        REFERENCES metadata.notification_tracking_tokens(id) ON DELETE CASCADE,
    event_type VARCHAR(20) NOT NULL
        CHECK (event_type IN ('open', 'click', 'unsubscribe', 'bounce')),
    event_data JSONB DEFAULT '{}',
    ip_address TEXT,
    user_agent TEXT,
    suspected_bot BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ne_token ON metadata.notification_events(tracking_token);
CREATE INDEX idx_ne_type ON metadata.notification_events(event_type);
CREATE INDEX idx_ne_created ON metadata.notification_events(created_at DESC);

-- =============================================================================
-- 3. New table: notification_settings
--    Singleton config for instance-level bulk email settings.
-- =============================================================================

CREATE TABLE metadata.notification_settings (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    organization_address TEXT,
    unsubscribe_reason_text TEXT
        DEFAULT 'You received this email based on your registration.',
    tracking_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the singleton row so deployers can UPDATE instead of INSERT
INSERT INTO metadata.notification_settings (id) VALUES (1);

-- =============================================================================
-- 4. Alter notification_templates: add is_bulk flag
-- =============================================================================

ALTER TABLE metadata.notification_templates
    ADD COLUMN is_bulk BOOLEAN NOT NULL DEFAULT FALSE;

-- Recreate public VIEWs to pick up the new column (SELECT * is captured at
-- creation time in PostgreSQL, so ALTER TABLE ADD COLUMN alone won't surface
-- the column through an existing VIEW).
CREATE OR REPLACE VIEW public.notification_templates AS
    SELECT * FROM metadata.notification_templates;

-- =============================================================================
-- 5. Alter notification_preferences: add bulk unsubscribe tracking
-- =============================================================================

ALTER TABLE metadata.notification_preferences
    ADD COLUMN bulk_email_unsubscribed_templates TEXT[] DEFAULT '{}';

CREATE OR REPLACE VIEW public.notification_preferences AS
    SELECT * FROM metadata.notification_preferences;

-- =============================================================================
-- 6. Grants
-- =============================================================================

-- Tracking tokens: workers INSERT, users can SELECT their own
GRANT SELECT, INSERT, UPDATE ON metadata.notification_tracking_tokens TO authenticated;
GRANT SELECT, INSERT ON metadata.notification_tracking_tokens TO web_anon;

-- Events: workers INSERT, users can SELECT
GRANT SELECT, INSERT ON metadata.notification_events TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.notification_events_id_seq TO authenticated;

-- Settings: authenticated can read, postgres (admin) can write
GRANT SELECT ON metadata.notification_settings TO authenticated;

-- Public VIEWs for PostgREST exposure
CREATE VIEW public.notification_tracking_tokens AS
    SELECT * FROM metadata.notification_tracking_tokens;
GRANT SELECT ON public.notification_tracking_tokens TO authenticated;

CREATE VIEW public.notification_events AS
    SELECT * FROM metadata.notification_events;
GRANT SELECT ON public.notification_events TO authenticated;

CREATE VIEW public.notification_settings AS
    SELECT * FROM metadata.notification_settings;
GRANT SELECT ON public.notification_settings TO authenticated;

-- =============================================================================
-- 7. Aggregation VIEW: notification_tracking_stats
-- =============================================================================

CREATE VIEW metadata.notification_tracking_stats
WITH (security_invoker = true) AS
SELECT
    ntt.entity_type,
    ntt.entity_id,
    ntt.template_name,
    COUNT(DISTINCT ntt.id) AS total_sent,
    -- Raw metrics (all events including bots)
    COUNT(DISTINCT CASE WHEN ne.event_type = 'open' THEN ntt.id END) AS unique_opens,
    COUNT(CASE WHEN ne.event_type = 'open' THEN 1 END) AS total_opens,
    COUNT(DISTINCT CASE WHEN ne.event_type = 'click' THEN ntt.id END) AS unique_clicks,
    COUNT(CASE WHEN ne.event_type = 'click' THEN 1 END) AS total_clicks,
    COUNT(CASE WHEN ne.event_type = 'unsubscribe' THEN 1 END) AS unsubscribes,
    COUNT(CASE WHEN ne.event_type = 'bounce' THEN 1 END) AS bounces,
    ROUND(
        COUNT(DISTINCT CASE WHEN ne.event_type = 'open' THEN ntt.id END)::numeric /
        NULLIF(COUNT(DISTINCT ntt.id), 0) * 100, 1
    ) AS open_rate_pct,
    ROUND(
        COUNT(DISTINCT CASE WHEN ne.event_type = 'click' THEN ntt.id END)::numeric /
        NULLIF(COUNT(DISTINCT ntt.id), 0) * 100, 1
    ) AS click_rate_pct,
    -- Bot-filtered metrics
    COUNT(DISTINCT CASE WHEN ne.event_type = 'open' AND ne.suspected_bot = FALSE THEN ntt.id END) AS human_unique_opens,
    ROUND(
        COUNT(DISTINCT CASE WHEN ne.event_type = 'open' AND ne.suspected_bot = FALSE THEN ntt.id END)::numeric /
        NULLIF(COUNT(DISTINCT ntt.id), 0) * 100, 1
    ) AS human_open_rate_pct
FROM metadata.notification_tracking_tokens ntt
LEFT JOIN metadata.notification_events ne ON ntt.id = ne.tracking_token
GROUP BY ntt.entity_type, ntt.entity_id, ntt.template_name;

GRANT SELECT ON metadata.notification_tracking_stats TO authenticated;

CREATE VIEW public.notification_tracking_stats AS
    SELECT * FROM metadata.notification_tracking_stats;
GRANT SELECT ON public.notification_tracking_stats TO authenticated;

-- =============================================================================
-- 8. RPC: get_user_bulk_subscriptions
--    Returns template names a user has received bulk emails for, with
--    unsubscribe status, for the profile page.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_user_bulk_subscriptions()
RETURNS TABLE (
    template_name VARCHAR(100),
    template_description TEXT,
    unsubscribed BOOLEAN,
    last_sent_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        ntt.template_name,
        COALESCE(nt.description, ntt.template_name),
        -- User is unsubscribed if ANY token for this template is marked unsubscribed
        BOOL_OR(ntt.unsubscribed),
        MAX(ntt.created_at)
    FROM metadata.notification_tracking_tokens ntt
    JOIN metadata.civic_os_users_private cup ON cup.email = ntt.recipient_email
    LEFT JOIN metadata.notification_templates nt ON nt.name = ntt.template_name AND nt.is_bulk = TRUE
    WHERE cup.id = current_user_id()
      AND nt.is_bulk = TRUE
    GROUP BY ntt.template_name, nt.description
    ORDER BY MAX(ntt.created_at) DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_bulk_subscriptions() TO authenticated;

-- =============================================================================
-- 9. RPC: set_bulk_email_unsubscribe
--    Toggles unsubscribe for a specific bulk template for the current user.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_bulk_email_unsubscribe(
    p_template_name TEXT,
    p_unsubscribed BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_email TEXT;
BEGIN
    -- Get the current user's email from the private table
    SELECT email INTO v_email
    FROM metadata.civic_os_users_private
    WHERE id = current_user_id();

    IF v_email IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;

    -- Update all tracking tokens for this template/email combo
    UPDATE metadata.notification_tracking_tokens
    SET unsubscribed = p_unsubscribed
    WHERE recipient_email = v_email
      AND template_name = p_template_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_bulk_email_unsubscribe(TEXT, BOOLEAN) TO authenticated;

-- =============================================================================
-- 10. RPC: admin_get_user_bulk_subscriptions
--     Admin version that takes a user_id parameter.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_get_user_bulk_subscriptions(p_user_id UUID)
RETURNS TABLE (
    template_name VARCHAR(100),
    template_description TEXT,
    unsubscribed BOOLEAN,
    last_sent_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        ntt.template_name,
        COALESCE(nt.description, ntt.template_name),
        BOOL_OR(ntt.unsubscribed),
        MAX(ntt.created_at)
    FROM metadata.notification_tracking_tokens ntt
    JOIN metadata.civic_os_users_private cup ON cup.email = ntt.recipient_email
    LEFT JOIN metadata.notification_templates nt ON nt.name = ntt.template_name AND nt.is_bulk = TRUE
    WHERE cup.id = p_user_id
      AND nt.is_bulk = TRUE
    GROUP BY ntt.template_name, nt.description
    ORDER BY MAX(ntt.created_at) DESC;
$$;

GRANT EXECUTE ON FUNCTION public.admin_get_user_bulk_subscriptions(UUID) TO authenticated;

-- =============================================================================
-- 11. RPC: admin_set_bulk_email_unsubscribe
--     Admin version that takes a user_id and template name.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_set_bulk_email_unsubscribe(
    p_user_id UUID,
    p_template_name TEXT,
    p_unsubscribed BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_email TEXT;
BEGIN
    -- Only admins can manage other users' subscriptions
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'Permission denied: admin role required';
    END IF;

    SELECT email INTO v_email
    FROM metadata.civic_os_users_private
    WHERE id = p_user_id;

    IF v_email IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;

    UPDATE metadata.notification_tracking_tokens
    SET unsubscribed = p_unsubscribed
    WHERE recipient_email = v_email
      AND template_name = p_template_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_bulk_email_unsubscribe(UUID, TEXT, BOOLEAN) TO authenticated;

COMMIT;
