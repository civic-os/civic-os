# Notification Worker Service (Go + River + AWS SES)

A Go microservice that sends multi-channel notifications (email, SMS) with template validation and preview in Civic OS. Uses River (PostgreSQL-based job queue) for reliable, at-least-once delivery with automatic retries.

## Features

- ✅ **At-least-once delivery** - Notifications survive crashes and restarts
- ✅ **Automatic retries** - Exponential backoff (max 5 attempts for emails)
- ✅ **Multi-channel** - Email (AWS SES), SMS (Phase 2)
- ✅ **Go templates** - text/template and html/template with XSS protection
- ✅ **Real-time validation** - Template syntax checking via high-priority jobs
- ✅ **HTML preview** - Render templates with sample data before saving
- ✅ **User preferences** - Per-user channel enable/disable, custom email addresses
- ✅ **Graceful shutdown** - Completes in-flight jobs before stopping
- ✅ **Horizontal scaling** - Run multiple instances for high throughput

## Architecture

```
Angular creates notification
  ↓
create_notification() RPC
  ↓
metadata.notifications INSERT
  ↓
Trigger inserts River job (send_notification)
  ↓
NotificationWorker claims job (priority 1)
  ↓
1. Fetch user preferences
2. Load template from database
3. Render template with entity data
4. Send via AWS SES
5. Update notification status
```

### Three Workers in One Service

| Worker | Priority | Purpose |
|--------|----------|---------|
| **NotificationWorker** | 1 (normal) | Send actual notifications via email/SMS |
| **ValidationWorker** | 100 (high) | Validate template syntax (real-time feedback) |
| **PreviewWorker** | 100 (high) | Render templates with sample data (HTML preview) |

High-priority jobs (validation/preview) are processed before queued notifications, enabling instant feedback in the UI without delaying actual sends.

## Prerequisites

- **Go 1.23+**
- **PostgreSQL 17** with River schema (v0.11.0+ migration)
- **AWS SES** configured (production mode, moved out of sandbox)
- **AWS credentials** (via environment variables or IAM role)

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://authenticator:password@localhost:5432/civic_os` |
| `SITE_URL` | Frontend URL (for email links) | `http://localhost:4200` |
| `AWS_SES_FROM_EMAIL` | "From" email address (must be verified in SES) | `noreply@civic-os.org` |
| `S3_REGION` | AWS region for SES | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS access key (or use IAM role) | - |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (or use IAM role) | - |

## Development

### Build

```bash
go build -o notification-worker
```

### Run Locally

```bash
export DATABASE_URL="postgres://authenticator:password@localhost:5432/civic_os"
export SITE_URL="http://localhost:4200"
export AWS_SES_FROM_EMAIL="noreply@civic-os.org"
export S3_REGION="us-east-1"
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"

./notification-worker
```

### Run with Docker Compose

The service is included in `docker-compose.yml` for local development:

```bash
docker-compose up -d notification-worker
docker-compose logs -f notification-worker
```

## Production Deployment

### Docker

```bash
docker build -t civic-os/notification-worker:0.11.0 .
docker run -d \
  -e DATABASE_URL="postgres://user:pass@host:5432/civic_os" \
  -e SITE_URL="https://your-app.com" \
  -e AWS_SES_FROM_EMAIL="noreply@your-app.com" \
  -e S3_REGION="us-east-1" \
  -e AWS_ACCESS_KEY_ID="..." \
  -e AWS_SECRET_ACCESS_KEY="..." \
  --name notification-worker \
  civic-os/notification-worker:0.11.0
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notification-worker
spec:
  replicas: 2  # Scale based on notification volume
  selector:
    matchLabels:
      app: notification-worker
  template:
    metadata:
      labels:
        app: notification-worker
    spec:
      containers:
      - name: notification-worker
        image: civic-os/notification-worker:0.11.0
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: civic-os-secrets
              key: database-url
        - name: SITE_URL
          value: "https://your-app.com"
        - name: AWS_SES_FROM_EMAIL
          value: "noreply@your-app.com"
        - name: S3_REGION
          value: "us-east-1"
        # Use IAM roles for pods instead of static credentials
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "500m"
```

## AWS SES Setup

### 1. Move Out of Sandbox

AWS SES starts in sandbox mode (200 emails/day, verified recipients only). For production:

1. Go to AWS SES console → Account dashboard
2. Click "Request production access"
3. Fill out use case form (typically approved in 24 hours)
4. Production limits: 50,000 emails/day, any recipient

### 2. Verify "From" Email Address

```bash
aws ses verify-email-identity --email-address noreply@your-app.com
```

Or via AWS Console: SES → Verified identities → Create identity → Email address

### 3. Required IAM Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:SendRawEmail"
      ],
      "Resource": "*"
    }
  ]
}
```

## Template Syntax

Templates use Go template syntax (`text/template` and `html/template`):

### Context Structure

```json
{
  "Entity": { ... },    // From entity_data parameter
  "Metadata": {
    "site_url": "..."   // From SITE_URL env var
  }
}
```

### Examples

```html
<!-- Subject -->
New issue: {{.Entity.display_name}}

<!-- HTML Body -->
<h2>New Issue</h2>
<p>{{.Entity.display_name}}</p>
{{if .Entity.severity}}
  <p>Severity: {{.Entity.severity}}/5</p>
{{end}}
<a href="{{.Metadata.site_url}}/view/issues/{{.Entity.id}}">View Issue</a>

<!-- Text Body -->
New Issue: {{.Entity.display_name}}
{{if .Entity.severity}}Severity: {{.Entity.severity}}/5{{end}}
View at: {{.Metadata.site_url}}/view/issues/{{.Entity.id}}
```

See migration file for complete syntax reference.

## Monitoring

### Queue Depth by Kind

```sql
SELECT kind, COUNT(*)
FROM metadata.river_job
WHERE queue = 'notifications' AND state = 'available'
GROUP BY kind;
```

### Failed Notifications

```sql
SELECT id, template_name, error_message, channels_failed, created_at
FROM metadata.notifications
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 100;
```

### Job Latency

```sql
SELECT
  kind,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY finalized_at - scheduled_at) AS p50_latency,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY finalized_at - scheduled_at) AS p95_latency
FROM metadata.river_job
WHERE queue = 'notifications'
  AND state = 'completed'
  AND finalized_at > NOW() - INTERVAL '1 hour'
GROUP BY kind;
```

### Running Jobs

```sql
SELECT id, kind, args->>'notification_id' AS notification_id, attempt, attempted_at
FROM metadata.river_job
WHERE queue = 'notifications' AND state = 'running';
```

## Troubleshooting

### Jobs stuck in "available" state

Check that the service is running and connected to the database:

```bash
docker-compose logs notification-worker
```

### AWS SES errors

**"Email address not verified"**: Verify sender email in AWS SES console.

**"Daily sending quota exceeded"**: Move out of sandbox mode (see AWS SES Setup).

**"Message rejected: Email address is not verified"** (recipient): Only in sandbox mode. Move to production.

### Template rendering errors

Check the `error_message` column:

```sql
SELECT template_name, error_message, entity_data
FROM metadata.notifications
WHERE status = 'failed' AND error_message LIKE '%rendering%'
ORDER BY created_at DESC
LIMIT 10;
```

Common issues:
- Missing fields in `entity_data` → Use `{{if .Entity.field}}...{{end}}`
- Invalid syntax → Test with `validate_template_parts()` RPC

### High error rate

Check River job errors:

```sql
SELECT kind, args, errors, attempt, max_attempts
FROM metadata.river_job
WHERE queue = 'notifications' AND state = 'retryable'
ORDER BY created_at DESC
LIMIT 10;
```

## Performance

- **Cold start**: ~100ms
- **Memory usage**: ~100-150MB per instance
- **Throughput**:
  - Validation: 1000+ validations/sec
  - Preview: 500+ previews/sec
  - Email sending: 10-14 emails/sec (SES rate limit)
- **Concurrency**: 30 workers per instance (configurable)

## Related

- **Notifications Guide**: `docs/development/NOTIFICATIONS.md`
- **Go Microservices Guide**: `docs/development/GO_MICROSERVICES_GUIDE.md`
- **River Documentation**: https://riverqueue.com/docs
- **AWS SES Documentation**: https://docs.aws.amazon.com/ses/
