# Tree List View Design

**Status**: Directional design, not scheduled. No code.
**Date**: 2026-11-05 (amended the same day after review: explicit enablement only, tree editor deferred, indexing note, sibling limit and focus in place of pagination; amended 2026-11-06: skeleton plus visible-row loading in Phase 1, depth and sibling limit as entity metadata)
**Audience**: Civic OS contributors working on the List page, the `recordList` facade and the `Dimension` property type; integrators configuring hierarchical entities.

## Summary

Many entities are trees: programs with sub-programs, regions with sites, departments with divisions, service categories with subcategories, org charts. Each has a foreign key from the table to itself (`parent_id`). Today the List page shows them as a flat, paginated table, so the structure that matters most to the people using them is invisible: a reader cannot see which programs sit under "Youth Services" without filtering by parent, one parent at a time.

This note designs a **tree list view**: the List page's table rendered as an ARIA tree grid, with indented rows, expand and collapse, sibling ordering, dimmed inactive rows, search and filters that keep matching rows' ancestors visible, and per-node child counts. Phase 1 is read-only as a tree: the parent is edited on the Create and Edit pages like any other foreign key, and a server-side guard refuses cycles.

| Question | Recommendation |
|---|---|
| How is it enabled? | Only explicitly, by the integrator: `show_tree` and `tree_parent_property_name` on `metadata.entities`. No default from the dimensions registry and no auto-detection. The integrator decides knowing the table's size. |
| Is it a panel beside the table, like the map and calendar? | No. It is a mode of the table itself: the same columns, rows arranged as a tree. A Table / Tree toggle switches between them. |
| How are rows loaded? | Two ordinary list requests. A **skeleton** (`id`, the parent and the sort columns of every row, in the list's order, up to 1,000 rows) from which the client builds the whole tree; then the list's full select **only for the rows on screen** (`id=in.(...)`), fetched again only for rows not yet loaded. Above 1,000 rows the toggle is disabled with a notice and the flat table stays; Phase 2 pages the skeleton. No new RPC. |
| What replaces pagination? | A per-parent limit: each sibling group shows its first 4 children in sibling order, then a "Show N more" row. Focus re-roots the view on one node, with a breadcrumb of its ancestors and `focus=<id>` in the URL. Both are computed from the skeleton and decide which rows the display request asks for. The initial depth and the limit are entity metadata. |
| How do search and filters work? | The server answers them as it does today, with a second request that returns only matching ids. The client shows matches plus their ancestors as context rows. No filter logic is reimplemented in the client. |
| How is the parent edited? | Phase 1: on the Create and Edit pages, through the ordinary FK dropdown or search modal. A tree editor (drag and a Move dialog) is deferred. |
| How are cycles prevented? | A server-side parent-cycle guard, generalized from the Impact Reporting design so any tree table can install it. An instance can also hide the record and its descendants from the parent dropdown with an `options_source_rpc`. |
| Where does the code go? | Pure tree functions in a new `packages/core/src/tree/` module, later shared with the `Dimension` hierarchical dropdown. `recordList` gains a tree view, state and commands. The page renders. |

## Problem

A self-referencing FK renders today as an ordinary `ForeignKeyName` column ("Parent: Youth Services"). That is enough to store a tree and not enough to read one:

- No view shows the shape. Users rebuild it in their heads from the Parent column, or keep a separate chart.
- Sorting by name interleaves levels. Sorting by Parent groups siblings but loses depth.
- Pagination cuts subtrees across pages.
- Re-parenting means opening each record's Edit page and choosing from a flat dropdown that offers the record itself and its descendants, both of which create a cycle.

Calendar and map views solved the same kind of problem for time and place: the entity carries data with a natural presentation, and metadata turns that presentation on. Hierarchy is the third common shape.

## Prior art inside Civic OS

| Capability | State | Role in this design |
|---|---|---|
| Calendar on the List page (v0.9.0) | Built. `show_calendar`, `calendar_property_name`, `calendar_color_property` on `metadata.entities`; `CHECK calendar_or_map_not_both`. Renders above the table; its visible range filters the rows (`ov`), up to 1,000. | Enablement pattern (opt-in flag plus property name, exposed through `schema_entities`, read through `EntityHandle.features`). Row cap. |
| Map on the List page | Built. `show_map`, `map_property_name`, `map_color_property`. Renders beside the table; row hover highlights the marker. | Shows a view can coexist with the table; tree plus map is allowed (regions and sites). |
| `recordList` facade (v0.78.0) | Built, `packages/core/src/facades/record-list.ts`. Snapshot store plus commands; `views` says which presentations apply; markers, polygons and events are derived in the snapshot. | The tree view is a fourth entry in `views` and a derived `tree` section in the snapshot. |
| `options_source_rpc` (v0.44.0) | Built. Filters a FK dropdown's options through an RPC that receives the record's own id (`p_id`) on the Edit page. | Lets an instance remove the record and its descendants from the parent dropdown without new framework code. |
| `metadata.dimensions` registry | Designed in `docs/notes/IMPACT_REPORTING_DESIGN.md`, not built. | No longer supplies tree defaults (see Enablement). `register_dimension()` installs the generalized guard. |
| Parent-cycle guard | Designed in the same note, installed by `register_dimension()`. | Server-side cycle protection. Generalized here (see Editing and cycle protection). |
| `Dimension` property type | Designed in the same note: a FK to a registered dimension renders as a hierarchical dropdown. Not built. | Shares the tree-building code. |

The calendar design document (`docs/development/CALENDAR_INTEGRATION.md`, Phase 3) planned a List / Calendar tab toggle. The built page instead shows the calendar above the table and the map beside it, with no toggle. A tree cannot sit beside the table: it is the table, rearranged. So the tree view brings the toggle back, for tree entities only.

## Design

### Enablement

Three options were weighed.

| Option | For | Against |
|---|---|---|
| **A. Explicit metadata** (`show_tree`, `tree_parent_property_name`) | Same pattern as calendar and map. The integrator decides, and knows the table's size and how it will grow. Works for any entity. | One more setting to know about. |
| B. Default from the dimensions registry | Zero configuration for registered hierarchical dimensions. | Turns on a whole-table load for a table nobody sized; a registered dimension can be large (a statewide site list). Makes `show_tree` three-valued and lets the calendar CHECK miss the resolved state. |
| C. Auto-detect any self-referencing FK | Zero configuration everywhere. | Not every self-reference is a hierarchy: `duplicate_of_id`, `replaced_by_id`, `referred_by_id` on a person, `previous_version_id`. A table with two self-references needs a choice. A wrong guess changes the default List page of an instance without anyone asking. |

**Decision: A only.** B and C are rejected. *(Decided 2026-11-05.)*

```sql
ALTER TABLE metadata.entities
  ADD COLUMN show_tree                  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN tree_parent_property_name  VARCHAR(63),
  ADD COLUMN tree_sort_property_name    VARCHAR(63),   -- sibling order; see Sibling order
  ADD COLUMN tree_active_property_name  VARCHAR(63),   -- dims inactive rows; see Presentation
  ADD COLUMN tree_initial_depth         SMALLINT,      -- levels expanded on first view; NULL = 2
  ADD COLUMN tree_sibling_limit         SMALLINT;      -- children shown per parent; NULL = 4

ALTER TABLE metadata.entities
  ADD CONSTRAINT calendar_or_tree_not_both
  CHECK (NOT (show_calendar AND show_tree)),
  ADD CONSTRAINT tree_initial_depth_range CHECK (tree_initial_depth BETWEEN 1 AND 10),
  ADD CONSTRAINT tree_sibling_limit_range CHECK (tree_sibling_limit BETWEEN 1 AND 100);
```

- **Size is the integrator's call.** The Integrator Guide section says to enable the tree only on tables expected to stay under 1,000 rows, and to keep the parent column indexed. The cap and fallback (see Data access) remain as a safety net for a table that outgrows that expectation.
- **Display parameters.** `tree_initial_depth` and `tree_sibling_limit` shape the view, not the data: they decide which rows the display request asks for (see Wide groups and focus), never what the server returns. They are per entity because trees differ (a three-level program list against a wide, shallow site list), and the integrator who enables the tree knows its shape. NULL means the framework default (2 and 4), resolved in core, so a later change of default reaches every entity that never set one. [4/5; an instance config key would set one value for every tree in the instance; a presentation overlay lives in app code, not integrator metadata.]
- **Exposure in `schema_entities`.** The view exposes the six columns at the end, as earlier migrations did, and `EntityHandle.features` reads them.
- **Validation.** `upsert_entity_metadata()` gains the six parameters and refuses a `tree_parent_property_name` that is not a FK from the table to itself. The view also drops a tree configuration whose parent column no longer qualifies (renamed, dropped, FK removed), so an instance owner who flattens a tree gets the flat table back, not a broken page. The frontend checks once more that the property is among the entity's properties, as `recordList` already does for the map property.
- **Calendar conflict.** The calendar's range filter turns the table into a list of events in a week; a tree over a filtered week of events has no clear meaning. Tree and map may coexist.
- **Suggestion.** The Entities admin page (`/entity-management`) may show a hint on an entity with exactly one self-referencing FK and no tree setting: "This entity has a parent column. Show it as a tree?", with the table's estimated row count (`pg_class.reltuples`) beside it so the size is in front of the integrator when they decide. One click sets `show_tree` and the parent name; the hint never changes anything by itself.

Cache invalidation needs nothing new: changes to `metadata.entities` already bump `schema_cache_versions`.

### Presentation

The List page gains a segmented control, Table and Tree, shown only when `views.tree` is true. Tree is the default when the view applies. The choice is in the URL (`view=tree` or `view=table`), so links and the back button keep it.

In Tree mode:

- **Same columns, same cells.** The table keeps its columns (`displayColumns`) and `DisplayPropertyComponent` cells. The first column, which already links to the record, gains indentation (`padding-inline-start` per level, logical property for RTL) and an expand or collapse button. The parent column itself is usually redundant in Tree mode and is hidden there unless it is the first column.
- **No pagination.** Offset pages cut trees arbitrarily: a page boundary separates children from their parents. The whole tree's structure is loaded (see Data access), the pagination controls are replaced by a count ("142 programs"), and wide sibling groups are shortened by the sibling limit instead (see Wide groups and focus).
- **Expand and collapse.** Default: `tree_initial_depth` levels are expanded (two when unset: roots and their children), so a small tree is fully visible and a large one starts readable. "Expand all" and "Collapse all" buttons sit beside the toggle. The expanded set is kept per entity in `sessionStorage` by the page, like the page-size preference in `localStorage`, not in the URL (a long id list makes poor links).
- **Child counts.** A collapsed row with children shows the number of descendants as a badge after its label ("Youth Services · 7"). The counts are computed from the skeleton at no extra cost, and are exact for every row, loaded for display or not. Counts of related records (enrollments per program) are reporting, not tree structure, and are out of scope.
- **Inactive rows.** When `tree_active_property_name` is set, a row whose value is false is dimmed and carries an "Inactive" label (text, not color alone, and translated). Dimmed text must still meet WCAG AA contrast against the zebra background in all 35 themes, so "dimmed" means a softer text token, not `opacity`. Inactive rows are shown by default; the ordinary filter bar on the active column hides them, and active descendants of a hidden row then stay visible through the ancestor rule below.
- **Orphans.** A row whose parent is not in the result is placed at root level with a muted "parent not shown" marker. This happens when RLS hides the parent from the viewer; the tree never invents or fetches rows the viewer cannot list.
- **Existing cycles.** A table without the server guard can hold a cycle already. The tree builder detects it, places the cycle's rows at root level with a warning marker, and never loops.
- **Map.** Tree plus map works as table plus map does: markers for the rows loaded for display (the skeleton carries no geometry), hover highlighting by row. Expanding or focusing adds markers as their rows load.
- **Read-only summary VIEWs** (`views.summary`) can be trees; rows are not links.

### Sibling order

Rows are ordered within their siblings, never across levels. The order, first match wins:

1. The user's column sort, when set (header click). In Tree mode a sort applies within each sibling group.
2. `tree_sort_property_name`, when set.
3. A column named `sort_order` of an integer type, when present. The name is the one Category and the registry tables already use for ordering, and it is what most hand-built tree tables already have. [3/5; the alternative is no convention, so an integrator must always name the column. The convention costs nothing when absent and is overridden by setting the property.]
4. `display_name`, then `id` (the query compiler's default order).

The server does the ordering: the skeleton request sends the same `order` the flat list would (through `buildOrderField`, which already orders FK columns by their embedded display name; the skeleton's select carries whatever columns or embeds that order needs), and the tree builder keeps the server's order within each sibling group (a stable grouping). No type-aware comparator is reimplemented in the client. Because the skeleton is ordered, the sibling limit's "first 4" are chosen by the server's sort. A sort change reloads the skeleton (one small request); display rows already loaded are reused.

### Wide groups and focus

*Decided 2026-11-05; amended 2026-11-06 (computed from the skeleton, limits from entity metadata).* A tree replaces the table's pages with two tools that never separate a child from its parent, so every partial view is still a correct tree.

**Sibling limit.** [4/5]

- Each sibling group below the root level shows its first `tree_sibling_limit` children (**4** when unset) in sibling order, followed by a "Show 12 more" row. A group is shortened only when it has more than the limit plus 2 children, so the view never hides one or two rows behind a button.
- "Show N more" reveals the next 50 of the group (the rest when at most 52 remain); the label then counts what is left. Revealed counts are kept per parent id beside the expanded set, outside `ListState`, so revealing never changes the list query; it only adds the newly shown ids to a display request.
- The root level is shown in full. [3/5; limiting it too treats every level alike, but would hide most of a shallow tree such as a list of departments, which is where the reader starts.]
- "First" follows sibling order, including the user's column sort: sorted by a date column, each parent shows its four most recent children.
- While a filter or search is active, the limit is lifted: only matches and their context rows are shown, and hiding a match behind "Show more" would defeat the search.
- Child-count badges count every descendant, shown or not.

**Focus.** [4/5]

- Rows with children carry a Focus button in the first cell, beside the expander (`aria-label` "Show only Youth Services and its descendants", translated). Focusing makes that row the only root, expanded, with its descendants under the usual rules.
- A breadcrumb above the table names its ancestors (`<nav>` with a translated `aria-label`): "All programs › Services › Youth Services". Each ancestor re-focuses on that node and "All programs" clears the focus. The count reads "7 under Youth Services".
- Focus is part of `ListState` and the URL (`focus=<id>`), so links, reloads and the back button keep it. The planner leaves it out of the skeleton's request key: a focus change re-derives the visible rows from the skeleton and requests display rows only for those not yet loaded.
- Under a filter, matches outside the focused subtree are hidden and counted: "4 more matches outside Youth Services", with a button that clears the focus.
- A focus id that is not in the skeleton (deleted, or hidden by RLS) clears the focus with a polite announcement; the tree never fetches a row the viewer cannot list.

**Why this shape.** Both tools are computed by core's `flattenTree` over the skeleton, which holds the whole tree's structure. Their output is the list of visible ids, and that list is exactly what the display request asks for, so the view's size follows what the reader has opened, not the table: a tree at its initial depth with groups shortened requests a few dozen rows. Expand all, or a filter (which lifts the limit), can still ask for every row, up to the skeleton's 1,000.

A visual org chart (boxes and lines, the focused node centered) was considered for the same idea and set aside: the tree grid keeps the list's columns, filters, sorting and the treegrid accessibility pattern, which a canvas chart would have to rebuild (see Non-goals).

### Search and filters

Search and filters keep their server semantics: full-text and substring search, every filter operator, Related Records links, filter chips. Implementing them again over the loaded rows in the client would drift from the server; FTS cannot be reproduced there at all.

So in Tree mode a filtered or searched list adds one request to the skeleton and display requests (see Data access):

1. **The skeleton**: every row, unfiltered.
2. **The matches**: the same filters and search the flat list would send, `select=id`, up to the same cap.
3. **The display rows**: matches and their ancestors (found in the skeleton, with no request per level), minus rows already loaded.

Filters never touch the skeleton: a filtered skeleton would drop the ancestors of matches and turn their descendants into orphans.

The snapshot marks each tree row as a **match**, a **context row** (an ancestor of a match, not itself a match), or hidden. Context rows are shown in a muted style with screen-reader text "does not match the filter". Ancestors of matches are expanded automatically for as long as the filter is active, without touching the stored expanded set. Search terms are highlighted in match rows as in the table. Clearing the filters drops request 2 and restores the stored expanded set.

An empty match set shows the existing "No results" state with its Clear filters button.

### Data access

**Phase 1: skeleton plus visible rows.** [4/5] *Decided 2026-11-06.* The tree's structure and the rows' display data are loaded separately: structure for every row, display data only for the rows on screen.

1. **Skeleton.** One request: `select=` the key, the parent column and the columns (or embeds) the sort needs, with the flat list's `order`, `pagination: { page: 1, pageSize: 1000 }`. 1,000 is the app's `MAX_LIMIT` (`src/app/utils/query-limits.ts`) and the calendar's page size. A row costs a few dozen bytes, so a full skeleton is a few tens of kilobytes. Core's `buildTree` turns it into the tree index: roots, children, depth, ancestors, descendant counts, orphans, cycle members.
2. **Display rows.** `flattenTree` (expanded set, initial depth, sibling limit, revealed counts, focus, matches) yields the visible ids. One request fetches them with the flat list's full select string (embedded FK names, Status and Category badges, the active column): `id=in.(...)`. Rows are cached by id in the facade; later expands, "Show N more" and focus changes request only ids not in the cache.

Rules:

- **Size gate.** The skeleton's `Content-Range` total tells whether the tree fits. When it exceeds 1,000, the snapshot reports `tree.status = 'too_large'`: the Tree toggle is disabled with a notice ("This list has more than 1,000 rows, so the tree view is not available. An administrator can turn it off for this list.") and the flat table is shown. No display request is sent. A partial skeleton is never used, because children whose parents fell beyond the cap would look like orphans.
- **No count request first.** Because enablement is explicit, an oversized tree is a configuration the integrator should correct, and one discarded skeleton per visit is a small cost until they do.
- **Chunking.** The display request lists only visible ids not yet cached: usually a few dozen, but Expand all or a broad filter can reach the skeleton's 1,000. Ids are chunked (100 per request) so a long UUID list stays under common 8 KB URL limits; the chunks run in parallel, at most 10, and their results are merged into the cache.
- **Rows that disappear.** A row deleted (or hidden by an RLS change) between the skeleton and the display request is simply missing from the result. The facade drops it from the visible rows and the next load rebuilds the skeleton. Rows in the display result that are no longer visible are ignored.
- **Cache lifetime.** Sort, filter, focus and expand changes reuse the cache: they change which rows are visible, not what a row shows. A refresh (after a write, a `schema_cache_versions` bump, an entity change) clears it and reloads the skeleton, so displayed values never outlive the structure they belong to.
- **Security.** Every request is an ordinary list request under RLS; there is no new RPC, no definer function and no new grant. The MCP server and other core consumers can use the same two steps.
- Expanding or collapsing rows whose display data is cached sends nothing.

Expected sizes fit easily: programs, sites, departments and categories run from a handful to a few hundred rows per instance.

Why not one request through a windowing RPC: a function returning the table's row type would accept the list's select string and embeds, but PostgREST applies URL filters and `order` to the function's output, after the window, so filters would cut the windowed tree and the sibling order would have to be passed in and re-implemented in SQL. A generic function over any entity returns untyped rows and loses embedding. Building the tree in the client from an ordered skeleton keeps the query, the filters and the order exactly where the flat list builds them. *(Considered and rejected 2026-11-06.)*

**Phase 2: skeleton paging, on demand.** For trees above 1,000 rows (a large municipal org chart), the skeleton is fetched in `Range` pages of 1,000 up to a higher cap, and the `too_large` fallback moves to that cap. Display loading does not change, since it never depended on the table's size. Deferred until an instance has such a tree; Phase 1's fallback keeps it working meanwhile.

### Indexing

PostgreSQL has no index type specific to trees. The storage models and their indexes:

| Model | Index | Reads | Writes on re-parent |
|---|---|---|---|
| **Adjacency list** (`parent_id`) | B-tree on `parent_id` | Children: one index lookup. Subtree or ancestors: a recursive query, one lookup per level | One row |
| Materialized path (`ltree`) | GiST on the path | Subtree and ancestors in one indexed comparison | Every descendant's path, by trigger |
| Closure table (ancestor, descendant, depth) | B-trees on both columns | Both directions in one join | Rows for the whole subtree |
| Nested sets (left, right) | B-tree | Fast subtree reads | Renumbers much of the table |

**Decision: adjacency list with the B-tree on the parent column**, which the FK index rule already requires. The tree view loads the whole skeleton and builds the tree in the client, so no index speeds the view itself (the display request is a primary-key lookup). The parent index serves the cycle guard's ancestor walk, `dimension_subtree()` and the inverse-relationship lookups on Detail pages; at hundreds of rows per tree, a recursive walk over B-tree lookups is negligible. A path column or closure table is worth its maintenance triggers only if subtree filtering in reports becomes hot, which matches the Impact Reporting design's choice to avoid `ltree`.

### Editing and cycle protection

**Phase 1 has no tree editor.** The parent is set on the Create and Edit pages through the ordinary FK control: the dropdown, or the search modal when `fk_search_modal` is on. The tree view itself is read-only. *(Decided 2026-11-05.)*

The flat FK control offers the record itself and its descendants, and choosing either creates a cycle. Two existing mechanisms cover that:

- **Server-side guard (Phase 1).** The parent-cycle guard covers the Edit page, import, MCP, SQL and concurrent edits. The Impact Reporting design installs it from `register_dimension()`; this design generalizes it so non-dimension trees get the same protection:
  - `metadata.tree_parent_guard()` takes the key and parent column names as trigger arguments (no label column: the error message names no rows) (`TG_ARGV`) instead of reading the registry, and keeps every other property of the designed guard: no column list on the trigger (so the parent column can still be dropped), `CYCLE` clause and depth limit, a `pg_advisory_xact_lock()` per table taken only when the parent changes.
  - It raises `check_violation` with `USING CONSTRAINT = 'tree_parent_cycle'`. The constraint name lets the existing `ErrorService` path show a translated `metadata.constraint_messages` text on the Edit page and lets clients recognize the error without matching message text. The name is fixed; the message does not interpolate row labels.
  - `register_dimension()` installs it with the registry's columns.
  - A new `enable_tree_parent_guard(p_table, p_parent_column, p_key_column DEFAULT 'id')` helper installs it on any other table, passing the two column names as the trigger's arguments. Guard: `metadata._is_db_admin()`. The helper accepts only a base table in `public` that is listed in `schema_entities` and a parent column that is a FK from that table to itself, quotes identifiers with `%I`, and installs only this fixed trigger, so the admin JWT path it admits cannot run other DDL.
  - Enabling the tree view does **not** install it: metadata settings do not alter instance tables. The Entities admin page warns when `show_tree` is on for a table without the guard.
- **Prevention in the dropdown (optional, per instance).** An `options_source_rpc` receives the record's own id on the Edit page, so a short per-table wrapper can return every row except the record and its descendants. The Integrator Guide section includes the recipe. Core does not ship a generic version because the RPC signature carries no table name.

**Deferred: tree editor.** Re-parenting in the tree view by drag (onto a row, or a "Top level" zone) and a keyboard-accessible Move dialog with a hierarchical picker. Drag requires a single-pointer alternative (WCAG 2.2 SC 2.5.7), so the two ship together. Angular CDK's drag-drop reorders and transfers between lists; dropping onto a row to nest it needs custom hit-testing or a connected list per subtree, so the effort is larger than the admin pages' reordering suggests. Revisit after Phase 1 is in use.

### Relation to the `Dimension` property type

The `Dimension` property type and the tree view need the same operations over the same shape (rows with a key, a parent, an order and an active flag):

| Operation | Tree view | `Dimension` dropdown |
|---|---|---|
| Build the tree, keeping server order within siblings | yes | yes |
| Detect orphans and cycles without looping | yes | yes |
| Depth and ancestor path per row | indentation, `aria-level` | indented options, "Parent › Child" label for the selected value |
| Descendants of a row | child counts | disabled options (a record cannot be its own ancestor) |
| Flatten to visible rows given an expanded set and a match set | yes | type-ahead filtering keeps ancestors of matching options |
| Inactive rows | dimmed | hidden from new choices, still shown when already selected |

So the tree code lives once, in core: [5/5 that it must be shared; 4/5 on the shape]

- `packages/core/src/tree/` (new module, Apache-2.0 header, no framework): `buildTree(skeletonRows, { key, parent })` returns an immutable index (roots, children by id, depth, ancestors, descendant counts, orphans, cycle members); `flattenTree(tree, { expanded, initialDepth, siblingLimit, matches?, focus?, revealed? })` returns the visible ids in order (the input to the display request) with level, set size, position and match or context marks, plus a "more" entry (parent id, hidden count) after each shortened group; `isInSubtree(tree, ancestorId, id)` ships with its first consumer (the `Dimension` dropdown or the deferred editor), not before, since every core export needs a verified consumer.
- Angular: a `TreeSelectComponent` (hierarchical listbox or combobox) arrives with the `Dimension` edit control and is reused by the deferred Move dialog. A tree entity's parent field keeps the ordinary FK control until then.

### SDK fit

The tree view is a metadata feature plus a core feature, as SDK governing rule 3 requires; no consumer re-derives what the metadata means (rule 1).

| Layer | Change |
|---|---|
| Metadata contract | `metadata.entities` columns, `schema_entities` exposure, `upsert_entity_metadata()` parameters. |
| `EntityHandle.features` | `tree: boolean`, `treeParentProperty`, `treeSortProperty`, `treeActiveProperty`, `treeInitialDepth`, `treeSiblingLimit` (defaults resolved here, so no consumer re-derives them). |
| `recordList` | `views.tree: boolean` (configured, the parent property present among the properties); `ListState.view: 'table' \| 'tree'` (normalized: `'tree'` only when `views.tree`); `ListState.focus: id \| null` (normalized to null outside Tree mode; left out of the skeleton's request key); the skeleton and match requests in `plan()`, and the chunked display requests issued from the derived visible ids with a per-facade row cache; a derived `tree` section in the snapshot (`status: 'ready' \| 'too_large'`, the flattened visible rows with level, set size, position, match or context, inactive, orphan and cycle marks, child counts, "more" entries, the focus breadcrumb and the count of matches outside the focus); commands `setView`, `setFocus(id \| null)`, `toggleExpanded(id)`, `showMore(parentId)`, `expandAll`, `collapseAll`, `setExpanded(ids)` (the page restores the stored set). |
| `src/app/sdk/list-url.ts` | Maps `view` and `focus` to and from the URL. |
| List page | Renders the toggle, the breadcrumb and the tree grid rows, including "Show N more" rows; stores the expanded set; maps the too-large status and a missing focus to their notices. |

Why extend `recordList` rather than add a `recordTree` facade: the tree view needs everything the list facade already owns (search, filters, chips, filter bar columns, sort, columns, summary-view handling, map features) and differs only in how rows are loaded and arranged. The calendar and map views set the precedent of living inside `recordList` behind `views`. The tree logic goes in its own file (`facades/record-list-tree.ts`) so `record-list.ts` does not grow by half. [4/5; a separate facade would keep `recordList` smaller, at the cost of duplicating or extracting its filter, search and chip handling, which is the larger change.]

The expanded set and the revealed counts are not part of `ListState`, so `stateEqual`, the URL mapping and load scheduling are unchanged by expanding a row or showing more: both change the visible ids, never the list query, and at most add a display request for ids not yet cached. Focus is in `ListState` because it belongs in links, but it is not part of the skeleton's request key, for the same reason. Display requests follow the facade's existing cancellation: a newer visible set cancels an in-flight display request whose ids are no longer needed.

New exports (`buildTree`, `flattenTree` and their types, the new `ListState` and snapshot fields) need `@consumer` tags; the List page is their `app` consumer. `api:report` is regenerated with the change.

The MCP server needs nothing in Phase 1. Its entity description could later say that an entity is hierarchical and name the parent column.

### Accessibility

The tree view follows the WAI-ARIA Authoring Practices **treegrid** pattern, because rows have several columns; a plain `tree` role cannot carry cells.

- **Roles and states.** `role="treegrid"` on the table, `aria-label` from the entity name (the existing `<caption>` stays). Each row: `role="row"`, `aria-level` (1-based), `aria-setsize` and `aria-posinset` within the sibling group (counting siblings hidden by the sibling limit, not rows hidden by a filter; see Shortened groups), `aria-expanded` on rows with children (absent on leaves), `aria-selected` not used. Cells: `role="gridcell"`; column headers keep `role="columnheader"` and `aria-sort`.
- **Focus.** One tab stop: roving `tabindex` on rows. Row focus first; the user moves into cells with the arrow keys.
- **Keys** (row focused), as the APG treegrid pattern defines them: Down and Up move to the next or previous visible row; Right expands a collapsed row, or moves focus into the first cell of an expanded one; Left collapses an expanded row, or moves to the parent of a collapsed row or leaf; Home and End go to the first and last visible row; Enter opens the record (the first cell's link). Added for this view: `*` expands all siblings of the focused row (borrowed from the APG tree view pattern). In a cell, Left and Right move between cells, and Left from the first cell returns to row focus.
- **Shortened groups.** `aria-setsize` gives the group's full size, so the fourth row reads "4 of 16" while twelve are hidden. The "Show N more" row is a `role="row"` at the group's level holding one gridcell with a native button, and it takes part in Up and Down navigation; activating it moves focus to the first newly shown row. The Focus button and the breadcrumb are native buttons; after a focus change, focus moves to the new root row and the live region names it.
- **Announcements.** The page's existing polite live region (`listAnnouncement`) speaks expand and collapse when a filter auto-expands, and the too-large fallback. Context rows and orphans carry screen-reader text; inactive rows carry the "Inactive" label as text.
- **Lint and verification.** The `@angular-eslint/template` a11y rules apply; the treegrid is keyboard- and screen-reader-verified (VoiceOver and NVDA) per `docs/development/ACCESSIBILITY_MANUAL_TESTING.md`.

### i18n

New strings under the existing prefixes: the Table and Tree toggle labels, Expand all and Collapse all, the descendant-count badge text, "Inactive", "parent not shown", the cycle warning, the context-row screen-reader text, "Show N more" (plural forms), the Focus button label, the breadcrumb label and its "All" root, the count under a focus, the matches-outside-focus notice and the missing-focus announcement, the too-large notice, the Entities admin hint and guard warning, and the `tree_parent_cycle` constraint message. See `docs/notes/I18N_DESIGN.md` (New Feature i18n Checklist).

## Decisions

| # | Decision | Recommendation | Alternative and trade-off |
|---|---|---|---|
| 1 | Enablement | Explicit `show_tree` (`NOT NULL DEFAULT FALSE`) plus `tree_parent_property_name`, set by the integrator, who knows the table's size. No registry default, no auto-detection; an Entities admin hint with the estimated row count. **Decided 2026-11-05.** | Default on for registered hierarchical dimensions: zero configuration, but loads whole tables nobody sized and makes the flag three-valued. Auto-detect every self-referencing FK: also turns non-hierarchical references (`duplicate_of_id`) into trees. |
| 2 | Presentation | A mode of the table with a Table / Tree toggle, Tree by default. **Proposed.** | A panel beside the table, like the map: duplicates every row and doubles the screen width needed. |
| 3 | Calendar | Tree and calendar exclusive (`CHECK`); tree and map allowed. **Proposed.** | Allow both: the calendar's week filter would cut the tree arbitrarily. |
| 4 | Data access | Skeleton (key, parent, sort columns; up to 1,000 rows, flat table above) plus the full select only for visible ids, cached by id and chunked; no new RPC; skeleton paging in Phase 2. **Decided 2026-11-06.** | Whole rows up to 1,000 in one request: simplest, but loads every row's display data and leaves larger trees to a later rebuild. A windowing RPC: one request, but URL filters and `order` apply after the window, and a generic function loses embedding. Per-level lazy loading: unknown child counts and an ancestor walk per search. |
| 5 | Filters | Server answers filters as match ids; client shows matches and ancestors. **Proposed.** | Filter the loaded rows in the client: one request fewer, but FTS and filter operators would be reimplemented and drift. |
| 6 | Sibling order | User sort, then `tree_sort_property_name`, then a `sort_order` column by convention, then `display_name`, `id`; ordering done by the server. **Proposed.** | No convention: more predictable, one more setting for nearly every tree. |
| 7 | Cycle guard | Generalize the designed guard into `metadata.tree_parent_guard()` with trigger arguments and `USING CONSTRAINT = 'tree_parent_cycle'`; `enable_tree_parent_guard()` helper restricted to `public` base tables listed in `schema_entities`; not installed by enabling the view; ships in Phase 1. **Decided 2026-11-05; amends the Impact Reporting design's guard.** | Leave non-dimension trees unguarded: no schema change, but the Edit page, import and concurrent edits can create cycles. |
| 8 | Facade | Extend `recordList` (tree logic in its own file); pure tree functions in `packages/core/src/tree/`. **Proposed.** | A separate `recordTree` facade: smaller files, but filter, search and chip handling extracted or duplicated. |
| 9 | Editing | Phase 1 edits the parent through the ordinary FK control on Create and Edit; drag and the Move dialog are deferred. **Decided 2026-11-05.** | Ship the tree editor in Phase 1: re-parenting in place, but drag-to-nest is custom CDK work and needs the Move dialog alongside for WCAG 2.5.7. |
| 10 | Index | Adjacency list with a B-tree on the parent column. **Decided 2026-11-05.** | `ltree` or a closure table: faster subtree queries, maintenance triggers on every re-parent; not needed at expected sizes. |
| 11 | Wide groups | Sibling limit (first N below the root level, shortened only above N + 2, "Show N more") and focus with a breadcrumb and `focus=<id>`, computed over the skeleton; their output is the display request's id list. **Decided 2026-11-05.** | Offset pages: familiar, but a page boundary separates children from parents. An org chart with the focus centered: shows shape, loses the columns, filters and treegrid pattern. |
| 12 | Display parameters | `tree_initial_depth` (default 2) and `tree_sibling_limit` (default 4) on `metadata.entities`, NULL meaning the framework default resolved in core. **Decided 2026-11-06.** | An instance config key: one setting, but one value for trees of different shapes. A presentation overlay: per app, not integrator metadata. |

## Phasing

| Phase | Scope | Depends on |
|---|---|---|
| 1 | Metadata columns and `schema_entities` exposure; `upsert_entity_metadata()` parameters; core `tree` module (`buildTree`, `flattenTree`); `recordList` tree view with skeleton, match and chunked display requests, row cache and commands; List page tree grid with toggle, expand and collapse, counts, inactive and orphan marks, sibling limit and focus; generalized guard, `enable_tree_parent_guard()` and the `tree_parent_cycle` constraint message; Entities admin settings, row-count hint and missing-guard warning; Integrator Guide section (sizing, parent index, `options_source_rpc` recipe); translations | Nothing new |
| 1b | `register_dimension()` installs the generalized guard; the `Dimension` property type and `TreeSelectComponent` on the shared module | `metadata.dimensions` (Impact Reporting Phase 1) |

*Scheduling note (2026-11-19, issue #135).* The generalized guard, `enable_tree_parent_guard()` and the `tree_parent_cycle` constraint message ship ahead of the rest of Phase 1, in v0.85.0 with the dimensions registry, which installs the guard. Phase 1b's `Dimension` property type and `TreeSelectComponent` follow in v0.86.0 with `buildTree` and `flattenTree` from the core `tree` module, so the module's first consumer is the `Dimension` control rather than the List page. The rest of Phase 1 (the List page tree grid) is not scheduled.
| 2 | Tree editor (drag and Move dialog); skeleton paging for trees above 1,000 rows, moving the fallback to a higher cap; sibling reorder by drag; optional path column in Excel export | Demand after Phase 1; an instance with a tree above 1,000 rows |

## Non-goals

- A tree on the Detail page (a record's subtree as a related-records section). Possible later with the same core module.
- Multiple parents (a DAG). A row has one parent column; many-to-many hierarchies are a different model.
- Organization-chart graphics (boxes and lines). The tree grid is a list; a visual chart would be a dashboard widget or a JointJS view. Its one draw, centering on a node to show its descendants, is covered by focus (see Wide groups and focus).
- Aggregating measures up the tree. That is the measure engine's rollup columns in `docs/notes/IMPACT_REPORTING_DESIGN.md`.

## Open questions

1. Should the 1,000-row skeleton cap be an instance config key, or is a fixed cap (matching the calendar) enough until Phase 2 pages the skeleton?
2. Should Tree be the default mode when the view applies, or should the user's last choice per entity be remembered (in `localStorage`, like page size)?
3. Should the Entities admin page offer to install the guard when an admin turns on `show_tree` (an explicit, confirmed action, unlike setting metadata by SQL)?
4. Is `sessionStorage` right for the expanded set and revealed counts, or should they persist across sessions?
## References

- `docs/development/CALENDAR_INTEGRATION.md`: calendar enablement and the List page toggle as first designed.
- `packages/core/src/facades/record-list.ts`: list facade, `views`, row cap.
- `docs/notes/OPTIONS_SOURCE_RPC_DESIGN.md`: filtered FK options with the record's own id.
- `docs/notes/FRONTEND_SDK_DESIGN.md` (§3 Governing rules, §11 Facades) and `docs/development/SDK_PACKAGES.md` (`@consumer` tags, API report).
- `docs/notes/IMPACT_REPORTING_DESIGN.md`: `metadata.dimensions`, `Dimension` property type, parent-cycle guard.
- `docs/development/ACCESSIBILITY_WCAG.md`, `docs/development/ACCESSIBILITY_MANUAL_TESTING.md`.
- [WAI-ARIA APG: Treegrid pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treegrid/); [WCAG 2.2 SC 2.5.7 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).
