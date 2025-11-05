# S3 Signer Service (Go + River)

A Go microservice that generates presigned S3 URLs for secure file uploads and downloads in Civic OS. Uses River (PostgreSQL-based job queue) for reliable, at-least-once delivery with automatic retries.

## Features

- ✅ **At-least-once delivery** - Jobs survive crashes and restarts
- ✅ **Automatic retries** - Exponential backoff (max 25 attempts)
- ✅ **Presigned URLs** - Secure, time-limited S3 access (15 min upload, 1 hour download)
- ✅ **Graceful shutdown** - Completes in-flight jobs before stopping
- ✅ **Horizontal scaling** - Run multiple instances for high throughput
- ✅ **Monitoring** - Query job status via SQL

## Architecture

```
File Upload Request (Angular)
  ↓
request_upload_url() RPC
  ↓
metadata.file_upload_requests INSERT
  ↓
Trigger inserts River job (s3_presign)
  ↓
S3 Signer Worker claims job (FOR UPDATE SKIP LOCKED)
  ↓
Generates presigned S3 URL via AWS SDK
  ↓
Updates database with presigned_url and file_id
  ↓
Angular polls get_upload_url() to retrieve URL
  ↓
Angular uploads file directly to S3
```

## Prerequisites

- **Go 1.23+**
- **PostgreSQL 17** with River schema (v0.10.0+ migration)
- **AWS credentials** (via environment variables or IAM role)

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:postgres@localhost:5432/civic_os` |
| `AWS_REGION` | AWS region for S3 | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS access key (or use IAM role) | - |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (or use IAM role) | - |

## Development

### Build

```bash
go build -o s3-signer
```

### Run Locally

```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/civic_os"
export AWS_REGION="us-east-1"
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"

./s3-signer
```

### Run with Docker Compose

The service is included in `docker-compose.yml` for local development:

```bash
docker-compose up -d s3-signer
docker-compose logs -f s3-signer
```

## Production Deployment

### Docker

```bash
docker build -t civic-os/s3-signer:0.10.0 .
docker run -d \
  -e DATABASE_URL="postgres://user:pass@host:5432/civic_os" \
  -e AWS_REGION="us-east-1" \
  -e AWS_ACCESS_KEY_ID="..." \
  -e AWS_SECRET_ACCESS_KEY="..." \
  --name s3-signer \
  civic-os/s3-signer:0.10.0
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: s3-signer
spec:
  replicas: 3  # Scale as needed
  selector:
    matchLabels:
      app: s3-signer
  template:
    metadata:
      labels:
        app: s3-signer
    spec:
      containers:
      - name: s3-signer
        image: civic-os/s3-signer:0.10.0
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: civic-os-secrets
              key: database-url
        - name: AWS_REGION
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

## Monitoring

### Queue Depth

```sql
SELECT COUNT(*)
FROM metadata.river_job
WHERE queue = 's3_signer' AND state = 'available';
```

### Failed Jobs (Dead-Letter Queue)

```sql
SELECT id, args, errors, attempt, max_attempts, created_at
FROM metadata.river_job
WHERE queue = 's3_signer' AND state = 'discarded'
ORDER BY finalized_at DESC
LIMIT 100;
```

### Job Latency (p95)

```sql
SELECT
  percentile_cont(0.95) WITHIN GROUP (ORDER BY finalized_at - scheduled_at) AS p95_latency
FROM metadata.river_job
WHERE queue = 's3_signer'
  AND state = 'completed'
  AND finalized_at > NOW() - INTERVAL '1 hour';
```

### Running Jobs

```sql
SELECT id, args, attempt, attempted_at
FROM metadata.river_job
WHERE queue = 's3_signer' AND state = 'running';
```

## Troubleshooting

### Jobs stuck in "available" state

Check that the service is running and connected to the database:

```bash
docker-compose logs s3-signer
```

### AWS credentials errors

Verify credentials are set correctly:

```bash
# Test AWS credentials
aws s3 ls --profile your-profile

# Check environment variables
echo $AWS_ACCESS_KEY_ID
echo $AWS_SECRET_ACCESS_KEY
```

### High error rate

Check the `errors` JSONB column for specific error messages:

```sql
SELECT args->>'request_id', errors
FROM metadata.river_job
WHERE queue = 's3_signer' AND state = 'retryable'
ORDER BY created_at DESC
LIMIT 10;
```

## Performance

- **Cold start**: ~50ms
- **Memory usage**: ~100-150MB per instance
- **Throughput**: 100+ jobs/sec per instance (I/O-bound)
- **Concurrency**: 50 workers per instance (configurable)

## Related

- **File Storage Guide**: `docs/development/FILE_STORAGE.md`
- **Go Microservices Guide**: `docs/development/GO_MICROSERVICES_GUIDE.md`
- **River Documentation**: https://riverqueue.com/docs
