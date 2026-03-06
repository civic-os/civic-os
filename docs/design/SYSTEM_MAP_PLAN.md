# System Map — Master Plan

**Status:** 📋 Active plan
**Created:** 2026-03-06
**Supersedes:** Work Session Plan (§7) in `INTROSPECTION_UX_DESIGN.md`
**Context:** Sessions 1–3 completed; mid-project replan based on insights gained

---

## 1. The System Map Metaphor

A Civic OS application is a system with a lot of detail hidden inside. The **System Map** is the organizing metaphor for introspection: like a geographic map, it shows the appropriate level of detail at each "zoom" level. Zoom out and you see all entities and their relationships. Zoom in and you see status diagrams, property details, automation chains. Every zoom level is a directly addressable view with consistent navigation between levels.

This metaphor emerged during Session 3 and retroactively explains the design decisions from Sessions 1–3. It also revealed a missing zoom level (Entity Overview) and motivated this replan.

---

## 2. Zoom Hierarchy

Five semantic zoom levels, ordered from highest altitude to deepest detail:

| Level | Name | Scope | Shows | Primary Viz | Status |
|-------|------|-------|-------|-------------|--------|
| 1 | **Application** | All entities | Structural topology, entity names | Simplified ERD (JointJS) | 🔄 Exists, needs decomposition |
| 2 | **Entity-to-Entity** | One entity + neighbors | Causal/structural edges, aggregated effects | Context Diagram (JointJS) | ✅ Designed (`CONTEXT_DIAGRAM_DESIGN.md`) |
| 3 | **Entity Overview** | One entity | Properties, capabilities, validations, permissions, inline embeds | Sections page with embedded diagrams | 📋 Session 5 |
| 4 | **Lifecycle Detail** | One entity's statuses | Status nodes, transitions, listener panel | Statechart (JointJS + SVG) | ✅ Designed (`STATECHART_VISUALIZATION_DESIGN.md`) |
| 5 | **Execution Trace** | One event path | Step-by-step causal chain across entity boundaries | Event-function-effect sequence | 📋 Session 6 |

**Navigation rule:** Each level is reachable from its neighbors by a single interaction. No dead ends. Browser back returns to previous level.

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

The existing Schema Editor ERD (`SCHEMA_EDITOR_DESIGN.md`) predates the System Map concept. It currently packs content from multiple zoom levels into one screen. Session 4 will decompose it. For reference, this is the planned redistribution:

| Current ERD element | Destination level | Notes |
|-------------------|------------------|-------|
| Entity boxes (names + relationship lines) | **Application** | Simplified — no property lists on canvas |
| Entity boxes (property detail, type badges, capability indicators) | **Entity Overview** | Properties section |
| Inspector panel (Properties tab) | **Entity Overview** | Core content |
| Inspector panel (Relations tab) | **Entity Overview** | Relationships section |
| Inspector panel (Validations tab) | **Entity Overview** | Validations section |
| Inspector panel (Permissions tab) | **Entity Overview** | Permissions section |
| Entity sidebar (search, filter, minimap) | **Navigation shell** | Persistent across levels |
| Relationship lines (FK detail, cardinality) | **Application** (simplified) + **Entity-to-Entity** (with causal overlay) | Detail in popovers, not on canvas |
| Toolbar (layout, zoom, export) | **Application** | Canvas controls for top level |

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

---

## 5. Upcoming Sessions

### Session 4: Navigation Shell + ERD Decomposition

**Scope:** Design the navigation frame that connects all zoom levels, and specify how the existing ERD simplifies into the Application level.

**Key questions to resolve:**
- URL structure across all levels (`/schema-editor/...` vs `/introspection/...` vs unified)
- Breadcrumb design showing current position in zoom hierarchy
- Sidebar behavior: persistent entity list, current level indicator, search
- How the Application-level canvas changes when property detail is extracted
- What entity boxes show at Application level (name, lifecycle summary, capability icons?)
- Click-through behavior: entity box → Entity Overview or Entity-to-Entity?
- How the causal overlay toggle works at Application level (P1 from original design)

**Output:** `SYSTEM_MAP_NAVIGATION_DESIGN.md`

**Inputs from prior sessions:**
- S3-D9 navigation actions (re-center, view lifecycle, view causal chains)
- S3-D2 route structure (`/schema-editor/entity/:type/context`)
- S2-D1 dual renderer locations (`/schema-editor/entity/:type/workflow`)
- Existing Schema Editor sidebar, toolbar, inspector panel

### Session 5: Entity Overview

**Scope:** Design the entity's "home page" — the missing zoom level between Context Diagram and Statechart. This is where users land when they click an entity.

**Key questions to resolve:**
- Section layout: properties, capabilities, validations, permissions, inline embeds
- Which ERD inspector panel content migrates here vs. stays on the ERD
- Inline statechart embed (S2-D1 lightweight SVG) — size, interactivity, click-through
- Inline context diagram embed — same questions
- Capabilities display (status columns, file FKs, calendar/map/notes/payments/search flags)
- Permissions section: CRUD matrix for this entity, RLS policy summaries, action permissions
- How much of the existing inspector panel can be reused vs. redesigned
- Progressive disclosure: what's always visible vs. expandable

**Output:** `ENTITY_OVERVIEW_DESIGN.md`

**Inputs from prior sessions:**
- S2-D1 inline embed spec (lightweight SVG renderer)
- S3-D7 node contents (display name + lifecycle line — this is the compact version)
- S3-r3 changelog (capabilities removed from context diagram, deferred to this level)
- ERD inspector panel (Properties/Relations/Validations/Permissions tabs)
- `INTROSPECTION_UX_DESIGN.md` §3.2 Entity Level sections table

### Session 6: Causal Chain UI + Permissions Layer

**Scope:** Two related topics combined. The causal chain is the deepest zoom level (execution trace). The permissions layer is the role overlay at Application and Entity-to-Entity levels.

**Causal chain questions:**
- Entry points: statechart popover → "View full causal chain", context diagram edge popover → "View causal chains", entity action → chain for that action
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
- How the overlay interacts with the causal toggle at Application level
- Whether edge visibility changes with role overlay

**Output:** `CAUSAL_CHAIN_DESIGN.md` + `PERMISSIONS_LAYER_DESIGN.md` (or combined if scope allows)

**Inputs from prior sessions:**
- S2-D5 transition popover ("View full causal chain →" button)
- S2-D6 effect categories (same taxonomy applies to chain steps)
- S3-D8 edge detail popover ("View causal chains →" button)
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
| D3 | Three zoom levels → **revised to five** (see §2) | 🔄 Updated |
| D4 | Causal chain anatomy: event → function → effects | ✅ Standing |
| D5 | Formalized event-to-function bindings | ✅ Implemented (v0.33.0) |
| D6 | Entity context diagram | ✅ Refined by Session 3 |
| D7 | Statecharts for status lifecycle | ✅ Refined by Session 2 |
| D8 | Phase 3 readiness principle (every view = future editing surface) | ✅ Standing |
| D9 | Effect-event duality at entity boundaries | ✅ Standing |
| D10 | Computed statuses | ✅ Eliminated as concept (Session 2, S2-D7) |

### Standing UX Principles

From `INTROSPECTION_UX_DESIGN.md` §5:

- **P1:** Structural is the base layer; causal is the overlay
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
| `SYSTEM_INTROSPECTION_DESIGN.md` | Database layer — tables, views, static analysis | ✅ Reference |
| `CAUSAL_BINDINGS_EXAMPLES.md` | Test data — all causal bindings across examples | ✅ Reference |
| `SCHEMA_EDITOR_DESIGN.md` | Existing ERD — source material for Session 4 decomposition | ✅ Reference |
| `SYSTEM_MAP_NAVIGATION_DESIGN.md` | Session 4 output — navigation shell + ERD decomposition | 📋 Upcoming |
| `ENTITY_OVERVIEW_DESIGN.md` | Session 5 output — entity home page | 📋 Upcoming |
| `CAUSAL_CHAIN_DESIGN.md` | Session 6 output — execution trace UI | 📋 Upcoming |
| `PERMISSIONS_LAYER_DESIGN.md` | Session 6 output — role overlay mechanics | 📋 Upcoming |
| `PHASE3_EDITING_DESIGN.md` | Session 7 output — view-to-edit bridge | 📋 Upcoming |

---

## License

Copyright (C) 2023-2026 Civic OS, L3C. Licensed under AGPL-3.0-or-later.
