# Third-Party System Synchronization with Civic OS

**Solution Space Research** — 16 approaches across 6 categories

> **Scope**: Synchronizing a third-party non-Civic-OS system (CRM, case management, government DB, SaaS tool) with a Civic OS instance. Distinct from federation (instance-to-instance sync in `docs/notes/FEDERATION_DESIGN.md`), though infrastructure overlaps should be harmonized.

> **Rendered version**: See `THIRD_PARTY_SYNC_DESIGN.html` for a styled, interactive version of this document.

---

## Existing Infrastructure (Already Built)

| Component | Version | Capabilities |
|-----------|---------|--------------|
| **River Job Queue** | v0.10.0+ | At-least-once delivery, exponential backoff, dead-letter queue, row-level locking |
| **Scheduled Jobs** | v0.22.0+ | Cron-based SQL function execution via `metadata.scheduled_jobs`, full audit trail |
| **Go HTTP Clients** | v0.11.0+ | Keycloak (OAuth2, 30s timeout), Telnyx SMS (API key, 10s timeout), error classification |
| **Webhook Inbound** | v0.13.0+ | Stripe handler: signature verify, idempotency via UNIQUE constraint, atomic processing |
| **Causal Bindings** | v0.33.0+ | Status transitions + property change triggers for event-to-function binding |
| **PostgREST API** | All | Full CRUD REST, JWT auth, RLS enforcement, OpenAPI spec (no native webhooks) |

---

## A. Pull-Based (Civic OS Polls the 3rd Party)

### A1. Scheduled SQL Function Polling

```
 ┌──────────┐      ┌─────────────────────────────────────┐
 │ 3rd Party│◄─────│ Go Worker (scheduled_job_execute)    │
 │ API      │─────►│ → calls PL/pgSQL function            │
 └──────────┘      │   → uses pg_net/http extension       │
                   └─────────────────────────────────────┘
```

- **Direction**: Pull | **Trigger**: Cron | **Complexity**: Medium | **Resilience**: Low
- **New infra**: `pg_net` or `pgsql-http` PostgreSQL extension
- **+** Zero new services; SQL-native; existing audit trail
- **−** Blocking SQL execution; OAuth2 awkward in PL/pgSQL; no streaming
- **Best for**: Small reference data (ZIP codes, program IDs) from simple APIs

---

### A2. River-Based Polling Worker (Go HTTP Fetch) ★ RECOMMENDED

```
 ┌──────────┐      ┌────────────────────────────────────────┐
 │ 3rd Party│◄─────│ Go Worker (new kind: external_api_fetch)│
 │ API      │─────►│ → reads metadata.external_sync_config   │
 └──────────┘      │ → upserts into local tables             │
                   │ → logs to metadata.external_sync_log    │
                   └────────────────────────────────────────┘
```

- **Direction**: Pull | **Trigger**: Cron/Manual/Event | **Complexity**: Medium | **Resilience**: High
- **New infra**: `external_api_worker.go` in consolidated-worker + 2 metadata tables
- **+** Proven pattern (same as Keycloak/Telnyx clients); proper error classification; River retry/backoff; pagination; existing container
- **−** Requires Go code per API (not fully metadata-driven); min 1-min latency
- **Best for**: *The workhorse* — any 3rd party REST API without webhooks

---

### A3. SQL Trigger + River HTTP Fetch (Event-Driven Enrichment)

```
 ┌──────────┐      ┌─────────────────────────────────────────┐
 │ 3rd Party│◄─────│ Go Worker (ext_api_enrich)               │
 │ API      │─────►│ ← triggered by INSERT/UPDATE trigger     │
 └──────────┘      │    inserting River job in same txn       │
                   └─────────────────────────────────────────┘
```

- **Direction**: Pull (event-triggered) | **Trigger**: DB event | **Complexity**: Medium | **Resilience**: High
- **New infra**: DB trigger + River job kind; same Go HTTP client as A2
- **+** Immediate enrichment; atomic trigger; integrates with causal bindings
- **−** Depends on external API availability; user sees partial data until enrichment completes
- **Best for**: Address geocoding, license verification, credit checks on submission

---

## B. Push-Based (3rd Party Pushes to Civic OS)

### B4. Generic Webhook Receiver ★ RECOMMENDED

```
 ┌──────────┐  HTTP POST  ┌──────────────────────────────────┐
 │ 3rd Party│────────────►│ Webhook HTTP Server (Go, :8080)   │
 │ (webhooks)│             │ → signature verify                │
 └──────────┘             │ → idempotency (metadata.webhooks) │
                          │ → River job (process_webhook)     │
                          └──────────────────────────────────┘
```

- **Direction**: Push | **Trigger**: 3rd party event | **Complexity**: Medium | **Resilience**: High
- **New infra**: Generic routes in webhook server; `metadata.webhook_endpoints` table; HMAC/API-key/Basic verification
- **+** Proven pattern (mirrors Stripe handler exactly); real-time; full audit trail
- **−** 3rd party must support webhooks; Civic OS must be internet-reachable; no backfill
- **Best for**: SaaS integrations (Salesforce, HubSpot, Jira, Square)

---

### B5. PostgREST Direct Write (Service Account JWT)

```
 ┌──────────┐  HTTP REST  ┌──────────────────────────────────┐
 │ 3rd Party│────────────►│ PostgREST (existing API)          │
 │ (custom  │             │ → JWT via Keycloak client_creds   │
 │  client) │             │ → RLS scopes access               │
 └──────────┘             └──────────────────────────────────┘
```

- **Direction**: Push | **Trigger**: 3rd party controls | **Complexity**: Low | **Resilience**: Medium
- **New infra**: Keycloak service account + RLS policies (zero code changes)
- **+** Zero new infrastructure; full CRUD; RLS protection; self-documenting (OpenAPI)
- **−** Schema coupling; no transformation unless VIEWs used; auth complexity for legacy systems
- **Best for**: Partner orgs with dev capacity; government interoperability

---

### B6. Database Direct Write (PostgreSQL Service Role)

```
 ┌──────────┐  PG protocol  ┌───────────────────────────────┐
 │ 3rd Party│───────────────►│ PostgreSQL (restricted role)   │
 └──────────┘                └───────────────────────────────┘
```

- **Direction**: Push | **Trigger**: 3rd party controls | **Complexity**: Low | **Resilience**: Low-Med
- **New infra**: DB role + GRANTs + optional `integration` schema
- **+** Maximum performance; transactional; COPY for bulk; no HTTP overhead
- **−** Security risk; PG port exposure; tightest coupling; migration risk
- **Best for**: ETL tools (SSIS, Talend, dbt, Fivetran, Airbyte); internal tools on same network

---

## C. Sidecar / Middleware

### C7. Dedicated Sync Sidecar Service

```
 ┌──────────┐     ┌──────────────────┐     ┌────────────────┐
 │ 3rd Party│◄───►│ Sync Sidecar     │◄───►│ Civic OS       │
 │ API      │     │ (Go service)     │     │ PostgREST / PG │
 └──────────┘     └──────────────────┘     └────────────────┘
```

- **Direction**: Any | **Trigger**: Any | **Complexity**: High | **Resilience**: High
- **New infra**: Standalone `services/sync-sidecar/` Go service
- **+** Clean separation; maximum flexibility; independent scaling/deployment; testable
- **−** New service to deploy/monitor; state management; some pattern duplication
- **Best for**: Complex integrations (SOAP/XML, proprietary formats, bidirectional)

---

### C8. External Workflow Engine (n8n / Temporal / Windmill)

```
 ┌──────────┐     ┌──────────────────┐     ┌────────────────┐
 │ 3rd Party│◄───►│ n8n / Temporal    │◄───►│ Civic OS       │
 │ API      │     │ (400+ connectors)│     │ PostgREST API  │
 └──────────┘     └──────────────────┘     └────────────────┘
```

- **Direction**: Any | **Trigger**: Any | **Complexity**: High | **Resilience**: High
- **New infra**: Workflow engine container(s) + workflow definitions
- **+** Visual design; pre-built connectors; non-developers can modify flows; built-in retry
- **−** Additional dependency; licensing; debugging across boundaries; data residency
- **Best for**: Orgs already using a workflow engine; multi-system flows; rapid prototyping

---

### C9. API Gateway with Transformation (Kong / Caddy Plugin)

```
 ┌──────────┐     ┌──────────────────┐     ┌────────────────┐
 │ 3rd Party│────►│ API Gateway      │────►│ PostgREST API  │
 └──────────┘     │ (auth + reshape) │     └────────────────┘
                  └──────────────────┘
```

- **Direction**: Push | **Trigger**: 3rd party event | **Complexity**: Low-Med | **Resilience**: Medium
- **New infra**: Gateway configuration (Caddy already in VPS deployments)
- **+** No code changes; hot-reload; rate limiting built-in
- **−** Limited transformation; no state; single-request scope
- **Best for**: Simple payload reshaping; auth translation; rate limiting

---

## D. Database-Level

### D10. PostgreSQL Foreign Data Wrappers (FDW)

```
 ┌──────────────────┐  PG protocol  ┌──────────────────────────────┐
 │ 3rd Party DB     │◄─────────────►│ FOREIGN TABLE + MAT. VIEW    │
 └──────────────────┘               └──────────────────────────────┘
```

- **Direction**: Pull | **Trigger**: On-demand / scheduled REFRESH | **Complexity**: Low-Med | **Resilience**: Low
- **+** Transparent SQL access; JOIN-able with local tables; PostgreSQL-native
- **−** Performance (network latency); PG-to-PG only; availability coupling
- **Best for**: Cross-database queries on same network; rarely-changing reference data

---

### D11. Logical Replication (PG-to-PG)

```
 ┌──────────────────┐  WAL stream  ┌────────────────────────────┐
 │ 3rd Party PG     │─────────────►│ Civic OS (SUBSCRIBER)      │
 │ (PUBLISHER)      │              └────────────────────────────┘
 └──────────────────┘
```

- **Direction**: Push (WAL) | **Trigger**: Automatic | **Complexity**: Medium | **Resilience**: High
- **+** Near-real-time; low overhead; row/column filtering (PG 15+)
- **−** PG-only both sides; requires replication role; no transformation; WAL bloat risk
- **Best for**: Near-real-time mirroring between PostgreSQL databases

---

### D12. ETL / Batch Import (CSV/Excel/File-Based)

```
 ┌──────────┐  export  ┌──────┐  upload  ┌────────────────┐
 │ 3rd Party│─────────►│ File │─────────►│ Civic OS       │
 └──────────┘          └──────┘          │ (Import UI)    │
                                         └────────────────┘
```

- **Direction**: Pull/Push (file) | **Trigger**: Manual / file watcher | **Complexity**: Low | **Resilience**: Low-Med
- **+** Partially exists (Excel Import); low technical barrier; works without API
- **−** Manual unless automated; batch-only; data quality issues
- **Best for**: Legacy systems without APIs; one-time migrations; small orgs

---

## E. Event Streaming

### E13. Change Data Capture — Debezium

```
 ┌────────────────┐  WAL  ┌──────────────────┐  consume  ┌──────────┐
 │ Civic OS PG    │──────►│ Kafka (Debezium)  │──────────►│ 3rd Party│
 └────────────────┘       └──────────────────┘           └──────────┘
```

- **Direction**: Outbound | **Trigger**: Automatic (WAL) | **Complexity**: Very High | **Resilience**: Very High
- **+** Complete change capture; decoupled; replayable; fan-out
- **−** **Massive overkill** for municipal deployments; Kafka operational complexity
- **Best for**: Enterprise with existing Kafka; data lake feeding

---

### E14. Message Broker (NATS / RabbitMQ)

```
 ┌────────────────┐  pub  ┌──────────────────┐  sub  ┌──────────┐
 │ Civic OS       │──────►│ NATS JetStream   │◄──────│ 3rd Party│
 │ (Go worker)    │◄──────│                  │──────►│          │
 └────────────────┘  sub  └──────────────────┘  pub  └──────────┘
```

- **Direction**: Bidirectional | **Trigger**: Event-driven | **Complexity**: High | **Resilience**: High
- **+** Decoupled; NATS is lightweight; fan-out; guaranteed delivery
- **−** New infrastructure; message schema management; requires 3rd party participation
- **Best for**: Multiple internal systems exchanging events; microservice architectures

---

## F. Hybrid Patterns

### F15. Bidirectional Sync with Conflict Resolution

```
 ┌────────────────┐◄──── push/pull ────►┌──────────────────┐
 │ Civic OS       │                      │ 3rd Party        │
 │ sync_state tbl │◄── conflict res. ──►│                  │
 └────────────────┘                      └──────────────────┘
```

- **Direction**: Bidirectional | **Trigger**: Hybrid | **Complexity**: Very High | **Resilience**: Med-High
- **Conflict strategies**: Last-write-wins · Source-of-truth per field · Field-level merge · Manual review queue
- **+** True bidirectional; configurable conflict resolution; audit trail
- **−** Most complex; clock skew; infinite loop prevention; partial failure
- **Best for**: Appointments, case records, or clients maintained in both systems

---

### F16. Event Sourcing Bridge

```
 ┌────────────────┐  append  ┌──────────────────┐  consume  ┌──────────┐
 │ Civic OS       │─────────►│ sync_events log  │◄──────────│ 3rd Party│
 │ (DB trigger)   │◄─────────│ (append-only)    │──────────►│ (agent)  │
 └────────────────┘  consume └──────────────────┘  append   └──────────┘
```

- **Direction**: Bidirectional | **Trigger**: Event-driven | **Complexity**: High | **Resilience**: Very High
- **+** Complete audit trail; replayable; decoupled; conflict detection via sequence
- **−** Storage growth; eventual consistency; event schema versioning
- **Best for**: High-auditability (healthcare, gov); event sourcing/CQRS systems

---

## Recommendation Matrix

| # | Approach | Reference Import | Real-Time Events | Periodic Bulk | Bidirectional | Reporting Feed |
|---|---------|-----------------|-----------------|--------------|--------------|---------------|
| A1 | SQL function polling | Good | Poor | Possible | Poor | Poor |
| **A2** | **River polling worker** | **★ Best** | Possible | **★ Best** | Good (half) | Good |
| A3 | Trigger + River fetch | Possible | Good | Poor | Possible | Poor |
| **B4** | **Webhook receiver** | Poor | **★ Best** | Poor | Good (half) | Poor |
| B5 | PostgREST direct write | Good | Good | Good | Good | Good |
| B6 | Database direct write | Possible | Possible | Good | Possible | Poor |
| **C7** | **Sync sidecar** | Good | Good | Good | **★ Best** | Good |
| C8 | Workflow engine | Good | Good | Good | Good | Good |
| C9 | API gateway | Poor | Possible | Poor | Poor | Poor |
| D10 | FDW | Good | Poor | Possible | Poor | Poor |
| D11 | Logical replication | Poor | ★ Best (PG) | Poor | Possible | Poor |
| D12 | ETL / batch import | Possible | Poor | Good | Poor | Poor |
| E13 | CDC (Debezium) | Poor | Good | Poor | Possible | Good |
| E14 | Message broker | Poor | Good | Poor | Good | Possible |
| **F15** | **Bidirectional sync** | Poor | Good | Possible | **★ Best** | Poor |
| F16 | Event sourcing bridge | Poor | Good | Poor | Good | Possible |

### Per-Scenario Recommendations

1. **Read-Only Reference Import** → A2 (River polling); alt: D10 (FDW) if PG-to-PG
2. **Real-Time Event Sync** → B4 (Webhook); alt: D11 (Logical rep.); fallback: A2 (1-5 min poll)
3. **Periodic Bulk Sync** → A2 (River polling, nightly cron); alt: D12 (ETL) if no API
4. **Bidirectional Sync** → F15 (A2 outbound + B4 inbound + conflict res.); alt: C7 (Sidecar)
5. **One-Way Reporting Feed** → A2 (River polling, push); alt: B5 (let them pull from PostgREST)

---

## Build Priority (Phased Approach)

### Phase 1: River-Based External API Worker (A2)
**Covers 3/5 scenarios**: Reference import, periodic bulk sync, outbound reporting

- `services/consolidated-worker-go/external_api_worker.go`
- `metadata.external_sync_config` — endpoint, auth, entity mapping, schedule, cursor state
- `metadata.external_sync_log` — attempt history, status, records processed
- Reusable `ExternalAPIClient` — OAuth2, API key, Basic, HMAC auth modes

### Phase 2: Generic Webhook Receiver (B4)
**Covers 4/5 scenarios**: + Real-time event sync

- Extend webhook HTTP server with generic routes (`/webhooks/:provider`)
- `metadata.webhook_endpoints` — provider, signature method, target entity, column mapping
- New River job kind: `process_external_webhook`

### Phase 3: Bidirectional Sync Framework (F15)
**Covers 5/5 scenarios**: + Bidirectional sync

- `metadata.sync_state` — per-record version tracking, sync direction, conflict state
- Conflict resolution engine — configurable strategies per entity/field
- Anti-echo protection — detect and suppress sync-triggered changes

### What NOT to Build (Unless Customer Requires)
- **Kafka/Debezium (E13/E14)** — Enterprise overkill for municipal deployments
- **Workflow engine (C8)** — External dependency risk; Go worker more maintainable
- **Event sourcing bridge (F16)** — Marginal benefit over F15 for typical use cases

---

## Relationship to Federation Design

| Federation Component | Third-Party Sync Equivalent |
|---|---|
| `metadata.federation_peers` | `metadata.external_sync_config` (same concept) |
| `metadata.federation_mappings` | Column mapping in sync config |
| `metadata.federation_sync_log` | `metadata.external_sync_log` (identical) |
| `federation_sync_outbound` River job | `external_api_push` River job |
| ETag concurrency | Depends on 3rd party API capabilities |
| Keycloak client_credentials auth | Reusable; need additional auth modes |

**Design Recommendation**: Design metadata tables to accommodate **both** federation and 3rd-party sync. Use a `sync_type` discriminator (`federation` vs `external`) or separate tables with a shared sync log. The Go worker shares the HTTP client abstraction and error classification logic.

---

## Key Files for Implementation

| File | Pattern |
|------|---------|
| `services/consolidated-worker-go/main.go` | Worker registration (`river.AddWorker()`) |
| `services/consolidated-worker-go/keycloak_client.go` | OAuth2 HTTP client with token caching |
| `services/payment-worker/webhook_handler.go` | Inbound webhook: idempotency, sig verify, atomic txn |
| `services/consolidated-worker-go/scheduled_jobs_worker.go` | Cron scheduling, unique_key dedup, audit logging |
| `docs/notes/FEDERATION_DESIGN.md` | Overlapping design to harmonize |

---

## FOSS Integration Tool Marketplace

The original 16 approaches above describe *architectural patterns*. This section surveys the **existing open-source tools** that implement these patterns with configurable field mapping, flexible auth, and multi-protocol support.

### The Field Mapping Problem

The critical gap in naive sync approaches: we cannot assume remote systems share Civic OS's data shape. Transforming `{first_name: "Dan", last_name: "K", status: 1}` into `{full_name: "Dan K", source: "external", active: true}` with **configurable, non-developer-editable rules** is the hard part. Most tools either:
- Punt entirely (ELT philosophy: load raw, transform later with dbt)
- Require you to write code in a general-purpose language
- Provide a purpose-built mapping DSL (the best approach for configurability)

### Tool Categories

| Category | What It Solves | Example |
|----------|---------------|---------|
| **Full iPaaS** | Visual workflow + connectors + transforms | n8n, Activepieces, Kestra |
| **ELT/ETL Platform** | Batch/streaming data movement | Airbyte, Meltano, dlt |
| **Stream Processor** | Real-time event transformation and routing | Redpanda Connect, Conduit |
| **Workflow Orchestrator** | Task scheduling and dependency management | Temporal, Windmill, Hatchet |
| **Webhook Infrastructure** | Reliable sending/receiving of webhooks | Svix, Hookdeck Outpost |
| **Integration Framework** | Code-first library for building integrations | Apache Camel, Node-RED |

---

### Tier 1: Best Fit for Civic OS

#### Redpanda Connect (formerly Benthos) ★ TOP PICK

| | |
|---|---|
| **License** | MIT (core) + Apache 2.0 (90%+ connectors) |
| **What** | Declarative stream processing: inputs → processors → outputs. Single binary. |
| **Field Mapping** | **Bloblang** — purpose-built mapping DSL with dot-path access, method chaining, conditionals, type coercion |
| **Protocols** | HTTP server (push), polling (pull), Kafka/NATS/AMQP (pub-sub), PostgreSQL CDC |
| **Auth** | Per-input/output: OAuth2, API keys, mTLS, basic auth |
| **Deploy** | Single static Go binary; Docker |
| **Community** | ~8k GitHub stars, Redpanda corporate backing |

**Why it's the best fit**: Same language as the existing worker (Go), single binary sidecar, Bloblang solves the field mapping problem elegantly, native PostgreSQL CDC input means it can react to Civic OS data changes without triggers.

```yaml
# Example: Transform Civic OS referral into external case management format
input:
  sql_select:
    driver: postgres
    dsn: "${DATABASE_URL}"
    table: referrals
    columns: ["id", "client_id", "service_type", "status_id", "created_at"]

pipeline:
  processors:
    - mapping: |
        root.case_id = "COS-" + this.id.string()
        root.participant = this.client_id.string()
        root.service = match this.service_type {
          "housing" => "HOUSING_ASSIST",
          "food" => "FOOD_SECURITY",
          _ => this.service_type.uppercase()
        }
        root.opened_date = this.created_at.format("2006-01-02")
        root.source_system = "civic-os"

output:
  http_client:
    url: "https://external-system.gov/api/cases"
    verb: POST
    headers:
      Authorization: "Bearer ${EXTERNAL_API_TOKEN}"
      Content-Type: application/json
```

---

#### Conduit (by Meroxa)

| | |
|---|---|
| **License** | Apache 2.0 |
| **What** | Real-time data integration; Kafka Connect replacement without JVM |
| **Field Mapping** | Built-in processors + JavaScript processor + custom Go processor SDK |
| **Protocols** | PostgreSQL CDC, HTTP, S3, Kafka, file |
| **Auth** | Per-connector configuration |
| **Deploy** | Single Go binary; Docker |
| **Community** | ~1.5k GitHub stars, Meroxa backing |

**Why it fits**: Apache 2.0, Go binary, native PostgreSQL CDC, designed specifically for "stream data between data stores." Less mature mapping than Bloblang but architecturally aligned with Civic OS.

---

#### NATS JetStream (as transport layer)

| | |
|---|---|
| **License** | Apache 2.0 |
| **What** | High-performance messaging with persistent streaming |
| **Field Mapping** | None (pure transport — pair with Redpanda Connect or custom Go for transforms) |
| **Protocols** | Pub-sub, request-reply, queue groups, pull consumers |
| **Auth** | NKeys, JWT-based, TLS |
| **Deploy** | Single Go binary (~15MB); Docker |
| **Community** | ~16k GitHub stars, CNCF project |

**Why it fits**: If the integration needs an event bus between Civic OS and external systems, NATS is the lightest-weight option. Pairs with Redpanda Connect for the transform layer.

---

### Tier 2: Strong Candidates

#### Activepieces (MIT Zapier alternative)

| | |
|---|---|
| **License** | MIT |
| **What** | No-code/low-code workflow automation, 330+ integrations |
| **Field Mapping** | Visual mapping UI + TypeScript code steps |
| **Deploy** | Docker Compose |
| **Community** | ~12k GitHub stars, YC S22 |

**Best for**: When non-developers need to configure syncs visually. True MIT license (unlike n8n's fair-code).

#### Windmill (multi-language workflow)

| | |
|---|---|
| **License** | AGPLv3 |
| **What** | Turn scripts into workflows/webhooks/UIs; Python, TS, Go, Bash, SQL |
| **Field Mapping** | Full scripting in any language between steps |
| **Deploy** | Docker Compose; Rust+Svelte |
| **Community** | ~13.4k GitHub stars |

**Best for**: Complex multi-step sync workflows where you need retry guarantees AND flexibility.

#### Svix (outbound webhook delivery)

| | |
|---|---|
| **License** | MIT |
| **What** | Reliable webhook sending with retries, backoff, FIFO ordering |
| **Field Mapping** | Payload transforms before delivery |
| **Deploy** | Single Rust binary; PostgreSQL backend |
| **Community** | ~3k GitHub stars |

**Best for**: When Civic OS needs to reliably PUSH events to external systems. Narrowly focused, does one thing perfectly.

#### Kestra (event-driven orchestration)

| | |
|---|---|
| **License** | Apache 2.0 |
| **What** | Declarative YAML workflows; language-agnostic; event triggers |
| **Field Mapping** | Script tasks in any language + Pebble templating |
| **Deploy** | Docker; single JAR (Java) |
| **Community** | ~15k GitHub stars, v1.0 LTS in 2025 |

**Best for**: When you need both orchestration AND integration in one tool.

---

### Tier 3: Viable but Heavier / Narrower

| Tool | License | Category | Field Mapping | Civic OS Fit | Why Not Tier 1 |
|------|---------|----------|---------------|-------------|----------------|
| **n8n** | Sustainable Use (NOT OSS) | iPaaS | Visual + JS | High | License prohibits offering as service |
| **Apache Camel** | Apache 2.0 | Integration Framework | AtlasMap (visual) | Medium | JVM-based; heavy for point-to-point sync |
| **Temporal** | MIT | Durable Execution | Code-only | Medium | No built-in connectors or mapping |
| **Hatchet** | MIT | Task Queue | Code-only | Medium | PostgreSQL-native but no mapping layer |
| **Node-RED** | Apache 2.0 | Flow-based | JS functions | Medium | Node.js dependency; IoT-oriented |
| **dlt** | Apache 2.0 | Python ELT | Python functions | Medium | Adds Python dependency to Go stack |
| **Nango** | ELv2 (NOT OSS) | API Auth Mgmt | TypeScript | Medium | Excellent OAuth mgmt but restrictive license |
| **Trigger.dev** | Apache 2.0 | Background Jobs | TypeScript | Medium | Adds Node.js; no declarative mapping |

---

### What NOT to Use (Overkill / Wrong Domain)

| Tool | Why Not |
|------|---------|
| **Airbyte** | ELv2 license; heavy deployment (6+ containers); no real-time; mapping is "load then dbt" |
| **Apache Flink** | Cluster infrastructure for millions of events/sec; absurd for app-sync |
| **Apache Airflow** | Batch DAG orchestration, not real-time sync; heavy Python infra |
| **Dagster/Prefect** | Data asset orchestration for analytics, not app-to-app sync |
| **Kafka/Debezium** | Massive operational overhead; overkill for municipal deployments |
| **Vector** | Excellent VRL language but designed for observability (logs/metrics), not app data |
| **Estuary Flow** | BSL license; cloud-first; not truly self-hostable |
| **RudderStack** | AGPL but focused on customer data/marketing CDP, not general sync |

---

### Field Mapping Approach Comparison

| Tool | Mapping Language | Declarative? | Visual Editor? | Non-Dev Editable? |
|------|-----------------|-------------|---------------|-------------------|
| **Redpanda Connect** | Bloblang | Yes | No (YAML config) | With training |
| **Apache Camel** | AtlasMap | Yes | Yes (drag-drop) | Yes |
| **Activepieces** | Visual + TypeScript | Partial | Yes | Yes |
| **n8n** | Visual + JavaScript | Partial | Yes | Yes |
| **Conduit** | JavaScript processors | Partial | No | Needs dev |
| **OpenConnector** | Twig templates | Yes | No | With training |
| **Windmill** | Any language | No | Partial | Needs dev |
| **Node-RED** | JavaScript functions | No | Yes (flow view) | With training |

---

### Recommended Architecture: Redpanda Connect Sidecar

Based on this survey, the highest-value integration pattern for Civic OS is:

```
 ┌──────────────┐                     ┌──────────────────────┐
 │ Civic OS     │  PostgreSQL CDC     │  Redpanda Connect    │
 │ PostgreSQL   │────────────────────►│  (single Go binary)  │
 │              │                     │                      │
 │              │◄────────────────────│  Bloblang transforms │
 │              │  HTTP/SQL write     │  per-integration     │
 └──────────────┘                     │  YAML configs        │
                                      │                      │
 ┌──────────────┐  HTTP (any auth)   │  Input: pg_cdc,      │
 │ 3rd Party    │◄───────────────────│    http_server,      │
 │ System       │────────────────────►│    cron              │
 └──────────────┘  Webhooks / API    │  Output: http_client,│
                                      │    sql_insert,       │
                                      │    nats, kafka       │
                                      └──────────────────────┘
```

**Why this wins**:
- **Field mapping is first-class** via Bloblang DSL (not an afterthought)
- **No schema lock** — transforms decouple Civic OS schema from external expectations
- **Auth flexibility** — HTTP client supports OAuth2, API key, Basic, mTLS, custom headers
- **Bidirectional** — can both push (CDC → transform → HTTP POST) and pull (HTTP GET → transform → SQL INSERT)
- **Single binary sidecar** — same deployment model as the consolidated Go worker
- **MIT license** — no restrictions
- **No PostgREST dependency** — reads/writes PostgreSQL directly when needed, or uses PostgREST when convenient
- **Configuration-driven** — new integrations are YAML files, not code changes

### Alternative: Conduit for Simpler Cases

If the field mapping needs are simple (rename fields, filter columns, basic type coercion), Conduit is lighter-weight and Apache 2.0. It lacks Bloblang's expressiveness but its JavaScript processor handles moderate transforms. Better for "just pipe this table to that API with some column renames."

### Complement: Svix for Outbound Webhooks

If Civic OS needs to reliably *send* events to systems that accept webhooks (rather than pulling or transforming), Svix handles delivery guarantees (retry, backoff, FIFO, signature rotation) without building that infrastructure. Pairs well with Redpanda Connect for the transform step.

---

### Redpanda Connect: Enterprise vs. Community

Redpanda Connect ships as a single binary supporting both editions. ~90% of connectors are free (Apache 2.0 / MIT).

#### Enterprise-Only (Paid License Required)

| Feature | Why It Exists |
|---------|--------------|
| **CDC inputs** (`postgres_cdc`, `mysql_cdc`, `mongodb_cdc`, `mssql_cdc`, `oracle_cdc`, `dynamodb_cdc`) | Real-time WAL-based change capture |
| **Snowflake Streaming** output | Data warehouse streaming |
| **Iceberg** output | Data lake format |
| **Salesforce** components | CRM integration |
| **Allow/deny lists** | Multi-tenant governance — restrict which components pipelines can use |
| **Configuration service** | Send pipeline logs/status to a Redpanda cluster topic |
| **Secrets management** | Pull secrets from Vault/AWS Secrets Manager (instead of env vars) |
| **FIPS compliance** | FIPS-validated cryptography |

#### Free / Community (What Civic OS Needs)

| Component | Use Case | License |
|-----------|----------|---------|
| `sql_select` / `sql_raw` input | Poll PostgreSQL with arbitrary queries | Apache 2.0 |
| `sql_insert` / `sql_raw` output | Write to PostgreSQL | Apache 2.0 |
| `http_client` input/output | REST API polling and pushing (OAuth2, API keys, mTLS) | Apache 2.0 |
| `http_server` input | Receive webhooks | Apache 2.0 |
| **Bloblang** DSL | All field mapping and transformation | MIT |
| NATS / Kafka / AMQP I/O | Messaging transport | Apache 2.0 |
| Cron scheduling, rate limiting, batching, retry | Pipeline orchestration | Apache 2.0 |

#### Assessment: Enterprise Not Needed

The only tempting enterprise feature is `postgres_cdc` for real-time WAL-based change capture. But for Civic OS's municipal workloads (hundreds of changes/hour, not millions), these free alternatives eliminate the need:

1. **`sql_select` + cron** — Poll every 1–5 minutes with `WHERE updated_at > :last_cursor`. The latency difference vs. CDC is irrelevant at municipal scale.
2. **River trigger → HTTP push** — Civic OS's causal bindings (`metadata.status_transitions`, `metadata.property_change_triggers`) already fire on data changes. A River job can POST to Redpanda Connect's `http_server` input for near-real-time without CDC.
3. **Secrets management** — Env vars + Docker secrets are sufficient for single-VPS deployments. Vault integration adds governance overhead without value at our scale.

The paid features target organizations running multi-tenant streaming infrastructure (Kafka replacement, data lakes, Snowflake pipelines). Civic OS's use case — point-to-point sync between a PostgreSQL app and a handful of external APIs — is squarely in the free tier.
