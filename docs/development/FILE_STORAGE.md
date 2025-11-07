# File Storage Implementation Guide

This document provides a comprehensive guide to implementing file storage features in Civic OS using S3-compatible storage (MinIO for development, AWS S3 for production).

## Overview

**File Storage Types** (`FileImage`, `FilePDF`, `File`): UUID foreign keys to `metadata.files` table for S3-based file storage with automatic thumbnail generation. Civic OS provides complete file upload workflow via PostgreSQL functions and background workers. Files are stored in S3-compatible storage with presigned URL workflow that maintains PostgREST-only communication from Angular.

## Architecture

### Components

- **Database**: `metadata.files` table stores file metadata and S3 keys, `file_upload_requests` table manages presigned URL workflow, `metadata.river_job` table queues background jobs
- **S3 Signer Service**: Go microservice (v0.10.0+) uses River job queue to generate presigned upload URLs with automatic retries
- **Thumbnail Worker**: Go microservice (v0.10.0+) processes uploaded images (3 sizes: 150x150, 400x400, 800x800) and PDFs (first page) using bimg (libvips) and pdftoppm with white background letterboxing
- **S3 Key Structure**: `{entity_type}/{entity_id}/{file_id}/original.{ext}` and `/thumb-{size}.jpg` for thumbnails
- **UUIDv7**: Time-ordered UUIDs improve B-tree index performance

## Property Type Detection

The SchemaService automatically detects file types from validation metadata:

```typescript
// SchemaService.getPropertyType() detects file types from validation metadata
if (column.udt_name === 'uuid' && column.join_table === 'files') {
  const fileTypeValidation = column.validation_rules?.find(v => v.type === 'fileType');
  if (fileTypeValidation?.value?.startsWith('image/')) {
    return EntityPropertyType.FileImage;  // Thumbnails + lightbox viewer
  } else if (fileTypeValidation?.value === 'application/pdf') {
    return EntityPropertyType.FilePDF;    // First-page thumbnail + iframe viewer
  }
  return EntityPropertyType.File;         // Generic file with download link
}
```

## UI Behavior

### Display Mode
`DisplayPropertyComponent` shows thumbnails (with loading/error states), opens lightbox for images, iframe viewer for PDFs

### Edit Mode
`EditPropertyComponent` provides file input with drag-drop, validates type/size, uploads immediately on selection, shows progress

### Create Forms
File properties are filtered out of Create forms (files require existing entity ID)

### Validation
Frontend validates before upload; backend enforces via validation metadata

## Adding File Properties to Your Schema

### Step 1: Add UUID Column with Foreign Key

```sql
-- 1. Add UUID column with FK to files table
ALTER TABLE issues ADD COLUMN photo UUID REFERENCES metadata.files(id);

-- 2. Create index (required for performance)
CREATE INDEX idx_issues_photo ON issues(photo);
```

### Step 2: Add Validation Metadata

```sql
-- 3. Add validation metadata
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('issues', 'photo', 'fileType', 'image/*', 'Only image files are allowed', 1),
  ('issues', 'photo', 'maxFileSize', '5242880', 'File size must not exceed 5 MB', 2);
```

### Step 3 (Optional): Add Custom Display Name

```sql
-- 4. (Optional) Add custom display name
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order)
VALUES ('issues', 'photo', 'Photo', 'Upload a photo of the issue', 50);
```

## Validation Types

- **`fileType`**: MIME type constraint (e.g., `image/*`, `image/jpeg`, `application/pdf`)
- **`maxFileSize`**: Maximum size in bytes
  - `5242880` = 5 MB
  - `10485760` = 10 MB

## S3 Configuration

**Current**: Hardcoded to `http://localhost:9000/civic-os-files/` for MinIO development.

**Production TODO**: Use environment configuration with CloudFront or S3 bucket URLs.

**Files to update**:
- `FileUploadService.getS3Url()`
- `DisplayPropertyComponent.getS3Url()`
- `PdfViewerComponent.getS3Url()`

## Services

### FileUploadService

**Location**: `src/app/services/file-upload.service.ts`

**Functionality**: Handles complete upload workflow:
1. Request presigned URL from database
2. Upload file to S3 using presigned URL
3. Create file record in database
4. Poll for thumbnail generation completion

## Development Setup

### Docker Compose Services

The `examples/pothole/docker-compose.yml` includes:
- **MinIO** (ports 9000/9001) - S3-compatible storage
- **s3-signer service** - Generates presigned URLs
- **thumbnail-worker service** - Processes uploaded files

### Database Migration

**Migration**: `postgres/migrations/deploy/v0-5-0-add-file-storage.sql` adds core file storage infrastructure

---

## Production Configuration

### Environment Variables

Both microservices (S3 Signer and Thumbnail Worker) require environment variables for production deployment.

#### Required for Both Services

```bash
# PostgreSQL
DATABASE_URL=postgres://user:password@host:5432/database

# AWS Credentials
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key

# S3 Bucket
S3_BUCKET=your-production-bucket
```

#### Development-Only Variables (MinIO)

```bash
# S3 Signer: Public endpoint for presigned URLs
S3_PUBLIC_ENDPOINT=http://localhost:9000  # LOCAL ONLY - omit for AWS S3

# Thumbnail Worker: Internal S3 endpoint
S3_ENDPOINT=http://minio:9000  # LOCAL ONLY - omit for AWS S3
```

⚠️ **Critical**: `S3_PUBLIC_ENDPOINT` and `S3_ENDPOINT` are **only for local MinIO development**. Do NOT set these variables in production with AWS S3 - the services will automatically use correct AWS endpoints.

---

### System Requirements

#### S3 Signer
- **Runtime**: Docker image or Go 1.23+ binary
- **Dependencies**: None (statically linked binary)
- **Network**: Outbound HTTPS to AWS S3 and PostgreSQL

#### Thumbnail Worker
- **Runtime**: Docker image or Go 1.23+ binary
- **Dependencies** (if running binary directly):
  - libvips 8.x+ (`libvips-dev` or `vips-devel` package)
  - poppler-utils (`pdftoppm` command)
- **Network**: Outbound HTTPS to AWS S3 and PostgreSQL

**Recommended**: Use Docker images which include all dependencies pre-installed.

---

### IAM Permissions (AWS S3)

The services require the following S3 permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:PutObjectAcl"
      ],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::your-bucket-name"
    }
  ]
}
```

**Security Best Practice**: Use IAM roles (EC2/ECS task roles) instead of access keys when possible.

---

### Deployment Options

#### Option 1: Docker Compose (Recommended)

```yaml
services:
  s3-signer:
    image: ghcr.io/civic-os/s3-signer:0.10.0
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - S3_REGION=us-east-1
      - S3_BUCKET=${S3_BUCKET}
    restart: unless-stopped

  thumbnail-worker:
    image: ghcr.io/civic-os/thumbnail-worker:0.10.0
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - S3_REGION=us-east-1
    restart: unless-stopped
```

#### Option 2: Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: civic-os-file-workers
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: s3-signer
        image: ghcr.io/civic-os/s3-signer:0.10.0
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: civic-os-secrets
              key: database-url
        - name: S3_REGION
          value: "us-east-1"
        - name: S3_BUCKET
          value: "your-bucket"

      - name: thumbnail-worker
        image: ghcr.io/civic-os/thumbnail-worker:0.10.0
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: civic-os-secrets
              key: database-url
        - name: S3_REGION
          value: "us-east-1"
```

#### Option 3: Systemd Services

```ini
# /etc/systemd/system/civic-os-s3-signer.service
[Unit]
Description=Civic OS S3 Signer
After=postgresql.service

[Service]
Type=simple
User=civicos
Environment="DATABASE_URL=postgres://..."
Environment="S3_REGION=us-east-1"
Environment="S3_BUCKET=your-bucket"
ExecStart=/usr/local/bin/s3-signer
Restart=always

[Install]
WantedBy=multi-user.target
```

---

### Monitoring & Health Checks

#### Service Logs

Both services log to stdout/stderr:
- Startup banner with configuration
- Job processing status (Job ID, attempt number, duration)
- Error details with stack traces

```bash
# Docker
docker logs s3-signer
docker logs thumbnail-worker

# Kubernetes
kubectl logs deployment/civic-os-file-workers -c s3-signer
kubectl logs deployment/civic-os-file-workers -c thumbnail-worker

# Systemd
journalctl -u civic-os-s3-signer -f
journalctl -u civic-os-thumbnail-worker -f
```

#### Database Monitoring

Check job queue health directly in PostgreSQL:

```sql
-- Pending jobs
SELECT queue, COUNT(*)
FROM metadata.river_job
WHERE state = 'available'
GROUP BY queue;

-- Failed jobs (dead-letter queue)
SELECT id, kind, args, errors, attempt, max_attempts
FROM metadata.river_job
WHERE state = 'discarded'
ORDER BY finalized_at DESC
LIMIT 10;

-- Job processing rate (last hour)
SELECT
  queue,
  COUNT(*) as completed,
  AVG(EXTRACT(EPOCH FROM (finalized_at - scheduled_at))) as avg_duration_seconds
FROM metadata.river_job
WHERE state = 'completed'
  AND finalized_at > NOW() - INTERVAL '1 hour'
GROUP BY queue;
```

---

### Scaling

#### Horizontal Scaling

Both services support horizontal scaling - run multiple instances:

```bash
# Docker Compose
docker-compose up -d --scale s3-signer=3 --scale thumbnail-worker=3

# Kubernetes
kubectl scale deployment civic-os-file-workers --replicas=5
```

River's row-level locking ensures each job is processed by only one worker, even with multiple instances.

#### Vertical Scaling

**S3 Signer** (I/O-bound):
- Default: 50 workers per instance
- Memory: ~50-100MB per instance
- CPU: Minimal (mostly network I/O)

**Thumbnail Worker** (CPU-bound):
- Default: 10 workers per instance
- Memory: ~300-500MB per instance (libvips memory usage)
- CPU: High during thumbnail generation

Adjust worker counts in code (`main.go`) if needed based on your workload.

---

## Example Usage

See `examples/pothole/init-scripts/07_add_file_fields.sql` for complete example with:
- `Issue.photo` (image field)
- `WorkPackage.report_pdf` (PDF field)

## Related Documentation

- Main documentation: `CLAUDE.md` - Property Type System section
- Research notes: `docs/notes/FILE_STORAGE_OPTIONS.md` - Historical design decisions (v0.5.0 planning)
- Migration: `postgres/migrations/deploy/v0-5-0-add-file-storage.sql`
