# Go Microservices Implementation Guide

**Status:** ✅ **CURRENT** - Implemented in v0.10.0
**Purpose:** Complete guide for Civic OS microservices using Go + River (PostgreSQL table queue)

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [River Queue Architecture](#river-queue-architecture)
3. [Go Code Examples](#go-code-examples)
4. [PostgreSQL Integration](#postgresql-integration)
5. [Deployment](#deployment)
6. [Monitoring & Operations](#monitoring--operations)
7. [Migration Plan](#migration-plan)

---

## Architecture Overview

### Current State (Node.js + LISTEN/NOTIFY)

```
┌─────────────────────────────────────────────────┐
│  Angular Frontend                               │
│  - Uploads file metadata via PostgREST          │
└───────────────┬─────────────────────────────────┘
                │ HTTP REST
                ↓
┌─────────────────────────────────────────────────┐
│  PostgREST API                                  │
│  - INSERT into metadata.file_upload_requests    │
└───────────────┬─────────────────────────────────┘
                │ PostgreSQL protocol
                ↓
┌─────────────────────────────────────────────────┐
│  PostgreSQL 17                                  │
│  - Trigger fires: NOTIFY 'upload_url_request'  │
│  - Trigger fires: NOTIFY 'file_uploaded'       │
└─────┬──────────────────────────┬────────────────┘
      │ LISTEN                   │ LISTEN
      ↓                          ↓
┌──────────────┐          ┌──────────────┐
│  S3 Signer   │          │  Thumbnail   │
│  (Node.js)   │          │  Worker      │
│              │          │  (Node.js)   │
│  - Listens   │          │              │
│    to NOTIFY │          │  - Listens   │
│  - Generates │          │    to NOTIFY │
│    presigned │          │  - Sharp +   │
│    URLs      │          │    libvips   │
└──────────────┘          └──────────────┘
```

#### Limitations of Current Architecture

1. **At-most-once delivery** - Messages lost on worker crash
2. **No durability** - Messages lost on connection failure
3. **No retries** - Failed processing requires manual intervention
4. **Global database lock** - NOTIFY causes lock contention at 50+ concurrent writers
5. **No monitoring** - Can't see queue depth or failed jobs
6. **Duplicate processing risk** - Multiple LISTEN subscribers can process same event

---

### Current State (Go + River) - v0.10.0+

```
┌─────────────────────────────────────────────────┐
│  Angular Frontend                               │
│  - Uploads file metadata via PostgREST          │
└───────────────┬─────────────────────────────────┘
                │ HTTP REST
                ↓
┌─────────────────────────────────────────────────┐
│  PostgREST API                                  │
│  - INSERT into metadata.file_upload_requests    │
└───────────────┬─────────────────────────────────┘
                │ PostgreSQL protocol
                ↓
┌─────────────────────────────────────────────────┐
│  PostgreSQL 17                                  │
│  - Trigger inserts job into river_job table     │
│  - ACID guarantees (job + data commit together) │
│  - Single river_job table for all job types     │
└─────┬──────────────────────────┬────────────────┘
      │ FOR UPDATE SKIP LOCKED   │ FOR UPDATE SKIP LOCKED
      ↓                          ↓
┌──────────────┐          ┌──────────────┐
│  S3 Signer   │          │  Thumbnail   │
│  (Go+River)  │          │  Worker      │
│              │          │  (Go+River+  │
│  - Claims    │          │   bimg)      │
│    jobs from │          │              │
│    queue:    │          │  - Claims    │
│    "s3_      │          │    jobs from │
│    signer"   │          │    queue:    │
│  - Generates │          │    "thumb-   │
│    presigned │          │    nails"    │
│    URLs      │          │  - Generates │
│  - Updates   │          │    thumbnails│
│    database  │          │  - Uploads   │
│              │          │    to S3     │
└──────────────┘          └──────────────┘
```

#### Benefits of New Architecture

1. ✅ **At-least-once delivery** - Jobs survive worker crashes
2. ✅ **Durable** - Jobs persisted in database table
3. ✅ **Automatic retries** - Exponential backoff, configurable max attempts
4. ✅ **Row-level locking** - No global lock, scales horizontally
5. ✅ **Full monitoring** - SQL queries show queue depth, latency, failed jobs
6. ✅ **Atomic job claiming** - SKIP LOCKED prevents duplicate processing
7. ✅ **Transactional guarantees** - Job and data commit atomically
8. ✅ **Dead-letter queue** - Failed jobs preserved for debugging
9. ✅ **Priority queues** - Critical jobs processed first
10. ✅ **Scheduled/delayed jobs** - Run at specific time or after delay

---

## River Queue Architecture

### Single Table, Multiple Queues

River uses a **single `river_job` table** for all job types, with jobs filtered by:
- **`queue`** - Which worker pool processes it (e.g., "s3_signer", "thumbnails")
- **`kind`** - Which worker function handles it (e.g., "s3_presign", "thumbnail_generate")
- **`state`** - Job lifecycle status ("available", "running", "completed", etc.)

```sql
-- Single table for ALL jobs
CREATE TABLE river_job (
    id BIGSERIAL PRIMARY KEY,
    args JSONB NOT NULL,              -- Job-specific data
    kind VARCHAR NOT NULL,             -- Job type identifier
    queue VARCHAR NOT NULL,            -- Queue name
    state VARCHAR NOT NULL,            -- Job state
    priority SMALLINT NOT NULL DEFAULT 1,
    scheduled_at TIMESTAMPTZ NOT NULL,
    attempted_at TIMESTAMPTZ,
    finalized_at TIMESTAMPTZ,
    attempt SMALLINT NOT NULL DEFAULT 0,
    max_attempts SMALLINT NOT NULL DEFAULT 25,
    attempted_by TEXT[],               -- Worker tracking
    errors JSONB,                      -- Error details
    metadata JSONB,                    -- User metadata
    tags VARCHAR[],                    -- Job tags
    unique_key BYTEA,                  -- For unique jobs
    unique_states BIT(8)               -- Unique job state tracking
);
```

### Two-Dimensional Routing: `kind` vs `queue`

| Dimension | Purpose | Example Values |
|-----------|---------|----------------|
| **`kind`** | Job type/worker (WHAT to do) | "s3_presign", "thumbnail_generate", "send_email" |
| **`queue`** | Resource pool (WHERE/WHEN to process) | "s3_signer", "thumbnails", "default" |

**Example**: A job with `kind="s3_presign"` and `queue="s3_signer"` is processed by the S3 Signer Service listening to the "s3_signer" queue.

### Deployment Patterns

#### Pattern 1: Monolithic (All Workers Together)

**Use Case**: Development, small applications

```go
workers := river.NewWorkers()
river.AddWorker(workers, &S3PresignWorker{})
river.AddWorker(workers, &ThumbnailWorker{})
river.AddWorker(workers, &EmailWorker{})

riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
    Queues: map[string]river.QueueConfig{
        river.QueueDefault: {MaxWorkers: 100}, // All jobs share pool
    },
    Workers: workers,
})
```

**Pros**: Simple, single deployment
**Cons**: Can't scale independently, CPU jobs block I/O jobs

#### Pattern 2: Separate Microservices ✅ **RECOMMENDED**

**Use Case**: Production, independent scaling, fault isolation

Each microservice runs as a separate Go process with:
- Only the workers it needs
- Only the queues it listens to
- Independent scaling and deployments

**Benefits**:
- Scale thumbnails without scaling S3 signer
- CPU-bound vs I/O-bound resource isolation
- Fault isolation (thumbnail crash doesn't affect S3 signing)
- Independent deployments

---

## Go Code Examples

### Project Structure

```
services/
├── s3-signer/
│   ├── main.go              # S3 Signer service entry point
│   ├── go.mod
│   ├── go.sum
│   ├── Dockerfile
│   └── README.md
│
├── thumbnail-worker/
│   ├── main.go              # Thumbnail worker entry point
│   ├── go.mod
│   ├── go.sum
│   ├── Dockerfile
│   └── README.md
│
└── shared/
    ├── jobs/
    │   ├── s3_presign.go    # S3 presign job definition
    │   └── thumbnail.go     # Thumbnail job definition
    └── database/
        └── connection.go    # Shared DB connection logic
```

### S3 Signer Service

**File: `services/s3-signer/main.go`**

```go
package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river"
    "github.com/riverqueue/river/riverdriver/riverpgxv5"
)

// S3PresignArgs defines the job arguments
type S3PresignArgs struct {
    RequestID string `json:"request_id"`
    Bucket    string `json:"bucket"`
    Key       string `json:"key"`
    Operation string `json:"operation"` // "upload" or "download"
}

// Kind returns the job type identifier
func (S3PresignArgs) Kind() string {
    return "s3_presign"
}

// InsertOpts returns job insertion options (routes to queue)
func (S3PresignArgs) InsertOpts() river.InsertOpts {
    return river.InsertOpts{
        Queue: "s3_signer",
    }
}

// S3PresignWorker processes S3 presign jobs
type S3PresignWorker struct {
    river.WorkerDefaults[S3PresignArgs]
    s3Client         *s3.Client
    s3PresignClient  *s3.PresignClient
    dbPool           *pgxpool.Pool
}

// Work processes the job
func (w *S3PresignWorker) Work(ctx context.Context, job *river.Job[S3PresignArgs]) error {
    log.Printf("[S3Presign] Processing job %d for request %s", job.ID, job.Args.RequestID)

    // Generate presigned URL based on operation
    var presignedURL string
    var err error

    if job.Args.Operation == "upload" {
        presignedURL, err = w.generateUploadURL(ctx, job.Args.Bucket, job.Args.Key)
    } else {
        presignedURL, err = w.generateDownloadURL(ctx, job.Args.Bucket, job.Args.Key)
    }

    if err != nil {
        log.Printf("[S3Presign] Error generating URL: %v", err)
        return fmt.Errorf("failed to generate presigned URL: %w", err)
    }

    // Update database with presigned URL
    _, err = w.dbPool.Exec(ctx, `
        UPDATE metadata.file_upload_requests
        SET presigned_url = $1, status = 'ready', updated_at = NOW()
        WHERE id = $2
    `, presignedURL, job.Args.RequestID)

    if err != nil {
        log.Printf("[S3Presign] Error updating database: %v", err)
        return fmt.Errorf("failed to update database: %w", err)
    }

    log.Printf("[S3Presign] Successfully generated URL for request %s", job.Args.RequestID)
    return nil
}

func (w *S3PresignWorker) generateUploadURL(ctx context.Context, bucket, key string) (string, error) {
    req, err := w.s3PresignClient.PresignPutObject(ctx, &s3.PutObjectInput{
        Bucket: &bucket,
        Key:    &key,
    }, s3.WithPresignExpires(1*time.Hour))

    if err != nil {
        return "", err
    }

    return req.URL, nil
}

func (w *S3PresignWorker) generateDownloadURL(ctx context.Context, bucket, key string) (string, error) {
    req, err := w.s3PresignClient.PresignGetObject(ctx, &s3.GetObjectInput{
        Bucket: &bucket,
        Key:    &key,
    }, s3.WithPresignExpires(1*time.Hour))

    if err != nil {
        return "", err
    }

    return req.URL, nil
}

func main() {
    ctx := context.Background()

    // Connect to PostgreSQL
    dbPool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Fatalf("Unable to connect to database: %v", err)
    }
    defer dbPool.Close()

    // Load AWS config
    awsCfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        log.Fatalf("Unable to load AWS config: %v", err)
    }

    // Create S3 client
    s3Client := s3.NewFromConfig(awsCfg)
    s3PresignClient := s3.NewPresignClient(s3Client)

    // Register workers
    workers := river.NewWorkers()
    river.AddWorker(workers, &S3PresignWorker{
        s3Client:        s3Client,
        s3PresignClient: s3PresignClient,
        dbPool:          dbPool,
    })

    // Create River client
    riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
        Queues: map[string]river.QueueConfig{
            "s3_signer": {MaxWorkers: 50}, // I/O-bound, many workers
        },
        Workers: workers,
    })
    if err != nil {
        log.Fatalf("Unable to create River client: %v", err)
    }

    // Start processing jobs
    if err := riverClient.Start(ctx); err != nil {
        log.Fatalf("Unable to start River client: %v", err)
    }

    log.Println("S3 Signer Service started, listening to 's3_signer' queue...")

    // Graceful shutdown
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    <-sigChan

    log.Println("Shutting down gracefully...")
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := riverClient.Stop(ctx); err != nil {
        log.Printf("Error stopping River client: %v", err)
    }

    log.Println("Shutdown complete")
}
```

### Thumbnail Worker Service

**File: `services/thumbnail-worker/main.go`**

```go
package main

import (
    "bytes"
    "context"
    "fmt"
    "io"
    "log"
    "os"
    "os/exec"
    "os/signal"
    "syscall"
    "time"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/h2non/bimg"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river"
    "github.com/riverqueue/river/riverdriver/riverpgxv5"
)

// ThumbnailArgs defines the job arguments
type ThumbnailArgs struct {
    FileID   string `json:"file_id"`
    S3Key    string `json:"s3_key"`
    FileType string `json:"file_type"` // "image" or "pdf"
}

// Kind returns the job type identifier
func (ThumbnailArgs) Kind() string {
    return "thumbnail_generate"
}

// InsertOpts returns job insertion options (routes to queue)
func (ThumbnailArgs) InsertOpts() river.InsertOpts {
    return river.InsertOpts{
        Queue: "thumbnails",
    }
}

// ThumbnailWorker processes thumbnail generation jobs
type ThumbnailWorker struct {
    river.WorkerDefaults[ThumbnailArgs]
    s3Client *s3.Client
    bucket   string
    dbPool   *pgxpool.Pool
}

// Work processes the job
func (w *ThumbnailWorker) Work(ctx context.Context, job *river.Job[ThumbnailArgs]) error {
    log.Printf("[Thumbnail] Processing job %d for file %s", job.ID, job.Args.FileID)

    // Update status to processing
    _, err := w.dbPool.Exec(ctx, `
        UPDATE metadata.files
        SET thumbnail_status = 'processing', updated_at = NOW()
        WHERE id = $1
    `, job.Args.FileID)
    if err != nil {
        return fmt.Errorf("failed to update status: %w", err)
    }

    // Download file from S3
    fileData, err := w.downloadFromS3(ctx, job.Args.S3Key)
    if err != nil {
        log.Printf("[Thumbnail] Error downloading file: %v", err)
        return fmt.Errorf("failed to download file: %w", err)
    }

    // Generate thumbnails based on file type
    var thumbnails map[string][]byte
    if job.Args.FileType == "pdf" {
        thumbnails, err = w.generatePDFThumbnails(fileData)
    } else {
        thumbnails, err = w.generateImageThumbnails(fileData)
    }

    if err != nil {
        log.Printf("[Thumbnail] Error generating thumbnails: %v", err)
        return fmt.Errorf("failed to generate thumbnails: %w", err)
    }

    // Upload thumbnails to S3
    for size, data := range thumbnails {
        thumbnailKey := fmt.Sprintf("%s/thumbnail_%s.jpg", job.Args.S3Key, size)
        err := w.uploadToS3(ctx, thumbnailKey, data)
        if err != nil {
            return fmt.Errorf("failed to upload %s thumbnail: %w", size, err)
        }
    }

    // Update database with completion status
    _, err = w.dbPool.Exec(ctx, `
        UPDATE metadata.files
        SET thumbnail_status = 'completed', updated_at = NOW()
        WHERE id = $1
    `, job.Args.FileID)

    if err != nil {
        return fmt.Errorf("failed to update completion status: %w", err)
    }

    log.Printf("[Thumbnail] Successfully generated thumbnails for file %s", job.Args.FileID)
    return nil
}

func (w *ThumbnailWorker) downloadFromS3(ctx context.Context, key string) ([]byte, error) {
    result, err := w.s3Client.GetObject(ctx, &s3.GetObjectInput{
        Bucket: &w.bucket,
        Key:    &key,
    })
    if err != nil {
        return nil, err
    }
    defer result.Body.Close()

    return io.ReadAll(result.Body)
}

func (w *ThumbnailWorker) uploadToS3(ctx context.Context, key string, data []byte) error {
    _, err := w.s3Client.PutObject(ctx, &s3.PutObjectInput{
        Bucket:      &w.bucket,
        Key:         &key,
        Body:        bytes.NewReader(data),
        ContentType: stringPtr("image/jpeg"),
    })
    return err
}

func (w *ThumbnailWorker) generateImageThumbnails(imageData []byte) (map[string][]byte, error) {
    thumbnails := make(map[string][]byte)

    // Small thumbnail (150x150)
    small, err := bimg.NewImage(imageData).Resize(150, 150)
    if err != nil {
        return nil, fmt.Errorf("failed to generate small thumbnail: %w", err)
    }
    thumbnails["small"] = small

    // Medium thumbnail (400x400)
    medium, err := bimg.NewImage(imageData).Resize(400, 400)
    if err != nil {
        return nil, fmt.Errorf("failed to generate medium thumbnail: %w", err)
    }
    thumbnails["medium"] = medium

    // Large thumbnail (800x800)
    large, err := bimg.NewImage(imageData).Resize(800, 800)
    if err != nil {
        return nil, fmt.Errorf("failed to generate large thumbnail: %w", err)
    }
    thumbnails["large"] = large

    return thumbnails, nil
}

func (w *ThumbnailWorker) generatePDFThumbnails(pdfData []byte) (map[string][]byte, error) {
    // Write PDF to temp file
    tmpFile, err := os.CreateTemp("", "pdf-*.pdf")
    if err != nil {
        return nil, err
    }
    defer os.Remove(tmpFile.Name())

    if _, err := tmpFile.Write(pdfData); err != nil {
        return nil, err
    }
    tmpFile.Close()

    // Convert first page to image using pdftoppm
    ppmFile := tmpFile.Name() + ".ppm"
    cmd := exec.Command("pdftoppm", "-f", "1", "-l", "1", "-singlefile", tmpFile.Name(), tmpFile.Name())
    if err := cmd.Run(); err != nil {
        return nil, fmt.Errorf("pdftoppm failed: %w", err)
    }
    defer os.Remove(ppmFile)

    // Read PPM file
    ppmData, err := os.ReadFile(ppmFile)
    if err != nil {
        return nil, err
    }

    // Generate medium thumbnail only for PDFs
    medium, err := bimg.NewImage(ppmData).Resize(400, 400)
    if err != nil {
        return nil, err
    }

    return map[string][]byte{"medium": medium}, nil
}

func stringPtr(s string) *string {
    return &s
}

func main() {
    ctx := context.Background()

    // Connect to PostgreSQL
    dbPool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Fatalf("Unable to connect to database: %v", err)
    }
    defer dbPool.Close()

    // Load AWS config
    awsCfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        log.Fatalf("Unable to load AWS config: %v", err)
    }

    // Create S3 client
    s3Client := s3.NewFromConfig(awsCfg)

    // Register workers
    workers := river.NewWorkers()
    river.AddWorker(workers, &ThumbnailWorker{
        s3Client: s3Client,
        bucket:   os.Getenv("S3_BUCKET"),
        dbPool:   dbPool,
    })

    // Create River client
    riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
        Queues: map[string]river.QueueConfig{
            "thumbnails": {MaxWorkers: 10}, // CPU-bound, fewer workers
        },
        Workers: workers,
    })
    if err != nil {
        log.Fatalf("Unable to create River client: %v", err)
    }

    // Start processing jobs
    if err := riverClient.Start(ctx); err != nil {
        log.Fatalf("Unable to start River client: %v", err)
    }

    log.Println("Thumbnail Worker Service started, listening to 'thumbnails' queue...")

    // Graceful shutdown
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    <-sigChan

    log.Println("Shutting down gracefully...")
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := riverClient.Stop(ctx); err != nil {
        log.Printf("Error stopping River client: %v", err)
    }

    log.Println("Shutdown complete")
}
```

---

## PostgreSQL Integration

### River Migrations

River provides a CLI tool to run database migrations:

```bash
# Install River CLI
go install github.com/riverqueue/river/cmd/river@latest

# Run migrations (creates river_job, river_leader, river_migration tables)
river migrate-up --database-url "$DATABASE_URL"

# Check migration status
river migrate-get --database-url "$DATABASE_URL"
```

**What migrations create:**
- `river_job` - Main job queue table
- `river_leader` - Leader election for periodic jobs (unlogged table)
- `river_migration` - Migration tracking table

### Replacing NOTIFY Triggers with River Job Insertion

**Current trigger (LISTEN/NOTIFY pattern):**

```sql
CREATE OR REPLACE FUNCTION notify_upload_url_request()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('upload_url_request', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER upload_url_request_notify
AFTER INSERT ON metadata.file_upload_requests
FOR EACH ROW EXECUTE FUNCTION notify_upload_url_request();
```

**New trigger (River job insertion):**

```sql
CREATE OR REPLACE FUNCTION enqueue_s3_sign_job()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO river_job (kind, args, queue, priority, state, scheduled_at)
  VALUES (
    's3_presign',
    jsonb_build_object(
      'request_id', NEW.id,
      'bucket', 'civic-os-files',
      'key', NEW.file_path,
      'operation', 'upload'
    ),
    's3_signer',
    1,
    'available',
    NOW()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER file_upload_request_enqueue
AFTER INSERT ON metadata.file_upload_requests
FOR EACH ROW EXECUTE FUNCTION enqueue_s3_sign_job();
```

**For thumbnail worker:**

```sql
CREATE OR REPLACE FUNCTION enqueue_thumbnail_job()
RETURNS TRIGGER AS $$
BEGIN
  -- Only enqueue if file is an image or PDF
  IF NEW.mime_type LIKE 'image/%' OR NEW.mime_type = 'application/pdf' THEN
    INSERT INTO river_job (kind, args, queue, priority, state, scheduled_at)
    VALUES (
      'thumbnail_generate',
      jsonb_build_object(
        'file_id', NEW.id,
        's3_key', NEW.s3_key,
        'file_type', CASE
          WHEN NEW.mime_type = 'application/pdf' THEN 'pdf'
          ELSE 'image'
        END
      ),
      'thumbnails',
      1,
      'available',
      NOW()
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER file_uploaded_enqueue
AFTER INSERT ON metadata.files
FOR EACH ROW EXECUTE FUNCTION enqueue_thumbnail_job();
```

### Transactional Job Insertion from Go

River supports **transactional job insertion**, ensuring jobs and business logic commit atomically:

```go
// Start transaction
tx, err := dbPool.Begin(ctx)
if err != nil {
    return err
}
defer tx.Rollback(ctx)

// Insert file record
var fileID string
err = tx.QueryRow(ctx, `
    INSERT INTO metadata.files (display_name, mime_type, s3_key)
    VALUES ($1, $2, $3)
    RETURNING id
`, fileName, mimeType, s3Key).Scan(&fileID)
if err != nil {
    return err
}

// Enqueue thumbnail job IN SAME TRANSACTION
_, err = riverClient.InsertTx(ctx, tx, ThumbnailArgs{
    FileID:   fileID,
    S3Key:    s3Key,
    FileType: "image",
}, nil)
if err != nil {
    return err // Transaction rolls back, no orphaned jobs!
}

// Commit transaction (both file record and job)
return tx.Commit(ctx)
```

---

## Deployment

### Dockerfiles

**S3 Signer Dockerfile (`services/s3-signer/Dockerfile`):**

```dockerfile
# Builder stage
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Install dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build binary
RUN CGO_ENABLED=0 GOOS=linux go build -o /s3-signer main.go

# Runtime stage
FROM alpine:3.20

# Install ca-certificates for HTTPS
RUN apk --no-cache add ca-certificates

WORKDIR /app

# Copy binary from builder
COPY --from=builder /s3-signer .

# Create non-root user
RUN adduser -D -u 1000 appuser
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ps aux | grep s3-signer || exit 1

ENTRYPOINT ["./s3-signer"]
```

**Thumbnail Worker Dockerfile (`services/thumbnail-worker/Dockerfile`):**

```dockerfile
# Builder stage
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache \
    libc6-compat \
    vips-dev \
    build-base

# Install dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build binary
RUN CGO_ENABLED=1 GOOS=linux go build -o /thumbnail-worker main.go

# Runtime stage
FROM alpine:3.20

# Install runtime dependencies
RUN apk --no-cache add \
    ca-certificates \
    vips \
    poppler-utils

WORKDIR /app

# Copy binary from builder
COPY --from=builder /thumbnail-worker .

# Create non-root user
RUN adduser -D -u 1000 appuser
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ps aux | grep thumbnail-worker || exit 1

ENTRYPOINT ["./thumbnail-worker"]
```

### Docker Compose Configuration

**Development (`docker-compose.yml`):**

```yaml
version: '3.8'

services:
  postgres:
    # Existing PostgreSQL service
    image: postgres:17-alpine
    # ... existing config ...

  postgrest:
    # Existing PostgREST service
    # ... existing config ...

  # NEW: S3 Signer Service
  s3-signer:
    build:
      context: ./services/s3-signer
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgres://postgres:password@postgres:5432/civic_os
      AWS_REGION: us-east-1
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      S3_BUCKET: civic-os-files
      S3_ENDPOINT: http://minio:9000
      S3_PUBLIC_ENDPOINT: http://localhost:9000
    depends_on:
      - postgres
    restart: unless-stopped

  # NEW: Thumbnail Worker Service
  thumbnail-worker:
    build:
      context: ./services/thumbnail-worker
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgres://postgres:password@postgres:5432/civic_os
      AWS_REGION: us-east-1
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      S3_BUCKET: civic-os-files
      S3_ENDPOINT: http://minio:9000
    depends_on:
      - postgres
    restart: unless-stopped
    deploy:
      replicas: 2  # Horizontal scaling
```

**Production (`docker-compose.prod.yml`):**

```yaml
version: '3.8'

services:
  # Existing services (postgres, postgrest, frontend)...

  s3-signer:
    image: ghcr.io/civic-os/s3-signer:${VERSION:-latest}
    environment:
      DATABASE_URL: ${DATABASE_URL}
      AWS_REGION: ${AWS_REGION}
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      S3_BUCKET: ${S3_BUCKET}
    depends_on:
      - postgres
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  thumbnail-worker:
    image: ghcr.io/civic-os/thumbnail-worker:${VERSION:-latest}
    environment:
      DATABASE_URL: ${DATABASE_URL}
      AWS_REGION: ${AWS_REGION}
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      S3_BUCKET: ${S3_BUCKET}
    depends_on:
      - postgres
    restart: unless-stopped
    deploy:
      replicas: 3  # Scale based on load
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### CI/CD Pipeline

**GitHub Actions (`.github/workflows/build-go-services.yml`):**

```yaml
name: Build Go Microservices

on:
  push:
    branches: [main]
    paths:
      - 'services/**'
      - '.github/workflows/build-go-services.yml'
  pull_request:
    branches: [main]
    paths:
      - 'services/**'

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: [s3-signer, thumbnail-worker]

    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23'

      - name: Build
        working-directory: ./services/${{ matrix.service }}
        run: go build -v ./...

      - name: Test
        working-directory: ./services/${{ matrix.service }}
        run: go test -v ./...

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract version from package.json
        id: version
        run: echo "VERSION=$(jq -r .version package.json)" >> $GITHUB_OUTPUT

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: ./services/${{ matrix.service }}
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: |
            ghcr.io/civic-os/${{ matrix.service }}:latest
            ghcr.io/civic-os/${{ matrix.service }}:v${{ steps.version.outputs.VERSION }}
            ghcr.io/civic-os/${{ matrix.service }}:${{ steps.version.outputs.VERSION }}
            ghcr.io/civic-os/${{ matrix.service }}:sha-${{ github.sha }}
          cache-from: type=registry,ref=ghcr.io/civic-os/${{ matrix.service }}:buildcache
          cache-to: type=registry,ref=ghcr.io/civic-os/${{ matrix.service }}:buildcache,mode=max
```

---

## Monitoring & Operations

### SQL Monitoring Queries

**Queue depth by state:**

```sql
SELECT state, COUNT(*)
FROM metadata.river_job
GROUP BY state
ORDER BY state;
```

**Queue depth by queue and kind:**

```sql
SELECT queue, kind, state, COUNT(*)
FROM metadata.river_job
WHERE state IN ('available', 'scheduled', 'running')
GROUP BY queue, kind, state
ORDER BY COUNT(*) DESC;
```

**Job latency (p50, p95, p99):**

```sql
SELECT
  kind,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY finalized_at - scheduled_at) AS p50_latency,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY finalized_at - scheduled_at) AS p95_latency,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY finalized_at - scheduled_at) AS p99_latency
FROM metadata.river_job
WHERE state = 'completed'
  AND finalized_at > NOW() - INTERVAL '1 hour'
GROUP BY kind;
```

**Failed jobs (dead-letter queue):**

```sql
SELECT id, kind, queue, errors, attempt, max_attempts, created_at
FROM metadata.river_job
WHERE state = 'discarded'
ORDER BY finalized_at DESC
LIMIT 100;
```

**Currently running jobs:**

```sql
SELECT id, kind, queue, attempted_by, attempt, created_at
FROM metadata.river_job
WHERE state = 'running'
ORDER BY created_at DESC;
```

**Table bloat monitoring:**

```sql
SELECT
  relname,
  n_live_tup,
  n_dead_tup,
  ROUND(n_dead_tup * 100.0 / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct
FROM pg_stat_user_tables
WHERE relname = 'river_job';
```

### Autovacuum Tuning

**Table-level settings (already configured in v0.10.0 migration):**

```sql
ALTER TABLE metadata.river_job SET (
  autovacuum_vacuum_scale_factor = 0.01,  -- Vacuum at 1% dead tuples (default: 20%)
  autovacuum_vacuum_cost_delay = 1        -- Aggressive (default: 20ms)
);
```

**Server-level setting (optional, add to `postgresql.conf` for production):**

```ini
autovacuum_naptime = 20  # Check every 20 seconds (default: 60s)
```

**Check autovacuum activity:**

```sql
SELECT
  schemaname,
  relname,
  last_autovacuum,
  last_autoanalyze,
  autovacuum_count,
  autoanalyze_count
FROM pg_stat_user_tables
WHERE relname = 'river_job';
```

### Scaling Procedures

**Horizontal Scaling (Docker Compose):**

```bash
# Scale thumbnail workers to 5 replicas
docker-compose up -d --scale thumbnail-worker=5

# Scale S3 signer to 3 replicas
docker-compose up -d --scale s3-signer=3
```

**Horizontal Scaling (Kubernetes):**

```bash
kubectl scale deployment thumbnail-worker --replicas=5
kubectl scale deployment s3-signer --replicas=3
```

**Vertical Scaling:** Increase `MaxWorkers` in River configuration:

```go
riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
    Queues: map[string]river.QueueConfig{
        "thumbnails": {MaxWorkers: 20}, // Increased from 10
    },
    Workers: workers,
})
```

### Troubleshooting Guide

| Problem | Symptoms | Solution |
|---------|----------|----------|
| **High Queue Depth** | Jobs accumulating, not processing | Scale workers horizontally, check for stuck jobs |
| **High Dead Tuple %** | Slow query performance | Tune autovacuum settings, manual VACUUM if needed |
| **Worker Crashes** | Jobs stuck in "running" state | Check logs, memory limits, increase error handling |
| **Slow Job Processing** | High p95/p99 latency | Check indexes, analyze query plans, optimize workers |
| **Database Bloat** | Disk usage growing | Manual VACUUM FULL (requires downtime), reindex |
| **Connection Pool Exhaustion** | "too many connections" errors | Tune pgxpool settings, reduce MaxWorkers |

---

## Production Deployment

### Environment Variables

Both Go microservices require the following environment variables:

#### Common Configuration (Both Services)

```bash
# PostgreSQL Connection
DATABASE_URL=postgres://user:password@host:5432/database_name

# AWS Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key-id
AWS_SECRET_ACCESS_KEY=your-secret-access-key

# S3 Bucket
S3_BUCKET=your-bucket-name
```

#### S3 Signer Specific

```bash
# Public endpoint for presigned URLs (MinIO/Docker only)
# For production AWS S3, OMIT this variable entirely
S3_PUBLIC_ENDPOINT=http://localhost:9000
```

**Important**: `S3_PUBLIC_ENDPOINT` is **only for local MinIO** in Docker environments. This tells the S3 signer to generate presigned URLs using `localhost:9000` instead of the internal Docker hostname. For production AWS S3, **do not set this variable** - the service will use standard AWS URLs.

#### Thumbnail Worker Specific

```bash
# Internal S3 endpoint (MinIO/Docker only)
# For production AWS S3, OMIT this variable entirely
AWS_ENDPOINT_URL=http://minio:9000
```

**Important**: `AWS_ENDPOINT_URL` is **only for local MinIO** in Docker environments. For production AWS S3, **do not set this variable** - the service will use standard AWS endpoints.

---

### Development vs Production Configuration

| Configuration | Development (MinIO) | Production (AWS S3) |
|---------------|---------------------|---------------------|
| `AWS_ENDPOINT_URL` | `http://minio:9000` | **Omit** (uses AWS default) |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | **Omit** (uses AWS default) |
| `S3_BUCKET` | `civic-os-files` | Your production bucket name |
| S3 URL Style | Path-style (forced) | Virtual-hosted (AWS default) |
| IAM Authentication | Access keys | Access keys or IAM roles |

---

### Docker Deployment

**Building Images:**

```bash
# Build S3 Signer
docker build -t civic-os/s3-signer:0.10.0 services/s3-signer-go/

# Build Thumbnail Worker
docker build -t civic-os/thumbnail-worker:0.10.0 services/thumbnail-worker-go/
```

**Running with Docker Compose (Production):**

```yaml
services:
  s3-signer:
    image: civic-os/s3-signer:0.10.0
    environment:
      - DATABASE_URL=postgres://user:pass@db-host:5432/civic_os
      - AWS_REGION=us-east-1
      - AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
      - S3_BUCKET=your-production-bucket
      # NO S3_PUBLIC_ENDPOINT for production!
    restart: unless-stopped

  thumbnail-worker:
    image: civic-os/thumbnail-worker:0.10.0
    environment:
      - DATABASE_URL=postgres://user:pass@db-host:5432/civic_os
      - AWS_REGION=us-east-1
      - AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
      - S3_BUCKET=your-production-bucket
      # NO AWS_ENDPOINT_URL for production!
    restart: unless-stopped
```

**Running Standalone:**

```bash
# Set environment variables
export DATABASE_URL="postgres://user:pass@host:5432/civic_os"
export AWS_REGION="us-east-1"
export AWS_ACCESS_KEY_ID="your-key"
export AWS_SECRET_ACCESS_KEY="your-secret"
export S3_BUCKET="your-bucket"

# Run S3 Signer
./s3-signer

# Run Thumbnail Worker (requires libvips and poppler-utils installed)
./thumbnail-worker
```

---

### System Dependencies

#### S3 Signer
- **Go Runtime**: Go 1.23+ (if running from source)
- **Network**: Outbound HTTPS to AWS S3 and PostgreSQL

#### Thumbnail Worker
- **Go Runtime**: Go 1.23+ (if running from source)
- **libvips**: Image processing library (8.x+)
  - Ubuntu/Debian: `apt-get install libvips-dev`
  - RHEL/CentOS: `yum install vips-devel`
  - Alpine: `apk add vips-dev`
- **poppler-utils**: PDF rendering (`pdftoppm` command)
  - Ubuntu/Debian: `apt-get install poppler-utils`
  - RHEL/CentOS: `yum install poppler-utils`
  - Alpine: `apk add poppler-utils`
- **Network**: Outbound HTTPS to AWS S3 and PostgreSQL

**Docker images include all dependencies** - no manual installation needed.

---

### Upgrading from v0.9.0 (Node.js) to v0.10.0 (Go)

**Database Migration:**
The database schema migrates automatically via Sqitch when you update to v0.10.0. The migration adds River job queue tables to the `metadata` schema.

**Service Migration Steps:**

1. **Stop old Node.js services:**
   ```bash
   docker-compose stop s3-signer-node thumbnail-worker-node
   # OR
   systemctl stop civic-os-s3-signer civic-os-thumbnail-worker
   ```

2. **Update database** (if not using automatic Sqitch migrations):
   ```bash
   sqitch deploy
   ```

3. **Update docker-compose.yml or systemd units** to use new Go services

4. **Start new Go services:**
   ```bash
   docker-compose up -d s3-signer thumbnail-worker
   # OR
   systemctl start civic-os-s3-signer-go civic-os-thumbnail-worker-go
   ```

5. **Verify services are running:**
   ```bash
   docker-compose logs s3-signer thumbnail-worker
   # Should see: "River client started"
   ```

**Important**: The new Go services use the **same database tables and triggers** as the Node.js services. File uploads that were in progress during the upgrade will complete automatically with the new workers. No data migration is required.

**Rollback**: If needed, you can roll back by stopping the Go services and restarting the Node.js services. The database changes are backward-compatible.

---

## Migration Plan (✅ COMPLETED in v0.10.0)

The migration from Node.js + LISTEN/NOTIFY to Go + River was completed in v0.10.0. This section is kept for historical reference.

### Phase 1: Preparation ✅ COMPLETED

**Completed Tasks:**
   - Implement `S3PresignWorker` with AWS SDK v2
   - Write unit tests
   - Create Dockerfile

2. **Replace NOTIFY Trigger** (1 day)
   - Update `notify_upload_url_request()` to insert River job
   - Deploy trigger update
   - Verify job insertion

3. **Dual-Write Testing** (3-5 days)
   - Deploy Go service alongside Node.js
   - Configure trigger to insert both NOTIFY and River job
   - Monitor both systems in parallel
   - Compare success rates, latency, errors
   - Load test with 100 req/sec

4. **Cutover** (1 day)
   - Remove NOTIFY trigger
   - Keep only River job insertion
   - Monitor Go service for 24 hours
   - Check for any errors or issues

5. **Decommission Node.js** (1 day)
   - Stop Node.js S3 signer service
   - Remove Node.js container from docker-compose
   - Clean up old code

**Rollback Plan:**
1. Re-enable NOTIFY trigger
2. Restart Node.js service
3. Stop Go service
4. Investigate issues

**Success Criteria:**
- ✅ 100% success rate for presigned URL generation
- ✅ Latency < 100ms (p95)
- ✅ No errors in logs
- ✅ Zero downtime during cutover

---

### Phase 3: Thumbnail Worker Migration (3-4 weeks)

**Tasks:**

1. **Build Go Service** (1 week)
   - Create `services/thumbnail-worker/` directory
   - Implement `ThumbnailArgs` job type
   - Implement `ThumbnailWorker` with bimg (libvips)
   - Implement PDF processing with pdftoppm
   - Write unit tests
   - Create Dockerfile with libvips

2. **Replace NOTIFY Trigger** (1 day)
   - Update `notify_file_uploaded()` to insert River job
   - Deploy trigger update
   - Verify job insertion

3. **Performance Testing** (1 week)
   - Deploy Go service alongside Node.js
   - Configure trigger to insert both NOTIFY and River job
   - Monitor both systems in parallel
   - **Pixel-perfect comparison**: Compare thumbnail output byte-by-byte
   - Load test with 50 images/sec
   - Memory profiling with pprof

4. **Cutover** (1 day)
   - Remove NOTIFY trigger
   - Keep only River job insertion
   - Monitor Go service for 48 hours
   - Check thumbnail quality

5. **Decommission Node.js** (1 day)
   - Stop Node.js thumbnail worker
   - Remove Node.js container
   - Clean up old code

**Rollback Plan:**
1. Re-enable NOTIFY trigger
2. Restart Node.js service
3. Stop Go service
4. Reprocess failed jobs

**Success Criteria:**
- ✅ 100% success rate for thumbnail generation
- ✅ Pixel-perfect output match with Node.js/Sharp
- ✅ Processing time < 2 seconds per image (p95)
- ✅ Memory usage < 500MB per worker
- ✅ No errors in logs

---

### Phase 4: Future Notification Service (When Needed)

**Tasks:**

1. **Design Notification Schema** (2-3 days)
   - Define email/SMS job types
   - Design template system
   - Plan retry logic

2. **Build Go Service** (1 week)
   - Implement `EmailArgs`, `SMSArgs` job types
   - Integrate AWS SES for email
   - Integrate AWS SNS for SMS
   - Implement template rendering
   - Write unit tests

3. **Deploy and Test** (1 week)
   - Deploy Go service
   - Test with small user subset (10-20 users)
   - Monitor delivery rates
   - Check spam scores

4. **Gradual Rollout** (1 week)
   - Increase to 100 users
   - Increase to 1,000 users
   - Full rollout

**Success Criteria:**
- ✅ 99% delivery rate
- ✅ < 1% spam rate
- ✅ Latency < 5 seconds (email sending)
- ✅ No bounces from invalid addresses

---

### Timeline Summary

| Phase | Duration | Risk Level |
|-------|----------|------------|
| **Phase 1: Preparation** | 2-3 days | Low |
| **Phase 2: S3 Signer** | 1-2 weeks | Low |
| **Phase 3: Thumbnail Worker** | 3-4 weeks | Medium |
| **Phase 4: Notifications** | 3-4 weeks | Low |
| **Total** | **2-3 months** | - |

---

## Summary

This guide provides everything needed to migrate Civic OS microservices from Node.js + LISTEN/NOTIFY to Go + River (PostgreSQL table queue):

✅ **Complete architecture diagrams**
✅ **Production-ready Go code examples**
✅ **PostgreSQL trigger replacements**
✅ **Dockerfiles and docker-compose configurations**
✅ **Monitoring queries and operational procedures**
✅ **Step-by-step migration plan with rollback procedures**
✅ **Testing checklist and success criteria**

**Key Benefits:**
- Zero additional infrastructure cost (uses PostgreSQL)
- At-least-once delivery (jobs survive crashes)
- Automatic retries with exponential backoff
- Dead-letter queue for failed jobs
- Transactional guarantees (job + data commit together)
- Independent scaling per service
- Full monitoring via SQL queries

**When to Execute:** When ready to improve reliability and scalability of microservices.

---

**End of Guide**
