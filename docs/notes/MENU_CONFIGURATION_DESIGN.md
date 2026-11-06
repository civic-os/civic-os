# Menu Configuration Design

**Status**: Built (v0.81.0)
**Created**: 2026-11-05

**Related docs**:
- `docs/INTEGRATOR_GUIDE.md` (Menu Configuration) for integrator-facing SQL and behavior
- `docs/development/PERMISSIONS_MODEL.md` for why navigation is not RBAC
- `docs/notes/FRONTEND_SDK_DESIGN.md` for the core package that holds the rules
- `docs/notes/CUSTOM_PAGES_DESIGN.md` for the reserved custom-page node kind

## Problem

The sidebar was one flat list of entities. An integrator could hide an entity (`metadata.entities.show_in_sidebar`) and order the list (`sort_order`), but not group entities, nest a sub-list under its parent, or label a link differently from the entity. Instances with twenty or more tables needed headings.

## Model

`metadata.menu_nodes` is a tree stored as an adjacency list. Each row is a node:

| Column | Role |
|--------|------|
| `node_key` | Primary key. A table name for an entity node, a slug (`^[a-z][a-z0-9_]*$`) for a heading |
| `node_kind` | `heading` or `entity`. A column CHECK limits it to those two, so a new kind (custom page) is a migration, and the kind cannot change on update |
| `target_key` | The table or registered view an entity node links to; NULL for a heading. Unique per kind, so an entity has one node |
| `display_name` | Label override; required for headings, optional for entity nodes |
| `icon` | Material Symbols name |
| `parent_node_key` | Self-reference with `ON DELETE CASCADE`. Deleting a parent deletes its subtree, which leaves those entities unplaced, not hidden |
| `sort_order` | Nullable INT, no default, like `metadata.entities.sort_order` |
| `is_hidden` | Hides the node and its subtree |
| `collapsed_by_default` | Initial open state for headings and parent entity nodes |

Placement rules: depth at most 3 (root is 1); headings at the root or under a heading; entity nodes at the root, under a heading or under an entity node; no cycles; an entity node's `node_key` equals its target; a target must be a `public` table or a view registered in `metadata.entities`, the same eligibility test as `public.schema_entities` (virtual entities qualify).

### Where each rule lives

- **Database**: the `BEFORE INSERT OR UPDATE` row trigger `metadata.menu_nodes_validate()` enforces every structural rule above, including the depth of a moved subtree and cycles on UPDATE. SQL, init scripts and the RPC all pass through it.
- **Core** (`packages/core/src/menu/`): `validateMenuTree` mirrors the structural rules as data (error codes, in node order) so an editor reports problems before the round trip. `buildMenu` turns the flat rows plus the caller's entities into the visible tree. `menuBranchKeys` returns the ancestors of an entity entry so a host can open the active branch. All three are pure and total: cycles, orphans, duplicates and over-deep data degrade (a cycle breaks at its first node, an orphan becomes a root) and never throw or loop. Their `@consumer` tag is `app`, and the consumer for `MenuNodeKind` and the error types is `typed`.
- **App**: `SchemaService.getMenu()` combines entities (junction tables excluded), the cached nodes and `buildMenu` into a `MenuState` of `loading`, `error` or `ready`. `SidebarMenuComponent` renders a `ready` tree. `/admin/menu` (`AdminMenuPage` with the pure operations in `admin-menu.tree.ts`) edits it.

### `buildMenu` rules

1. `is_hidden` removes a node and its subtree. An entity with a hidden node is not treated as unplaced.
2. An entity node whose target is not among the caller's entities is dropped and its children take its place.
3. A heading with no visible descendant is dropped.
4. Siblings sort by (`sort_order` with NULL as 0, key). Entities with no node follow the root nodes, sorted among themselves by (entity `sort_order`, table name).
5. Label: the node's translated `display_name`, else the entity's display name. A blank node label counts as unset.

Sibling order is the same key as `schema_entities` (`ORDER BY COALESCE(sort_order, 0), table_name`), so a menu with no visible nodes reproduces the previous order exactly. Unplaced entities trail the root nodes rather than merging in among them: a heading placed at the root stays above every unplaced entity whatever their `sort_order` values, the editor can renumber root siblings (x10) without moving them past unplaced entities, and a newly created table appears at the end where an admin will notice it. Two entity keys with equal `sort_order` tie-break by their rank in the entity list (the database's collation); any comparison involving a heading key falls back to code point.

## Data flow

1. `public.schema_menu_nodes` (view) exposes the nodes. `display_name` goes through `metadata.t('menu_node', node_key || '.display_name', display_name)`; `base_display_name` is the untranslated label.
2. `SchemaClient.getMenuNodes()` fetches and caches the rows per context and shares the in-flight request. A failure rejects and is not cached, so the next call retries. `invalidateMenuNodes()` drops only the menu slot.
3. `metadata.menu_version` (one row) is stamped by statement-level triggers on every INSERT, UPDATE, DELETE and TRUNCATE of `menu_nodes`. The `menu` row of `schema_cache_versions` reads it. `MAX(updated_at)` would miss deletes, which is why the version is stamped instead.
4. `VersionService` compares the `menu` version on each navigation (`schemaVersionGuard`); a change calls `SchemaService.refreshMenuCache()`, which refetches the nodes. The entities cache is untouched: a menu edit never refetches entities or properties.
5. `refreshCache()` (used on a locale change) also refetches the nodes once the menu has been requested, because labels are translated server-side.

### Sidebar component

`SidebarMenuComponent` renders the root level as sections (`sidebarSections()`): a root heading is a `<details>` whose summary is styled like the sidebar's About and Admin titles, and its entries sit at the root indent (the nested list drops DaisyUI's indent and guide line). A run of root entities that follows a heading, or the whole root when there is no heading, gets a **Data** section, because without the indent those entities would read as part of the heading above; a run before the first heading stays untitled under Home. Nested headings are ordinary DaisyUI `<details>` items. Parent entity nodes are a link plus a DaisyUI `.menu-dropdown-toggle` button (`aria-expanded`, `aria-controls`, translated `aria-label`) side by side in a two-column `li`, so both are direct `li` children (DaisyUI styles only those) and the toggle draws the same `::after` chevron as a summary; the child list is `.menu-dropdown` / `.menu-dropdown-show`. `src/styles.css` restores the open-summary chevron rotation, which DaisyUI 5.7.27 overrides by re-emitting its closed rule unprefixed in the responsive menu variants.

Open state lives in `SidebarOpenStateService`, shared by the tree, the About, Admin and Data sections and the editor preview. It defaults to `!collapsedByDefault` (sections default open), is remembered per key in `localStorage` (`civic-os.menu.open`, a JSON map; reads and writes are guarded), and the part holding the active route is always rendered open and refuses to close: the ancestors of the active entity (from `/view|create|edit/:table`), a Data section containing it, About on `/schema-editor`, Admin on its route prefixes. The fixed sections use the keys `@about`, `@admin` and `@data` (an earlier titled run is `@data.<first key>`), which no node key can take.

### Failure state

If the node fetch fails, the sidebar shows Home, a notice and a Retry button (`refreshMenuCache()`). It does not fall back to the flat entity list: an entity a node hides would reappear, and hiding is the one thing the menu is trusted to do.

## Editor (`/admin/menu`)

The page keeps a **draft** as a flat list of rows in depth-first display order: `{key, kind, targetKey, label, icon, hidden, collapsed, depth}`. A row's parent is the nearest previous row with `depth - 1`, so a move is an array splice plus a depth change, and structure errors cannot be expressed by most operations. The operations (move up, move down, indent, outdent, can-X checks) live in `admin-menu.tree.ts` as pure functions on that list and are tested without Angular.

- Drag and drop and the Move up, Move down, Indent and Outdent buttons produce the same operations. Buttons are the accessible path; each move updates an `aria-live` region.
- `rowsToNodes` turns the draft into `MenuNodeRow[]`: parent from nesting, `sort_order` as position among siblings times 10.
- Unplaced tables and views (no row in the draft) appear in a tray; Add to menu appends a row. Removing a row returns the entity to the tray.
- Add heading creates a root heading whose `node_key` is a slug of the label. The key is immutable: renaming the label later keeps its translations (translations are keyed by `node_key`).
- The label field edits the base label (`base_display_name`), never the translated one, so an admin in another locale cannot write a translation back as the base.
- Hidden is an eye toggle on the row's action group, its `aria-label` naming the action and the row (Hide X, Show X). A hidden row collapses to one line: its inputs are removed, the name dims and a Hidden badge shows.
- `validateMenuTree` runs on the draft **without** the entity list: structure only. The editor cannot see every target the database accepts (junction tables are not in the management entity list, and `schema_entities` omits tables the admin's roles cannot read), so an eligibility check here blocked saves the trigger allows. Rows whose target is not in the editor's entity list get a **Not shown** badge with help text instead (junction, unreadable, or dropped).
- A live preview runs the draft through `buildMenu`. Before save, `validateMenuTree` runs on the draft nodes and every error is listed; Save is blocked while any remain. **Discard changes** resets the draft to the last loaded or saved tree. After a successful save the editor calls `refreshMenuCache()` so the sidebar updates at once.
- Save posts the whole tree to `save_menu_tree`; the editor reads from the server, not the app-wide cache, so it starts from the current state. When the result lists `skipped` keys, the editor reloads so the draft matches the stored tree.

Entity Management lost its sidebar toggle and links here.

## Write path

`public.save_menu_tree(p_nodes jsonb)` is `SECURITY DEFINER`, admin only (`is_admin()`), `PUBLIC` execute revoked. It rejects non-array input, rejects nodes with an unknown parent or on a cycle before writing, deletes every row, then inserts parents before children (ordered by depth), so the validation trigger sees each node with its real parent. Everything runs in one transaction, so a failed save leaves the old tree. It returns the node count, the skipped keys and the new menu version. An empty array empties the menu, after which every entity shows at the root.

**Dropped targets on save.** The editor sends every row back, including a node whose table was dropped after it was placed; re-inserting it would fail the trigger, so one dropped table would make the menu unsaveable. `save_menu_tree` therefore skips an input entity node when a node with the same key and target is already stored and the target is no longer in `schema_entities`, and gives its children their nearest kept ancestor as parent (the rendering rule). The stored-node condition keeps the trigger strict for everything new: a node first added with a bad target still raises, and so does sending the skipped node again after the save removed it. The trigger itself stays strict for direct inserts.

`metadata.menu_nodes` itself grants SELECT only (policy: everyone reads). Integrators write it from migrations and init scripts, which run as a database role.

## Decisions and tradeoffs

**Hard move of `show_in_sidebar`, not a kept column.** Two sources of truth (a flag and a node) would need a precedence rule and would let `schema_entities` and the tree disagree. Dropping the column makes the tree the only owner. The cost is a breaking change for install SQL: a script that writes the column or passes `p_show_in_sidebar` fails after the upgrade. The migration seeds a hidden root node only for each entity that had `show_in_sidebar = FALSE`; visible entities stay unplaced and keep their `sort_order` order, so an upgraded instance renders identically and reaches the same state as a fresh install (whose init scripts write their own hidden nodes), and the Integrator Guide gives the one-statement replacement. Dropping the column meant dropping and recreating `schema_entities` and its dependent views; the migration captures their definitions, options, comments and grants, drops without CASCADE (an unexpected non-view dependent stops the migration), and recreates them.

**Entities without a node still show.** The alternative (an entity is invisible until placed) would make every new table vanish and every integrator write a menu row for each one. The default matches the flat menu, and a hidden node is the explicit way to hide.

**`sort_order` keeps its meaning on `metadata.entities`.** It is the default entity order: Detail related sections, MCP `list_entities`, and the position of unplaced entities. Menu order is a different concern and has its own column. Reusing one column for both would make dragging in the menu editor reorder unrelated screens.

**A definer bridge view.** `schema_menu_nodes` is `SECURITY DEFINER` on purpose and is on the view-security allowlist: the menu is public wayfinding data (anonymous users see a menu), the base table's policy is already "everyone reads", and the view adds translation through `metadata.t()`. It exposes no data the table does not.

**Whole-tree save.** One RPC call replaces the tree, instead of per-node writes. Reordering touches many `sort_order` values and moves subtrees, and node-by-node edits can pass through states the trigger rejects (for example, a child briefly deeper than three levels). A single transaction avoids partial menus. The cost is no conflict detection: two admins saving concurrently, the last save wins.

**Depth cap of 3.** A deeper menu is hard to scan in a drawer, and the cap keeps the structure shallow. The cap is enforced in the trigger and mirrored in core, so it can be raised in one place later.

**Entity nodes may have entity children.** A sub-list (notes under a case) is a common shape and costs nothing. Headings cannot sit under an entity, because a heading under a link has no clear click target.

**`base_display_name` beside the translated label.** The editor needs the base label; the sidebar needs the translated one. One view returns both.

**Labels translate through the existing translation system** (`menu_node` source, `<node_key>.display_name`), so Translation Admin and coverage reports work. `get_translation_defaults()` gained the source.

**MCP is unaffected.** LLM clients address entities by name, not by menu position, and a grouping hint would need its own design.

**Core owns the rules.** `buildMenu` and `validateMenuTree` live in `@civic-os/core` so the generic app, the editor and future clients interpret the tree the same way. The app holds only binding and presentation.

## Revert

The revert script restores `metadata.entities.show_in_sidebar` and the previous `schema_entities`, dependents, `upsert_entity_metadata` (17 parameters), `add_guided_form_step`, `schema_cache_versions` and `get_translation_defaults`, then drops the menu objects. It is lossy by design. Every eligible entity (those with a node and the unplaced ones that follow the root nodes) gets `sort_order = rank * 10`, where rank is its position in the depth-first menu order (a hidden root entity node has no place in the menu, so it ranks with the unplaced entities by its entity `sort_order`, keeping the general entity order), and `show_in_sidebar = FALSE` when its node or any ancestor is hidden. Entities without a `metadata.entities` row get one. Headings, nesting, labels, icons, collapsed flags and menu translations are lost; export `schema_menu_nodes` first.

## Out of scope and future

- **Custom-page nodes.** `node_kind` is a two-value CHECK today; a third kind for custom pages (`docs/notes/CUSTOM_PAGES_DESIGN.md`) is a migration plus a `buildMenu` branch.
- **Dashboards in the menu.** Not designed.
- **Per-role menus.** One tree for everyone; hiding is global. Role-specific visibility would need its own model (compare dashboard role visibility).
- **MCP grouping hint.** Not done.
- **Conflict detection on save.** A version check against `menu_version` could reject a stale save.
- **Plural names.** Set a node label per entity; there is no automatic pluralization.
