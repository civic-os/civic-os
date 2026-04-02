# Deterministic Schema Operations — Migration-First SDK Design

> Copyright (C) 2023-2026 Civic OS, L3C. Licensed under AGPL-3.0-or-later.

## Context

The LLM Schema Assistant eval harness (v0.42.0) proved that LLM-generated SQL scores
66-87/100 across 12 tasks at 4 difficulty levels, but cannot replace human review. The
best model (GPT 5.4) still produces deployment blockers on complex tasks — missed FK
indexes, incorrect RLS policies, wrong grant targets. See `docs/notes/LLM_SCHEMA_ASSISTANT_DESIGN.md`
for the eval harness architecture and scoring dimensions.

This research asks: **can we build deterministic tools where structured inputs produce
guaranteed-correct SQL?** If so, the LLM shifts from SQL generator to parameter extractor,
and the correctness burden moves from probabilistic generation to validated templates.

## Finding: 65% of Operations Are Already Parameterizable

A full audit of Civic OS schema operations reveals 49 distinct operations. Most are
mechanically predictable given structured inputs:

| Category | Count | % | Examples |
|----------|------:|--:|---------|
| Fully Parameterizable | 32 | 65% | Create table, add column, add validation, grant permissions, configure metadata, add status values, add category values, enable notes, add FK index, enable RLS, configure text search |
| Partially Parameterizable | 9 | 18% | Add FK relationship (needs join semantics), add M2M relationship (needs junction naming), configure dashboard widget (needs filter DSL), add computed field (needs SQL expression) |
| Freeform SQL Required | 8 | 16% | Virtual entities (INSTEAD OF triggers), custom RPCs, complex RLS policies, payment integration RPCs, custom notification triggers, RRULE expansion logic |
| **Total** | **49** | **100%** | |

The 32 fully parameterizable operations can be encoded as deterministic SQL templates
with zero LLM involvement. The 9 partially parameterizable operations need constrained
LLM assistance for specific sub-expressions only.

## Existing RPC Infrastructure

Civic OS already provides helper RPCs for programmatic schema configuration. These are
the reference implementations whose logic the SDK will encode into SQL templates:

| RPC | Purpose | Version |
|-----|---------|---------|
| `upsert_entity_metadata()` | Configure entity display name, description, menu order, search fields, calendar/recurring settings | v0.4.0+ |
| `set_role_permission()` | Grant or revoke table-level CRUD permissions for a role | v0.20.2+ |
| `enable_entity_notes()` | Enable polymorphic notes on an entity (creates permissions, configures metadata) | v0.16.0+ |
| `add_status_transition()` | Register an allowed status transition with optional on-transition RPC | v0.33.0+ |
| `add_property_change_trigger()` | Bind a property change event to an RPC function | v0.33.0+ |
| `auto_register_function()` | Register an RPC in the introspection system | v0.23.0+ |
| `create_schema_decision()` | Record an architectural decision with supersession support | v0.30.0+ |
| `get_role_id()` | Look up role ID by `role_key` | v0.36.0+ |
| `current_user_id()` / `current_user_email()` | JWT claim extraction helpers | v0.4.0+ |
| `has_permission()` / `is_admin()` | RBAC check helpers | v0.4.0+ |

**Gap**: These RPCs configure metadata and permissions but do not create DDL (tables,
columns, indexes, policies). The highest-value missing operation is a complete entity
creation workflow.

## The Gap: What's Missing

### `create_entity()` — Highest Value Missing Operation

Creating a new entity today requires 8+ separate SQL statements executed in correct order:

1. `CREATE TABLE` with required columns (`id`, `created_at`, `updated_at`, `display_name`)
2. `CREATE INDEX` on every FK column
3. `CREATE TRIGGER` for `updated_at` timestamp
4. `ALTER TABLE ENABLE ROW LEVEL SECURITY`
5. `CREATE POLICY` for anonymous and authenticated access
6. `GRANT` on table and sequence to `web_anon` and `authenticated`
7. `INSERT INTO metadata.entities` for display configuration
8. `INSERT INTO metadata.permissions` for RBAC rows
9. `NOTIFY pgrst, 'reload schema'`
10. `SELECT create_schema_decision(...)` for ADR

Missing any step produces a broken entity — no RLS means data leaks, no FK indexes
means slow inverse relationship queries, no metadata means default display names.

### Other Missing Operations

| Operation | Complexity | Why It's Missing |
|-----------|-----------|-----------------|
| `add_column` | Medium | Needs type mapping, optional FK detection, index creation, metadata INSERT |
| `add_validation` | Low | Template is simple but developers forget `metadata.constraint_messages` |
| `add_fk_relationship` | Medium | Needs FK constraint + index + metadata `join_table`/`join_column` config |
| `add_m2m_relationship` | High | Junction table with composite PK + dual FK indexes + grants + RLS |
| `configure_text_search` | Medium | Needs generated `tsvector` column + GIN index + `search_fields` metadata |
| `add_status_column` | Medium | FK to statuses + `enable_entity_statuses()` equivalent workflow |

## Architecture Decision: Migration-First SDK

Three approaches were evaluated:

### Comparison

| Dimension | Pure RPC | Migration-First SDK | Pure TypeScript Codegen |
|-----------|----------|-------------------|----------------------|
| **JWT dependency** | Requires authenticated session | None — produces standalone SQL | None |
| **Atomicity** | Each RPC is a separate transaction | Single transaction wraps entire migration | Depends on runner |
| **Reviewability** | Opaque — must trust RPC internals | Full SQL visible before apply | Full SQL visible |
| **Revertability** | No built-in revert | Generates matched deploy/revert scripts | Possible but manual |
| **Portability** | Requires running Civic OS instance | SQL files work with any PG client | Requires Node.js runtime |
| **Testability** | Needs live database with auth | SQL can be dry-run in any test PG | Needs build step |
| **Sqitch compatibility** | N/A — RPCs are runtime calls | Direct output as Sqitch deploy/revert/verify | Needs adapter |

### Decision

**Migration-First SDK**: The SDK generates complete SQL migration scripts (deploy + revert),
not RPC calls. Each operation produces SQL that can be reviewed in full, applied as a single
transaction, and reverted cleanly. This aligns with the existing Sqitch migration workflow
documented in `postgres/migrations/README.md`.

Existing RPCs like `upsert_entity_metadata()` and `set_role_permission()` serve as reference
implementations — their logic is encoded into the SDK's SQL templates rather than called at
runtime. This eliminates the JWT dependency and makes generated migrations portable.

## Interface Design

The SDK exposes a fluent TypeScript API that builds a migration as an ordered sequence of
operations, then serializes to SQL:

```typescript
const migration = schema.newMigration('add-invoices-entity');

migration.createEntity({
  name: 'invoices',
  displayName: 'Invoice',
  columns: [
    { name: 'vendor_name', type: 'text_short' },
    { name: 'amount', type: 'money' },
    { name: 'due_date', type: 'date' },
  ],
  access: 'authenticated',
});

migration.addValidation('invoices', 'amount', {
  type: 'min', value: 0.01
});

const sql = migration.toSQL();       // deploy script
const revert = migration.toRevertSQL(); // revert script
```

Key design constraints:
- Column `type` uses `EntityPropertyType` names, not raw PG types — the SDK maps to correct PG types and domains
- `access: 'authenticated' | 'public'` controls grant and RLS template selection
- Required columns (`id`, `created_at`, `updated_at`, `display_name`) are always included — callers do not specify them
- FK columns are detected by type and automatically get indexes
- Every migration automatically appends `NOTIFY pgrst` and `create_schema_decision()`

## Output Format

The SDK produces the same labeled block format used by the LLM Schema Assistant, enabling
shared tooling for review, safety validation, and apply workflows:

```
-- [STATUS] Status type values (if applicable)         (order: 1)
-- [CATEGORY] Category values (if applicable)          (order: 2)
-- [DDL] Table and column definitions                  (order: 3)
-- [INDEXES] FK and search indexes                     (order: 4)
-- [FUNCTIONS] Custom RPCs (if applicable)             (order: 5)
-- [TRIGGERS] updated_at and custom triggers           (order: 6)
-- [METADATA] Entity and property metadata INSERTs     (order: 7)
-- [VALIDATIONS] Validation rules and constraint messages (order: 8)
-- [GRANTS] Permission grants to database roles        (order: 9)
-- [RLS] Row level security policies                   (order: 10)
-- [PERMISSIONS] RBAC permission rows                  (order: 11)
-- [NOTIFY] PostgREST schema cache reload              (order: 12)
-- [ADR] Schema decision record                        (order: 13)
```

The safety validator from `tools/schema-assistant/src/safety/` works unchanged on SDK
output because the format is identical.

## Relationship to LLM Assistant

With the SDK in place, the LLM's role fundamentally changes:

| Before (v0.42.0) | After (SDK) |
|---|---|
| LLM generates raw SQL | LLM extracts structured parameters |
| 12+ convention rules to follow | SDK enforces conventions automatically |
| Scores 66-87/100 | SDK output scores 100/100 by construction |
| Human reviews SQL correctness | Human reviews intent correctness |
| Complex tasks produce blockers | Complex tasks decompose into SDK calls |

**Workflow**: User describes intent in natural language. LLM extracts structured parameters
(entity name, columns with types, access level, validations). SDK generates guaranteed-correct
SQL. Human reviews that the parameters match intent — not that the SQL is correct.

For the 8 freeform operations (virtual entities, custom RPCs, complex RLS), the LLM
continues to generate SQL directly. The safety validator and human review remain the
quality gates for those cases.

## JWT Dependency Audit

Several existing RPCs require JWT context (`current_user_id()`) which prevents use in
migration scripts. The SDK avoids this by encoding the logic directly in SQL templates,
but the audit is relevant for understanding which RPCs could be called from migrations
if needed.

| Function | JWT Required | Resolution |
|----------|:---:|---|
| `upsert_entity_metadata()` | Yes | SDK encodes as direct `INSERT INTO metadata.entities` |
| `set_role_permission()` | Yes | SDK encodes as direct `INSERT INTO metadata.permission_roles` |
| `enable_entity_notes()` | Yes | SDK encodes equivalent INSERTs for permissions + metadata |
| `add_status_transition()` | No | Could be called directly; SDK uses INSERT for consistency |
| `add_property_change_trigger()` | No | Could be called directly; SDK uses INSERT for consistency |
| `create_schema_decision()` | Yes | SDK uses direct INSERT with placeholder for `created_by` |
| `get_role_id()` | No | SDK calls directly in generated SQL for role lookups |
| `auto_register_function()` | No | SDK calls directly in generated SQL |

**Near-term**: For operations that need `current_user_id()`, the SDK generates SQL with
a session variable set at the top of the migration (`SET local jwt.claims.sub = '...'`),
allowing service account execution.

**Long-term**: Refactor JWT-dependent RPCs to accept an optional `p_user_id` parameter
that falls back to `current_user_id()` when NULL, following the `SECURITY INVOKER` pattern.

## Phase Plan

### Phase 1: Core SDK + CLI Integration

**Scope**: `createEntity`, `addColumn`, `addValidation`, `removeColumn`, `configureEntityMetadata`, `configurePropertyMetadata`

- TypeScript SDK package in `tools/schema-sdk/`
- CLI wrapper: `civic-os-schema create-entity --name invoices --columns "vendor:text_short, amount:money"`
- Integration with existing safety validator from `tools/schema-assistant/src/safety/`
- Sqitch deploy/revert/verify script generation
- Unit tests with snapshot assertions on generated SQL

### Phase 2: Relationships + Search + Workflow Types

**Scope**: `addFKRelationship`, `addM2MRelationship`, `configureTextSearch`, `addStatusColumn`, `addCategoryColumn`, `enableEntityNotes`

- FK relationship creates constraint + index + metadata `join_table`/`join_column`
- M2M generates junction table with composite PK, dual FK indexes, grants, RLS
- Text search generates `tsvector` column, GIN index, and `search_fields` metadata
- Status/category wrappers generate FK column + metadata inserts for values

### Phase 3: MCP Server + Angular Schema Builder UI

**Scope**: MCP tool server exposing SDK operations, Angular admin page for visual schema building

- MCP server wraps SDK operations as tools for Claude Code and other MCP clients
- Angular Schema Builder page at `/admin/schema-builder` with form-based entity creation
- Live preview of generated SQL before apply
- Integration with Safe Change Pipeline from `docs/notes/LLM_SCHEMA_ASSISTANT_DESIGN.md` (Phase 3)

## Not in Scope (Remains Freeform SQL)

These operations require custom logic that cannot be parameterized into templates:

| Operation | Why Freeform |
|-----------|-------------|
| Virtual entities (VIEWs + INSTEAD OF triggers) | Trigger logic is application-specific |
| Custom RPCs | Business logic by definition |
| Complex RLS policies | Row-level predicates depend on data model relationships |
| Payment integration | Stripe webhook handling requires custom RPC logic |
| Custom computed fields | SQL expressions are unbounded |
| Notification trigger functions | Event detection logic varies per entity |
| RRULE expansion customization | Scheduling rules are domain-specific |
| Custom dashboard widget queries | Filter predicates depend on data model |

For these operations, the LLM Schema Assistant (or manual SQL) remains the appropriate
tool, with the safety validator and human review as quality gates.

## References

- `docs/notes/LLM_SCHEMA_ASSISTANT_DESIGN.md` — LLM Schema Assistant architecture, eval harness, safety validator
- `tools/schema-assistant/` — Current LLM-based schema generation implementation
- `docs/INTEGRATOR_GUIDE.md` — Complete metadata configuration reference
- `postgres/migrations/README.md` — Sqitch migration workflow documentation
- `docs/notes/SOFT_DELETE_DESIGN.md` — Example of `enable_*()` pattern (reference for SDK wrappers)
