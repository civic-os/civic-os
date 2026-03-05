# Statechart Visualization — Session 2 Design Decisions

**Status:** ✅ Design Complete (r5)
**Session:** 2 of 6 (Statechart Visualization)
**Depends on:** Session 1 (property change triggers — completed in v0.33.0)
**Prerequisite for:** Session 3 (entity context diagram), Session 4 (causal chain UI)

**Resolves open questions from INTROSPECTION_UX_DESIGN.md:**
- **O1** (Statechart rendering technology) — JointJS for full view, lightweight SVG for inline embed
- **O4** (All-transition status listeners) — Rendered as entity-level annotation panel, grouped by effect category

**Resolves ambiguity identified during session:**
- **S2-D10** (`on_transition_rpc` semantics) — Resolved as Interpretation A: the RPC that causes the transition. Historical context documented.

---

## Decisions

### S2-D1: Dual Renderer Architecture

Two rendering contexts serve different purposes:

| Context | Location | Technology | Interactive? | Purpose |
|---------|----------|-----------|-------------|---------|
| **Inline embed** | Entity introspection page, Status Lifecycle section | Angular component + static SVG | Click-to-navigate only | Quick overview within entity page |
| **Full canvas** | `/schema-editor/entity/:type/workflow` | JointJS graph + paper | Full interaction; Phase 3 editing | Primary visualization and future editing surface |

Both renderers share the same **layout algorithm** and **visual encoding rules**. The inline embed is a static projection of what the full canvas renders interactively.

**Rationale:** JointJS provides drag-to-reposition, draw-edge-between-nodes, inspector panel, and undo/redo — all required for Phase 3 editing. The inline embed avoids loading the full JointJS runtime for a non-interactive thumbnail.

### S2-D2: Visual Encoding for Status Nodes

| Visual Property | Metadata Source | Encoding | Phase 3 Edit Control |
|----------------|----------------|----------|---------------------|
| Fill color | `metadata.statuses.color` | Node background fill | Color picker |
| Label | `metadata.statuses.display_name` | Centered text, auto-contrast | Text input |
| Initial state | `metadata.statuses.is_initial` | Solid black dot + arrow entering from left (UML convention) | Toggle |
| Terminal state | `metadata.statuses.is_terminal` | Double border (inner + outer stroke) + pill/stadium shape | Toggle |
| Sort order | `metadata.statuses.sort_order` | Vertical ordering within rank groups | Drag reorder (Phase 3) |

**Text contrast rule:** If hex color luminance > 0.4, render dark text; otherwise white.

All status nodes are rendered identically regardless of whether their transitions are user-driven or automatic. The edge styles communicate that distinction.

### S2-D3: Two Transition Edge Types

Only two edge variants. This is a simplification from the initial design which proposed three.

| Variant | Condition | Line Style | Arrowhead | Label |
|---------|-----------|-----------|-----------|-------|
| **User action** | `on_transition_rpc IS NOT NULL` | Solid, 2px, neutral | Filled triangle | Function name (monospace) |
| **Automatic** | `on_transition_rpc IS NULL` | Dashed 6-3, 1.5px, muted | Open triangle | Source description (italic) |

**Edge annotations:**

| Annotation | Condition | Encoding |
|-----------|-----------|----------|
| Effects count badge | `effects_count > 0` | Small circle with number, right of label |
| Scheduled job indicator | `scheduled_job IS NOT NULL` | Clock icon badge, left of label |
| Requirement indicator | `guard_condition`, `required_role`, or `required_fields` present | Warning icon + text below label |

**Language (S2-D3a):** User-facing labels describe purpose, not PostgreSQL mechanics. "User action" not "RPC-bound." "Automatic" not "NULL RPC" or "consequence." "Requirements" not "guards." Function names appear in the popover detail.

### S2-D4: Layout Algorithm

**Rank-based left-to-right (Sugiyama-style).**

1. Initial status → rank 0. Each subsequent status → max(predecessor ranks) + 1.
2. Within-rank sort by `sort_order`.
3. Vertical centering per rank.
4. Back-edges route below via curved Bézier.

**Zero-transition case:** If an entity has statuses but no `status_transitions` rows, statuses are arranged in a single horizontal row sorted by `sort_order`. No edges, no initial marker. An explanatory callout appears above the diagram. See S2-D8.

**JointJS implementation:** `DirectedGraph.layout()` with `rankDir: 'LR'` (wraps Dagre).

### S2-D5: Transition Detail Popover

**Click-to-popover, popover-links-to-trace-view.**

Popover contents:
1. From → To with color chips
2. Function binding (if user action) or "No direct action — {source}" (if automatic)
3. Description
4. Requirements section (conditional)
5. Scheduled job section (conditional)
6. Effects count badge
7. "View full causal chain →" button (navigates to Session 4 trace view)

**Popover vs. inspector panel:** The inspector panel (right side) is reserved for Phase 3 editing. The popover serves read-only chain preview. Two surfaces, two purposes.

### S2-D6: Effect Category System

Functions that fire on every status change are grouped by **what they accomplish**, not PostgreSQL trigger phase. Five categories ordered by causal flow:

| Category | Icon | What it does | Typical PG phase |
|----------|------|-------------|-----------------|
| **Guard** | 🛡 | Validates — blocks transition if conditions aren't met | BEFORE |
| **Auto-update** | ⟳ | Updates fields on this same record | BEFORE |
| **Sync** | ↗ | Updates related records in other entities | AFTER |
| **Audit** | 📋 | Creates log entry or note | AFTER |
| **Notify** | ✉ | Sends email or SMS | AFTER |

The "Typical PG phase" column is for integrator reference only — it does **not** appear in the UI. Trigger phase surfaces only in the Session 4 trace-level view as collapsible technical metadata.

**Schema addition:**
```sql
ALTER TABLE metadata.property_change_triggers
  ADD COLUMN effect_category VARCHAR(20) NOT NULL DEFAULT 'auto_update'
  CHECK (effect_category IN ('guard', 'auto_update', 'sync', 'audit', 'notify'));
```

### S2-D7: "Computed Status" Is Not a Framework Concept

**Revised during session.** The initial design proposed `is_computed` flags, dashed/hatched nodes, and a third "computed" edge variant. This was removed.

Analysis: `staff_onboarding` status is a regular status-typed property whose value is modified as a downstream **effect** of `update_onboarding_status()`, which fires on `staff_document.status_id` changes. Using D4's causal chain anatomy:

1. **Event:** `staff_document.status_id` changes
2. **Function:** `update_onboarding_status()` responds (a sync-category listener)
3. **Effect:** `staff_members.onboarding_status_id` is set to a new value

Every piece of this already has a name in the existing model. No new primitive is needed. The so-called "computed status" is:
- A status property → shown in the Properties section of the entity page
- Modified by an effect → shown in staff_document's causal chain
- Visible as an incoming causal arrow → shown in the entity context diagram (Session 3)

**What was removed:**
- `is_computed` flag on `metadata.status_types` — not needed
- Dashed/hatched node rendering — all status nodes look the same
- Third "computed" edge variant (dotted line) — automatic (dashed) covers all NULL-RPC transitions
- "Computed by" annotation — replaced by either a no-transitions callout (S2-D8) or standard automatic edge labels with `consequence_source`

**What remains:** If an integrator declares `status_transitions` rows for such an entity (for documentation purposes), those transitions render as automatic (dashed) edges with `consequence_source` explaining the upstream cause. The statechart looks like any other all-automatic workflow. See S2-D8 for the zero-transition case.

### S2-D8: Zero-Transition Entities

If an entity has statuses but **no rows in `metadata.status_transitions`**:

1. Status nodes render as a horizontal row (no graph layout, no edges)
2. No initial-state marker (arrows require a transition target)
3. A callout appears above: "This entity's status is modified by automation on {source entity} — no transitions are declared."
4. A "View {source entity} lifecycle →" link navigates to the entity where the causal chain originates

If an integrator later adds transition rows (via SQL or Phase 3 GUI), the statechart switches to the standard graph layout automatically.

The prototype includes both variants for comparison:
- `staff_onboarding` — with declared automatic transitions and upstream cause descriptions
- `staff_onboarding_no_transitions` — zero transitions, floating nodes with callout

### S2-D9: Language Principles

| Implementation term | User-facing term | Rationale |
|-------------------|-----------------|-----------|
| `on_transition_rpc` | "User action" / function display name | Describes the action that causes this transition (S2-D10, resolved) |
| NULL RPC | "Automatic" / source description | Describes what happens without user action |
| Guard conditions | "Requirements" | Describes what's needed, not the mechanism |
| BEFORE/AFTER phase | Not shown (Session 4 only) | Implementation detail for integrators |
| `effect_category` | Guard / Auto-update / Sync / Audit / Notify | Describes what the function accomplishes |
| Terminal / Initial | Kept as-is | Domain concepts, not PostgreSQL terminology |

### S2-D10: `on_transition_rpc` Semantics — Resolved

**Resolution: Interpretation A — the RPC that causes the transition.**

The `on_transition_rpc` column records the function that a user (or system) invokes to move from one status to another. The edge label on the statechart answers "how does this transition happen?" NULL means no single action causes this transition directly — it occurs as a downstream effect of something else.

This interpretation aligns with the Session 2 statechart design: solid edges mean "a user or scheduled job invokes this function," dashed edges mean "this happens automatically as a consequence."

**Historical context:** The ambiguity exists because the system's interaction model has evolved. Civic OS was originally more edit-page-centric — users edited properties directly (including status via a dropdown), and automation reacted to those edits. Under that model, `on_transition_rpc` would naturally be reactive (Interpretation B): "when the user changes the status dropdown from Pending to Approved, call this function."

Over time, the design shifted toward action buttons. Users prefer clicking "Approve" over selecting from a dropdown. The entity actions system (`metadata.entity_actions`) now provides the primary UX for status transitions — a button that calls an RPC, which changes the status as one of its effects. Under this model, `on_transition_rpc` is the RPC that causes the transition (Interpretation A), and the old dropdown-edit pathway is deprecated in favor of buttons.

The column name (`on_transition_rpc`) still reads like reactive phrasing, and `STATUS_TYPE_SYSTEM.md` describes it as "RPC to call on transition." This is legacy naming from the edit-centric era. New design work should treat the column as Interpretation A.

**Implications for downstream sessions:**

- **Statechart (this session):** Confirmed. Solid edge = "this function causes the transition." Dashed edge = "no single function causes this — it happens automatically."
- **Session 4 (causal chain):** Trace forward from the RPC as the chain's entry point. The RPC is the cause; status change + downstream effects follow.
- **Phase 3 (editing):** Binding an RPC to a transition means "this function is how users (or automation) move between these statuses." The Phase 3 workflow editor should present this as "When you add a transition, which action triggers it?"
- **Reactive bindings:** If an integrator needs code to run *in response to* a specific transition (Interpretation B), they use `property_change_triggers` with `change_type = 'changed_to'` on the status column. Session 1 already provides this mechanism. There is no need for `on_transition_rpc` to serve double duty.
- **Legacy dropdown editing:** The existing `validate_status_transition()` function and `get_allowed_transitions()` helper still work for edit-page status dropdowns. But the forward-looking design (introspection, visual builder) assumes action-button-driven transitions. The status dropdown may eventually be restricted to read-only display, with all transitions going through entity actions.

**Column rename:** `on_transition_rpc` should be renamed to `caused_by_rpc` (or similar — `action_rpc`, `trigger_rpc`) before Phase 3 work begins. Every Phase 3 feature, migration generator, and editor UI built on top of this column will use whatever name exists at that point. Renaming after Phase 3 means rework; renaming before means everything downstream is clean. This is a simple `ALTER TABLE ... RENAME COLUMN` migration with a corresponding update to the PostgREST API surface and any frontend references. Target: before Session 6 (Phase 3 editing affordances).

---

## Data Requirements

| Table/View | Columns Used | Purpose |
|-----------|-------------|---------|
| `metadata.statuses` | `id`, `entity_type`, `display_name`, `color`, `sort_order`, `is_initial`, `is_terminal` | Node rendering |
| `metadata.status_transitions` | `from_status_id`, `to_status_id`, `on_transition_rpc`, `required_role`, `required_fields`, `description` | Edge rendering |
| `metadata.property_change_triggers` | `function_name`, `display_name`, `change_type`, `effect_category` (where status column + `change_type = 'any'`) | Listener panel |
| `rpc_entity_effects` + `notification_triggers` | Count per RPC | Effects count badge |

**New column:**
- `metadata.property_change_triggers.effect_category` — guard / auto_update / sync / audit / notify

**Columns NOT added (removed from earlier revision):**
- ~~`metadata.status_types.is_computed`~~ — "computed status" is not a framework concept
- `metadata.status_transitions.triggered_by` — still potentially useful for linking automatic transitions to their cause, but deferred to Session 4 where causal chain traversal will clarify the requirements

---

## Session Changelog

Changes made during the design session, in order. These capture the reasoning evolution, not just the final state.

### Change 1: BEFORE/AFTER → Effect Categories

**Problem:** The initial design labeled all-transition listeners with PostgreSQL trigger phases (BEFORE/AFTER). A municipal clerk has no mental model for when a function runs relative to a database commit.

**Resolution:** Replaced with five effect categories (guard, auto_update, sync, audit, notify) that describe what the function accomplishes. The ordering reflects causal flow: guards can block, auto-updates modify the record, syncs propagate to other entities, audit logs the change, notifications tell people. Trigger phase surfaces only in the Session 4 trace view as technical metadata for integrators.

**Schema impact:** New `effect_category` column on `property_change_triggers`.

### Change 2: "Computed Status" Eliminated

**Problem:** The initial design treated computed statuses (like staff_onboarding) as a distinct concept with special visual treatment — dashed nodes, hatched fills, a third edge variant, and an `is_computed` flag.

**Insight:** "Computed status" is not a framework primitive. It's a regular status property modified as a downstream effect of automation on another entity. Using D4's causal chain anatomy, the onboarding status is an **effect** — the output end of a chain originating at staff_document. Every component already has a name in the model.

**Resolution:**
- Removed `is_computed` flag, dashed/hatched nodes, computed edge variant
- Two edge types only: user action (solid) and automatic (dashed)
- Entities with no declared transitions show floating nodes with an explanatory callout
- Entities with declared automatic transitions render normally with dashed edges
- The upstream cause appears in the `consequence_source` field on the transition edge

### Change 3: Three Edge Types → Two

**Consequence of Change 2.** The dotted "computed" edge was distinct from the dashed "automatic" edge. With the computed concept eliminated, both cases are NULL-RPC transitions — the dashed automatic edge covers both. The difference between "side effect of parent cancellation" and "computed from child document approvals" is a matter of the edge label, not the line style.

### Change 4: `on_transition_rpc` Semantics Resolved

**Problem:** The column `on_transition_rpc` could mean either "the RPC that causes this transition" (Interpretation A) or "the RPC that fires when this transition occurs" (Interpretation B). The column name suggests B; the actual example data works as A.

**Context from project founder:** The system evolved from an edit-page-centric model (users change status via dropdown, automation reacts) toward an action-button model (users click "Approve," the RPC changes status as an effect). The column was designed in the old world but populated for the new one. The forward direction is action buttons, not dropdown edits.

**Resolution:** Interpretation A — the RPC that causes the transition. Reactive bindings (Interpretation B) are handled by `property_change_triggers` from Session 1. The two systems have complementary roles: `on_transition_rpc` records how a transition is caused; `property_change_triggers` records what fires in response to property changes (including status changes). This confirms the Session 2 statechart design: solid edge = user/system action, dashed edge = automatic consequence.

---

## Inputs to Future Sessions

### For Session 3 (Entity Context Diagram):

1. **The statechart's listener panel and the context diagram's trigger section overlap.** The listener panel shows functions that fire on any status change for this entity. The context diagram shows all incoming/outgoing causal arrows. Status-related automation appears in both. Decision needed: does the context diagram reference the statechart for status automation, or duplicate it?

2. **Zero-transition entities need context diagram treatment.** Staff_onboarding has no statechart (or a minimal one), but it has a rich incoming causal arrow from staff_document. The context diagram is the *primary* visualization for such entities — it shows what writes to this entity's status and why.

3. **Effect categories apply beyond statuses.** The guard/auto_update/sync/audit/notify taxonomy was designed for status listeners but applies equally to property change triggers on non-status columns. Session 3 should use the same categories when showing triggers on the context diagram.

### For Session 4 (Causal Chain UI):

1. **`on_transition_rpc` is the causal entry point (S2-D10, resolved).** Trace forward from the RPC: user invokes function → status changes → downstream effects fire. For automatic transitions (NULL RPC), the entry point is the upstream cause described in `consequence_source` or `triggered_by`. The reactive side (what fires in response to the status change) comes from `property_change_triggers`.

2. **Trigger phase (BEFORE/AFTER) surfaces here.** The statechart deliberately hides it. The trace view should show it as collapsible technical metadata, labeled "Execution details" with a brief explanation of what BEFORE vs AFTER means.

3. **The "View full causal chain →" button needs a route.** Proposed: `/introspection/entity/:type/chain/:transitionId`

4. **Automatic transitions may not have a single RPC to trace.** Mott Park's Pending → Paid has 5 different pathways (1 Stripe webhook + 4 manual RPCs). The trace view needs to handle "multiple entry points" for a single transition.

5. **Cross-entity effects create the deepest chains.** The approval chain for Mott Park reservation_request fans out to 3+ entities. Staff_document approval reaches into staff_members via `update_onboarding_status()`. These cross-entity boundaries are where the trace view earns its value.

### For Session 6 (Phase 3 Editing):

1. **`on_transition_rpc` = "which action triggers this transition" (S2-D10, resolved).** The Phase 3 workflow editor should present binding an RPC as "When you add a transition, which action triggers it?" Leaving it NULL means the transition happens automatically. This aligns with the action-button-centric direction of the system.

2. **Two edge types simplify the editing UX.** Drawing a new transition just needs: source node, target node, and optionally an RPC binding. If an RPC is bound, the edge renders solid. If not, it renders dashed. No mode selection needed.

3. **Zero-transition → with-transitions is a natural Phase 3 flow.** An integrator looking at floating nodes for staff_onboarding might decide to declare the expected transitions for documentation. Phase 3 should make this easy: draw edges between the floating nodes, add `consequence_source` descriptions.

4. **The `effect_category` column needs a Phase 3 input control.** When an integrator registers a property change trigger, they select the category from a dropdown. The five options are self-describing.

5. **Status dropdown editing may become restricted.** With `on_transition_rpc` firmly as Interpretation A, the forward design assumes all transitions happen through entity action buttons, not by editing the status dropdown directly. Phase 3 could make the status dropdown read-only on edit pages for entities that have declared transitions, forcing changes through the action buttons. This is not a Session 2 decision but should be considered in Phase 3 planning.

---

## Prototype

`statechart-prototype.jsx` demonstrates:
- All seven workflow variants from CAUSAL_BINDINGS_EXAMPLES.md (including both with-transitions and zero-transitions versions of staff_onboarding)
- Two edge types only (user action = solid, automatic = dashed)
- All status nodes rendered identically (no computed visual treatment)
- Rank-based L→R layout with back-edge routing
- Zero-transition layout (floating horizontal row with callout)
- Click-to-popover with causal chain preview
- Listener panel grouped by effect category
- User-facing language throughout

---

## License

Copyright (C) 2023-2026 Civic OS, L3C. Licensed under AGPL-3.0-or-later.
