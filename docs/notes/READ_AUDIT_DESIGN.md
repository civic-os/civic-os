# Read Audit Design Document

> **Status**: Proposed (design complete, not implemented)
> **Author**: Daniel Kurin
> **Date**: August 2026

## Overview

Government deployments — law enforcement in particular — require auditing of **read** operations: who viewed which record, when, and how. Write auditing is a solved pattern (triggers → audit tables; see the Activity/Audit Log roadmap item), but PostgreSQL fires no triggers on SELECT, so read auditing requires a fundamentally different architecture.

This document specifies a read-audit system for Civic OS built from four layers:

```
┌─────────────────────────────────────────────────────────────────┐
│ CAPTURE      pgAudit (object mode) inside PostgreSQL            │
│ ATTRIBUTION  db-pre-request stamps user UUID into               │
│              application_name (PostgREST server config)         │
│ TRANSPORT    Log stream → Go worker (adapter per environment)   │
│ CONSUMPTION  audit.read_log table → admin page, alert RPCs,     │
│              S3 archive                                         │
└─────────────────────────────────────────────────────────────────┘
```

Every layer that **establishes** the audit record is PostgreSQL + PostgREST configuration. The Go consolidated worker only makes records queryable and actionable — it is a post-processor, never the source of truth.

## Design Principles

1. **No reliance on client behavior.** The audit record must be complete and correct for *any* API client — the Angular app, curl, a hostile script. Nothing the client sends (headers, parameters) is trusted or required. This matches the Civic OS mental model: the API self-assembles from PostgreSQL + PostgREST configuration.
2. **Statement-level truth.** pgAudit logs the statement the executor actually ran, with bound parameters. This is the standard accepted by audit regimes (CJIS-style "log access attempts to protected information"): who, what, when, and the exact query — including attempts that RLS filtered to zero rows.
3. **The worker is a post-processor, never the source of truth.** The audit record is durable the moment PostgreSQL writes the log line — before the worker, River, or the rest of the database is involved. Worker downtime delays queryability; it never loses records (with one caveat on DigitalOcean; see Transport).
4. **Upstream pgAudit, no fork.** pgAudit has no plugin API, but forking it (one 2,487-line C file) was considered and rejected: perpetual per-PG-major-version maintenance, custom `.so` distribution, and — decisive for the government market — "we run upstream pgAudit, same as RDS/Cloud SQL/Crunchy" is a one-line answer in a security review, while a fork invites a code audit of our C. If a gap ever demands custom code, the path is (a) propose upstream (e.g., a `pgaudit.log_gucs` setting), then (b) a tiny *companion* extension chaining on the same hooks — never a fork.
5. **Self-assembly.** Enabling read audit on an entity is a metadata flag; the framework generates the grants. Per-provider setup (extension enablement, transport wiring) is one-time deployment configuration, like Keycloak.

## Rejected Alternatives

| Approach | Why rejected |
|---|---|
| Client-echoed audit header (Angular interceptor sends query context; `db-pre-request` logs it) | Spoofable/omittable by any non-Angular client. Violates principle 1. |
| `db-pre-request` logging alone | PostgREST exposes `request.path`, `request.method`, `request.headers`, `request.cookies`, `request.jwt.claims` as GUCs — **not the query string**. Knows *who* and *which entity*, but not *which record*. |
| Fork pgAudit | See principle 4. |
| `pgaudit_analyze` (official log-to-table companion) | A separate Perl daemon to containerize and operate; generic schema. The Go worker is already deployed with every instance, has `pg_query_go`, S3, and notifications. |
| Per-row logging VIEW (volatile function call per row) | Planner-dependent (no guarantee the function runs exactly once per returned row), significant read overhead. Reserved as an optional future "strict mode" via RPC-gated reads for the most sensitive entities — not the default mechanism. |
| `log_statement = 'all'` | Firehose; no object scoping, no parameter/row metadata, drowns the log. |

## Layer 1: Capture (pgAudit object mode)

```ini
# postgresql.conf (or provider parameter group / config API)
shared_preload_libraries = 'pgaudit'
pgaudit.role = 'civic_os_auditor'   # dedicated, non-login audit role
pgaudit.log_parameter = on          # bound values → record-level detail
pgaudit.log_rows = on               # rows retrieved/affected count
```

```sql
CREATE ROLE civic_os_auditor NOLOGIN;
-- Framework grants SELECT per audited entity (see Enablement below):
GRANT SELECT ON public.incidents TO civic_os_auditor;
```

**Why object mode**: session logging (`pgaudit.log = 'read'`) logs every SELECT including the metadata/schema queries every page load issues — impractical volume. Object mode logs only statements touching relations the auditor role can SELECT.

**JOIN / embed coverage**: pgAudit hooks `ExecutorCheckPerms` — the executor's permission check over the query's full range table. An audited relation is logged wherever it appears: direct SELECT, JOIN, subquery, a VIEW referencing it, or a PostgREST embedded resource (`?select=*,arrests(*)` compiles to a lateral join). An audited table cannot be read "sideways" through a join from an unaudited table without a log line.

**Record-level detail**: PostgREST compiles the URL's filters into the statement. With `log_parameter = on`, a Detail-page read logs `WHERE id = $1` plus `$1 = 5`. The query string never needs to leave the server side — it is *in* the statement.

**RLS interaction**: rows denied by RLS never leave the database, but pgAudit logs the *attempt* regardless of rows returned — exactly what access-attempt auditing requires. `log_rows` distinguishes "viewed" from "attempted, got nothing."

**Known quirk**: revoking SELECT from the audit role does not reliably disable read auditing for a relation already audited in the session ([pgaudit#210](https://github.com/pgaudit/pgaudit/issues/210)). Treat auditor grants as append-mostly.

## Layer 2: Attribution (application_name stamping)

PostgREST connects as one database role (`authenticated` / `web_anon`), so pgAudit alone attributes reads to the role, not the human. The bridge is server-side PostgREST configuration:

```sql
-- db-pre-request = 'metadata.pre_request'
CREATE FUNCTION metadata.pre_request() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Transaction-local; resets on pooled connections; legal in
  -- PostgREST's read-only GET transactions (GUC writes aren't data writes)
  PERFORM set_config('application_name',
                     coalesce(current_user_id()::text, 'anonymous'),
                     true);
END $$;
```

Every log line the transaction emits — including every pgAudit line — now carries the end user's UUID:

- **Self-hosted**: `log_line_prefix` includes `%a`; better, jsonlog/csvlog carry `application_name` as a dedicated field regardless of prefix.
- **RDS**: `log_line_prefix` is **not customizable** — irrelevant, because `log_destination = 'csvlog'` puts `application_name` in a dedicated column.
- **DigitalOcean**: `log_line_prefix` is limited to three presets, **all of which include `db=%d,app=%a`** — attribution and per-database demux both survive.

Bonus: the user UUID appears in `pg_stat_activity` during long-running queries.

## Layer 3: Transport (LogSource adapters)

The only environment-specific layer. The worker defines one interface:

```go
type LogSource interface {
    // Returns parsed records plus a checkpoint; ingestion resumes
    // from the last committed checkpoint after restart.
    Next(ctx context.Context) ([]LogRecord, Checkpoint, error)
}
```

Selected via env var (matching the worker's existing env-gated feature registration, e.g. the Keycloak workers): `READ_AUDIT_SOURCE=file|cloudwatch|syslog`.

### file — self-hosted / VPS (default)

- `log_destination = 'stderr,jsonlog'` — stderr keeps `docker compose logs postgres` working; jsonlog (PG 15+; we run PG 17) writes structured records to a volume the worker mounts read-only.
- Tail with checkpointed offsets; handle PostgreSQL log rotation.
- One JSON object per record — no CSV multi-line quoting issues; `application_name`, `session_id`, `session_line_num` are top-level fields.

### cloudwatch — AWS RDS

- pgAudit is officially supported on RDS via parameter groups.
- Enable PostgreSQL log export to CloudWatch Logs; worker polls `FilterLogEvents` (AWS SDK already linked for S3). Fallback: RDS `DownloadDBLogFilePortion`.
- Use `log_destination = 'csvlog'` for structured fields (see Attribution).
- CloudWatch *strengthens* the ground-truth story: durable, retention-configurable, IAM-controlled, outside the database's blast radius.

### syslog — DigitalOcean Managed Databases

- pgaudit is on DO's supported-extensions list. DO has no log file/download API; it forwards via **logsinks** (rsyslog / Elasticsearch / OpenSearch endpoints, RFC5424, TLS).
- The worker runs a syslog listener goroutine (precedent: the tracking server and scheduled-job ticker already run alongside River) as the rsyslog endpoint.
- Deployment docs mandate the machine-friendly prefix preset: `pid=%p,user=%u,db=%d,app=%a,client=%h`.
- **Logsinks are cluster-scoped.** There is no per-database stream; the endpoint receives every database in the cluster plus platform housekeeping lines. Consequences:
  - Same-customer multi-instance clusters are fine: the worker demuxes on `db=` into per-instance audit tables.
  - **Different customers must never share a cluster once audit forwarding is on** (customer A's endpoint would receive customer B's audit lines). Hard rule: read-audited instance ⇒ dedicated cluster, or cluster shared only within one customer.
- **Durability caveat**: logsink is push-based — if the listener is down, DO has nowhere to deliver and lines can drop (unlike file/CloudWatch, which buffer). Mitigation: DO permits multiple logsinks per cluster; point a second sink at a durable store (small managed OpenSearch or hosted log service) as the archival ground truth; the worker can backfill gaps from it.

Cloud SQL and Azure Flexible Server also ship pgAudit with their own log APIs; adapters can be added on demand without touching the core.

## Layer 4: Ingestion & Normalization (Go worker)

Pipeline per record:

1. **Envelope parse** — jsonlog object, csvlog row, or syslog line + prefix regex → common `LogRecord` (timestamp, database, application_name, session_id, session_line_num, message).
2. **Filter** — keep messages beginning `AUDIT:`; drop everything else early (especially on DO's noisy cluster stream).
3. **Payload parse** — pgAudit's message body is CSV (class, command, object type, object name, statement, parameters, rows).
4. **AST normalization** — parse the statement with **`pg_query_go`** (already a worker dependency via `source_code_parser.go` — the real PostgreSQL parser, not regex):
   - Extract every relation referenced → `relations` array (this is the JOIN answer at the reporting layer: "who read from `arrests`, even via an embed" is a plain query).
   - For primary-key-equality statements, resolve bound parameters → concrete `record_id`s. Detail-page reads become `(user, entity, record_id, timestamp)` — the "who viewed record X" index.
   - Otherwise store the normalized filter expression plus the `log_rows` count.
5. **Insert** — batched, into `audit.read_log`.

**Idempotency**: PostgreSQL's structured formats include `session_id` + `session_line_num` in every record — a natural unique key, identical across all three transports. At-least-once ingestion is safe; `ON CONFLICT DO NOTHING`.

**Cadence**: start with a once-a-minute batch job (simple, idempotent); a streaming tailer goroutine is a latency optimization, not a correctness requirement.

## Layer 5: Storage

```sql
CREATE SCHEMA audit;

CREATE TABLE audit.read_log (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  logged_at        timestamptz NOT NULL,
  user_id          uuid,                -- from application_name; NULL = anonymous
  database_name    text NOT NULL,       -- demux field (DO multi-db clusters)
  session_id       text NOT NULL,
  session_line_num bigint NOT NULL,
  audit_class      text NOT NULL,       -- READ, etc.
  command          text NOT NULL,       -- SELECT, etc.
  statement        text NOT NULL,
  parameters       jsonb,
  relations        text[] NOT NULL,     -- every relation touched, joins included
  record_ids       jsonb,               -- resolved pk-equality ids, keyed by relation
  rows_returned    bigint,
  PRIMARY KEY (id, logged_at),
  UNIQUE (session_id, session_line_num, logged_at)
) PARTITION BY RANGE (logged_at);       -- monthly partitions
```

- **Append-only**: the ingestion role gets INSERT only; no role gets UPDATE/DELETE. Retention drops whole partitions.
- **Indexes**: `(user_id, logged_at)`, GIN on `relations`, GIN on `record_ids`.
- **Retention & partition rollover**: SQL functions on the existing `metadata.scheduled_jobs` cron system — zero new Go. Default retention TBD (CJIS-style regimes commonly require ≥ 1 year).
- **Raw archive (optional tier)**: worker ships raw log segments to S3 (client already in the worker); S3 Object Lock provides WORM storage for compliance.

## Layer 6: Consumption

### Admin page (`/admin/read-audit`)

Read-only VIEW + RPCs per `docs/notes/ADMIN_PAGE_PITFALLS.md`. Core queries: "who viewed record X" (GIN on `record_ids`), "everything user Y read in range", "all access to entity Z". Permission-gated (likely a dedicated `audit:read` permission — admin-only by default).

### Alert rules (bespoke RPCs on scheduled jobs)

**Decision**: alert rules are bespoke SQL functions written per customer need, executed by `metadata.scheduled_jobs`, until usage patterns justify a structured GUI-managed system.

Conventions every alert RPC follows from day one:

1. **High-water mark, not time windows.** Each RPC tracks the last processed `read_log.id` in a state row and scans only forward. Cron is at-least-once and possibly delayed; a watermark makes runs idempotent — no duplicate alerts after a missed tick, no gap if ingestion lagged. (Same idempotency discipline River enforces with unique keys, one layer up.)
2. **Deliver via the existing notification pipeline** — the RPC inserts a notification; email/SMS delivery is machinery that already exists.
3. **Register via `metadata.auto_register_function()`** so every detective control self-documents through System Introspection — "what alerting runs on this system?" is answered by the introspection page.

Example rules: user reads > N distinct person records within an hour; off-hours bulk access; repeated zero-row attempts against a protected entity (probing). Misuse detection (e.g., personnel looking up acquaintances) is a documented real-world problem in law-enforcement systems and a meaningful differentiator.

**Future**: `metadata.audit_alert_rules` (entity, condition, threshold, window, recipients) evaluated by one generic RPC, with GUI management — bespoke RPCs migrate into rows or remain as escape hatches, mirroring the validation system's duality.

## Enablement & Self-Assembly

- `audit_reads boolean DEFAULT false` on `metadata.entities` (open question: separate table instead).
- A framework function (pattern: `enable_entity_notes()`) applies `GRANT SELECT ON <table> TO civic_os_auditor` when flagged. Plain SQL — identical on self-hosted and managed.
- One-time per-deployment setup (deployment docs, like Keycloak): enable the extension (`shared_preload_libraries` locally; parameter group on RDS; config API on DO), set pgAudit GUCs, configure `db-pre-request`, wire the transport.
- Worker env: `READ_AUDIT_ENABLED`, `READ_AUDIT_SOURCE`, plus source-specific settings (log dir / CloudWatch group / syslog listen address + TLS cert).

## Environment Configuration Matrix

| | Self-hosted / VPS | AWS RDS | DigitalOcean |
|---|---|---|---|
| pgAudit enablement | `shared_preload_libraries` | Parameter group (officially supported) | Supported-extensions list + config API |
| Log format | jsonlog (+ stderr for docker logs) | csvlog | text + mandated prefix preset (`pid=,user=,db=,app=,client=`) |
| Attribution field | jsonlog `application_name` | csvlog `application_name` column | `app=%a` in prefix |
| Transport | File tail on shared volume | CloudWatch Logs (`FilterLogEvents`); fallback `DownloadDBLogFilePortion` | Cluster-scoped logsink → worker syslog listener |
| Ground truth | Log files (buffer through worker downtime) | CloudWatch (durable, IAM-controlled) | **Weakest** — push-based; mitigate with second logsink to durable store |
| Multi-DB / tenancy note | — | Per-instance log group | One stream per cluster; demux on `db=`; **never share a cluster across customers** |

## Integrity & Threat Notes

- Audit records are durable at log-write time, before any application code runs — a compromised worker can delay or corrupt the *queryable* copy but not the ground truth (files / CloudWatch; on DO, the second logsink).
- `audit.read_log` is append-only by grants; retention is partition-drop only.
- The attribution GUC is set by `db-pre-request` (server config) from the verified JWT — clients cannot influence it.
- `db-pre-request` failure fails the request (fail-closed for attribution).
- Anonymous (`web_anon`) reads of audited entities log with `user_id = NULL`; whether to audit anonymous reads at all is an open question (public tables are usually not audit targets).

## Performance Considerations

- Object mode scopes logging to flagged entities — metadata/schema queries produce zero audit volume.
- pgAudit overhead on audited statements is modest (statement formatting at executor time); the dominant cost is log volume — size `log_rotation_size`/retention accordingly.
- Ingestion is batched with COPY-style inserts; a minute of latency is acceptable (alerts read the table, not the stream).
- Alert RPCs scan forward from watermarks — bounded work per tick regardless of table size.

## Phasing

1. **Phase 1 — capture + attribution (config only, no code)**: pgAudit object mode, auditor role + `audit_reads` flag/grant function, `db-pre-request` stamping, deployment docs for all three environments. Compliance-credible on its own (logs are grep-able/SIEM-shippable).
2. **Phase 2 — ingestion + admin page**: `LogSource` adapters (file first, then cloudwatch, then syslog), `audit.read_log` schema + migration, `/admin/read-audit`.
3. **Phase 3 — alerting + archive**: bespoke alert RPC conventions + first rules, retention scheduled jobs, optional S3/WORM archive.
4. **Phase 4 (on demand)** — structured alert rules + GUI; optional RPC-gated "strict mode" (true per-row read receipts) for the most sensitive entities.

## Open Questions

- `audit_reads` on `metadata.entities` vs. a dedicated `metadata.read_audit_config` table (per-entity retention/config would favor the latter).
- Default retention period (regime-dependent; ≥ 1 year likely floor).
- jsonlog availability on RDS (csvlog is confirmed and sufficient; jsonlog would be nicer) — verify at implementation time.
- DO logsink delivery/retry semantics under endpoint downtime — verify empirically; determines how hard to push the dual-sink requirement.
- Whether to audit anonymous (`web_anon`) reads.
- Statement truncation: pgAudit logs full statements; very large `IN` lists / M:M queries may need `log_parameter_max_size` tuning.
- Upstream contribution: propose `pgaudit.log_gucs` (embed named GUCs like `request.jwt.claims` directly in audit records) — would let attribution ride inside the pgAudit record itself rather than the envelope.

## References

- [pgAudit](https://github.com/pgaudit/pgaudit) — capture layer (object mode, `log_parameter`, `log_rows`)
- [pgaudit_analyze](https://github.com/pgaudit/pgaudit_analyze) — rejected companion; prior art for log-to-table
- [PostgREST transactions & GUCs](https://docs.postgrest.org/en/v14/references/transactions.html) — `db-pre-request`, available request settings
- [AWS RDS pgAudit](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.pgaudit.html)
- [DO supported extensions](https://docs.digitalocean.com/products/databases/postgresql/details/supported-extensions/) · [DO log forwarding](https://docs.digitalocean.com/products/databases/postgresql/how-to/forward-logs/) · [DO PostgreSQL config (prefix presets)](https://docs.digitalocean.com/reference/terraform/reference/resources/database_postgresql_config/)
- [pg_query_go](https://github.com/pganalyze/pg_query_go) — already a worker dependency (`source_code_parser.go`)
- Related: `docs/notes/SCHEDULED_JOBS_DESIGN.md` (alert execution), `docs/notes/ADMIN_PAGE_PITFALLS.md` (admin page pattern), `docs/development/NOTIFICATIONS.md` (alert delivery)
