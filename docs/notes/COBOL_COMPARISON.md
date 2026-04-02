# Civic OS vs COBOL: Comparative Analysis for Government Modernization

> **Context**: This document evaluates Civic OS as a replacement for COBOL-based government systems, analyzing architectural parallels, migration paths, and scope boundaries. Written March 2026.

## Three-Layer Architecture Comparison

Civic OS has three distinct layers that map onto what COBOL mainframe systems actually do:

```
┌─────────────────────────────────────────────────┐
│  STRUCTURAL LAYER                                │
│  metadata.entities, metadata.properties          │
│  "What data exists and how to display it"        │
│  COBOL equivalent: DATA DIVISION + Copybooks     │
├─────────────────────────────────────────────────┤
│  CAUSAL LAYER                                    │
│  metadata.status_transitions                     │
│  metadata.property_change_triggers               │
│  metadata.entity_actions                         │
│  "What happens when data changes"                │
│  COBOL equivalent: EVALUATE/PERFORM flow control │
├─────────────────────────────────────────────────┤
│  REACTIVE LAYER                                  │
│  PostgreSQL triggers, RPC functions              │
│  Go worker (notifications, files, payments)      │
│  Scheduled jobs (cron)                           │
│  "The imperative code that executes effects"     │
│  COBOL equivalent: PROCEDURE DIVISION paragraphs │
│  + JCL batch + MQ messaging                      │
└─────────────────────────────────────────────────┘
```

## Core Similarities

### 1. Declarative, Metadata-Driven Philosophy

Both systems bet on **describing what data looks like** rather than writing imperative code for every operation.

- **COBOL**: `DATA DIVISION` declares record layouts; copybooks (`COPY`) are shared schema definitions referenced by multiple programs.
- **Civic OS**: `metadata.entities` and `metadata.properties` declare record layouts; `schema_entities` and `schema_properties` views aggregate them for consumption.

```
COBOL:        COPYBOOK → DATA DIVISION → PROCEDURE DIVISION → Screen
Civic OS: metadata tables → schema views → SchemaService → Dynamic Pages
```

### 2. Database-Centric Architecture

COBOL government systems are overwhelmingly database-centric — business logic lives in the data layer (DB2 stored procedures, VSAM file definitions, IMS hierarchical segments). The application is a thin processing layer over structured data.

Civic OS is architecturally identical: business logic lives in PostgreSQL (RLS policies for security, triggers for workflows, RPCs for actions, CHECK constraints for validation). The Angular frontend is intentionally thin.

### 3. Role-Based Access Control

- **COBOL**: RACF/ACF2/Top Secret gate access based on user identity and resource definitions.
- **Civic OS**: `metadata.roles` + `metadata.permissions` + Row Level Security, with Keycloak as identity provider. Same pattern: externalized authorization at the data access layer.

### 4. Record-Oriented Thinking

COBOL thinks in records and batches. Civic OS thinks in entities and list views. Both organize the world as "collections of typed records with defined relationships."

## Core Differences

| Dimension | COBOL | Civic OS |
|---|---|---|
| **UI generation** | Separate (CICS/BMS maps, hand-coded) | Automatic from schema metadata |
| **Schema evolution** | Painful (copybook changes cascade) | Sqitch migrations + metadata updates |
| **Data types** | Fixed-length fields, PICTURE clauses | PostgreSQL domains (`phone_number`, `hex_color`, `time_slot`) |
| **Deployment** | Mainframe (z/OS, AS/400) | Docker containers, any Linux host |
| **Cost model** | MIPS-based licensing ($$$) | Open source (AGPL), commodity hardware |
| **Integration** | MQ Series, CICS transactions, JCL batch | PostgREST API, webhooks, iCal feeds |
| **Workflow** | Hardcoded in PROCEDURE DIVISION | Metadata-driven (status transitions, action buttons) |
| **Reporting** | COBOL report writers, JCL extracts | Excel export, dashboard widgets |
| **Behavioral discoverability** | Grep through source code / tribal knowledge | SQL-queryable metadata views |

### The Key Architectural Difference: Queryable vs. Opaque

COBOL buries its state machine in PROCEDURE DIVISION paragraphs across multiple programs. To understand "what happens when a permit is approved," you grep through hundreds of source files.

Civic OS makes the same information **queryable from SQL**:

```sql
-- "What happens when a permit is approved?"
SELECT * FROM metadata.property_change_triggers
WHERE table_name = 'permits' AND change_type = 'changed_to';

-- "What transitions are allowed from Pending?"
SELECT * FROM metadata.status_transitions
WHERE entity_type = 'permit' AND from_status_id = get_status_id('permit', 'pending');

-- "What entities does approve_permit() affect?"
SELECT * FROM schema_entity_dependencies
WHERE source_name = 'approve_permit';
```

The `schema_entity_dependencies` view distinguishes **structural** dependencies (foreign keys) from **causal** dependencies (triggers/RPCs that modify data). COBOL has no equivalent without expensive static analysis tools.

## Behavioral Layer: Detailed Mapping

### Status-Driven Workflows

A typical COBOL government program:

```cobol
EVALUATE WS-PERMIT-STATUS
  WHEN 'PENDING'
    IF WS-ACTION = 'APPROVE'
      PERFORM 2000-APPROVE-PERMIT
      PERFORM 3000-CREATE-INSPECTION
      PERFORM 4000-SEND-NOTIFICATION
    END-IF
  WHEN 'APPROVED'
    IF WS-ACTION = 'COMPLETE'
      PERFORM 2100-COMPLETE-PERMIT
      PERFORM 4000-SEND-NOTIFICATION
    END-IF
END-EVALUATE
```

The same system in Civic OS:

1. **`metadata.status_transitions`** declares the state machine graph
2. **`metadata.property_change_triggers`** declares what fires on each change
3. **`metadata.entity_actions`** declares the UI buttons with visibility/enable conditions
4. **`transition_entity()`** gateway validates and executes transitions
5. **PostgreSQL BEFORE/AFTER triggers** execute the actual work

### Construct-by-Construct Mapping

| COBOL Construct | Civic OS Equivalent | Notes |
|---|---|---|
| `EVALUATE WS-STATUS` (state machine) | `metadata.status_transitions` + `transition_entity()` | Validates transitions automatically; COBOL relies on programmer discipline |
| `PERFORM 2000-APPROVE` (business logic) | RPC function returning JSONB | Same isolation as CICS transactions via SECURITY DEFINER |
| `PERFORM 3000-CREATE-INSPECTION` (cascade) | AFTER trigger + `property_change_triggers` | Declaratively registered, not buried in program flow |
| JCL batch job (`//STEP01 EXEC PGM=...`) | `metadata.scheduled_jobs` with cron + timezone | Go worker replaces JES2; JSONB results replace SYSPRINT |
| CICS BMS screen map | Auto-generated from metadata | Biggest labor savings |
| Copybook (`COPY PERMIT-REC`) | PostgreSQL DDL + `metadata.properties` | Schema is single source of truth |
| RACF resource rules | `metadata.roles` + `metadata.permissions` + RLS | More granular — row-level, not just transaction-level |
| MQ Series message | `create_notification()` → River queue → Go worker | At-least-once delivery with automatic retries |
| DB2 CHECK constraint | PostgreSQL CHECK + `metadata.validations` | Dual enforcement: frontend for UX, backend for security |
| COBOL report writer | Excel export + dashboard widgets | Less powerful for complex reports |

### Transaction Gateway Parallel

COBOL/CICS uses **transaction codes** as the only sanctioned entry points for modifying data. You don't write directly to DB2; you invoke transaction `PRMT` which runs `PERMIT01` which validates and updates.

Civic OS's `transition_entity()` is the same pattern:

```
COBOL/CICS:
  Terminal → CICS Transaction Code → COBOL Program → DB2 UPDATE
  (Direct DB2 UPDATE from terminal = security violation)

Civic OS:
  UI Action → RPC → transition_entity() → PostgreSQL UPDATE
  (Direct UPDATE on status_id = blocked by BEFORE trigger guard)
```

The session variable depth counter (`civic_os.transition_depth`) handles re-entrancy — the same problem CICS programmers manage with `LINK` vs `XCTL`.

## COBOL Replacement Assessment

### Coverage Estimate: ~75-80% of Government COBOL

The behavioral layer significantly expands coverage beyond pure CRUD:

1. **Status-driven workflows** — permits, cases, applications, inspections, complaints all follow "record enters → progresses through statuses → triggers side effects." `status_transitions` + `property_change_triggers` captures this directly.

2. **Batch processing** — `metadata.scheduled_jobs` covers common patterns: overdue detection, reminder notifications, auto-completion, periodic reports.

3. **Payment processing** — Stripe integration (webhook → trigger → status sync → notification) replaces COBOL programs reading MQ messages from payment gateways.

4. **System documentation** — The introspection system (`schema_functions`, `schema_triggers`, `schema_entity_dependencies`, `schema_notifications`) solves one of government COBOL's worst problems: nobody knows what the system does.

### Strong Fit

- CRUD-heavy departmental systems (permits, case management, asset registries, inspection logs)
- Green-screen replacements (3270 terminal screens that map 1:1 to database records)
- Simple, well-defined status workflows (submitted → reviewed → approved → closed)
- Systems where documentation has been lost and tribal knowledge is the only guide

### Needs Extension

- **Complex batch processing** — Multi-million-record nightly runs need Airflow/pg_cron alongside Civic OS
- **Complex calculation engines** — Tax tables, benefit formulas, actuarial computations need dedicated services
- **Multi-system orchestration** — COBOL programs coordinating across IMS, DB2, VSAM, and MQ in a single transaction

### Outside Scope

- Real-time transaction processing at mainframe scale (millions TPS)
- Large-state tax/unemployment/benefit processing systems
- 500-page formatted report generation with control breaks and cross-references

## Migration Paths

### Path 1: Strangler Fig (Recommended)

Identify self-contained COBOL subsystems, replace individually:

```
Phase 1: Identify self-contained subsystems (permits, complaints, assets)
Phase 2: Model data in PostgreSQL, mapping copybooks → tables + metadata
Phase 3: Deploy Civic OS alongside the mainframe
Phase 4: Build sync bridge (MQ → PostgreSQL or batch extract/load)
Phase 5: Migrate users gradually, decommission COBOL programs one by one
```

Works because government COBOL systems are almost always collections of loosely-coupled programs sharing data stores.

### Path 2: Full Schema + Behavioral Migration

```
Phase 1: DATA DIVISION → Structural Layer
  - Parse copybooks → PostgreSQL DDL
  - Map PIC clauses → PostgreSQL types + custom domains
  - Configure metadata.entities + metadata.properties

Phase 2: EVALUATE/PERFORM → Causal Layer
  - Extract state machines from PROCEDURE DIVISION
  - Map to metadata.status_transitions
  - Extract cascade rules → metadata.property_change_triggers
  - Extract screen actions → metadata.entity_actions

Phase 3: Business Logic → Reactive Layer
  - Rewrite COBOL paragraphs as PL/pgSQL functions
  - SECURITY DEFINER mirrors CICS transaction isolation
  - BEFORE/AFTER trigger choreography replaces PERFORM sequence

Phase 4: JCL Batch → Scheduled Jobs
  - Map JCL schedules to cron expressions
  - Rewrite batch programs as RETURNS JSONB functions
  - Go worker replaces JES2 scheduler

Phase 5: Notifications
  - Map COBOL print/mail programs to notification templates
  - Go template syntax replaces COBOL STRING/UNSTRING formatting
```

### Path 3: API Bridge (Lowest Risk)

Keep mainframe running, mirror data to PostgreSQL, use Civic OS as the new UI layer. Writes go through an API bridge back to the mainframe. Maintains mainframe costs during transition but minimizes risk.

## The Fundamental Insight

COBOL and Civic OS represent two solutions to the same problem: government agencies need systems that manage structured records through status-driven workflows with role-based access control and automated side effects.

COBOL solved it in 1959 by giving programmers a language to write these systems imperatively. Every agency wrote the same patterns — state machines, permission checks, notification dispatch, batch scheduling — thousands of times.

Civic OS solves it in 2025 by recognizing that **these patterns are universal** and encoding them as framework-level abstractions. The structural layer eliminates screen-building. The causal layer eliminates state-machine coding. The reactive layer provides the escape hatch for genuinely custom logic.

Most government COBOL isn't complex — it's repetitive. The complexity comes from scale (thousands of similar programs) and age (decades of patches), not algorithmic sophistication. A framework that eliminates the repetition while providing queryable behavioral metadata addresses the root cause.
