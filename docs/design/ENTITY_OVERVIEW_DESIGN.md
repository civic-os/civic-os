# Entity Overview — Session 5 Design Decisions

**Status:** ✅ Design Complete
**Session:** 5 of 7 (Entity Overview)
**Depends on:** Session 2 (statechart — design complete), Session 3 (context diagram — design complete), Session 4 (navigation shell — design complete)
**Prerequisite for:** Session 6 (causal chain + permissions), Session 7 (Phase 3 editing)

**Resolves plan items from `SYSTEM_MAP_PLAN.md` §5 Session 5:**
- Section layout and ordering
- Properties section design (migrated from inspector panel)
- Capabilities display (expanding Application-level icons)
- Inline statechart embed behavior
- Inline context diagram embed (decided: not included — see S5-D2)
- Permissions section design
- Validations section design (integrated into Properties — see S5-D3)
- Traces summary section design
- Phase 3 readiness considerations

**Terminology decision:** User-facing labels use "Structural" and "Behavioral" for the two relationship categories. The internal/technical term remains "causal" in code, database columns, and design documents. See S5-D5 for rationale.

**Display name principle:** Wherever an entity, property, role, function, action, or status is referenced by name in the UI, the metadata `display_name` is used — never the database identifier. This applies to capability configuration, FK references, cross-property validation lists, connection labels, CRUD matrix role names, action permission role lists, trace entry point function names, and any other surface where a named object appears. Database identifiers (column names, function names, role keys) appear only in secondary technical detail lines explicitly marked for power users. This is a core design choice supported by the metadata system: Civic OS maintains human-readable display names on properties, entities, roles, functions, statuses, and actions, and the introspection UI should surface the same vocabulary users see throughout the application.

**Property reference badge:** When a property display name appears outside the Properties section — in capability configuration, structural connection labels, cross-property validation lists, or search field names — it renders as a subtle badge (the `PropRef` component) rather than plain text. This distinguishes a reference to a specific named property from ordinary prose. Without the badge, "Facility Location" reads as a description; with it, it reads as the name of a specific field. The badge uses the same visual weight as the `(?)` help icon that appears alongside it. This pattern mirrors how the application already uses the `(?)` icon on form fields — the property name badge and help tooltip are a consistent pair throughout the System Map.

---

## Context

The Entity Overview is Level 3 in the System Map hierarchy — the entity's "home page." It lives at `/system-map/entity/:type` and serves as the most comprehensive single-entity view. Users arrive here by clicking the focal node on a Context Diagram (L2), and it branches down to both L4 siblings: Lifecycle Detail and Execution Trace.

Session 4 established that all content from the existing Schema Editor inspector panel (Properties, Relations, Validations, Permissions tabs) migrates here. Session 5 designs what that looks like with full-page real estate, adds new sections (Capabilities, Connections, Traces), and resolves the inline embed behavior for the statechart.

**Key structural input:** The sidebar Section 2 at Entity Overview is a page table of contents with anchor links to sections (S4-D5). The breadcrumb shows `🗺️ > {Entity} > Overview` (S4-D4).

---

## Decisions

### S5-D1: Page Layout Model

**Scrolling sections page with condensed/expanded states.** Every section has two states:

- **Condensed:** a compact summary appropriate to the section's content type, always visible. Format varies per section — stat lines, icon rows, mini diagrams — whatever communicates the section's essence most efficiently.
- **Expanded:** full detail view with all information for that section.

The page is a vertically scrolling document. All sections are visible simultaneously in their condensed state, giving a scannable overview of the entire entity. Users expand sections they want to explore in detail.

**Sidebar table of contents** provides anchor links to each section. Clicking a TOC link scrolls to the section and auto-expands it if collapsed.

**Rationale:** A tabbed layout (like the old inspector panel) would hide content behind clicks, contradicting the purpose of an "overview" level. A fully expanded page would be overwhelming for entities with many properties. The condensed/expanded hybrid gives both the scannable overview and the full detail, with each section defining its own condensed representation appropriate to its content type.

### S5-D2: Section Inventory and Ordering

Seven sections in this order:

| # | Section | Anchor ID | Condensed Format | Collapsible? | Conditional? |
|---|---------|-----------|-----------------|-------------|-------------|
| 1 | **Identity** | — | Page header | No (always visible) | No |
| 2 | **Capabilities** | `#capabilities` | Icon row with labels | Yes | No (shows "No capabilities configured" if empty) |
| 3 | **Properties** | `#properties` | Stat line | Yes | No |
| 4 | **Connections** | `#connections` | Stat line | Yes | No (shows "No connections" if isolated entity) |
| 5 | **Permissions** | `#permissions` | Stat line | Yes | No |
| 6 | **Lifecycle** | `#lifecycle` | Stat line | Yes | Yes — only if entity has statuses |
| 7 | **Traces** | `#traces` | Category counts with icons | Yes | Yes — only if entity has automation |

**Identity** is the page header, not a collapsible section. It shows the entity display name (prominent), description, and technical metadata (table name, virtual entity flag if applicable).

**No inline context diagram embed.** The Context Diagram (L2) is one breadcrumb click away — the user most likely arrived here from it. Embedding a miniature of the page they just left is redundant and contradicts the zoom metaphor (previewing a *shallower* level rather than a *deeper* one). The Lifecycle embed works because it previews a deeper level.

**Validations are integrated into the Properties section** (S5-D3), not a standalone section. Per-property validations appear inline on property cards; cross-property validations appear as a subsection below the property list.

### S5-D3: Properties Section Design

The densest section — migrated from the inspector panel's Properties tab, now with full-page width.

**Condensed view:** stat line — "{N} properties · {N} required · {N} foreign keys." Search configuration is shown in the Capabilities section, not here.

**Expanded view:** card-per-property list following the existing inspector panel's expand/collapse card pattern.

**Property card — collapsed state:**
- Display name (prominent)
- Type-relevant badges: PK, Required, FK, Status, File, M2M, Geography, etc.
- Badges use Civic OS property type vocabulary, not PostgreSQL column types

**Property card — expanded state:**
- Description (if present)
- Civic OS property type with type-specific detail:
  - **Foreign Key:** "→ {referenced entity display name}"
  - **Status:** entity type identifier
  - **Many-to-Many:** "↔ {related entity} via {junction table}"
  - **File:** indicates file storage linkage
  - **Geography:** property name relevant to map capability
  - Other types: type name is self-explanatory
- Per-property validation rules as compact chips (required, min, max, minLength, maxLength, pattern)
- Secondary technical line for power users: column name, PostgreSQL type

**Non-functional metadata omitted in Phase 2:** sort_order, column_width, visibility flags (show_on_list, show_on_create, show_on_edit, show_on_detail), sortable, filterable. These are configuration concerns, not introspection content. Phase 3 adds them as editable fields on the property cards.

**Cross-property validations subsection:** appears below the property cards within the expanded Properties section. Each rule shows its friendly constraint message and the properties it references (e.g., "End date must be after start date — applies to: start_date, end_date"). This ensures users never see properties without awareness of their validation constraints.

### S5-D4: Capabilities Section Design

Expands the four Application-level capability icons (workflow, payments, calendar, map) into a full picture of what the entity can do.

**Condensed view:** horizontal row of capability icons with labels, showing only capabilities the entity has. Icons match the Application-level vocabulary plus additional capabilities not visible at L1:

| Capability | Icon | Condition | Expanded Detail |
|-----------|------|-----------|----------------|
| **Workflow** | (established) | `status_transitions` rows exist | Status count and transition count |
| **Payments** | (established) | `payment_initiation_rpc IS NOT NULL` | Initiation RPC name, capture mode (immediate/deferred) |
| **Calendar** | (established) | `show_calendar = true` | Time slot property name, color property |
| **Map** | (established) | `show_map = true` | Geography property name |
| **Notes** | (new at L3) | `enable_notes = true` | Boolean — presence is the information |
| **Search** | (new at L3) | `search_fields` is populated | Indexed field names |
| **Recurring** | (new at L3) | `supports_recurring = true` | Recurring property name |
| **Virtual Entity** | (new at L3) | `is_view = true` | Indicates VIEW-backed entity with INSTEAD OF triggers |

Absent capabilities are not shown — no grayed-out icons.

**Expanded view:** each enabled capability gets a detail line showing its configuration. Capabilities with no additional configuration beyond the boolean flag (Notes, Virtual Entity) show presence only.

### S5-D5: Connections Section Design

Shows both structural and behavioral connections. Replaces and expands the old inspector Relations tab (which was structural-only).

**User-facing labels:** "Structural" and "Behavioral." The internal/technical term remains "causal" in code, database columns (`schema_entity_dependencies.category`), and design documents. The label "Behavioral" is more immediately understood by non-technical users than "Causal," even though "causal" better describes the internal mechanics of chain traversal.

**Rationale for the terminology:**
- **Structural connections** are part of the entity's definition — FK references, M2M junctions. They exist in the schema, are always present, and are visible in the data at rest. They describe **what things are**.
- **Behavioral connections** describe what the entity **does** to other entities at runtime — functions that write across entity boundaries, triggered by events. They are dynamic, conditional, and visible only in the automation layer. They describe **what things do to each other**.

**Condensed view:** "{N} structural · {N} behavioral" — counts of each connection type.

**Expanded view:** grouped by related entity. Within each entity group:

1. **Structural connections first:** full sentence format with arrow indicating direction. Outgoing: "{Focal Entity} → references {Related Entity} via `{Property Name}` (?)" where the property name renders as a `PropRef` badge (see property reference badge principle above) and (?) shows the property description on hover (same tooltip pattern used on form fields throughout the app). Incoming: "{Focal Entity} ← is referenced by {Related Entity}" — no property name or tooltip, since the FK property belongs to the other entity and is outside the user's mental context.
2. **Behavioral connections second:** functions and direction (e.g., "Approve Reservation → creates records on Inspections")

Entity groups that have both structural and behavioral connections are sorted before groups with only one type. Within each category, behavioral-only groups (no structural counterpart) appear last — their absence of structural connection is itself informative.

### S5-D6: Inline Statechart Embed

Only present if the entity has statuses. Uses the S2-D1 lightweight SVG renderer (or non-interactive JointJS — renderer choice is an implementation decision, not a design decision).

**Condensed view:** stat line — "{N} statuses · {N} transitions · {N} with automation."

**Expanded view:** simplified inline SVG statechart showing:
- Status nodes colored per `metadata.statuses.color` with initial/terminal markers (S2-D2)
- Transition edges: solid for user action, dashed for automatic (S2-D3)
- Same layout algorithm as the full L4 canvas (S2-D4: rank-based left-to-right) so the shape is consistent when the user zooms in

**Not shown on the embed** (reserved for L4 Lifecycle Detail):
- Annotation badges (effects count, scheduled job indicator, requirement indicator)
- Listener panel (entity-level status change listeners grouped by effect category)
- Transition popovers

**Interactivity:** `zoom-in` cursor over the entire SVG. Click anywhere navigates to `/system-map/entity/:type/workflow` (L4 Lifecycle Detail). No per-node or per-edge interaction. Consistent with S4-D2's single-click-advances-one-level rule.

**Phase 3 note:** the inline embed remains read-only even in Phase 3 edit mode. Workflow editing happens exclusively on the full L4 Lifecycle Detail page where JointJS provides drag-to-reposition, draw-edge, and inspector panel capabilities. This avoids building edit affordances into the embed renderer.

### S5-D7: Permissions Section Design

**Condensed view:** "{N} roles with access · {N} custom rules" — roles counts roles with any CRUD permission on this entity; custom rules counts RLS policies.

**Expanded view:** three subsections in order:

**1. CRUD Matrix**
Roles as rows, Create/Read/Update/Delete as columns, checkmarks for granted permissions. Admin row always present at top. Roles with no permissions on this entity are omitted (all-empty rows provide no information). Ordered by role hierarchy (admin → manager → editor → user → anonymous → custom roles).

**2. Custom Rules (RLS Policies)**
Each policy shows:
- Policy name (always visible, serves as label)
- Comment from `COMMENT ON POLICY` (if present — this is the human-readable description)
- SQL expression available via expandable "Show SQL" toggle for technical users

If no comment exists, the policy name alone is shown with the SQL toggle. This approach is consistent across all policies and rewards integrators who document their work via PostgreSQL comments, without relying on brittle auto-interpretation of SQL expressions.

**3. Action Permissions**
Which entity actions are restricted to specific roles and which roles can execute them. Only shown if the entity has protected actions (actions registered in `protected_rpcs`). Unprotected actions (available to all authenticated users) are noted as such. Each protected action lists its permitted roles.

### S5-D8: Traces Summary Section

Only present if the entity has automation — status transitions with RPCs, property change triggers, or entity actions.

**Condensed view:** counts by category with icons — e.g., "⚡ 3 transition automations · ◇ 2 property triggers · ▣ 4 entity actions." Categories with zero count are omitted. The workflow icon is established for transition automations; property trigger and entity action icons are placeholders per S4-D5 note 5 — Session 6 resolves the final icons.

**Expanded view:** entry points grouped by category:

1. **Transition automations** — status transitions where `on_transition_rpc IS NOT NULL`. Each lists the transition (From → To) and function name.
2. **Property change triggers** — from `property_change_triggers`. Each lists the watched property, change type, and function name.
3. **Entity actions** — from `entity_actions`. Each lists the action display name and function name.

Each entry point is individually clickable, navigating to its specific trace (`/system-map/entity/:type/trace?transition=X`, `/system-map/entity/:type/trace?trigger=X`, `/system-map/entity/:type/trace?action=X`). A "View all traces →" link at the bottom navigates to the Trace Index page (`/system-map/entity/:type/trace`). Both use `zoom-in` cursor per S4-D2.

**Icon consistency requirement:** the icons used in the condensed view must match the icons used on the Trace Index page (Session 6). Session 5 uses placeholders; Session 6 establishes the final visual vocabulary.

### S5-D9: Phase 3 Readiness

Per D8 (every view is a future editing surface) and P6, each section has been evaluated for the view→edit transition:

| Section | Phase 3 Transition | Complexity |
|---------|-------------------|-----------|
| **Properties** | Card expand/collapse accommodates inline edit controls. Cross-property validations get "Add rule" affordance. | Medium — many field types |
| **Capabilities** | Static text → toggle switches and dropdowns. | Low |
| **Connections** | Read-only longest. Structural changes are schema migrations (add/remove FK). Behavioral wiring is automation configuration. | High — Session 7 scope |
| **Permissions** | CRUD matrix → checkbox matrix. Action permissions get role assignment controls. RLS policies require SQL authoring — hardest to make GUI-editable. | Medium-High |
| **Lifecycle embed** | Remains read-only in Phase 3. Editing happens on full L4 canvas. | None at this level |
| **Traces summary** | Remains read-only. Automation wiring is edited at the trace/chain level. | None at this level |

**Key principle:** the inline statechart embed does not become an editing surface in any phase. The JointJS full canvas at L4 is the editing surface for workflow. The Entity Overview embed is always a preview.

---

## Data Sources

| Section | Primary Data Source |
|---------|-------------------|
| Identity | `schema_entities` (display_name, description, table_name, is_view) |
| Capabilities | `schema_entities` (show_calendar, show_map, enable_notes, search_fields, payment_initiation_rpc, supports_recurring, is_view) + `status_transitions` (existence check for workflow) |
| Properties | `schema_properties` (all columns) + `metadata.validations` (per-property and cross-property rules) + `metadata.constraint_messages` |
| Connections | `schema_entity_dependencies` (both `structural` and `causal` categories) |
| Permissions | `schema_permissions_matrix` (filtered to entity) + `pg_policies` (with comments) + `protected_rpc_roles` joined to `entity_actions` |
| Lifecycle | `metadata.statuses` + `metadata.status_transitions` (for inline SVG rendering) |
| Traces | `status_transitions` (where `on_transition_rpc IS NOT NULL`) + `property_change_triggers` + `entity_actions` |

---

## Inputs to Future Sessions

### For Session 6 (Causal Chain + Permissions):

1. **Trace entry points are individually linkable from Entity Overview.** Each entry point in the Traces expanded view links to its specific trace via query params. Session 6 must define the Trace Index page that these links target and the trace visualization they navigate into.
2. **Trace category icons are placeholders.** Session 6 establishes the final icon vocabulary for all three categories (transition automations, property change triggers, entity actions). The icons must be updated on Entity Overview to match.
3. **"Behavioral" is the user-facing label** for causal connections. Session 6 should use this label in the Trace Index page, trace visualization, and any new UI where the structural/causal distinction surfaces. The internal term "causal" continues in code and database schema.
4. **Permissions section uses "custom rules" for RLS policies** and shows policy comments via `COMMENT ON POLICY`. Session 6's permissions layer design should be consistent with this vocabulary — avoid "RLS" in user-facing text.
5. **The Traces condensed view shows category counts with icons.** The Trace Index page should repeat or expand this pattern for consistency.

### For Session 7 (Phase 3 Editing):

1. **Properties section cards are the primary editing surface** for property metadata. Phase 3 adds input controls to the expanded card state. Non-functional metadata (sort_order, column_width, visibility flags, sortable, filterable) — omitted in Phase 2 — is added as editable fields.
2. **Capabilities section transitions to toggle switches and dropdowns.** Straightforward view→edit conversion.
3. **Permissions CRUD matrix becomes a checkbox matrix.** Action permissions get role assignment controls. RLS policy editing (SQL authoring) is the hardest GUI challenge.
4. **Connections section stays read-only longest.** Structural changes require schema migrations. Behavioral wiring requires automation configuration UI.
5. **Inline statechart embed stays read-only in Phase 3.** Workflow editing happens on the L4 full canvas only.
6. **Cross-property validations need an "Add rule" affordance** with a builder for selecting properties and defining the constraint expression.
7. **Display name principle applies to all editing surfaces.** Phase 3 form controls should use display names for labels and options (role selectors, property selectors, function selectors). Database identifiers appear only in technical detail and generated SQL output.
8. **PropRef badge pattern extends to editing.** Property selectors and references in Phase 3 builders should render selected values as PropRef badges, maintaining visual consistency between read and edit modes.

---

## Prototype

`entity-overview-prototype.jsx` demonstrates (test entity: Mott Park Reservation Requests):
- Scrolling sections page with condensed/expanded toggle per section
- Identity header with entity name, description, table name
- Capabilities section with icon pill row (condensed) and configuration detail with `PropRef` badges and `(?)` tooltips (expanded)
- Properties section with stat line (condensed) and card-per-property list (expanded) including expand/collapse per card with type-specific detail and validation chips
- Cross-property validations subsection within Properties, property names as `PropRef` badges
- Connections section grouped by related entity with structural-first, behavioral-second ordering; full-sentence labels with mid-sentence arrows ("Reservation Request → references Facilities via `Facility` (?)"); incoming connections omit property name
- Permissions section with CRUD matrix (display names for roles), custom rules with "Show SQL" toggle, and action permissions with role badges
- Lifecycle section with stat line (condensed) and simplified inline SVG statechart (expanded) with zoom-in cursor
- Traces section with category counts and icons (condensed) and grouped entry point list with individual links and display names for functions (expanded)
- Sidebar table of contents with anchor links
- Breadcrumb showing `🗺️ > Reservation Request > Overview`

---

## License

Copyright (C) 2023-2026 Civic OS, L3C. Licensed under AGPL-3.0-or-later.
