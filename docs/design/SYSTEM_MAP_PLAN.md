# System Map — Master Plan

**Status:** 📋 Active plan
**Created:** 2026-03-06
**Supersedes:** Work Session Plan (§7) in `INTROSPECTION_UX_DESIGN.md`
**Context:** Sessions 1–4 completed; hierarchy revised in Session 4 (L4 siblings replace linear L4→L5)

---

## 1. The System Map Metaphor

A Civic OS application is a system with a lot of detail hidden inside. The **System Map** is the organizing metaphor for introspection: like a geographic map, it shows the appropriate level of detail at each "zoom" level. Zoom out and you see all entities and their relationships. Zoom in and you see status diagrams, property details, automation chains. Every zoom level is a directly addressable view with consistent navigation between levels.

This metaphor emerged during Session 3 and retroactively explains the design decisions from Sessions 1–3. It also revealed a missing zoom level (Entity Overview) and motivated the mid-project replan.

---

## 2. Zoom Hierarchy

Four semantic zoom levels. Level 4 has sibling views (Lifecycle Detail and Execution Trace) rather than a linear chain.

| Level | Name | Scope | Shows | Primary Viz | Status |
|-------|------|-------|-------|-------------|--------|
| 1 | **Application** | All entities | Unified topology, entity names, descriptions, capabilities | Simplified ERD (JointJS) | ✅ Designed (`SYSTEM_MAP_NAVIGATION_DESIGN.md`) |
| 2 | **Entity-to-Entity** | One entity + neighbors | Causal/structural edges, aggregated effects | Context Diagram (JointJS) | ✅ Designed (`CONTEXT_DIAGRAM_DESIGN.md`) |
| 3 | **Entity Overview** | One entity | Properties, capabilities, validations, permissions, inline embeds | Sections page with embedded diagrams | 📋 Session 5 |
| 4a | **Lifecycle Detail** | One entity's statuses | Status nodes, transitions, listener panel | Statechart (JointJS + SVG) | ✅ Designed (`STATECHART_VISUALIZATION_DESIGN.md`) |
| 4b | **Execution Trace** | One event path | Step-by-step causal chain across entity boundaries | Event-function-effect sequence | 📋 Session 6 |

```
L1:  Application
L2:  Entity-to-Entity (Context Diagram)
L3:  Entity Overview
L4:  Detail views (siblings)
     ├─ Lifecycle Detail (Statechart)
     └─ Execution Trace (Causal Chain)
```

**Why L4 siblings, not L4→L5:** Execution Traces can originate from property change triggers, entity actions, and context diagram edges — not only from status transitions. Trace does not depend on or pass through Lifecycle. Both are "deep detail" views accessible from Entity Overview. The breadcrumb uses a dropdown on the L4 segment to enable sibling navigation (S4-D4).

**Navigation rules:**
- Single-click advances exactly one zoom level (`zoom-in` cursor)
- Right-click opens a context menu for jumping to any level
- Breadcrumbs grow progressively and help navigate back up
- L4 siblings are navigable via breadcrumb dropdown
- Browser back returns to previous level

**Trace Index:** `/system-map/entity/:type/trace` (no query params) is a listing of all automation entry points for an entity — status transitions with RPCs, property change triggers, and entity actions. Selecting one opens the specific trace. This page is reachable via the L4 breadcrumb dropdown from Lifecycle, or directly from Entity Overview and Context Diagram.

**Future level (not in current plan):** A **Module** level above Application — groups of related entities shown as named regions. Needed when instances grow to 30+ entities. Deferred because current examples (3–8 entities) don't require it and there's no way to dogfood/prototype it yet.

### Permissions as a Layer

Permissions are not a zoom level — they cut across levels and behave differently at each one:

| Level | Permission behavior |
|-------|-------------------|
| **Application** | Role overlay: opacity/transparency shows which entities a role can access. Admin toggle. |
| **Entity-to-Entity** | Same role overlay on neighboring entities. |
| **Entity Overview** | Concrete section: CRUD matrix, RLS policy summaries, action permissions per role. |
| **Lifecycle Detail** | Which transitions each role can trigger (via entity action permissions). |
| **Execution Trace** | Conditions/permissions shown as inline annotations on each step. |

Default behavior: show everything the current user has read access to. Admins get a role selector to view the system as any role.

---

## 3. ERD Decomposition

The existing Schema Editor ERD (`SCHEMA_EDITOR_DESIGN.md`) predates the System Map concept. It currently packs content from multiple zoom levels into one screen. Session 4 decomposed it. Here is the redistribution:

| Current ERD element | Destination level | Notes |
|-------------------|------------------|-------|
| Entity boxes (names + relationship lines) | **Application** | Simplified — no property lists on canvas; boxes show name, 2-line description, 4 capability icons |
| Entity boxes (property detail, type badges, capability indicators) | **Entity Overview** | Properties section |
| Inspector panel (Properties tab) | **Entity Overview** | Core content |
| Inspector panel (Relations tab) | **Entity Overview** | Relationships section |
| Inspector panel (Validations tab) | **Entity Overview** | Validations section |
| Inspector panel (Permissions tab) | **Entity Overview** | Permissions section |
| Entity sidebar (search, filter, minimap) | **Navigation shell** | Persistent across levels |
| Relationship lines (FK detail, cardinality) | **Application** (unified, no arrows/cardinality) + **Entity-to-Entity** (with causal overlay) | Application: all connections uniform. Detail in popovers at L2+ |
| Toolbar (layout, zoom, export) | **Application** | Canvas controls in sidebar Section 2 |
| Inspector panel (right side) | **Removed at Application level** | Returns in Phase 3 edit mode (Session 7) |

---

## 4. Completed Sessions

### Session 1: Property Change Trigger Schema ✅ (v0.33.0)

**Deliverable:** `property_change_triggers` table, `on_transition_rpc` bindings, `CAUSAL_BINDINGS_EXAMPLES.md`

Formalized the event-to-function bindings that were previously buried in PL/pgSQL source code. This is the prerequisite for all causal visualization.

### Session 2: Statechart Visualization ✅ (Design Complete)

**Deliverable:** `STATECHART_VISUALIZATION_DESIGN.md` — 10 decisions (S2-D1 through S2-D10), prototype

Key outcomes:
- Dual renderer (JointJS full canvas + lightweight SVG inline embed)
- Two edge types only (user action = solid, automatic = dashed)
- "Computed status" eliminated as a concept — it's a regular status modified by downstream effects
- `on_transition_rpc` semantics resolved as Interpretation A (the RPC that causes the transition)
- Effect category system: guard / auto_update / sync / audit / notify
- New `effect_category` column on `property_change_triggers`

### Session 3: Entity Context Diagram ✅ (Design Complete)

**Deliverable:** `CONTEXT_DIAGRAM_DESIGN.md` — 11 decisions (S3-D1 through S3-D11), prototype

Key outcomes:
- Focal-only edges (no peripheral-to-peripheral)
- Hub layout with zone-based positioning (incoming left, outgoing right, structural top)
- Arrows follow write direction; structural-only edges have no arrows
- System tables are capabilities, not peer nodes
- Three edge styles: solid (structural + causal), blue dashed (causal only), gray dashed (structural only)
- Identified missing Entity Overview zoom level → triggered this replan
- Terminology: "Structural" and "Causal" throughout (migration S3-M1 needed for `schema_entity_dependencies`)

### Session 4: Navigation Shell + ERD Decomposition ✅ (Design Complete)

**Deliverable:** `SYSTEM_MAP_NAVIGATION_DESIGN.md` — 7 decisions (S4-D1 through S4-D7), prototype

Key outcomes:
- `/system-map` root URL, fully superseding `/schema-editor` (no redirect needed — S2/S3 routes were design-only)
- Single-click advances exactly one zoom level with `zoom-in` cursor; right-click context menu for jumping to any level
- Application-level entity boxes: name + 2-line truncated description + four capability icons (workflow, payments, calendar, map)
- No inspector panel at Application level in Phase 2; returns in Phase 3 edit mode
- Breadcrumbs grow progressively, always reflect zoom hierarchy regardless of navigation path
- L4 breadcrumb segment has dropdown for sibling navigation (Lifecycle ↔ Trace)
- Sidebar persistent at all levels: constant entity list + level-specific Section 2 content
- Unified topology at Application level: no structural/causal distinction, no arrows, no cardinality — all connections shown as uniform edges
- **Hierarchy revision:** Lifecycle Detail and Execution Trace are L4 siblings, not linear L4→L5. Traces can originate from property changes, entity actions, and context diagram edges — not only status transitions.
- Trace Index page (`/system-map/entity/:type/trace`) lists all automation entry points grouped by source
- Phase 3 forward reference: view/edit mode toggle, cursor vocabulary shift (`zoom-in` → `default`)

---

## 5. Upcoming Sessions

### Session 5: Entity Overview

**Scope:** Design the entity's "home page" — the zoom level between Context Diagram and detail views. This is where users land when they click the focal node on a Context Diagram.

**Key questions to resolve:**
- Section layout: properties, capabilities, validations, permissions, inline embeds
- All inspector panel content migrates here (S4-D7)
- Inline statechart embed (S2-D1 lightweight SVG) — size, interactivity, click-through
- Inline context diagram embed — same questions
- Capabilities display (status columns, file FKs, calendar/map/notes/payments/search flags)
- Permissions section: CRUD matrix for this entity, RLS policy summaries, action permissions
- Progressive disclosure: what's always visible vs. expandable
- Trace entry points: how entity actions and property change triggers link to traces

**Output:** `ENTITY_OVERVIEW_DESIGN.md`

**Inputs from prior sessions:**
- S2-D1 inline embed spec (lightweight SVG renderer)
- S3-D7 node contents (display name + lifecycle line — this is the compact version)
- S3-r3 changelog (capabilities removed from context diagram, deferred to this level)
- ERD inspector panel (Properties/Relations/Validations/Permissions tabs) — all content migrates here (S4-D7)
- S4-D2 click-through: focal node → Entity Overview (`zoom-in` cursor)
- S4-D3 entity box content: name + description + capability icons at Application level; full detail here
- S4-D4 breadcrumb: `🗺️ > {Entity} > Overview`; sidebar Section 2 shows page table of contents
- S4-D5 sidebar: Entity Overview gets anchor links to sections as Section 2 content
- `INTROSPECTION_UX_DESIGN.md` §3.2 Entity Level sections table

### Session 6: Causal Chain UI + Permissions Layer

**Scope:** Two related topics combined. The causal chain is the Execution Trace (L4 sibling to Lifecycle). The permissions layer is the role overlay at Application and Entity-to-Entity levels.

**Causal chain questions:**
- Trace Index page design: grouping, sorting, filtering of entry points (S4-D4 established its existence; Session 6 designs the content)
- Entry points: statechart popover → "View full causal chain", context diagram edge popover → "View causal chains", entity action → chain for that action, property change trigger → chain for that trigger
- The graph walk algorithm (D9 from original design): joining `rpc_entity_effects` to `property_change_triggers` on `(table_name, property_name)`
- Multiple entry points for one transition (Mott Park's 5 pathways to Paid)
- Cross-entity boundary visualization (P5 inline expansion)
- BEFORE/AFTER as collapsible technical metadata
- Forward ("what happens when...") vs backward ("what could cause...") traversal
- Blockly integration (O7): link to existing visualization, embed, or just show description?
- Card layout for event-function-effect sequence

**Permissions layer questions:**
- Role selector UI at Application and Entity-to-Entity levels
- Opacity/transparency mechanics for inaccessible entities
- What "no access" looks like (grayed out? hidden? badge?)
- Application level has no causal overlay toggle (S4-D6: unified topology) — how does role overlay interact with that?
- Whether edge visibility changes with role overlay at Context Diagram level

**Output:** `CAUSAL_CHAIN_DESIGN.md` + `PERMISSIONS_LAYER_DESIGN.md` (or combined if scope allows)

**Inputs from prior sessions:**
- S2-D5 transition popover ("View full causal chain →" button)
- S2-D6 effect categories (same taxonomy applies to chain steps)
- S3-D8 edge detail popover ("View causal chains →" button)
- S4-D1 trace route: `/system-map/entity/:type/trace?transition=X&target=Y&action=Z`
- S4-D4 Trace Index page and L4 breadcrumb dropdown
- S4-D6 no structural/causal distinction at Application level
- D4 causal chain anatomy (event → function → effects)
- D9 effect-event duality and graph walk algorithm
- P5 inline expansion at entity boundaries

### Session 7: Phase 3 Editing Affordances

**Scope:** Review all designed surfaces and specify exactly which elements become editable, what controls they need, and what the migration generation strategy looks like.

**Key questions to resolve:**
- Per-level edit affordances: what becomes editable at each zoom level
- Migration generation: how GUI edits translate to SQL migrations
- Entity creation workflow (Application level)
- Property creation/editing (Entity Overview)
- Status/transition editing (Statechart — S2-D11 already specifies some)
- Cross-entity automation wiring (Context Diagram — S3-D11 already specifies some)
- `caused_by_rpc` rename (from `on_transition_rpc`) — execute before building on top of it
- Effect-event bidirectional awareness in builder (D9, O9)
- Status dropdown restriction for entities with declared transitions
- View/edit mode toggle: `zoom-in` cursor → `default`, single-click navigates → selects, inspector panel returns (S4-D2, S4-D7 forward references)

**Output:** `PHASE3_EDITING_DESIGN.md`

**Pre-session migration tasks:**
- Rename `on_transition_rpc` → `caused_by_rpc` (S2-D10 recommendation)
- S3-M1: rename `'behavioral'` → `'causal'` in `schema_entity_dependencies` view

---

## 6. Open Question Tracker

Mapped from `INTROSPECTION_UX_DESIGN.md` §6 to their resolution location:

| # | Question | Resolution |
|---|----------|-----------|
| O1 | Statechart rendering technology | ✅ Session 2 (S2-D1: JointJS + SVG dual renderer) |
| O2 | Causal chain UI component | Session 6 |
| O3 | Context diagram layout | ✅ Session 3 (S3-D2: hub layout with zones) |
| O4 | All-transition status listeners | ✅ Session 2 (S2-D6: effect categories on `property_change_triggers`) |
| O5 | Property change trigger execution model | Out of scope (backend implementation, not UX design) |
| O6 | Progressive disclosure levels by role | Session 6 (permissions layer) |
| O7 | Integration with existing Blockly visualization | Session 6 (causal chain — decide link vs embed vs description) |
| O8 | Dashboard-entity cross-references | Deferred (future enhancement, not in current plan) |
| O9 | Phase 3 cross-entity effect-event detection | Session 7 |
| O10 | Portable status references in property change triggers | Deferred (implementation detail, track separately) |

---

## 7. Migration Items

Pre-implementation tasks that should be completed before the sessions that depend on them:

| Item | Description | Depends on | Needed before |
|------|-------------|-----------|---------------|
| S3-M1 | Rename `'behavioral'` → `'causal'` in `schema_entity_dependencies` view CTEs | Session 3 decision | Session 7 (Phase 3 editing) |
| S2-D10 | Rename `on_transition_rpc` → `caused_by_rpc` on `metadata.status_transitions` | Session 2 decision | Session 7 (Phase 3 editing) |
| S2-D6 | Add `effect_category` column to `metadata.property_change_triggers` | Session 2 decision | Implementation of statechart or context diagram |

---

## 8. Standing Decisions

These decisions from `INTROSPECTION_UX_DESIGN.md` remain in effect. They are not repeated here in full — refer to the original document for detail.

| Decision | Summary | Status |
|----------|---------|--------|
| D1 | Two relationship categories: structural and causal | ✅ Standing |
| D2 | Entity-centric navigation as primary axis | ✅ Standing |
| D3 | Three zoom levels → five → **four with L4 siblings** (see §2) | 🔄 Updated (Session 4) |
| D4 | Causal chain anatomy: event → function → effects | ✅ Standing |
| D5 | Formalized event-to-function bindings | ✅ Implemented (v0.33.0) |
| D6 | Entity context diagram | ✅ Refined by Session 3 |
| D7 | Statecharts for status lifecycle | ✅ Refined by Session 2 |
| D8 | Phase 3 readiness principle (every view = future editing surface) | ✅ Standing |
| D9 | Effect-event duality at entity boundaries | ✅ Standing |
| D10 | Computed statuses | ✅ Eliminated as concept (Session 2, S2-D7) |

### Standing UX Principles

From `INTROSPECTION_UX_DESIGN.md` §5:

- **P1:** Structural is the base layer; causal is the overlay — **except at Application level** where topology is unified (S4-D6). The overlay toggle first appears at Entity-to-Entity level.
- **P2:** Semantic zoom (each level changes what *kind* of information is visible)
- **P3:** Directed flow for causal, flexible layout for structural
- **P4:** Show the happy path, annotate the conditions
- **P5:** Inline expansion at entity boundaries
- **P6:** Every view is a future editing surface

---

## 9. Document Map

| Document | Content | Status |
|----------|---------|--------|
| `SYSTEM_MAP_PLAN.md` | This document — master plan and session tracker | 📋 Active |
| `INTROSPECTION_UX_DESIGN.md` | Original conceptual model, decisions D1–D10, principles P1–P6 | ✅ Reference (session plan superseded by this doc) |
| `STATECHART_VISUALIZATION_DESIGN.md` | Session 2 — statechart rendering decisions | ✅ Complete |
| `CONTEXT_DIAGRAM_DESIGN.md` | Session 3 — context diagram rendering decisions | ✅ Complete |
| `SYSTEM_MAP_NAVIGATION_DESIGN.md` | Session 4 — navigation shell + ERD decomposition | ✅ Complete |
| `SYSTEM_INTROSPECTION_DESIGN.md` | Database layer — tables, views, static analysis | ✅ Reference |
| `CAUSAL_BINDINGS_EXAMPLES.md` | Test data — all causal bindings across examples | ✅ Reference |
| `SCHEMA_EDITOR_DESIGN.md` | Existing ERD — source material for Session 4 decomposition | ✅ Reference (superseded by `/system-map`) |
| `ENTITY_OVERVIEW_DESIGN.md` | Session 5 output — entity home page | 📋 Upcoming |
| `CAUSAL_CHAIN_DESIGN.md` | Session 6 output — execution trace UI + trace index | 📋 Upcoming |
| `PERMISSIONS_LAYER_DESIGN.md` | Session 6 output — role overlay mechanics | 📋 Upcoming |
| `PHASE3_EDITING_DESIGN.md` | Session 7 output — view-to-edit bridge | 📋 Upcoming |

---

## License

Copyright (C) 2023-2026 Civic OS, L3C. Licensed under AGPL-3.0-or-later.
