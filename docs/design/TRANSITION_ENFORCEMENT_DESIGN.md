# Transition Enforcement System — Design Decisions

**Status:** Design Complete
**Session:** Transition Enforcement (between Session 5 and Session 6)
**Depends on:** Session 1 (property change triggers — v0.33.0), Session 2 (statechart visualization — S2-D10)
**Prerequisite for:** Session 6 (causal chain UI), Session 8 (Phase 3 editing affordances)

**Resolves deferred question from v0.33.0 migration:**
- `v0-33-0-causal-bindings.sql` line 35: *"Whether this table is purely declarative or also enforces allowed transitions is deferred to a future session."*

**Resolves S2-D10 follow-up:**
- `on_transition_rpc` column semantics, naming, and whether it should exist at all

---

## Context

Civic OS has two metadata systems that relate to status changes:

| System | Table | Purpose | Current State |
|--------|-------|---------|---------------|
| **Causal** | `metadata.status_transitions` | Declares valid edges in the state machine | Declarative only, no enforcement |
| **Reactive** | `metadata.property_change_triggers` | Declares functions that fire when properties change | Carries ALL status-change automation |

Entity action RPCs (e.g., `approve_reservation_request`) directly `UPDATE ... SET status_id = ...`. This is opaque to metadata — the introspection system (`analyze_function_dependencies()`) detects table-level effects via regex but cannot determine which column is modified or which transition is taken.

S2-D10 resolved `on_transition_rpc` as "the RPC that CAUSES the transition" (Interpretation A). But the column is scalar while some transitions have 5+ causing RPCs, and maintaining it requires manual annotation that integrators can forget.

### Problems Identified

1. **`on_transition_rpc` is scalar** but Mott Park's Pending→Paid transition has 5 causing RPCs (1 Stripe webhook + 4 manual payment RPCs)
2. **Manual annotation burden**: the link between "function X causes transition Y" is a checklist item integrators must remember
3. **`entity_actions → status_transitions` is M:N**: one action can cause multiple transitions (e.g., `cancel_reservation_request` causes both Pending→Cancelled and Approved→Cancelled)
4. **Split discoverability**: integrators look in `status_transitions` for the state machine and `property_change_triggers` for what actually happens

---

## Design Philosophy

### Two Layers + Gateway

```
 CAUSAL LAYER                          REACTIVE LAYER
 status_transitions                    property_change_triggers
 (topology only — valid edges)         (effects that fire in response)
                                         'any' → audit, color sync
         ▲ validated by                  'changed_to' → state-arrival
                                           effects (payments, notifs)
 GATEWAY                                        ▲
 transition_entity()                             │ fires via
   1. Validates transition               PostgreSQL native triggers
   2. Executes UPDATE ───────────────────────────┘
   3. Self-documenting
   4. Session-variable guard

         ▲ called by

 RPC FUNCTIONS
 (entity actions, webhooks, scheduled jobs)
```

**Principle:** `status_transitions` owns the topology (valid edges). `property_change_triggers` owns the reactive effects. `transition_entity()` is the gateway between them — it validates against the topology, executes the UPDATE, and the UPDATE fires the reactive triggers via PostgreSQL's native mechanism.

### Three Granularities of Transition Behavior

| Granularity | Meaning | Location |
|-------------|---------|----------|
| **Edge-specific causal** | "What function causes THIS transition" | Encoded in `transition_entity()` calls, discoverable by static analysis |
| **State-arrival reactive** | "What fires when we ARRIVE at this status, regardless of origin" | `property_change_triggers` with `change_type = 'changed_to'` |
| **Any-transition reactive** | "What fires on EVERY status change" | `property_change_triggers` with `change_type = 'any'` |

State-arrival is the default model for integrators (covers 90% of cases). Edge-specific reactive hooks (e.g., different notification for initial approval vs re-approval) are a future enhancement.

---

## Decisions

### TE-D1: Enforcement Mechanism — `transition_entity()` Gateway

All status changes go through a gateway function instead of direct `UPDATE ... SET status_id = ...`:

```sql
-- OLD: opaque UPDATE, invisible to metadata
UPDATE reservation_requests SET status_id = v_approved_id WHERE id = p_entity_id;

-- NEW: self-documenting, self-enforcing gateway
PERFORM transition_entity('reservation_request', p_entity_id, 'approved');
```

**Function contract:**

```sql
transition_entity(
  p_entity_type TEXT,     -- e.g., 'reservation_request' (matches status_types)
  p_entity_id   BIGINT,   -- record ID
  p_to_status_key TEXT    -- e.g., 'approved' (resolved via get_status_id)
) RETURNS VOID
```

**Internal flow:**

1. Discovers table name + status column from `metadata.properties WHERE status_entity_type = p_entity_type`
2. Reads current `status_id` from the record
3. Resolves `p_to_status_key` to a status ID via `get_status_id()`
4. **If transitions exist** for this entity_type → validates (current, target) against `metadata.status_transitions`
5. **If NO transitions exist** → permissive mode, allows any change
6. Increments session variable `civic_os.transition_depth` (depth counter)
7. Executes `UPDATE ... SET status_column = target_status_id WHERE id = p_entity_id`
8. Decrements depth counter

**Permissive mode:** When `metadata.status_transitions` has zero rows for an entity_type, the gateway skips validation. Entities can adopt the gateway before formalizing transitions. Enforcement activates automatically once transitions are populated.

**Rationale vs alternatives:**

| Approach | Enforcement | Discoverability | Integrator Burden |
|----------|------------|-----------------|-------------------|
| BEFORE UPDATE trigger (reads metadata) | Blocks invalid API PATCHes | None — opaque UPDATEs remain | Low (opt-in trigger) |
| Application-level enforcement | PostgREST/RPC validates | None | High (every client validates) |
| **`transition_entity()` gateway** | **Built into the function call** | **Auto-discoverable via static analysis** | **Low — replace UPDATE with PERFORM** |

### TE-D2: Session Variable Guard — Depth Counter

A BEFORE UPDATE trigger on each entity table blocks direct `status_id` modifications that don't go through the gateway:

```sql
-- Guard trigger logic:
IF NEW.status_id IS DISTINCT FROM OLD.status_id THEN
  IF COALESCE(current_setting('civic_os.transition_depth', true), '0')::INT < 1 THEN
    RAISE EXCEPTION 'Status changes must use transition_entity(). '
      'Direct UPDATE of status columns is not allowed.'
      USING ERRCODE = 'check_violation';
  END IF;
END IF;
```

**Why a depth counter, not a boolean flag:**

Re-entrancy. `cancel_reservation_request` calls `transition_entity()` for the request, which fires an AFTER trigger that calls `transition_entity()` for each payment.

```
cancel_reservation_request()
  → transition_entity('reservation_request', ..., 'cancelled')     depth: 0→1
    → UPDATE reservation_requests SET status_id = ...
    → AFTER trigger fires
      → FOR EACH payment:
        → transition_entity('reservation_payment', ..., 'cancelled')  depth: 1→2
          → UPDATE reservation_payments SET status_id = ...
          → guard checks depth=2 ≥ 1 ✓
          → depth: 2→1
    → depth: 1→0
```

A boolean flag would break at the inner decrement — the outer trigger chain would find the flag cleared.

### TE-D3: RPC Contract — Use Gateway

RPCs replace direct status UPDATEs with gateway calls. The return contract `{success, message, navigate_to?, refresh?}` is unchanged.

**Single-entity transition:**
```sql
-- In approve_reservation_request():
PERFORM transition_entity('reservation_request', p_entity_id, 'approved');
```

**Multi-entity cascade:**
```sql
-- In cancel_reservation_request():
PERFORM transition_entity('reservation_request', p_entity_id, 'cancelled');
FOR v_payment IN SELECT id FROM reservation_payments
  WHERE reservation_request_id = p_entity_id AND status_id = v_pending_id
LOOP
  PERFORM transition_entity('reservation_payment', v_payment.id, 'cancelled');
END LOOP;
```

**Computed status:**
```sql
-- In update_onboarding_status():
v_new_key := CASE WHEN v_all_approved THEN 'all_approved'
                  WHEN v_any_started THEN 'partial'
                  ELSE 'not_started' END;
IF v_new_status_id != v_current_status_id THEN
  PERFORM transition_entity('staff_onboarding', p_staff_member_id, v_new_key);
END IF;
```

### TE-D4: Reactive Layer — Stays in property_change_triggers

Reactive behavior stays in `property_change_triggers`. The transition system (`status_transitions`) owns only topology (valid edges). The reactive system owns effects.

The UPDATE inside `transition_entity()` fires PostgreSQL's native BEFORE/AFTER triggers. No dispatch logic inside the gateway — the gateway validates and executes, then gets out of the way.

**Execution order:**

```
  RPC calls transition_entity()
    ├── 1. Gateway validates transition
    ├── 2. Gateway sets session depth counter
    ├── 3. Gateway executes UPDATE
    │     ├── 4. BEFORE triggers fire (guards, calculations, color sync)
    │     ├── 5. Row written
    │     └── 6. AFTER triggers fire (audit notes, notifications, sync)
    └── 7. Gateway decrements depth counter
```

**Unified introspection VIEW:** A new VIEW joins `status_transitions` with `property_change_triggers` on status columns to present the complete lifecycle per transition edge — valid edges, what state-arrival effects fire at each target status, and what any-transition effects fire globally.

### TE-D5: Drop `on_transition_rpc` Column

The causal link between functions and transitions is now encoded in `transition_entity()` calls within function source code.

**Enhanced `analyze_function_dependencies()`** detects the pattern:

```sql
-- Regex: TRANSITION_ENTITY\(\s*'([a-z_]+)'\s*,\s*[^,]+\s*,\s*'([a-z_]+)'
-- Captures: (entity_type, to_status_key)
-- Auto-registers: calling_function → causes transition → entity_type → to_status_key
```

This eliminates:
- The `on_transition_rpc` column (manual annotation replaced by static analysis)
- The proposed `entity_actions.transition_id` FK (the chain is: action → RPC → `transition_entity()` call → discoverable)
- The M:N relationship problem (each `transition_entity()` call encodes one function → one target status)

**Impact on S2-D3 (statechart edge types):**

The statechart visualization currently uses `on_transition_rpc IS NOT NULL` for solid vs dashed edges. With the column dropped, the edge type is determined by whether ANY registered function calls `transition_entity()` targeting this transition's `to_status_id`:

| Condition | Edge Style |
|-----------|------------|
| Static analysis finds `transition_entity()` call targeting this edge | Solid (user/system action) |
| No function found targeting this edge | Dashed (automatic/undiscovered) |

**Impact on `schema_entity_dependencies` view:** The `status_transition_deps` CTE (which joined `status_transitions.on_transition_rpc` to `rpc_entity_effects`) is replaced by a CTE that joins the enhanced static analysis results.

### TE-D6: Entity Actions — No Explicit FK Needed

The chain from entity action to transition is fully discoverable without a database FK:

```
entity_actions.rpc_function = 'approve_reservation_request'
  → Function source contains: transition_entity('reservation_request', ..., 'approved')
  → Static analysis auto-registers this causal link
  → Introspection VIEW joins: action → function → transition target
  → Statechart renders: action button label on the transition edge
```

### TE-D7: property_change_triggers — No New Constraints

`changed_to` and `any` triggers on status columns coexist freely with the transition system. State-arrival effects (fire when ARRIVING at a status regardless of origin) are semantically different from edge-specific behavior.

A diagnostic query in the introspection system flags potential overlaps for human review, but no database constraint is added.

---

## Schema Changes

### New Functions

| Function | Schema | Purpose |
|----------|--------|---------|
| `transition_entity(TEXT, BIGINT, TEXT)` | `public` | Gateway: validate + execute status transition. SECURITY DEFINER. |
| `status_change_guard()` | `metadata` | BEFORE UPDATE trigger: blocks direct status_id changes without gateway. |
| `enable_transition_guard(NAME)` | `public` | Helper: installs guard trigger on a table. SECURITY DEFINER. |
| `get_allowed_transitions(TEXT, INT)` | `public` | Query: returns valid target statuses from current status. For frontend dropdown filtering. |

### Modified Functions

| Function | Change |
|----------|--------|
| `add_status_transition()` | Remove `p_on_transition_rpc` parameter |
| `analyze_function_dependencies()` | Add `transition_entity()` call detection regex |

### Dropped Columns

| Table | Column | Reason |
|-------|--------|--------|
| `metadata.status_transitions` | `on_transition_rpc` | Replaced by static analysis of `transition_entity()` calls |

### Modified Views

| View | Change |
|------|--------|
| `schema_entity_dependencies` | Replace `status_transition_deps` CTE (was joining on `on_transition_rpc`) with enhanced static analysis join |

### New View

| View | Purpose |
|------|---------|
| `schema_transition_lifecycle` (name TBD) | Unified view joining `status_transitions` + `property_change_triggers` for complete per-edge lifecycle |

---

## Migration Strategy for Examples

**Clean break**: New init scripts (historical scripts untouched) that:
1. Install `enable_transition_guard()` on entities with status columns
2. `CREATE OR REPLACE` RPCs to use `transition_entity()` instead of direct UPDATE
3. Update `status_transitions` rows to remove `on_transition_rpc` data (column will be dropped in migration)

**Example script naming convention:** `NN_<prefix>_transition_gateway.sql`

| Example | Entities | Complexity | Notes |
|---------|----------|------------|-------|
| Community Center | `reservation_requests` | Low | 4 transitions, 3 RPCs |
| Staff Portal | `time_off_requests`, `reimbursements`, `staff_tasks` | Medium | 3 entities, simple workflows |
| Staff Portal | `staff_documents` | Special | Keeps custom guard (auto-submit on file upload). Gateway + custom guard coexist. |
| Staff Portal | `staff_onboarding` | Special | Computed status. Uses permissive mode (no transitions to validate). |
| Mott Park | `reservation_requests`, `reservation_payments` | High | 10 transitions, re-entrant cascade |

---

## Frontend Changes

| Component | Change |
|-----------|--------|
| **Edit page** | When transitions exist for an entity, filter status dropdown to `get_allowed_transitions()` results |
| **Status Admin page** | Show guard installation status per entity |
| **System Map (Session 6)** | Enhanced static analysis surfaces `transition_entity()` calls in causal chain visualization |
| **Statechart (Session 2)** | Edge type derived from static analysis presence instead of `on_transition_rpc IS NOT NULL` |

---

## Edge Cases

| Case | Handling |
|------|----------|
| No transitions declared for entity_type | Permissive mode — gateway allows any status change |
| Multi-entity cascade (cancel request + payments) | Each entity transitioned via separate gateway call in cursor loop |
| Computed status (staff_onboarding) | Uses gateway in permissive mode. If transitions formalized later, enforcement auto-activates. |
| External system (Stripe webhook) | Webhook handler (SECURITY DEFINER) calls gateway — same pattern as entity action RPCs |
| Bulk scheduled job (auto-complete) | Cursor loop, one gateway call per record |
| Initial status on INSERT | Not a transition — handled by existing `validate_status_entity_type()` trigger |
| Integrator bypasses gateway with direct UPDATE | Session variable guard trigger blocks it. RAISE EXCEPTION with clear message. |
| Re-entrant transitions (cascade) | Depth counter handles nested gateway calls correctly |
| Custom guard (staff_documents) | Gateway + custom trigger coexist. Custom trigger fires BEFORE the gateway's UPDATE. |
| Multiple status columns on one entity | Gateway discovers all status columns from `metadata.properties`. Each is validated independently. |

---

## Open Questions for Future Sessions

| Question | Context | Target Session |
|----------|---------|---------------|
| Edge-specific reactive hooks | Should `property_change_triggers` support hooks that fire for a specific from→to edge, not just state-arrival? | Session 8 (Phase 3 editing) |
| `transition_entity()` in Blockly | How to visualize the gateway call in source code block diagrams? New AST node type? | Session 6 (causal chain UI) |
| Transition permissions | Should specific transitions be gated by role? E.g., only managers can approve. | Session 7 (progressive disclosure) |
| Bulk transitions | Should `transition_entities()` (plural) accept an array for performance in scheduled jobs? | Implementation session |
| Auto-generated action buttons | If a transition has no entity action but IS discovered via static analysis, auto-generate a button? | Session 8 (Phase 3 editing) |

---

## Verification Plan

1. **Functional test — enforcement**: Create entity with declared transitions. Verify `transition_entity()` allows valid transition, rejects invalid. Verify direct PATCH blocked by guard.
2. **Functional test — permissive mode**: Entity with statuses but NO declared transitions. Verify `transition_entity()` allows any change.
3. **Functional test — re-entrancy**: Cancel reservation request with pending payments. Verify cascade completes, depth counter correct.
4. **Static analysis test**: Register function containing `transition_entity()` call. Verify `analyze_function_dependencies()` detects the causal link.
5. **Integration test**: Run Mott Park with gateway-migrated RPCs. Verify entity action buttons, reactive triggers (audit notes, notifications, calendar sync), and payment cascade all work.
6. **Frontend test**: Edit page status dropdown shows only valid transitions when transitions are declared.
