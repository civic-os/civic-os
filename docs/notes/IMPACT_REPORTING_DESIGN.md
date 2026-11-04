# Impact Reporting Design

**Status**: Directional design, not scheduled. No code.
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
| Instance config store | Designed (`metadata.instance_config`, `get_config()`). | Organization name, fiscal year start, and default program come from here. |
| Module install primitives | **None exist.** Instances are deployed by running pre-defined scripts. | This design proposes the minimum registry it needs; see Module registry. |

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
    key_column         NAME NOT NULL DEFAULT 'id',
    label_column       NAME NOT NULL DEFAULT 'display_name',
    parent_column      NAME,                      -- NULL for a flat dimension
    active_column      NAME,                      -- NULL if rows are never retired
    external_id_column NAME,                      -- e.g. the QuickBooks Class id; accounting reads it
    default_value_id   UUID,                      -- the row new records point at when the user chooses nothing
    hide_when_single   BOOLEAN NOT NULL DEFAULT TRUE, -- one active row: no dropdown, every report still has the axis
    sort_order         INTEGER NOT NULL DEFAULT 0
);
CREATE FUNCTION public.register_dimension(p_key TEXT, p_schema NAME, p_table NAME, ...) RETURNS VOID; -- admin only
```

Registration is the only contract. The owner of a dimension creates its table wherever it likes, registers it, and populates it. Woven's People Served module creates `programs` (in `public`, because Woven owns the public schema of its instances, or in a `woven` schema if the module line later wants one) and registers it as `program`. A city instance registers `departments` and `wards`. Nothing in core changes between the two.

What registration gives the engine:

- **Axes from FKs.** Every FK from any entity to a registered dimension table is a reporting axis, read from `schema_properties` with no per-measure configuration. A measure's entity with FKs to `programs` and `sites` is cut by both.
- **Hierarchy.** `dimension_subtree(p_key, p_value_id)` walks `parent_column` with a recursive CTE built by dynamic SQL. No `ltree`: trees are small and the extension question goes away.
- **Rollup columns.** Generated VIEWs carry the value and its ancestors (`program_id`, `program_l1_id`, `program_l2_id`) so a widget groups at any level with an ordinary `filters` entry.
- **Defaults and ergonomics.** `default_value_id` is applied by the Create page to an empty FK; `hide_when_single` hides the dropdown for a one-program organization. Woven seeds a **General** program on install.
- **A `Dimension` property type.** A FK whose target is a registered dimension renders as a hierarchical dropdown instead of a flat `ForeignKeyName` list. One generic type, keyed on the registry, replaces a Program-specific one. `schema_properties` exposes `dimension_key` on such columns.
- **Delete guard.** `register_dimension()` installs a BEFORE DELETE trigger on the table that refuses to remove a row still referenced by accounting slots (see below). Rows are retired through `active_column`, not deleted.

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
dimension_1_value_id  UUID,        -- validated against the registered table by trigger
dimension_2_key       TEXT REFERENCES metadata.dimensions(dimension_key),
dimension_2_value_id  UUID
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

**Row filters** are SQL text evaluated at VIEW generation, not at query time, and are restricted to the registering admin. They cover voided readings, withdrawn enrollments and test records without a second mechanism.

**Schema-responsive discovery.** The engine cannot know what an entity means, but it can list what is countable. A `suggest_report_measures()` function scans `schema_properties` for tables with an FK to any registered dimension and at least one date column and proposes a count measure per table and a sum measure per numeric column, named from display names. An admin accepts or ignores each suggestion from a Measures admin page. This is how a customer's "included change" (a new entity added for one organization) becomes reportable without anyone writing SQL, and it is as far as responding to the public schema can go honestly.

### Report packs

A report pack is a set of SQL statements installed with a module: measure registrations, any supporting VIEWs the measures read, a dashboard with widgets over the generated VIEWs, document templates, and translations for all of their labels. Packs are **instance content**, so they live in the Woven deployment line and are applied by deployment automation, never by core migrations (the "Instance-Specific Data Is Off-Limits" rule in `postgres/migrations/README.md`).

Each pack is an idempotent SQL script with an `install_report_pack('<pack_key>')` entry point that upserts its rows and re-creates its VIEWs, so re-running after a module upgrade is safe.

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
    dimension_filters   JSONB NOT NULL DEFAULT '{}',           -- {"program": "<subtree root id>", "site": "<id>"}
    bucket              TEXT NOT NULL CHECK (bucket IN ('month','quarter','year','fiscal_year','range')),
    period_start        DATE,                                  -- for 'range'
    period_end          DATE,
    breakdown_filters   JSONB NOT NULL DEFAULT '{}',           -- {"county": ["Genesee"]}
    compare_prior       BOOLEAN NOT NULL DEFAULT FALSE,        -- adds the same period one year earlier
    document_template_id UUID                                   -- optional DOCX/PDF rendering
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

### Permissions

- Report VIEWs are `security_invoker`. A viewer's dashboard shows aggregates of rows they could list. There is no separate "reporting" permission in Phase 1.
- Breakdown VIEWs over small populations can re-identify people. Packs set a minimum cell size on breakdown VIEWs (suppress cells below 5 by default) when the breakdown column is a demographic. This is enforced in the generated VIEW, not in the widget.
- De-identified exports are a dedicated entity with their own `read` permission, granted to an analyst role.
- `register_report_measure()`, `register_module()` and report-definition writes are admin-only RPCs with in-body guards, per the function security rules.

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
| 2 | Phase 1 data access | Generate `security_invoker` VIEWs per measure. **Accepted 2026-11-03.** | A generic `report_measure_values()` RPC. More flexible for ad hoc periods, but needs a new widget data source and reimplements RLS in the RPC. Add later. |
| 3 | Where packs live | Woven deployment line, applied by automation. **Accepted 2026-11-02.** | Core migrations. Violates the instance-content rule and ties every instance to Woven's module vocabulary. |
| 4 | Outcomes in Phase 1 | No; outputs and demographics only. **Open**: not yet decided. | Ship indicator and measurement tables now. Doubles the People Served schema before a customer has asked for outcome tracking in the product. |
| 5 | Module registry scope | Table plus two functions, no dependency resolution | A full module system. Premature with zero modules installed anywhere. |

## Phasing

| Phase | Scope | Depends on |
|---|---|---|
| 1 | `metadata.dimensions`, `register_dimension()`, `dimension_subtree()` and the `Dimension` property type; Woven `programs` table registered as `program`; `metadata.modules` and guards; `metadata.report_measures` with VIEW generation; `people_served` and `volunteers` packs; dashboards over generated VIEWs; Excel export of report VIEWs | People Served module schema; chart widget (built) |
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
4. Small-cell suppression threshold: fixed at 5, or a config key?
5. How many accounting slots: two fixed, or a slot count read from the registry at migration time?
6. Should the accounting module and Money and Grants converge into one design, and with registered dimensions, can accounting move into `public` instead of its own schema? (Future research, outside this design.)
7. Should `register_module()` be called by the deployment automation rather than by each module's script, so the automation is the single source of truth for what is installed?

## References

- `docs/notes/DASHBOARD_DESIGN.md`, `docs/development/DASHBOARD_WIDGETS.md`: chart widget contract and the stat-card blocker.
- `docs/notes/ACCOUNTING_ATTRIBUTION_DESIGN.md`: dimensions, rate layer and the deferred funder report.
- `docs/notes/DOCUMENT_TEMPLATE_DESIGN.md`: DOCX and PDF delivery.
- `docs/notes/CUSTOM_PAGES_DESIGN.md`: candidate home for the Reports page.
- `docs/notes/INSTANCE_SETUP_DESIGN.md`: instance config store.
- `docs/notes/HHAP_SIZING_COMPARISON.md`: de-identified VIEWs and chart-over-`security_invoker` precedent.
- Sector sources: [2 CFR 200.301 performance measurement summary](https://dof.ca.gov/media/docs/budget/state-fiscal-recovery-fund/Outcomes-and-Outputs-Presentation.pdf), [Urban Institute common outcome framework](https://betterevaluation.org/sites/default/files/411404-Building-a-Common-Outcome-Framework-To-Measure-Nonprofit-Performance.PDF), [EEA Core Indicators Library](https://core-indicators.eeagrants.org/), [Kauffman Foundation outputs and outcomes guide](https://search.issuelab.org/resource/kauffman-foundation-grant-application-guide-developing-expected-outputs-and-outcomes), [AmeriCorps performance measure reporting, 45 CFR 2522.620](https://www.law.cornell.edu/cfr/text/45/2522.620).
