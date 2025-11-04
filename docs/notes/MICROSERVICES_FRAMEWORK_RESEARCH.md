# Microservices Framework Research: Language & Architecture Comparison

**Date**: 2025-11-03  
**Purpose**: Evaluate alternative frameworks and architectures for Civic OS microservices beyond Node.js and Laravel PHP

## Executive Summary

### Quick Recommendations by Service Type

| Service Type | Top Choice | Runner-Up | Why |
|-------------|-----------|-----------|-----|
| **S3 Signer** (I/O-bound) | **Go** | Rust | Sub-50ms cold start, 4-8x less memory than Node, excellent AWS SDK, trivial deployment |
| **Thumbnail Worker** (CPU-intensive) | **Go** (govips/bimg) | Rust (libvips bindings) | Proven production usage, libvips performance (4-8x faster than ImageMagick), simple deployment |
| **Notification Service** (async messaging) | **Go** | Python (FastAPI) | Excellent concurrency, low memory, fast AWS SDK for SES/SNS |

### Key Insight

**Go dominates the microservices space** for these use cases due to:
- Sub-second startup times (vs 30-40s for Spring Boot, 7s for JVM)
- 3-10x lower memory footprint than Java/Node
- Excellent libvips bindings (bimg, govips) matching Sharp performance
- Mature AWS SDK (aws-sdk-go-v2)
- Single binary deployment (no runtime dependencies)
- Container sizes: 2-7MB (scratch base) vs 136MB+ for alternatives

**Critical Architectural Insight**: PostgreSQL LISTEN/NOTIFY has **severe scalability limitations** due to global database lock during commit under high write concurrency. Consider message queue alternatives for production.

---

## Language & Framework Deep Dive

### 1. Go (Golang)

#### Strengths
- **Performance**: Sub-50ms AWS Lambda cold starts (8x faster than Python, 3x faster than Java)
- **Memory**: 100-150MB footprint vs 1GB+ for Java Spring Boot
- **Container Size**: 2-7MB (scratch base), 15-20MB (Alpine)
- **Concurrency**: Goroutines provide excellent I/O handling without callback hell
- **AWS SDK**: Mature aws-sdk-go-v2 with full S3 presigned URL support
- **Image Processing**: bimg and govips provide production-ready libvips bindings
  - 4-8x faster than ImageMagick
  - 10x less memory usage than ImageMagick
  - Used by thousands of production services (Transloadit, QBurst, ptrchm)
- **PostgreSQL**: Strong LISTEN/NOTIFY support via pq and pgx drivers
- **Deployment**: Single statically-linked binary, no runtime dependencies

#### Weaknesses
- **Learning Curve**: Error handling verbosity, pointer management
- **Generics**: Recently added (Go 1.18), ecosystem still catching up
- **Dependency Management**: go.mod can be quirky with versioning

#### Production Examples
- **Imaginary** (github.com/h2non/imaginary): Fast HTTP microservice for image processing backed by libvips
- **Transloadit**: Built image processing server with Go + libvips
- **QBurst**: High-performance image resizer proxy offloading NGINX

#### Container Recommendations
- **Use scratch** for statically-compiled binaries (smallest footprint)
- **Use Alpine** if you need shell access for debugging (5MB base + app)
- **Avoid distroless** unless you need ca-certificates (Go can bundle these)

#### Cost Profile (AWS Lambda)
- **1 req/sec**: ~$5/month (128MB memory, 50ms duration)
- **10 req/sec**: ~$50/month
- **100 req/sec**: **$500+/month** (consider containers at this scale)

#### Verdict
**Best choice for all three services**. Excellent balance of performance, developer productivity, and operational simplicity.

---

### 2. Rust

#### Strengths
- **Performance**: Best-in-class cold start (30ms AWS Lambda, 33% faster than Go)
- **Memory Safety**: Ownership model prevents entire classes of bugs
- **Container Size**: 15.9MB minimal image (comparable to Go)
- **AWS SDK**: aws-sdk-rust reached GA in 2024, integrates well with Tokio
- **Concurrency**: Tokio async runtime (work-stealing scheduler, excellent for I/O)
- **Image Processing**: libvips-rust-bindings (olxgroup-oss) available but less mature

#### Weaknesses
- **Learning Curve**: Steep for borrow checker, lifetime annotations
- **Compile Times**: Significantly slower than Go (impacts dev workflow)
- **Ecosystem Maturity**: Fewer production examples, smaller community
- **Image Processing**: libvips bindings less battle-tested than Go equivalents
- **CPU-Bound Tasks**: Requires separate thread pool (rayon) alongside Tokio

#### CPU-Bound Task Pattern
```rust
// Tokio for I/O, rayon for CPU work
tokio::spawn(async move {
    let result = rayon::spawn(|| expensive_cpu_work()).await;
});
```

#### PostgreSQL Support
- **tokio-postgres**: Excellent async support
- **sqlx**: Stream-based PgListener with auto-reconnect

#### Verdict
**Excellent for greenfield projects with performance-critical requirements**, but Go's ecosystem maturity and faster development cycle make it more practical for most teams.

---

### 3. Java/Kotlin + Spring Boot

#### Traditional JVM

**Strengths**
- **AWS SDK**: Most mature SDK (has existed longest)
- **Enterprise Tooling**: Excellent observability, monitoring, debugging
- **Image Processing**: ImageIO, TwelveMonkeys, Thumbnailator (adequate)
- **Spring Cloud**: Comprehensive microservices patterns (service discovery, config, etc.)

**Weaknesses**
- **Memory**: 1GB+ minimum for basic Spring Boot app
- **Startup Time**: 30-40 seconds (catastrophic for auto-scaling)
- **Container Size**: 361MB (JVM-based)
- **Cold Start**: ~100ms AWS Lambda (even with SnapStart)

#### GraalVM Native Image

**Strengths**
- **Startup Time**: Reduced to ~2s (4x faster than JVM)
- **Memory**: ~360MB reduction in container size (136MB total)
- **Performance**: 10% better throughput, 5% faster response time
- **AWS Lambda**: Better suited for FaaS with instant startup

**Weaknesses**
- **Build Time**: 5 minutes (vs 25 seconds for JVM)
- **Native Executable Size**: Often 2x larger than JAR (includes full runtime)
- **Ecosystem**: Not all Spring features supported, reflection requires configuration

#### Verdict
**Only viable with GraalVM Native Image**, but still **lags Go/Rust significantly**. Use only if team expertise is Java-first or enterprise tooling is required.

---

### 4. C# / .NET Core

#### Strengths
- **AWS SDK**: Mature and well-maintained
- **Image Processing**: ImageSharp (high performance, pure .NET, no native deps)
  - Performance competitive with libvips in some benchmarks
  - SkiaSharp also available (faster, more memory efficient in tests)
- **ASP.NET Core**: Excellent web framework, good async support
- **Cross-Platform**: Runs on Linux containers efficiently
- **Self-Contained Deployment**: Can bundle runtime for smaller images

#### Weaknesses
- **ImageSharp Licensing**: **Requires paid commercial license** (expensive for projects)
- **Container Size**: Larger than Go/Rust (even with runtime-deps optimization)
- **Memory**: Higher than Go (though better than Java)
- **Community**: Smaller Linux/container ecosystem compared to Go

#### Container Optimization
- Use `runtime-deps` images with self-contained binaries (eliminates .NET runtime)
- Reduces size but still larger than Go/Rust equivalents

#### Verdict
**Viable if team is C#/.NET-first**, but **ImageSharp licensing is a dealbreaker** for cost-sensitive projects. SkiaSharp is free but less idiomatic.

---

### 5. Python

#### Strengths
- **AWS SDK (boto3)**: Most mature AWS SDK, gold standard
- **Image Processing**: Pillow, pyvips (Python libvips bindings)
  - pyvips: 0.18s runtime, 49MB memory (only 20% slower than C libvips)
- **FastAPI**: Excellent async framework for APIs
  - On par with Node.js when properly configured (gunicorn workers, asyncpg)
  - Better for I/O-bound operations (database queries, S3 uploads)
- **PostgreSQL**: psycopg2/psycopg3 with excellent LISTEN/NOTIFY support

#### Weaknesses
- **Cold Start**: 325ms AWS Lambda (slowest of all options)
- **Performance**: 3x slower than Node.js for database operations (SQLAlchemy)
- **Memory**: Higher than Go/Rust
- **Concurrency**: GIL limits CPU-bound parallelism (non-issue for I/O)
- **Container Size**: Larger than compiled languages (even on Alpine)

#### Configuration Matters
- **Single worker**: FastAPI is slow
- **Multiple gunicorn workers + asyncpg**: Competitive with Node.js
- **Database-heavy**: FastAPI can be fastest (better than Express, NestJS)

#### Cost Profile (AWS Lambda)
- **Most expensive** at scale due to slow cold starts and higher memory requirements

#### Verdict
**Good for rapid prototyping** or teams Python-first, but **Go outperforms in every metric** for production microservices.

---

### 6. Elixir / Phoenix

#### Strengths
- **Concurrency**: BEAM VM with actor model (millions of lightweight processes)
- **Fault Tolerance**: OTP supervision trees (self-healing processes)
- **PostgreSQL**: Postgrex with native LISTEN/NOTIFY support
- **AWS SDK**: ExAWS (community-maintained, adequate)
- **Image Processing**: Mogrify (ImageMagick wrapper)

#### Weaknesses
- **AWS SDK**: Not official, community-driven (less mature than Go/Rust/Java)
- **Image Processing**: Relies on ImageMagick (slower, more memory than libvips)
- **CPU-Bound Tasks**: BEAM optimized for I/O, CPU work blocks schedulers
- **Learning Curve**: Functional paradigm, OTP patterns unfamiliar to most devs
- **Container Size**: Larger than Go/Rust
- **Cold Start**: Slower than Go/Rust

#### Best Use Case
**Message-heavy systems** (chat, notifications) where actor model shines, but **not ideal for image processing** (CPU-bound).

#### Verdict
**Excellent for notification service** (email/SMS queues with fault tolerance), but **poor fit for thumbnail worker**. Go is simpler and faster for this use case.

---

## Image Processing Library Comparison

### Performance Benchmarks

| Library | Language | Runtime (crop/shrink/sharpen/save) | Peak Memory | Notes |
|---------|----------|-------------------------------------|-------------|-------|
| **libvips (C)** | C | 0.15s | 40 MB | Baseline |
| **pyvips** | Python | 0.18s (+20%) | 49 MB | Negligible overhead |
| **Sharp** | Node.js | ~0.15s | ~40 MB | Wraps libvips, 4-5x faster than ImageMagick |
| **bimg/govips** | Go | ~0.15s | ~40 MB | Production-proven, 4-8x faster than ImageMagick |
| **Pillow-SIMD** | Python | 0.36s (+140%) | 230 MB | 5-6x worse |
| **ImageMagick** | C | 0.82s (+447%) | 463 MB | 10x more memory, 5x slower |
| **OpenCV** | Python | 0.93s (+520%) | 222 MB | Not designed for thumbnails |
| **ImageSharp** | C# | ~0.60s | ~150 MB | Adequate, requires paid license |
| **SkiaSharp** | C# | ~0.40s | ~100 MB | Better than ImageSharp, free |

### Key Insights

1. **libvips dominates**: All libvips bindings (Sharp, pyvips, bimg, govips) are 4-8x faster than alternatives
2. **Streaming architecture**: libvips processes images in small chunks (low memory) vs ImageMagick (entire image in RAM)
3. **Production usage**: Sharp downloads 250M+/year (2024), recommended by AWS/GCP for Lambda/Cloud Functions
4. **Language overhead**: Minimal (pyvips only 20% slower than C, Go/Node negligible)

### Recommendation

**Use libvips bindings for ANY production image processing**:
- **Go**: bimg (h2non) or govips (davidbyttow) - both production-proven
- **Node.js**: Sharp (current choice, excellent)
- **Python**: pyvips
- **Rust**: libvips-rust-bindings (less mature)

---

## PostgreSQL LISTEN/NOTIFY Analysis

### Architecture

```sql
-- Notify on INSERT
CREATE TRIGGER notify_file_upload
AFTER INSERT ON metadata.files
FOR EACH ROW
EXECUTE FUNCTION pg_notify('file_uploads', row_to_json(NEW)::text);
```

```go
// Go listener (pgx)
conn.Listen(ctx, "file_uploads")
for notification := range conn.Notifications() {
    processFile(notification.Payload)
}
```

### Critical Scalability Limitation

**Problem**: LISTEN/NOTIFY acquires a **global database lock during COMMIT** under high write concurrency.

#### Impact (Real Production Data)

- **Single writer**: No issue
- **10 concurrent writers**: Moderate lock contention
- **50+ concurrent writers**: **Database stalls, immense load, major downtime**

#### Technical Details

1. When `NOTIFY` executes in a transaction, it holds locks until commit
2. Commit phase acquires **global lock on entire database**
3. Serializes ALL commits (not just notify transactions)
4. Lock contention grows exponentially with concurrent writers

### Message Delivery Guarantees

- **At-most-once delivery**: Messages lost on connection failure
- **No durability**: Messages not persisted (lost on crash)
- **8KB payload limit**: Cannot send large data
- **No backpressure**: Slow consumers don't block producers (messages dropped)

### When to Use LISTEN/NOTIFY

✅ **Good for**:
- Low write concurrency (<10 concurrent writers)
- Cache invalidation signals (no durability required)
- Internal dev/test environments
- Simple publish-subscribe patterns

❌ **Avoid for**:
- High-throughput production systems
- Reliable message delivery requirements
- Distributed microservices (horizontal scaling)
- Multi-region deployments

---

## PostgreSQL as Job Queue (Table-Based Pattern)

### Overview

**PostgreSQL can serve as a reliable job queue** using table-based queuing with `FOR UPDATE SKIP LOCKED` (PostgreSQL 9.5+). This provides at-least-once delivery, durability, and horizontal scaling **without** the global lock issues of LISTEN/NOTIFY.

**Key Insight**: Instead of NOTIFY/LISTEN, jobs are stored in a table and workers claim them atomically using row-level locking. This scales to 10,000+ jobs/sec on commodity hardware.

### Core Pattern

```sql
-- Single table for all jobs
CREATE TABLE river_job (
    id BIGSERIAL PRIMARY KEY,
    args JSONB NOT NULL,              -- Job-specific data
    kind VARCHAR NOT NULL,             -- Job type: "s3_presign", "thumbnail", "email"
    queue VARCHAR NOT NULL,            -- Queue name: "s3_signer", "thumbnails", "default"
    state VARCHAR NOT NULL,            -- "available", "running", "completed", etc.
    priority SMALLINT NOT NULL DEFAULT 1,
    scheduled_at TIMESTAMPTZ NOT NULL,
    attempt SMALLINT NOT NULL DEFAULT 0,
    max_attempts SMALLINT NOT NULL DEFAULT 25,
    -- ... more columns
);

-- Atomic job claiming (no blocking)
SELECT id FROM river_job
WHERE state = 'available'
  AND queue = 'thumbnails'
  AND (scheduled_at IS NULL OR scheduled_at <= NOW())
ORDER BY priority ASC, scheduled_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

**How `SKIP LOCKED` Works**: When multiple workers try to claim jobs, each worker locks different rows without waiting. This enables true parallelism without lock contention (unlike LISTEN/NOTIFY's global lock).

### River: Production-Ready PostgreSQL Job Queue for Go

**River** (riverqueue.com) is a mature Go library for PostgreSQL job queues, built by Brandur Leach and Blake Gentry (Heroku veterans).

#### Key Features

✅ **At-least-once delivery** - Jobs survive crashes
✅ **Automatic retries** - Exponential backoff, configurable max attempts
✅ **Dead-letter queue** - Failed jobs preserved for debugging
✅ **Scheduled/delayed jobs** - Run at specific time or after delay
✅ **Periodic/cron jobs** - Run on schedule (hourly, daily, etc.)
✅ **Unique jobs** - Prevent duplicates by args or custom key
✅ **Priority queues** - Order by priority, scheduled time
✅ **Transactional insertion** - Job and data commit atomically
✅ **Strongly-typed workers** - Go generics for type safety
✅ **Optional web UI** - Monitor jobs via River UI
✅ **Graceful shutdown** - Completes in-flight jobs before stopping
✅ **Multi-queue support** - Separate queues with different concurrency limits

#### Performance

- **~10,000 jobs/sec** on MacBook Air (commodity hardware)
- **Similar throughput to Que (Ruby)**: 7,690 jobs/sec on AWS c3.8xlarge
- **Scales to 100,000+ jobs/sec** with optimization (RudderStack case study)

#### Installation

```bash
go get github.com/riverqueue/river
go get github.com/riverqueue/river/riverdriver/riverpgxv5
river migrate-up --database-url "$DATABASE_URL"
```

### Two-Dimensional Routing: `kind` vs `queue`

River uses **two routing dimensions**:

1. **`kind`** - Job type/worker (WHAT to do)
   - Identifies which worker processes the job
   - Examples: "s3_presign", "thumbnail_generate", "send_email"
   - Maps to Go worker structs via registration

2. **`queue`** - Resource pool (WHERE/WHEN to process)
   - Determines which worker pool claims the job
   - Controls concurrency limits (MaxWorkers)
   - Examples: "s3_signer", "thumbnails", "default"

```go
// Job type definition
type S3PresignArgs struct {
    FileID string `json:"file_id"`
}

func (S3PresignArgs) Kind() string {
    return "s3_presign"  // ← Job type
}

func (S3PresignArgs) InsertOpts() river.InsertOpts {
    return river.InsertOpts{
        Queue: "s3_signer",  // ← Queue name
    }
}
```

### Deployment Patterns

#### Pattern 1: Monolithic (All Workers Together)

```go
workers := river.NewWorkers()
river.AddWorker(workers, &S3PresignWorker{})
river.AddWorker(workers, &ThumbnailWorker{})
river.AddWorker(workers, &EmailWorker{})

riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
    Queues: map[string]river.QueueConfig{
        river.QueueDefault: {MaxWorkers: 100},
    },
    Workers: workers,
})
```

**Pros**: Simple, easy to start
**Cons**: Can't scale independently, CPU jobs block I/O jobs

#### Pattern 2: Separate Microservices ✅ **RECOMMENDED**

**S3 Signer Service:**
```go
workers := river.NewWorkers()
river.AddWorker(workers, &S3PresignWorker{}) // ONLY S3 worker

riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
    Queues: map[string]river.QueueConfig{
        "s3_signer": {MaxWorkers: 50}, // I/O-bound, many workers
    },
    Workers: workers,
})
```

**Thumbnail Worker Service:**
```go
workers := river.NewWorkers()
river.AddWorker(workers, &ThumbnailWorker{}) // ONLY thumbnail worker

riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
    Queues: map[string]river.QueueConfig{
        "thumbnails": {MaxWorkers: 10}, // CPU-bound, fewer workers
    },
    Workers: workers,
})
```

**Benefits**:
- Independent scaling (scale thumbnails without scaling S3 signer)
- Resource isolation (CPU-bound vs I/O-bound separation)
- Fault isolation (thumbnail crash doesn't affect S3 signing)
- Independent deployments

### Comparison: LISTEN/NOTIFY vs Table Queue vs Message Brokers

| Feature | LISTEN/NOTIFY | PostgreSQL Table Queue (River) | RabbitMQ | Redis Pub/Sub | AWS SQS |
|---------|---------------|--------------------------------|----------|---------------|---------|
| **Delivery Guarantee** | At-most-once | ✅ At-least-once | ✅ At-least-once | At-most-once | ✅ At-least-once |
| **Persistence** | ❌ Ephemeral | ✅ Durable | ✅ Durable | ❌ Ephemeral | ✅ Durable |
| **Survives Crashes** | ❌ Lost | ✅ Preserved | ✅ Preserved | ❌ Lost | ✅ Preserved |
| **Automatic Retries** | ❌ Manual | ✅ Built-in | ✅ Built-in | ❌ None | ✅ Built-in |
| **Dead-Letter Queue** | ❌ None | ✅ Yes | ✅ Yes | ❌ None | ✅ Yes |
| **Priority Queues** | ❌ None | ✅ Yes (ORDER BY) | ✅ Yes | ❌ None | ❌ None |
| **Scheduled/Delayed Jobs** | ❌ None | ✅ Yes | ⚠️ Plugin | ❌ None | ✅ Yes |
| **Multiple Workers** | ⚠️ Duplicate risk | ✅ Atomic (SKIP LOCKED) | ✅ Yes | ✅ Yes | ✅ Yes |
| **Throughput** | ? | 10k-100k jobs/sec | 50k msg/sec | 1M msg/sec | Auto-scale |
| **Latency** | Very Low (<1ms) | Low (5-10ms) | Low (5-20ms) | Very Low (<1ms) | Medium (100-300ms) |
| **Operational Complexity** | Low | Low | Medium | Low | Very Low (managed) |
| **Scalability** | ❌ Global lock at 50+ writers | ✅ Row locks (horizontal) | ✅ Clustered | ✅ Clustered | ✅ Infinite |
| **Infrastructure Cost** | $0 (included) | $0 (included) | $15-30/month | $10-20/month | Pay-per-use |
| **Transactional Guarantees** | ⚠️ Weak | ✅ ACID (job + data) | ❌ Separate system | ❌ Separate system | ❌ Separate system |

### When to Use PostgreSQL Table Queue

✅ **Good for**:
- Throughput < 50k jobs/sec (well within PostgreSQL capacity)
- Transactional guarantees critical (job + data commit together)
- Minimizing infrastructure complexity (no additional services)
- Development/staging environments (zero setup)
- Teams with strong PostgreSQL expertise

❌ **Consider Alternatives When**:
- Sustained > 50k jobs/sec (PostgreSQL becomes bottleneck)
- Advanced routing needed (topic exchanges, fanout patterns)
- Multi-region replication required (PostgreSQL replication is heavy)
- Need for message TTL/expiration (automatic cleanup)

### Operational Considerations

#### 1. Table Bloat (Critical)

**Problem**: Frequent job updates create dead tuples, slowing queries if not vacuumed.

**Solution**: Aggressive autovacuum tuning
```sql
ALTER TABLE river_job SET (
  autovacuum_vacuum_scale_factor = 0.01,  -- Vacuum at 1% dead (default: 20%)
  autovacuum_vacuum_cost_delay = 1,       -- Aggressive (default: 20ms)
  autovacuum_naptime = 20                 -- Check every 20 seconds
);
```

**Monitoring**:
```sql
SELECT
  relname,
  n_live_tup,
  n_dead_tup,
  ROUND(n_dead_tup * 100.0 / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct
FROM pg_stat_user_tables
WHERE relname = 'river_job';
```

**Alert**: If `dead_pct > 20%`, autovacuum is not keeping up.

#### 2. WAL Growth

**Impact**: 3x write amplification (1 MB logical → 3 MB WAL writes)

**Mitigation**:
- Use `wal_level = replica` (not `logical`)
- Tune `wal_buffers = 64MB` for high-throughput
- Archive old WAL files for point-in-time recovery

#### 3. Index Maintenance

**Critical Index** (River creates automatically):
```sql
CREATE INDEX river_job_state_queue_scheduled_at_id_idx
ON river_job(state, queue, scheduled_at, id)
WHERE state IN ('available', 'retryable');
```

Without this index, workers scan entire table to find jobs.

### Production Examples

#### Heroku (Brandur Leach, River author)
- Used PostgreSQL queue (Que) in primary API for years
- **Issue**: Table bloat from dead tuples slowed job locking
- **Kept it**: Transactional consistency (job rolls back with transaction)

#### RudderStack (100k events/sec)
- **Partitioning**: Capped datasets at 100k rows for fast scans
- **Write amplification**: 3:1 ratio (1 MB → 3 MB physical writes)
- **Solutions**: Composite indexes, COPY bulk inserts, aggressive autovacuum
- **Result**: Scaled PostgreSQL queue to 100k events/sec

#### Que (Ruby, River's inspiration)
- 7,690 jobs/sec on AWS c3.8xlarge (32 cores)
- Proven pattern for 10+ years in production

### Cost Comparison (10 jobs/sec)

| Architecture | Monthly Cost | Notes |
|--------------|--------------|-------|
| **LISTEN/NOTIFY (current)** | $0 | Scalability risk (global lock) |
| **PostgreSQL Table Queue (River)** | $0 | No additional infrastructure |
| **RabbitMQ + Containers** | $46 | $15 managed RabbitMQ + $30 containers |
| **Redis Pub/Sub + Containers** | $30 | $10 managed Redis + $20 containers |
| **AWS SQS + Containers** | $15 | $1 SQS + $10-15 containers |
| **AWS Lambda (Go)** | $150 | Expensive at sustained load |

**Winner**: PostgreSQL table queue at low-medium scale (0 additional cost).

### Recommendation for Civic OS

**Use PostgreSQL Table Queue (River) for all microservices**:

1. **S3 Signer** - Queue: "s3_signer", MaxWorkers: 50 (I/O-bound)
2. **Thumbnail Worker** - Queue: "thumbnails", MaxWorkers: 10 (CPU-bound)
3. **Notification Service** - Queue: "email", MaxWorkers: 100 (async)

**Benefits**:
- Zero additional infrastructure (already have PostgreSQL)
- Transactional job insertion (atomic with business logic)
- At-least-once delivery (survives crashes)
- Automatic retries, dead-letter queue
- Scales to 10,000+ jobs/sec (you need 10-100)
- Simple monitoring (SQL queries)

**Migration Path**:
- Replace NOTIFY triggers with River job inserts
- Deploy Go microservices with River workers
- Keep existing PostgreSQL infrastructure

See `docs/development/GO_MICROSERVICES_GUIDE.md` for complete implementation guide.

### Alternative Architectures (Recommended)

#### 1. **Message Queue (RabbitMQ)**

**Strengths**:
- Reliable delivery (at-least-once, ack-based)
- 50,000 msg/sec throughput (sustainable)
- Advanced routing (exchanges, topics, fanout)
- Durability (persists to disk)
- Handles large files via chunking

**Weaknesses**:
- Operational complexity (clustering, monitoring)
- Slower than Redis (but more reliable)
- Memory usage (queues stored in RAM by default)

**Use Case**: **Best for thumbnail worker** (guaranteed delivery, failure retry, dead-letter queues)

#### 2. **Redis Pub/Sub**

**Strengths**:
- 1M msg/sec throughput (in-memory)
- Simple, fast, low latency
- Already used for caching (shared resource)

**Weaknesses**:
- Fire-and-forget (no durability)
- At-most-once delivery (no acks)
- Not suitable for large files
- No complex routing

**Use Case**: **Good for S3 signer** (lightweight, ephemeral, low latency)

#### 3. **AWS SQS (Managed Queue)**

**Strengths**:
- Fully managed (no ops)
- Infinite scale (auto-scales)
- Dead-letter queues (failure handling)
- Pay-per-use (cost-effective at low volume)

**Weaknesses**:
- Higher latency (100-300ms)
- Eventual consistency (delay in delivery)
- Vendor lock-in

**Use Case**: **Good for notification service** (async email/SMS, retries, no rush)

#### 4. **Kafka / NATS (Event Streaming)**

**Strengths**:
- High throughput (millions msg/sec)
- Durability (replicated log)
- Event replay (reprocess history)
- Multiple consumers (fan-out)

**Weaknesses**:
- High operational complexity (Kafka cluster, Zookeeper)
- Overkill for simple queue patterns
- Steeper learning curve

**Use Case**: **Overkill for Civic OS** (designed for event-sourcing, real-time analytics)

#### 5. **Serverless (AWS Lambda + S3 Events)**

**Strengths**:
- Zero ops (fully managed)
- Auto-scales to zero
- Cost-effective at low volume

**Weaknesses**:
- Cold start latency (30-325ms)
- 15-minute execution limit
- Vendor lock-in
- More expensive at scale (>50 req/sec)

**Use Case**: **Good for thumbnail worker** if traffic is sporadic (<10 req/sec)

---

## Architecture Recommendation Matrix

| Service | Traffic Pattern | Recommended Architecture | Runner-Up |
|---------|-----------------|-------------------------|-----------|
| **S3 Signer** | Bursty (form uploads) | **Redis Pub/Sub** + Go container | AWS Lambda (Go runtime) |
| **Thumbnail Worker** | Steady (background jobs) | **RabbitMQ** + Go container (bimg) | AWS Lambda (Go + govips layer) |
| **Notification Service** | Async (email/SMS) | **AWS SQS** + Go container (AWS SDK) | Elixir + OTP (self-hosted) |

### Cost Comparison (Monthly, 10 req/sec average)

| Architecture | S3 Signer | Thumbnail Worker | Notification Service | Total |
|--------------|-----------|------------------|---------------------|-------|
| **LISTEN/NOTIFY (current)** | Included (PostgreSQL) | Included | Included | $0 (ops risk) |
| **Redis + Containers** | $10 (managed Redis) + $5 (container) | N/A | N/A | $15 |
| **RabbitMQ + Containers** | N/A | $15 (managed RabbitMQ) + $10 (container) | N/A | $25 |
| **AWS SQS + Containers** | N/A | N/A | $1 (SQS) + $5 (container) | $6 |
| **AWS Lambda (Go)** | $50 | $50 | $50 | $150 |
| **Hybrid (Redis + RabbitMQ + SQS)** | $15 | $25 | $6 | **$46/month** |

### At 100 req/sec (Scale Up)

| Architecture | Total Cost | Notes |
|--------------|-----------|-------|
| **LISTEN/NOTIFY** | $0 | **Database will stall** (global lock) |
| **Containers (Kubernetes)** | $150-300 | 3-6 pods, horizontal scaling |
| **AWS Lambda** | $500+ | **Becomes expensive**, consider containers |

---

## Final Recommendations

### Technology Stack

| Component | Technology | Reasoning |
|-----------|-----------|-----------|
| **S3 Signer Service** | **Go + Redis Pub/Sub** | Sub-50ms latency, 5MB container, trivial scaling |
| **Thumbnail Worker** | **Go (bimg) + RabbitMQ** | Proven libvips performance, reliable delivery, failure retry |
| **Notification Service** | **Go + AWS SQS** | Async-first, managed queue, dead-letter handling |
| **Container Base** | **Alpine Linux (Go)** | 5MB + app, shell access for debugging, apk package manager |
| **Orchestration** | **Docker Compose (dev)** <br> **Kubernetes (prod)** | Simple local dev, production-grade scaling |

### Migration Path (Lowest Risk)

#### Phase 1: Decouple S3 Signer (Low Risk)
1. Build Go S3 signer service (aws-sdk-go-v2)
2. Deploy as sidecar container (shared network with PostgREST)
3. Add Redis for pub/sub (or keep LISTEN/NOTIFY initially)
4. **Impact**: Offload CPU from PostgreSQL, faster presigned URLs
5. **Rollback**: Simple (just remove service, fallback to existing)

#### Phase 2: Replace Thumbnail Worker (Medium Risk)
1. Build Go thumbnail service (bimg + libvips)
2. Deploy RabbitMQ (managed CloudAMQP or self-hosted)
3. Dual-write to both LISTEN/NOTIFY and RabbitMQ (parallel testing)
4. Monitor performance for 1 week
5. Cut over to RabbitMQ, remove LISTEN/NOTIFY trigger
6. **Impact**: Reliable image processing, no database lock contention
7. **Rollback**: Re-enable LISTEN/NOTIFY trigger, drain RabbitMQ queue

#### Phase 3: Add Notification Service (New Feature)
1. Build Go notification service (AWS SDK for SES/SNS)
2. Use AWS SQS (managed, zero ops)
3. **Impact**: Email/SMS notifications for users
4. **Rollback**: N/A (new feature)

### Container Deployment (docker-compose.yml)

```yaml
version: '3.8'

services:
  # Existing services (postgres, postgrest, keycloak, frontend)
  
  # NEW: Redis (for S3 Signer pub/sub)
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
  
  # NEW: RabbitMQ (for Thumbnail Worker)
  rabbitmq:
    image: rabbitmq:3-management-alpine
    ports:
      - "5672:5672"   # AMQP
      - "15672:15672" # Management UI
    environment:
      RABBITMQ_DEFAULT_USER: civic_os
      RABBITMQ_DEFAULT_PASS: ${RABBITMQ_PASSWORD}
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
  
  # NEW: S3 Signer Service (Go)
  s3-signer:
    image: ghcr.io/civic-os/s3-signer:latest
    environment:
      AWS_REGION: us-east-1
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      S3_BUCKET: ${S3_BUCKET}
      REDIS_URL: redis://redis:6379
      DATABASE_URL: ${DATABASE_URL}
    depends_on:
      - redis
      - postgres
    restart: unless-stopped
  
  # NEW: Thumbnail Worker (Go + libvips)
  thumbnail-worker:
    image: ghcr.io/civic-os/thumbnail-worker:latest
    environment:
      AWS_REGION: us-east-1
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      S3_BUCKET: ${S3_BUCKET}
      RABBITMQ_URL: amqp://civic_os:${RABBITMQ_PASSWORD}@rabbitmq:5672/
      DATABASE_URL: ${DATABASE_URL}
    depends_on:
      - rabbitmq
      - postgres
    restart: unless-stopped
    deploy:
      replicas: 2  # Horizontal scaling
  
  # NEW: Notification Service (Go)
  notification-service:
    image: ghcr.io/civic-os/notification-service:latest
    environment:
      AWS_REGION: us-east-1
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      SQS_QUEUE_URL: ${SQS_QUEUE_URL}
      DATABASE_URL: ${DATABASE_URL}
    depends_on:
      - postgres
    restart: unless-stopped

volumes:
  redis-data:
  rabbitmq-data:
```

---

## gRPC vs REST vs Message Queue Comparison

### When to Use gRPC

**Strengths**:
- **Performance**: Binary protocol (protobuf), 10x smaller payloads than JSON
- **Streaming**: Bidirectional streaming (real-time updates)
- **Type Safety**: Code generation from .proto files
- **Interservice**: Best for internal microservice-to-microservice communication

**Weaknesses**:
- **Browser Support**: Limited (requires gRPC-web proxy)
- **Debugging**: Binary protocol harder to inspect (no curl)
- **Learning Curve**: Protobuf schema design, versioning

**Use Case**: **NOT NEEDED for Civic OS** (Angular frontend uses REST, services are event-driven)

### When to Use REST

**Strengths**:
- **Ubiquitous**: Browsers, curl, Postman, every language
- **Debugging**: Human-readable JSON, simple HTTP tools
- **Caching**: HTTP caching (CDN, browser)
- **Stateless**: Scales horizontally trivially

**Weaknesses**:
- **Verbose**: JSON larger than protobuf
- **Synchronous**: Tight coupling (caller waits for response)

**Use Case**: **Keep for Angular ↔ PostgREST API** (public-facing, human-readable)

### When to Use Message Queue

**Strengths**:
- **Async**: Fire-and-forget (producer doesn't wait)
- **Decoupling**: Services don't need to know about each other
- **Reliability**: At-least-once delivery, retries, dead-letter queues
- **Buffering**: Handles traffic spikes (queue absorbs bursts)

**Weaknesses**:
- **Eventual Consistency**: No immediate response
- **Complexity**: Additional infrastructure (RabbitMQ, SQS)

**Use Case**: **Perfect for background jobs** (thumbnails, emails, file processing)

---

## Service Mesh (Istio, Linkerd) Analysis

### What is a Service Mesh?

A **sidecar proxy** pattern (Envoy) injected into every pod that handles:
- **Traffic routing** (load balancing, retries, circuit breakers)
- **Observability** (metrics, tracing, logs)
- **Security** (mTLS, authentication, authorization)

### When to Use Service Mesh

**Good for**:
- 10+ microservices with complex routing
- Mutual TLS (zero-trust security)
- Advanced traffic management (canary deploys, A/B testing)
- Distributed tracing (Jaeger, Zipkin)

**Overkill for**:
- 3-5 microservices (use simple load balancers)
- Synchronous request/reply only (no event-driven)

### Limitations

- **HTTP/gRPC only**: Envoy only supports HTTP, gRPC, MongoDB, DynamoDB, Redis at L7
- **No AMQP/MQTT**: Service mesh doesn't help with RabbitMQ, NATS, Kafka
- **Async patterns**: Event-driven systems need **Event Mesh** (Solace, NATS Streaming)

### Recommendation for Civic OS

**Do NOT use service mesh** (3 services is too small, adds complexity). Instead:
- **Docker Compose** (dev): Simple, local networking
- **Kubernetes** (prod): Built-in service discovery, load balancing, health checks
- **RabbitMQ/SQS**: Handles async messaging (service mesh doesn't apply)

---

## References & Production Case Studies

### Go Microservices
- **Imaginary** (github.com/h2non/imaginary): 5.5k stars, production HTTP image service
- **Transloadit**: "Build a fast image processing server with Go and Libvips" (transloadit.com)
- **QBurst**: High-performance image resizer proxy replacing NGINX + image-filter

### libvips Performance
- Official benchmarks: github.com/libvips/vips-bench
- Sharp (Node.js): 150M+ downloads/year (2023), 250M+ predicted (2024)
- AWS/GCP recommendation: Sharp for Lambda/Cloud Functions image resizing

### PostgreSQL LISTEN/NOTIFY Issues
- **Recall.ai**: "Postgres LISTEN/NOTIFY does not scale" (recall.ai/blog)
  - Production outage: global lock caused database stall under 50+ concurrent writers
- **Hacker News discussion**: 200+ comments on scalability issues (news.ycombinator.com/item?id=44490510)

### Cost Analysis
- **2024 study**: "Comparing Cost and Performance of Microservices and Serverless in AWS: EC2 vs Lambda"
  - Serverless cheaper below 66 req/sec
  - EC2/containers cheaper above 66 req/sec
  - Real case: E-commerce (170k daily txns) saved $10,900/month migrating from containers to serverless

### AWS Lambda Cold Starts (2024)
- **Rust**: 30ms average
- **Go**: 45ms average
- **Python**: 325ms average
- **Java**: 100ms (SnapStart enabled), 2500ms (without)

---

## Appendix: Quick Start Code Examples

### Go S3 Signer (aws-sdk-go-v2)

```go
package main

import (
    "context"
    "time"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
)

func generatePresignedURL(bucket, key string) (string, error) {
    cfg, _ := config.LoadDefaultConfig(context.TODO())
    client := s3.NewFromConfig(cfg)
    presignClient := s3.NewPresignClient(client)
    
    request, err := presignClient.PresignPutObject(context.TODO(), &s3.PutObjectInput{
        Bucket: &bucket,
        Key:    &key,
    }, s3.WithPresignExpires(15*time.Minute))
    
    return request.URL, err
}
```

### Go Thumbnail Worker (bimg + libvips)

```go
package main

import (
    "github.com/h2non/bimg"
)

func generateThumbnail(inputPath string, width, height int) ([]byte, error) {
    buffer, _ := bimg.Read(inputPath)
    
    options := bimg.Options{
        Width:   width,
        Height:  height,
        Crop:    true,
        Quality: 85,
        Type:    bimg.JPEG,
    }
    
    return bimg.Resize(buffer, options)
}
```

### Go RabbitMQ Consumer

```go
package main

import (
    "github.com/streadway/amqp"
)

func main() {
    conn, _ := amqp.Dial("amqp://guest:guest@localhost:5672/")
    ch, _ := conn.Channel()
    
    msgs, _ := ch.Consume(
        "thumbnails", // queue
        "",           // consumer
        false,        // auto-ack (false = manual ack for reliability)
        false,        // exclusive
        false,        // no-local
        false,        // no-wait
        nil,          // args
    )
    
    for msg := range msgs {
        processThumbnail(msg.Body)
        msg.Ack(false) // Acknowledge after success
    }
}
```

---

## Glossary

- **Cold Start**: Time to initialize serverless function from zero (first request or after idle)
- **Warm Start**: Subsequent requests to already-initialized function (cached runtime)
- **libvips**: Fast image processing library (streaming architecture, low memory)
- **Goroutine**: Lightweight thread in Go (OS thread can run 1000s of goroutines)
- **Tokio**: Async runtime for Rust (work-stealing scheduler, similar to Go)
- **GraalVM Native Image**: Ahead-of-time compiled Java (fast startup, lower memory)
- **Service Mesh**: Infrastructure layer for microservices (sidecar proxies, traffic management)
- **Event Mesh**: Message routing for event-driven systems (async, pub/sub)
- **At-least-once delivery**: Message delivered 1+ times (duplicates possible, acks required)
- **At-most-once delivery**: Message delivered 0-1 times (no duplicates, no reliability)

---

**End of Research Document**
