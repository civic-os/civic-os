# System Map Navigation Shell — Session 4 Design Decisions

**Status:** ✅ Design Complete
**Session:** 4 of 7 (Navigation Shell + ERD Decomposition)
**Depends on:** Session 2 (statechart — design complete), Session 3 (context diagram — design complete)
**Prerequisite for:** Session 5 (Entity Overview), Session 6 (causal chain + permissions), Session 7 (Phase 3 editing)

**Resolves plan items from `SYSTEM_MAP_PLAN.md` §5 Session 4:**
- URL structure across all levels
- Breadcrumb design showing current position in zoom hierarchy
- Sidebar behavior across levels
- Application-level canvas after property detail extraction
- Entity box content at Application level
- Click-through behavior from Application level
- Causal overlay behavior at Application level

---

## Context

Sessions 2 and 3 designed individual zoom levels (Statechart at Level 4, Context Diagram at Level 2) but left the connective tissue undefined. This session designs the navigation frame — how users move between levels — and specifies the Application-level canvas that results from decomposing the existing ERD.

**Revised hierarchy:** During this session, the original five-level linear hierarchy was revised. Lifecycle Detail and Execution Trace are now Level 4 siblings (both below Entity Overview) rather than a linear L4→L5 chain. This reflects the fact that traces can originate from property change triggers, entity actions, and context diagram edges — not only from status transitions. The zoom hierarchy is:

```
L1:  Application
L2:  Entity-to-Entity (Context Diagram)
L3:  Entity Overview
L4:  Detail views (siblings)
     ├─ Lifecycle Detail (Statechart)
     └─ Execution Trace (Causal Chain)
```

The existing Schema Editor (`/schema-editor`) is a three-panel layout: entity sidebar, JointJS canvas with entity boxes showing full property lists, and a right inspector panel with Properties/Relations/Validations/Permissions tabs. Session 4 decomposes this into the System Map's four-level hierarchy (with Level 4 siblings), redistributing content to the appropriate zoom level.

---

## Decisions

### S4-D1: URL Structure

**Root:** `/system-map` — fully supersedes `/schema-editor`. The old route is removed (no redirect needed; Sessions 2–3 routes exist only in design docs, not in code).

**Route tree:**

```
/system-map                              → Level 1: Application
/system-map/entity/:type                 → Level 3: Entity Overview
/system-map/entity/:type/context         → Level 2: Entity-to-Entity (Context Diagram)
/system-map/entity/:type/workflow        → Level 4: Lifecycle Detail (Statechart)
/system-map/entity/:type/trace           → Level 4: Trace Index (all entry points)
/system-map/entity/:type/trace?...       → Level 4: Execution Trace (specific chain)
```

**Note on Level 4 siblings:** Lifecycle Detail and Execution Trace are peers, not parent-child. Both are detail views accessible from Entity Overview (Level 3). The Trace Index (`/trace` with no params) lists all automation entry points for the entity; selecting one opens the specific trace (`/trace?transition=X`, etc.). See S4-D4 for the breadcrumb dropdown that enables sibling navigation.

**Trace route parameterization:** The Trace Index (`/system-map/entity/:type/trace`) lists all automation entry points. Query params select a specific trace:

```
/system-map/entity/:type/trace?transition=:transitionId
/system-map/entity/:type/trace?target=:targetType
/system-map/entity/:type/trace?action=:actionName
```

Detail deferred to Session 6. The trace view is one component with different starting conditions, not separate pages. The Trace Index (no params) is the entry point from the breadcrumb dropdown.

**Rationale:** "System Map" matches the organizing metaphor from `SYSTEM_MAP_PLAN.md`. "Schema Editor" implied schema editing capability that doesn't exist in Phase 2 and used developer vocabulary. Since no code exists at the old routes, the rename is cost-free.

### S4-D2: Click-Through and Navigation Gestures

**Governing rule:** Single-click advances exactly one zoom level. No exceptions.

**Single-click behavior:**

| Current Level | Click Target | Action | Cursor | Tooltip (500ms) |
|---|---|---|---|---|
| Application | Entity box | → Context Diagram (L2) | `zoom-in` | "View {Entity Name} neighborhood" |
| Application | Edge | Not interactive | — | — |
| Context Diagram | Focal node | → Entity Overview (L3) | `zoom-in` | "View {Entity Name} details" |
| Context Diagram | Peripheral node | Re-center (lateral, stay L2) | `pointer` | "Center on {Entity Name}" |
| Context Diagram | Edge (12px hit area) | Popover (S3-D8) | `pointer` | "View relationship details" |
| Lifecycle Detail | Node/edge | Popover (S2-D5) | `pointer` | — |
| All canvas levels | Blank canvas | Pan | `grab`/`grabbing` | — |

**Cursor vocabulary:**
- `zoom-in` — always means "this click advances one zoom level"
- `pointer` — lateral navigation or popover
- `grab`/`grabbing` — canvas pan

**Right-click context menu at all levels.** Provides jump options to any zoom level, enabling users to skip levels or zoom all the way out without sequential back-navigation.

| Right-Click Target | Menu Items |
|---|---|
| **Entity box/node** | All applicable zoom levels for that entity (Context Diagram, Entity Overview, Lifecycle), plus ← System Map |
| **Relationship edge** (Context Diagram only) | Navigation targets for both connected entities (e.g., "View Permits Context", "View Inspections Context", "View Permits Overview", "View Inspections Overview") |
| **Blank canvas** | Navigation to all higher zoom levels (at Lifecycle: ← Entity Overview, ← Context Diagram, ← System Map) |

Menu items use entity display names: "Permits Overview", "Permits Lifecycle", not "Zoom to Level 3."

**Context Diagram edge interaction:** Edges use a 12px invisible hit area around the 1.5px visible line, making them easy to click. Clicking opens the S3-D8 popover (structural section, forward/reverse effects, "View causal chains →" link). Clicking blank canvas dismisses the popover.

**Cross-entity pivoting in Execution Trace:** Right-clicking a step that belongs to a different entity than the `:type` in the URL offers navigation scoped to that entity — "View Inspections Overview", "View Inspections Lifecycle." This enables following a causal chain and then exploring where it led.

**Phase 3 forward reference (Session 7):** In edit mode, single-click reverts to select+inspect behavior (inspector panel returns). The `zoom-in` cursor changes to `default`. Right-click context menu continues to provide navigation in both modes. The view/edit mode toggle design is deferred to Session 7.

### S4-D3: Entity Box Content at Application Level

Entity boxes at Application level show three elements:

| Element | Rendering | Source |
|---|---|---|
| **Display name** | Bold, top of box | `schema_entities.display_name` |
| **Description** | Smaller text, 2-line truncation with ellipsis | `schema_entities.description` |
| **Capability icons** | Horizontal row, bottom of box | Derived from entity flags (see below) |

**Capability icons (four possible):**

| Icon | Condition |
|---|---|
| Workflow | Entity has rows in `status_transitions` |
| Payments | `payment_initiation_rpc IS NOT NULL` |
| Calendar | `show_calendar = true` |
| Map | `show_map = true` |

Only icons for capabilities the entity has are rendered. Most entities display 0–2 icons.

**Box sizing:** Fixed height. Description truncates at 2 lines with ellipsis; full text in hover tooltip. Entities without descriptions show name + icons. Entities with no capabilities and no description show only the name. Approximate dimensions: 160–180px wide × 90–110px tall (dramatically smaller than the current property-list boxes).

**Removed from canvas (migrated to Entity Overview, Session 5):**
- Property lists and type badges
- Validation indicators
- FK column names
- Search configuration
- Notes/recurring/files indicators

**Relationship lines remain** between entities (FK, M2M, and causal connections — see S4-D6). No text labels on lines; detail in popovers. Consistent with S3-D3's "no text on edges" principle.

### S4-D4: Breadcrumb Design

A horizontal breadcrumb bar below the toolbar shows the current position in the zoom hierarchy. Breadcrumbs grow progressively as the user zooms in and help navigate back up — they never show levels below the current one.

**Breadcrumb at each level:**

| Level | Breadcrumb |
|---|---|
| Application | `🗺️` |
| Context Diagram | `🗺️ > Permits` |
| Entity Overview | `🗺️ > Permits > Overview` |
| Lifecycle Detail | `🗺️ > Permits > Overview > Lifecycle ▾` |
| Trace Index | `🗺️ > Permits > Overview > Trace ▾` |
| Execution Trace | `🗺️ > Permits > Overview > Trace ▾` |

**Rules:**
- `🗺️` (map icon) represents the Application level. Clickable from any deeper level.
- Entity display name represents the Context Diagram (Level 2). Clicking it from any deeper level navigates to the entity's Context Diagram.
- Each segment is clickable except the current (rightmost) level.
- **Breadcrumbs reflect the zoom hierarchy, not the navigation path.** If a user right-clicks to jump from Context Diagram directly to Lifecycle (skipping Entity Overview), the breadcrumb still shows `🗺️ > Permits > Overview > Lifecycle ▾` with Overview as a clickable intermediate target.
- **Lateral navigation resets entity scope.** Re-centering on a different entity or pivoting to a different entity via the Execution Trace updates the entity name segment and all downstream segments.

**Level 4 sibling dropdown:** The rightmost breadcrumb segment at Level 4 includes a `▾` caret. Clicking it opens a dropdown listing sibling views: Lifecycle and Trace. The current view is marked with a dot indicator. This enables lateral navigation between L4 siblings without going back up to Entity Overview.

- **Lifecycle → Trace** via dropdown navigates to the **Trace Index** — a page listing all automation entry points for the entity (status transitions with RPCs, property change triggers, entity actions). The user picks a specific chain to trace.
- **Trace → Lifecycle** via dropdown navigates directly to the Lifecycle statechart.
- The dropdown pattern currently applies only to Level 4 segments. Expanding it to other breadcrumb levels is a future consideration.

**Standard breadcrumb styling.** No special bolding or emphasis. The progressive growth of the breadcrumb is itself the primary orientation cue.

### S4-D5: Sidebar Behavior

The sidebar is persistent at all zoom levels, collapsible via a toggle button. It has two sections:

**Section 1: Entity List (constant across all levels)**
- Scrollable list of all entities with display names
- Search/filter input at top
- Click any entity → navigates to its Context Diagram (Level 2)
- The currently-focused entity (if any) gets a highlighted background
- At Application level, no entity is highlighted

**Section 2: Level-Specific Content (varies by zoom level)**

| Level | Section 2 Content |
|---|---|
| **Application** | Visibility toggles (hide/show entities), minimap, auto-layout, fit-to-screen |
| **Context Diagram** | Fit-to-screen, edge style legend, causal overlay toggle |
| **Entity Overview** | Page table of contents (anchor links to sections: Properties, Capabilities, Validations, Permissions, Lifecycle, Context) |
| **Lifecycle Detail** | Edge type legend, entity-level listeners summary |
| **Trace Index** | Anchor links to entry point groups (Transitions, Property Triggers, Entity Actions) |
| **Execution Trace** | Chain metadata (entry point, entities traversed), expand/collapse controls |

**Canvas controls** (minimap, auto-layout, fit-to-screen, zoom) appear only at levels with a JointJS canvas (Application, Context Diagram, Lifecycle Detail).

**The causal overlay toggle** appears in the sidebar at Context Diagram level. It does not appear at Application level (see S4-D6).

### S4-D6: Unified Topology at Application Level

**At Application level, there is no structural/causal distinction.** A connection is a connection. This follows P2 (semantic zoom): the type of connection is Level 2 information, not Level 1.

**Edge rendering:**
- One edge per connected entity pair, regardless of connection type (FK, M2M, causal, or any combination)
- Uniform style: single solid line, neutral color
- No arrows (direction is a Level 2+ concept)
- No cardinality notation (crow's feet are structural detail, Level 2+)
- No badges, labels, or annotations
- **Not interactive** — edges at Application level are visual topology only, not clickable. Connection detail is accessed by zooming into either entity's Context Diagram.

**Complete topology.** The Application canvas shows all connected entity pairs: FK relationships, M2M relationships, and causal-only connections (entity pairs connected only by cross-entity effects with no FK/M2M). This is more comprehensive than the current ERD, which only shows structural relationships.

**Causal overlay toggle absent at Application level.** The structural/causal distinction first appears at Context Diagram level (Level 2), where the toggle lives in the sidebar. At Application level, the toggle would be meaningless since all edges are already shown uniformly.

**Rationale:** At the highest altitude, users ask "what exists and what's connected?" — not "how are they connected?" The ERD's structural-only view gave an incomplete picture; the unified topology gives the complete one. The Context Diagram is where connection types become relevant.

### S4-D7: Inspector Panel Migration

**Phase 2:** No inspector panel at Application level. The canvas fills the full width between sidebar and window edge.

**Content redistribution:**

| Current Inspector Tab | Destination | Session |
|---|---|---|
| Properties | Entity Overview — Properties section | Session 5 |
| Relations | Entity Overview — Relationships section | Session 5 |
| Validations | Entity Overview — Validations section | Session 5 |
| Permissions | Entity Overview — Permissions section | Session 5 |

The three-panel layout (sidebar + canvas + inspector) is reserved for Phase 3 editing mode. In Phase 2, clicking an entity navigates rather than selecting, so the inspector has no trigger.

**Phase 3 forward reference (Session 7):** In edit mode, the inspector panel returns at Application level. Single-click reverts to select+inspect. The view/edit mode toggle controls cursor vocabulary (`zoom-in` in view mode → `default` in edit mode) and click behavior (navigate in view mode → select in edit mode). Right-click context menu provides navigation in both modes.

---

## ERD Decomposition Summary

Final redistribution of existing Schema Editor elements:

| Current Element | Destination Level | Notes |
|---|---|---|
| Entity boxes (names) | **Application** | Retained, with description and capability icons |
| Entity boxes (property lists, type badges) | **Entity Overview** (S5) | Removed from canvas |
| Entity boxes (capability indicators) | **Application** | Simplified to 4 icons (workflow, payments, calendar, map) |
| Relationship lines | **Application** | Simplified: uniform edges, no arrows, no cardinality |
| Cardinality notation (crow's feet) | **Context Diagram** (S3) | Appears in edge popovers at Level 2+ |
| Arrow direction | **Context Diagram** (S3) | Follows write direction per S3-D5; absent at Level 1 |
| Inspector panel (all tabs) | **Entity Overview** (S5) | Migrated as full sections |
| Toolbar (layout, zoom, export) | **Application** | Canvas controls in sidebar Section 2 |
| Entity sidebar (search, filter) | **Navigation shell** | Persistent entity list across all levels |
| Entity sidebar (minimap) | **Application** | Canvas-level sidebar Section 2 |

---

## Inputs to Future Sessions

### For Session 5 (Entity Overview):

1. **Entity Overview is the entity "home page"** at `/system-map/entity/:type`. It receives all inspector panel content (Properties, Relations, Validations, Permissions) and serves as the hub for zooming into both L4 siblings — Lifecycle and Trace.
2. **Sidebar Section 2** at Entity Overview is a page table of contents with anchor links to sections.
3. **Single-click on the focal node** in the Context Diagram navigates here. The breadcrumb shows `🗺️ > {Entity} > Overview`.
4. **Traces section on Entity Overview.** Both L4 siblings should be directly reachable from Entity Overview. Lifecycle has the inline statechart preview; Traces should have a compact summary showing entry point counts by source (status transitions, property triggers, entity actions) with a "View all traces →" link to the Trace Index. This ensures users can navigate to traces without going through Lifecycle first.
5. **Trace category icons are placeholders until Session 6.** The workflow icon (two connected circles) is established for status transitions. Property change triggers and entity actions use placeholder icons in the prototype. Session 6 designs the Trace Index in full detail and will establish the visual vocabulary for all three trace entry point categories. Session 5 should use the workflow icon and generic placeholders, noting that Session 6 resolves the final icons. The icons must be consistent between the Entity Overview summary and the Trace Index.

### For Session 6 (Causal Chain + Permissions):

1. **Trace route:** `/system-map/entity/:type/trace` (no params) is the Trace Index — lists all automation entry points. `/system-map/entity/:type/trace?transition=X&target=Y&action=Z` opens a specific trace. Single component per view.
2. **Trace Index page:** Lists all automation entry points grouped by source: status transitions with RPCs (from `status_transitions` where `on_transition_rpc IS NOT NULL`), property change triggers (from `property_change_triggers`), and entity actions (from `entity_actions`). Each item shows function name, description, and links to its specific trace.
3. **Lifecycle and Trace are L4 siblings.** The breadcrumb dropdown enables switching between them. Trace is reachable from: Lifecycle (via dropdown or transition popovers), Entity Overview (via trace links on actions or triggers), and Context Diagram (via edge popovers). It does not require passing through Lifecycle.
4. **Breadcrumb at trace level:** `🗺️ > {Entity} > Overview > Trace ▾`
5. **Right-click cross-entity pivoting** in trace: steps belonging to other entities offer navigation to that entity's views.
6. **Causal overlay toggle** first appears at Context Diagram level (sidebar Section 2). Application level has no toggle — topology is unified.

### For Session 7 (Phase 3 Editing):

1. **View/edit mode toggle** controls Application-level behavior:
   - View mode: single-click navigates (`zoom-in` cursor), no inspector panel
   - Edit mode: single-click selects (`default` cursor), inspector panel returns
   - Right-click context menu provides navigation in both modes
2. **The cursor vocabulary must shift** between modes: `zoom-in` (view) → `default` (edit) for entity boxes.

---

## Prototype

`system-map-navigation-prototype.jsx` demonstrates:
- Application-level canvas with simplified entity boxes (name, description, capability icons)
- Unified topology edges (no arrows, no cardinality, non-interactive)
- Breadcrumb progression across zoom levels with L4 sibling dropdown
- Sidebar with entity list and level-specific Section 2
- Click-through with native `zoom-in` cursor
- Right-click context menu at all levels (entities, blank canvas)
- Context Diagram with edge click popovers (12px hit area) per S3-D8
- Trace Index page listing status transitions, property change triggers, and entity actions
- L4 sibling navigation: Lifecycle ↔ Trace via breadcrumb dropdown

---

## License

Copyright (C) 2023-2026 Civic OS, L3C. Licensed under AGPL-3.0-or-later.
