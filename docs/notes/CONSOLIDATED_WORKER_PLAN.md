# Consolidated Worker Plan

**Purpose**: Combine s3-signer, thumbnail-worker, and notification-worker into a single Go binary to minimize database connections for demo environments with limited connection pools (22 connections).

**Target**: Execute after finalizing the notifications service

**Connection Savings**: 12 connections → 4 connections per instance (67% reduction)

---

## Problem Statement

Current architecture uses three separate Go microservices:
- **s3-signer**: ~16 connections (pgxpool default: 4 × NumCPU)
- **thumbnail-worker**: ~16 connections
- **notification-worker**: ~16 connections
- **Total per instance**: ~48 connections

Demo environment has **22 connection limit** total. This prevents running multiple instances on shared database.

---

## Solution: Single Binary, Single Connection Pool

Merge all three workers into `consolidated-worker` binary with:
- **Single pgxpool** (4 connections total)
- **Single River client** with multiple queues
- **Single LISTEN/NOTIFY connection** (all workers share job queue notifications)
- **Three queue configurations** (s3_signer, thumbnails, notifications)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  consolidated-worker                                    │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  pgxpool (MaxConns: 4)                           │  │
│  │  - 1 connection: LISTEN/NOTIFY (all queues)      │  │
│  │  - 3 connections: Job processing (shared pool)   │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  River Client (single instance)                  │  │
│  │                                                   │  │
│  │  Queue: s3_signer     (MaxWorkers: 20)          │  │
│  │  Queue: thumbnails    (MaxWorkers: 3)           │  │
│  │  Queue: notifications (MaxWorkers: 10)          │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Workers (registered with single River client)   │  │
│  │                                                   │  │
│  │  - S3PresignWorker                               │  │
│  │  - ThumbnailWorker                               │  │
│  │  - NotificationWorker                            │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Create Consolidated Binary

**File**: `services/consolidated-worker/main.go`

**Structure**:
```go
package main

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river"
    "github.com/riverqueue/river/riverdriver/riverpgxv5"
)

func main() {
    ctx := context.Background()

    // 1. Configure connection pool with explicit limits
    poolConfig, err := pgxpool.ParseConfig(databaseURL)
    if err != nil {
        log.Fatalf("Failed to parse database URL: %v", err)
    }

    // CRITICAL: Explicit connection limits
    poolConfig.MaxConns = getEnvInt("DB_MAX_CONNS", 4)
    poolConfig.MinConns = 1
    poolConfig.MaxConnLifetime = 1 * time.Hour
    poolConfig.MaxConnIdleTime = 5 * time.Minute
    poolConfig.HealthCheckPeriod = 1 * time.Minute

    dbPool, err := pgxpool.NewWithConfig(ctx, poolConfig)
    if err != nil {
        log.Fatalf("Failed to create database pool: %v", err)
    }
    defer dbPool.Close()

    // 2. Initialize S3 client (shared by S3 signer and thumbnail worker)
    s3Client, s3PresignClient := initializeS3Client(ctx)

    // 3. Initialize AWS SES client (for notification worker)
    sesClient := initializeSESClient(ctx)

    // 4. Register all workers
    workers := river.NewWorkers()
    river.AddWorker(workers, &S3PresignWorker{
        s3Client:        s3Client,
        s3PresignClient: s3PresignClient,
        dbPool:          dbPool,
    })
    river.AddWorker(workers, &ThumbnailWorker{
        s3Client: s3Client,
        dbPool:   dbPool,
    })
    river.AddWorker(workers, &NotificationWorker{
        sesClient: sesClient,
        dbPool:    dbPool,
    })

    // 5. Create single River client with multiple queues
    riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
        Queues: map[string]river.QueueConfig{
            "s3_signer":    {MaxWorkers: 20},  // I/O-bound, many workers
            "thumbnails":   {MaxWorkers: 3},   // CPU-bound, few workers
            "notifications": {MaxWorkers: 10}, // I/O-bound, moderate workers
        },
        Workers: workers,
        Logger:  slog.Default(),
        Schema:  "metadata",
    })
    if err != nil {
        log.Fatalf("Failed to create River client: %v", err)
    }

    // 6. Start River client (single LISTEN/NOTIFY for all queues)
    if err := riverClient.Start(ctx); err != nil {
        log.Fatalf("Failed to start River client: %v", err)
    }

    log.Println("🚀 Consolidated worker running!")
    log.Println("Queues: s3_signer (20 workers), thumbnails (3 workers), notifications (10 workers)")
    log.Println("Database connections: 4 total")

    // 7. Graceful shutdown
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    <-sigChan

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    riverClient.Stop(shutdownCtx)
}
```

**Key Components**:
- `initializeS3Client()` - Extracted from s3-signer/main.go
- `initializeSESClient()` - From notification-worker/main.go
- `S3PresignWorker` - Copy from s3-signer (implements river.Worker interface)
- `ThumbnailWorker` - Copy from thumbnail-worker
- `NotificationWorker` - Copy from notification-worker

---

### Phase 2: Environment Variables

**Consolidated Configuration**:
```bash
# Database (shared pool)
DATABASE_URL=postgres://user:pass@host:5432/civic_os
DB_MAX_CONNS=4      # Total connections for all workers
DB_MIN_CONNS=1

# S3 (for s3-signer and thumbnail-worker)
S3_BUCKET=civic-os-files
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_REGION=us-east-1
S3_ENDPOINT=...
S3_PUBLIC_ENDPOINT=...

# Thumbnail Worker
THUMBNAIL_MAX_WORKERS=3  # CPU-bound, limit based on memory

# AWS SES (for notification-worker)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
FROM_EMAIL=noreply@yourdomain.com
```

**Optional Tuning** (for high-traffic production):
```bash
DB_MAX_CONNS=6  # Increase if queue depth grows
```

---

### Phase 3: Docker Configuration

**New Dockerfile**: `services/consolidated-worker/Dockerfile`

```dockerfile
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Copy go.mod and go.sum (assuming mono-repo structure)
COPY services/consolidated-worker/go.mod services/consolidated-worker/go.sum ./
RUN go mod download

# Copy source code
COPY services/consolidated-worker/ ./

# Build binary
RUN CGO_ENABLED=0 GOOS=linux go build -o consolidated-worker .

# Final stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

COPY --from=builder /app/consolidated-worker .

CMD ["./consolidated-worker"]
```

**docker-compose.yml Changes**:
```yaml
services:
  # REMOVE these three services:
  # s3-signer:
  # thumbnail-worker:
  # notification-worker:

  # ADD consolidated worker:
  consolidated-worker:
    image: ghcr.io/civic-os/consolidated-worker:v0.11.0
    build:
      context: ./services/consolidated-worker
    environment:
      DATABASE_URL: ${DATABASE_URL}
      DB_MAX_CONNS: ${DB_MAX_CONNS:-4}

      # S3 Configuration
      S3_BUCKET: ${S3_BUCKET:-civic-os-files}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY}
      S3_REGION: ${S3_REGION:-us-east-1}
      S3_ENDPOINT: ${S3_ENDPOINT}
      S3_PUBLIC_ENDPOINT: ${S3_PUBLIC_ENDPOINT}

      # Thumbnail Configuration
      THUMBNAIL_MAX_WORKERS: ${THUMBNAIL_MAX_WORKERS:-3}

      # AWS SES Configuration
      AWS_REGION: ${AWS_REGION:-us-east-1}
      AWS_ACCESS_KEY_ID: ${AWS_SES_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SES_SECRET_ACCESS_KEY}
      FROM_EMAIL: ${FROM_EMAIL}
    depends_on:
      - postgres
    restart: unless-stopped
```

---

### Phase 4: Kubernetes Deployment

**Deployment**: `k8s/consolidated-worker.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: consolidated-worker
  namespace: civic-os
spec:
  replicas: 1  # Scale as needed
  selector:
    matchLabels:
      app: consolidated-worker
  template:
    metadata:
      labels:
        app: consolidated-worker
    spec:
      containers:
      - name: consolidated-worker
        image: ghcr.io/civic-os/consolidated-worker:v0.11.0
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: civic-os-secrets
              key: database-url
        - name: DB_MAX_CONNS
          value: "4"
        - name: S3_BUCKET
          valueFrom:
            configMapKeyRef:
              name: civic-os-config
              key: s3-bucket
        - name: S3_ACCESS_KEY_ID
          valueFrom:
            secretKeyRef:
              name: civic-os-secrets
              key: s3-access-key-id
        - name: S3_SECRET_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: civic-os-secrets
              key: s3-secret-access-key
        - name: THUMBNAIL_MAX_WORKERS
          value: "3"
        - name: AWS_SES_ACCESS_KEY_ID
          valueFrom:
            secretKeyRef:
              name: civic-os-secrets
              key: aws-ses-access-key-id
        - name: AWS_SES_SECRET_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: civic-os-secrets
              key: aws-ses-secret-access-key
        - name: FROM_EMAIL
          valueFrom:
            configMapKeyRef:
              name: civic-os-config
              key: from-email
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
```

---

## Migration Path

### Step 1: Build and Test Consolidated Worker
```bash
cd services/consolidated-worker
go mod init github.com/civic-os/consolidated-worker
go mod tidy
go build -o consolidated-worker .
```

### Step 2: Local Testing
```bash
# Update docker-compose.yml to use consolidated-worker
docker-compose down
docker-compose up -d --build

# Monitor connection usage
docker exec civic-os-postgres psql -U postgres civic_os -c \
  "SELECT COUNT(*) FROM pg_stat_activity WHERE datname = 'civic_os';"

# Expected: ~4 connections (down from ~12)
```

### Step 3: Verify Job Processing
```bash
# Upload a file (triggers s3_signer and thumbnails queues)
# Send a notification (triggers notifications queue)
# Check River job completion:

docker exec civic-os-postgres psql -U postgres civic_os -c \
  "SELECT queue, state, COUNT(*) FROM metadata.river_job GROUP BY queue, state;"
```

### Step 4: Production Deployment
```bash
# Build and push consolidated worker image
docker build -t ghcr.io/civic-os/consolidated-worker:v0.11.0 services/consolidated-worker
docker push ghcr.io/civic-os/consolidated-worker:v0.11.0

# Update production docker-compose or Kubernetes manifests
# Deploy (existing 3 services will stop, consolidated-worker starts)
# Monitor job queues and connection counts
```

---

## Testing Strategy

### Unit Tests
- Test each worker independently (S3PresignWorker, ThumbnailWorker, NotificationWorker)
- Mock dependencies (S3 client, SES client, dbPool)

### Integration Tests
1. **Connection Pool Test**:
   - Start consolidated-worker
   - Query `pg_stat_activity` to verify ≤4 connections
   - Submit jobs to all three queues
   - Verify connection count stays ≤4 under load

2. **Job Processing Test**:
   - Submit 10 S3 presign jobs → verify completion
   - Submit 5 thumbnail jobs → verify images processed
   - Submit 3 notification jobs → verify emails sent

3. **Graceful Shutdown Test**:
   - Start jobs
   - Send SIGTERM
   - Verify River completes in-flight jobs before shutdown
   - Verify no connection leaks

### Performance Tests
- Benchmark job throughput (jobs/second) vs. separate services
- Measure latency (job submission → completion)
- Verify CPU/memory usage stays within resource limits

---

## Rollback Plan

If consolidated-worker has issues:

1. **Revert docker-compose.yml**:
   - Remove `consolidated-worker` service
   - Re-add `s3-signer`, `thumbnail-worker`, `notification-worker`

2. **Redeploy previous images**:
   ```bash
   docker-compose pull s3-signer thumbnail-worker notification-worker
   docker-compose up -d
   ```

3. **Verify job processing resumes** with separate services

---

## Connection Usage Comparison

### Current Architecture (3 separate services)
```
Instance 1:
- s3-signer:        16 connections
- thumbnail-worker: 16 connections
- notification-worker: 16 connections
Total: 48 connections

Demo Environment (22 connection limit):
- Can run: 0.45 instances (OVER LIMIT)
```

### Consolidated Worker Architecture
```
Instance 1:
- consolidated-worker: 4 connections

Demo Environment (22 connection limit):
- Can run: 5 instances (with 2 connections spare)
```

**Improvement**: 1200% increase in instance density (0.45 → 5 instances per database)

---

## Documentation Updates

After implementation:

1. **Update INTEGRATOR_GUIDE.md**:
   - Replace 3-service architecture with consolidated-worker
   - Update deployment instructions
   - Add connection tuning guidance

2. **Update GO_MICROSERVICES_GUIDE.md**:
   - Add consolidated-worker section
   - Explain when to use consolidated vs. separate services
   - Document connection pool configuration

3. **Update docker-compose examples**:
   - `examples/pothole/docker-compose.yml`
   - `examples/broader-impacts/docker-compose.yml`
   - `examples/community-center/docker-compose.yml`

4. **Update PRODUCTION.md**:
   - Replace 3-service deployment with consolidated-worker
   - Update Kubernetes manifests
   - Add connection monitoring queries

---

## Trade-offs

### Advantages ✅
- **67% reduction in connections** (12 → 4 per instance)
- **Single LISTEN/NOTIFY** connection for all queues
- **Simpler deployment** (1 container instead of 3)
- **Easier monitoring** (single service to track)
- **Shared connection pool** (more efficient utilization)

### Disadvantages ❌
- **Less isolation**: One service crash affects all workers
- **Cannot scale queues independently**: Can't run more thumbnail workers without scaling everything
- **Larger binary**: ~15MB vs. 5MB per service
- **Shared memory**: All workers compete for same resources

### Recommendation
- **Demo/staging**: Use consolidated-worker (connection-constrained environments)
- **Production (single instance)**: Use consolidated-worker (simpler ops)
- **Production (multi-instance, high traffic)**: Consider separate services + PgBouncer (scale queues independently)

---

## Success Metrics

- ✅ Connection count ≤4 per instance (measured via `pg_stat_activity`)
- ✅ Job processing throughput matches current 3-service architecture
- ✅ No increase in job latency (submission → completion time)
- ✅ Graceful shutdown completes in <10 seconds
- ✅ CPU/memory usage within resource limits (512Mi-1Gi)

---

## Timeline Estimate

| Phase | Duration | Tasks |
|-------|----------|-------|
| Phase 1: Code | 4-6 hours | Create main.go, extract workers, add tests |
| Phase 2: Docker | 1-2 hours | Dockerfile, docker-compose updates |
| Phase 3: Testing | 2-3 hours | Integration tests, connection verification |
| Phase 4: Docs | 1-2 hours | Update guides, examples |
| **Total** | **8-13 hours** | Full implementation + testing + documentation |

---

## Next Steps

1. **Wait for notification-worker finalization** (per user request)
2. **Create consolidated-worker directory** structure
3. **Extract common code** (S3 client init, SES client init)
4. **Implement main.go** following this plan
5. **Write integration tests** for connection pooling
6. **Update docker-compose** and examples
7. **Test locally** with connection monitoring
8. **Deploy to demo environment** and verify 4-connection limit
9. **Update documentation** with new architecture
10. **Release as v0.11.0** with migration guide

---

## Questions for Finalization

Before implementation:
- [ ] Should THUMBNAIL_MAX_WORKERS be dynamically calculated based on available memory?
- [ ] Should we support runtime queue configuration (enable/disable queues via env vars)?
- [ ] Should consolidated-worker support graceful draining (finish all jobs before shutdown)?
- [ ] Should we include Prometheus metrics endpoint for monitoring?
- [ ] Should the binary support a "compatibility mode" that runs only one queue type (for phased migration)?
