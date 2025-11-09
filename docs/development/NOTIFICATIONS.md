# Notification System Architecture

**Status**: ✅ Implemented in v0.11.0

**Version**: 0.11.0

This document describes the architecture and implementation plan for the Civic OS notification system, a River-based microservice that provides multi-channel notifications (email, SMS) with template support.

## Overview

The notification system allows applications to send notifications to users by calling a PostgreSQL function. The system supports:

- **Multi-channel delivery**: Email (Phase 1), SMS (Phase 2)
- **Template system**: Database-managed templates with HTML/Text/SMS variants
- **User preferences**: Per-user channel preferences
- **Polymorphic entity references**: Link notifications to any entity type
- **Reliable delivery**: River queue with automatic retries and error handling
- **Future extensibility**: Digest emails, quiet hours, notification history

## Architecture

### Data Flow

```
Application Code
    ↓
create_notification() RPC
    ↓
INSERT → metadata.notifications
    ↓
PostgreSQL Trigger
    ↓
INSERT → metadata.river_job (kind: "send_notification")
    ↓
Go Notification Worker
    ↓
1. Fetch notification record
2. Load template
3. Render template with entity data
4. Check user preferences
5. Send via channel(s) (Email/SMS)
6. Update notification status
```

### Components

1. **Database Schema** - Tables for notifications, templates, preferences
2. **PostgreSQL RPC** - `create_notification()` function for creating notifications
3. **PostgreSQL Trigger** - Auto-enqueue River jobs on INSERT
4. **Go Worker** - River-based worker that renders and sends notifications
5. **Template System** - Go templates with HTML/Text/SMS variants (NO caching for simplicity)
6. **Template Validation** - Synchronous PostgreSQL RPC with per-part validation
7. **Channel Adapters** - Email (SMTP), SMS (Twilio/AWS SNS)

## Architecture Decisions

### Template Parsing Strategy: No Caching (Phase 1)

**Decision:** Templates are parsed fresh on every notification. No caching.

**Rationale:**
- Template parsing is extremely fast (~10-50μs per template)
- Real bottleneck is email delivery (~1-2 seconds), not parsing
- Eliminates entire class of cache invalidation bugs
- Template updates take effect immediately
- Simpler mental model for Phase 1

**Performance Impact:**
- 10,000 notifications/day × 50μs parsing = 500ms CPU time
- Compare to: 10,000 notifications × 1s email delivery = 2.7 hours
- Parsing is 0.02% of total notification time

**Future:** Add simple TTL cache when notification volume exceeds 50,000/day (Phase 3).

### Validation Strategy: Per-Part Validation

**Decision:** Validate template parts (subject, HTML, text, SMS) independently, not as a unit.

**Rationale:**
- Each template part is independent (no cross-references)
- Enables real-time validation as user types (better UX)
- Faster validation for single-field edits
- Same RPC handles both single-part and all-parts validation

**Use Cases:**
- **Real-time:** Validate subject field as user types (500ms debounce)
- **Pre-save:** Validate all parts before INSERT into database
- **Template updates:** Validate only the parts being edited

### Validation Architecture: Synchronous RPC + River Queue

**Decision:** PostgreSQL RPC function that enqueues high-priority River job and polls for result.

**Rationale:**
- Consistent with River queue architecture (no HTTP endpoints)
- Validation jobs get priority=4 (vs priority=1 for notifications)
- Natural backpressure via 10-second timeout
- Zero additional infrastructure (no nginx, load balancers, etc.)
- Validation is read-only (no side effects, no caching)

## Template Engine Selection

### Chosen Solution: Go's Native Templates

The notification system uses **Go's built-in `text/template` and `html/template` packages** for template rendering. This choice provides:

- ✅ **Zero external dependencies** - Part of Go's standard library
- ✅ **Security by default** - `html/template` auto-escapes HTML to prevent XSS
- ✅ **Context-aware escaping** - Different escaping for HTML, JS, CSS, URLs
- ✅ **Performance** - Fast parsing (~10-50μs), no caching needed for Phase 1
- ✅ **Simplicity** - No additional dependencies or cache management

**Official Documentation:**
- [text/template](https://pkg.go.dev/text/template) - Plain text templates (subject, SMS)
- [html/template](https://pkg.go.dev/html/template) - HTML templates with XSS protection

### Go Template Syntax Overview

Go templates use `{{` and `}}` delimiters with dot notation for data access.

**Basic Syntax:**

```go
// Variable access
{{.Entity.display_name}}           // Access nested fields
{{.User.email}}                     // Dot notation for structs/maps

// Conditionals
{{if .Entity.severity}}
  Severity: {{.Entity.severity}}/5
{{end}}

{{if eq .Entity.status "urgent"}}
  ⚠️ URGENT
{{else}}
  Status: {{.Entity.status}}
{{end}}

// Iteration
{{range .Entity.tags}}
  - {{.}}
{{end}}

// Variables
{{$url := .Metadata.site_url}}
<a href="{{$url}}/view/issues/{{.Entity.id}}">View Issue</a>

// Built-in functions
{{len .Entity.tags}} tags
{{printf "%.2f" .Entity.price}}
```

**Custom Template Functions:**

Civic OS provides custom formatters for domain-specific data types. These functions are available in all template contexts (subject, HTML, text, SMS).

```go
// formatTimeSlot - Format tstzrange to human-readable date range
// Input: ["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")
// Output: "Mar 15, 2025 2:00 PM EST - 4:00 PM EST"
{{formatTimeSlot .Entity.time_slot}}

// Multi-day ranges format differently
// Input: ["2025-03-15 14:00:00+00","2025-03-17 11:00:00+00")
// Output: "Mar 15, 2025 2:00 PM EST - Mar 17, 2025 11:00 AM EST"
{{formatTimeSlot .Entity.reservation_time}}

// formatDateTime - Format ISO timestamp to localized datetime
// Input: "2025-03-15T19:00:00Z"
// Output: "Mar 15, 2025 2:00 PM EST"
{{formatDateTime .Entity.created_at}}
{{formatDateTime .Entity.reviewed_at}}

// formatDate - Format ISO date to localized date (no time)
// Input: "2025-03-15"
// Output: "Mar 15, 2025"
{{formatDate .Entity.event_date}}

// formatMoney - Format money values
// Input: "$1,234.56" (PostgreSQL money type) or 1234.56 (numeric)
// Output: "$1,234.56"
{{formatMoney .Entity.hourly_rate}}
{{formatMoney .Entity.total_cost}}

// formatPhone - Format 10-digit phone to (XXX) XXX-XXXX
// Input: "5551234567"
// Output: "(555) 123-4567"
{{formatPhone .Entity.contact_phone}}
```

**Timezone Configuration:**

All date/time formatters use the timezone configured via the `NOTIFICATION_TIMEZONE` environment variable (default: `America/New_York`). This ensures notifications display times consistently for your organization's timezone.

```yaml
# docker-compose.yml
notification-worker:
  environment:
    - NOTIFICATION_TIMEZONE=${NOTIFICATION_TIMEZONE:-America/New_York}
```

**Supported Timezones:** Any valid IANA timezone name (e.g., `America/Los_Angeles`, `Europe/London`, `UTC`). See [IANA Time Zone Database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) for complete list.

> **Future Enhancement:** Currently all notifications use a single system timezone. In a future phase, we plan to capture each user's timezone preference (stored in `metadata.civic_os_users`) and format dates/times in the recipient's local timezone. This will require: (1) adding a `timezone` column to the users table, (2) passing recipient timezone to the renderer, and (3) updating formatters to use recipient-specific timezone instead of system timezone. This is particularly important for organizations with users across multiple timezones.

**Example Usage in Templates:**

```html
<!-- Reservation confirmation email -->
<div class="info-box">
  <p><strong>Facility:</strong> {{.Entity.resource.display_name}}</p>
  <p><strong>Reserved Time:</strong> {{formatTimeSlot .Entity.time_slot}}</p>
  <p><strong>Hourly Rate:</strong> {{formatMoney .Entity.resource.hourly_rate}}</p>
  <p><strong>Approved On:</strong> {{formatDateTime .Entity.reviewed_at}}</p>
  {{if .Entity.contact_phone}}
  <p><strong>Contact:</strong> {{formatPhone .Entity.contact_phone}}</p>
  {{end}}
</div>
```

**Security Features:**

`html/template` automatically escapes based on context:

```go
// Input: entity_data = {"name": "<script>alert('xss')</script>"}

// Template:
<p>Name: {{.Entity.name}}</p>

// Output (safely escaped):
<p>Name: &lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;</p>
```

**Real-World Example:**

```sql
-- Subject template (text/template)
New issue assigned: {{.Entity.display_name}}

-- HTML template (html/template)
<h2>New Issue Assigned</h2>
<p>You have been assigned to: <strong>{{.Entity.display_name}}</strong></p>
{{if .Entity.severity}}
  <p>Severity: {{.Entity.severity}}/5</p>
{{end}}
<p><a href="{{.Metadata.site_url}}/view/issues/{{.Entity.id}}">View Issue</a></p>

-- Text template (text/template)
New Issue Assigned

You have been assigned to: {{.Entity.display_name}}
{{if .Entity.severity}}
Severity: {{.Entity.severity}}/5
{{end}}

View at: {{.Metadata.site_url}}/view/issues/{{.Entity.id}}
```

### Alternative Template Engines Considered

While Go's native templates were chosen, here are other options for reference:

#### 1. Handlebars (via `aymerick/raymond`)

**Syntax:** Similar to Mustache with `{{variable}}` syntax and helpers.

```handlebars
<!-- Handlebars syntax -->
<h2>New Issue Assigned</h2>
<p>You have been assigned to: <strong>{{Entity.display_name}}</strong></p>
{{#if Entity.severity}}
  <p>Severity: {{Entity.severity}}/5</p>
{{/if}}
<p><a href="{{Metadata.site_url}}/view/issues/{{Entity.id}}">View Issue</a></p>
```

**Pros:**
- Familiar to JavaScript developers
- Clean, readable syntax
- Helpers for custom logic

**Cons:**
- Requires external dependency (`github.com/aymerick/raymond`)
- Less context-aware escaping than `html/template`
- Additional maintenance burden

**Documentation:**
- [Handlebars.js Guide](https://handlebarsjs.com/guide/)
- [aymerick/raymond (Go)](https://github.com/aymerick/raymond)

#### 2. Liquid (via `osteele/liquid`)

**Syntax:** Shopify's template language with objects `{{}}`, tags `{% %}`, and filters `|`.

```liquid
<!-- Liquid syntax -->
<h2>New Issue Assigned</h2>
<p>You have been assigned to: <strong>{{ Entity.display_name }}</strong></p>
{% if Entity.severity %}
  <p>Severity: {{ Entity.severity }}/5</p>
{% endif %}
<p><a href="{{ Metadata.site_url }}/view/issues/{{ Entity.id }}">View Issue</a></p>
```

**Pros:**
- Powerful filter system (`{{ name | upcase }}`)
- Template inheritance (extends/includes)
- Familiar to Shopify/Jekyll users

**Cons:**
- Requires external dependency (`github.com/osteele/liquid`)
- More complex syntax than Go templates
- Performance overhead vs. native templates

**Documentation:**
- [Liquid Language](https://shopify.github.io/liquid/)
- [osteele/liquid (Go)](https://github.com/osteele/liquid)

#### 3. Mustache

**Syntax:** Logic-less templates with minimal syntax.

```mustache
<!-- Mustache syntax -->
<h2>New Issue Assigned</h2>
<p>You have been assigned to: <strong>{{Entity.display_name}}</strong></p>
{{#Entity.severity}}
  <p>Severity: {{Entity.severity}}/5</p>
{{/Entity.severity}}
<p><a href="{{Metadata.site_url}}/view/issues/{{Entity.id}}">View Issue</a></p>
```

**Pros:**
- Extremely simple (no logic)
- Language-agnostic (many implementations)
- Forces logic into code, not templates

**Cons:**
- Too restrictive for complex notifications
- No built-in HTML escaping
- Limited control flow

**Documentation:**
- [Mustache Spec](https://mustache.github.io/)
- [Go Implementations](https://github.com/cbroglie/mustache)

### Syntax Comparison Table

| Feature | Go Templates | Handlebars | Liquid | Mustache |
|---------|-------------|------------|--------|----------|
| **Variable** | `{{.Var}}` | `{{Var}}` | `{{ Var }}` | `{{Var}}` |
| **Conditional** | `{{if .X}}...{{end}}` | `{{#if X}}...{{/if}}` | `{% if X %}...{% endif %}` | `{{#X}}...{{/X}}` |
| **Loop** | `{{range .Items}}{{.}}{{end}}` | `{{#each Items}}{{this}}{{/each}}` | `{% for item in Items %}{{ item }}{% endfor %}` | `{{#Items}}{{.}}{{/Items}}` |
| **Escape HTML** | Auto (html/template) | `{{Var}}` (escaped) | `{{ Var }}` (escaped) | Manual only |
| **Raw HTML** | `{{.Var}}` (text/template) | `{{{Var}}}` | `{{ Var \| raw }}` | `{{{Var}}}` |
| **Filters/Helpers** | Built-in functions | Custom helpers | `{{ Var \| filter }}` | None |
| **Dependency** | Stdlib | External | External | External |

### Decision Rationale

**Why Go's native templates?**

1. **No Dependencies**: Reduces attack surface and simplifies deployment
2. **Security**: `html/template` provides context-aware XSS protection automatically
3. **Performance**: Standard library templates are highly optimized
4. **Maintainability**: No third-party library updates to track
5. **Team Familiarity**: Go developers already know the syntax
6. **Sufficient Power**: Supports conditionals, loops, and custom functions

**When to reconsider:**

- If template authors are non-technical and need simpler syntax (consider Handlebars)
- If you need advanced features like template inheritance (consider Liquid)
- If migrating from an existing system using a specific template language

**Migration Path:**

The template rendering is isolated in `renderer.go`. If you later decide to switch engines, you only need to modify that single file—the database schema and API remain unchanged.

## Database Schema

### Migration: `v0-11-0-add-notifications.sql`

#### Table: `metadata.notification_templates`

Stores reusable notification templates with multiple format variants.

```sql
CREATE TABLE metadata.notification_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,  -- e.g., "issue_created", "appointment_reminder"
    description TEXT,

    -- Template variants (Go template syntax)
    subject_template TEXT NOT NULL,     -- Email subject line
    html_template TEXT NOT NULL,        -- HTML email body
    text_template TEXT NOT NULL,        -- Plain text email body
    sms_template TEXT,                  -- SMS message (160 char limit, future)

    -- Metadata
    entity_type VARCHAR(100),           -- Expected entity type (documentation only)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata.notification_templates IS
    'Notification templates with HTML/Text/SMS variants. Templates use Go template syntax with context: {User, Entity, Metadata}.';
COMMENT ON COLUMN metadata.notification_templates.entity_type IS
    'Expected entity type for this template (e.g., "issues"). Documentation only - not enforced.';

-- Example templates
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template) VALUES
('issue_created', 'Notify assigned user when new issue is created', 'issues',
    'New issue assigned: {{.Entity.display_name}}',
    '<h2>New Issue Assigned</h2><p>You have been assigned to: <strong>{{.Entity.display_name}}</strong></p><p>Severity: {{.Entity.severity}}/5</p><p><a href="{{.Metadata.site_url}}/view/issues/{{.Entity.id}}">View Issue</a></p>',
    'New Issue Assigned\n\nYou have been assigned to: {{.Entity.display_name}}\n\nSeverity: {{.Entity.severity}}/5\n\nView at: {{.Metadata.site_url}}/view/issues/{{.Entity.id}}'
),
('appointment_reminder', 'Remind user of upcoming appointment', 'appointments',
    'Reminder: Appointment on {{.Entity.start_time}}',
    '<h2>Appointment Reminder</h2><p>You have an appointment scheduled for <strong>{{.Entity.start_time}}</strong></p><p>Location: {{.Entity.location}}</p><p><a href="{{.Metadata.site_url}}/view/appointments/{{.Entity.id}}">View Details</a></p>',
    'Appointment Reminder\n\nYou have an appointment scheduled for {{.Entity.start_time}}\n\nLocation: {{.Entity.location}}\n\nView at: {{.Metadata.site_url}}/view/appointments/{{.Entity.id}}'
);
```

#### Table: `metadata.notification_preferences`

Per-user notification channel preferences.

```sql
CREATE TABLE metadata.notification_preferences (
    user_id UUID NOT NULL REFERENCES civic_os_users(id) ON DELETE CASCADE,
    channel VARCHAR(20) NOT NULL,  -- 'email', 'sms'
    enabled BOOLEAN NOT NULL DEFAULT TRUE,

    -- Contact information
    email_address email_address,   -- Override user's primary email
    phone_number phone_number,      -- For SMS (Phase 2)

    -- Future: Per-template preferences
    -- disabled_templates TEXT[],  -- Array of template names to suppress

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user_id, channel)
);

COMMENT ON TABLE metadata.notification_preferences IS
    'Per-user notification channel preferences. Defaults to enabled for all channels.';

-- Default preferences for all users (email enabled)
-- This trigger could auto-create preferences when users are created
CREATE OR REPLACE FUNCTION create_default_notification_preferences()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    INSERT INTO metadata.notification_preferences (user_id, channel, enabled, email_address)
    VALUES (NEW.id, 'email', TRUE, NEW.email)
    ON CONFLICT (user_id, channel) DO NOTHING;

    -- Future: Add SMS preference when phone_number is added to civic_os_users
    -- INSERT INTO metadata.notification_preferences (user_id, channel, enabled, phone_number)
    -- VALUES (NEW.id, 'sms', FALSE, NEW.phone_number)
    -- ON CONFLICT (user_id, channel) DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER create_default_notification_preferences_trigger
    AFTER INSERT ON metadata.civic_os_users
    FOR EACH ROW
    EXECUTE FUNCTION create_default_notification_preferences();
```

#### Table: `metadata.notifications`

Individual notification records with polymorphic entity references.

```sql
CREATE TABLE metadata.notifications (
    id BIGSERIAL PRIMARY KEY,

    -- Recipient
    user_id UUID NOT NULL REFERENCES civic_os_users(id) ON DELETE CASCADE,

    -- Template
    template_name VARCHAR(100) NOT NULL REFERENCES metadata.notification_templates(name),

    -- Polymorphic entity reference
    entity_type VARCHAR(100),           -- Table name (e.g., 'issues', 'appointments')
    entity_id VARCHAR(100),             -- Entity primary key (stored as text for flexibility)
    entity_data JSONB,                  -- Snapshot of entity data for template rendering

    -- Delivery
    channels TEXT[] NOT NULL DEFAULT '{email}',  -- ['email'], ['sms'], or ['email', 'sms']
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending', 'sent', 'failed'

    -- Results (updated by worker)
    sent_at TIMESTAMPTZ,
    error_message TEXT,
    channels_sent TEXT[],               -- Which channels succeeded
    channels_failed TEXT[],             -- Which channels failed

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Indexes
    CONSTRAINT valid_status CHECK (status IN ('pending', 'sent', 'failed'))
);

CREATE INDEX idx_notifications_user_id ON metadata.notifications(user_id);
CREATE INDEX idx_notifications_status ON metadata.notifications(status);
CREATE INDEX idx_notifications_created_at ON metadata.notifications(created_at);
CREATE INDEX idx_notifications_entity ON metadata.notifications(entity_type, entity_id);

COMMENT ON TABLE metadata.notifications IS
    'Individual notification records. Created via create_notification() RPC, processed by notification worker.';
COMMENT ON COLUMN metadata.notifications.entity_data IS
    'JSONB snapshot of entity at notification creation time. Used for template rendering.';
```

#### RPC Function: `create_notification()`

PostgreSQL function for creating notifications with validation.

```sql
CREATE OR REPLACE FUNCTION create_notification(
    p_user_id UUID,
    p_template_name VARCHAR,
    p_entity_type VARCHAR DEFAULT NULL,
    p_entity_id VARCHAR DEFAULT NULL,
    p_entity_data JSONB DEFAULT NULL,
    p_channels TEXT[] DEFAULT '{email}'
)
RETURNS BIGINT  -- Returns notification ID
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_notification_id BIGINT;
    v_template_exists BOOLEAN;
BEGIN
    -- Validate template exists
    SELECT EXISTS(
        SELECT 1 FROM metadata.notification_templates WHERE name = p_template_name
    ) INTO v_template_exists;

    IF NOT v_template_exists THEN
        RAISE EXCEPTION 'Template "%" does not exist', p_template_name;
    END IF;

    -- Validate user exists
    IF NOT EXISTS(SELECT 1 FROM civic_os_users WHERE id = p_user_id) THEN
        RAISE EXCEPTION 'User "%" does not exist', p_user_id;
    END IF;

    -- Validate channels
    IF p_channels IS NULL OR array_length(p_channels, 1) = 0 THEN
        RAISE EXCEPTION 'At least one channel must be specified';
    END IF;

    -- Insert notification
    INSERT INTO metadata.notifications (
        user_id,
        template_name,
        entity_type,
        entity_id,
        entity_data,
        channels
    )
    VALUES (
        p_user_id,
        p_template_name,
        p_entity_type,
        p_entity_id,
        p_entity_data,
        p_channels
    )
    RETURNING id INTO v_notification_id;

    RETURN v_notification_id;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION create_notification TO authenticated;

COMMENT ON FUNCTION create_notification IS
    'Create a notification for a user. Validates template and user existence. Auto-enqueues River job for delivery.';

-- Usage example:
-- SELECT create_notification(
--     p_user_id := '123-456-789',
--     p_template_name := 'issue_created',
--     p_entity_type := 'issues',
--     p_entity_id := '42',
--     p_entity_data := '{"display_name": "Pothole on Main St", "severity": 5, "id": 42}'::jsonb,
--     p_channels := '{email}'
-- );
```

#### Trigger: Auto-enqueue River Jobs

PostgreSQL trigger to automatically enqueue River jobs when notifications are created.

```sql
CREATE OR REPLACE FUNCTION enqueue_notification_job()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts)
    VALUES (
        'send_notification',
        jsonb_build_object(
            'notification_id', NEW.id::text,
            'user_id', NEW.user_id::text,
            'template_name', NEW.template_name,
            'entity_type', NEW.entity_type,
            'entity_id', NEW.entity_id,
            'entity_data', NEW.entity_data,
            'channels', NEW.channels
        ),
        'notifications',  -- Queue name
        1,                -- Priority (higher = more urgent)
        5                 -- Max attempts (fewer than file jobs - emails are idempotent)
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enqueue_notification_job_trigger
    AFTER INSERT ON metadata.notifications
    FOR EACH ROW
    EXECUTE FUNCTION enqueue_notification_job();

COMMENT ON FUNCTION enqueue_notification_job IS
    'Trigger function that enqueues River job when notification is created.';
```

#### Permissions

```sql
-- Grant access to notification tables
GRANT SELECT, INSERT ON metadata.notifications TO authenticated;
GRANT SELECT ON metadata.notification_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE ON metadata.notification_preferences TO authenticated;

-- RLS policies
ALTER TABLE metadata.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.notification_preferences ENABLE ROW LEVEL SECURITY;

-- Users can see their own notifications
CREATE POLICY "Users see own notifications" ON metadata.notifications
    FOR SELECT TO authenticated USING (user_id = current_user_id());

-- Users can manage their own preferences
CREATE POLICY "Users manage own preferences" ON metadata.notification_preferences
    FOR ALL TO authenticated USING (user_id = current_user_id());

-- Admins can manage templates
ALTER TABLE metadata.notification_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage templates" ON metadata.notification_templates
    FOR ALL TO authenticated USING (is_admin());
CREATE POLICY "All can view templates" ON metadata.notification_templates
    FOR SELECT TO authenticated USING (TRUE);
```

### Template Validation System

The notification system includes a synchronous validation system that allows frontends to validate template syntax before saving.

#### Validation Tables

```sql
-- Main validation request
CREATE TABLE metadata.template_validation_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_template TEXT,
    html_template TEXT,
    text_template TEXT,
    sms_template TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending', 'completed'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    CONSTRAINT valid_status CHECK (status IN ('pending', 'completed'))
);

-- Individual part results (enables per-field validation)
CREATE TABLE metadata.template_part_validation_results (
    id SERIAL PRIMARY KEY,
    validation_id UUID NOT NULL REFERENCES metadata.template_validation_results(id) ON DELETE CASCADE,
    part_name VARCHAR(20) NOT NULL,  -- 'subject', 'html', 'text', 'sms'
    valid BOOLEAN NOT NULL,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_part_name CHECK (part_name IN ('subject', 'html', 'text', 'sms'))
);

CREATE INDEX idx_template_validation_results_status
    ON metadata.template_validation_results(status, created_at);
CREATE INDEX idx_part_validation_results_validation_id
    ON metadata.template_part_validation_results(validation_id);

COMMENT ON TABLE metadata.template_validation_results IS
    'Temporary storage for template validation requests. Results expire after 1 hour.';
COMMENT ON TABLE metadata.template_part_validation_results IS
    'Per-part validation results. Enables real-time validation of individual template fields.';

-- Cleanup function for old validation results
CREATE OR REPLACE FUNCTION cleanup_old_validation_results()
RETURNS void
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    DELETE FROM metadata.template_validation_results
    WHERE created_at < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION cleanup_old_validation_results TO authenticated;

-- Optional: Schedule periodic cleanup via pg_cron or app-level cron
```

#### Validation RPC Function

```sql
CREATE OR REPLACE FUNCTION validate_template_parts(
    p_validation_id UUID DEFAULT gen_random_uuid(),
    p_subject_template TEXT DEFAULT NULL,
    p_html_template TEXT DEFAULT NULL,
    p_text_template TEXT DEFAULT NULL,
    p_sms_template TEXT DEFAULT NULL
)
RETURNS TABLE(
    part_name TEXT,
    valid BOOLEAN,
    error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_start_time TIMESTAMPTZ;
    v_timeout_seconds INT := 10;
    v_completed BOOLEAN := FALSE;
BEGIN
    v_start_time := clock_timestamp();

    -- Validate that at least one template part was provided
    IF p_subject_template IS NULL
        AND p_html_template IS NULL
        AND p_text_template IS NULL
        AND p_sms_template IS NULL
    THEN
        RAISE EXCEPTION 'At least one template part must be provided for validation';
    END IF;

    -- Insert validation request
    INSERT INTO metadata.template_validation_results (
        id,
        subject_template,
        html_template,
        text_template,
        sms_template,
        status
    )
    VALUES (
        p_validation_id,
        p_subject_template,
        p_html_template,
        p_text_template,
        p_sms_template,
        'pending'
    );

    -- Enqueue high-priority validation job
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts)
    VALUES (
        'validate_template_parts',
        jsonb_build_object(
            'validation_id', p_validation_id::text,
            'subject_template', p_subject_template,
            'html_template', p_html_template,
            'text_template', p_text_template,
            'sms_template', p_sms_template
        ),
        'notifications',
        100,  -- HIGH PRIORITY (normal notifications are priority 1)
        3
    );

    -- Poll for results (100ms intervals, 10 second timeout)
    LOOP
        -- Check if validation completed
        SELECT status = 'completed'
        INTO v_completed
        FROM metadata.template_validation_results
        WHERE id = p_validation_id;

        IF v_completed THEN
            -- Return results for each part validated
            RETURN QUERY
            SELECT
                pvr.part_name,
                pvr.valid,
                pvr.error_message
            FROM metadata.template_part_validation_results pvr
            WHERE pvr.validation_id = p_validation_id
            ORDER BY
                CASE pvr.part_name
                    WHEN 'subject' THEN 1
                    WHEN 'html' THEN 2
                    WHEN 'text' THEN 3
                    WHEN 'sms' THEN 4
                END;
            RETURN;
        END IF;

        -- Timeout check
        IF EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) > v_timeout_seconds THEN
            RAISE EXCEPTION 'Template validation timeout (>% seconds). Worker may be overloaded.', v_timeout_seconds;
        END IF;

        -- Sleep 100ms between polls
        PERFORM pg_sleep(0.1);
    END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION validate_template_parts TO authenticated;

COMMENT ON FUNCTION validate_template_parts IS
    'Synchronously validates template parts by enqueuing high-priority River job. Pass only the parts you want to validate (enables per-field real-time validation). Returns validation result for each part. Times out after 10 seconds.';

-- Usage examples:

-- Validate single field (real-time as user types):
-- SELECT * FROM validate_template_parts(
--     p_subject_template := 'New issue: {{.Entity.display_name}}'
-- );

-- Validate all fields (pre-save):
-- SELECT * FROM validate_template_parts(
--     p_subject_template := 'New issue: {{.Entity.display_name}}',
--     p_html_template := '<h2>Issue</h2><p>{{.Entity.description}}</p>',
--     p_text_template := 'Issue: {{.Entity.description}}'
-- );
```

## Go Worker Implementation

### Service Structure

```
services/notification-worker-go/
├── main.go              # River client setup, graceful shutdown
├── notification_worker.go   # NotificationWorker (sends notifications)
├── validation_worker.go     # ValidationWorker (validates templates)
├── types.go             # Shared types and structs
├── channels/
│   ├── email.go         # SMTP email sender
│   └── sms.go           # SMS sender (stub for Phase 2)
├── go.mod
├── go.sum
├── Dockerfile
└── README.md
```

**Key Design:** Two separate River workers running in the same service:
1. **NotificationWorker** - Sends notifications (priority 1)
2. **ValidationWorker** - Validates templates (priority 4)

### Dependencies (go.mod)

```go
module github.com/civic-os/notification-worker-go

go 1.24

require (
    github.com/jackc/pgx/v5 v5.7.6
    github.com/riverqueue/river v0.25.0
    github.com/riverqueue/river/riverdriver/riverpgxv5 v0.25.0
)
// Note: Email uses Go stdlib net/smtp (no external dependencies)
// Note: SMS support (Phase 2) may add Twilio SDK
```

### main.go - Service Setup

```go
package main

import (
    "context"
    "fmt"
    "log"
    "log/slog"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river"
    "github.com/riverqueue/river/riverdriver/riverpgxv5"
)

func main() {
    ctx := context.Background()

    // 1. Load configuration from environment
    databaseURL := getEnv("DATABASE_URL", "postgres://authenticator:password@localhost:5432/civic_os")
    siteURL := getEnv("SITE_URL", "http://localhost:4200")

    // SMTP Configuration
    smtpHost := getEnv("SMTP_HOST", "email-smtp.us-east-1.amazonaws.com")
    smtpPort := getEnv("SMTP_PORT", "587")
    smtpUsername := getEnv("SMTP_USERNAME", "")
    smtpPassword := getEnv("SMTP_PASSWORD", "")
    smtpFrom := getEnv("SMTP_FROM", "noreply@civic-os.org")

    log.Printf("🚀 Civic OS Notification Worker starting...")
    log.Printf("   Site URL: %s", siteURL)
    log.Printf("   SMTP Host: %s:%s", smtpHost, smtpPort)
    log.Printf("   SMTP From: %s", smtpFrom)
    log.Printf("   SMTP Auth: %v", smtpUsername != "")

    // 2. Connect to PostgreSQL
    dbPool, err := pgxpool.New(ctx, databaseURL)
    if err != nil {
        log.Fatalf("Failed to create database pool: %v", err)
    }
    defer dbPool.Close()

    if err := dbPool.Ping(ctx); err != nil {
        log.Fatalf("Failed to connect to database: %v", err)
    }
    log.Println("✓ Connected to PostgreSQL")

    // 3. Create SMTP configuration
    smtpConfig := &SMTPConfig{
        Host:     smtpHost,
        Port:     smtpPort,
        Username: smtpUsername,
        Password: smtpPassword,
        From:     smtpFrom,
    }
    log.Println("✓ SMTP configuration loaded")

    // 4. Register BOTH River workers (notification sender + validator)
    workers := river.NewWorkers()

    // Notification sender (priority 1)
    river.AddWorker(workers, &NotificationWorker{
        dbPool:     dbPool,
        smtpConfig: smtpConfig,
        siteURL:    siteURL,
    })

    // Template validator (priority 4)
    river.AddWorker(workers, &ValidationWorker{
        dbPool:  dbPool,
        siteURL: siteURL,
    })

    // 5. Create River client
    riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
        Queues: map[string]river.QueueConfig{
            "notifications": {MaxWorkers: 30}, // I/O-bound, SMTP connections
        },
        Workers: workers,
        Logger:  slog.Default(),
        Schema:  "metadata", // River tables in metadata schema
    })
    if err != nil {
        log.Fatalf("Failed to create River client: %v", err)
    }

    // 7. Start River client
    if err := riverClient.Start(ctx); err != nil {
        log.Fatalf("Failed to start River client: %v", err)
    }
    log.Println("✓ River client started with queue: notifications (30 workers)")
    log.Println("🚀 Notification worker is running!")

    // 8. Graceful shutdown
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    <-sigChan
    log.Println("Shutdown signal received, stopping gracefully...")

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    if err := riverClient.Stop(shutdownCtx); err != nil {
        log.Printf("Error stopping River client: %v", err)
    }

    log.Println("✓ Shutdown complete")
}

func getEnv(key, defaultValue string) string {
    if value := os.Getenv(key); value != "" {
        return value
    }
    return defaultValue
}
```

### worker.go - Notification Worker

```go
package main

import (
    "context"
    "crypto/tls"
    "encoding/json"
    "fmt"
    "log"
    "net"
    "net/smtp"
    "strings"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river"
)

// SMTPConfig holds SMTP server configuration
type SMTPConfig struct {
    Host     string
    Port     string
    Username string
    Password string
    From     string
}

// NotificationArgs defines the job arguments structure
type NotificationArgs struct {
    NotificationID string          `json:"notification_id"`
    UserID         string          `json:"user_id"`
    TemplateName   string          `json:"template_name"`
    EntityType     string          `json:"entity_type"`
    EntityID       string          `json:"entity_id"`
    EntityData     json.RawMessage `json:"entity_data"`
    Channels       []string        `json:"channels"`
}

func (NotificationArgs) Kind() string { return "send_notification" }

func (NotificationArgs) InsertOpts() river.InsertOpts {
    return river.InsertOpts{
        Queue:       "notifications",
        MaxAttempts: 5,
        Priority:    1,
    }
}

// NotificationWorker implements the River Worker interface
type NotificationWorker struct {
    river.WorkerDefaults[NotificationArgs]
    dbPool     *pgxpool.Pool
    renderer   *Renderer
    smtpConfig *SMTPConfig
}

// Work executes the notification job
func (w *NotificationWorker) Work(ctx context.Context, job *river.Job[NotificationArgs]) error {
    startTime := time.Now()
    log.Printf("[Job %d] Starting notification job (attempt %d/%d): notification_id=%s, template=%s",
        job.ID, job.Attempt, job.MaxAttempts, job.Args.NotificationID, job.Args.TemplateName)

    // 1. Fetch user preferences and validate channels
    prefs, err := w.getUserPreferences(ctx, job.Args.UserID)
    if err != nil {
        return fmt.Errorf("failed to fetch user preferences: %w", err)
    }

    // 2. Load template from database
    template, err := w.loadTemplate(ctx, job.Args.TemplateName)
    if err != nil {
        // Template error is permanent - don't retry
        w.markNotificationFailed(ctx, job.Args.NotificationID, fmt.Sprintf("Template error: %v", err))
        return nil // Don't retry
    }

    // 3. Render template with entity data
    rendered, err := w.renderer.RenderTemplate(template, job.Args.EntityData)
    if err != nil {
        // Rendering error is permanent - don't retry
        w.markNotificationFailed(ctx, job.Args.NotificationID, fmt.Sprintf("Rendering error: %v", err))
        return nil // Don't retry
    }

    // 4. Send via requested channels (respecting preferences)
    var channelsSent []string
    var channelsFailed []string
    var lastError error

    for _, channel := range job.Args.Channels {
        // Check if user has this channel enabled
        if !prefs.IsEnabled(channel) {
            log.Printf("[Job %d] Skipping channel %s (disabled by user)", job.ID, channel)
            continue
        }

        switch channel {
        case "email":
            if err := w.sendEmail(ctx, prefs.Email, rendered); err != nil {
                log.Printf("[Job %d] Failed to send email: %v", job.ID, err)
                channelsFailed = append(channelsFailed, "email")
                lastError = err
            } else {
                channelsSent = append(channelsSent, "email")
            }

        case "sms":
            // Phase 2: SMS implementation
            log.Printf("[Job %d] SMS channel not yet implemented", job.ID)
            channelsFailed = append(channelsFailed, "sms")

        default:
            log.Printf("[Job %d] Unknown channel: %s", job.ID, channel)
        }
    }

    // 5. Update notification status
    if len(channelsSent) > 0 {
        w.markNotificationSent(ctx, job.Args.NotificationID, channelsSent, channelsFailed)
        duration := time.Since(startTime)
        log.Printf("[Job %d] ✓ Notification sent successfully via %v in %v", job.ID, channelsSent, duration)
        return nil
    } else {
        // All channels failed - retry if transient error
        w.markNotificationFailed(ctx, job.Args.NotificationID, fmt.Sprintf("All channels failed: %v", lastError))
        if isTransientError(lastError) {
            return lastError // Retry
        }
        return nil // Don't retry permanent errors
    }
}

// getUserPreferences fetches user notification preferences
func (w *NotificationWorker) getUserPreferences(ctx context.Context, userID string) (*UserPreferences, error) {
    var prefs UserPreferences

    // Get email preference
    err := w.dbPool.QueryRow(ctx, `
        SELECT enabled, email_address
        FROM metadata.notification_preferences
        WHERE user_id = $1 AND channel = 'email'
    `, userID).Scan(&prefs.EmailEnabled, &prefs.Email)

    if err != nil {
        // If no preferences found, fall back to user's primary email
        err = w.dbPool.QueryRow(ctx, `
            SELECT email FROM metadata.civic_os_users WHERE id = $1
        `, userID).Scan(&prefs.Email)

        if err != nil {
            return nil, fmt.Errorf("user not found: %w", err)
        }
        prefs.EmailEnabled = true // Default to enabled
    }

    return &prefs, nil
}

type UserPreferences struct {
    Email        string
    EmailEnabled bool
    Phone        string
    SMSEnabled   bool
}

func (p *UserPreferences) IsEnabled(channel string) bool {
    switch channel {
    case "email":
        return p.EmailEnabled && p.Email != ""
    case "sms":
        return p.SMSEnabled && p.Phone != ""
    default:
        return false
    }
}

// loadTemplate fetches template from database
func (w *NotificationWorker) loadTemplate(ctx context.Context, templateName string) (*NotificationTemplate, error) {
    var tmpl NotificationTemplate
    err := w.dbPool.QueryRow(ctx, `
        SELECT subject_template, html_template, text_template, sms_template
        FROM metadata.notification_templates
        WHERE name = $1
    `, templateName).Scan(&tmpl.Subject, &tmpl.HTML, &tmpl.Text, &tmpl.SMS)

    if err != nil {
        return nil, fmt.Errorf("template '%s' not found: %w", templateName, err)
    }

    return &tmpl, nil
}

// sendEmail sends email via SMTP with STARTTLS
func (w *NotificationWorker) sendEmail(ctx context.Context, toEmail string, rendered *RenderedNotification) error {
    // Build MIME email with multipart/alternative (HTML + plain text)
    headers := make(map[string]string)
    headers["From"] = w.smtpConfig.From
    headers["To"] = toEmail
    headers["Subject"] = rendered.Subject
    headers["MIME-Version"] = "1.0"
    headers["Content-Type"] = "multipart/alternative; boundary=\"boundary123\""
    headers["Date"] = time.Now().Format(time.RFC1123Z)

    // Build email body with text and HTML parts
    var emailBody strings.Builder
    for key, value := range headers {
        emailBody.WriteString(fmt.Sprintf("%s: %s\r\n", key, value))
    }
    emailBody.WriteString("\r\n")
    emailBody.WriteString("--boundary123\r\n")
    emailBody.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
    emailBody.WriteString(rendered.Text)
    emailBody.WriteString("\r\n\r\n--boundary123\r\n")
    emailBody.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
    emailBody.WriteString(rendered.HTML)
    emailBody.WriteString("\r\n\r\n--boundary123--\r\n")

    // Connect to SMTP server
    serverAddr := net.JoinHostPort(w.smtpConfig.Host, w.smtpConfig.Port)
    conn, err := net.DialTimeout("tcp", serverAddr, 10*time.Second)
    if err != nil {
        return fmt.Errorf("dial failed: %w", err)
    }
    defer conn.Close()

    client, err := smtp.NewClient(conn, w.smtpConfig.Host)
    if err != nil {
        return fmt.Errorf("SMTP client creation failed: %w", err)
    }
    defer client.Close()

    // Start TLS if supported (STARTTLS)
    if ok, _ := client.Extension("STARTTLS"); ok {
        tlsConfig := &tls.Config{
            ServerName: w.smtpConfig.Host,
            MinVersion: tls.VersionTLS12,
        }
        if err = client.StartTLS(tlsConfig); err != nil {
            return fmt.Errorf("STARTTLS failed: %w", err)
        }
    }

    // Authenticate if credentials provided
    if w.smtpConfig.Username != "" && w.smtpConfig.Password != "" {
        auth := smtp.PlainAuth("", w.smtpConfig.Username, w.smtpConfig.Password, w.smtpConfig.Host)
        if err = client.Auth(auth); err != nil {
            return fmt.Errorf("SMTP authentication failed: %w", err)
        }
    }

    // Send email via SMTP protocol
    if err = client.Mail(w.smtpConfig.From); err != nil {
        return fmt.Errorf("MAIL FROM failed: %w", err)
    }
    if err = client.Rcpt(toEmail); err != nil {
        return fmt.Errorf("RCPT TO failed: %w", err)
    }

    writer, err := client.Data()
    if err != nil {
        return fmt.Errorf("DATA command failed: %w", err)
    }
    defer writer.Close()

    if _, err = writer.Write([]byte(emailBody.String())); err != nil {
        return fmt.Errorf("writing email body failed: %w", err)
    }

    return nil
}

// markNotificationSent updates notification status to 'sent'
func (w *NotificationWorker) markNotificationSent(ctx context.Context, notificationID string, channelsSent, channelsFailed []string) {
    _, err := w.dbPool.Exec(ctx, `
        UPDATE metadata.notifications
        SET status = 'sent',
            sent_at = NOW(),
            channels_sent = $2,
            channels_failed = $3
        WHERE id = $1
    `, notificationID, channelsSent, channelsFailed)

    if err != nil {
        log.Printf("Failed to update notification status: %v", err)
    }
}

// markNotificationFailed updates notification status to 'failed'
func (w *NotificationWorker) markNotificationFailed(ctx context.Context, notificationID string, errorMsg string) {
    _, err := w.dbPool.Exec(ctx, `
        UPDATE metadata.notifications
        SET status = 'failed',
            error_message = $2
        WHERE id = $1
    `, notificationID, errorMsg)

    if err != nil {
        log.Printf("Failed to update notification status: %v", err)
    }
}

// isTransientError determines if error should trigger retry
func isTransientError(err error) bool {
    if err == nil {
        return false
    }

    // Network errors, timeouts, SMTP temporary errors = retry
    // Invalid email, template errors, authentication failures = don't retry

    errStr := err.Error()

    // Transient errors (network, SMTP temporary)
    if contains(errStr, "timeout") ||
       contains(errStr, "connection") ||
       contains(errStr, "dial failed") ||
       contains(errStr, "connection refused") ||
       contains(errStr, "rate limit") {
        return true
    }

    // Permanent errors (authentication, invalid recipients)
    if contains(errStr, "invalid") ||
       contains(errStr, "not found") ||
       contains(errStr, "template") ||
       contains(errStr, "authentication failed") ||
       contains(errStr, "bad credentials") {
        return false
    }

    // Default to retry for unknown errors
    return true
}

func contains(s, substr string) bool {
    return len(s) >= len(substr) && (s == substr || len(s) > len(substr) && (s[:len(substr)] == substr || s[len(s)-len(substr):] == substr))
}
```

### renderer.go - Template Engine

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "html/template"
    "text/template"
)

type NotificationTemplate struct {
    Subject string
    HTML    string
    Text    string
    SMS     string
}

type RenderedNotification struct {
    Subject string
    HTML    string
    Text    string
    SMS     string
}

type Renderer struct {
    siteURL string
}

func NewRenderer(siteURL string) *Renderer {
    return &Renderer{siteURL: siteURL}
}

// RenderTemplate renders all template variants with entity data
func (r *Renderer) RenderTemplate(tmpl *NotificationTemplate, entityData json.RawMessage) (*RenderedNotification, error) {
    // Parse entity data into map
    var entity map[string]interface{}
    if err := json.Unmarshal(entityData, &entity); err != nil {
        return nil, fmt.Errorf("invalid entity_data JSON: %w", err)
    }

    // Build template context
    context := map[string]interface{}{
        "Entity": entity,
        "Metadata": map[string]string{
            "site_url": r.siteURL,
        },
    }

    // Render subject (text template)
    subject, err := r.renderText(tmpl.Subject, context)
    if err != nil {
        return nil, fmt.Errorf("subject render error: %w", err)
    }

    // Render HTML body
    html, err := r.renderHTML(tmpl.HTML, context)
    if err != nil {
        return nil, fmt.Errorf("HTML render error: %w", err)
    }

    // Render text body
    text, err := r.renderText(tmpl.Text, context)
    if err != nil {
        return nil, fmt.Errorf("text render error: %w", err)
    }

    // SMS (Phase 2)
    sms := ""
    if tmpl.SMS != "" {
        sms, err = r.renderText(tmpl.SMS, context)
        if err != nil {
            return nil, fmt.Errorf("SMS render error: %w", err)
        }
    }

    return &RenderedNotification{
        Subject: subject,
        HTML:    html,
        Text:    text,
        SMS:     sms,
    }, nil
}

// renderText renders text template (subject, text body, SMS)
func (r *Renderer) renderText(templateStr string, context map[string]interface{}) (string, error) {
    tmpl, err := texttemplate.New("template").Parse(templateStr)
    if err != nil {
        return "", err
    }

    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, context); err != nil {
        return "", err
    }

    return buf.String(), nil
}

// renderHTML renders HTML template with XSS protection
func (r *Renderer) renderHTML(templateStr string, context map[string]interface{}) (string, error) {
    tmpl, err := htmltemplate.New("template").Parse(templateStr)
    if err != nil {
        return "", err
    }

    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, context); err != nil {
        return "", err
    }

    return buf.String(), nil
}
```

### Dockerfile

```dockerfile
# Build stage
FROM golang:1.24-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app

# Copy go.mod and go.sum first for better caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o worker .

# Runtime stage
FROM alpine:3.20

RUN apk --no-cache add ca-certificates tzdata

# Create non-root user
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/worker .

RUN chown -R appuser:appuser /app

USER appuser

HEALTHCHECK --interval=30s --timeout=3s \
    CMD ps aux | grep -q worker || exit 1

CMD ["./worker"]
```

## Usage Examples

### Creating Notifications from Application Code

#### Example 1: Issue Assignment Notification

```sql
-- When assigning an issue to a user
UPDATE issues SET assigned_user_id = '123-456-789' WHERE id = 42;

-- Send notification
SELECT create_notification(
    p_user_id := '123-456-789',
    p_template_name := 'issue_created',
    p_entity_type := 'issues',
    p_entity_id := '42',
    p_entity_data := jsonb_build_object(
        'id', 42,
        'display_name', 'Pothole on Main St',
        'severity', 5,
        'description', 'Large pothole needs immediate attention'
    )
);
```

#### Example 2: Appointment Reminder

```sql
-- Send reminder 24 hours before appointment
SELECT create_notification(
    p_user_id := user_id,
    p_template_name := 'appointment_reminder',
    p_entity_type := 'appointments',
    p_entity_id := id::text,
    p_entity_data := jsonb_build_object(
        'id', id,
        'start_time', start_time,
        'location', location,
        'display_name', display_name
    )
)
FROM appointments
WHERE start_time BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'
  AND reminder_sent = FALSE;
```

#### Example 3: Embedded Relationships (Nested Data)

**Problem:** Template needs to display related entity data (e.g., status display name, assigned user name).

**Solution:** Manually join related tables and construct nested JSONB:

```sql
-- Notification with embedded status relationship
SELECT create_notification(
    p_user_id := i.assigned_user_id,
    p_template_name := 'issue_status_changed',
    p_entity_type := 'issues',
    p_entity_id := i.id::text,
    p_entity_data := jsonb_build_object(
        'id', i.id,
        'display_name', i.display_name,
        'severity', i.severity,
        'status', jsonb_build_object(
            'id', s.id,
            'display_name', s.display_name,
            'color', s.color
        ),
        'assigned_user', jsonb_build_object(
            'id', u.id,
            'display_name', u.display_name,
            'email', u.email
        )
    )
)
FROM issues i
JOIN statuses s ON i.status_id = s.id
JOIN civic_os_users u ON i.assigned_user_id = u.id
WHERE i.id = 42;
```

**Template with nested access:**

```handlebars
Subject: Issue status changed: {{.Entity.display_name}}

HTML:
<h2>Issue Status Updated</h2>
<p><strong>{{.Entity.display_name}}</strong></p>
<p>Status: <span style="background-color: {{.Entity.status.color}}; padding: 4px 8px;">
  {{.Entity.status.display_name}}
</span></p>
<p>Assigned to: {{.Entity.assigned_user.display_name}}</p>
<p><a href="{{.Metadata.site_url}}/view/issues/{{.Entity.id}}">View Issue</a></p>

Text:
Issue Status Updated

{{.Entity.display_name}}

Status: {{.Entity.status.display_name}}
Assigned to: {{.Entity.assigned_user.display_name}}

View at: {{.Metadata.site_url}}/view/issues/{{.Entity.id}}
```

**Go Template Nested Access:**

Go templates support deep nesting via dot notation:

```go
{{.Entity.field}}                    // Direct field
{{.Entity.status.display_name}}      // Nested object
{{.Entity.tags}}                     // Array
{{range .Entity.tags}}               // Iterate array
  - {{.name}}                        // Array element field
{{end}}
{{if .Entity.status}}                // Conditional on nested existence
  Status: {{.Entity.status.display_name}}
{{end}}
```

**Phase 2 Enhancement:** Add `get_entity_for_notification()` helper function to automatically fetch and embed relationships. See Phase 2 section below.

#### Example 4: Using Triggers for Automatic Notifications

```sql
-- Send notification when new issue is created
CREATE OR REPLACE FUNCTION notify_issue_created()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.assigned_user_id IS NOT NULL THEN
        PERFORM create_notification(
            p_user_id := NEW.assigned_user_id,
            p_template_name := 'issue_created',
            p_entity_type := 'issues',
            p_entity_id := NEW.id::text,
            p_entity_data := jsonb_build_object(
                'id', NEW.id,
                'display_name', NEW.display_name,
                'severity', NEW.severity
            )
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_issue_created_trigger
    AFTER INSERT ON issues
    FOR EACH ROW
    EXECUTE FUNCTION notify_issue_created();
```

### Managing User Preferences

```sql
-- Disable email notifications for a user
UPDATE metadata.notification_preferences
SET enabled = FALSE
WHERE user_id = current_user_id() AND channel = 'email';

-- Use custom email address
UPDATE metadata.notification_preferences
SET email_address = 'custom@example.com'
WHERE user_id = current_user_id() AND channel = 'email';

-- View user's notification history
SELECT
    n.created_at,
    n.template_name,
    n.status,
    n.channels_sent,
    t.description AS template_description
FROM metadata.notifications n
JOIN metadata.notification_templates t ON n.template_name = t.name
WHERE n.user_id = current_user_id()
ORDER BY n.created_at DESC
LIMIT 20;
```

### Creating Custom Templates

```sql
-- Add new template for password reset
INSERT INTO metadata.notification_templates (
    name,
    description,
    entity_type,
    subject_template,
    html_template,
    text_template
) VALUES (
    'password_reset',
    'Send password reset link to user',
    NULL,  -- No entity type needed
    'Reset your Civic OS password',
    '<h2>Password Reset Request</h2><p>Click the link below to reset your password:</p><p><a href="{{.Metadata.site_url}}/reset-password?token={{.Entity.reset_token}}">Reset Password</a></p><p>This link expires in 1 hour.</p>',
    'Password Reset Request\n\nClick the link below to reset your password:\n\n{{.Metadata.site_url}}/reset-password?token={{.Entity.reset_token}}\n\nThis link expires in 1 hour.'
);

-- Use the template
SELECT create_notification(
    p_user_id := '123-456-789',
    p_template_name := 'password_reset',
    p_entity_data := jsonb_build_object('reset_token', 'abc123xyz')
);
```

## Deployment

### Docker Compose Configuration

Add to `docker-compose.yml`:

```yaml
services:
  notification-worker:
    build:
      context: ./services/notification-worker-go
      dockerfile: Dockerfile
    container_name: civic-os-notification-worker
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://authenticator:${AUTHENTICATOR_PASSWORD}@postgres:5432/civic_os
      SMTP_HOST: ${SMTP_HOST:-email-smtp.us-east-1.amazonaws.com}
      SMTP_PORT: ${SMTP_PORT:-587}
      SMTP_USERNAME: ${SMTP_USERNAME}
      SMTP_PASSWORD: ${SMTP_PASSWORD}
      SMTP_FROM: ${SMTP_FROM:-noreply@civic-os.org}
      SITE_URL: http://localhost:4200
    depends_on:
      - postgres
    networks:
      - civic-os-network
```

### Local Development with Inbucket

**For local development**, all examples ship with **Inbucket** - a zero-config SMTP server with web UI:

- **No SMTP credentials required** - works out of the box with `docker-compose up`
- **Web UI**: View all sent emails at http://localhost:9100
- **SMTP Port**: 2500 (automatically configured in docker-compose.yml)
- **Mock data compatibility**: Mock generators use `@example.com` emails for easy testing

**Testing workflow:**
1. Start example: `cd examples/pothole && docker-compose up -d`
2. Trigger a notification (e.g., create an issue, update status)
3. View email at http://localhost:9100 → Click recipient email (`user@example.com`)

**No configuration needed** - docker-compose defaults to Inbucket. To override with production SMTP, set environment variables in `.env`.

### Production Environment Variables

For **production deployments**, configure real SMTP credentials:

```bash
# SMTP Configuration (vendor-agnostic)
# Works with AWS SES, SendGrid, Mailgun, Gmail, or any SMTP server
SMTP_HOST=email-smtp.us-east-1.amazonaws.com  # AWS SES endpoint (adjust region)
SMTP_PORT=587                                   # 587 for STARTTLS (recommended)
SMTP_USERNAME=AKIAIOSFODNN7EXAMPLE             # SMTP credentials
SMTP_PASSWORD=BGbLaM1234567890abcdefghijklmnopqrstuvwxyz1234
SMTP_FROM=noreply@civic-os.org                 # Verified sender email

# Application Configuration
SITE_URL=https://app.civic-os.org
DATABASE_URL=postgres://authenticator:password@postgres:5432/civic_os
```

### SMTP Email Provider Setup

The notification system uses standard SMTP protocol, allowing you to use **any email provider**:

#### AWS SES (via SMTP)
1. **Verify sender email** in AWS SES console: https://console.aws.amazon.com/ses/
2. **Create SMTP credentials** (IAM user with SES send permission)
3. **Move out of sandbox mode** for production (requires AWS support request)
4. **Configure DKIM and SPF** for deliverability
5. **SMTP endpoint**: `email-smtp.us-east-1.amazonaws.com` (adjust region)
6. **Port**: 587 (STARTTLS recommended)

#### SendGrid
1. **Create API key**: Settings → API Keys
2. **SMTP endpoint**: `smtp.sendgrid.net`
3. **Port**: 587
4. **Username**: `apikey` (literal string)
5. **Password**: Your SendGrid API key

#### Mailgun
1. **Get SMTP credentials**: Mailgun Dashboard → Domains → SMTP Credentials
2. **SMTP endpoint**: `smtp.mailgun.org`
3. **Port**: 587

#### Gmail (for testing only)
1. **Enable 2FA** and create App Password
2. **SMTP endpoint**: `smtp.gmail.com`
3. **Port**: 587
4. **Username**: Your Gmail address
5. **Password**: App Password (not account password)

### Monitoring

#### Queue Depth

```sql
-- Check notification queue depth
SELECT COUNT(*)
FROM metadata.river_job
WHERE kind = 'send_notification' AND state = 'available';
```

#### Failed Notifications

```sql
-- View failed notifications
SELECT
    n.id,
    n.user_id,
    u.email,
    n.template_name,
    n.error_message,
    n.created_at
FROM metadata.notifications n
JOIN metadata.civic_os_users u ON n.user_id = u.id
WHERE n.status = 'failed'
ORDER BY n.created_at DESC
LIMIT 20;
```

#### Notification Metrics

```sql
-- Daily notification volume by template
SELECT
    DATE(created_at) AS date,
    template_name,
    status,
    COUNT(*) AS count
FROM metadata.notifications
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(created_at), template_name, status
ORDER BY date DESC, count DESC;
```

## Future Phases

### Phase 2: SMS Support

- **Add Twilio/AWS SNS integration** (`channels/sms.go`)
- **Update templates** to include SMS variant (160 character limit)
- **Phone number validation** in user preferences
- **Delivery receipts** and error handling
- **Cost tracking** (SMS is expensive)

### Phase 2: Automatic Field Extraction

**Problem**: Currently, trigger functions manually build `entity_data` JSONB by explicitly listing each field:

```sql
jsonb_build_object(
    'id', NEW.id,
    'display_name', NEW."display_name",
    'severity_level', NEW.severity_level,  -- Easy to forget!
    'description', NEW.description
)
```

When templates reference new fields (e.g., `{{.Entity.severity_level}}`), integrators must remember to update the trigger function. This is error-prone and leads to missing data in notifications.

**Solution**: Automatically extract entity field references from templates during validation and use them to build `entity_data` dynamically.

#### Architecture

The automatic field extraction integrates with the existing validation flow:

1. **User edits template** in Template Editor → Real-time validation triggered
2. **Validation worker** (Go) parses template for syntax errors
3. **NEW: Field extraction** - Parse template AST to find `{{.Entity.field_name}}` references
4. **Store extracted fields** in `template_validation_results.extracted_fields`
5. **Frontend receives validation** → Merges extracted fields from all template parts
6. **User saves template** → `required_fields` array stored in `notification_templates` table
7. **Trigger function calls helper** → Helper builds JSONB with only required fields

**Key Benefits**:
- ✅ **Zero manual maintenance** - Template is single source of truth for required fields
- ✅ **Non-blocking** - Extraction happens during existing async validation (no new latency)
- ✅ **Automatic updates** - Change template → validation extracts new fields → next notification uses them
- ✅ **No over-fetching** - Only includes fields actually referenced in template

#### Database Schema Changes

```sql
-- 1. Add required_fields column to templates table
ALTER TABLE metadata.notification_templates
ADD COLUMN required_fields TEXT[] DEFAULT '{}';

COMMENT ON COLUMN metadata.notification_templates.required_fields IS
  'Entity fields referenced in templates (auto-extracted during validation)';

-- 2. Add extracted_fields to validation results
ALTER TABLE metadata.template_validation_results
ADD COLUMN extracted_fields TEXT[] DEFAULT '{}';

COMMENT ON COLUMN metadata.template_validation_results.extracted_fields IS
  'Entity fields referenced in this template part';
```

#### Go Worker Implementation

**1. Add Field Extraction to Renderer** (`renderer.go`):

```go
import (
    "text/template/parse"
    "sort"
)

// ExtractEntityFields parses template and extracts {{.Entity.field_name}} references
func (r *Renderer) ExtractEntityFields(templateStr string) ([]string, error) {
    tmpl, err := textTemplate.New("parser").Parse(templateStr)
    if err != nil {
        return nil, err
    }

    fields := make(map[string]bool) // Use map to deduplicate

    // Walk AST to find {{.Entity.field_name}} references
    if tmpl.Tree != nil && tmpl.Tree.Root != nil {
        r.extractFieldsFromNode(tmpl.Tree.Root, fields)
    }

    // Convert map to sorted slice
    result := []string{}
    for field := range fields {
        result = append(result, field)
    }
    sort.Strings(result)

    return result, nil
}

func (r *Renderer) extractFieldsFromNode(node parse.Node, fields map[string]bool) {
    switch n := node.(type) {
    case *parse.ActionNode:
        if n.Pipe != nil {
            for _, cmd := range n.Pipe.Cmds {
                for _, arg := range cmd.Args {
                    if field, ok := r.extractEntityField(arg); ok {
                        fields[field] = true
                    }
                }
            }
        }
    case *parse.IfNode:
        if n.Pipe != nil {
            r.extractFieldsFromNode(n.Pipe, fields)
        }
        if n.List != nil {
            r.extractFieldsFromList(n.List, fields)
        }
        if n.ElseList != nil {
            r.extractFieldsFromList(n.ElseList, fields)
        }
    case *parse.RangeNode:
        if n.List != nil {
            r.extractFieldsFromList(n.List, fields)
        }
        if n.ElseList != nil {
            r.extractFieldsFromList(n.ElseList, fields)
        }
    case *parse.ListNode:
        r.extractFieldsFromList(n, fields)
    }
}

func (r *Renderer) extractFieldsFromList(list *parse.ListNode, fields map[string]bool) {
    if list != nil {
        for _, node := range list.Nodes {
            r.extractFieldsFromNode(node, fields)
        }
    }
}

func (r *Renderer) extractEntityField(arg parse.Node) (string, bool) {
    field, ok := arg.(*parse.FieldNode)
    if !ok {
        return "", false
    }

    // Check if it starts with "Entity"
    // Template: {{.Entity.severity_level}} → field.Ident = ["Entity", "severity_level"]
    if len(field.Ident) >= 2 && field.Ident[0] == "Entity" {
        return field.Ident[1], true
    }

    return "", false
}
```

**2. Update Validation Worker** (`validation_worker.go`):

```go
// Add extracted_fields to ValidationPartResult
type ValidationPartResult struct {
    PartName        string
    Valid           bool
    ErrorMessage    string
    ExtractedFields []string  // NEW
}

// Update validatePart to extract fields
func (w *ValidationWorker) validatePart(partName, template string, isHTML bool) ValidationPartResult {
    // Existing validation
    err := w.renderer.ValidateTemplate(template, isHTML)

    if err != nil {
        return ValidationPartResult{
            PartName:     partName,
            Valid:        false,
            ErrorMessage: err.Error(),
        }
    }

    // NEW: Extract entity fields
    fields, err := w.renderer.ExtractEntityFields(template)
    if err != nil {
        // Extraction failed, but template is valid - log warning
        log.Printf("Warning: Could not extract fields from %s: %v", partName, err)
    }

    return ValidationPartResult{
        PartName:        partName,
        Valid:           true,
        ExtractedFields: fields,  // NEW
    }
}

// Update storeValidationResult to save extracted fields
func (w *ValidationWorker) storeValidationResult(
    ctx context.Context,
    validationID string,
    result ValidationPartResult,
) {
    _, err := w.dbPool.Exec(ctx, `
        UPDATE metadata.template_validation_results
        SET valid = $3,
            error_message = $4,
            extracted_fields = $5  -- NEW
        WHERE validation_id = $1 AND part_name = $2
    `, validationID, result.PartName, result.Valid, result.ErrorMessage, result.ExtractedFields)

    if err != nil {
        log.Printf("Failed to store validation result: %v", err)
    }
}
```

#### PostgreSQL Function Updates

**1. Update `get_validation_results` RPC**:

```sql
CREATE OR REPLACE FUNCTION get_validation_results(p_validation_id TEXT)
RETURNS TABLE (
    status TEXT,
    part_name TEXT,
    valid BOOLEAN,
    error_message TEXT,
    extracted_fields TEXT[]  -- NEW
)
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
BEGIN
    -- Check if all parts are validated
    IF (SELECT COUNT(*) FROM metadata.template_validation_results
        WHERE validation_id = p_validation_id AND valid IS NOT NULL) =
       (SELECT COUNT(*) FROM metadata.template_validation_results
        WHERE validation_id = p_validation_id) THEN

        -- Validation completed
        RETURN QUERY
        SELECT
            'completed'::TEXT as status,
            r.part_name,
            r.valid,
            r.error_message,
            r.extracted_fields  -- NEW
        FROM metadata.template_validation_results r
        WHERE r.validation_id = p_validation_id
        ORDER BY r.part_name;
    ELSE
        -- Still pending
        RETURN QUERY
        SELECT
            'pending'::TEXT,
            NULL::TEXT,
            NULL::BOOLEAN,
            NULL::TEXT,
            NULL::TEXT[];
    END IF;
END;
$$;
```

**2. Create Helper Function for Trigger Usage**:

```sql
CREATE OR REPLACE FUNCTION build_entity_data_for_template(
    p_template_name TEXT,
    p_entity_table TEXT,
    p_entity_id TEXT
) RETURNS JSONB
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_required_fields TEXT[];
    v_result JSONB := '{}'::jsonb;
    v_field TEXT;
    v_query TEXT;
BEGIN
    -- Get required fields from template
    SELECT required_fields INTO v_required_fields
    FROM metadata.notification_templates
    WHERE name = p_template_name;

    IF v_required_fields IS NULL OR array_length(v_required_fields, 1) = 0 THEN
        RAISE WARNING 'Template % has no required_fields - did you save after validation?', p_template_name;
        RETURN '{}'::jsonb;
    END IF;

    -- Build SELECT clause with only required fields
    v_query := format(
        'SELECT row_to_json(t) FROM (SELECT %s FROM %I WHERE id = $1) t',
        array_to_string(
            array(SELECT quote_ident(unnest) FROM unnest(v_required_fields)),
            ', '
        ),
        p_entity_table
    );

    EXECUTE v_query INTO v_result USING p_entity_id;

    RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION build_entity_data_for_template TO authenticated;

COMMENT ON FUNCTION build_entity_data_for_template IS
    'Builds entity_data JSONB with only fields required by template. Fields auto-extracted during template validation.';
```

#### Frontend Changes

**1. Update TypeScript Interfaces** (`notification.service.ts`):

```typescript
export interface ValidationResult {
  part_name: string;
  valid: boolean;
  error_message?: string;
  extracted_fields?: string[];  // NEW
}

export interface ValidationStatusResponse {
  status: string;
  part_name?: string;
  valid?: boolean;
  error_message?: string;
  extracted_fields?: string[];  // NEW
}
```

**2. Update Template Editor Component** (`template-editor.component.ts`):

```typescript
export class TemplateEditorComponent {
  // ... existing code ...

  // NEW: Track all extracted fields
  private allExtractedFields = signal<string[]>([]);

  private setupValidation(): void {
    const fieldsToValidate = ['subject_template', 'html_template', 'text_template', 'sms_template'];

    fieldsToValidate.forEach(field => {
      const subject = new Subject<void>();
      this.validationSubjects.set(field, subject);

      subject.pipe(debounceTime(500)).subscribe(() => {
        this.validateField(field);
      });

      this.templateForm.get(field)?.valueChanges.subscribe(() => {
        subject.next();
      });
    });
  }

  private validateField(fieldName: string): void {
    // ... existing validation code ...

    this.notificationService.validateTemplateParts(parts).subscribe({
      next: (results) => {
        // Store validation results
        const resultsMap = new Map(this.validationResults());
        results.forEach(result => {
          resultsMap.set(result.part_name, result);
        });
        this.validationResults.set(resultsMap);

        // NEW: Merge extracted fields from all template parts
        const allFields = new Set<string>();
        results.forEach(r => {
          if (r.extracted_fields) {
            r.extracted_fields.forEach(f => allFields.add(f));
          }
        });
        this.allExtractedFields.set(Array.from(allFields).sort());

        // Clear validating state
        const validatingSet = new Set(this.validating());
        validatingSet.delete(fieldName);
        this.validating.set(validatingSet);
      },
      // ... error handling ...
    });
  }

  onSubmit(): void {
    if (this.templateForm.invalid) {
      this.templateForm.markAllAsTouched();
      return;
    }

    this.saving.set(true);
    this.saveError.set(undefined);

    // Include extracted fields in form submission
    const formValue = {
      ...this.templateForm.value,
      required_fields: this.allExtractedFields()  // NEW
    };

    if (this.template) {
      this.notificationService.updateTemplate(this.template.id, formValue).subscribe({
        // ... existing handlers ...
      });
    } else {
      this.notificationService.createTemplate(formValue).subscribe({
        // ... existing handlers ...
      });
    }
  }
}
```

#### Updated Trigger Usage

**Before (Phase 1 - Manual)**:

```sql
CREATE FUNCTION notify_issue_created() RETURNS TRIGGER AS $$
DECLARE
    v_issue_data JSONB;
BEGIN
    IF NEW."created_user" IS NOT NULL THEN
        -- Manual JSONB construction - easy to forget fields!
        SELECT jsonb_build_object(
            'id', NEW.id,
            'display_name', NEW."display_name",
            'location', NEW.location,
            'severity_level', NEW.severity_level,  -- Forgot this initially!
            'description', NEW.description,
            'status', jsonb_build_object(
                'id', s.id,
                'display_name', s."display_name"
            )
        )
        INTO v_issue_data
        FROM "IssueStatus" s
        WHERE s.id = NEW."status";

        PERFORM create_notification(
            p_user_id := NEW."created_user",
            p_template_name := 'issue_created',
            p_entity_type := 'issues',
            p_entity_id := NEW.id::text,
            p_entity_data := v_issue_data,
            p_channels := ARRAY['email']
        );
    END IF;
    RETURN NEW;
END;
$$;
```

**After (Phase 2 - Automatic)**:

```sql
CREATE FUNCTION notify_issue_created() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."created_user" IS NOT NULL THEN
        -- Automatic field selection based on template
        PERFORM create_notification(
            p_user_id := NEW."created_user",
            p_template_name := 'issue_created',
            p_entity_type := 'Issue',  -- Table name
            p_entity_id := NEW.id::text,
            p_entity_data := build_entity_data_for_template(
                'issue_created',  -- Template name
                'Issue',          -- Table name
                NEW.id::text      -- Entity ID
            ),
            p_channels := ARRAY['email']
        );
    END IF;
    RETURN NEW;
END;
$$;
```

**Benefits**:
- Template references new field → Validation extracts it → Next notification includes it automatically
- No manual JSONB construction
- No risk of forgetting fields
- Template is single source of truth

#### Handling Foreign Key Relationships

**Current limitation**: `build_entity_data_for_template()` only fetches scalar fields. Templates that reference nested relationships (e.g., `{{.Entity.status.display_name}}`) won't work.

**Phase 2 Enhancement**: Extend helper to auto-detect and embed foreign key relationships:

```sql
CREATE OR REPLACE FUNCTION build_entity_data_for_template(
    p_template_name TEXT,
    p_entity_table TEXT,
    p_entity_id TEXT
) RETURNS JSONB AS $$
DECLARE
    v_required_fields TEXT[];
    v_result JSONB;
    v_fk_column TEXT;
    v_fk_table TEXT;
    v_fk_id TEXT;
    v_related_data JSONB;
BEGIN
    -- Get required fields
    SELECT required_fields INTO v_required_fields
    FROM metadata.notification_templates
    WHERE name = p_template_name;

    -- Fetch entity with required fields
    -- ... (same as before) ...

    -- Auto-embed foreign key relationships
    -- Example: status_id → status: {id: X, display_name: "Open"}
    FOR v_fk_column IN
        SELECT column_name FROM unnest(v_required_fields) AS column_name
        WHERE column_name LIKE '%_id'
    LOOP
        -- Look up FK relationship in schema_properties
        SELECT join_table INTO v_fk_table
        FROM schema_properties
        WHERE table_name = p_entity_table AND column_name = v_fk_column;

        IF v_fk_table IS NOT NULL THEN
            -- Get FK value from entity
            v_fk_id := v_result->>v_fk_column;

            IF v_fk_id IS NOT NULL THEN
                -- Fetch related entity
                EXECUTE format(
                    'SELECT jsonb_build_object(''id'', id, ''display_name'', display_name)
                     FROM %I WHERE id = $1',
                    v_fk_table
                ) INTO v_related_data USING v_fk_id;

                -- Replace status_id with status: {id, display_name}
                v_result := jsonb_set(
                    v_result,
                    ARRAY[regexp_replace(v_fk_column, '_id$', '')],
                    v_related_data
                );
            END IF;
        END IF;
    END LOOP;

    RETURN v_result;
END;
$$;
```

This allows templates to use `{{.Entity.status.display_name}}` without manual JOINs in the trigger.

#### Validation and Error Handling

**1. Edge Case: Template Saved Without Validation**

If a template is created via direct SQL INSERT or validation is bypassed:

```sql
-- Add CHECK constraint to prevent empty required_fields
ALTER TABLE metadata.notification_templates
ADD CONSTRAINT required_fields_not_empty
CHECK (required_fields IS NOT NULL AND array_length(required_fields, 1) > 0);
```

**2. Edge Case: Field Doesn't Exist in Entity**

If template references non-existent field (typo or schema change):

```sql
-- Helper function validates fields exist before querying
CREATE OR REPLACE FUNCTION validate_required_fields(
    p_table_name TEXT,
    p_required_fields TEXT[]
) RETURNS BOOLEAN AS $$
DECLARE
    v_missing_fields TEXT[];
BEGIN
    SELECT array_agg(field)
    INTO v_missing_fields
    FROM unnest(p_required_fields) field
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = p_table_name AND column_name = field
    );

    IF array_length(v_missing_fields, 1) > 0 THEN
        RAISE WARNING 'Template references non-existent fields: %', v_missing_fields;
        RETURN FALSE;
    END IF;

    RETURN TRUE;
END;
$$;
```

Call this during notification creation to fail gracefully if schema changes break templates.

#### Migration Path

**Step 1**: Add database columns and functions (backward compatible)
**Step 2**: Deploy Go worker with field extraction
**Step 3**: Deploy frontend with `required_fields` in save
**Step 4**: Re-save existing templates to populate `required_fields`
**Step 5**: Update trigger functions to use `build_entity_data_for_template()`

**Backward Compatibility**: Old trigger functions continue working with manual `jsonb_build_object()`. New triggers can use helper immediately.

### Phase 3: Advanced Features

#### Notification Digests

```sql
-- Batch notifications by user and send daily digest
CREATE TABLE metadata.notification_digests (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES civic_os_users(id),
    frequency VARCHAR(20) NOT NULL,  -- 'daily', 'weekly'
    send_at TIME NOT NULL,           -- e.g., '09:00:00'
    last_sent_at TIMESTAMPTZ,
    enabled BOOLEAN NOT NULL DEFAULT TRUE
);

-- Cron function to generate digests
CREATE OR REPLACE FUNCTION send_daily_digests()
RETURNS void AS $$
BEGIN
    -- For each user with daily digest enabled
    -- Collect pending notifications
    -- Render digest template
    -- Send single email with all notifications
    -- Mark notifications as sent
END;
$$ LANGUAGE plpgsql;
```

#### Per-Template Preferences

```sql
-- Allow users to disable specific notification types
ALTER TABLE metadata.notification_preferences
ADD COLUMN disabled_templates TEXT[];

-- Example: Disable comment notifications
UPDATE metadata.notification_preferences
SET disabled_templates = array_append(disabled_templates, 'comment_added')
WHERE user_id = current_user_id();
```

#### Quiet Hours

```sql
-- Don't send notifications during user's quiet hours
ALTER TABLE metadata.notification_preferences
ADD COLUMN quiet_hours_start TIME,
ADD COLUMN quiet_hours_end TIME,
ADD COLUMN timezone VARCHAR(50);

-- Worker checks quiet hours before sending
```

#### Notification History UI

Create Angular page at `/notifications` showing user's notification history with:
- List of sent notifications
- Read/unread status
- Deep links to related entities
- Preference management UI

#### Unsubscribe Links

```sql
-- Generate unsubscribe token
CREATE TABLE metadata.unsubscribe_tokens (
    token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES civic_os_users(id),
    template_name VARCHAR(100),  -- NULL = unsubscribe from all
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add to email footer
-- <a href="{{.Metadata.site_url}}/unsubscribe/{{.Entity.unsubscribe_token}}">Unsubscribe</a>
```

#### Bounce/Complaint Handling

```sql
-- Track bounced emails to avoid sending to invalid addresses
CREATE TABLE metadata.email_bounces (
    email email_address PRIMARY KEY,
    bounce_type VARCHAR(20),  -- 'hard', 'soft', 'complaint'
    bounced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- SNS webhook endpoint to receive SES bounce notifications
-- Worker checks bounce list before sending
```

## Testing

### Manual Testing

```bash
# 1. Start services
docker-compose up -d postgres notification-worker

# 2. Create test notification
psql $DATABASE_URL -c "
SELECT create_notification(
    p_user_id := (SELECT id FROM civic_os_users LIMIT 1),
    p_template_name := 'issue_created',
    p_entity_type := 'issues',
    p_entity_id := '1',
    p_entity_data := '{\"id\": 1, \"display_name\": \"Test Issue\", \"severity\": 3}'::jsonb
);
"

# 3. Check worker logs
docker logs -f civic-os-notification-worker

# 4. Verify notification status
psql $DATABASE_URL -c "SELECT * FROM metadata.notifications ORDER BY created_at DESC LIMIT 1;"
```

### Integration Tests

```go
// Test template rendering
func TestRenderTemplate(t *testing.T) {
    renderer := NewRenderer("http://localhost:4200")

    template := &NotificationTemplate{
        Subject: "Issue: {{.Entity.display_name}}",
        HTML:    "<p>Severity: {{.Entity.severity}}</p>",
        Text:    "Severity: {{.Entity.severity}}",
    }

    entityData := []byte(`{"display_name": "Test Issue", "severity": 5}`)

    rendered, err := renderer.RenderTemplate(template, entityData)
    assert.NoError(t, err)
    assert.Equal(t, "Issue: Test Issue", rendered.Subject)
    assert.Contains(t, rendered.HTML, "Severity: 5")
}
```

## Security Considerations

1. **RLS Policies**: Users can only see their own notifications
2. **Template Injection**: Use Go's `html/template` for XSS protection
3. **Email Spoofing**: DKIM/SPF configured in AWS SES
4. **Rate Limiting**: River queue limits concurrent workers (30)
5. **PII Protection**: Notification records contain user emails - enforce RLS
6. **Unsubscribe Compliance**: Include unsubscribe link (CAN-SPAM Act)

## Performance Tuning

### Worker Concurrency

```go
// Adjust based on load testing
Queues: map[string]river.QueueConfig{
    "notifications": {MaxWorkers: 30},  // 20-50 for SES rate limits
}
```

### Database Indexes

Already included in schema:
- `idx_notifications_user_id` - User history queries
- `idx_notifications_status` - Failed notification queries
- `idx_notifications_created_at` - Time-based queries

### SES Rate Limits

- **Sandbox**: 1 email/second, 200/day
- **Production**: 14 emails/second (default), request increase if needed
- Worker automatically retries on rate limit (transient error)

### Template Caching

Future optimization: Cache compiled templates in memory to avoid re-parsing.

## Troubleshooting

### Notifications Not Sending

```sql
-- Check River job queue
SELECT id, state, errors, attempt, max_attempts
FROM metadata.river_job
WHERE kind = 'send_notification'
ORDER BY scheduled_at DESC
LIMIT 10;

-- Check notification status
SELECT * FROM metadata.notifications WHERE status = 'failed';
```

### Template Rendering Errors

```bash
# Check worker logs for template syntax errors
docker logs civic-os-notification-worker | grep "render error"
```

### SES Authentication Errors

```bash
# Verify AWS credentials
docker exec civic-os-notification-worker env | grep AWS

# Test SES access
aws ses verify-email-identity --email-address test@example.com
```

## Considerations Before Building

Before implementing the notification system, review these important considerations organized by priority and complexity.

### ✅ Phase 1: Must-Have (Build Now)

#### 1. Template Preview with Sample Data (Phase 1 - Critical)

**Decision:** Include in Phase 1. Essential for good UX, especially HTML preview.

**Why:**
- Admins need to see rendered output before saving (catch formatting errors)
- HTML preview in iframe shows visual appearance (margins, colors, responsiveness)
- Sample data validation ensures template works with actual entity structure
- Without preview, template errors only surface when notifications fail in production

**Implementation:** Add `preview_template_parts()` RPC function with high priority validation:

```sql
CREATE OR REPLACE FUNCTION preview_template_parts(
    p_subject_template TEXT,
    p_html_template TEXT,
    p_text_template TEXT,
    p_sample_entity_data JSONB
)
RETURNS TABLE(
    part_name TEXT,
    rendered_output TEXT,
    error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_validation_id UUID := gen_random_uuid();
    -- Similar polling pattern to validate_template_parts()
    -- But worker returns RENDERED output instead of just validation errors
BEGIN
    -- Implementation similar to validate_template_parts()
    -- Worker job kind: 'preview_template_parts'
    -- Returns both validation status AND rendered output
END;
$$;
```

**Frontend UI:**

```typescript
// Template editor with live preview
<div class="grid grid-cols-2 gap-4">
  <!-- Left: Template editor -->
  <div>
    <textarea formControlName="html_template"></textarea>
    <button (click)="previewTemplate()">Preview</button>
  </div>

  <!-- Right: Live preview -->
  <div class="preview-panel">
    <h3>Subject Preview:</h3>
    <p>{{ preview.subject }}</p>

    <h3>HTML Preview:</h3>
    <iframe [srcdoc]="preview.html" sandbox="allow-same-origin"></iframe>

    <h3>Text Preview:</h3>
    <pre>{{ preview.text }}</pre>
  </div>
</div>
```

**Sample Data Input:** Provide JSONB input field for sample entity data, with examples for common entity types.

#### 2. Template Documentation

**Decision:** No seed templates in migration. Focus on excellent documentation instead.

**Why:** Civic OS is a meta-framework - notification templates are domain-specific (issues, appointments, etc.). Seed templates would be meaningless without domain context.

**Alternative Approach:** Comprehensive template examples in documentation and migration comments:

```sql
-- Example templates for common use cases (commented, not inserted):

-- Example 1: Issue Assignment Notification
-- INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template) VALUES
-- ('issue_created', 'Notify assigned user when issue is created', 'issues',
--     'New issue assigned: {{.Entity.display_name}}',
--     '<h2>New Issue Assigned</h2><p>You have been assigned to: <strong>{{.Entity.display_name}}</strong></p>{{if .Entity.severity}}<p>Severity: {{.Entity.severity}}/5</p>{{end}}<p><a href="{{.Metadata.site_url}}/view/issues/{{.Entity.id}}">View Issue</a></p>',
--     'New Issue Assigned\n\nYou have been assigned to: {{.Entity.display_name}}\n{{if .Entity.severity}}Severity: {{.Entity.severity}}/5\n{{end}}\nView at: {{.Metadata.site_url}}/view/issues/{{.Entity.id}}'
-- );

-- Example 2: Appointment Reminder
-- INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template) VALUES
-- ('appointment_reminder', 'Remind user of upcoming appointment', 'appointments',
--     'Reminder: Appointment on {{.Entity.start_time}}',
--     '<h2>Appointment Reminder</h2><p>You have an appointment scheduled for <strong>{{.Entity.start_time}}</strong></p><p>Location: {{.Entity.location}}</p>',
--     'Appointment Reminder\n\nYou have an appointment scheduled for {{.Entity.start_time}}\nLocation: {{.Entity.location}}'
-- );
```

**INTEGRATOR_GUIDE.md** will include detailed template creation guide with copy-paste examples for common scenarios.

#### 3. Template Permissions

**Decision:** Admin-only

Templates can only be created/edited by users with `is_admin()` = true. This is enforced via RLS policies on `metadata.notification_templates`.

```sql
-- Already included in schema (see Permissions section)
CREATE POLICY "Admins manage templates" ON metadata.notification_templates
    FOR ALL TO authenticated USING (is_admin());
```

**Future:** Add role-based permissions like `notification_templates:write` in Phase 2 if needed.

#### 4. Missing Field Handling

**Decision:** Lenient mode

Templates use `template.Option("missingkey=zero")` - missing fields return zero value instead of failing.

**Implementation:**

```go
// In worker when parsing templates
tmpl, err := texttemplate.New("subject").Option("missingkey=zero").Parse(templateStr)
```

**Behavior:**
- `{{.Entity.severity}}` with missing field → empty string (zero value)
- `{{.Entity.count}}` with missing field → 0
- Template still renders successfully

**Why:** Better user experience - notifications don't fail due to minor data issues. Templates should use `{{if .Entity.severity}}` checks for optional fields.

**Phase 2 Enhancement:** Require Entity schema attachment to templates. When creating/editing template, admin specifies expected entity_type (e.g., "issues"). Validation worker can then validate that all referenced fields exist in that entity's schema, providing better error messages at template creation time rather than at notification send time.

#### 5. SMTP Email Configuration

**Status:** Vendor-agnostic SMTP implementation - works with any email provider.

**Implementation:** Go worker uses Go's standard library (`net/smtp`) with STARTTLS support for secure email delivery. No external dependencies beyond stdlib.

**Supported Providers:**
- **AWS SES** (via SMTP): email-smtp.us-east-1.amazonaws.com:587
- **SendGrid**: smtp.sendgrid.net:587
- **Mailgun**: smtp.mailgun.org:587
- **Gmail** (testing): smtp.gmail.com:587
- **Custom SMTP servers**: Any standard SMTP server

**Configuration (via environment variables):**
- `SMTP_HOST`: SMTP server hostname
- `SMTP_PORT`: SMTP port (587 for STARTTLS recommended)
- `SMTP_USERNAME`: SMTP authentication username
- `SMTP_PASSWORD`: SMTP authentication password
- `SMTP_FROM`: Sender email address (must be verified by provider)

**AWS SES Setup (if using AWS SES):**
1. **Verify sender email** in AWS SES console: https://console.aws.amazon.com/ses/
2. **Create SMTP credentials** (IAM user with SES send permission)
3. **Sandbox vs Production Mode:**
   - Sandbox: 200 emails/day, only to verified addresses
   - Production: 50,000 emails/day, any recipient (requires support request)
4. **Configure SPF/DKIM** for deliverability:
   ```
   v=spf1 include:amazonses.com ~all
   ```

#### 6. Rate Limiting Strategy

**Problem:** Email providers have rate limits (AWS SES: 14 emails/second, SendGrid: varies by plan).

**Current Handling:** Worker `sendEmail()` returns error on rate limit → River retries with exponential backoff.

**Improvements for Phase 2:**
- Add `pg_sleep(0.1)` between emails in burst scenarios
- Track rate limit in shared state (Redis or database)
- Implement token bucket algorithm for smoother flow

#### 7. Error Classification

**Critical:** Distinguish transient vs. permanent errors to avoid wasting retries.

**Transient (retry):**
- Network timeouts (dial failed, connection refused)
- SMTP temporary errors (rate limits)
- Database connection errors

**Permanent (don't retry):**
- Invalid email address (550 error)
- Template syntax errors
- Template not found
- User not found

**Implementation:** `isTransientError()` function checks error codes/messages.

### 🔄 Phase 2: Important (Build Soon)

#### 8. Bounce Handling

**Problem:** Emails to invalid addresses fail silently, waste resources, hurt sender reputation.

**Solution:** AWS SES SNS notifications for bounces/complaints:

```sql
CREATE TABLE metadata.email_bounces (
    email email_address PRIMARY KEY,
    bounce_type VARCHAR(20),  -- 'hard', 'soft', 'complaint'
    bounced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bounce_count INT NOT NULL DEFAULT 1
);
```

Worker checks bounce list before sending. Hard bounces (invalid email) are never retried.

#### 9. Unsubscribe Mechanism

**Legal Requirement:** CAN-SPAM Act requires one-click unsubscribe for marketing emails.

**Implementation:**

```sql
-- Generate unsubscribe tokens
CREATE TABLE metadata.unsubscribe_tokens (
    token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES civic_os_users(id),
    template_name VARCHAR(100),  -- NULL = unsubscribe from all
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add to template context
-- {{.Metadata.unsubscribe_url}}
```

Add footer to all email templates:
```html
<p><a href="{{.Metadata.unsubscribe_url}}">Unsubscribe</a></p>
```

Frontend page at `/unsubscribe/{token}` updates preferences.

#### 10. Template Versioning

**Problem:** Template changes are destructive. No way to rollback or see history.

**Solution Option 1: Simple Audit Log**

```sql
CREATE TABLE metadata.notification_template_versions (
    id BIGSERIAL PRIMARY KEY,
    template_name VARCHAR(100) NOT NULL,
    subject_template TEXT NOT NULL,
    html_template TEXT NOT NULL,
    text_template TEXT NOT NULL,
    sms_template TEXT,
    created_by UUID REFERENCES civic_os_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger to snapshot on UPDATE
CREATE TRIGGER snapshot_template_on_update...
```

**Solution Option 2: Temporal Tables** (PostgreSQL 17+) - automatic history tracking.

#### 11. Per-Template User Preferences

**Use Case:** User wants issue notifications but not comment notifications.

**Implementation:**

```sql
ALTER TABLE metadata.notification_preferences
ADD COLUMN disabled_templates TEXT[];

-- User disables specific template
UPDATE metadata.notification_preferences
SET disabled_templates = array_append(disabled_templates, 'comment_added')
WHERE user_id = current_user_id();
```

Worker checks array before sending.

#### 12. Auto-Fetch Helper for Embedded Relationships

**Problem:** Manually constructing nested JSONB with JOIN statements is tedious and error-prone (see Example 3 in Usage Examples).

**Solution:** Add helper function that automatically fetches entity with embedded relationships:

```sql
CREATE OR REPLACE FUNCTION get_entity_for_notification(
    p_entity_type TEXT,
    p_entity_id TEXT,
    p_embed_relationships TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_entity_data JSONB;
    v_fk_column TEXT;
    v_fk_table TEXT;
    v_fk_value TEXT;
    v_related_data JSONB;
BEGIN
    -- 1. Fetch base entity as JSONB
    EXECUTE format(
        'SELECT row_to_json(t.*) FROM %I t WHERE id = $1',
        p_entity_type
    ) INTO v_entity_data USING p_entity_id;

    -- 2. If embed_relationships specified, fetch and nest related entities
    IF p_embed_relationships IS NOT NULL THEN
        FOREACH v_fk_column IN ARRAY p_embed_relationships LOOP
            -- Look up foreign key metadata from schema_properties
            SELECT
                sp.join_table,
                v_entity_data->>v_fk_column
            INTO v_fk_table, v_fk_value
            FROM schema_properties sp
            WHERE sp.table_name = p_entity_type
              AND sp.column_name = v_fk_column;

            IF v_fk_table IS NOT NULL AND v_fk_value IS NOT NULL THEN
                -- Fetch related entity's display fields
                EXECUTE format(
                    'SELECT jsonb_build_object(''id'', id, ''display_name'', display_name)
                     FROM %I WHERE id = $1',
                    v_fk_table
                ) INTO v_related_data USING v_fk_value;

                -- Replace FK ID with nested object
                -- Change column name from status_id to status
                v_entity_data := jsonb_set(
                    v_entity_data,
                    ARRAY[regexp_replace(v_fk_column, '_id$', '')],
                    v_related_data
                );
            END IF;
        END LOOP;
    END IF;

    RETURN v_entity_data;
END;
$$;

GRANT EXECUTE ON FUNCTION get_entity_for_notification TO authenticated;

COMMENT ON FUNCTION get_entity_for_notification IS
    'Fetches entity with embedded relationships for notification templates. Automatically joins related entities and constructs nested JSONB.';
```

**Usage - Before (Phase 1):**

```sql
-- Manual JOIN and nested JSONB construction
SELECT create_notification(
    p_user_id := i.assigned_user_id,
    p_template_name := 'issue_status_changed',
    p_entity_type := 'issues',
    p_entity_id := i.id::text,
    p_entity_data := jsonb_build_object(
        'id', i.id,
        'display_name', i.display_name,
        'status', jsonb_build_object('id', s.id, 'display_name', s.display_name),
        'assigned_user', jsonb_build_object('id', u.id, 'display_name', u.display_name)
    )
)
FROM issues i
JOIN statuses s ON i.status_id = s.id
JOIN civic_os_users u ON i.assigned_user_id = u.id
WHERE i.id = 42;
```

**Usage - After (Phase 2):**

```sql
-- Automatic relationship embedding
SELECT create_notification(
    p_user_id := assigned_user_id,
    p_template_name := 'issue_status_changed',
    p_entity_type := 'issues',
    p_entity_id := '42',
    p_entity_data := get_entity_for_notification(
        'issues',
        '42',
        ARRAY['status_id', 'assigned_user_id']  -- Auto-embed these relationships
    )
)
FROM issues WHERE id = 42;
```

**Benefits:**
- No manual JOINs required
- No manual nested JSONB construction
- Less boilerplate code
- Uses SchemaService metadata to discover relationships
- Consistent field naming (status_id → status)

**Template usage remains identical:**
```handlebars
Status: {{.Entity.status.display_name}}
Assigned to: {{.Entity.assigned_user.display_name}}
```

**Important: Snapshot Semantics**

The auto-fetch helper executes **at notification creation time**, not send time. The `entity_data` JSONB is a snapshot of the entity state when the event occurred.

**Why this is correct:**

```
T=0s:  Issue status changes Open → Closed
T=0s:  create_notification() called
T=0s:  get_entity_for_notification() fetches issue with status="Closed"
T=0s:  entity_data stored: {status: {display_name: "Closed"}}
T=5s:  Status changes AGAIN to "Reopened" (entity mutates)
T=10s: Worker sends notification with status="Closed" (from snapshot)
```

**This is intentional:**
- Notifications document **events** ("status changed to Closed"), not current state
- Snapshot provides audit trail of what triggered the notification
- Users click link to see **current** state (fresh query)
- If entity changes multiple times, each notification reflects its triggering event

**Edge Case:** If River queue is backlogged and notifications take hours to send, data may be very stale. This indicates operational issues (monitor queue depth). The notification is still technically correct - it reflects the state when the event occurred.

**When to use fresh data:** If you need guaranteed fresh data, don't embed relationships - just pass entity ID and have the template link to the detail page where users see current state.

#### 13. Notification History UI

**Features:**
- List of notifications sent to current user
- Read/unread status
- Links to related entities
- Resend functionality (for failed notifications)

**Page:** `/notifications` (Angular component)

```typescript
// List user's notification history
dataService.getData('metadata.notifications', {
  filter: `user_id=eq.${currentUserId}`,
  order: 'created_at.desc',
  limit: 50
})
```

### 🚀 Phase 3: Advanced (Future)

#### 13. Notification Scheduling

**Use Case:** Send appointment reminder 24 hours before, not immediately.

**Implementation:** Add `send_at` timestamp:

```sql
ALTER TABLE metadata.notifications
ADD COLUMN send_at TIMESTAMPTZ DEFAULT NOW();

-- Trigger only enqueues if send_at <= NOW()
CREATE OR REPLACE FUNCTION enqueue_notification_job()
...
    IF NEW.send_at <= NOW() THEN
        -- Enqueue immediately
    ELSE
        -- Skip, will be picked up by scheduled job
    END IF;
...
```

Cron job runs every minute to enqueue pending notifications:

```sql
SELECT create_notification_job(id)
FROM metadata.notifications
WHERE send_at <= NOW() AND status = 'pending';
```

#### 14. Digest/Batching

**Use Case:** Daily summary email instead of 20 individual notifications.

**Implementation:**

```sql
CREATE TABLE metadata.notification_digests (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES civic_os_users(id),
    frequency VARCHAR(20) NOT NULL,  -- 'daily', 'weekly'
    send_at TIME NOT NULL,           -- e.g., '09:00:00'
    last_sent_at TIMESTAMPTZ,
    enabled BOOLEAN NOT NULL DEFAULT FALSE
);
```

Cron job aggregates pending notifications into single email using digest template.

#### 15. Quiet Hours

**Use Case:** Don't send notifications between 10 PM - 8 AM user's local time.

**Implementation:**

```sql
ALTER TABLE metadata.notification_preferences
ADD COLUMN quiet_hours_start TIME,
ADD COLUMN quiet_hours_end TIME,
ADD COLUMN timezone VARCHAR(50);
```

Worker checks quiet hours before sending, delays notification until quiet period ends.

#### 16. Email Analytics

**Features:** Track opens, clicks, conversions.

**Implementation:**
- AWS SES Event Publishing (SNS → Lambda → Database)
- Embed tracking pixel in HTML emails
- Wrap links with redirect tracker

**Privacy:** Requires user consent, may conflict with privacy regulations (GDPR).

#### 17. Multi-Language Support (i18n)

**Problem:** Notifications should match user's preferred language.

**Solution Option 1:** Multiple templates per language:
- `issue_created_en`, `issue_created_es`, `issue_created_fr`

**Solution Option 2:** JSON translation files:

```sql
ALTER TABLE metadata.notification_templates
ADD COLUMN translations JSONB;  -- {"en": {...}, "es": {...}}
```

Worker selects template variant based on `user.preferred_language`.

#### 18. Attachment Support

**Use Case:** Send invoice PDF, report attachment.

**Implementation:** Reference files from `metadata.files` table:

```sql
ALTER TABLE metadata.notifications
ADD COLUMN attachment_ids BIGINT[];  -- Array of file IDs
```

Worker fetches presigned URLs and attaches to email via SES `Attachments` parameter.

**Limitation:** SES has 10 MB total message size limit.

#### 19. Priority Levels

**Use Case:** Urgent security alerts bypass rate limits, jump queue.

**Implementation:** Use River job priority:

```sql
-- Urgent notification
INSERT INTO metadata.river_job (..., priority) VALUES (..., 50);

-- Normal notification
INSERT INTO metadata.river_job (..., priority) VALUES (..., 1);

-- Low priority (digest)
INSERT INTO metadata.river_job (..., priority) VALUES (..., 0);
```

Workers process high-priority jobs first.

#### 20. Template Caching

**When:** Notification volume exceeds 50,000/day.

**Implementation:** Simple TTL cache in worker:

```go
type NotificationWorker struct {
    // ... existing fields ...
    templateCache sync.Map  // map[string]*ParsedTemplate
}

func (w *NotificationWorker) getTemplate(name string) (*ParsedTemplate, error) {
    // Check cache
    if cached, ok := w.templateCache.Load(name); ok {
        return cached.(*ParsedTemplate), nil
    }

    // Cache miss - fetch, parse, cache
    template := w.loadAndParseTemplate(name)
    w.templateCache.Store(name, template)

    // Expire after 5 minutes
    go func() {
        time.Sleep(5 * time.Minute)
        w.templateCache.Delete(name)
    }()

    return template, nil
}
```

### Decision Matrix

| Feature | Priority | Complexity | Phase | Impact | Status |
|---------|----------|------------|-------|--------|--------|
| Template validation | Must-have | Medium | 1 | Critical | ✅ Designed |
| Template preview | Must-have | Medium | 1 | High UX improvement | ✅ Approved |
| Template documentation | Must-have | Low | 1 | Reduces friction | ✅ Approved |
| Template permissions | Must-have | Low | 1 | Security requirement | ✅ Admin-only |
| Missing field handling | Must-have | Low | 1 | Prevents errors | ✅ Lenient mode |
| AWS SES setup | Must-have | Medium | 1 | Required for email | ✅ Account ready |
| Error classification | Must-have | Low | 1 | Smart retries | ✅ Designed |
| Rate limiting | Important | Medium | 2 | Prevents throttling | Phase 2 |
| Bounce handling | Important | Medium | 2 | Improves deliverability | Phase 2 |
| Unsubscribe | Important | Low | 2 | Legal requirement | Phase 2 |
| Template versioning | Important | Medium | 2 | Audit/rollback | Phase 2 |
| Auto-fetch helper | Important | Low | 2 | Reduces boilerplate | Phase 2 |
| History UI | Important | Medium | 2 | User visibility | Phase 2 |
| Entity schema attachment | Important | Medium | 2 | Better validation | Phase 2 |
| Scheduling | Advanced | Medium | 3 | Nice-to-have | Phase 3 |
| Digests | Advanced | High | 3 | Reduces noise | Phase 3 |
| Quiet hours | Advanced | Low | 3 | User preference | Phase 3 |
| Analytics | Advanced | High | 3 | Marketing feature | Phase 3 |
| i18n | Advanced | High | 3 | Global users | Phase 3 |
| Attachments | Advanced | Medium | 3 | Specific use case | Phase 3 |
| Priority levels | Advanced | Low | 3 | Already via River | Phase 3 |
| Template caching | Advanced | Low | 3 | 50k+/day only | Phase 3 |

### Summary Recommendation

**Phase 1 Scope (Build Now):**
- ✅ **Template validation** with per-part validation (already designed)
- ✅ **Template preview** with sample data and HTML iframe (critical UX feature)
- ✅ **Admin-only permissions** (RLS policies already in schema)
- ✅ **Lenient missing field handling** (`missingkey=zero` option)
- ✅ **AWS SES integration** (account available, SMTP interface)
- ✅ **Basic error handling** (transient vs permanent error classification)
- ✅ **Comprehensive documentation** (template examples in migration comments)

**Phase 1 Timeline:** ~2-3 weeks development

**Provides:**
- Core notification sending capability
- Real-time template validation as users type
- Visual HTML preview before saving
- Multi-channel foundation (email now, SMS Phase 2)
- Production-ready error handling and retries

**Defer to Phase 2 (~2 weeks):**
- Bounce handling (track invalid emails)
- Unsubscribe mechanism (CAN-SPAM compliance)
- Template versioning (audit history)
- Auto-fetch helper (automatic embedded relationships - no manual JOINs)
- Notification history UI (`/notifications` page)
- Entity schema attachment (validate field references at template creation time)

**Defer to Phase 3 (~4-6 weeks, diminishing returns):**
- Scheduling, digests, quiet hours
- Email analytics (opens, clicks)
- Multi-language support (i18n)
- Attachments, priority levels
- Template caching (only needed at 50k+ notifications/day)

## References

- **River Documentation**: https://riverqueue.com/docs
- **AWS SES Developer Guide**: https://docs.aws.amazon.com/ses/
- **Go Template Package**: https://pkg.go.dev/text/template
- **Civic OS Microservices Guide**: `docs/development/GO_MICROSERVICES_GUIDE.md`
- **File Storage Architecture**: `docs/development/FILE_STORAGE.md`

## Deployment Checklist

### Prerequisites

- [ ] PostgreSQL database with Civic OS v0.11.0+ schema
- [ ] AWS account with SES access
- [ ] Verified sender email address in AWS SES
- [ ] AWS IAM credentials with SES send permissions

### Deployment Steps

1. **Apply Database Migration**
   ```bash
   # Via Sqitch (recommended)
   sqitch deploy v0-11-0-add-notifications

   # Or via migrations container
   docker run --rm \
     -e DATABASE_URL="postgres://user:pass@host:5432/db" \
     ghcr.io/civic-os/migrations:v0.11.0 deploy
   ```

2. **Configure Environment Variables**
   ```bash
   # Required
   DATABASE_URL=postgres://authenticator:password@postgres:5432/civic_os
   S3_REGION=us-east-1
   AWS_SES_FROM_EMAIL=noreply@your-domain.com
   SITE_URL=https://app.your-domain.com

   # AWS Credentials (use IAM role in production)
   S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
   S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
   ```

3. **Deploy Notification Worker**
   ```yaml
   # docker-compose.yml
   services:
     notification-worker:
       image: ghcr.io/civic-os/notification-worker-go:v0.11.0
       # Or build from source:
       # build:
       #   context: ./services/notification-worker-go
       restart: unless-stopped
       environment:
         DATABASE_URL: ${DATABASE_URL}
         SMTP_HOST: ${SMTP_HOST}
         SMTP_PORT: ${SMTP_PORT}
         SMTP_USERNAME: ${SMTP_USERNAME}
         SMTP_PASSWORD: ${SMTP_PASSWORD}
         SMTP_FROM: ${SMTP_FROM}
         SITE_URL: ${SITE_URL}
       depends_on:
         - postgres
   ```

4. **Verify SMTP Configuration**
   ```bash
   # Test SMTP connection (if using AWS SES)
   aws ses verify-email-identity --email-address noreply@your-domain.com

   # Check verification status (AWS SES)
   aws ses get-identity-verification-attributes \
     --identities noreply@your-domain.com

   # Test SMTP connectivity (generic)
   telnet your-smtp-host.com 587
   # Should see: 220 [SMTP server banner]
   ```

5. **Create Example Templates** (Optional)
   ```bash
   # Run example template script
   psql $DATABASE_URL < examples/pothole/init-scripts/08_notification_templates.sql
   ```

6. **Test Notification Sending**
   ```sql
   -- Send test notification
   SELECT create_notification(
       p_user_id := current_user_id(),
       p_template_name := 'issue_created',
       p_entity_type := 'issues',
       p_entity_id := '1',
       p_entity_data := '{"id": 1, "display_name": "Test Issue", "severity": 3}'::jsonb
   );

   -- Verify notification created
   SELECT * FROM metadata.notifications ORDER BY created_at DESC LIMIT 1;

   -- Check worker processed it
   SELECT state, errors FROM metadata.river_job
   WHERE kind = 'send_notification' ORDER BY id DESC LIMIT 1;
   ```

### Production Considerations

1. **Email Provider Production Access** (if using AWS SES)
   - AWS SES starts in sandbox mode (200 emails/day, verified recipients only)
   - Request production access via AWS Support ticket
   - Production mode: 50,000 emails/day, any recipient

2. **Configure SPF and DKIM** (provider-specific)

   **AWS SES:**
   ```
   # Add SPF to DNS
   v=spf1 include:amazonses.com ~all
   ```
   - Enable DKIM signing in AWS SES console
   - Add DKIM CNAME records to DNS

   **SendGrid:**
   - Domain Authentication in SendGrid dashboard
   - Add provided CNAME records to DNS

   **Mailgun:**
   - Verify domain in Mailgun dashboard
   - Add provided DNS records

3. **Set Up Bounce/Complaint Handling** (Phase 2)
   - Configure provider webhooks for bounces and complaints
   - Create webhook endpoint to update `metadata.email_bounces`

4. **Monitor Queue Depth**
   ```sql
   -- Alert if queue depth > 1000
   SELECT COUNT(*) FROM metadata.river_job
   WHERE kind = 'send_notification' AND state = 'available';
   ```

5. **Set Up Log Aggregation**
   - Worker logs to stdout (structured JSON recommended)
   - Integrate with CloudWatch, Datadog, or ELK stack

## Troubleshooting

### Notifications Not Sending

**Symptom**: Notifications stuck in `pending` status, River jobs not processing.

**Diagnosis:**
```sql
-- Check River job queue
SELECT id, state, errors, attempt, max_attempts, scheduled_at
FROM metadata.river_job
WHERE kind = 'send_notification'
ORDER BY scheduled_at DESC LIMIT 10;

-- Check notification status
SELECT id, status, error_message, created_at
FROM metadata.notifications
WHERE status IN ('pending', 'failed')
ORDER BY created_at DESC LIMIT 10;
```

**Common Causes:**
1. **Worker not running**: `docker ps | grep notification-worker`
2. **Database connection failed**: Check `DATABASE_URL` and network connectivity
3. **River schema mismatch**: Ensure migrations applied to `metadata` schema
4. **Trigger not firing**: Verify `enqueue_notification_job_trigger` exists on `metadata.notifications`

**Fix:**
```bash
# Restart worker
docker-compose restart notification-worker

# Check worker logs
docker logs -f civic-os-notification-worker

# Verify trigger exists
psql $DATABASE_URL -c "
  SELECT tgname FROM pg_trigger
  WHERE tgrelid = 'metadata.notifications'::regclass;
"
```

### Template Validation Timeout

**Symptom**: Frontend shows "Template validation timeout (>10 seconds)" error.

**Cause**: ValidationWorker is overloaded or not running.

**Diagnosis:**
```sql
-- Check validation job processing
SELECT state, COUNT(*)
FROM metadata.river_job
WHERE kind = 'validate_template_parts'
GROUP BY state;

-- Check for stuck jobs
SELECT id, state, errors, attempt, scheduled_at
FROM metadata.river_job
WHERE kind = 'validate_template_parts' AND state = 'running'
  AND scheduled_at < NOW() - INTERVAL '1 minute';
```

**Fix:**
- Validation jobs have priority=4 (should process instantly)
- If queue is backlogged, increase worker concurrency or deploy additional workers
- Check worker logs for Go template parsing errors

### SMTP Authentication Errors

**Symptom**: Notifications fail with "SMTP authentication failed" or "bad credentials" errors.

**Diagnosis:**
```bash
# Check SMTP environment variables in worker
docker exec civic-os-notification-worker env | grep SMTP

# Test SMTP connection manually
telnet $SMTP_HOST $SMTP_PORT
# Should see: 220 [server banner]

# Check worker logs for detailed error
docker logs civic-os-notification-worker | grep -i "authentication"
```

**Fix:**
1. **Verify SMTP credentials** are correct:
   - AWS SES: Use SMTP credentials (not IAM access keys)
   - SendGrid: Username is literal string `apikey`
   - Gmail: Use App Password (not account password)
2. **Check SMTP_HOST and SMTP_PORT** are correct for your provider
3. **Ensure credentials not expired** (rotate/regenerate if needed)
4. **Test connectivity**: Use `telnet` or `openssl s_client` to verify server is reachable

### Email Not Delivered (Bounces)

**Symptom**: Notification marked as `sent` but email never arrives.

**Diagnosis:**
```sql
-- Check sent notifications
SELECT user_id, u.email, n.sent_at, n.channels_sent
FROM metadata.notifications n
JOIN metadata.civic_os_users u ON n.user_id = u.id
WHERE n.status = 'sent'
ORDER BY n.sent_at DESC LIMIT 10;
```

**Common Causes:**
1. **Provider in sandbox/restricted mode**: Some providers restrict recipients initially
   - AWS SES: Sandbox mode only allows verified recipients
   - SendGrid: Free tier may have restrictions
2. **SPF/DKIM not configured**: Emails flagged as spam
3. **Invalid recipient email**: Typo in email address
4. **Rate limit exceeded**: Provider throttling (varies by provider/plan)

**Fix:**
1. **Verify recipient email** (if provider requires it):
   ```bash
   # AWS SES sandbox mode
   aws ses verify-email-identity --email-address recipient@example.com
   ```
2. **Check sending statistics** (provider-specific):
   ```bash
   # AWS SES
   aws ses get-send-statistics

   # SendGrid
   curl -X GET "https://api.sendgrid.com/v3/stats" \
     -H "Authorization: Bearer $SENDGRID_API_KEY"
   ```
3. **Review bounce notifications** (if configured via webhooks)
4. **Check spam folder** on recipient side

### Template Rendering Errors

**Symptom**: Notification fails with "Template render error" in `error_message`.

**Diagnosis:**
```sql
-- Find failed notifications with template errors
SELECT template_name, error_message, COUNT(*)
FROM metadata.notifications
WHERE status = 'failed' AND error_message LIKE '%render error%'
GROUP BY template_name, error_message;

-- Inspect specific notification
SELECT entity_data, error_message
FROM metadata.notifications
WHERE id = <notification_id>;
```

**Common Causes:**
1. **Invalid entity_data JSON**: Malformed JSONB passed to `create_notification()`
2. **Template syntax error**: Unclosed `{{if}}`, typo in field name
3. **Missing nested field**: Template accesses `{{.Entity.status.display_name}}` but `status` is NULL

**Fix:**
1. **Test template with validation RPC**:
   ```sql
   SELECT * FROM validate_template_parts(
       p_subject_template := 'Issue: {{.Entity.display_name}}',
       p_html_template := '<p>{{.Entity.description}}</p>'
   );
   ```

2. **Use preview RPC with real entity data**:
   ```sql
   SELECT * FROM preview_template_parts(
       p_subject_template := 'Issue: {{.Entity.display_name}}',
       p_html_template := '<p>{{.Entity.description}}</p>',
       p_sample_entity_data := '{"display_name": "Test", "description": "Test desc"}'::jsonb
   );
   ```

3. **Add conditionals for optional fields**:
   ```handlebars
   {{if .Entity.status}}
     Status: {{.Entity.status.display_name}}
   {{end}}
   ```

### Worker Memory/Performance Issues

**Symptom**: Worker consuming excessive memory or processing notifications slowly.

**Diagnosis:**
```bash
# Check worker resource usage
docker stats civic-os-notification-worker

# Check River worker metrics
psql $DATABASE_URL -c "
  SELECT
    state,
    COUNT(*) as count,
    AVG(EXTRACT(EPOCH FROM (finalized_at - scheduled_at))) as avg_duration_sec
  FROM metadata.river_job
  WHERE kind = 'send_notification' AND finalized_at IS NOT NULL
  GROUP BY state;
"
```

**Fix:**
1. **Adjust worker concurrency**: Reduce `MaxWorkers` if memory constrained
2. **Check template complexity**: Large HTML templates with many embedded images
3. **Monitor SES rate limits**: Add `pg_sleep(0.1)` between bulk sends if hitting throttles

### Preview Not Updating in UI

**Symptom**: Template editor preview shows stale content or doesn't update.

**Cause**: Debounce timing, stale validation results, or browser caching.

**Fix:**
1. **Check network requests**: DevTools → Network tab → Filter for `preview_template_parts` RPC calls
2. **Clear validation results**: Cleanup function runs hourly, or manually:
   ```sql
   DELETE FROM metadata.template_validation_results
   WHERE created_at < NOW() - INTERVAL '1 hour';
   ```
3. **Verify iframe sandbox**: Check browser console for Content Security Policy errors

### High Queue Depth / Backlog

**Symptom**: Thousands of pending notifications in River queue.

**Diagnosis:**
```sql
-- Check queue depth by kind
SELECT kind, state, COUNT(*)
FROM metadata.river_job
WHERE state IN ('available', 'running')
GROUP BY kind, state;

-- Check oldest pending job
SELECT kind, scheduled_at, errors
FROM metadata.river_job
WHERE state = 'available'
ORDER BY scheduled_at ASC LIMIT 1;
```

**Causes:**
1. **Worker insufficient capacity**: Too many notifications, too few workers
2. **Rate limit throttling**: AWS SES blocking sends
3. **Failing jobs retrying**: Permanent errors not classified correctly

**Fix:**
1. **Scale workers horizontally**: Deploy multiple worker instances
2. **Increase worker concurrency**: Adjust `MaxWorkers` config
3. **Review failed jobs**: Identify and fix permanent errors
   ```sql
   SELECT errors, COUNT(*)
   FROM metadata.river_job
   WHERE state = 'retryable' AND kind = 'send_notification'
   GROUP BY errors;
   ```

---

**Document Status**: ✅ Implemented in v0.11.0
**Last Updated**: 2025-11-07
**Author**: Civic OS Team

**Architecture Summary:**
- **No caching** in Phase 1 (parse fresh every time, ~10-50μs per template)
- **Per-part validation** (subject/HTML/text/SMS independently for real-time feedback)
- **Synchronous RPC + River queue** (no HTTP endpoints, consistent with microservices pattern)
- **Three workers**: NotificationWorker (priority 1), ValidationWorker (priority 4), PreviewWorker (priority 4)

**Phase 1 Implementation (Complete):**
1. ✅ **Database Schema**: 5 tables, 6 RPC functions, 2 triggers
2. ✅ **Go Notification Worker**: 3 River workers (send, validate, preview)
3. ✅ **Angular Service**: CRUD operations, validation, preview
4. ✅ **Template Management UI**: List, create, edit, delete with real-time validation
5. ✅ **Template Editor**: Two-column layout with live HTML preview
6. ✅ **Example Templates**: Pothole domain (issue_created, issue_status_changed)
7. ✅ **Docker Integration**: Notification worker service in all docker-compose.yml files
8. ✅ **Documentation**: Complete deployment and troubleshooting guides

**Phase 1 Features:**
- Multi-channel notifications (email Phase 1, SMS Phase 2)
- Go template engine (text/html) with XSS protection
- Real-time validation with 500ms debouncing
- HTML preview in sandboxed iframe
- AWS SES email delivery with error classification
- Template permissions (admin-only via RLS)
- User notification preferences
- Automatic retry with exponential backoff
- Polymorphic entity references
