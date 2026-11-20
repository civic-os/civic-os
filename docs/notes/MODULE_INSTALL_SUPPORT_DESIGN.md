# Module Install Support Design

**Status**: Built (issue #135): steps 1 and 2 in v0.84.0, step 3 in v0.85.0 (see Phasing).
**Date**: 2026-11-05
**Audience**: Civic OS contributors building the module registry and the Woven module line; integrators who script changes to an instance.

## Summary

Instance content such as a module's tables, seed rows and registrations is installed by scripts that deployment automation runs against a live instance, never by core migrations (`postgres/migrations/README.md`, "Instance-Specific Data Is Off-Limits"). Organizations change their instances freely after an install, so a later script cannot assume the schema it was written against. This note designs two core features those scripts need:

| Feature | What it gives a script | Shape |
|---|---|---|
| Interface comparison | A check, before any change, that the tables, columns, dimensions, modules and functions it depends on still exist with the types it expects | `compare_interface(jsonb)` returns the differences; `assert_interface(jsonb)` stops the script on any error |
| Domain version and schema decisions without a JWT | A way to record a schema decision and raise the domain version from a script that runs as the deployment role | `set_domain_version()`, `create_schema_decision()` and the registry RPCs accept the deployment role through `metadata._is_db_admin()`; new `bump_domain_version()` |

**Why a separate note.** Both features are general tools for any script that changes an instance, not reporting features. `docs/notes/IMPACT_REPORTING_DESIGN.md` (Module registry) proposes the smallest module registry reporting needs and leaves the rest of a module system to a later design; this note is that design's first part. The module registry itself stays specified in the Impact Reporting note, and this note builds on it.

## Context

An install script, as the Woven module templates define it:

- runs as one transaction, so it either completes or leaves nothing behind;
- checks the instance's core version first (`metadata.framework_version()`, v0.77.0);
- checks every element it depends on against the live schema, and stops before any change if one is missing or different;
- creates shared tables only when absent, seeds defaults, registers dimensions and measures;
- records a schema decision, raises the domain version by one minor version linked to that decision, and registers its module last;
- connects as the **deployment role**: the login role that runs core migrations (`postgres` on a self-hosted instance, `doadmin` or `rds_admin` on a managed database). It has no JWT.

What core has today:

| Piece | State | Gap for install scripts |
|---|---|---|
| `metadata.framework_version()` | Built, v0.77.0 | None |
| Domain Version (`set_domain_version()`) | Built, v0.77.0 | Guarded by `is_admin()`, which reads the JWT: a script without one is refused |
| `create_schema_decision()` | Built, v0.30.0 | Same `is_admin()` guard; scripts fall back to a direct `INSERT` that skips its validation |
| `metadata._is_db_admin()` | Built, v0.56.1 (`session_user` fix in v0.76.5) | None. Accepts an admin JWT, a superuser, or a login role with `CREATEROLE`; about twenty framework functions already use it so psql sessions can call them |
| Module registry (`register_module()`, `module_installed()`) | Designed in the Impact Reporting note; not built | Designed as admin only, so the same guard question applies |
| Dimensions registry (`register_dimension()`) | Designed in the Impact Reporting note; not built | Same |
| Comparing a declared schema with the live one | Nothing | All of feature 1 |

## 1. Interface comparison

### Functions

```sql
CREATE FUNCTION public.compare_interface(p_declared JSONB)
RETURNS TABLE (
    template     TEXT,  -- the label the caller passed, echoed for messages
    source       TEXT,  -- the element's source label, if given
    element      TEXT,  -- 'table' | 'dimension' | 'module' | 'rpc'
    name         TEXT,  -- schema-qualified table or function, dimension key, module key
    column_name  TEXT,  -- for column differences; NULL otherwise
    difference   TEXT,  -- a code from the table below
    severity     TEXT,  -- 'error' | 'info'
    expected     TEXT,
    actual       TEXT
)
LANGUAGE plpgsql STABLE SECURITY INVOKER;

CREATE FUNCTION public.assert_interface(p_declared JSONB) RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY INVOKER;
```

`compare_interface()` returns one row per difference, ordered by element, name and column, and no rows when the instance matches. `assert_interface()` calls it, prints each `info` row as a `NOTICE`, and, if any row is an `error`, raises one exception with SQLSTATE `55000` (`object_not_in_prerequisite_state`). The message gives the template and the number of errors, and the `DETAIL` has one line per error:

```
ERROR:  interface check failed for people_served@1.1.0: 1 difference
DETAIL: public.programs.external_id: type integer, required text (required by shared/program)
```

An install script calls `assert_interface()` as its first statement after the core version check. Nothing has changed yet, so the exception rolls back an empty transaction.

A malformed declaration (unknown `element`, a missing `name`, a type string `to_regtype()` cannot resolve) is a bug in the script, not a difference in the instance: both functions raise `22023` at once.

### Input format

Module templates declare interface elements as `yaml` blocks in their specs. Postgres has no YAML parser, and the declarations are fixed when a template is built, so the template tooling converts them to JSON and the script embeds the JSON as a literal. Core receives elements that are already fully resolved: a template's list of required elements is expanded into complete element shapes before it reaches core.

**A declaration is what the script uses, not what the other template publishes.** A published interface may list a table's five columns; a script that reads only `id` and `parent_id` declares only those two. Every property given is checked and every property left out is not. This keeps the check from failing on changes that do not affect the script: an organization that drops a column this script never reads, or makes a column required that it only reads, installs without a difference.

```json
{
  "template": "people_served@1.1.0",
  "elements": [
    { "element": "table", "name": "public.programs", "source": "shared/program",
      "columns": [
        { "name": "id",        "type": "bigint" },
        { "name": "parent_id", "type": "bigint", "nullable": true, "references": "public.programs.id" }
      ] },
    { "element": "dimension", "key": "program", "table": "public.programs", "source": "shared/program",
      "columns": { "key": "id", "parent": "parent_id" } },
    { "element": "module", "key": "people_served", "version": "1.2" },
    { "element": "rpc", "name": "public.dimension_subtree", "args": ["text", "bigint"], "returns": "setof bigint" }
  ]
}
```

| Element | Always checked | Checked only when given | Compared with |
|---|---|---|---|
| `table` | `name` (schema-qualified) exists and is a table; each listed column exists | per column: `type`, `nullable`, `references` (`schema.table.column`); `writes: true` on the table (see below) | `pg_class`, `pg_attribute`, `pg_constraint`, `pg_attrdef` |
| `dimension` | `key` is registered | `table`; each listed column role (`key`, `label`, `parent`, `active`, `external_id`; `sort` since v0.86.0) | `metadata.dimensions` and the live table |
| `module` | `key` is installed | `version` (`MAJOR.MINOR`) | `metadata.modules` |
| `rpc` | `name` with `args[]` (types in order) resolves | `returns` | `to_regprocedure()`, `pg_get_function_result()` |

A table element with an empty `columns` list checks only that the table exists. `template` and `source` are free labels used only in messages. Element kinds are generic: core never sees a module name except as data.

There is no element for core features. A script checks the core version with `metadata.framework_version()`. A script that needs a specific core function can declare it as an `rpc` element, which checks that the function exists, not just that the version number is high enough.

### What is compared

**Table.** The relation must exist and be a table (`relkind` `r` or `p`). A view with the same name is `kind_mismatch`: it cannot carry the FKs that make a column a reporting axis. For each declared column: it exists; when `type` is given, the type is compatible (rules below); when `nullable` is given, the nullability is compatible; and when `references` is given, a foreign key constraint on that single column points at that table and column. The constraint name and `ON DELETE` action are never compared. Columns the declaration does not list are never looked at: they belong to the organization, or to another dependent's declaration.

A missing FK is an `error` even when the column and its values are intact. The dimensions registry derives reporting axes from FKs, so a dropped constraint silently changes which reports cut by that column.

**Tables the script writes.** *Decided 2026-11-06.* The rules above protect readers, but install scripts also insert: they seed defaults into shared tables such as `programs`. Undeclared columns are never inspected, so an organization that added a `NOT NULL` column without a default would pass the check and then fail at the seed `INSERT`, after other changes, with a raw error. The transaction still rolls back, but the promise to stop before any change no longer holds. A table element with `writes: true` therefore also checks every column the declaration does not list: each must be nullable, have a default, be an identity or generated column, or the element reports `missing_default` (error) naming it. Declared columns written by the script are listed as usual; `nullable → NOT NULL` on a column the script inserts without a value is the script's own bug, caught by declaring the column.

**Dimension.** The registry has a row for `key`; when given, its table is `table`; each declared column role names the same column as the registry and that column exists in the table. Undeclared roles are not compared. A registry row that still names a renamed or dropped column is reported here, which is how stale registry entries come to light. When `metadata.dimensions` does not exist (core older than the registry), every dimension element is `missing_core_feature`.

**Module.** `metadata.modules` has a row for `key`. With `version: "1.2"`, the installed version must have major 1 and minor 2 or higher: templates raise the major version whenever a published element is modified or removed. A missing module is an `error`. Report packs that skip quietly when a module is absent call `module_installed()` themselves before calling `assert_interface()`. When `metadata.modules` does not exist, the element is `missing_core_feature`.

**Rpc.** `to_regprocedure('<name>(<args>)')` resolves the exact signature; when `returns` is given, `pg_get_function_result()` must equal it after normalizing type names. Volatility, security mode and grants are not compared.

### Type compatibility

Declared types are written in SQL spelling and normalized with `to_regtype()` and `to_regtypemod()` (PostgreSQL 17, which core already runs), so `int8`, `bigint` and `BIGINT` are the same type and `varchar(50)` carries its length. Live types come from `pg_attribute.atttypid` and `atttypmod`.

**Rule.** Dependents mostly *read* another template's published columns: report packs, VIEWs and joins. A difference is accepted when every value the template wrote is still valid and a reader still gets the kind of value it expects. These are the changes an admin makes when values stop fitting. Accepted differences are returned with severity `info` (`widened`), so the script prints them without stopping. Anything else is an `error`.

| Declared → live | Severity | Why |
|---|---|---|
| Same type and modifier | (no row) | |
| `varchar(n)` → `varchar(m)` with m ≥ n, unbounded `varchar`, or `text` | info | Longer values fit; SQL readers have no fixed buffers |
| `numeric(p,s)` → `numeric(p',s')` with s' ≥ s and p'−s' ≥ p−s, or unconstrained `numeric` | info | Every declared value fits with its scale intact |
| `smallint` → `integer` → `bigint` | info | Every declared value fits; Woven tables are `bigint` already, so this arises only on columns an organization converted |
| nullable → `NOT NULL` | info (`now_required`) | Readers are unaffected; only a dependent that inserts without the column could fail, and dependents rarely write to another template's tables |
| `NOT NULL` → nullable | error | Readers may receive NULL they do not handle |
| Shorter length, less precision, `bigint` → `integer`, `text` → `varchar(n)` | error | Values the template wrote may not fit |
| `timestamp` ↔ `timestamptz` | error | Different meaning (wall-clock vs instant), not a width change |
| Base type ↔ domain (`text` ↔ `email_address`, `numeric` ↔ `money`), enum, array, `json` ↔ `jsonb`, any other change | error | A domain is a Civic OS property type with its own checks and UI; it matches only itself |

Widening is not transitive across kinds: `smallint` → `numeric` is an error. The list is deliberately short, and an addition is a design change to this note.

**Widening and re-created VIEWs.** A widening is safe for queries, but `CREATE OR REPLACE VIEW` refuses to change the type of an existing view column. A dependent that re-creates a VIEW projecting a widened column must `DROP VIEW` and `CREATE VIEW` (repeating `WITH (security_invoker = true)`, which a re-create resets) rather than replace it, or the `info` row is followed by a failure. Report packs re-create their VIEWs that way (`docs/notes/IMPACT_REPORTING_DESIGN.md`, Report packs).

### Difference codes

| Code | Element | Severity |
|---|---|---|
| `missing_table` | table | error |
| `kind_mismatch` | table | error |
| `missing_column` | table | error |
| `type_mismatch` | table, rpc (`returns`) | error |
| `widened` | table | info |
| `nullability_mismatch` | table | error |
| `now_required` | table | info |
| `missing_reference` | table | error |
| `reference_mismatch` | table (FK points elsewhere) | error |
| `missing_default` | table with `writes: true` (undeclared `NOT NULL` column without a default) | error |
| `missing_dimension` | dimension | error |
| `dimension_mismatch` | dimension (table or column role differs, or column absent) | error |
| `missing_module` | module | error |
| `module_version_mismatch` | module | error |
| `missing_rpc` | rpc | error |
| `missing_core_feature` | dimension, module | error |

### Introspection source

The function reads `pg_catalog` directly. `information_schema` is filtered by the caller's privileges, and `schema_properties` covers only `public` and adds Civic OS interpretation (property types) on top. Dimension tables may live outside `public` (`accounting.funding_sources`), and the comparison is about the schema, not the UI's reading of it.

### Security

Both functions write nothing and reveal only catalog facts and registry rows that authenticated users can already read through the metadata VIEWs. They are `SECURITY INVOKER`, `EXECUTE` is revoked from `PUBLIC` and granted to `authenticated`, and no in-body guard is needed. The grant lets other tools use the same check later: the MCP server or the schema editor could warn when an edit touches a declared element. That use is not designed here.

### Non-goals

- Repairing differences. The organization decides whether to restore an element or not install.
- Labels, permissions, translations, seed rows or UI metadata. These are never interface elements.
- Template upgrades (comparing template version N, version N+1 and the live instance). That is a separate design. This function answers only "does the instance still provide what the script needs?"
- Blocking organizations from changing declared elements. A difference is reported only when a later script requires the element.

## 2. Domain version and schema decisions without a JWT

### Problem

Every install that changes the schema records a schema decision ("People Served v1.1.0 module installed") and raises the domain version by one minor version, linked to that decision. `set_domain_version()` and `create_schema_decision()` both start with `IF NOT is_admin()`. `is_admin()` reads roles from the JWT, and a script connected as the deployment role has none, so both refuse. The workaround today is a direct `INSERT INTO metadata.schema_decisions`, and the same would work for `metadata.domain_version`: the deployment role is a superuser or the table owner, so it bypasses both the missing write grant and RLS. Both direct writes skip the validation that keeps a version tied to exactly one decision, which is what the functions exist to enforce.

The requirement to keep: no domain version without a schema decision that is linked to it and to no other version.

### Options

| Option | Verdict |
|---|---|
| **Guard with `metadata._is_db_admin()`** | **Recommended.** The existing answer to "admin, or the role that runs migrations?" Accepts an admin JWT, a superuser, or a login role with `CREATEROLE` (managed database admins). PostgREST connects as `authenticator`, which has neither, so API callers still need an admin JWT. About twenty framework functions use it already. |
| Dedicated `civic_os_deployer` role, guarded by `pg_has_role(session_user, ...)` | Fewer privileges, but it must be provisioned on every instance, managed databases included, and no core function follows the pattern. Possible later if instances get a separate install role; the guard function is the one place to change. |
| Script sets `request.jwt.claims` with an admin role before calling | Forges an identity, gives the decision no real author, and depends on `is_admin()` internals. Rejected. |
| Separate install-only function that writes both tables | A second writer of `metadata.domain_version` with its own copy of the checks. Rejected in favor of one writer with a wider guard. |

### Design

1. **Guard.** `set_domain_version()` and `create_schema_decision()` replace `IF NOT is_admin()` with `IF NOT metadata._is_db_admin()`. Behavior over the API does not change. `create_schema_decision()` keeps its validation; `author_id` is NULL when there is no JWT (`current_user_id()` returns NULL, and the column is nullable).
2. **One writer.** The body of `set_domain_version()` moves into an internal `metadata._set_domain_version(...)` with no guard and no `EXECUTE` grant. `set_domain_version()` and `bump_domain_version()` each check the guard and call it, so the decision checks (`23502` none given, `23503` not found, `23505` linked to another version) exist once.
3. **Bump helper.**

   ```sql
   CREATE FUNCTION public.bump_domain_version(
       p_part        TEXT,  -- 'major' | 'minor' | 'patch'
       p_migration   TEXT,  -- stored as set_by_migration, e.g. 'people_served@1.1.0'
       p_decision_id INT,
       p_min_client_domain_version TEXT DEFAULT NULL  -- NULL keeps the current floor
   ) RETURNS TEXT          -- the new domain version
   LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = metadata, public;
   ```

   It locks the single `metadata.domain_version` row (`FOR UPDATE`), drops pre-release and build metadata, raises the requested part, resets the lower parts (`1.3.0` + minor = `1.4.0`; `0.0.0` + minor = `0.1.0`; `1.4.0-rc.1` + minor = `1.5.0`), and calls the internal setter. The floor stays unchanged unless `p_min_client_domain_version` is given. A major bump that breaks clients generated for the previous version should pass the new version as the floor, or typed clients generated before it keep connecting. The row lock serializes concurrent installs, so two scripts cannot both read `1.3.0` and both write `1.4.0`. Guarded by `_is_db_admin()`; `EXECUTE` revoked from `PUBLIC` and granted to `authenticated`, like `set_domain_version()`.
4. **Grants for the deployment role.** The role that runs core migrations owns these functions, or is a superuser, so it can execute them without a grant. Install scripts connect as that same role. A deployment that runs scripts as a different login role grants it `EXECUTE` explicitly.

Install sequence (illustrative, inside the script's single transaction):

```sql
BEGIN;
SELECT public.assert_interface($json$ { "template": "people_served@1.1.0", "elements": [ ... ] } $json$::jsonb);
-- create or check tables, seed defaults, register dimensions and measures
SELECT public.bump_domain_version(
         'minor',
         'people_served@1.1.0',
         public.create_schema_decision(
           p_title        := 'People Served v1.1.0 module installed',
           p_decision     := '...',
           p_migration_id := 'people_served@1.1.0'));
SELECT public.register_module('people_served', 'People Served', '1.1.0');
COMMIT;
```

**Re-runs** are the script's responsibility. A script that finds itself already installed at the same version (through `module_installed()` and the registry's version) skips the decision and the bump. Core does not try to detect "nothing changed". Report packs follow the same rule through their own registry rows (`docs/notes/IMPACT_REPORTING_DESIGN.md`, Packs and the domain version), so applying every pack on every deployment does not raise the version each time.

**Security.** `_is_db_admin()` admits three kinds of session: a superuser, a login role with `CREATEROLE`, and an admin JWT over PostgREST (its first branch is `is_admin()`). For `set_domain_version()`, `create_schema_decision()` and `bump_domain_version()` the third adds nothing: those functions were already admin-only over the API. The decision requirement is unchanged: a version still cannot be set without an unlinked decision. The guard is not a general answer for functions that **generate DDL**: an application admin cannot otherwise run DDL, so such a function must limit what the admin path can reach (see section 3).

## 3. Registry RPCs use the same guard

Install scripts also call `register_dimension()`, `register_module()` and `register_report_measure()`, which the Impact Reporting design describes as admin-only. All three use `metadata._is_db_admin()` as their in-body guard, for the same reason and with the same API behavior. `module_installed()` stays callable by any role.

Two of them generate DDL as the function owner, so the admin JWT path is narrowed (*decided 2026-11-06*; specified in the Impact Reporting note's Permissions section):

- `register_report_measure()` writes `row_filter` SQL text into a VIEW. A non-NULL filter is accepted only from a session that has no JWT and that `_is_db_admin()` admits, checked by a new `metadata._is_deployer()` helper (superuser or `CREATEROLE`, no `is_admin()` branch). Otherwise an application admin could inject DDL that runs as the owner.
- `register_dimension()` installs triggers. Over the API it accepts only tables `schema_entities` lists or tables in framework-owned schemas, quotes identifiers with `%I`, and installs only the fixed delete and parent guards. *As built (v0.85.0):* over the API it accepts any base table in `public`, listed or not, and installs its fixed triggers (delete, parent-cycle and default-fill) only on tables in `public`.

## Decisions

| # | Decision | Alternative and trade-off |
|---|---|---|
| 1 | One JSONB argument of fully resolved elements; template tooling converts its YAML declarations | YAML text parsed in SQL: needs an extension or a hand-written parser, and couples core to one template format |
| 1a | Conservative check: a script declares only the columns and properties it uses, and only those are compared. **Decided 2026-11-05.** | Compare the publishing template's whole interface element: catches more drift, but fails installs on changes the script never touches |
| 2 | Report differences as rows; a separate `assert_interface()` raises | A single raising function: simpler, but tools that only want to show differences would have to catch exceptions |
| 3 | Read-safe widenings (length, precision, integer width, nullable → `NOT NULL`) pass as `info`; everything else is an error. **Decided 2026-11-05.** | Exact match only: never wrong for writers, but blocks installs on instances where an admin lengthened a field or made one required |
| 4 | Missing FK on a declared reference is an error | Accept the column without its FK: joins still work, but reporting axes come from FKs, so reports would change silently |
| 4a | `writes: true` on a table element also requires every undeclared column to accept an omitted value. **Decided 2026-11-06.** | Leave write failures to the `INSERT`: no extra rule, but the script fails after changes, with a raw error, instead of before any |
| 4b | Registry functions that generate DDL narrow the admin JWT path (`row_filter` only from deployer sessions; trigger installation only on listed tables). **Decided 2026-11-06.** | `_is_db_admin()` alone: simpler, but lets an application admin inject DDL that runs as the function owner |
| 5 | Scripts without a JWT are admitted by `metadata._is_db_admin()` on `set_domain_version()`, `create_schema_decision()` and the registry RPCs, plus a `bump_domain_version()` helper. **Decided 2026-11-05.** | A dedicated deployer role: fewer privileges, but provisioning on every instance and no precedent in core |
| 6 | Interface comparison and the install path live in this note, not the Impact Reporting note. **Decided 2026-11-05.** | Extend the Impact Reporting module registry section: one file, but a reporting note would own schema-contract and versioning features |

## Phasing

Both features belong to Impact Reporting Phase 1 and must exist before the first module's install script is written:

| Step | Scope | Depends on |
|---|---|---|
| 1 (v0.84.0) | `_is_db_admin()` guard on `set_domain_version()` and `create_schema_decision()`; `bump_domain_version()` | Domain Version (built) |
| 2 (v0.84.0) | `compare_interface()` and `assert_interface()` for `table` and `rpc` elements; `dimension` and `module` elements are validated and reported as `missing_core_feature` until step 3 | Nothing new |
| 3 (v0.85.0) | `dimension` and `module` elements | Dimensions and module registries (Impact Reporting Phase 1), which use the same guard from the start |

Documentation ships with the build per the documentation rules: an Integrator Guide section ("Scripting instance changes") covering both functions, the install sequence and the type rules, and a CLAUDE.md index entry update.

## Open questions

1. Should the schema editor and the Instance Management MCP warn when an admin edits a column that an installed template declares? That needs the declarations stored on the instance (for example with the module registry row), which this design does not do.
2. Should `metadata.dimensions` follow renames by storing column numbers (`attnum`) instead of names? Today a rename leaves the registry naming a column that no longer exists. The comparison reports it, but only at the next install.
3. Should `compare_interface()` also accept a declared check constraint or unique constraint, for dependents that rely on uniqueness of a column such as `external_id`?

## References

- `docs/notes/IMPACT_REPORTING_DESIGN.md`: dimensions registry, module registry, measure engine, report packs.
- `docs/notes/FRONTEND_SDK_DESIGN.md` (sections 9, 10): domain version and schema contract hash.
- `docs/INTEGRATOR_GUIDE.md`: Domain Version, Schema Decisions, Securing RPC Functions.
- `docs/notes/SECURITY_DEFINER_AUDIT_2026-10.md`: in-body guards and `_is_db_admin()`.
- `postgres/migrations/deploy/v0-77-0-domain-version.sql`, `v0-56-1-fix-managed-db-admin-guard.sql`, `v0-76-5-revoke-public-execute.sql`.
