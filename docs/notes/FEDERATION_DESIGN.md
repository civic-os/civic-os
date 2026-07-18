# Federation Design Document

> **Status:** Proposed — forward-looking design exploration, not yet scheduled.
> **Created:** 2026-07-10
> **Author:** Design Discussion with Claude

**Related Documentation:**
- `docs/notes/ETAG_CONCURRENCY_DESIGN.md` — Optimistic concurrency control (dependency)
- `docs/development/GO_MICROSERVICES_GUIDE.md` — Consolidated worker architecture (delivery mechanism)
- `docs/AUTHENTICATION.md` — Keycloak service account pattern (auth model)
- `docs/INTEGRATOR_GUIDE.md` — Metadata table conventions (configuration pattern)

---

## Overview

Federation enables independent Civic OS instances to share a defined subset of their data with a coordinating hub or peer instances. This document explores how federation *could* work within Civic OS's existing architecture — metadata-driven configuration, PostgREST APIs, ETag concurrency, and the River-based Go worker.

Federation is not replication. A federated instance retains full authority over its own data. The federation layer translates, filters, and transmits a *projection* of local data to external consumers according to a declared standard.

**Guiding principle:** The first real customer requirement will define the initial implementation. This document maps the design space and identifies architectural decisions that each use case would force.

---

## Motivating Use Cases

Two representative scenarios illustrate the range of federation requirements. Neither is assumed as the first implementation target — both are included to stress-test the design.

### Use Case A: Standardized Statistical Reporting

A network of municipal agencies each track incidents locally (code enforcement complaints, infrastructure reports, public safety events). A regional or federal body collects standardized statistical summaries — analogous to how local law enforcement agencies submit Uniform Crime Reporting data to the FBI, or how municipal 311 systems submit service request data to regional dashboards.

**Characteristics:**
- Outbound only (instance → hub)
- Aggregated or anonymized — individual PII rarely leaves the instance
- Schema mapping required (local entity shape → federal reporting standard)
- Batch cadence acceptable (daily or weekly submissions)
- Low conflict risk — hub is append-mostly, instances don't read back from hub
- Compliance-driven: the standard is externally defined and versioned

### Use Case B: Coordinated Human Services (HMIS-like)

Multiple service organizations (shelters, outreach teams, hospitals, case management agencies) each run their own Civic OS instance for day-to-day operations. A Continuum of Care (CoC) or lead agency runs a hub that provides unified client identity, coordinated entry, and aggregate reporting to HUD.

**Characteristics:**
- Bidirectional (instance ↔ hub for client identity; instance → hub for service records)
- Record-level data with PII — consent-based sharing governs what leaves each instance
- Client deduplication at the hub (master person index)
- Real-time or near-real-time for referrals and warm handoffs
- Higher conflict risk — multiple orgs may update the same client's demographics
- Privacy regulations (HIPAA, 42 CFR Part 2, state laws) constrain what can be shared and with whom

### Key Differences

| Dimension | Statistical Reporting | Coordinated Services |
|---|---|---|
| Direction | Outbound only | Bidirectional |
| Granularity | Aggregated / anonymized | Individual records with PII |
| Cadence | Batch (daily/weekly) | Near-real-time for referrals |
| Conflict risk | Low (append-only hub) | Medium (shared client records) |
| Privacy | Standard open-data rules | Consent-based, regulated |
| Schema mapping | Local → federal standard | Local → shared standard + identity matching |
| Trigger | Scheduled or manual "Submit" | Event-driven (status change, referral created) |

---

## Network Topology

### Hub-and-Spoke (Recommended Starting Point)

```
  Instance A ──┐
  Instance B ──┼──► Central Hub
  Instance C ──┘
```

Each instance owns its local data and pushes a declared subset to a central hub. The hub aggregates, deduplicates (if applicable), and provides a unified view. Instances can pull reference data (codebooks, taxonomies, shared standards) from the hub.

**Why start here:**
- Matches the authority model (origin authority for records, hub authority for standards)
- Clear data governance — one entity sets the federation rules
- Single audit point for compliance
- Avoids multi-master conflict resolution (the hardest distributed systems problem)
- Natural fit for both use cases above

### Bilateral Peer Sync (Future Extension)

```
  Instance A ◄──► Instance B  (shared clients only)
```

When two instances frequently co-serve clients (e.g., an outreach team and a shelter), they may benefit from direct record sharing without routing through the hub. This is an optimization, not a starting architecture. It introduces:
- Peer discovery and authentication
- Bilateral conflict resolution
- More complex consent tracking (A shares with B but not C)

**Recommendation:** Design the metadata tables to accommodate peer connections from day one, but implement hub-and-spoke first. Bilateral sync can be added as a second mode without schema changes.

### Full Mesh (Not Recommended)

Every instance replicates with every other instance. This has quadratic complexity (N×(N-1)/2 channels), makes privacy enforcement extremely difficult, and requires CRDT or vector-clock-based conflict resolution that PostgreSQL doesn't natively support. No current use case justifies this complexity.

---

## Architecture

### Why a Service Layer (Not Native PostgreSQL Replication)

PostgreSQL logical replication operates at the table level — it replicates all rows of a published table to all subscribers. Federation requires finer control:

| Requirement | Logical Replication | Service Layer |
|---|---|---|
| Row-level filtering (consent, status) | Limited (`WHERE` on publication, PG 15+) | Full control |
| Column projection (strip PII) | Column lists on publication (PG 15+) | Full control |
| Schema transformation (local → standard) | Not supported | Core capability |
| ETag version gating | Not applicable | Natural fit |
| Retry with audit trail | Replication slots, no app-level audit | River jobs with logging |
| Authentication | Replication roles (superuser-adjacent) | Keycloak client credentials |
| Per-peer configuration | One publication per subscriber | Metadata-driven per peer |

The service layer approach reuses Civic OS's existing infrastructure: PostgREST for reads/writes, the Go worker for reliable job processing, and Keycloak for authentication.

### Component Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Local Instance                        │
│                                                          │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────┐  │
│  │ PostgREST│◄──►│ Go Worker     │───►│ PostgreSQL   │  │
│  │ (local)  │    │ (federation   │    │ (river_job + │  │
│  │          │    │  job handler) │    │  sync_log)   │  │
│  └──────────┘    └───────┬───────┘    └──────────────┘  │
│                          │                               │
└──────────────────────────┼───────────────────────────────┘
                           │ HTTPS + Bearer token
                           ▼
┌──────────────────────────┼───────────────────────────────┐
│                    Hub Instance                           │
│                          │                               │
│  ┌──────────┐    ┌───────┴───────┐    ┌──────────────┐  │
│  │ PostgREST│◄──►│ Go Worker     │───►│ PostgreSQL   │  │
│  │ (hub)    │    │ (ingest +     │    │ (federated   │  │
│  │          │    │  dedup jobs)  │    │  tables)     │  │
│  └──────────┘    └───────────────┘    └──────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Sync Flow (Outbound: Instance → Hub)

1. **Trigger**: A database trigger (or scheduled River cron job) detects a qualifying change — a record inserted, a status reaching "closed," or a manual Entity Action Button click ("Submit to Hub").
2. **Enqueue**: A row is inserted into `river_job` with kind `federation_sync` and args identifying the entity, record ID, target peer, and mapping to apply.
3. **Read**: The Go worker reads the record from local PostgREST (with `select` string derived from the mapping), capturing the response ETag.
4. **Transform**: The worker applies the declared schema mapping — renaming columns, computing derived values, redacting PII-flagged fields.
5. **Push**: The worker POSTs (or PATCHes) the transformed record to the hub's PostgREST endpoint, authenticated with Keycloak client credentials. If updating an existing federated record, it sends `If-Match` with the last-known hub ETag.
6. **Handle response**:
   - **201/200**: Success. Log to `metadata.federation_sync_log` with the returned ETag.
   - **412 Precondition Failed**: The hub's copy was modified since our last sync. Log the conflict. Resolution depends on configuration (see Conflict Resolution below).
   - **4xx/5xx**: Transient or permanent failure. River retries with exponential backoff. Persistent failures go to dead letter.
7. **Update sync state**: Record the new ETag, timestamp, and status in the sync log.

### Sync Flow (Inbound: Hub → Instance)

For reference data distribution (codebooks, taxonomies, policy updates):

1. Hub publishes an update to a reference entity.
2. Hub's worker enqueues `federation_distribute` jobs for each subscribing instance.
3. Worker pushes the updated reference record to each instance's PostgREST with `If-Match`.
4. Instance accepts or 412s (if local admin has customized the reference data).

For client identity sync (HMIS-like):

1. Hub deduplicates client records and produces a master identity.
2. Hub pushes the merged identity back to originating instances.
3. Instances update their local client reference to point to the hub's canonical ID.

This inbound path is more complex and is where the use case will drive design decisions. The statistical reporting use case may never need inbound sync at all.

---

## ETag Version Gating in Federation Context

The ETag concurrency design (`docs/notes/ETAG_CONCURRENCY_DESIGN.md`) was written for the Edit Page save path. The same mechanism extends to service-to-service sync with no protocol changes — it's standard HTTP.

### Version Chain

```
Instance                          Hub
────────                          ───
Record created locally
  │
  ├─ Sync push (no If-Match)
  │                               Record created, ETag: "aaa"
  │                               ──────────────────────────
  ├─ Store hub ETag "aaa"
  │   in sync_log
  │
Record updated locally
  │
  ├─ Sync push (If-Match: "aaa")
  │                               ETag matches → update applied
  │                               New ETag: "bbb"
  │                               ──────────────────────────
  ├─ Store hub ETag "bbb"
  │   in sync_log
  │
  │                               Hub admin corrects a field
  │                               New ETag: "ccc"
  │                               ──────────────────────────
Record updated locally again
  │
  ├─ Sync push (If-Match: "bbb")
  │                               ETag mismatch → 412!
  │                               ──────────────────────────
  ├─ Conflict logged
```

### Why ETags Over Timestamps

- **No clock synchronization required** between instances (wall clocks drift)
- **Covers the full representation** including any joined/embedded fields
- **Standard HTTP** — any PostgREST endpoint supports it with zero configuration
- **Composable** — the same ETag the Edit Page uses for user-to-user concurrency is the one the federation service uses for instance-to-instance concurrency

### Conflict Resolution Strategies

When a sync push receives 412, the configured strategy determines next steps:

| Strategy | Behavior | Appropriate When |
|---|---|---|
| **Log and alert** | Record the conflict, notify an admin. No automatic resolution. | Default. Safe for initial deployments. |
| **Force overwrite** | Re-send without `If-Match`. Origin instance's version wins. | Instance is authoritative and hub should never independently modify federated records. |
| **Fetch and merge** | Pull hub's current version, diff against local, attempt field-level merge. | Shared records where both sides may legitimately edit different fields. |
| **Defer to hub** | Drop the push. Hub's version stands. | Hub is authoritative (e.g., client identity after dedup). |

The strategy should be configurable per mapping, per peer — not a global setting.

---

## Trust Model

### Three Trust Dimensions

**1. Data Authority — Who owns the record?**

| Authority Model | Description | Configuration |
|---|---|---|
| Origin authority | The instance that created a record is always authoritative. Hub accepts pushes but cannot independently modify. | Default for outbound-only reporting. |
| Hub authority | The hub can override instance data (e.g., after deduplication or quality review). | Configured per entity on the hub. |
| Shared authority | Multiple instances can modify different fields of the same record. | Requires field-level merge strategy. Most complex. |

**2. Visibility — Who can see what?**

This extends Civic OS's existing RLS model across instance boundaries:

| Visibility Model | Description | Use Case |
|---|---|---|
| All federated data visible to hub | Hub sees everything instances push. | Statistical reporting — the hub IS the audience. |
| Consent-based | Records are shared only when a subject (e.g., client) has granted consent to specific orgs. | HMIS-like — consent is tracked per client per org. |
| Aggregated only | Instances push computed summaries, never individual records. | Public dashboards, open data portals. |

Consent-based visibility means the federation service must evaluate per-record sharing rules before pushing. This is the row-filtering capability that rules out native logical replication.

**3. Authentication — How do instances prove identity?**

Civic OS already has the building blocks:

- **Keycloak client credentials flow**: Each instance registers as an OAuth2 client in the hub's Keycloak realm (or a shared federation realm). The worker obtains a bearer token and includes it in PostgREST requests. This mirrors the existing `civic-os-service-account` pattern used by the consolidated worker for user provisioning.
- **PostgREST + RLS**: The hub's PostgREST validates the bearer token. RLS policies on federated tables use JWT claims to enforce what each instance can read/write. An instance authenticated as `instance_a` can only modify records with `federation_origin = 'instance_a'`.

No new authentication infrastructure is needed. The trust boundary is the Keycloak token validation that PostgREST already performs.

---

## Metadata Configuration

Following Civic OS's convention of metadata-driven behavior, federation would be configured through database tables rather than code or config files.

### `metadata.federation_peers`

Registered instances that this node communicates with.

| Column | Type | Purpose |
|---|---|---|
| `id` | `serial PK` | Internal identifier |
| `peer_key` | `text UNIQUE` | Stable identifier (e.g., `citywide-hub`, `shelter-north`) |
| `display_name` | `text` | Human-readable name |
| `postgrest_url` | `text` | Base URL for the peer's PostgREST API |
| `auth_client_id` | `text` | Keycloak client ID for authenticating to this peer |
| `auth_realm_url` | `text` | Keycloak realm token endpoint for this peer |
| `direction` | `text` | `outbound`, `inbound`, or `bidirectional` |
| `is_active` | `boolean` | Enable/disable without deleting configuration |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |

### `metadata.federation_mappings`

Declares how a local entity maps to a federated standard for a specific peer.

| Column | Type | Purpose |
|---|---|---|
| `id` | `serial PK` | |
| `peer_id` | `FK → federation_peers` | Target peer |
| `local_entity` | `text` | Local table name (e.g., `incidents`) |
| `federated_entity` | `text` | Entity name on the peer (e.g., `standardized_incidents`) |
| `column_mappings` | `jsonb` | `{"local_col": "federated_col", ...}` with optional transform hints |
| `row_filter_rpc` | `text` | Optional RPC name that returns boolean — should this record be synced? |
| `pii_redact_columns` | `text[]` | Columns to strip or hash before pushing |
| `conflict_strategy` | `text` | `log_and_alert`, `force_overwrite`, `fetch_and_merge`, `defer_to_hub` |
| `is_active` | `boolean` | |

### `metadata.federation_subscriptions`

Controls sync cadence and trigger conditions.

| Column | Type | Purpose |
|---|---|---|
| `id` | `serial PK` | |
| `mapping_id` | `FK → federation_mappings` | Which mapping this subscription governs |
| `trigger_mode` | `text` | `on_change` (LISTEN/NOTIFY), `scheduled`, or `manual` |
| `schedule_cron` | `text` | Cron expression for scheduled mode (e.g., `0 2 * * *` for 2 AM daily) |
| `trigger_status` | `text` | Optional: only sync when record reaches this status (e.g., `closed`) |
| `last_sync_at` | `timestamptz` | Timestamp of last successful batch sync |

### `metadata.federation_sync_log`

Audit trail for every sync attempt.

| Column | Type | Purpose |
|---|---|---|
| `id` | `bigserial PK` | |
| `mapping_id` | `FK → federation_mappings` | |
| `local_record_id` | `text` | Primary key of the synced record (text for UUID/int flexibility) |
| `peer_id` | `FK → federation_peers` | |
| `direction` | `text` | `outbound` or `inbound` |
| `sent_etag` | `text` | ETag sent with `If-Match` (null for first push) |
| `received_etag` | `text` | ETag returned by the peer (stored for next sync) |
| `status` | `text` | `success`, `conflict_412`, `error_4xx`, `error_5xx`, `pending` |
| `error_detail` | `text` | Error message on failure |
| `synced_at` | `timestamptz` | |

The sync log serves double duty: audit trail and version tracking. The `received_etag` for the most recent `success` entry is the `If-Match` value for the next push of that record.

---

## Go Worker Integration

Federation jobs run in the existing consolidated Go worker alongside file storage, notifications, and user provisioning jobs.

### New Job Kinds

| Kind | Purpose |
|---|---|
| `federation_sync_outbound` | Push a single record to a peer. Args: `mapping_id`, `record_id`. |
| `federation_sync_batch` | Scheduled batch sync. Args: `subscription_id`. Enqueues individual `federation_sync_outbound` jobs. |
| `federation_sync_inbound` | Process an incoming record from a peer. Args: `mapping_id`, `payload`. |
| `federation_conflict_resolve` | Attempt automated conflict resolution for a 412'd record. Args: `sync_log_id`. |

### Trigger Mechanisms

**Event-driven (on_change):**
A PostgreSQL trigger on the federated entity fires on INSERT/UPDATE. If the record matches the subscription's filter criteria (status, consent, etc.), it inserts a `federation_sync_outbound` job into `river_job`.

**Scheduled (cron):**
River supports periodic jobs. A `federation_sync_batch` job runs on the configured cron schedule, queries for records modified since `last_sync_at`, and enqueues individual outbound jobs.

**Manual (Entity Action Button):**
An Entity Action Button labeled "Submit to [Hub Name]" calls an RPC that enqueues a `federation_sync_outbound` job for the current record. This gives the user explicit control over when data leaves their instance — important for consent-based sharing.

### Authentication Flow

1. Worker reads peer's `auth_client_id` and `auth_realm_url` from `metadata.federation_peers`.
2. Worker requests a token from the peer's Keycloak using client credentials grant.
3. Worker caches the token (respecting `expires_in`) and includes it as `Authorization: Bearer` on PostgREST requests to the peer.

This is the same flow the worker already uses for the local Keycloak service account, extended to remote realms.

---

## Schema Mapping

The `column_mappings` JSONB field in `metadata.federation_mappings` defines how local columns translate to the federated standard. This is intentionally simple for the first iteration.

### Basic Column Rename

```json
{
  "incident_type_id": "category_code",
  "reported_at": "event_date",
  "location_text": "geo_location"
}
```

The worker reads the local record, renames keys according to the mapping, and pushes the result.

### Value Transformation (Future)

More complex mappings — like converting a local FK ID to a standardized code, or computing a derived field — would require either:

1. **A database VIEW** that presents the local data in the federated shape. The mapping then points at the VIEW instead of the base table. This is the Civic OS-native approach (Virtual Entities).
2. **An RPC** that accepts a record ID and returns the transformed representation. The mapping references the RPC name.
3. **Worker-side transform functions** registered by kind. Most flexible, but requires Go code changes per standard.

**Recommendation:** Start with option 1 (VIEWs). It requires no worker code changes, keeps transformation logic in SQL where it's testable, and aligns with the Virtual Entity pattern. The `local_entity` in the mapping just points to the VIEW name.

---

## Privacy and Consent

For use cases involving PII (coordinated services, client data), the federation layer must enforce sharing rules before any data leaves the instance.

### Row-Level Filtering

The `row_filter_rpc` in `metadata.federation_mappings` points to a PostgreSQL function that determines whether a given record should be synced:

```sql
-- Example: only sync clients who have signed a release of information
CREATE FUNCTION federation_filter_clients(p_record_id int)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM client_consents
    WHERE client_id = p_record_id
      AND consent_type = 'data_sharing'
      AND status = 'active'
      AND expires_at > now()
  );
$$ LANGUAGE sql SECURITY DEFINER;
```

The worker calls this function before pushing each record. If it returns false, the record is skipped and logged as `status = 'filtered'`.

### Column Redaction

The `pii_redact_columns` array lists columns to strip or hash. The worker removes these columns from the payload before pushing. For aggregated reporting, an alternative is to point the mapping at a VIEW that already excludes PII columns.

### Consent Revocation

When a consent record is deactivated, the instance should notify the hub to delete or archive the previously shared records. This could be a `federation_consent_revoked` job kind that sends a DELETE to the hub's PostgREST for the affected records.

---

## Open Questions

These are decisions that the first real use case will force. They are intentionally left unresolved.

| Question | Options | Depends On |
|---|---|---|
| Where does the hub run? | Same Civic OS instance with a "hub" role? Separate deployment? | Operational model of the coordinating body |
| How are federated standards versioned? | Semantic versioning in the mapping? Standard-version column on federated tables? | Whether the external standard evolves (HMIS data standards change annually) |
| Client deduplication algorithm? | Probabilistic matching (name + DOB + SSN-last-4)? Deterministic (shared unique ID)? | Whether a shared client identifier exists across orgs |
| Should the hub have its own UI? | Dashboard-only? Full Civic OS CRUD on federated data? | Whether hub operators need to edit federated records |
| How does an instance join/leave the federation? | Self-service registration? Manual onboarding? | Trust level and governance model |
| Network connectivity requirements? | Always-online? Store-and-forward for intermittent connectivity? | Whether instances are in locations with unreliable internet |
| Monitoring and alerting? | Sync lag dashboards? Alert on persistent 412s? Dead letter notifications? | Operational maturity of the federation |

---

## Implementation Phases (Notional)

These phases represent a possible ordering, not a commitment. The first customer will determine which capabilities are built first.

### Phase 0: ETag Concurrency (Prerequisite)

Implement `docs/notes/ETAG_CONCURRENCY_DESIGN.md`. Federation depends on `If-Match` support in `DataService` and the Go worker's HTTP client.

### Phase 1: Outbound Reporting (Simplest Case)

- `metadata.federation_peers` and `metadata.federation_mappings` tables
- `federation_sync_outbound` job kind in the Go worker
- Manual trigger via Entity Action Button ("Submit to Hub")
- `metadata.federation_sync_log` for audit
- Column rename mapping (JSONB)
- No inbound sync, no conflict resolution, no consent filtering

### Phase 2: Scheduled Batch Sync

- `metadata.federation_subscriptions` table
- `federation_sync_batch` job kind with River periodic scheduling
- Status-based trigger filtering (`trigger_status`)
- Batch sync state tracking (`last_sync_at`)

### Phase 3: Consent-Aware Filtering

- `row_filter_rpc` evaluation before push
- `pii_redact_columns` stripping
- Consent revocation propagation

### Phase 4: Inbound Sync and Conflict Resolution

- `federation_sync_inbound` job kind
- Reference data distribution (hub → instances)
- Conflict resolution strategies (configurable per mapping)
- `federation_conflict_resolve` job kind

### Phase 5: Bilateral Peer Sync

- Peer-to-peer connections (not just hub-and-spoke)
- Mutual authentication between peers
- More complex consent tracking (per-peer visibility)

---

## Relationship to Multi-Tenancy

The roadmap includes a Multi-Tenancy item (row-level tenant isolation within a single database). Federation and multi-tenancy are complementary, not competing:

- **Multi-tenancy**: Multiple organizations share one Civic OS instance with row-level isolation. Appropriate when a single operator (e.g., a city IT department) manages the instance for multiple departments.
- **Federation**: Multiple independent Civic OS instances share selected data across network boundaries. Appropriate when each organization controls its own instance and infrastructure.

A city might use multi-tenancy internally (police, fire, public works on one instance) and federation externally (submitting data to a state or federal hub). The two features can coexist.
