# Notification System Architecture

**Status**: Design phase - not yet implemented

**Version**: 0.11.0 (planned)

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
5. **Template System** - Go templates with HTML/Text/SMS variants
6. **Channel Adapters** - Email (AWS SES), SMS (AWS SNS/Twilio)

## Template Engine Selection

### Chosen Solution: Go's Native Templates

The notification system uses **Go's built-in `text/template` and `html/template` packages** for template rendering. This choice provides:

- ✅ **Zero external dependencies** - Part of Go's standard library
- ✅ **Security by default** - `html/template` auto-escapes HTML to prevent XSS
- ✅ **Context-aware escaping** - Different escaping for HTML, JS, CSS, URLs
- ✅ **Performance** - Compiled templates cached in memory
- ✅ **Simplicity** - No additional dependencies to manage

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

## Go Worker Implementation

### Service Structure

```
services/notification-worker-go/
├── main.go              # River client setup, graceful shutdown
├── worker.go            # NotificationWorker implementation
├── renderer.go          # Template rendering engine
├── channels/
│   ├── email.go         # AWS SES email sender
│   └── sms.go           # SMS sender (stub for Phase 2)
├── go.mod
├── go.sum
├── Dockerfile
└── README.md
```

### Dependencies (go.mod)

```go
module github.com/civic-os/notification-worker-go

go 1.24

require (
    github.com/aws/aws-sdk-go-v2 v1.39.5
    github.com/aws/aws-sdk-go-v2/config v1.28.0
    github.com/aws/aws-sdk-go-v2/service/ses v1.30.0      // Email
    github.com/aws/aws-sdk-go-v2/service/sns v1.35.0      // SMS (Phase 2)
    github.com/jackc/pgx/v5 v5.7.6
    github.com/riverqueue/river v0.25.0
    github.com/riverqueue/river/riverdriver/riverpgxv5 v0.25.0
)
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

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/ses"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river"
    "github.com/riverqueue/river/riverdriver/riverpgxv5"
)

func main() {
    ctx := context.Background()

    // 1. Load configuration from environment
    databaseURL := getEnv("DATABASE_URL", "postgres://authenticator:password@localhost:5432/civic_os")
    siteURL := getEnv("SITE_URL", "http://localhost:4200")
    fromEmail := getEnv("AWS_SES_FROM_EMAIL", "noreply@civic-os.org")
    awsRegion := getEnv("S3_REGION", "us-east-1")

    log.Printf("🚀 Civic OS Notification Worker starting...")
    log.Printf("   Site URL: %s", siteURL)
    log.Printf("   From Email: %s", fromEmail)
    log.Printf("   AWS Region: %s", awsRegion)

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

    // 3. Initialize AWS SES client
    cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(awsRegion))
    if err != nil {
        log.Fatalf("Failed to load AWS config: %v", err)
    }
    sesClient := ses.NewFromConfig(cfg)
    log.Println("✓ AWS SES client initialized")

    // 4. Create template renderer
    renderer := NewRenderer(siteURL)

    // 5. Register River workers
    workers := river.NewWorkers()
    river.AddWorker(workers, &NotificationWorker{
        dbPool:    dbPool,
        renderer:  renderer,
        sesClient: sesClient,
        fromEmail: fromEmail,
    })

    // 6. Create River client
    riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
        Queues: map[string]river.QueueConfig{
            "notifications": {MaxWorkers: 30}, // I/O-bound, but rate-limited by SES
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
    "encoding/json"
    "fmt"
    "log"
    "time"

    "github.com/aws/aws-sdk-go-v2/service/ses"
    "github.com/aws/aws-sdk-go-v2/service/ses/types"
    "github.com/aws/aws-sdk-go/aws"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river"
)

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
    dbPool    *pgxpool.Pool
    renderer  *Renderer
    sesClient *ses.Client
    fromEmail string
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

// sendEmail sends email via AWS SES
func (w *NotificationWorker) sendEmail(ctx context.Context, toEmail string, rendered *RenderedNotification) error {
    input := &ses.SendEmailInput{
        Source: aws.String(w.fromEmail),
        Destination: &types.Destination{
            ToAddresses: []string{toEmail},
        },
        Message: &types.Message{
            Subject: &types.Content{
                Data:    aws.String(rendered.Subject),
                Charset: aws.String("UTF-8"),
            },
            Body: &types.Body{
                Html: &types.Content{
                    Data:    aws.String(rendered.HTML),
                    Charset: aws.String("UTF-8"),
                },
                Text: &types.Content{
                    Data:    aws.String(rendered.Text),
                    Charset: aws.String("UTF-8"),
                },
            },
        },
    }

    _, err := w.sesClient.SendEmail(ctx, input)
    return err
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

    // Network errors, timeouts, rate limits = retry
    // Invalid email, template errors = don't retry

    // Simplified - in production, check specific AWS error codes
    errStr := err.Error()

    // Transient errors
    if contains(errStr, "timeout") || contains(errStr, "connection") || contains(errStr, "rate limit") {
        return true
    }

    // Permanent errors
    if contains(errStr, "invalid") || contains(errStr, "not found") || contains(errStr, "template") {
        return false
    }

    // Default to retry
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

#### Example 3: Using Triggers for Automatic Notifications

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
      S3_REGION: us-east-1
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY}
      AWS_SES_FROM_EMAIL: noreply@civic-os.org
      SITE_URL: http://localhost:4200
    depends_on:
      - postgres
    networks:
      - civic-os-network
```

### Environment Variables

```bash
# AWS SES Configuration
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_SES_FROM_EMAIL=noreply@civic-os.org

# Application Configuration
SITE_URL=https://app.civic-os.org
DATABASE_URL=postgres://authenticator:password@postgres:5432/civic_os
```

### AWS SES Setup

1. **Verify sender email address** in AWS SES console
2. **Move out of sandbox mode** for production (requires AWS support request)
3. **Configure DKIM and SPF** for deliverability
4. **Set up bounce/complaint handling** (future enhancement)

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

## References

- **River Documentation**: https://riverqueue.com/docs
- **AWS SES Developer Guide**: https://docs.aws.amazon.com/ses/
- **Go Template Package**: https://pkg.go.dev/text/template
- **Civic OS Microservices Guide**: `docs/development/GO_MICROSERVICES_GUIDE.md`
- **File Storage Architecture**: `docs/development/FILE_STORAGE.md`

---

**Document Status**: Design phase - implementation pending v0.11.0 release
**Last Updated**: 2025-01-05
**Author**: Civic OS Team
