# Trackable Notifications Design

> **Status**: Implemented
> **Version target**: v0.70.0
> **Author**: Claude + Daniel
> **Date**: 2026-08-05

## Problem

Civic OS's notification system has two delivery paths that differ in **shape**, not intent:

| Path | Worker | Job Kind | Shape |
|------|--------|----------|-------|
| Per-user | `NotificationWorker` | `send_notification` | User ID → looks up preferences, supports email + SMS |
| Multi-recipient | `SendEmailWorker` | `send_email` | Raw email addresses, email only |

Whether an email needs tracking and CAN-SPAM compliance is **independent of which path sends it**. A promotional event notification sent per-user IS bulk commercial email. An operational report sent to 10 managers via `send_email` is NOT. The delivery shape (user IDs vs. email addresses) and the compliance obligation (bulk vs. transactional) are orthogonal concerns.

Currently, neither path has:
- **Engagement tracking** — no open or click metrics
- **CAN-SPAM compliance** — no unsubscribe mechanism, no physical address
- **RFC 8058 support** — Gmail/Yahoo increasingly filter bulk email without `List-Unsubscribe` headers

The `SendEmailWorker` additionally has **no delivery tracking** — fire and forget.

The newsletter entity attempted domain-level open tracking (tracking pixel via PostgREST RPC), but this is architecturally broken: PostgREST runs GET requests in read-only transactions, and `<img>` tags can only GET.

## Solution: Framework-Level Trackable Notifications

Add engagement tracking and CAN-SPAM compliance as a template-level concern, transparent to the delivery path. Templates flagged `is_bulk = TRUE` automatically get tracking pixels, compliance footers, and unsubscribe handling — regardless of whether they're sent via `NotificationWorker` or `SendEmailWorker`.

Integrators choose their delivery function based on what they have (user IDs → `create_notification()`, email addresses → `send_email()`), then set `is_bulk` on the template if it's commercial/marketing email. The framework handles the rest.

### Design Principles

1. **Transparent to templates** — tracking is injected after rendering, not by the template author
2. **Template-driven** — `is_bulk` on the template controls tracking, not the delivery path
3. **Opt-out capable** — `NOTIFICATION_TRACKING_ENABLED=false` disables all tracking injection
4. **Domain-agnostic** — the framework tracks notifications generically; domain code (newsletters, campaigns) builds on top with VIEWs and dashboards

## Architecture

### New Database Tables

#### `metadata.notification_tracking_tokens`

One row per recipient per bulk email sent. This is the join point between "what was sent" and "what happened after."

```sql
CREATE TABLE metadata.notification_tracking_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_email TEXT NOT NULL,
    template_name VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100),           -- e.g., 'newsletters'
    entity_id VARCHAR(100),             -- e.g., '42'
    entity_data_snapshot JSONB,          -- frozen copy of entity_data at send time
    unsubscribed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ntt_recipient ON metadata.notification_tracking_tokens(recipient_email);
CREATE INDEX idx_ntt_entity ON metadata.notification_tracking_tokens(entity_type, entity_id);
CREATE INDEX idx_ntt_template ON metadata.notification_tracking_tokens(template_name);
CREATE INDEX idx_ntt_created ON metadata.notification_tracking_tokens(created_at DESC);
```

#### `metadata.notification_events`

Event-sourced engagement log. One row per open, click, unsubscribe, or bounce.

```sql
CREATE TABLE metadata.notification_events (
    id BIGSERIAL PRIMARY KEY,
    tracking_token UUID NOT NULL REFERENCES metadata.notification_tracking_tokens(id) ON DELETE CASCADE,
    event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('open', 'click', 'unsubscribe', 'bounce')),
    event_data JSONB DEFAULT '{}',      -- click: {url}, bounce: {code, message}
    ip_address TEXT,
    user_agent TEXT,
    suspected_bot BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ne_token ON metadata.notification_events(tracking_token);
CREATE INDEX idx_ne_type ON metadata.notification_events(event_type);
CREATE INDEX idx_ne_created ON metadata.notification_events(created_at DESC);
```

#### `metadata.notification_settings`

Singleton table for instance-level bulk email configuration (one row max).

```sql
CREATE TABLE metadata.notification_settings (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
    organization_address TEXT,           -- CAN-SPAM physical address (required for bulk)
    unsubscribe_reason_text TEXT         -- e.g., "You received this because you are a registered client"
        DEFAULT 'You received this email based on your registration.',
    tracking_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Deployers configure this via SQL INSERT or a future admin UI.

#### Template Flag: `is_bulk`

Add column to `metadata.notification_templates`:

```sql
ALTER TABLE metadata.notification_templates
    ADD COLUMN is_bulk BOOLEAN NOT NULL DEFAULT FALSE;
```

Only templates with `is_bulk = TRUE` get tracking injection and CAN-SPAM compliance footer. Existing transactional templates default to `FALSE` and are unaffected.

### New HTTP Server in Go Worker

The consolidated worker gains a lightweight HTTP server for inbound tracking callbacks. This is the only new network surface.

**Port**: Configurable via `TRACKING_PORT` env var (default: `8090`)
**Public URL**: `TRACKING_URL` env var (e.g., `http://localhost:8090` dev, `https://track.example.org` prod)

#### Endpoints

##### `GET /t/o?t={token}` — Open Tracking

1. Validate token exists in `notification_tracking_tokens`
2. INSERT into `notification_events` (type=`open`, ip, user-agent)
3. Return 1x1 transparent GIF with `Cache-Control: no-store` (prevent caching that would suppress repeat opens)

Response: `image/gif`, 43 bytes (smallest valid GIF).

##### `GET /t/c?t={token}&u={base64url}` — Click Tracking

1. Validate token exists
2. Decode target URL from `u` parameter
3. Validate URL (reject `javascript:`, `data:`, etc.)
4. INSERT into `notification_events` (type=`click`, url in event_data)
5. 302 redirect to target URL

Short paths (`/t/o`, `/t/c`) minimize URL length in emails — long tracking URLs can trigger spam filters.

##### `POST /t/u?t={token}` — RFC 8058 One-Click Unsubscribe

Called by Gmail/Yahoo servers when user clicks "Unsubscribe" in the email client UI.

1. Validate `List-Unsubscribe=One-Click` in POST body (per RFC 8058)
2. Validate token
3. SET `unsubscribed = TRUE` on `notification_tracking_tokens`
4. INSERT into `notification_events` (type=`unsubscribe`)
5. Return 200 OK

##### `GET /t/u?t={token}` — Visible Unsubscribe Page

Called when user clicks the footer unsubscribe link.

1. Validate token
2. Render a simple HTML page: "You have been unsubscribed from {template description} emails."
3. SET `unsubscribed = TRUE` on `notification_tracking_tokens`
4. INSERT into `notification_events` (type=`unsubscribe`)

### Auto-Injection (Both Workers)

When a template has `is_bulk = TRUE` and `NOTIFICATION_TRACKING_ENABLED != false`, both `NotificationWorker` and `SendEmailWorker` apply the following steps before sending each email. The injection logic lives in a shared function called by both workers.

#### 1. Generate Tracking Token

Before sending each recipient's email, INSERT a row into `notification_tracking_tokens` with the recipient email, template name, and entity context.

#### 2. Inject Tracking Pixel (Open Tracking)

Append before `</body>`:

```html
<img src="{TRACKING_URL}/t/o?t={token}" width="1" height="1" alt="" style="display:block;height:1px;width:1px;overflow:hidden;" />
```

#### 3. Append CAN-SPAM Footer

Append after the template's rendered HTML, before the tracking pixel:

```html
<div style="margin-top:32px; padding-top:16px; border-top:1px solid #e4e4e7; text-align:center; font-size:12px; color:#a1a1aa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <p style="margin:0 0 8px;">{unsubscribe_reason_text}</p>
  <p style="margin:0 0 8px;">
    <a href="{TRACKING_URL}/t/u?t={token}" style="color:#71717a; text-decoration:underline;">Unsubscribe</a>
  </p>
  <p style="margin:0; color:#a1a1aa;">{organization_address}</p>
</div>
```

If `organization_address` is not configured, log a warning but still send (don't block delivery over a config gap — the deployer should fix it).

#### 4. Add RFC 8058 Headers

Add to SMTP headers for bulk emails:

```
List-Unsubscribe: <{TRACKING_URL}/t/u?t={token}>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

This enables Gmail/Yahoo's native "Unsubscribe" button in the email client chrome.

### Unsubscribe Enforcement

When either worker prepares to send a bulk email (`is_bulk = TRUE`):

1. Check if recipient has an `unsubscribed = TRUE` token for the same `template_name`
2. If so, **skip sending** — log as suppressed, do not create a new tracking token
3. This is per-template suppression (unsubscribing from newsletters doesn't suppress welcome emails)

### User-Facing Unsubscribe Management

#### User Profile

Users can view and manage their bulk email subscriptions on the "My Profile" page (`/profile`). The existing notification preferences section already shows email/SMS channel preferences. Extend it with a "Bulk Email" section showing:

- List of template names the user has been sent (from `notification_tracking_tokens` where `recipient_email` matches)
- Unsubscribe toggle per template (maps to `unsubscribed` flag on the most recent token for that template)
- "Re-subscribe" action that sets `unsubscribed = FALSE`

This integrates with the existing `metadata.notification_preferences` system. A new column on `notification_preferences`:

```sql
ALTER TABLE metadata.notification_preferences
    ADD COLUMN bulk_email_unsubscribed_templates TEXT[] DEFAULT '{}';
```

This stores the template names the user has opted out of, providing a single source of truth per-user (rather than querying across all tracking tokens by email).

#### Admin: User Management

The User Management edit modal (`/admin/users`) shows the user's bulk email status:

- Which bulk templates they've unsubscribed from
- Admin can re-subscribe a user (with an audit note)
- Visible in the same section as existing notification preferences

### Aggregation VIEW

A convenience VIEW for domain-specific dashboards and the admin UI:

```sql
CREATE VIEW metadata.notification_tracking_stats
WITH (security_invoker = true) AS
SELECT
    ntt.entity_type,
    ntt.entity_id,
    ntt.template_name,
    COUNT(DISTINCT ntt.id) AS total_sent,
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
```

Domain code (e.g., newsletters) can create its own VIEWs joining this with domain tables.

## Migration Path from Newsletter-Specific Tracking

### Remove from `29_newsletter_entity.sql`

- `newsletter_recipients.tracking_token` column — no longer needed (framework generates tokens)
- `newsletter_opens` table — replaced by `metadata.notification_events`
- `newsletter_open_stats` VIEW — replaced by `metadata.notification_tracking_stats`
- `track_newsletter_open()` RPC — replaced by `/t/o` HTTP endpoint
- Manual `<img>` tracking pixel in notification template — auto-injected by framework

### Keep in `29_newsletter_entity.sql`

- `newsletter_recipients` junction table (without `tracking_token`) — still needed for recipient list management
- `send_newsletter()` RPC — still needs to iterate recipients and call `metadata.send_email()`
- `schedule_newsletter()` RPC — unchanged
- `check_scheduled_newsletters()` scheduled job — unchanged

### Update `newsletter_send` Template

- Set `is_bulk = TRUE`
- Remove manual tracking pixel from `html_template`
- Remove manual footer (framework appends one)
- Keep `{{ markdown .Entity.body }}` — the body content is template-driven, only the chrome is framework-managed

## Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `NOTIFICATION_TRACKING_ENABLED` | `true` | Master switch for all tracking injection |
| `TRACKING_URL` | `http://localhost:8090` | Public-facing base URL for tracking endpoints |
| `TRACKING_PORT` | `8090` | Port the tracking HTTP server binds to |

Instance-level settings (`organization_address`, `unsubscribe_reason_text`) live in `metadata.notification_settings` rather than env vars, since they're content (not infrastructure) and may be managed by non-technical admins via a future UI.

## Security Considerations

- **Token opacity**: Tracking tokens are UUIDs — they don't encode recipient email or entity data. An attacker who guesses a token can trigger a spurious open/click event but cannot extract PII.
- **URL validation**: Click tracking decodes and validates target URLs before redirecting. Reject `javascript:`, `data:`, `file:`, and other non-HTTP schemes to prevent open redirect attacks.
- **Rate limiting**: The tracking HTTP server should limit requests per token per time window to prevent event table bloat from bots or scanners. A simple approach: deduplicate opens within a 1-minute window per token.
- **Unsubscribe authentication**: RFC 8058 unsubscribe is intentionally unauthenticated (the token IS the authentication). This is by design — email clients must be able to unsubscribe without user login.
- **No PII in URLs**: Tracking URLs contain only the token UUID. IP and user-agent are captured from the request headers at event time, not embedded in the URL.

## Bot Detection

Email clients (Gmail, Yahoo, Outlook) and security appliances routinely pre-fetch images and links in emails before the user sees them. Without filtering, these automated opens inflate engagement metrics.

### Heuristics

The tracking server applies two heuristics to every `GET /t/o` open event, setting `suspected_bot = TRUE` if either fires:

1. **Timing threshold** — If `now() - tracking_token.created_at < 5 seconds`, flag as bot. Humans don't open emails within seconds of send. This catches security scanners and link pre-fetchers.
2. **Known bot user-agents** — String match against a maintained list: `GoogleImageProxy`, `YahooMailProxy`, `ms-office`, `Barracuda`, `ZmImgProxy`, `Outlook-iOS`, `Microsoft Outlook`.

### Design Principle: Flag, Never Discard

Bot-suspected events are **always recorded** in `notification_events`. The `suspected_bot` column lets the aggregation VIEW and dashboards filter them out, but raw data is preserved for:
- Debugging false positives
- Tuning detection thresholds
- Auditing delivery (proving an email was received by the mailbox)

The `notification_tracking_stats` VIEW exposes both raw metrics (`unique_opens`, `open_rate_pct`) and filtered metrics (`human_unique_opens`, `human_open_rate_pct`), giving integrators both perspectives without requiring them to understand the bot detection logic.

### Rate Limiting

The open endpoint deduplicates events within a 1-minute window per token. If an open event for the same token already exists within the last minute, the endpoint returns the tracking GIF without inserting a new event. This prevents event table bloat from aggressive pre-fetchers that retry rapidly.

## Future / Roadmap

- **`rawHTML` template function**: `{{ rawHTML .Entity.field }}` to bypass Go `html/template` auto-escaping for pre-formatted HTML fields. Would need sanitization via `bluemonday` to prevent XSS. Currently `markdown` is the only rich content path and handles its own HTML conversion.
- **Click tracking link rewriting**: The `/t/c` endpoint and schema support click events from day one (URL stored in `event_data` JSONB). What's deferred is **automatic link rewriting** — parsing rendered HTML to rewrite every `<a href>` to route through the click tracker. This requires an HTML tokenizer (`golang.org/x/net/html`), edge case handling (mailto:, tel:, anchors, the unsubscribe link itself), and adds URL length to emails (potential spam filter concern). For now, integrators who need click tracking can manually use `{{.Metadata.tracking_url}}/t/c?t={{token}}&u={base64url}` in templates.
- **Bounce tracking**: `SendEmailWorker.sendEmail()` already catches SMTP errors. On failure, INSERT a `bounce` event. Repeated bounces could auto-suppress the address.
- **Admin UI**: `/admin/notifications` page showing delivery stats, engagement metrics, and unsubscription management.
- **Send throttling**: River supports per-queue rate limits. Important for bulk sends to avoid ISP throttling and maintain sender reputation.
- **DKIM signing**: RFC 8058 requires DKIM signatures covering `List-Unsubscribe` headers. Currently outside Civic OS scope (handled by mail infrastructure), but worth documenting for deployers.
- **A/B testing**: Future domain-level feature. Send variant templates to subsets of recipients, compare engagement via tracking stats.
- **Dashboard widget**: A "Campaign Performance" widget type showing open/click rates for bulk notifications.

## Implementation Order

1. **Migration**: New tables (`notification_tracking_tokens`, `notification_events`, `notification_settings`), `is_bulk` column on templates, `bulk_email_unsubscribed_templates` on `notification_preferences`
2. **HTTP server**: Add tracking server to Go worker with open/click/unsubscribe endpoints
3. **Auto-injection**: Tracking pixel, CAN-SPAM footer, RFC 8058 headers in shared injection function used by both workers
4. **Unsubscribe enforcement**: Skip suppressed recipients, sync unsubscribe state to `notification_preferences`
5. **User profile**: Bulk email subscription management on My Profile page
6. **Admin UI**: Show bulk email unsubscribe status in User Management edit modal
7. **Aggregation VIEW**: `notification_tracking_stats` for domain dashboards
8. **Newsletter migration**: Remove domain-specific tracking from `29_newsletter_entity.sql`, set `is_bulk = TRUE`
9. **Documentation**: Update Integrator Guide, Notifications docs
