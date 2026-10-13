# Accounting Attribution — Design Document

> **Status:** Directional draft — not scheduled, not settled.
> **Created:** 2026-10-07
>
> **Read this before relying on anything below.** This document records the direction of a design conversation, not decisions. Every table, column, rule shape and phase here is tentative and expected to change when a real instance exercises it. The "Decisions" table lists leanings with their rationale so a future contributor can see why, not so they can treat them as fixed. If you are implementing from this document, re-open each leaning with the maintainer first.
> **Dependencies:** Causal bindings (v0.33.0+), Entity Actions dot-notation path resolution (v0.18.0+), Instance Config Store (`docs/notes/INSTANCE_SETUP_DESIGN.md`, for fiscal year), consolidated worker (`docs/development/GO_MICROSERVICES_GUIDE.md`, for API sync)

**Related Documentation:**
- `docs/development/PAYMENT_PROCESSING.md` — the module pattern this design copies (core-managed schema, bridge VIEW, auto-detected property type)
- `docs/notes/THIRD_PARTY_SYNC_DESIGN.md` — sync approaches for the export path
- `docs/development/ENTITY_ACTIONS.md` — dot-notation condition evaluation reused by posting rules
- `docs/INTEGRATOR_GUIDE.md` (Entity Notes System) — the polymorphic `entity_type` / `entity_id` source pattern reused here
- `docs/notes/SOFT_DELETE_DESIGN.md` — when soft delete lands, the archive flag becomes a reversal trigger

---

## Problem

Agencies running Civic OS keep their books in an external accounting system (QuickBooks or similar). That system sees a transaction only after money moves and never learns the operational context: which program the purchase was for, which funding source should pay for it, which case the disbursement belongs to, which site the staff hours were worked at. Bookkeepers reconstruct that context by hand from exports, and program staff cannot see whether a funding source has budget left before they approve a request.

Civic OS already holds the record where the decision is made: the reimbursement request, the purchase approval, the client assistance disbursement, the time entry, the volunteer shift. Attaching accounting dimensions at that record, recording every change to it as an immutable entry, and exporting coded entries removes the reconstruction step entirely.

## What this is, in one sentence

**A subledger with ledger discipline.** Civic OS generates the dimensioned side of each transaction (the expense, the hours, the disbursement, coded to account, program and funding source) from operational data. The external accounting system supplies the other side (cash, payables, payroll) and keeps the books.

## Non-goals

These are deliberate exclusions, not deferred phases. A contributor who finds themselves building any of these should stop and reread this section.

- **Not the general ledger.** No chart of accounts beyond a mirror of the external system's subset, no trial balance, no financial statements, no year-end close. The external accounting system stays authoritative.
- **Single-leg entries, no balancing.** Each entry records one dimensioned amount. The balancing leg (cash, clearing, payables) is the external system's concern. This is a decision, recorded below, not an omission.
- **No accrual accounting.** Two journals, commitment and actual. Receivables, payables aging and revenue recognition are out of scope.
- **No payroll.** Effort entries carry hours and an allocation; wage totals come from the payroll provider.
- **No books-of-record liability.** Nothing here produces a document an auditor would treat as the agency's ledger.

## Ledger discipline

The reason this module exists rather than a report over domain tables: **domain rows mutate; exports do not.** A reimbursement amount is edited after approval, a funding-source tag is corrected, a record is deleted. The file sent to the bookkeeper last month said something else. Every question an accountant asks of an export (when did this change, why, what moved between last month and this one) is answered by three rules:

1. **Nothing recorded is ever updated or deleted.** A change to an attributed fact is a new entry that names the entry it corrects. A trigger raises `entry_immutable:` on any UPDATE or DELETE of an entry outside the sync-state columns.
2. **A period closes when it is exported.** Entries cannot be created with an effective date inside a closed period; the function raises `period_locked:`. A correction to a closed-period fact is dated in the open period and carries `corrects_entry_id`, so "changes since the last export" is a query over the batch, not forensics.
3. **Every entry has an author and a reason.** Trigger-generated entries get a generated reason (`amount 120.00 → 95.00 by <user>`). Manual corrections and reversals require one.

These rules apply to **every create, update and delete of a budget-tied record**, not only to status transitions. Approving a request creates a commitment entry; paying it reverses the commitment and creates an actual; editing the amount afterwards creates a delta; changing the funding source creates a reclassification pair; deleting the record reverses whatever is outstanding. The operational record is never blocked from changing. The ledger records that it changed.

## Architecture Overview

The payments module is the template. It established the pattern of a **core-managed schema outside `public`**, exposed through **bridge VIEWs** that the generic CRUD pages render, **linked from domain tables by a UUID FK** that the frontend detects as a dedicated property type, and extended by **RPCs rather than direct writes**.

| Payments module | Accounting module |
|---|---|
| `payments` schema, Sqitch-managed, no direct table grants | `accounting` schema, same posture |
| `public.payment_transactions` bridge VIEW | `public.funding_sources`, `public.programs`, `public.ledger_entries` bridge VIEWs with `security_invoker = true` |
| Domain row → `payments.transactions` (one payment per row) | Domain row → `accounting.funding_sources` / `accounting.programs` (a dimension tag); `accounting.entries` → domain row (polymorphic, many entries per row over its life) |
| `Payment` property type detected by `join_schema = 'payments'` | `FundingSource` and `Program` property types detected by `join_schema = 'accounting'` |
| `payment_initiation_rpc` on `metadata.entities` | `metadata.posting_rules` resolved by one generic reconcile function, fired from a row-change trigger and registered as a causal binding |
| Payment worker (Stripe) | None at first; a worker job later for API sync to the external system |
| RLS: users see their own payments | RLS: `ledger_entries` read/create permissions, no ownership filter |

Two intentional departures from the payments analogy:

1. **The ledger points at the domain, not the reverse.** A domain row carries dimension FKs (which fund, which program) but no link to its entries. Entries reference the row through `source_entity` + `source_id`, exactly as `metadata.entity_notes` does. The domain table never changes shape to accommodate the ledger.
2. **Access is role-scoped, not ownership-scoped.** The staff member who submitted a reimbursement never needs to see the entries it produced. Finance staff need to see all of them.

### Data flow

```
Domain row is inserted, updated or deleted (any path: action RPC, Edit page, import, API)
    → AFTER INSERT/UPDATE/DELETE trigger accounting.post_on_change() on the domain table
    → accounting.reconcile_source(entity, id):
        for each enabled posting rule on this entity:
            target  = resolve(rule, NEW row)   -- journal, valuation (amount, or quantity × rate from the record or a rate schedule), account, program, funding source; or NULL if the row is not in a posting state
            current = net of existing entries for (source, rule) grouped by (journal, dimension tuple)
            emit the entries that move current to target:
                nothing outstanding and target present  → initial entry
                same tuple, different amount            → delta entry
                different tuple                          → reversal on old tuple + initial on new tuple (one reclass pair, shared correlation id)
                target absent (denied, deleted, left the posting state) → reversal of net
            resolution failure → row in accounting.exceptions; no entry
    → effective_date = the row's natural date if its period is open, else today with corrects_entry_id set
Bookkeeper opens /admin/accounting
    → Clears exceptions (fixes a rule or a dimension tag, then re-reconciles the source)
    → Exports: a batch is everything posted since the previous batch, including corrections to earlier periods
    → Closing the batch closes its period; entries move pending → exported → synced
```

Reconcile-to-target is deliberately stateless with respect to the trigger. It does not care which column changed or whether the change came from an action, an Edit page save or a bulk import; it compares what the ledger says about the source with what the rules say it should say now, and emits the difference. This is what makes "every create, update and delete" tractable without a transition counter.

## Database Schema

### Dimensions

```sql
CREATE SCHEMA accounting;

-- Mirror of the subset of the external chart of accounts this instance posts to.
-- Not a chart of accounts in its own right; external_id is the key that matters.
CREATE TABLE accounting.accounts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id   TEXT,                         -- QuickBooks Account.Id or equivalent
    code          TEXT,                         -- optional account number
    display_name  TEXT NOT NULL,
    account_kind  TEXT NOT NULL CHECK (account_kind IN ('expense','revenue','asset','liability','equity')),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Program / functional class. Maps to QuickBooks "Class" in nonprofit practice.
CREATE TABLE accounting.programs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id   TEXT,
    display_name  TEXT NOT NULL,
    parent_id     UUID REFERENCES accounting.programs(id),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON accounting.programs(parent_id);

-- Grant, restricted gift, general fund, appropriation: anything with a budget and a period.
CREATE TABLE accounting.funding_sources (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id    TEXT,                        -- QuickBooks Customer (funder) id, if used
    display_name   TEXT NOT NULL,
    source_kind    TEXT NOT NULL CHECK (source_kind IN ('grant','restricted_gift','general','appropriation','other')),
    period_start   DATE,
    period_end     DATE,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);

-- Budget by funding source, optionally narrowed to account and program.
CREATE TABLE accounting.funding_source_budget_lines (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    funding_source_id  UUID NOT NULL REFERENCES accounting.funding_sources(id) ON DELETE CASCADE,
    account_id         UUID REFERENCES accounting.accounts(id),
    program_id         UUID REFERENCES accounting.programs(id),
    display_name       TEXT NOT NULL,
    amount             NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
    period_start       DATE,
    period_end         DATE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON accounting.funding_source_budget_lines(funding_source_id);
CREATE INDEX ON accounting.funding_source_budget_lines(account_id);
CREATE INDEX ON accounting.funding_source_budget_lines(program_id);
```

Dimensions are **fixed columns**, not a generic axis junction. Three dimensions (account, program, funding source) cover the civic use cases, and fixed columns keep PostgREST embeds, RLS predicates, budget-vs-actual SQL and property-type detection simple. A fourth generic axis can be added later as a nullable column without touching existing rows.

### Periods and export batches

```sql
-- One row per fiscal period. Created lazily by the first entry dated inside it.
-- Fiscal year start month comes from the Instance Config Store.
CREATE TABLE accounting.periods (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_start  DATE NOT NULL,
    period_end    DATE NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    closed_at     TIMESTAMPTZ,
    closed_by_batch_id UUID,                       -- FK added after export_batches exists
    UNIQUE (period_start, period_end),
    CHECK (period_end >= period_start)
);

CREATE TABLE accounting.export_batches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_id       UUID NOT NULL REFERENCES accounting.periods(id),
    -- Cutoff: every entry with posted_at <= cutoff_at that is not yet in a batch belongs to this one.
    -- That includes corrections whose effective_date is in this period but which fix earlier periods.
    cutoff_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    format          TEXT NOT NULL CHECK (format IN ('csv','qbo_api')),
    export_unit     TEXT NOT NULL CHECK (export_unit IN ('per_entry','summarized')),
    include_commitments BOOLEAN NOT NULL DEFAULT FALSE,   -- commitments are usually internal
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','exported','synced','failed','voided')),
    entry_count     INT NOT NULL DEFAULT 0,
    total_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
    file_id         UUID REFERENCES metadata.files(id),  -- the generated CSV, stored like any other file
    created_by      UUID REFERENCES metadata.civic_os_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    exported_at     TIMESTAMPTZ,
    synced_at       TIMESTAMPTZ
);
ALTER TABLE accounting.periods
    ADD CONSTRAINT periods_closed_by_batch_fk FOREIGN KEY (closed_by_batch_id) REFERENCES accounting.export_batches(id);
```

Marking a batch `exported` closes its period. Voiding a batch (allowed only while it is the most recent batch) reopens the period and returns its entries to `pending`. A period may have more than one batch only through void-and-redo.

### Entries

`metadata.posting_rules` (next section) and `accounting.rates` (Valuation section) are created before `accounting.entries` because the entry references both.

```sql
CREATE TABLE accounting.entries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which journal, what kind of movement
    journal             TEXT NOT NULL CHECK (journal IN ('commitment','actual')),
    entry_kind          TEXT NOT NULL CHECK (entry_kind IN ('initial','delta','reclass','reversal','manual')),
    movement            TEXT NOT NULL CHECK (movement IN ('expense','disbursement','receipt','effort','in_kind')),

    -- When
    effective_date      DATE NOT NULL,                     -- the date the fact belongs to (natural date if period open, else today)
    posted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),-- when the ledger learned it; drives export batching
    period_id           UUID NOT NULL REFERENCES accounting.periods(id),

    -- How much (single leg, signed; reversals and negative deltas carry the opposite sign)
    amount              NUMERIC(14,2) NOT NULL,
    -- Valuation provenance: what was true when this entry was recorded. Denormalized on purpose;
    -- a funder audit must reproduce the amount from the entry alone.
    quantity            NUMERIC(12,4),                     -- hours, items, miles; NULL when valuation_kind = 'amount'
    rate                NUMERIC(12,4),                     -- the rate applied, NULL when valuation_kind = 'amount'
    rate_id             UUID REFERENCES accounting.rates(id),  -- NULL when the rate came from the record itself
    rate_basis          TEXT,                              -- copied from rates.basis, or 'record: staff_members.pay_rate'
    description         TEXT,

    -- Dimensions (the "debit side"; the balancing leg lives in the external system)
    account_id          UUID NOT NULL REFERENCES accounting.accounts(id),
    program_id          UUID REFERENCES accounting.programs(id),
    funding_source_id   UUID REFERENCES accounting.funding_sources(id),

    -- Provenance
    source_entity       NAME NOT NULL,
    source_id           TEXT NOT NULL,
    posting_rule_id     INT REFERENCES metadata.posting_rules(id) ON DELETE SET NULL,
    correlation_id      UUID,                              -- shared by the two halves of a reclass pair
    reverses_entry_id   UUID REFERENCES accounting.entries(id),
    corrects_entry_id   UUID REFERENCES accounting.entries(id), -- set when effective_date was pushed forward past a closed period
    reason              TEXT NOT NULL,                     -- generated for trigger entries, required for manual ones
    created_by          UUID NOT NULL REFERENCES metadata.civic_os_users(id),

    -- The only mutable columns
    sync_state          TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','exported','synced','failed','excluded')),
    export_batch_id     UUID REFERENCES accounting.export_batches(id),
    external_id         TEXT,                              -- id of the Bill / JournalEntry created externally
    sync_error          TEXT,

    CHECK (entry_kind <> 'reversal' OR reverses_entry_id IS NOT NULL),
    CHECK (entry_kind <> 'reclass'  OR correlation_id IS NOT NULL),
    CHECK (movement   <> 'effort'   OR quantity IS NOT NULL)
);
CREATE INDEX ON accounting.entries(source_entity, source_id);
CREATE INDEX ON accounting.entries(funding_source_id, journal, effective_date);
CREATE INDEX ON accounting.entries(program_id, journal, effective_date);
CREATE INDEX ON accounting.entries(account_id);
CREATE INDEX ON accounting.entries(period_id);
CREATE INDEX ON accounting.entries(posted_at) WHERE export_batch_id IS NULL;
CREATE INDEX ON accounting.entries(export_batch_id);
CREATE INDEX ON accounting.entries(posting_rule_id);
CREATE INDEX ON accounting.entries(reverses_entry_id);
CREATE INDEX ON accounting.entries(corrects_entry_id);
CREATE INDEX ON accounting.entries(correlation_id) WHERE correlation_id IS NOT NULL;

-- Immutability. Raises 'entry_immutable:' unless only the sync columns change.
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON accounting.entries
    FOR EACH ROW EXECUTE FUNCTION accounting.enforce_entry_immutability();

-- Period lock. Raises 'period_locked:' when effective_date falls in a closed period.
CREATE TRIGGER entries_period_lock BEFORE INSERT ON accounting.entries
    FOR EACH ROW EXECUTE FUNCTION accounting.enforce_period_open();

-- Exceptions are not ledger facts, so they live in a mutable side table.
CREATE TABLE accounting.exceptions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_entity   NAME NOT NULL,
    source_id       TEXT NOT NULL,
    posting_rule_id INT REFERENCES metadata.posting_rules(id) ON DELETE CASCADE,
    reason          TEXT NOT NULL,                         -- 'funding_source_ref path:site_id.funding_source_id resolved to NULL'
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    UNIQUE (source_entity, source_id, posting_rule_id)
);
```

Amounts are `NUMERIC(14,2)`, matching `payments.transactions`, not the PostgreSQL `money` type (locale-dependent formatting, no fractional-cent safety). The frontend `Money` display type should be mapped to these columns via the bridge VIEWs.

Why single-leg rather than balanced two-line entries: the balancing leg of every entry here is an account the external system owns (cash, payables, payroll clearing). Recording it in Civic OS would mean inventing clearing accounts whose only purpose is to make a constraint pass, and reconciling them against a system that is already authoritative for them. The one place balancing earns its keep, a reclassification between funding sources, is handled by emitting the pair under one `correlation_id` and checking in the reconcile function that the pair nets to zero before either row is inserted. The named refusal is `reclass_unbalanced:`.

### Posting rules

```sql
CREATE TABLE metadata.posting_rules (
    id                    SERIAL PRIMARY KEY,
    entity_type           NAME NOT NULL,                  -- table name, e.g. 'reimbursements'
    display_name          VARCHAR(100) NOT NULL,
    description           TEXT,

    -- Which journal this rule feeds, and when the row is "in" it.
    -- A row is in the journal while condition evaluates true; leaving it emits a reversal.
    journal               TEXT NOT NULL CHECK (journal IN ('commitment','actual')),
    condition             TEXT NOT NULL,                  -- dot-notation, same grammar as entity action visible_when; e.g. "status_id.status_key = 'approved'"

    -- What
    movement              TEXT NOT NULL,                  -- expense | disbursement | receipt | effort | in_kind
    effective_date_path   TEXT,                           -- 'approved_at', 'paid_at'; defaults to the row's updated_at
    description_template  TEXT,                           -- '{display_name} reimbursement'

    -- How much (see Valuation). Exactly the columns the valuation_kind needs are non-null; a CHECK enforces it.
    valuation_kind        TEXT NOT NULL CHECK (valuation_kind IN
                            ('amount','quantity_x_record_rate','quantity_x_schedule_rate','percent_of_rule','rpc')),
    amount_path           TEXT,                           -- 'amount', 'line_items.total'            (amount)
    quantity_path         TEXT,                           -- 'hours', 'quantity', 'miles'            (quantity_x_*)
    rate_path             TEXT,                           -- 'path:staff_member_id.pay_rate'          (quantity_x_record_rate)
    rate_schedule_id      UUID,                           -- FK to accounting.rate_schedules          (quantity_x_schedule_rate, percent_of_rule)
    rate_key_path         TEXT,                           -- 'path:volunteer_role_id'; NULL for a flat schedule
    base_rule_id          INT REFERENCES metadata.posting_rules(id), -- the rule whose amount this is a percent of (percent_of_rule)
    rpc_function          NAME,                           -- function(entity_type, record_id) RETURNS NUMERIC (rpc)

    -- Where (literal UUID or dot-notation path on the record)
    account_ref           TEXT NOT NULL,                  -- 'uuid:…' or 'path:site_id.expense_account_id'
    program_ref           TEXT,                           -- 'path:program_id' or 'path:site_id.program_id'
    funding_source_ref    TEXT,                           -- 'path:funding_source_id'

    is_enabled            BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order            INT NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON metadata.posting_rules(entity_type) WHERE is_enabled;
```

A typical entity has two rules: one feeding `commitment` while `status_key = 'approved'`, one feeding `actual` while `status_key = 'paid'`. When a row moves from approved to paid, reconcile sees the commitment rule's condition go false (reversal) and the actual rule's condition go true (initial) in the same transaction. No explicit transition table is needed; the rule's `condition` is the state predicate.

`*_ref` columns use a small prefixed grammar (`uuid:` literal, `path:` dot-notation on the record) so a single rule can say "program comes from the site this staff member belongs to" without a per-entity RPC. Path resolution reuses the resolver that evaluates entity action `visible_when` / `enabled_when` conditions; the MCP server already has a TypeScript implementation of that grammar and the SQL implementation should match it rather than invent a new one.

Escape hatch: `valuation_kind = 'rpc'` calls `rpc_function(entity_type, record_id)` expecting `NUMERIC`. Integrators should reach for this rarely; the Valuation section exists so they almost never have to.

### Valuation

A dollar amount for a non-money record is always `quantity × rate`. What varies between agencies is **where the rate comes from**, and that variation is the whole reason this section exists: without it every valued quantity needs a precomputed dollar column on the domain table or a per-instance RPC.

| Rate lives | Example | Varies by |
|---|---|---|
| On the record or a related record | a staff member's `pay_rate`; an inventory item's `unit_value` | the person or the item |
| In a schedule the agency maintains | volunteer hour value (a national figure is published yearly); mileage; a swag unit cost | category and time |
| In a schedule a funder dictates | a grant that values volunteer hours differently from the national figure; a negotiated indirect rate | funding source and time |
| As a percentage of another valued amount | fringe on salary; de minimis indirect on direct costs | derived |

```sql
-- A named schedule. The framework ships schedules (e.g. volunteer_hour_value) with no rows;
-- rates are instance data and go stale, so they are never seeded.
CREATE TABLE accounting.rate_schedules (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_key  TEXT NOT NULL UNIQUE,                   -- 'volunteer_hour_value', 'mileage', 'fringe_pct'
    display_name  TEXT NOT NULL,
    unit_label    TEXT NOT NULL,                          -- 'hour', 'item', 'mile', '%'
    rate_kind     TEXT NOT NULL CHECK (rate_kind IN ('per_unit','percent')),
    keyed_by      TEXT,                                   -- NULL for a flat schedule; otherwise a description such as 'volunteer_roles.id'
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only, time-versioned. Changing a rate closes the old range and inserts a new row;
-- posted entries keep the rate they were valued with (see rate_id / rate_basis on entries).
CREATE TABLE accounting.rates (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id        UUID NOT NULL REFERENCES accounting.rate_schedules(id),
    key                TEXT,                              -- the FK value when the schedule is keyed; NULL = default for the schedule
    funding_source_id  UUID REFERENCES accounting.funding_sources(id),  -- NULL = applies to every funding source
    effective_from     DATE NOT NULL,
    effective_to       DATE,                              -- NULL = open-ended
    rate               NUMERIC(12,4) NOT NULL,
    basis              TEXT NOT NULL,                     -- 'Independent Sector 2026 national value', 'Grant agreement §4.2'
    created_by         UUID NOT NULL REFERENCES metadata.civic_os_users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
    EXCLUDE USING gist (schedule_id WITH =, COALESCE(key,'') WITH =, COALESCE(funding_source_id, '00000000-0000-0000-0000-000000000000') WITH =,
                        daterange(effective_from, effective_to, '[]') WITH &&)
);
CREATE INDEX ON accounting.rates(schedule_id, key, effective_from);
CREATE INDEX ON accounting.rates(funding_source_id) WHERE funding_source_id IS NOT NULL;
```

**Resolution** for a rule of kind `quantity_x_schedule_rate`, given the entry's effective date, resolved key and resolved funding source:

1. a row matching schedule + key + funding source;
2. else schedule + key, any funding source;
3. else schedule + no key + funding source;
4. else schedule + no key (the flat default);
5. else `rate_unresolved:` and an exception row.

**Valuation kinds:**

| `valuation_kind` | Inputs | Result |
|---|---|---|
| `amount` | `amount_path` | money already on the record; `quantity`, `rate` NULL |
| `quantity_x_record_rate` | `quantity_path`, `rate_path` | no rate table needed; the record is the authority; `rate_basis = 'record: <path>'` |
| `quantity_x_schedule_rate` | `quantity_path`, `rate_schedule_id`, optional `rate_key_path` | looked up as above; `rate_id` and `rate_basis` copied onto the entry |
| `percent_of_rule` | `base_rule_id`, `rate_schedule_id` (a `percent` schedule) | its own entry, so direct and indirect cost appear separately to a funder; evaluated after the base rule in the same reconcile pass |
| `rpc` | `rpc_function` | escape hatch |

**Revaluation falls out of reconcile-to-target.** The rate is part of the target, so inserting a new rate row for a date range and running `reconcile_source()` over the affected sources produces delta entries with reason `rate 33.4900 → 34.8000 (basis: …)`, dated in the open period when the original period is closed. A rate correction is an auditable event, not a silent restatement. `revalue_rate()` below is the gesture that queues that pass.

**Quantity derivation is the real integrator pitfall, not valuation.** A rule needs a number on a row. Instances whose time tracking is event-style (separate clock-in and clock-out rows) have no such number; they need a durations table or VIEW materialized into a table, or a rule on the clock-out row with `valuation_kind = 'rpc'`. The Integrator Guide should show the durations-table pattern once so nobody reinvents it.

### Helper functions

```sql
-- Attach the posting trigger to a domain table. Idempotent. Also registers each rule
-- through add_status_transition() / add_property_change_trigger() so the introspection graph shows it.
CREATE FUNCTION public.enable_accounting_posting(p_table_name NAME) RETURNS VOID ...;

-- Declare a rule without writing INSERT statements. Mirrors add_status_transition(); validates that
-- the columns the valuation_kind needs are present and that any path resolves against the entity's schema.
CREATE FUNCTION public.add_posting_rule(
    p_entity_type NAME, p_journal TEXT, p_condition TEXT, p_movement TEXT,
    p_valuation_kind TEXT, p_account_ref TEXT,
    p_amount_path TEXT DEFAULT NULL, p_quantity_path TEXT DEFAULT NULL, p_rate_path TEXT DEFAULT NULL,
    p_rate_schedule_key TEXT DEFAULT NULL, p_rate_key_path TEXT DEFAULT NULL, p_base_rule_id INT DEFAULT NULL,
    p_rpc_function NAME DEFAULT NULL,
    p_program_ref TEXT DEFAULT NULL, p_funding_source_ref TEXT DEFAULT NULL,
    p_effective_date_path TEXT DEFAULT NULL, p_display_name VARCHAR(100) DEFAULT NULL, p_description TEXT DEFAULT NULL
) RETURNS INT ...;

-- Row-level trigger function: AFTER INSERT OR UPDATE OR DELETE. Calls reconcile_source().
CREATE FUNCTION accounting.post_on_change() RETURNS TRIGGER ...;

-- Core. Compares the ledger's net position for (source, rule) with what the rules say now
-- and inserts the entries that close the gap. SECURITY DEFINER so it can read dimension tables;
-- checks has_permission(p_entity_type, 'update') on the caller first.
CREATE FUNCTION accounting.reconcile_source(p_entity_type NAME, p_record_id TEXT, p_reason TEXT DEFAULT NULL)
    RETURNS SETOF UUID ...;

-- Manual gestures, each the whole gesture: insert the mirror (or the correction), nothing else.
CREATE FUNCTION public.reverse_entry(p_entry_id UUID, p_reason TEXT, p_effective_date DATE DEFAULT CURRENT_DATE) RETURNS UUID ...;
CREATE FUNCTION public.reclassify_entries(p_entry_ids UUID[], p_program_id UUID, p_funding_source_id UUID, p_reason TEXT) RETURNS UUID ...; -- returns correlation_id

-- Re-run reconcile for an exception's source after a rule or dimension tag was fixed.
CREATE FUNCTION public.resolve_accounting_exception(p_exception_id UUID) RETURNS SETOF UUID ...;

-- Rates. set_rate closes any open range for the same schedule/key/funding source and inserts the new row.
-- revalue_rate re-runs reconcile for every source whose entries used a rate this one supersedes (queued, not inline).
CREATE FUNCTION public.set_rate(p_schedule_key TEXT, p_rate NUMERIC, p_basis TEXT, p_effective_from DATE,
                                p_key TEXT DEFAULT NULL, p_funding_source_id UUID DEFAULT NULL) RETURNS UUID ...;
CREATE FUNCTION public.revalue_rate(p_rate_id UUID, p_reason TEXT) RETURNS INT ...;  -- returns count of sources queued

-- Budget position for a funding source as of a date, by journal.
CREATE FUNCTION public.funding_source_position(p_funding_source_id UUID, p_as_of DATE DEFAULT CURRENT_DATE)
    RETURNS TABLE (budgeted NUMERIC, committed NUMERIC, actual NUMERIC, remaining NUMERIC) ...;

-- Export. Creates the batch, assigns every unbatched entry with posted_at <= cutoff, renders the file.
CREATE FUNCTION public.create_export_batch(p_period_id UUID, p_format TEXT, p_export_unit TEXT, p_include_commitments BOOLEAN) RETURNS UUID ...;
CREATE FUNCTION public.mark_batch_exported(p_batch_id UUID) RETURNS VOID ...;  -- closes the period
CREATE FUNCTION public.void_batch(p_batch_id UUID, p_reason TEXT) RETURNS VOID ...;  -- most recent batch only; reopens the period
```

Named refusals, all with stable SQLSTATEs so `ErrorService.parseToHuman()` can translate them: `entry_immutable:`, `period_locked:`, `reclass_unbalanced:`, `batch_not_latest:`, `rule_unresolved:`, `rate_unresolved:`, `rate_overlap:`.

Why a row trigger rather than hooking entity actions: approvals happen through entity actions today, but amounts and tags also change through Edit pages, bulk imports, guided-form steps and the API. A row-change trigger with reconcile-to-target is the one mechanism that covers every path. The bindings are still registered so they appear in the System Introspection graph and the Entity Code page.

### Bridge VIEWs, grants, RLS

```sql
CREATE VIEW public.ledger_entries WITH (security_invoker = true) AS
    SELECT e.*, a.display_name AS account_name, p.display_name AS program_name,
           fs.display_name AS funding_source_name, per.period_start, per.period_end, per.status AS period_status
    FROM accounting.entries e
    JOIN accounting.accounts a   ON a.id = e.account_id
    JOIN accounting.periods per  ON per.id = e.period_id
    LEFT JOIN accounting.programs p         ON p.id = e.program_id
    LEFT JOIN accounting.funding_sources fs ON fs.id = e.funding_source_id;

CREATE VIEW public.funding_sources WITH (security_invoker = true) AS SELECT * FROM accounting.funding_sources;
CREATE VIEW public.programs         WITH (security_invoker = true) AS SELECT * FROM accounting.programs;
CREATE VIEW public.accounting_exceptions WITH (security_invoker = true) AS SELECT * FROM accounting.exceptions;
CREATE VIEW public.funding_source_positions AS ...;  -- budgeted / committed / actual / remaining per source, by period

GRANT USAGE ON SCHEMA accounting TO authenticated;
GRANT SELECT ON accounting.accounts, accounting.programs, accounting.funding_sources TO authenticated;
GRANT SELECT ON accounting.entries, accounting.exceptions, accounting.periods,
                accounting.funding_source_budget_lines, accounting.export_batches TO authenticated;
-- No INSERT/UPDATE/DELETE grants on accounting.* to any API role. All writes go through triggers and RPCs.
```

RLS on the base tables:

| Table | SELECT | Writes |
|---|---|---|
| `accounts`, `programs`, `funding_sources` | all `authenticated` (dimension names must render on domain Detail pages and in dropdowns) | RPC only, gated on `has_permission('funding_sources','update')` |
| `funding_source_budget_lines` | `has_permission('funding_sources','read')` | RPC only, same gate |
| `entries`, `exceptions`, `periods` | `has_permission('ledger_entries','read')` | trigger + RPC only; manual gestures gated on `has_permission('ledger_entries','create')` |
| `export_batches` | `has_permission('ledger_entries','read')` | RPC only, gated on `has_permission('ledger_entries','update')` |

Permission rows for `funding_sources` and `ledger_entries` are seeded for `manager` and `admin`. An instance that wants a bookkeeper role grants those two entities to it and nothing else. The dimension tables deliberately open SELECT to all authenticated users so a `FundingSource` dropdown works for the person submitting a request; the budget and the entries behind the dimension do not.

Register `ledger_entries`, `funding_sources` and `programs` in `metadata.entities` with `show_in_sidebar = false` so the generic List and Detail pages work for them but they are reached from the admin page.

## Frontend

### Property type detection

Add `FundingSource` and `Program` to `EntityPropertyType`. Detect in `SchemaService.getPropertyType()` next to the `Payment` branch:

```typescript
} else if (val.join_schema === 'accounting' && val.join_table === 'funding_sources') {
  return EntityPropertyType.FundingSource;   // also matches the public.funding_sources bridge VIEW
} else if (val.join_schema === 'accounting' && val.join_table === 'programs') {
  return EntityPropertyType.Program;
}
```

`propertyToSelectString()` embeds `(id, display_name)` for both, plus `source_kind, period_end` for `FundingSource` so the display component can badge a lapsed period. Edit renders as the standard FK dropdown with search modal. Both must be added as entity action param types (see the maintenance note on Entity Action Buttons in `CLAUDE.md`).

### Detail page section

Any record with rows in `ledger_entries` for its `(entity_type, id)` gets a "Financial" section below properties, rendered only for users with `ledger_entries:read`. It shows the current net position per journal and dimension tuple, then the entry history: kind, effective date, amount, dimensions, reason, author, sync state, and the external id as a link when the adapter can build one. An entry whose `effective_date` was pushed forward past a closed period is marked "corrects <date>" so the reader sees why this month's export contains last month's fact.

### Admin page `/admin/accounting`

Follows `docs/notes/ADMIN_PAGE_PITFALLS.md` (read-only VIEWs + RPCs, multi-phase `effect()` loading). Tabs:

1. **Exceptions** — unresolved rows from `accounting_exceptions`, with the reason and a Resolve button that calls `resolve_accounting_exception()`.
2. **Unbatched** — entries with no batch, filterable by journal, funding source and whether they correct a prior period.
3. **Export** — pick the open period, export unit and whether to include commitments; preview totals by account and program and the count of prior-period corrections; create the batch; download the file; mark exported (closes the period).
4. **Batches** — history with status, counts, totals, error text, and Void on the most recent.
5. **Dimensions** — accounts, programs, funding sources, budget lines (standard CRUD pages embedded or linked).
6. **Rates** — schedules and their rate history; "set new rate" closes the current range; "revalue" on a rate row queues the reconcile pass and reports how many sources it touched.

### Dashboard widget

`funding_source_position` as a widget type (or a filtered-list widget over `public.funding_source_positions`), showing budgeted, committed, actual, remaining per funding source. Register in the widget registry per `docs/development/DASHBOARD_WIDGETS.md`.

## Export

A batch is **everything posted since the previous batch**, selected by `posted_at`, not by `effective_date`. That is what makes prior-period corrections appear in the current export with their `corrects_entry_id`, which is the "what changed since last month" report bookkeepers actually want. Commitments are excluded by default; they are budget-control information for the agency, not transactions for the books.

### Phase 1: CSV

One file per batch, fixed columns so a bookkeeper builds a saved import mapping once:

```
entry_id, journal, entry_kind, movement, effective_date, posted_at, amount, quantity, rate, rate_basis, description, reason,
account_code, account_name, account_external_id,
program_name, program_external_id,
funding_source_name, funding_source_external_id,
source_entity, source_id, source_display_name,
reverses_entry_id, corrects_entry_id, corrects_effective_date, correlation_id
```

`summarized` groups by `(effective_date month, account, program, funding_source)` and emits one line per group with the entry-level columns empty; corrections to prior periods are summarized separately with `corrects_effective_date` set so they can be booked as a current-period adjustment. `per_entry` emits one line per entry. The generated file is stored through the existing file storage and attached to the batch.

### Phase 2: API sync via the worker

A River job `accounting_export_batch` reads an open batch and creates external objects. For QuickBooks Online:

| Movement | `per_entry` | `summarized` |
|---|---|---|
| `expense`, `disbursement` | Bill or Purchase with Class and Customer (funder) | JournalEntry lines by account/class |
| `receipt` | SalesReceipt with Class | JournalEntry |
| `effort`, `in_kind` | JournalEntry (allocation or in-kind pair) | JournalEntry |
| reversals and reclass pairs | reversing JournalEntry referencing the original external id | netted into the summary |

The balancing leg each external object needs (cash account, payables, clearing) is configured per instance in the Instance Config Store as an external account id; it never appears in `accounting.entries`. OAuth2 credentials also live in the Instance Config Store so an admin can connect without a redeploy. Idempotency uses the batch id as the external request id where the API supports it; otherwise the worker records `external_id` on the entry before moving on so a retry never double-posts.

**Unverified assumption:** QuickBooks Online's native CSV import of journal entries is reported to be gated by edition, and IIF import is Desktop-only. Confirm before promising the Phase 1 CSV as a QuickBooks Online import path rather than a bookkeeper reference file.

### Inbound actuals (optional Phase 3)

A pull job reading the external system's actuals by account and class into `accounting.external_actuals` for budget-vs-actual widgets. Read-only; never reconciles against `accounting.entries`.

## Prior art

Ekwo OS (AGPL-3.0, `github.com/Ekwo-ai/ekwo-os`) is the reference for the discipline rules: posted-entry immutability enforced by trigger, lock dates that raise named refusals (`period_locked:`), and corrections as a single function that writes the mirror and names the original (`reverse_entry`). Copy those shapes. Do not copy its balanced `entry_lines`, its generic analytic-axes junction, or its chart of accounts; this design's single-leg entries with fixed dimension columns are the deliberate alternative. AGPL-3.0 to AGPL-3.0 copying is permitted with attribution preserved; do not sign their Contributor Licence Agreement for anything flowing the other direction, since it grants relicensing rights.

## Decisions (tentative leanings, not commitments)

| Decision | Leaning | Rationale |
|---|---|---|
| Valuation as a layer vs dollar columns on domain tables | Layer: rate on the record, or a time-versioned schedule with funding-source overrides, or a percent of another rule | Eliminates per-instance RPCs and precomputed dollar columns; rate provenance is stored on the entry so a rate change never restates history |
| Rate changes | Append-only rows; revaluation posts deltas via reconcile | A rate correction is an auditable event, not a silent restatement |
| Seeded rates | Ship schedules, never rates | Published figures go stale; a stale seeded number gets audited |
| Ledger discipline vs mutable event log | Discipline: immutable entries, period lock on export, corrections post forward with references, author and reason on every row | Domain rows mutate; exports do not. Accountants ask when, why and what changed since last export; only an append-only record answers |
| Single-leg vs balanced two-line entries | Single-leg | The balancing leg is always an account the external system owns; recording it here means reconciling against a system already authoritative for it. Reclass pairs are checked to net to zero in the function instead |
| Trigger scope | Every INSERT/UPDATE/DELETE on a budget-tied table, reconcile-to-target | Covers Edit pages, imports and the API, not only action buttons; no transition counter needed |
| Dimension vocabulary | Match QuickBooks (Account, Class, Customer-as-funder) | A later fund-native model needs a mapping layer; acceptable |
| Dimensions as fixed columns vs generic axis junction | Fixed columns | Simpler embeds, RLS and SQL; a fourth axis is one nullable column later |
| Amount type | `NUMERIC(14,2)` | Matches payments module; `money` rejected for locale dependence |
| Rules as metadata vs SQL | Metadata with `rpc:` escape hatch | Consistent with notifications and actions |
| Default export unit | `summarized`, commitments excluded | Clean external books, detail stays here; `per_entry` when a bookkeeper wants each payee visible externally |
| Editing a record whose entries are in a closed period | Allowed; a correction posts in the open period | The operational record is never blocked; the ledger records that it changed |
| Fiscal year | Instance Config Store key | Period boundaries; July–June is common for the target users |

## Phasing

1. **Dimensions, rules, entries with immutability and period locks, exceptions, CSV export with batch close, admin page, Detail section, property types.** Valuation kinds `amount` and `quantity_x_record_rate` only. First source: expense and reimbursement requests (commitment while approved, actual while paid).
2. **Effort entries** from time entries (hours × a pay-rate path), plus **rate schedules** with funding-source overrides and `percent_of_rule` for fringe and indirect; monthly summarized export as an allocation journal entry. The durations-table pattern documented here.
3. **API sync** through the worker; Instance Config Store for credentials and balancing-leg accounts.
4. **Budget lines by period** and the funder report (operational counts joined with cost by funding source).
5. **In-kind** from volunteer hours; **receipts** from `payments.transactions` as a source if an instance wants it (a posting rule on `payments.transactions` with `condition = "status = 'succeeded'"`).

Phase 1 is somewhat larger than the payments module at v0.13 through v0.14; the additions over a flat event table are the period and immutability triggers, reconcile-to-target, and the reclass pair check.

## Documentation to ship with Phase 1

- `CLAUDE.md` index line (planned line already present; update to versioned on release)
- `docs/INTEGRATOR_GUIDE.md` — Accounting Attribution section: enabling posting on an entity, `add_posting_rule()` with one example per valuation kind, the `*_ref` grammar, the durations-table pattern for event-style time tracking, setting and revaluing rates, what happens on edit and delete, period close and corrections, permissions for a bookkeeper role, export workflow
- This document, updated with decisions taken
- i18n keys for the admin page, Detail section, property types, named refusals, and the `a11y.` labels
- Schema decision via `create_schema_decision()` for the `accounting` schema and for each instance that enables posting
