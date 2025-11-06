# Thumbnail Worker (Go + River + bimg)

A Go microservice that generates thumbnails for uploaded images and PDFs in Civic OS. Uses River (PostgreSQL-based job queue) for reliable processing with automatic retries, and bimg (libvips) for fast image manipulation.

## Features

- ✅ **Image thumbnails** - 3 sizes (small: 150x150, medium: 400x400, large: 800x800)
- ✅ **PDF thumbnails** - First page converted to image, then thumbnailed
- ✅ **High performance** - libvips is 4-8x faster than ImageMagick
- ✅ **At-least-once delivery** - Jobs survive crashes and restarts
- ✅ **Automatic retries** - Exponential backoff (max 25 attempts)
- ✅ **Graceful shutdown** - Completes in-flight jobs before stopping
- ✅ **Horizontal scaling** - Run multiple instances for high throughput

## Architecture

```
File Uploaded to S3 (Angular)
  ↓
metadata.files INSERT (thumbnail_status='pending')
  ↓
Trigger inserts River job (thumbnail_generate)
  ↓
Thumbnail Worker claims job (FOR UPDATE SKIP LOCKED)
  ↓
Downloads original from S3
  ↓
Generates 3 thumbnails (bimg/libvips)
  ↓
Uploads thumbnails to S3
  ↓
Updates database with thumbnail keys and status='completed'
  ↓
Angular displays thumbnails
```

## Prerequisites

- **Go 1.23+**
- **PostgreSQL 17** with River schema (v0.10.0+ migration)
- **AWS credentials** (via environment variables or IAM role)
- **System dependencies**:
  - libvips 8.x (image processing library)
  - poppler-utils (PDF to image conversion)

### Installing System Dependencies

**macOS (Homebrew):**
```bash
brew install vips poppler
```

**Ubuntu/Debian:**
```bash
sudo apt-get install libvips-dev poppler-utils
```

**Alpine Linux (Docker):**
```bash
apk add vips-dev poppler-utils
```

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:postgres@localhost:5432/civic_os` |
| `AWS_REGION` | AWS region for S3 | `us-east-1` |
| `S3_BUCKET` | S3 bucket name for files | `civic-os-files` |
| `AWS_ACCESS_KEY_ID` | AWS access key (or use IAM role) | - |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (or use IAM role) | - |
| `THUMBNAIL_MAX_WORKERS` | Max concurrent workers (tune based on CPU/memory) | `5` |

## Development

### Build

```bash
go build -o thumbnail-worker
```

### Run Locally

```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/civic_os"
export AWS_REGION="us-east-1"
export S3_BUCKET="civic-os-files"
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"

./thumbnail-worker
```

### Run with Docker Compose

The service is included in `docker-compose.yml` for local development:

```bash
docker-compose up -d thumbnail-worker
docker-compose logs -f thumbnail-worker
```

## Production Deployment

### Docker

```bash
docker build -t civic-os/thumbnail-worker:0.10.0 .
docker run -d \
  -e DATABASE_URL="postgres://user:pass@host:5432/civic_os" \
  -e AWS_REGION="us-east-1" \
  -e S3_BUCKET="civic-os-files" \
  -e AWS_ACCESS_KEY_ID="..." \
  -e AWS_SECRET_ACCESS_KEY="..." \
  --name thumbnail-worker \
  civic-os/thumbnail-worker:0.10.0
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thumbnail-worker
spec:
  replicas: 3  # Scale based on CPU usage
  selector:
    matchLabels:
      app: thumbnail-worker
  template:
    metadata:
      labels:
        app: thumbnail-worker
    spec:
      containers:
      - name: thumbnail-worker
        image: civic-os/thumbnail-worker:0.10.0
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: civic-os-secrets
              key: database-url
        - name: AWS_REGION
          value: "us-east-1"
        - name: S3_BUCKET
          value: "civic-os-files"
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "2000m"
```

## Monitoring

### Queue Depth

```sql
SELECT COUNT(*)
FROM metadata.river_job
WHERE queue = 'thumbnails' AND state = 'available';
```

### Failed Jobs (Dead-Letter Queue)

```sql
SELECT id, args, errors, attempt, max_attempts, created_at
FROM metadata.river_job
WHERE queue = 'thumbnails' AND state = 'discarded'
ORDER BY finalized_at DESC
LIMIT 100;
```

### Job Latency (p95)

```sql
SELECT
  percentile_cont(0.95) WITHIN GROUP (ORDER BY finalized_at - scheduled_at) AS p95_latency
FROM metadata.river_job
WHERE queue = 'thumbnails'
  AND state = 'completed'
  AND finalized_at > NOW() - INTERVAL '1 hour';
```

### Processing Time by File Type

```sql
SELECT
  args->>'file_type' AS file_type,
  COUNT(*) AS total_jobs,
  AVG(EXTRACT(EPOCH FROM (finalized_at - scheduled_at))) AS avg_seconds,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY finalized_at - scheduled_at) AS p95_latency
FROM metadata.river_job
WHERE queue = 'thumbnails'
  AND state = 'completed'
  AND finalized_at > NOW() - INTERVAL '24 hours'
GROUP BY args->>'file_type';
```

## Troubleshooting

### Jobs stuck in "available" state

Check that the service is running:

```bash
docker-compose logs thumbnail-worker
```

### libvips errors

Verify libvips is installed correctly:

```bash
# Check bimg can load libvips
go run main.go  # Should show bimg and libvips versions on startup
```

### PDF processing errors

Verify poppler-utils is installed:

```bash
which pdftoppm  # Should return path
pdftoppm -v     # Should show version
```

### High memory usage

Thumbnail generation is memory-intensive (~100MB per worker). Reduce worker count via `THUMBNAIL_MAX_WORKERS`:

```bash
# Docker
docker run -e THUMBNAIL_MAX_WORKERS=3 ...

# Kubernetes (via ConfigMap)
THUMBNAIL_MAX_WORKERS: "3"

# Tuning guidance:
# - Low memory (512Mi): 2-3 workers
# - Medium memory (1Gi): 5-7 workers
# - High memory (2Gi): 10-12 workers
```

### Slow processing

Check CPU usage. If maxed out, scale horizontally:

```bash
# Docker Compose
docker-compose up -d --scale thumbnail-worker=3

# Kubernetes
kubectl scale deployment thumbnail-worker --replicas=5
```

## Performance

- **Cold start**: ~50ms
- **Memory usage**: ~300-500MB per instance (varies with worker count)
- **Processing time**:
  - Images: 200-500ms per file (depends on size)
  - PDFs: 1-3 seconds per file (PDF conversion adds overhead)
- **Throughput**: 10-20 jobs/sec per instance (CPU-bound, default 5 workers)
- **Concurrency**: Configurable via `THUMBNAIL_MAX_WORKERS` (default: 5)

## Related

- **File Storage Guide**: `docs/development/FILE_STORAGE.md`
- **Go Microservices Guide**: `docs/development/GO_MICROSERVICES_GUIDE.md`
- **bimg Documentation**: https://github.com/h2non/bimg
- **libvips Documentation**: https://www.libvips.org/
