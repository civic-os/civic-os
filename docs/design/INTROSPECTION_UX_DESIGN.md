# Introspection UX Architecture - Design Document

**Status:** 📋 Design Phase
**Created:** 2026-03-03
**Author:** Design Discussion with Claude
**Target:** Phase 2 (Introspection) and Phase 3 (Visual Builder)

**Related Documentation:**
- `SYSTEM_INTROSPECTION_DESIGN.md` — Database schema, views, and static analysis for introspection
- `CAUSAL_BINDINGS_EXAMPLES.md` — Complete catalog of status transitions and property change triggers across all examples (v0.33.0)
- `SCHEMA_EDITOR_DESIGN.md` — JointJS ERD and entity metadata editing
- `STATUS_TYPE_SYSTEM.md` — Status types, transitions, and workflow engine design
- `ENTITY_ACTIONS.md` — Action buttons, RPC contracts, and condition system
- `CODE_BLOCK_SYSTEM_DESIGN.md` — Blockly-based PL/pgSQL function visualization

---

## 1. Overview

This document defines the conceptual model, navigation architecture, and UX principles for Civic OS introspection (Phase 2) and the visual application builder (Phase 3).

**Core problem:** A Civic OS application has entities, properties, statuses, actions, permissions, triggers, notifications, and dashboards. When a user asks "what happens when a permit application is submitted?", the answer spans multiple subsystems — status transitions, action conditions, trigger functions, entity side effects, and notification templates. No single existing view answers that question.

**Core insight:** The system's relationships fall into two fundamentally different categories — **structural** and **causal** — and the UX must treat them differently at every level.

---

## 2. Decisions Made

These are design decisions established during the initial design session. They should be treated as foundations unless revisited in a future session.

### D1: Two Relationship Categories

All relationships in a Civic OS application are either **structural** or **causal**.

**Structural** — the data model. Static, always present, bidirectional. Foreign key references, many-to-many junctions. "Permits reference parcels." Discovered from schema introspection. Visualized with undirected lines (or bidirectional arrows).

**Causal** — what happens at runtime. Directed, conditional, event-driven. "When a permit is approved, an inspection is created." Declared in metadata bindings. Visualized with directed arrows showing flow of execution.

The previously proposed `behavioral` category (function X modifies entity Y) is not a separate category. It is the **effects** segment of a causal chain — useful as an implementation detail but not a distinct concept for users.

**Impact on `schema_entity_dependencies`:** The `category` column should use `structural` vs `causal` rather than `structural` vs `behavioral`. Causal rows carry richer metadata: not just "function X modifies entity Y" but the event binding that triggered the function.

### D2: Entity-Centric Navigation

The primary navigation axis is **entity-centric**. Entities are the most concrete concept for users ("permits," "inspections," "reservations"), all metadata is entity-scoped, and Phase 3 editing will be entity-scoped.

System-wide cross-cutting views (dependency graph, permission matrix, notification catalog) supplement entity navigation but do not replace it.

### D3: Three Zoom Levels

Navigation follows Shneiderman's mantra — overview first, zoom and filter, details on demand — implemented as three semantic zoom levels:

| Level | Scope | Shows | Primary Visualization |
|-------|-------|-------|----------------------|
| **System** | All entities | Structural relationships, entity summaries | ERD (existing JointJS) |
| **Entity** | One entity | Causal I/O boundary, status lifecycle, properties, permissions | Entity context diagram + statechart |
| **Trace** | One event path | Full causal chain for a specific event | Event-function-effect sequence |

Each level is reachable from the one above by a single interaction (click an entity on the ERD → entity view; click an event arrow → trace view). No dead ends.

### D4: Causal Chain Anatomy

Every causal chain decomposes into three parts:

1. **Event** — something changes. Three types:
   - Status transition (specific: Draft → Submitted)
   - Property change (general: `assigned_reviewer_id` set to a value)
   - Record lifecycle (created, deleted)

2. **Function** — something responds. Bound via:
   - `status_transitions.on_transition_rpc` (already exists as column, not yet active)
   - `property_change_triggers` (new table, see §4)
   - `entity_actions.rpc_function` (existing)
   - `notification_triggers.source_function` (existing)
   - `scheduled_jobs.function_name` (existing)

3. **Effects** — something results. Captured in:
   - `rpc_entity_effects` (existing)
   - `trigger_entity_effects` (existing)
   - Effects that constitute new events continue the chain

The chain is the fundamental unit of causal introspection. Everything else — the context diagram, the statechart annotations, the trace view — is a projection of chains.

### D5: Formalized Event-to-Function Bindings

Current Civic OS triggers are registered at the PostgreSQL level (AFTER UPDATE on a table). The semantic intent (which property change or status transition matters) is buried inside function bodies. This must be formalized in metadata so causal chains become queryable.

Two binding mechanisms:

- **Status transition bindings** — use the existing `status_transitions.on_transition_rpc` column plus a new mechanism for "all transitions" listeners
- **Property change bindings** — a new `property_change_triggers` table (see §4)

This is a prerequisite for causal chain visualization. Without it, the links between events and functions exist only in PL/pgSQL source code.

### D6: Entity Context Diagram

The entity-level behavioral overview shows one entity's relationship to the automation system:

- **Top:** Triggers/watchers (functions that respond to changes on this entity)
- **Left:** Incoming events (actions that can be invoked, scheduled jobs, cross-entity effects that modify this entity)
- **Right:** Outgoing effects (entities modified, notifications sent, records created)
- **Center:** The entity itself

This is the behavioral equivalent of the ERD for one entity. It answers "what is this entity's relationship to the automation system?" but does not show internal lifecycle (statechart) or full execution paths (causal chain).

### D7: Statecharts for Status Lifecycle

Entities with status types get a statechart visualization showing:

- Status nodes (colored per `metadata.statuses.color`, marked initial/terminal)
- Transition edges (from `metadata.status_transitions`)
- Edge annotations: transition-specific RPCs (`on_transition_rpc`)
- Entity-level annotations: all-transition listeners (functions that fire on any status change)

Simplified notation — no hierarchy, no parallel regions, no formal statechart advanced features. Civic OS statuses are flat by design.

Mermaid state diagram syntax is a useful reference for the notation style, but the rendering will likely use JointJS for consistency with the ERD and for Phase 3 editability.

### D8: Phase 3 Readiness Principle

Every Phase 2 read-only view should display exactly the information that the corresponding Phase 3 edit form needs to collect. The view becomes the editing surface by adding input affordances. No restructuring should be required.

- Entity overview → entity editor (add properties, configure settings)
- Statechart → workflow editor (add statuses, draw transitions, bind functions)
- Causal chain → automation builder (edit function bindings, modify conditions)
- System-wide views → bulk editing surfaces

### D9: Effect-Event Duality at Entity Boundaries

An effect on one entity and an event on another entity are **the same thing viewed from two sides.** When a function writes to a property on another entity, that's an effect (tracked in `rpc_entity_effects`). When that property has change triggers registered, that's an event (tracked in `property_change_triggers`). The join between those two tables is the causal link that crosses entity boundaries.

This means causal chain traversal is a **graph walk:**

1. Start at an event (status transition, property change, record lifecycle)
2. Find the bound function(s) (`on_transition_rpc`, `property_change_triggers`, entity actions)
3. Find that function's effects (`rpc_entity_effects`, `trigger_entity_effects`)
4. Check whether any effect matches a registered event on the target entity (join effects to `property_change_triggers` on `table_name` + `property_name`)
5. If yes, continue walking from step 2. If no, the chain terminates.

Walking forward answers "what happens when X?" Walking backward answers "what could cause Y?" — follow the property change trigger back to the event, find all functions whose effects include writing to that property, find the events that trigger those functions. Multiple upstream paths can converge on the same node.

**Concrete example** — Mott Park reservation cancellation:

```
reservation_request.status_id → Cancelled           ← EVENT
  └─ cancel_reservation_request                      ← FUNCTION (on_transition_rpc)
       └─ writes reservation_payments.status_id      ← EFFECT (rpc_entity_effects)
            ≡                                        ← SAME NODE, TWO PERSPECTIVES
       reservation_payments.status_id changed         ← EVENT (property_change_triggers)
         ├─ set_payment_display_name                  ← FUNCTION
         │    └─ rebuilds display string              ← EFFECT (terminal)
         ├─ add_payment_status_change_note            ← FUNCTION
         │    └─ audit note on parent reservation     ← EFFECT (terminal)
         └─ update_can_waive_fees                     ← FUNCTION
              └─ writes reservation_request.can_waive ← EFFECT
                   (no trigger registered → terminal)
```

The `≡` in the middle is the key insight: `rpc_entity_effects` says the function modifies `reservation_payments.status_id`, and `property_change_triggers` says something fires when `reservation_payments.status_id` changes. That join is the bridge.

**Phase 3 implication:** The visual builder must detect and surface these cross-entity effect-event links when an integrator configures a function's effects or registers a property change trigger. If a function modifies `reservation_payments.status_id` and that property has change triggers, the builder should show: "This effect will trigger N downstream functions on `reservation_payments`." Conversely, when registering a new property change trigger, the builder should show: "N functions across M entities write to this property — this trigger will fire when any of them do." This bidirectional awareness prevents integrators from creating unintended cascades and makes the causal graph navigable during construction, not just after the fact.

### D10: Computed Statuses

Some entity statuses are not set by any RPC or transition — they are derived from the state of related entities. Example: `staff_members.onboarding_status_id` is recalculated whenever a child `staff_documents` record's status changes.

Computed statuses have **no `status_transitions` entries** because no direct transition is valid — the status is always a function of child state. They should be visually distinguished from direct statuses in the statechart (dashed arrows or a "computed" annotation) and flagged in metadata.

Computed statuses are a special case of the effect-event duality (D9): the child's status change is the event, the recomputation function is the function, and the parent's status update is the effect. The chain is: `staff_documents.status_id` changed → `update_onboarding_status` → writes `staff_members.onboarding_status_id`.

**Open question:** Should computed statuses be flagged with an `is_computed BOOLEAN` on the entity or status type? Or is it sufficient to infer this from the absence of `status_transitions` entries? An explicit flag is clearer for visualization; inference is simpler for the schema. **Decision deferred** — resolve in statechart visualization session (Session 2).

---

## 3. Visualization Architecture

### 3.1 System Level

**Primary view: Enhanced ERD** (existing JointJS Schema Editor)

Current capabilities: entities as nodes, FK relationships as edges, inspector panel with property details, auto-layout with Metro router.

Phase 2 additions:
- Toggle to overlay causal edges (dashed lines, directional, distinct color) from `schema_entity_dependencies` where `category = 'causal'`
- Causal edges labeled with the function/trigger that creates the cross-entity effect
- Click any entity node → navigate to entity-level view

**Supplementary system views:**

| View | Source | Purpose |
|------|--------|---------|
| Permission matrix | `schema_permissions_matrix` | Role × entity × CRUD grid (admin only) |
| Notification catalog | `schema_notifications` | All templates, triggers, recipients |
| Function registry | `schema_functions` | All RPCs, effects, schedules |
| Trigger map | `schema_triggers` | All triggers by entity and purpose |

Each supplementary view deep-links back to entity-level views.

### 3.2 Entity Level

**Primary view: Entity introspection page** with sections:

| Section | Content | Data Source |
|---------|---------|-------------|
| Summary | Property count, status count, action count, trigger count, role access | Aggregated from schema views |
| Properties | Column list with types, validations, search config | `schema_properties` |
| Relationships | Structural connections (FKs, M:M) | `schema_entity_dependencies` where `category = 'structural'` |
| Status lifecycle | Statechart diagram (if entity has status type). See `STATECHART_VISUALIZATION_DESIGN.md` for rendering decisions. | `metadata.statuses` + `metadata.status_transitions` + `metadata.property_change_triggers` (for listener panel) |
| Context diagram | Causal I/O boundary visualization | `schema_entity_dependencies` where `category = 'causal'` + `schema_triggers` |
| Actions | Available action buttons with conditions | `schema_entity_actions` |
| Permissions | Per-role CRUD + RLS policy summaries | `schema_permissions_matrix` filtered |

**Progressive disclosure:** Summary section is always visible. Other sections are expandable or tabbed. Status lifecycle and context diagram are the two visual sections; the rest are tabular.

### 3.3 Trace Level

**Primary view: Causal chain** for a specific event.

Entry points:
- Click a transition edge on the statechart → chain for that status transition
- Click an incoming/outgoing arrow on the context diagram → chain for that event path
- Click an action button in the actions section → chain for that action's execution

**Rendering:** Vertical sequence of event-function-effect cards. Each card shows:

```
┌─ EVENT ──────────────────────────────────────┐
│ Status changes: Under Review → Approved       │
│ on: permit_applications                       │
└───────────────────────┬──────────────────────┘
                        ▼
┌─ FUNCTION ───────────────────────────────────┐
│ approve_permit                                │
│ "Approves permit and creates inspection"      │
│                                               │
│ Conditions: role ≥ manager                    │
│ Parameters: p_permit_id (BIGINT)              │
└───────────────────────┬──────────────────────┘
                        ▼
┌─ EFFECTS ────────────────────────────────────┐
│ ✎ permit_applications.approved_at = NOW()    │
│ ✎ permit_applications.approved_by = user     │
│ ✚ inspections (new record created)        ──── → click to follow
│ ✉ Notification: "Permit approved" → applicant│
└──────────────────────────────────────────────┘
```

When the chain crosses an entity boundary (effect creates a record on another entity that has its own triggers), the view shows an inline expansion with a boundary marker. The user stays in the same trace but sees they've crossed into another entity's domain. A link offers full navigation to that entity's introspection page.

---

## 4. New Metadata: Property Change Triggers

### Problem

Currently, triggers are registered at the PostgreSQL event level (AFTER UPDATE on a table). The semantic intent — which property change matters — is encoded inside the function body (`IF NEW.status_id != OLD.status_id THEN ...`). This is invisible to the metadata layer and cannot be queried, visualized, or edited.

### Proposed Table

```sql
CREATE TABLE metadata.property_change_triggers (
    id SERIAL PRIMARY KEY,
    table_name NAME NOT NULL,
    property_name NAME NOT NULL,          -- column to watch
    change_type VARCHAR(20) NOT NULL,     -- 'any', 'set', 'cleared', 'changed_to'
    change_value TEXT,                    -- for 'changed_to': the specific value
    function_name NAME NOT NULL,          -- RPC to invoke
    display_name TEXT NOT NULL,
    description TEXT,
    sort_order INT DEFAULT 0,
    is_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**`change_type` semantics:**

| Value | Fires when | Example |
|-------|-----------|---------|
| `any` | Column value changes at all | `assigned_reviewer_id` changes for any reason |
| `set` | Column goes from NULL to non-NULL | `approved_at` gets a value |
| `cleared` | Column goes from non-NULL to NULL | `assigned_reviewer_id` is unassigned |
| `changed_to` | Column changes to a specific value | `priority` changes to `'urgent'` |

### Relationship to Status Transitions

Status transitions are a **constrained special case** of property change triggers. A status transition is equivalent to a property change trigger where:

- `property_name` is the entity's status column
- `change_type` is always `changed_to` (with composite from/to semantics)
- The binding is in `status_transitions.on_transition_rpc` rather than this table

This gives a nice hierarchy: status transitions are well-visualized on the statechart as a first-class concept; property change triggers are the general mechanism for everything else, shown on the context diagram.

### Status Transition All-Listener

For functions that should fire on **any** status transition for an entity (e.g., `notify_status_change`), two options:

**Option A:** Row in `property_change_triggers` where `property_name` is the status column and `change_type = 'any'`.

**Option B:** New column `metadata.status_transitions.on_any_transition_rpc` or a separate `metadata.status_transition_listeners` table.

Option A is simpler and avoids a new table, but conflates two systems. Option B keeps the status workflow self-contained. **Decision deferred** — resolve in the status/workflow design session.

---

## 5. UX Principles

These principles should guide implementation decisions for introspection and the visual builder.

### P1: Structural is the Base Layer; Causal is the Overlay

Structural relationships are always visible — they're the stable scaffolding. Causal relationships are shown on demand when users express interest in a specific event or automation. This parallels how GIS systems use a permanent base map with toggleable data layers.

**Implication:** The ERD always shows structural edges. Causal edges are a toggle. The entity page always shows properties and relationships. The context diagram and statechart are expandable sections.

### P2: Semantic Zoom

Each zoom level changes what *kind* of information is visible, not just the magnification:

- **System level** shows entities and structural connections. Individual properties, triggers, and conditions are not visible.
- **Entity level** shows the full shape of one entity: properties, statuses, causal I/O, permissions. Other entities appear only as connection endpoints.
- **Trace level** shows the full execution path for one event, including cross-entity effects. Schema structure is not visible.

### P3: Directed Flow for Causal, Flexible Layout for Structural

Causal visualizations must maintain consistent flow direction (top-to-bottom or left-to-right) because spatial position encodes time/causation. Structural visualizations (the ERD) can be laid out however minimizes visual clutter because position carries no semantic meaning.

### P4: Show the Happy Path, Annotate the Conditions

Causal chains should render as if everything fires, showing the full sequence. Conditions (role requirements, visibility conditions, disabled conditions) appear as secondary information — tooltips, expandable detail panels, or badge annotations. This keeps the narrative readable while making the full logic inspectable.

### P5: Inline Expansion at Entity Boundaries

When a causal chain crosses from one entity into another, the trace view expands inline with a clear boundary marker rather than navigating away. The user stays in context but sees they've crossed a boundary. Full navigation to the other entity is offered as a link, not forced.

### P6: Every View is a Future Editing Surface

Phase 2 views should display exactly the fields that Phase 3 editing will need to collect. The transition from read-only to editable should require adding input affordances to the existing layout, not restructuring the information architecture.

---

## 6. Open Questions

These items require dedicated design sessions to resolve.

### O1: Statechart Rendering Technology — ✅ Resolved (Session 2)

**Decision:** Dual renderer. JointJS for the full interactive canvas at `/schema-editor/entity/:type/workflow` (reuses ERD patterns, provides Phase 3 editing for free). Lightweight Angular + static SVG for the inline embed on entity introspection pages. Both share the same layout algorithm and visual encoding. See `STATECHART_VISUALIZATION_DESIGN.md` S2-D1.

### O2: Causal Chain UI Component

The trace-level causal chain view needs detailed UI design: card layout, how branching is handled when a function has multiple effects, how deep the inline cross-entity expansion goes before it stops, and how conditions/permissions are surfaced.

**Resolve in:** Causal chain UI session.

### O3: Context Diagram Layout

The entity context diagram (incoming left, triggers top, outgoing right) needs concrete layout design. How many items before it overflows? Does it use JointJS or simpler HTML/SVG? How does it handle entities with many triggers vs. few?

**Resolve in:** Entity context diagram session.

### O4: All-Transition Status Listeners — ✅ Resolved (Session 2)

**Decision:** Use `property_change_triggers` with `change_type = 'any'` on the status column. Rendered as an entity-level panel below the statechart, grouped by effect category (guard / auto_update / sync / audit / notify) rather than PostgreSQL trigger phase. New `effect_category` column on `property_change_triggers` table. See `STATECHART_VISUALIZATION_DESIGN.md` S2-D6.

### O5: Property Change Trigger Execution Model

`property_change_triggers` is a metadata concept, but something needs to actually invoke the function at runtime. Options: a generic BEFORE/AFTER UPDATE trigger per entity that reads the metadata table and dispatches, or code generation that creates specific triggers from the metadata. The former is more dynamic; the latter is more transparent.

**Resolve in:** Backend implementation session.

### O6: Progressive Disclosure Levels by Role

The three zoom levels serve progressive disclosure by complexity, but there's also a permission dimension: admins see everything, editors see entities they can modify, basic users see entities they can read. How do filtered views interact with the zoom levels? Does a basic user see a simplified statechart (just statuses, no function bindings)?

**Resolve in:** Permission-filtered introspection session.

### O7: Integration with Existing Blockly Visualization

The Code Block System already renders PL/pgSQL functions as Blockly blocks. When a causal chain reaches a function, should the trace view link to the Blockly visualization, embed a simplified version inline, or just show the function's registered description?

**Resolve in:** Function visualization integration session.

### O8: Dashboard-Entity Cross-References

Dashboards reference entities via `filtered_list`, `map`, and `calendar` widgets. This is noted as a future enhancement in `SYSTEM_INTROSPECTION_DESIGN.md`. When resolved, dashboards would appear as another type of relationship in the entity context diagram — "this entity appears on these dashboards."

**Resolve in:** Dashboard introspection session.

### O9: Phase 3 Builder — Cross-Entity Effect-Event Detection

Per D9, the visual builder must surface effect-event links bidirectionally. When an integrator configures a function that writes to a property on another entity, the builder should query `property_change_triggers` to show downstream consequences. When registering a new property change trigger, the builder should query `rpc_entity_effects` to show which functions across which entities write to that property. This requires a query or view that pre-computes the join between `rpc_entity_effects` and `property_change_triggers` on `(table_name, property_name)` — essentially materializing the entity boundary crossings.

**Resolve in:** Phase 3 editing affordances session (Session 6).

### O10: Portable Status References in Property Change Triggers

`property_change_triggers.change_value` currently stores environment-specific integer IDs (status_id values). This makes trigger declarations non-portable across environments. A `change_value_key` variant storing `(entity_type, status_key)` tuples would allow declarations like "changed_to: Approved" rather than "changed_to: 4". The `status_key` field on `metadata.statuses` (if added) would serve as the stable identifier.

**Resolve in:** Property change trigger schema refinement (or Session 2 if it affects statechart rendering).

---

## 7. Work Session Plan

Future design sessions, ordered by dependency. Each produces a concrete deliverable.

| # | Session | Status | Deliverable |
|---|---------|--------|-------------|
| 1 | Property change trigger schema | ✅ v0.33.0 | `property_change_triggers` table, `on_transition_rpc` bindings, `CAUSAL_BINDINGS_EXAMPLES.md` |
| 2 | Statechart visualization | ✅ Designed | `STATECHART_VISUALIZATION_DESIGN.md` — 10 decisions, prototype, dark-field UI aesthetic |
| 3 | Entity context diagram | 📋 Next | Layout design + data flow from `schema_entity_dependencies`. Inputs from S2: effect categories apply here too, zero-transition entities need context diagram as primary view, listener panel overlap to resolve |
| 4 | Causal chain UI | 📋 Next | Component design for trace-level visualization. Inputs from S2: `on_transition_rpc` = causal entry point, BEFORE/AFTER surfaces here as technical metadata, multi-pathway transitions need multiple entry points |
| 5 | Permission-filtered introspection | 📋 Blocked on #3–#4 | Role-based view filtering rules |
| 6 | Phase 3 editing affordances | 📋 Blocked on #3–#4 | Spec for transitioning each view to editable. Prereq: rename `on_transition_rpc` → `caused_by_rpc` |

Sessions 1–3 can be parallelized on the backend (#1) and frontend (#2, #3) tracks.

---

## 8. Relationship to Existing Documents

This document **does not replace** any existing design document. Here is how it relates to each:

| Document | Relationship |
|----------|-------------|
| `SYSTEM_INTROSPECTION_DESIGN.md` | That doc defines the database layer (tables, views, static analysis). This doc defines the conceptual model and UX architecture that sits on top of those views. `property_change_triggers` (proposed here, implemented in v0.33.0) extends that spec. |
| `CAUSAL_BINDINGS_EXAMPLES.md` | Complete catalog of all causal bindings across examples. Primary test data for Sessions 2–4. Surfaced design patterns (computed statuses, review loops, trigger chain depths) that inform visualization decisions. |
| `SCHEMA_EDITOR_DESIGN.md` | The ERD is the system-level structural view in this architecture. Phase 3 editing extends that ERD's inspector panel with behavioral/causal editing. |
| `STATUS_TYPE_SYSTEM.md` | Status transitions are a constrained special case of the causal chain model. The statechart visualization defined here renders data from that system's tables. The `on_transition_rpc` column becomes the primary status-level causal binding. |
| `ENTITY_ACTIONS.md` | Entity actions are one of the entry points into causal chains. The action's RPC function, conditions, and parameters appear in the trace-level view. |
| `CODE_BLOCK_SYSTEM_DESIGN.md` | Blockly function visualization may be linked from or embedded in the trace-level causal chain view (see Open Question O7). |
| `STATECHART_VISUALIZATION_DESIGN.md` | Session 2 deliverable. Defines statechart rendering approach (S2-D1), visual encoding (S2-D2/D3), layout algorithm (S2-D4), transition popover and side panel (S2-D5), effect category system (S2-D6), and `on_transition_rpc` semantics (S2-D10). Resolves O1 and O4. |

---

## License

Copyright (C) 2023-2026 Civic OS, L3C. Licensed under AGPL-3.0-or-later.