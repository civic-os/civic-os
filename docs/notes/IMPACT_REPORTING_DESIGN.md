# Impact Reporting Design

**Status**: Directional design. The dimensions and module registries are built (v0.85.0) and the `Dimension` property type is scheduled (v0.86.0), both in issue #135; the rest is not scheduled.
**Date**: 2026-11-02
**Audience**: Civic OS contributors building the Woven module line; integrators who will install report packs.

## Summary

Impact Reporting is a capability over the other Woven modules, not a module with its own data. Almost every customer will install it, and what they need from it is assembly work: the same counts cut by program, period, geography and funder, delivered as a live dashboard, a spreadsheet, or a document a funder will accept.

This design answers three questions:

| Question | Answer |
|---|---|
| Can reporting be generalized to respond to whatever entities the public schema holds? | Partly. Civic OS can generalize the **mechanics** by registration, the same way it generalizes CRUD by metadata: dimensions are registered lookup tables and every FK to one is a reporting axis; periods, aggregation and delivery are generic. It cannot infer **meaning** (that `households.size` is "people served") from a schema, so measures are declared, not discovered. A discovery helper can suggest candidates. |
| Should reports be designed per module and installed selectively? | Yes. Each module ships a **report pack**: measure registrations, VIEWs, dashboard widgets and document templates. Packs are instance content installed by deployment automation, not core migrations. |
| Can the planned pair-install cross-module pattern apply to reporting? | Yes, with the same mechanism. A pair pack declares the modules it requires and installs only when all are present. Cost per unit of service (People Served + Money and Grants) is the first one. |

The recommendation is a **registered-measure engine in core plus per-module and pair report packs in the Woven deployment line**. The engine is platform work; the packs are the "included changes" tier. The engine also resolves two existing gaps: the blocked stat-card widget and the funder report the accounting design defers.

## Problem

Listening sessions put Impact Reporting first in both priority votes and "fix first" votes, but the detail behind the votes was never "we lack a report." It was:

- Two funders want the same participant data cut differently: one by a city, one by a county.
- Grant tracking and demographics live in spreadsheets reconstructed at report time.
- A dashboard of a few headline counts (households served, pounds distributed, volunteer hours) would be enough for the board.
- Scheduled, on-demand and funder-specific reports; year-over-year comparison; de-identified exports for an evaluator.
- Fundraising by month against a target, shown red or green.

The dominant failure mode across all sessions was data living "in two places at once." Reporting that requires a second entry of the same data reproduces the problem it is meant to solve. The design constraint that follows: **every report reads the records created when the work happened, and nothing else.**

### What funders actually ask for

Funder reports across government and foundation sources use the logic-model vocabulary: inputs, activities, **outputs** (counts of things done), **outcomes** (changes observed), and performance measures with targets and variance commentary. Federal awards require performance to be measured and reported against the award's objectives (2 CFR 200.301). Standard outcome libraries exist (the Urban Institute common outcome framework, the EEA Core Indicators Library, Independent Sector's Charting Impact) but none is a de facto standard for small US nonprofits; each funder supplies its own template.

The practical consequence: a small organization's report is a **table of outputs by program and period**, a **demographic breakdown** of the people behind the outputs, sometimes an **outcome indicator** measured at two points in time, and a narrative. The first two are mechanical once the data exists. The third needs its own data model. The narrative is a human's job.

## Prior art inside Civic OS

| Capability | State | Role in this design |
|---|---|---|
| Dashboards and chart widget (v0.61.0) | Built. Chart reads a pre-aggregated VIEW (`isSummaryView`), with `labelColumn`, `valueColumns`, `filters`, `orderBy`, `limit`. | Delivery surface for live reporting. Measure VIEWs are built to its contract so Phase 1 needs no widget changes. |
| Stat card widget | Blocked: PostgREST has no GET aggregation; a `widget_aggregate()` RPC was proposed. | A registered measure materializes a one-row VIEW, which unblocks it without a generic aggregation RPC. |
| Chart widgets over `security_invoker` VIEWs | Proven in instance configuration (`docs/notes/HHAP_SIZING_COMPARISON.md`). | Every report VIEW is `security_invoker`; RLS decides what a viewer's report contains. |
| De-identified VIEWs | Designed for one instance (deterministic research key, PII stripped, small-cell suppression). | Generalized as a report-pack output type in Phase 3. |
| Accounting Attribution | Directional design. Owns `accounting.programs`, `accounting.funding_sources`, rate layer, and a deferred funder report "operational counts joined with cost by funding source." | The funder report is a pair pack over the measure engine. `accounting.programs` is replaced by registered dimension slots (see Dimensions). |
| Document Templates | Designed. DOCX placeholders, loops and conditionals, PDF via Gotenberg, triggered by action or status transition. | Delivery surface for funder-format reports. A report definition is the context the template renders. |
| Excel export | Built, with FK name resolution. | Delivery surface for row-level and tabular exports. |
| Instance config store | Built, v0.79.0 (`metadata.instance_config`, `get_config()`, integrator keys with `default_value`). | Organization name, fiscal year start, default program and the small-cell suppression threshold come from here. |
| Domain Version | Built, v0.77.0 (`set_domain_version()`, admin only, requires a linked schema decision). | Install scripts raise it; the path for scripts without a JWT is in `docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md`. |
| Module install primitives | **None exist.** Instances are deployed by running pre-defined scripts. | This design proposes the minimum registry it needs; see Module registry. Interface checks and versioning for install scripts are in `docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md`. |

## Design

### Layers

```
┌──────────────────────────────────────────────────────────────────┐
│ Delivery        dashboards · stat cards · Excel · DOCX/PDF · feed │
├──────────────────────────────────────────────────────────────────┤
│ Report packs    per module · per module pair · per customer       │   Woven deployment line
│                 (measure rows, VIEWs, widgets, templates)         │   ("included changes")
├──────────────────────────────────────────────────────────────────┤
│ Measure engine  metadata.report_measures · generated VIEWs        │   Civic OS core
│                 period bucketing · dimension rollup · breakdowns  │   (platform work)
├──────────────────────────────────────────────────────────────────┤
│ Dimensions      metadata.dimensions registry (core) · tables      │   core registry,
│                 registered by their owners: program · site ·      │   Woven tables
│                 funding source · department · ward                │
├──────────────────────────────────────────────────────────────────┤
│ Modules         People Served · Staff and Time · Volunteers ·     │   Woven
│                 Money and Grants · Events                         │
└──────────────────────────────────────────────────────────────────┘
```

The engine never knows what a module is. It knows entities, columns, FKs to registered dimensions, and date columns. Packs are the only place where "enrollments count as people served" is stated.

### Dimensions

A **dimension** is a lookup table that reports are cut by: program, site, department, ward, cohort, funding source. Core does not know any of these names. It knows a registry:

```sql
CREATE TABLE metadata.dimensions (
    dimension_key      TEXT PRIMARY KEY,          -- 'program', 'site', 'funding_source'
    display_name       TEXT NOT NULL,
    table_schema       NAME NOT NULL,             -- wherever the owner put it: public, woven, accounting
    table_name         NAME NOT NULL,
    key_column         NAME NOT NULL DEFAULT 'id', -- must be BIGINT; register_dimension() refuses any other type
    label_column       NAME NOT NULL DEFAULT 'display_name',
    parent_column      NAME,                      -- NULL for a flat dimension
    active_column      NAME NOT NULL,             -- rows are retired, never deleted (amendment 2026-11-19)
    external_id_column NAME,                      -- e.g. the QuickBooks Class id; accounting reads it
    default_value_id   BIGINT,                    -- the row new records point at when the user chooses nothing
    hide_when_single   BOOLEAN NOT NULL DEFAULT TRUE, -- one active row: no dropdown, every report still has the axis
    sort_order         INTEGER NOT NULL DEFAULT 0
);
CREATE FUNCTION public.register_dimension(p_key TEXT, p_schema NAME, p_table NAME, ...) RETURNS VOID; -- admin JWT or deployment role (see Permissions)
```

Registration is the only contract. The owner of a dimension creates its table wherever it likes, registers it, and populates it. Woven's People Served module creates `programs` (in `public`, because Woven owns the public schema of its instances, or in a `woven` schema if the module line later wants one) and registers it as `program`. A city instance registers `departments` and `wards`. Nothing in core changes between the two.

**Key type.** Every registered table has a `BIGINT` key, following the instance convention (`id BIGSERIAL PRIMARY KEY` in `docs/INTEGRATOR_GUIDE.md`). One key type is what lets a single column hold a value from any dimension: `default_value_id`, the accounting slots below, `dimension_subtree()` arguments and report definition filters. `register_dimension()` checks the type of `key_column` and refuses to register a table whose key is not `BIGINT`. (Decided 2026-11-05; see Decisions.)

What registration gives the engine:

- **Axes from FKs.** Every FK from any entity to a registered dimension table is a reporting axis, read from `schema_properties` with no per-measure configuration. A measure's entity with FKs to `programs` and `sites` is cut by both.
- **Hierarchy.** `dimension_subtree(p_key TEXT, p_value_id BIGINT) RETURNS SETOF BIGINT` walks `parent_column` with a recursive CTE built by dynamic SQL. No `ltree`: trees are small and the extension question goes away.
- **Rollup columns.** Generated VIEWs carry the value and its ancestors (`program_id`, `program_l1_id`, `program_l2_id`) so a widget groups at any level with an ordinary `filters` entry.
- **Defaults and ergonomics.** `default_value_id` is filled into an empty FK by a server-side trigger on each referencing table, so the Create page, import, MCP and SQL inserts all get it (amendment 2026-11-19, below); `hide_when_single` hides the dropdown for a one-program organization. Woven seeds a **General** program on install.
- **A `Dimension` property type.** A FK whose target is a registered dimension renders as a hierarchical dropdown instead of a flat `ForeignKeyName` list. One generic type, keyed on the registry, replaces a Program-specific one. `schema_properties` exposes `dimension_key` on such columns.
- **Delete guard.** `register_dimension()` installs a BEFORE DELETE trigger on the table that refuses to remove any row (amendment 2026-11-19; first designed to refuse only rows still referenced by accounting slots, see below). Rows are retired through `active_column`, not deleted.
- **Parent-cycle guard.** On a hierarchical dimension, `register_dimension()` also installs a trigger that refuses to make a row its own ancestor, so every tree stays walkable. See Parent-cycle guard below.

#### Parent-cycle guard

*Amendment 2026-11-05; generalized the same day by `docs/notes/TREE_LIST_VIEW_DESIGN.md` (Editing and cycle protection), so one guard serves registered dimensions and any other tree table.* Nothing in a self-referencing FK stops `A.parent = B` and `B.parent = A`. A cycle makes `dimension_subtree()` and the rollup columns loop or return wrong ancestors, and the error appears far from the edit that caused it. The registry prevents cycles on every registered tree:

- **Installed by registration.** When `parent_column` is not NULL, `register_dimension()` creates (or replaces) the row trigger `tree_parent_guard` on the table: `BEFORE INSERT OR UPDATE ... FOR EACH ROW EXECUTE FUNCTION metadata.tree_parent_guard('<key_column>', '<parent_column>')`, with the registry's column names as trigger arguments. Re-registering is idempotent and refreshes the arguments, so re-registration after a column rename repairs the guard. When a registration sets `parent_column` to NULL, the trigger is dropped. Non-dimension trees install the same trigger through `enable_tree_parent_guard()` (Tree List View design).
- **No column list.** The trigger fires on every insert and update, not `UPDATE OF <parent_column>`. A trigger with a column list depends on that column, so `ALTER TABLE ... DROP COLUMN parent_id` would fail without `CASCADE`, and organizations must stay free to flatten a tree. The function reads the values through `to_jsonb(NEW)` and `to_jsonb(OLD)`. It returns at once when the parent column is no longer in the row (dropped or renamed), when the new parent is NULL, or when an update leaves the parent unchanged. A PL/pgSQL function records no dependency on the columns it reads, so dropping or renaming the column always succeeds. A rename therefore turns the guard off silently until the table is re-registered; for dimensions, the interface check reports the stale registry row at the next install (`docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md`).
- **The check.** A new parent equal to the row's own key is refused. On insert that is the only check, because a new row has no descendants. On update the function walks ancestors from the new parent with a recursive query built by `format()` with `%I` identifiers, using the `CYCLE` clause and a depth limit so that an existing cycle cannot make the walk loop, and refuses the change if it reaches the row's key. The error is `check_violation` raised `USING CONSTRAINT = 'tree_parent_cycle'`: the existing `ErrorService` path looks the name up in `metadata.constraint_messages` and shows its translated text, and clients recognize the error by the name rather than by message text. No framework function translates raised messages today, so the message does not interpolate row labels.
- **Concurrency.** Two transactions could each pass the check (one setting A under B, the other B under A) and commit a cycle together. Before walking, the function takes `pg_advisory_xact_lock()` on a key derived from the table's OID, so parent changes within one table run one at a time. The lock is taken only when an update changes the parent, and trees are small and rarely re-parented, so the lock costs little. At `READ COMMITTED` (the API's isolation), each statement in the trigger function takes a new snapshot, so the second transaction's walk sees the first one's change once it holds the lock. A writer at `REPEATABLE READ` or `SERIALIZABLE` keeps its transaction snapshot and could still commit a cycle; the defensive reads below bound the damage, and scripts that re-parent in bulk should run at `READ COMMITTED`.
- **Existing data.** `register_dimension()` refuses to register a hierarchical table that already contains a cycle, and names the rows.
- **Defensive reads.** `dimension_subtree()` and the rollup-column generation also use the `CYCLE` clause, so a cycle introduced after someone drops the trigger yields a bounded result instead of an endless query.

Like the delete guard, this protects row data, not schema. It never refuses a change to columns, tables or metadata, and an instance owner may drop the trigger.

#### Build amendments (2026-11-19)

*Decided while planning issue #135, before any code.* Each changes or fills in the design above:

- **Defaults are filled by the server.** The MCP server and Excel import do not run the Create page's code, so a default applied only there would leave their records without a program. `register_dimension()` therefore installs a `BEFORE INSERT` row trigger, `dimension_default_fill`, on every table with a FK column to the registered table. It fills only on insert, only a FK left NULL, never a value the caller set, and never on update. Like the parent-cycle guard it reads the row through `to_jsonb(NEW)` and takes the column name as a trigger argument with no column list, so dropping or renaming the FK column still succeeds. The Create page shows the dropdown empty and the server fills it; the frontend does not copy the default.
- **Re-registration picks up new referencing tables.** `register_dimension()` is idempotent and looks for referencing FK columns on every call, installing the fill trigger on new ones. An install script that adds a table with a FK to a registered dimension re-registers the dimension afterwards. There is no event trigger (they need a superuser and are refused on some managed databases).
- **A retired default is skipped, not cleared.** The fill trigger skips a default whose `active_column` is false; the registry keeps `default_value_id`, so reactivating the row restores the default.
- **The default can be changed after install.** `set_dimension_default(p_key TEXT, p_value_id BIGINT)`, guarded by `metadata._is_db_admin()`, sets or clears it. It refuses a row that does not exist or is inactive. It generates no DDL, so the admin JWT path needs no narrowing. An admin page control is deferred.
- **Registered rows are never deleted.** The delete guard refuses every `DELETE` on a registered table, not only rows referenced by accounting slots, which do not exist yet. A row added by mistake is retired. An instance owner may still drop the trigger.
- **An active column is required.** Since no row can be deleted, `register_dimension()` refuses a table without `active_column`.
- **API scope until accounting exists.** Over the API, `register_dimension()` accepts only base tables in `public` that `schema_entities` lists, and installs the fill trigger only on referencing tables that `schema_entities` lists; referencing tables in other schemas get it only when the deployment role registers. Framework schemas (`accounting`) join the allowed list when they exist.
- **Contract hash.** `schema_properties` exposes `dimension_key`, and `metadata.schema_contract_hash()` includes it on every property, as it does `status_entity_type`. This changes every instance's hash once, at that release; typed clients under the `block` policy must be regenerated, and the release notes say so.
- **Errors users can read.** *Built in v0.85.0.* The delete guard and the parent-cycle guard raise SQLSTATE `23514` with a message in PostgreSQL's check-violation form, naming `dimension_row_delete` and `tree_parent_cycle`, because the frontend finds a constraint name only in that text (PostgREST does not pass `CONSTRAINT` through). Both names have `metadata.constraint_messages` rows (`table_name = '*'`), and the `constraint_messages` view now translates every message through `metadata.t()` (source type `constraint_message`), so these two ship in the six core locales.
- **Type precedence and one-row dimensions.** A column configured as Status or Category stays that type even when it references a registered table. `hide_when_single` hides the control on Create and Edit when the dimension has exactly one active row (the server fills it); Detail and List still show the value.

The dimensions this design expects Woven to register:

| Dimension | Owner | Table | Hierarchical |
|---|---|---|---|
| `program` | People Served (seeded with General) | `programs` | yes |
| `site` | People Served, when an organization has more than one location | `sites` | optional (region → site) |
| `funding_source` | Money and Grants | `accounting.funding_sources` | no |

Funding sources keep their accounting table because they carry budgets and periods; registering the same table as a dimension is additive and lets "people served by funder" be the same generated VIEW as "people served by program."

**Period** is not a dimension. Every measure names the date column that places a row in time, and the engine buckets by month, quarter, calendar year and fiscal year (fiscal year start from `get_config('fiscal_year_start_month')`). Award periods are arbitrary date ranges, which are filters on the bucketed VIEW, not a bucket of their own.

**Geography** ("families in one city versus the whole county") is not a dimension either. It comes from the address on the person or household record, normalized by People Served into city, county and ZIP columns, which the engine treats as breakdown columns.

#### What this means for the accounting design

The accounting design fixed its dimensions as FK columns (`account_id`, `program_id`, `funding_source_id`) on purpose: embeds, RLS predicates, budget SQL and type detection all stay simple. With registered dimensions, the program slot cannot hold a hard FK to a table chosen at install time. The proposed shape keeps fixed slots and swaps the FK for a registry key plus a validation trigger:

```sql
-- accounting.entries, accounting.funding_source_budget_lines, metadata.posting_rules
dimension_1_key       TEXT REFERENCES metadata.dimensions(dimension_key),
dimension_1_value_id  BIGINT,      -- validated against the registered table by trigger
dimension_2_key       TEXT REFERENCES metadata.dimensions(dimension_key),
dimension_2_value_id  BIGINT
```

Two slots cover program plus site. `account_id` and `funding_source_id` stay as they are: accounts are a mirror of the external chart and funding sources carry budgets, so both remain accounting-owned FKs. Posting rules replace `program_ref` with a slot reference that uses the same `path:` grammar. The QuickBooks Class export reads `external_id_column` through the registry.

This is a deliberate trade: referential integrity by trigger and delete guard instead of by FK. Civic OS already makes it for polymorphic references (entity notes point at `(source_entity, source_id)`; accounting entries point at domain rows the same way), so the architecture carries this cost already. What it buys is that Money and Grants never names "program" and works unchanged for a city that posts by department.

**Future direction, not part of this design (noted 2026-11-03).** The Accounting Attribution design and the Woven Money and Grants module describe the same thing from two sides and should converge into one design. Once dimensions are registered rather than owned, the main reason for a separate `accounting` schema (owning the dimension tables and hiding them from `public`) weakens, and it is worth researching whether the accounting tables can live in `public` as ordinary entities with bridge VIEWs only where RLS needs them. That research is its own task.

#### Placement alternatives considered

PostgREST exposes only `public`, the metadata VIEWs describe `public` only, and no client sends a schema per request. A table outside `public` reaches the UI through a bridge VIEW, the pattern `payments`, `accounting` and `metadata` already use; widening the PostgREST schema path would be per-request `Accept-Profile` headers through every client and is not on the table. Within that constraint:

| Option | Verdict |
|---|---|
| **Registry (`metadata.dimensions`), table wherever its owner puts it** | **Chosen 2026-11-03.** Axes derive from FKs; vocabulary stays out of core; placement becomes the owner's call. |
| Fixed `metadata.programs` with a `public.programs` bridge VIEW | The Status and Category precedent, and it keeps hard FKs in accounting. Rejected because "program" is a nonprofit word, cities and statewide programs cut by other things, and a fixed table cannot give an instance two hierarchies. |
| `woven.programs` with a `join_schema = 'woven'` type branch in core | Puts Woven vocabulary in core and core cannot FK to a schema only Woven installs. The registry removes the need. |
| `accounting.programs` as designed | Inverts the layering: people verticals would depend on the money module for their program axis. |

A `woven` schema may still earn its place for tables shared **between Woven modules but not general to Civic OS** (a `persons` table shared by People Served, Volunteers and Staff and Time). That decision belongs to the People Served design and carries the bridge-VIEW cost; nothing in this design needs it.

### Measure registry

The generalizing device is a metadata table. A measure is a declared aggregate over one entity:

```sql
CREATE TABLE metadata.report_measures (
    measure_key        TEXT PRIMARY KEY,          -- 'people_served', 'volunteer_hours'
    display_name       TEXT NOT NULL,
    description        TEXT,
    pack_key           TEXT NOT NULL,             -- which report pack owns it
    entity_name        TEXT NOT NULL,             -- public table or view
    aggregate          TEXT NOT NULL CHECK (aggregate IN ('count','count_distinct','sum','avg','min','max')),
    value_column       TEXT,                      -- NULL for count; the distinct key for count_distinct
    date_column        TEXT NOT NULL,             -- places the row in a period
    dimension_keys     TEXT[],                     -- NULL = every registered dimension the entity has an FK to
    row_filter         TEXT,                      -- optional SQL predicate, e.g. "voided_at IS NULL"
    breakdown_columns  TEXT[] NOT NULL DEFAULT '{}', -- e.g. '{city,county,age_band}'
    demographic_columns TEXT[] NOT NULL DEFAULT '{}', -- subset of breakdown_columns that describe people; suppressed below the threshold
    subject_column     TEXT,                      -- person or household key whose distinct count sizes a cell; defaults to value_column when is_unduplicated
    unit_label         TEXT,                      -- 'people', 'hours', 'pounds', 'USD'
    is_unduplicated    BOOLEAN NOT NULL DEFAULT FALSE, -- count_distinct over a person key
    sort_order         INTEGER NOT NULL DEFAULT 0
);
```

Registering a measure through `register_report_measure(...)` generates two `security_invoker` VIEWs from the row:

| VIEW | Grain | Consumer |
|---|---|---|
| `report_<measure_key>_by_period` | one row per (dimension values and their ancestors, bucket kind, bucket start) | chart widget, stat card (filtered to one bucket), Excel |
| `report_<measure_key>_breakdown` | one row per (dimension values, bucket, breakdown column, breakdown value) | demographic and geographic tables |

The engine finds the measure's axes by reading `schema_properties` for FKs from `entity_name` to registered dimension tables; `dimension_keys` narrows that set when an entity has more FKs than a report should cut by. A hop (a time entry that reaches program through its case) is not an axis in Phase 1; the pack registers a VIEW that joins the hop as the measure's entity, and the accounting design's `path:` grammar can replace that later. Generating VIEWs, rather than answering through a generic RPC, matches the chart widget contract that exists today and keeps RLS enforcement where it already is. A generic `report_measure_values()` RPC for ad hoc periods and filter sets is a later addition, not a Phase 1 requirement.

**Unduplicated counts** are the one sector-specific rule the engine must understand. "People served" is a count of distinct persons in a period, and the number for a parent dimension value is **not** the sum of its children, because one person can be in two programs. A measure flagged `is_unduplicated` is computed by `COUNT(DISTINCT value_column)` at every rollup level independently, and the chart widget documentation must say that these columns do not sum. This is the single most common error in hand-built nonprofit reports and the engine should make it impossible.

**Small-cell suppression.** *Amendment 2026-11-05; answers open question 4.* A breakdown cell that describes very few people can identify them ("the one person aged 75+ in this program"). The engine suppresses such cells in the generated breakdown VIEW, never in the widget, so every delivery surface (dashboard, Excel, document) inherits it.

- **What it protects.** Report VIEWs are `security_invoker`, so a viewer only ever aggregates rows they could list. A staff member who sees a suppressed cell can usually list the people in it, and an anonymous viewer aggregates only rows `web_anon` can read (none, unless the base table is public, in which case the rows themselves are public). Suppression therefore protects **output that leaves the instance**: documents rendered for funders, Excel files sent to evaluators, and the de-identified exports. That is the threat model the rules below are judged against; on live dashboards suppression is consistency, not protection.

- **Which cells.** Only breakdowns by a column listed in `demographic_columns`. Packs mark age band, race, ethnicity, household size and similar columns; geography and non-person breakdowns are suppressed only if a pack lists them. `register_report_measure()` refuses a `demographic_columns` entry that is not in `breakdown_columns`.
- **Cell size.** A cell's size is the number of distinct people in it: `COUNT(DISTINCT subject_column)`, where `subject_column` defaults to `value_column` for unduplicated measures. The rule applies to every aggregate. Hours by age band are suppressed when the band holds too few people, whatever the hours. `register_report_measure()` refuses a measure that has demographic columns but no subject: not unduplicated and no `subject_column`. Size is evaluated at each rollup level independently, like unduplicated counts.
- **Output.** The breakdown VIEW gains `is_suppressed BOOLEAN`. A suppressed cell keeps its row, with `value` and the cell size NULL, so a table shows "suppressed" rather than an absent row that reads as zero. Empty cells have no row, as before.
- **Threshold.** The integrator config key `report_min_cell_size` (`config_type` `integer`, `default_value` `'5'`, `is_public` false) in a new `reporting` config group. The measure engine migration seeds both with `ON CONFLICT DO NOTHING`, which is shape, not instance content. A cell is suppressed when its size is below the value. The `instance_config_normalize()` trigger gains a key-specific rule, as the map keys have: a whole number of 1 or more. Setting 1 turns suppression off, and the key's description on `/admin/config` says so. Label and description ship with translations under the `instance_config` and `instance_config_group` source types.
- **Read at query time.** Generated VIEWs call `metadata.report_min_cell_size()`, a `STABLE SECURITY DEFINER` function that returns the key's value, else its default, else 5 if the row is missing. Because the VIEW calls it rather than embedding the value, a changed setting applies to the next query without regenerating any VIEW. (STABLE permits but does not guarantee a single evaluation per query; the lookup is a primary-key read either way.) The VIEWs do not call `get_config()` directly because it runs with the caller's rights and returns NULL on this private key for a caller who cannot read it, such as a worker or export role without a signed-in user's grants. The fallback to 5 means a missing or unreadable setting leaves suppression on.
- **De-identified exports** (Phase 3) read the same function, so one setting governs every report surface.

Suppression is primary only: each cell is judged alone. A suppressed value can be recovered by subtraction wherever the same people are counted at two grains, which for additive measures (sums and plain counts) happens in several places: the other cells against the period total in `report_<measure_key>_by_period`; a quarter against its months (every bucket kind is computed); a parent dimension value against its other children (rollup columns); and two report-definition `range` periods that differ by a day. Unduplicated counts resist subtraction because distinct counts do not add, but they are not immune when one person sits in one cell only. See open question 4.

**Row filters** are SQL text evaluated at VIEW generation, not at query time, and are restricted to the registering admin. They cover voided readings, withdrawn enrollments and test records without a second mechanism.

**Schema-responsive discovery.** The engine cannot know what an entity means, but it can list what is countable. A `suggest_report_measures()` function scans `schema_properties` for tables with an FK to any registered dimension and at least one date column and proposes a count measure per table and a sum measure per numeric column, named from display names. An admin accepts or ignores each suggestion from a Measures admin page. This is how a customer's "included change" (a new entity added for one organization) becomes reportable without anyone writing SQL, and it is as far as responding to the public schema can go honestly.

### Report packs

A report pack is a set of SQL statements installed with a module: measure registrations, any supporting VIEWs the measures read, a dashboard with widgets over the generated VIEWs, document templates, and translations for all of their labels. Packs are **instance content**, so they live in the Woven deployment line and are applied by deployment automation, never by core migrations (the "Instance-Specific Data Is Off-Limits" rule in `postgres/migrations/README.md`).

Each pack is an idempotent SQL script with an `install_report_pack('<pack_key>')` entry point that upserts its rows and re-creates its VIEWs, so re-running after a module upgrade is safe. Re-creating means `DROP VIEW` and `CREATE VIEW ... WITH (security_invoker = true)`, not `CREATE OR REPLACE VIEW`, which refuses to change a column's type after an organization widens a source column.

**Packs and the domain version.** *Decided 2026-11-06 (decision 8).* Install scripts record a schema decision and raise the domain version (`docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md`), and a pack creates VIEWs, so it changes the schema too. Applying every pack on every deployment must not raise the version each time. Each pack therefore registers itself in `metadata.modules` with its own version (`module_key` `pack:<pack_key>`), records a decision and bumps the domain version only when it is absent or its registered version is older, and otherwise re-creates its VIEWs and upserts its rows without a decision.

**Per-module packs (first cut):**

| Pack | Requires | Headline measures | Breakdowns |
|---|---|---|---|
| `people_served` | People Served | people served (unduplicated), households served (unduplicated), enrollments, units of service by service type, active cases at period end | city, county, ZIP, age band, household size, any demographic Category the module defines |
| `staff_time` | Staff and Time | staff hours by activity, FTE by program, hours per case | staff role, site |
| `volunteers` | Volunteers | volunteer hours, active volunteers (unduplicated), shifts filled vs. offered | site, activity type |
| `money_grants` | Money and Grants | funds received by month vs. target, grant balance by funding source, days to award deadline | funding source kind, funder |
| `events` | Events and Fundraising | attendance, registrations vs. capacity, revenue per event | event type |

**Pair packs:**

| Pack | Requires | What it adds |
|---|---|---|
| `people_served+money_grants` | both | cost per unit of service, cost per person served, people served by funding source. This is the accounting design's deferred funder report. |
| `staff_time+money_grants` | both | effort by grant, salary allocation by program for time-and-effort certification. |
| `volunteers+money_grants` | both | valued volunteer hours as in-kind match, using the accounting rate layer. |
| `people_served+volunteers` | both | volunteer hours per person served. |
| `people_served+events` | both | event participation by enrolled person; new participants reached through events. |

A pair pack is installed only when every module it requires is present. It registers measures whose `entity_name` is a VIEW the pack itself creates over both modules' tables. Nothing in a pair pack is reachable from either module alone, which keeps a single-module instance free of dangling references.

**Customer packs** are the organization-specific layer: a measure registered against an included-change entity, a funder's report definition, a dashboard tailored to their board. They are written the same way and live in the customer's deployment folder.

### Report definitions and delivery

The pack supplies measures; the organization supplies the cuts funders want. A **report definition** is the saved combination:

```sql
CREATE TABLE metadata.report_definitions (
    report_key          TEXT PRIMARY KEY,
    display_name        TEXT NOT NULL,
    measure_keys        TEXT[] NOT NULL,
    dimension_filters   JSONB NOT NULL DEFAULT '{}',           -- {"program": 12, "site": 3}: BIGINT ids; a program id selects its subtree
    bucket              TEXT NOT NULL CHECK (bucket IN ('month','quarter','year','fiscal_year','range')),
    period_start        DATE,                                  -- for 'range'
    period_end          DATE,
    breakdown_filters   JSONB NOT NULL DEFAULT '{}',           -- {"county": ["Genesee"]}
    compare_prior       BOOLEAN NOT NULL DEFAULT FALSE,        -- adds the same period one year earlier
    document_template_id BIGINT REFERENCES metadata.document_templates(id) -- optional DOCX/PDF rendering
);
```

Delivery surfaces, all existing or designed elsewhere:

- **Dashboard**: a definition can be opened as a generated dashboard page (one widget per measure, filtered to the definition). Live, interactive, role-gated by RLS.
- **Excel**: the definition's rows exported with the existing export path. This is the "on demand" report.
- **Document**: the definition is the context object for a document template; the template owns the funder's layout and narrative placeholders. Rendered on demand from a button, or on a schedule by the worker. This is the "scheduled and funder-specific" report.
- **Year over year**: `compare_prior` adds a second series to every measure; nothing else changes.
- **De-identified row export**: a pack output type, not a measure. The pattern (stable research key, PII columns stripped, small-cell suppression on breakdowns) is generalized from the instance work that designed it, gated to a dedicated role, and delivered by Excel export.

**Targets.** Several asks were "actual against goal, red or green." A nullable `target` on a report definition line (`metadata.report_definition_targets(report_key, measure_key, bucket_start, target NUMERIC)`) lets the stat card color itself; the engine does not otherwise care about targets.

### Outcomes

Outputs are what the engine computes. **Outcomes** (a change in a person's situation between two points in time) need their own data: an indicator definition, a measurement per person per date, and a scoring rule. That is a data model for People Served to own (indicator, measurement, optional survey), not a reporting concern; once the rows exist they are ordinary measures (`avg` of score, `count_distinct` of persons who improved) with `row_filter` on the measurement kind. The reporting engine stays agnostic.

Recommendation: Phase 1 of Impact Reporting ships outputs and demographics. Outcome indicators are a People Served sub-module scheduled on customer demand, and the outcomes report pack is a pair pack over People Served and that sub-module.

### Module registry

No module-install primitive exists today, and this design needs exactly one thing from it: a way to ask "is module X present?" so a pair pack can decide whether to install. The smallest shape:

```sql
CREATE TABLE metadata.modules (
    module_key    TEXT PRIMARY KEY,     -- 'people_served'
    display_name  TEXT NOT NULL,
    version       TEXT NOT NULL,        -- the module's own semver, distinct from the instance domain version
    installed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE FUNCTION public.register_module(p_module_key TEXT, p_display_name TEXT, p_version TEXT) RETURNS VOID ...; -- admin only
CREATE FUNCTION public.module_installed(p_module_key TEXT) RETURNS BOOLEAN ...;                               -- STABLE, any role
```

Each Woven module's install script ends with `register_module(...)`. Each report pack begins with a guard on `module_installed()` for every module it requires and exits quietly otherwise. Deployment automation applies packs after modules in a fixed order, and because packs are idempotent, it can simply apply all known packs on every deployment and let the guards decide. The cross-module behavior Dan already plans for module pairs can use the same registry and the same guard, so the registry is shared infrastructure, not reporting-specific.

The registry lives in core because `module_installed()` must be callable from instance SQL on every instance. It is two functions and a table, and it does not attempt dependency resolution, uninstall or versioned upgrade; those are decisions for a later module-system design once more than one customer runs more than one module.

What install scripts need besides the registry (a check of the elements they depend on against the live schema, and a way to record a schema decision and raise the domain version without a JWT) is designed in `docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md`. That note's interface comparison reads `metadata.modules.version` for its `module` elements.

### Permissions

- Report VIEWs are `security_invoker`. A viewer's dashboard shows aggregates of rows they could list. There is no separate "reporting" permission in Phase 1.
- Breakdown VIEWs over small populations can re-identify people. Packs mark demographic breakdown columns, and the generated VIEW suppresses cells below the instance's `report_min_cell_size` (default 5), not the widget. See Small-cell suppression under Measure registry.
- De-identified exports are a dedicated entity with their own `read` permission, granted to an analyst role.
- `register_dimension()`, `register_report_measure()` and `register_module()` are called by install scripts that run as the deployment role without a JWT. Their in-body guard is `metadata._is_db_admin()`, not `is_admin()`. See `docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md`. Report-definition writes are admin-only RPCs guarded by `is_admin()`. Both follow the function security rules.
- **DDL from definer functions.** *Decided 2026-11-06 (decision 9).* `_is_db_admin()` also admits an admin JWT over PostgREST (its first branch is `is_admin()`), and an application admin cannot otherwise run DDL. Two registry functions generate DDL as the function owner, so each limits what that path can reach:
  - `register_report_measure()` concatenates `row_filter` SQL text into a VIEW definition. A non-NULL `row_filter` is accepted only from a session without a JWT that `_is_db_admin()` admits (a superuser or `CREATEROLE` login, through a `metadata._is_deployer()` helper with no `is_admin()` branch). Admins accepting suggestions on the Measures page send no filter. Without this, an application admin could inject DDL that runs as the owner.
  - `register_dimension()` installs triggers on the table it is given. Over the API it accepts only a base table that `schema_entities` lists or a table in a schema the framework owns for this purpose (`accounting`); identifiers are quoted with `%I` and only the fixed delete and parent guards are installed.

### What the frontend needs

Phase 1 needs no new widget types. Phase 2 needs:

- A **Measures** admin page: list registered measures, accept or dismiss suggestions, preview a measure's VIEW.
- A **Reports** page: list report definitions, run one (dashboard view, Excel, document), edit period and filters. This is a candidate Custom Page rather than a new page type.
- Stat card widget over a one-row VIEW, with optional target coloring.
- Chart widget documentation on non-additive (unduplicated) measures.

## Decisions

| # | Decision | Recommendation | Alternative and trade-off |
|---|---|---|---|
| 1 | How reports know what to cut by | A `metadata.dimensions` registry; owners create and register their own tables; axes derive from FKs. **Decided 2026-11-03.** | A fixed core `metadata.programs` table bridged to `public`: keeps hard FKs but bakes one nonprofit word into core and allows one hierarchy per instance. |
| 1a | Accounting dimension slots | Two `(dimension_key, value_id)` slots validated by trigger, with a delete guard on registered tables; `account_id` and `funding_source_id` stay hard FKs. Proposed; amends the accounting design. | Keep `accounting.programs` with a hard FK: simpler SQL, but Money and Grants then owns the program vocabulary and the people verticals depend on it. |
| 1b | Key type of registered dimension tables | `BIGINT`, checked by `register_dimension()`; `default_value_id`, the accounting slots and report filters are `BIGINT`. Follows the instance convention for `public` tables, so `programs`, `sites` and `accounting.funding_sources` need no exception. The accounting design's dimension tables change to match. **Decided 2026-11-05.** | `UUID`: ids cannot be enumerated and can be generated before insert, but the instance convention and the integrator examples use `BIGINT`, and a registry that accepted both would need a type column and two value columns per slot. |
| 2 | Phase 1 data access | Generate `security_invoker` VIEWs per measure. **Accepted 2026-11-03.** | A generic `report_measure_values()` RPC. More flexible for ad hoc periods, but needs a new widget data source and reimplements RLS in the RPC. Add later. |
| 3 | Where packs live | Woven deployment line, applied by automation. **Accepted 2026-11-02.** | Core migrations. Violates the instance-content rule and ties every instance to Woven's module vocabulary. |
| 4 | Outcomes in Phase 1 | No; outputs and demographics only. **Open**: not yet decided. | Ship indicator and measurement tables now. Doubles the People Served schema before a customer has asked for outcome tracking in the product. |
| 5 | Module registry scope | Table plus two functions, no dependency resolution | A full module system. Premature with zero modules installed anywhere. |
| 6 | Small-cell suppression threshold | Integrator config key `report_min_cell_size`, default 5, minimum 1 (1 turns suppression off), read at query time through a definer helper that falls back to 5. Cell size is the distinct count of `subject_column`. **Decided 2026-11-05.** | Fixed at 5: simpler, but some funders and evaluators require a higher threshold. A floor of 5 would stop an organization from weakening suppression, at the cost of exact small counts on staff-only instances. |
| 7 | Hierarchy integrity | `register_dimension()` installs the generalized `tree_parent_guard` trigger (column names as trigger arguments, `USING CONSTRAINT = 'tree_parent_cycle'`), with no column list so the parent column can still be dropped, serialized per table by an advisory lock. The same trigger serves non-dimension trees (Tree List View design). **Decided 2026-11-05.** | A `CHECK` or exclusion constraint cannot see ancestors. An `ltree` path column would need maintenance triggers and the extension this design avoided. |
| 8 | Pack versions | Packs register in `metadata.modules` as `pack:<pack_key>` with their own version, and record a decision and raise the domain version only when absent or older; otherwise they re-create VIEWs and upsert rows silently. **Decided 2026-11-06.** | A separate pack registry: `module_installed()` never sees packs, but a second table with the same shape and a second version check for interface `module` elements. |
| 9 | DDL from definer functions | `register_report_measure()` accepts a non-NULL `row_filter` only from a deployer session (`metadata._is_deployer()`); `register_dimension()` over the API installs its fixed guards only on listed `public` tables or framework schemas. **Decided 2026-11-06.** | `_is_db_admin()` alone: simpler, but an application admin could inject DDL that runs as the function owner. |
| 10 | Where `default_value_id` is filled | A `BEFORE INSERT` trigger on each referencing table, installed and refreshed by `register_dimension()`; a retired default is skipped. **Decided 2026-11-19.** | The Create page only: no DDL on referencing tables, but import, MCP and SQL inserts get no default. A column `DEFAULT`: simple, but static, so it ignores later default changes and retirements. |
| 11 | Deleting dimension rows | Refused for every row; rows are retired through a required `active_column`. **Decided 2026-11-19.** | Refuse only rows referenced by accounting slots: allows cleanup of mistakes, but protects nothing until accounting exists. |
| 12 | Changing the default | `set_dimension_default()` RPC; admin UI deferred. **Decided 2026-11-19.** | Re-run `register_dimension()` with a new default: works, but couples a data change to a registration that also installs triggers. |
| 13 | `dimension_key` in the contract hash | Included on every property; every instance's hash changes once. **Decided 2026-11-19.** | Only when non-NULL: no hash change for instances without dimensions, but an irregular contract shape. |

## Phasing

| Phase | Scope | Depends on |
|---|---|---|
| 1 | `metadata.dimensions`, `register_dimension()` with delete and parent-cycle guards, `dimension_subtree()` and the `Dimension` property type; Woven `programs` table registered as `program`; `metadata.modules` and guards; interface comparison and the install path for domain version (`docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md`); `metadata.report_measures` with VIEW generation and small-cell suppression (`report_min_cell_size`); `people_served` and `volunteers` packs; dashboards over generated VIEWs; Excel export of report VIEWs | People Served module schema; chart widget (built); instance config store (built); Domain Version (built) |
| 2 | Report definitions; stat card widget with targets; Measures and Reports admin pages; `suggest_report_measures()`; `money_grants` pack and the first pair pack (cost per unit of service) | Accounting Attribution Phase 1; Instance config store |
| 3 | Document-template delivery and scheduled rendering; de-identified export pattern; `staff_time` and remaining pair packs | Document Template system; Staff and Time module |
| 4 | Outcome indicators sub-module and its pair pack; generic measure RPC for ad hoc queries | Customer demand |

## Non-goals

- A query builder or pivot UI. Funders want fixed cuts; organizations want them saved, not rebuilt.
- Cross-instance aggregation. One instance per customer is the Woven model; a funder consolidating across grantees is a federation question.
- Replacing the narrative. Templates leave narrative placeholders for a human.
- A standard outcome taxonomy. None is dominant for small US nonprofits; packs seed measures, not a library of indicators.

## Open questions

1. Does the accounting design accept replacing `accounting.programs` and `program_id` with two registry-validated dimension slots, with the QuickBooks Class mapping read through `external_id_column`?
2. Which demographic columns does People Served normalize (city, county, ZIP are certain; age band, household size, race and ethnicity categories need the module's data design)?
3. Fiscal year: an instance config key, or a per-dimension-value column for organizations whose grants run on the funder's year?
4. ~~Small-cell suppression threshold: fixed at 5, or a config key?~~ Answered 2026-11-05: config key `report_min_cell_size`, default 5 (decision 6). Still open: should the engine add complementary suppression, and how far? Within one breakdown group (dimension value, bucket, breakdown column) the usual fix also suppresses the next-smallest cell. That does not close subtraction across bucket kinds, rollup levels or overlapping `range` periods (see Small-cell suppression). Since suppression protects output that leaves the instance, a narrower answer may be enough: apply complementary suppression and a single bucket kind only in document and export renderings, and leave live dashboards primary-only.
5. How many accounting slots: two fixed, or a slot count read from the registry at migration time?
6. Should the accounting module and Money and Grants converge into one design, and with registered dimensions, can accounting move into `public` instead of its own schema? (Future research, outside this design.)
7. Should `register_module()` be called by the deployment automation rather than by each module's script, so the automation is the single source of truth for what is installed?
8. ~~Should packs share `metadata.modules` under a `pack:` prefix, or get their own registry table?~~ Answered 2026-11-06: shared registry with the `pack:` prefix (decision 8).

## References

- `docs/notes/DASHBOARD_DESIGN.md`, `docs/development/DASHBOARD_WIDGETS.md`: chart widget contract and the stat-card blocker.
- `docs/notes/ACCOUNTING_ATTRIBUTION_DESIGN.md`: dimensions, rate layer and the deferred funder report.
- `docs/notes/DOCUMENT_TEMPLATE_DESIGN.md`: DOCX and PDF delivery.
- `docs/notes/CUSTOM_PAGES_DESIGN.md`: candidate home for the Reports page.
- `docs/notes/INSTANCE_SETUP_DESIGN.md`: instance config store.
- `docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md`: interface comparison for install scripts; domain version and schema decisions without a JWT.
- `docs/notes/HHAP_SIZING_COMPARISON.md`: de-identified VIEWs and chart-over-`security_invoker` precedent.
- Sector sources: [2 CFR 200.301 performance measurement summary](https://dof.ca.gov/media/docs/budget/state-fiscal-recovery-fund/Outcomes-and-Outputs-Presentation.pdf), [Urban Institute common outcome framework](https://betterevaluation.org/sites/default/files/411404-Building-a-Common-Outcome-Framework-To-Measure-Nonprofit-Performance.PDF), [EEA Core Indicators Library](https://core-indicators.eeagrants.org/), [Kauffman Foundation outputs and outcomes guide](https://search.issuelab.org/resource/kauffman-foundation-grant-application-guide-developing-expected-outputs-and-outcomes), [AmeriCorps performance measure reporting, 45 CFR 2522.620](https://www.law.cornell.edu/cfr/text/45/2522.620).
