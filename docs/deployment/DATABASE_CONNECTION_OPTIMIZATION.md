# Database Connection Optimization Guide

**Problem**: Each Go microservice creates a connection pool without explicit limits, consuming 10-20 connections per service by default. With 3 services (s3-signer, thumbnail-worker, notification-worker) across multiple instances, this quickly exhausts PostgreSQL's connection limit (typically 100 connections).

**Impact**: In demo/multi-tenant environments with many seldom-used instances, connection exhaustion prevents new services from starting.

---

## Solution 1: Explicit Connection Pool Limits (Immediate Fix)

**Recommended for**: All deployments, especially demo/staging environments

River's architecture uses goroutines for concurrency, **not** database connections. A service with `MaxWorkers: 50` can run efficiently with only **2-4 database connections**.

### Implementation

Add pgxpool configuration to limit connections per service:

```go
// Before (uses defaults - 10-20 connections per service)
dbPool, err := pgxpool.New(ctx, databaseURL)

// After (explicitly limits to 4 connections)
poolConfig, err := pgxpool.ParseConfig(databaseURL)
if err != nil {
    log.Fatalf("Failed to parse database URL: %v", err)
}

// Configure connection pool limits
poolConfig.MaxConns = 4                           // Total connections (CRITICAL)
poolConfig.MinConns = 1                           // Minimum idle connections
poolConfig.MaxConnLifetime = 1 * time.Hour        // Recycle connections
poolConfig.MaxConnIdleTime = 5 * time.Minute      // Close idle connections
poolConfig.HealthCheckPeriod = 1 * time.Minute    // Check connection health

dbPool, err := pgxpool.NewWithConfig(ctx, poolConfig)
```

### Connection Budget

With explicit limits, a typical Civic OS deployment uses:

| Service | Connections | Notes |
|---------|-------------|-------|
| S3 Signer | 4 | I/O-bound, goroutines handle concurrency |
| Thumbnail Worker | 4 | CPU-bound, THUMBNAIL_MAX_WORKERS controls parallelism |
| Notification Worker | 4 | I/O-bound (AWS SES), goroutines handle email sending |
| **Total per instance** | **12** | **Down from ~40+ connections** |

**Result**: 70% reduction in database connections per instance.

### Environment Variable Configuration

Make connection limits tunable:

```go
maxConns := getEnvInt("DB_MAX_CONNS", 4)
minConns := getEnvInt("DB_MIN_CONNS", 1)

poolConfig.MaxConns = int32(maxConns)
poolConfig.MinConns = int32(minConns)
```

Add to docker-compose.yml / Kubernetes:
```yaml
environment:
  DB_MAX_CONNS: "3"  # Ultra-low for demo environments
  DB_MIN_CONNS: "1"
```

---

## Solution 2: PgBouncer Connection Pooler (Production)

**Recommended for**: Production deployments with multiple instances or high traffic

PgBouncer sits between services and PostgreSQL, dramatically reducing actual database connections through transaction pooling.

### Architecture

```
[S3 Signer (4 conns)] ─┐
[Thumbnail (4 conns)] ──┼─> [PgBouncer (8 conns)] ─> [PostgreSQL (100 conns)]
[Notification (4 conns)]─┘
```

**With 10 instances**: 120 connections to PgBouncer → **8 connections to PostgreSQL**

### Configuration

**River-Specific Setup** (from River docs):

1. **Transaction pooling for workers** (most connections)
   - Handles job processing efficiently
   - Compatible with River's batch operations

2. **Session pooling for LISTEN/NOTIFY** (2-4 connections per coordinator)
   - Required for River's coordination features
   - Bypasses PgBouncer for these specific connections

**PgBouncer config (pgbouncer.ini)**:
```ini
[databases]
civic_os = host=postgres port=5432 dbname=civic_os pool_mode=transaction

[pgbouncer]
listen_addr = *
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 200      # Total client connections allowed
default_pool_size = 8      # Connections per database
reserve_pool_size = 2      # Emergency connections
max_db_connections = 12    # Maximum connections to PostgreSQL
```

**Service configuration**:
```yaml
services:
  s3-signer:
    environment:
      # Workers use PgBouncer transaction pooling
      DATABASE_URL: postgres://user:pass@pgbouncer:6432/civic_os
      DB_MAX_CONNS: 4

  thumbnail-worker:
    environment:
      DATABASE_URL: postgres://user:pass@pgbouncer:6432/civic_os
      DB_MAX_CONNS: 4
```

**Benefits**:
- 90%+ reduction in PostgreSQL connections
- Handles connection spikes gracefully
- Enables hundreds of client connections with <20 database connections

---

## Solution 3: Consolidated Service (Ultimate Optimization)

**Recommended for**: Small deployments, demo environments, resource-constrained hosts

Combine all three workers into a single Go binary with one connection pool.

### Architecture

```go
// single-worker/main.go
func main() {
    // Single connection pool (4 connections total)
    dbPool, err := pgxpool.NewWithConfig(ctx, poolConfig)

    // Register all workers
    workers := river.NewWorkers()
    river.AddWorker(workers, &S3PresignWorker{...})
    river.AddWorker(workers, &ThumbnailWorker{...})
    river.AddWorker(workers, &NotificationWorker{...})

    // Single River client with multiple queues
    riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
        Queues: map[string]river.QueueConfig{
            "s3_signer":    {MaxWorkers: 20},
            "thumbnails":   {MaxWorkers: 3},
            "notifications": {MaxWorkers: 10},
        },
        Workers: workers,
    })
}
```

**Benefits**:
- **Single connection pool** shared across all workers
- Simplified deployment (1 container instead of 3)
- **4 connections total** instead of 12
- Easier monitoring and logging

**Tradeoffs**:
- Less isolation (one service crash affects all workers)
- Cannot scale workers independently
- More complex codebase organization

---

## Solution 4: On-Demand Service Activation

**Recommended for**: Demo environments with many idle instances

Use systemd socket activation or Kubernetes Horizontal Pod Autoscaler (HPA) to start services only when jobs exist.

### PostgreSQL NOTIFY Trigger

```sql
-- Notify external orchestrator when jobs pending
CREATE OR REPLACE FUNCTION notify_pending_jobs()
RETURNS TRIGGER AS $$
BEGIN
    -- Only notify if queue depth crosses threshold
    IF (SELECT COUNT(*) FROM metadata.river_job WHERE state = 'available') > 0 THEN
        PERFORM pg_notify('river_jobs_pending', '');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER river_job_notify_trigger
    AFTER INSERT ON metadata.river_job
    FOR EACH STATEMENT
    EXECUTE FUNCTION notify_pending_jobs();
```

### Kubernetes CronJob (Scale to Zero)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: check-job-queue
spec:
  schedule: "*/5 * * * *"  # Every 5 minutes
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: queue-checker
            image: postgres:17
            command:
            - /bin/sh
            - -c
            - |
              PENDING=$(psql $DATABASE_URL -t -c "SELECT COUNT(*) FROM metadata.river_job WHERE state='available'")
              if [ "$PENDING" -gt 0 ]; then
                # Scale up workers
                kubectl scale deployment s3-signer --replicas=1
                kubectl scale deployment thumbnail-worker --replicas=1
              else
                # Scale down after idle period
                kubectl scale deployment s3-signer --replicas=0
                kubectl scale deployment thumbnail-worker --replicas=0
              fi
```

**Benefits**:
- Zero connections for idle instances
- Automatic activation when work available
- Ideal for demo/sandbox environments

---

## Recommendation Matrix

| Environment | Solution | Connections/Instance | Notes |
|-------------|----------|---------------------|-------|
| **Demo/Staging** | Solution 1 + 3 | **4** | Consolidated worker with explicit limits |
| **Production (single)** | Solution 1 | **12** | Explicit pool limits per service |
| **Production (multi-instance)** | Solution 1 + 2 | **8** (total) | PgBouncer transaction pooling |
| **Multi-tenant SaaS** | Solution 1 + 2 + 4 | **Variable** | PgBouncer + on-demand scaling |

---

## Implementation Priority

**Phase 1: Immediate Fix** (30 minutes)
1. Add explicit connection pool configuration to all three services
2. Set `DB_MAX_CONNS=3` in docker-compose for demo environments
3. Deploy and verify connection count drops

**Phase 2: Production Optimization** (2-4 hours)
1. Deploy PgBouncer container
2. Configure transaction pooling for workers
3. Update service DATABASE_URLs to point to PgBouncer
4. Monitor connection usage

**Phase 3: Long-term** (1-2 days)
1. Create consolidated-worker binary
2. Add on-demand scaling for demo environments
3. Document connection monitoring queries

---

## Monitoring Queries

Check current connection usage:

```sql
-- Connections by application
SELECT application_name, COUNT(*)
FROM pg_stat_activity
WHERE datname = 'civic_os'
GROUP BY application_name
ORDER BY COUNT(*) DESC;

-- Connection pool efficiency
SELECT
    application_name,
    state,
    COUNT(*),
    AVG(EXTRACT(EPOCH FROM (now() - state_change))) AS avg_state_duration_sec
FROM pg_stat_activity
WHERE datname = 'civic_os'
GROUP BY application_name, state;

-- Identify connection leaks (long-running idle)
SELECT pid, application_name, state, state_change, query
FROM pg_stat_activity
WHERE datname = 'civic_os'
  AND state = 'idle'
  AND state_change < now() - interval '5 minutes'
ORDER BY state_change;
```

---

## References

- River PgBouncer documentation: https://riverqueue.com/docs/pgbouncer
- pgx connection pooling: https://pkg.go.dev/github.com/jackc/pgx/v5/pgxpool
- PostgreSQL connection limits: https://www.postgresql.org/docs/current/runtime-config-connection.html
