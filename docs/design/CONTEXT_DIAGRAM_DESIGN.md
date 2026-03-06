# Entity Context Diagram — Session 3 Design Decisions

**Status:** ✅ Design Complete (r3)
**Session:** 3 of 6 (Entity Context Diagram)
**Depends on:** Session 1 (property change triggers — v0.33.0), Session 2 (statechart visualization — design complete)
**Prerequisite for:** Session 4 (causal chain UI)

**Resolves open questions from Session 2:**
- **S2→S3-Q1** (Statechart listener panel vs. context diagram overlap) — Resolved: the context diagram shows only cross-entity causal effects between domain entities; entity-internal effects remain on the statechart's listener panel (S3-D6)
- **S2→S3-Q2** (Zero-transition entities need context diagram treatment) — Resolved: the context diagram is the primary visualization for such entities; their incoming causal arrows tell the story the statechart cannot

**Terminology:** "Structural" and "Causal" throughout, consistent with Session 2. The `schema_entity_dependencies` view still stores `'behavioral'` for the causal category — a migration to `'causal'` is needed (see S3-M1).

---

## The Zoom Metaphor

Session 2's statechart is street-level: every status node, every transition edge, every trigger function for one entity's lifecycle.

Session 3's context diagram is neighborhood-level: one entity at center, the domain entities it interacts with around it, and the aggregated causal relationships that flow between them. Individual transitions, trigger functions, and internal field updates are hidden. What remains is the cross-entity picture — "what does this entity cause to happen elsewhere, and what do other entities cause to happen here?"

**What crosses the zoom threshold:** If an effect writes to a different domain entity, it appears as an edge on the context diagram. If it writes to the same entity, it stays on the statechart. System tables and framework integrations (entity notes, files, notifications, scheduled jobs) are capabilities/properties of the entity, not peer nodes — consistent with how the ERD treats system types.

**Missing intermediate level (noted for replan):** There is a gap between this diagram and the statechart — an "entity overview" level showing properties, capabilities, configuration, and inline embeds. This is not addressed in the current 6-session plan. A mid-session replan will determine where it fits.

---

## Decisions

### S3-D1: Focal-Only Edges

The context diagram shows only edges where the focal entity is a participant (source or target). Edges between two peripheral entities are excluded, even if they exist in the schema.

**Rationale:** This diagram answers "how does this entity relate to others?" not "how does the full subgraph around this entity look?" Including peripheral-to-peripheral edges (e.g., contacts → projects when the focal is organizations) would create crossing lines over the focal node and blur the diagram's focus. Users can re-center on a peripheral entity to see its connections.

**Implementation:** The rendering layer filters `schema_entity_dependencies` to rows where `source_entity = focal OR target_entity = focal`. Non-focal edges exist in the data but are not rendered or laid out.

### S3-D2: Entity-Centric Hub Layout

One focal entity at center. Related domain entities arranged around it in zones:

| Zone | Position | Placement rule |
|------|----------|---------------|
| **Outgoing** | Right | Focal entity writes to this entity via causal effects |
| **Incoming** | Left | This entity writes to the focal entity via causal effects |
| **Bidirectional** | Right | Causal writes flow in both directions (outgoing takes priority) |
| **Structural only** | Top | FK/M2M relationship but no causal effects |

Entities within each zone are distributed along a ±54° arc from the zone's primary angle. The hub radius is 280 units in a 960×640 viewport, giving generous spacing.

**Route:** `/schema-editor/entity/:type/context` — part of a navigable Entity Map feature where each entity's context diagram is a directly addressable view.

### S3-D3: Edge Aggregation

Multiple functions/triggers between the same entity pair are aggregated into a single visual edge. The edge carries a midpoint badge pill showing category icons and an effect count.

| Badge element | Source |
|--------------|--------|
| Category icons (colored SVGs) | Distinct `effect_category` values from underlying triggers |
| Effect count | Total number of causal functions (shown when > 1) |

**No text on edges.** Structural labels ("has many"), FK column names, and function names all live in the click popover. Edge angles are too variable for reliable text placement on the canvas.

### S3-D4: Three Edge Styles

| Style | Condition | Visual |
|-------|-----------|--------|
| **Structural + Causal** | FK/M2M and causal rows both exist | Solid blue line |
| **Causal only** | Only causal rows, no FK/M2M | Dashed blue line |
| **Structural only** | Only FK/M2M, no causal rows | Dashed gray line |

### S3-D5: Arrow Direction

**Arrows point in the direction of the write.** This is the single rule governing all arrow rendering.

When `staff_documents.status_id` changes and `update_onboarding_status()` writes to `staff_members.onboarding_status_id`, the arrow points toward Staff Members — regardless of which entity is the focal node.

Data model:
- **`causalForward`** = effects where the write goes source → target (arrowhead at target)
- **`causalReverse`** = effects where the write goes target → source (arrowhead at source)
- **Structural-only edges have no arrows.** FK direction ("belongs to" vs "has many") is a data modeling concern, not a causal direction. It appears in the click popover, not as visual arrows.

Layout derivation:
- If the focal entity is the target of a `causalForward` effect, the source entity goes in the **incoming** zone (left)
- If the focal entity is the source of a `causalForward` effect, the target entity goes in the **outgoing** zone (right)
- This ensures the same edge data produces correct arrows and layout from either end when re-centering

### S3-D6: Statechart / Context Diagram Overlap

Each visualization shows what's relevant to its zoom level:

| Effect category | Statechart listener panel | Context diagram edge |
|----------------|--------------------------|---------------------|
| **Guard** (entity-internal) | ✅ | ❌ Always same-entity |
| **Auto-update** (entity-internal) | ✅ | ❌ Always same-entity |
| **Sync** (to domain entity) | ✅ | ✅ Shown as edge |
| **Sync** (to system table) | ✅ | ❌ Capability, not peer |
| **Audit** (to entity_notes) | ✅ | ❌ Capability, not peer |
| **Notify** (sends email) | ✅ | ❌ Capability, not peer |

Only sync effects targeting domain entities appear as context diagram edges. Everything else is either entity-internal (statechart only) or a system-table/framework interaction (entity capability — deferred to the entity overview level).

### S3-D7: Node Design

Nodes show only name and lifecycle summary. No capabilities, no feature badges, no description. Detail lives in click popovers.

| Node type | Contents |
|-----------|----------|
| **Focal** | Display name (larger, bold), lifecycle line (`6S · 6T · 5A`), blue border with glow |
| **Peripheral** | Display name, lifecycle line, gray border |

Both use the same shape (rounded rectangle). Focal is distinguished by size (~20% larger), border color, and a subtle outer glow.

Click popover shows: description, lifecycle details, "View lifecycle →" (to statechart), "Re-center →" (reload context diagram for that entity).

### S3-D8: Edge Detail Popover

Clicking a causal edge opens a popover with:

1. **Structural section** (if FK/M2M exists): relationship type + FK column name
2. **Forward effects** (source writes to target): each function with category icon, display name, trigger condition
3. **Reverse effects** (target writes to source): same format
4. **"View causal chains →"** button linking to Session 4

### S3-D9: Navigation

| Action | Target |
|--------|--------|
| Click peripheral → "Re-center" | Context diagram for that entity (`/schema-editor/entity/:type/context`) |
| Click peripheral → "View lifecycle" | Statechart (`/schema-editor/entity/:type/workflow`) |
| Click edge → "View causal chains" | Session 4 trace (`/introspection/entity/:type/chains?target=:target_type`) |

Re-centering is the primary exploration pattern. Browser back button returns to previous center. This creates a navigable entity map where each node is an addressable view.

### S3-D10: Rendering Technology

JointJS for the full canvas at `/schema-editor/entity/:type/context`, consistent with ERD and statechart. Hub-and-spoke layout uses direct coordinate math (not Dagre — no rank structure needed).

Inline embed deferred — will be addressed when the intermediate "entity overview" zoom level is designed.

### S3-D11: Phase 3 Readiness

| Visual element | Phase 3 edit |
|----------------|-------------|
| Causal edge | Register/modify cross-entity effects |
| Edge category badges | Change effect category |
| Structural edge | Read-only (schema changes → ERD) |
| Peripheral node | Read-only (entity creation → ERD) |

The context diagram is the Phase 3 editing surface for **cross-entity automation wiring**. Schema structure stays on the ERD.

---

## Migration Items

### S3-M1: Rename `'behavioral'` to `'causal'` in `schema_entity_dependencies`

The `rpc_deps` and `trigger_deps` CTEs in `SYSTEM_INTROSPECTION_DESIGN.md` currently output `'behavioral'` as the category. This should become `'causal'` for consistency with Session 2/3 terminology. Affects the view definition only (no table column change — category is computed in the view's CTEs).

---

## Data Requirements

| Table/View | Purpose |
|-----------|---------|
| `schema_entity_dependencies` | All edges (filtered to focal + domain entities only) |
| `schema_entities` | Node rendering |
| `property_change_triggers` | Edge detail popover content |
| `rpc_functions` | Edge detail popover content |
| `rpc_entity_effects` | Cross-entity effect detection |
| `trigger_entity_effects` | Cross-entity effect detection |

**No new tables or columns required.**

---

## Session Changelog

### r1: Initial design with capabilities on focal node and external system nodes

First draft showed system tables (entity_notes, payments.transactions) as peripheral nodes with edges, and notification/scheduled job/payment integrations as separate "external system" nodes in a bottom zone. Focal entity had a capability badge grid.

### r2: Capabilities model — system integrations absorbed into focal node

Followed ERD's system types principle: system tables are capabilities, not peers. External system nodes removed. Focal entity node grew to accommodate a two-column capabilities grid. Terminology updated from "behavioral" to "causal."

### r3: Capabilities removed — diagram is purely topological

Capabilities are properties of an entity, belonging on a future "entity overview" zoom level between context diagram and statechart. The context diagram now shows only entity names, lifecycle summaries, structural edges, and causal edges. No capabilities, no feature badges, no description text on the canvas.

Additional changes in r3:
- Non-focal edges excluded (Q1 resolved)
- Structural-only edges have no arrows (Q2 resolved)
- Arrow direction bug fixed in Staff Members data (causalForward vs causalReverse)
- Layout zone assignment logic clarified to work correctly from either end of an edge
- Edge text labels removed — all detail in popovers
- Missing intermediate zoom level noted for mid-session replan (Q5)
- `'behavioral'` → `'causal'` migration noted as S3-M1 (Q6)

---

## Inputs to Future Sessions

### For Session 4 (Causal Chain UI):

1. **Edge popovers are the entry point.** Each function in the popover links to its trace view. Cross-entity chains start at the focal entity and cross the boundary the context diagram visualizes.

2. **Arrow direction is the trace direction.** A forward arrow (source → target) means the trace follows function execution from the source entity's lifecycle event into the target entity. The trace view should follow this same left-to-right / cause-to-effect orientation.

### For Mid-Session Replan:

1. **Missing zoom level.** An "entity overview" page between context diagram and statechart should show: properties with types (including the special types that are capabilities — status columns, file FKs, calendar/map/notes flags), inline embed of the statechart, inline embed of the context diagram, validations, and configuration. This is the page Session 2 referenced as the host for inline embeds.

2. **The zoom hierarchy is:** Application (ERD) → Entity-to-entity (Context Diagram) → Entity overview (???) → Lifecycle detail (Statechart) → Execution trace (Causal Chain).

### For Session 6 (Phase 3 Editing):

1. **Context diagram edits cross-entity automation.** Drawing a new causal edge means: "when this entity's property changes, write to that entity." The Phase 3 affordance is wiring triggers and effects between entities.

2. **Re-centering works in edit mode.** Integrators wiring multi-entity workflows need to view context from both ends.

---

## Prototype

`context-diagram-prototype.jsx` demonstrates:
- Five example views including structural-only (Broader Impacts) and incoming-focus (Staff Members)
- Focal-only edge filtering (contacts → projects excluded in Broader Impacts)
- Hub-and-spoke layout with zone-based positioning
- Three edge styles: solid (structural + causal), blue dashed (causal only), gray dashed (structural only)
- Arrows follow write direction; structural-only edges have no arrows
- Colored SVG category icons (sync, audit, notify) matching text colors
- Edge-to-node-border intersection geometry
- Edge aggregation with category icon pills and effect count badges
- Click popovers on edges and nodes with navigation affordances

---

## License

Copyright (C) 2023-2026 Civic OS, L3C. Licensed under AGPL-3.0-or-later.
