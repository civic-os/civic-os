# Declarative Schema Management Research

**Date**: March 2026
**Status**: Research complete. Revisit at v1.0 milestone.
**Context**: Evaluating alternatives to Sqitch for managing the Civic OS core database schema.

## Problem Statement

Civic OS uses Sqitch for imperative database migrations. As of v0.41.0, there are **61 migration files** spanning versions v0.4.0 through v0.41.0. The core frustration is **discoverability**: finding the current state of a database object (e.g., `metadata.entities`) requires tracing through every migration that ever touched it. There is no single "source of truth" file that shows what the table looks like today.

Secondary pain points:
- **Cognitive overhead**: Each new migration must be authored by hand with deploy/revert/verify scripts.
- **Drift risk**: The revert scripts can fall out of sync with deploy scripts over time.
- **Onboarding**: New contributors must understand the migration chain to reason about the schema.

## Tool Landscape

### Declarative ("Desired State") Tools

| Tool | Approach | PostgreSQL-Specific | License | Maturity |
|------|----------|-------------------|---------|----------|
| **pgschema** (pgplex) | Terraform-style dump/plan/apply | Yes — RLS, domains, partitioning, GIN/GIST indexes, column grants | Apache 2.0 | New (2025), sponsored by Bytebase |
| **Atlas** (Ariga) | HCL or SQL schema, plan/apply | Multi-database, but handles PG-specific objects | Dual: Apache 2.0 (community) / Commercial (Pro) | Mature, v1.0 released Dec 2025 |
| **pg-schema-diff** (Stripe) | Go library, diff/apply | Yes — Postgres-only, built for Stripe's needs | MIT | Active, used in production at Stripe |

### Imperative ("Migration File") Tools

| Tool | Approach | Notes |
|------|----------|-------|
| **Sqitch** (current) | Explicit dependency DAG, deploy/revert/verify | Perl-based, very mature, Postgres-native |
| **Flyway** | Numbered migration files | Java-based, generic, no PG-specific features |
| **Liquibase** | XML/YAML/SQL changesets | Enterprise-focused, verbose |
| **pgroll** (Xata) | Zero-downtime migrations with expand/contract | Interesting but opinionated: auto-creates shadow columns, manages backfill. Adds complexity. |

### Diff/Compare Tools

| Tool | Approach | Notes |
|------|----------|-------|
| **migra** | Python library, schema diff | Unmaintained (archived). Was excellent for one-off comparisons. |
| **pg_dump --schema-only** | Manual diff via pg_dump output | DIY approach, no tooling around it |

## Deep Dive: pgschema

pgschema is the closest PostgreSQL equivalent to SQL Server's DACPAC/SSDT workflow. It was selected for deep evaluation because it is Postgres-only (handling PG-specific objects that generic tools skip) and uses plain SQL files (no HCL, no custom DSL).

### How It Works

1. **Dump**: `pgschema dump --schema metadata --db civic_os > schema.sql` — exports the current database schema as readable SQL.
2. **Edit**: Modify the SQL file(s) to represent the desired end-state.
3. **Plan**: `pgschema plan --schema metadata --file schema.sql` — generates a diff (human-readable, JSON, or raw SQL).
4. **Apply**: `pgschema apply --plan plan.json` — executes the migration with fingerprint validation and transaction safety.

### Supported Objects

pgschema handles virtually all PostgreSQL schema objects relevant to Civic OS:

- **Tables**: Full DDL including partitioning (RANGE/LIST/HASH), identity/generated columns, LIKE clauses
- **Constraints**: PK, FK, UNIQUE, CHECK (including complex expressions), NOT VALID + deferred validation
- **Indexes**: All methods (btree, hash, GiST, SP-GiST, GIN, BRIN), partial, functional/expression, CONCURRENTLY creation
- **Views**: Regular and materialized, including `security_invoker`
- **Functions/Procedures**: PL/pgSQL bodies (treated as opaque text), IN/OUT/INOUT params, SECURITY DEFINER, volatility
- **Triggers**: BEFORE/AFTER/INSTEAD OF, all events, ROW/STATEMENT, WHEN conditions, constraint triggers
- **RLS Policies**: PERMISSIVE/RESTRICTIVE, all commands, USING/WITH CHECK
- **Domains**: Custom domains with CHECK constraints (e.g., `hex_color`, `email_address`)
- **Custom Types**: ENUM and composite types
- **Grants**: Table, column, sequence, function, type, WITH GRANT OPTION
- **Default Privileges**: ALTER DEFAULT PRIVILEGES
- **Comments**: COMMENT ON TABLE/COLUMN/FUNCTION/etc.
- **Sequences**: With all configuration options

### Unsupported Objects (by design)

pgschema operates at the **schema level**, not the cluster level:

- **Roles**: CREATE ROLE, ALTER ROLE — must be managed externally
- **Extensions**: CREATE EXTENSION (PostGIS, pgcrypto) — managed by infrastructure
- **Databases**: CREATE DATABASE
- **Tablespaces**: Cluster-level configuration
- **Schemas themselves**: CREATE SCHEMA — pgschema assumes the target schema exists

### File Organization

pgschema supports both single-file and multi-file organization:

**Multi-file** (recommended for Civic OS):
```
postgres/schema/
├── metadata/
│   ├── main.sql          # Entry point with \i includes
│   ├── tables/
│   │   ├── entities.sql
│   │   ├── properties.sql
│   │   └── ...
│   ├── functions/
│   └── policies/
├── public/
│   ├── main.sql
│   ├── views/
│   ├── functions/
│   └── domains/
└── seed/
    └── defaults.sql      # INSERT for roles, permissions, etc.
```

Files use PostgreSQL's native `\i` include directive — no tool-specific config needed.

### Key Features

- **Fingerprint validation**: Detects if the database schema changed between plan and apply (prevents stale migrations in CI/CD).
- **Online DDL**: Automatically generates `CREATE INDEX CONCURRENTLY`, `NOT VALID` constraint patterns.
- **Dependency resolution**: Topological sorting ensures correct execution order regardless of file organization.
- **`.pgschemaignore`**: Wildcard exclusion patterns for gradual adoption (ignore application tables in public schema).
- **No migration history table**: No `sqitch.changes`-equivalent to maintain.
- **Embedded Postgres**: Validates schema internally without requiring a shadow database.

### CI/CD Integration

pgschema provides a GitHub Actions example (`pgplex/pgschema-github-actions-example`) demonstrating a plan-review-apply pattern:
1. **On PR**: Run `pgschema plan`, post diff as PR comment, store `plan.json` as artifact.
2. **Human review**: Reviewer inspects the generated DDL.
3. **On merge**: Run `pgschema apply --plan plan.json --auto-approve`.

## Civic OS Compatibility Audit

### What Works Declaratively (majority of migrations)

The vast majority of the 61 Sqitch migrations consist of structural DDL that pgschema handles natively:

- All `CREATE TABLE` / `ALTER TABLE` statements in `metadata.*`
- All views (`schema_entities`, `schema_properties`, `civic_os_users`, etc.)
- All functions (`current_user_id()`, `has_permission()`, `set_updated_at()`, etc.)
- All RLS policies
- All grants to `web_anon` and `authenticated` roles
- All custom domains (`hex_color`, `email_address`, `phone_number`, `time_slot`)
- All triggers and indexes
- All comments on objects
- Cross-schema references (functions in `public` referencing `metadata.*` tables)

PL/pgSQL function bodies are opaque text to pgschema — they are compared as strings. This means complex function bodies with `EXECUTE format()`, River queue INSERTs, and `pg_catalog` queries all work fine.

### What Does NOT Work Declaratively

Patterns found across the 61 migrations that require imperative handling:

**1. Seed Data INSERTs (found in ~15 migrations)**

Default roles, permissions, permission_roles, widget_types, and other bootstrap data are inserted during migrations:
- `v0-4-0-baseline`: Initial roles, permissions, permission_roles
- `v0-5-0-add-file-storage`: File-related permissions
- `v0-10-0-add-river-queue`: River queue tables (though these are infrastructure)
- `v0-12-0-add-map-widget-type`: Widget type registry entries
- `v0-15-0-add-status-type`: Status-related permissions
- `v0-31-0-user-provisioning`: User management permissions
- `v0-40-0-status-category-admin-rpcs`: Loops granting all metadata permissions to admin

**2. NOTIFY pgrst Statements (found in nearly every migration)**

PostgREST cache reload: `NOTIFY pgrst, 'reload schema'`. This is an imperative side-effect that must happen after schema changes but cannot be expressed declaratively.

**3. Cluster-Level Objects**

- `CREATE SCHEMA IF NOT EXISTS metadata/postgis` — found in baseline
- `CREATE EXTENSION IF NOT EXISTS postgis/pgcrypto` — found in baseline and file storage
- `CREATE ROLE` — handled externally by init scripts, not in migrations

**4. DO Blocks with Data Manipulation**

`v0-40-0` contains a `DO` block that loops through `metadata.permissions` to auto-grant admin access to all metadata table permissions. This is imperative logic that reads data to generate more data.

**5. Conditional DDL**

Some migrations use `IF NOT EXISTS` or `DO $$ IF NOT EXISTS` patterns for idempotency. With pgschema, these are unnecessary — the tool only generates DDL for objects that differ from desired state.

### Two-Schema Challenge and Public Schema Safety

Civic OS spans two PostgreSQL schemas:
- **`metadata`**: ~30 tables, functions, policies — fully managed by core migrations
- **`payments`**: Transaction tables — fully managed by core migrations
- **`public`**: ~15 views, ~40+ functions, 4 domains, triggers — BUT **also contains application tables at runtime** (e.g., `issues`, `tags`, `resources`, etc.)

This is the critical safety concern: **`metadata` and `payments` are safe to manage destructively** (if an object isn't in the schema files, dropping it means we intentionally removed it). But **`public` contains integrator-created application tables** that must never be touched.

pgschema targets one schema per run. The safety mechanisms:

**1. `.pgschemaignore` file** — pgschema supports wildcard exclusion patterns. For the public schema, this would be configured to ignore all objects not explicitly managed:
```
# .pgschemaignore for public schema
# Only manage core Civic OS objects, ignore everything else
```

However, this approach is **allowlist vs. denylist**. The risk depends on pgschema's behavior when it encounters objects in the live database that aren't in the schema files:
- **If it ignores unknown objects**: Safe. Application tables are invisible to pgschema.
- **If it proposes to DROP unknown objects**: Dangerous. Application tables would be candidates for deletion.

**2. pgschema's actual behavior** — Based on documentation, pgschema's `dump` command captures all objects in a schema. The `plan` command diffs the schema files against the live database. Objects present in the database but **absent from schema files** would appear as candidates for DROP in the plan. This is the correct behavior for `metadata` (if we removed a table from schema files, we want it dropped) but **deadly for `public`** where application tables exist that were never in the schema files.

**3. Recommended mitigation strategies**:

- **Option A: Explicit ignore list** — Maintain a `.pgschemaignore` that lists every known application table pattern. Fragile: new tables added by integrators would need manual addition.
- **Option B: Separate namespace for core public objects** — Move core views/functions/domains to a dedicated schema (e.g., `civic_os_core`). Application tables remain in `public`. This is a significant refactor but eliminates the co-tenancy problem entirely.
- **Option C: pgschema `--no-drop` flag** — If pgschema supports a mode that only adds/modifies but never drops, this would be safe. As of March 2026, this flag does not exist, but could be requested as a feature.
- **Option D: Plan review as safety gate** — Always generate a plan, review it (manually or in CI), and only apply after confirming no application objects are targeted. This is the pragmatic approach — the CI/CD workflow already includes a review step.

**Recommended approach**: Combine **Option A** (`.pgschemaignore`) with **Option D** (mandatory plan review). For `metadata` and `payments`, the plan can be auto-approved since all objects are managed. For `public`, the plan MUST be human-reviewed before apply.

Long-term, **Option B** (dedicated `civic_os_core` schema) would be the cleanest solution but is out of scope for initial adoption.

## Pros and Cons

### Pros

| Benefit | Impact |
|---------|--------|
| **Single source of truth** | Each object has exactly one file. Finding the current `metadata.entities` table definition is trivial. |
| **No migration authoring** | Schema changes = editing SQL files. No deploy/revert/verify boilerplate. |
| **Automatic diffing** | Tool calculates the minimal DDL needed. No risk of forgetting a step. |
| **Reduced merge conflicts** | Changes to different objects are in different files. No sequential numbering. |
| **Safety features** | Fingerprint validation, online DDL patterns, transaction rollback. |
| **IDE-friendly** | Plain SQL files support go-to-definition, syntax highlighting, linting. |
| **CI/CD native** | Plan-as-PR-comment workflow gives reviewers visibility into exact DDL. |

### Cons

| Drawback | Impact |
|----------|--------|
| **No data migration support** | Seed data, backfills, and data transformations need separate scripts. |
| **New tool dependency** | Team must learn pgschema CLI. Written in Go, relatively new project. |
| **Two-run complexity** | Must run separately for `metadata` and `public` schemas. |
| **Public schema co-tenancy risk** | Application tables live alongside core objects in `public`. Requires `.pgschemaignore` + mandatory plan review to prevent accidental drops. `metadata` and `payments` are safe for destructive management. |
| **Breaking changes need expand-contract** | Column renames, type changes, splits require manual coordination between structural changes and data migration scripts. |
| **Cluster objects external** | Roles, extensions, schemas still need separate management. |
| **Young project risk** | pgschema launched in 2025. Community is small. No guarantee of long-term maintenance (mitigated by Apache 2.0 license and Bytebase sponsorship). |
| **Sqitch migration history lost** | Existing `sqitch.changes` audit trail would no longer be actively extended. |

## Recommended Adoption Approach

### Strategy: Hard Cutover at Version Boundary

Rather than running Sqitch and pgschema in parallel, perform a clean cutover:

1. **Choose a version milestone** (recommended: v1.0) where the schema is relatively stable.
2. **Dump current state** using `pgschema dump` as the baseline for both `metadata` and `public` schemas.
3. **Organize into multi-file structure** under `postgres/schema/`.
4. **Extract seed data** into `postgres/schema/seed/defaults.sql` — a standalone SQL file with all INSERT statements for bootstrap data.
5. **Create a bootstrap script** that:
   - Creates schemas and extensions
   - Runs `pgschema apply` for metadata and public
   - Runs seed data script
   - Runs `NOTIFY pgrst, 'reload schema'`
6. **Archive Sqitch directory** — keep `postgres/migrations/` read-only for historical reference and for existing deployments that haven't upgraded.

### Handling Data Migrations (Expand-Contract Pattern)

For breaking schema changes after adoption (column renames, type changes, splits):

1. **Expand**: Add new columns/objects in the schema files. Run `pgschema apply`.
2. **Transform**: Run a standalone SQL script to backfill/migrate data.
3. **Contract**: Remove old columns/objects from the schema files. Run `pgschema apply`.

This is the same expand-contract pattern used by pgroll and Atlas, just with manual scripting for step 2. These data migration scripts would live in a `postgres/data-migrations/` directory with timestamp-based naming.

### Handling Existing Production Deployments

Existing databases deployed via Sqitch need a transition path:

1. **Final Sqitch migration**: Create one last Sqitch migration (e.g., `v1-0-0-transition-to-pgschema`) that marks the handoff. This migration is a no-op structurally but documents the transition.
2. **pgschema takes over**: All subsequent changes use pgschema. Since pgschema diffs against live database state (not migration history), it works regardless of how the database got to its current state.
3. **Sqitch metadata cleanup**: Optionally drop `sqitch.*` schema from production after confirming pgschema manages everything correctly.

### Post-Deployment Hook for PostgREST

Since `NOTIFY pgrst` can't be expressed declaratively, add it as a post-apply step. Note the different safety levels per schema:

```bash
#!/bin/bash
# deploy.sh

# metadata and payments: safe to auto-approve (all objects are core-managed)
pgschema apply --schema metadata --plan plan-metadata.json --auto-approve
pgschema apply --schema payments --plan plan-payments.json --auto-approve

# public: MUST review plan first (application tables live here)
pgschema plan --schema public --file postgres/schema/public/main.sql --output-human
# Human reviews plan output, then:
pgschema apply --schema public --plan plan-public.json --auto-approve

psql -c "NOTIFY pgrst, 'reload schema'"
```

## When to Revisit

**Trigger**: v1.0 milestone, when:
- Schema churn has slowed (fewer new tables/columns per release)
- At least one production deployment is stable
- The team is ready for a tooling change

**Pre-requisites before adoption**:
- [ ] Test pgschema dump/plan/apply against a real Civic OS database
- [ ] Verify `.pgschemaignore` correctly excludes application tables
- [ ] Validate that all 40+ functions survive round-trip dump/edit/plan
- [ ] Design the seed data strategy (idempotent INSERTs vs. separate bootstrap)
- [ ] Update CI/CD pipelines (GitHub Actions, Docker migration container)
- [ ] Write developer workflow documentation

## Alternative: Atlas

If pgschema's youth is a concern, **Atlas** is the mature alternative:
- v1.0 released December 2025, backed by Ariga (VC-funded)
- Supports HCL or SQL schema definitions
- Has built-in data migration support (pre/post-deploy hooks)
- 50+ built-in linters for safe migration analysis
- Kubernetes operator, Terraform provider, GitHub Actions
- Handles roles and extensions (pgschema doesn't)
- Drawback: commercial features gated behind paid plan, HCL adds a learning curve

Atlas would be the fallback if pgschema proves insufficient or is abandoned.

## References

- pgschema: https://github.com/pgplex/pgschema | https://www.pgschema.com/
- Atlas: https://github.com/ariga/atlas | https://atlasgo.io/
- pg-schema-diff (Stripe): https://github.com/stripe/pg-schema-diff
- pgroll (Xata): https://github.com/xataio/pgroll
- Bytebase comparison: https://www.bytebase.com/blog/top-open-source-postgres-migration-tools/
