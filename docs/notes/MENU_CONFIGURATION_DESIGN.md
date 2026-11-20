# Menu Configuration Design

**Status**: Built (v0.81.0); per-caller reads, a menu permission and stale-save rejection added in v0.81.2 (see Amendment); dashboards in the menu added in v0.83.0 (see Amendment: dashboards)
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
| `node_kind` | `heading`, `entity` or (v0.83.0) `dashboard`. A CHECK limits it, so a new kind (custom page) is a migration, and the kind cannot change on update |
| `target_key` | The table or registered view an entity node links to; NULL for a heading. Unique per kind, so an entity has one node |
| `display_name` | Label override; required for headings, optional for entity nodes |
| `icon` | Material Symbols name |
| `parent_node_key` | Self-reference with `ON DELETE CASCADE`. Deleting a parent deletes its subtree, which leaves those entities unplaced, not hidden |
| `sort_order` | Nullable INT, no default, like `metadata.entities.sort_order` |
| `is_hidden` | Hides the node and its subtree |
| `collapsed_by_default` | Initial open state for headings and parent entity nodes |
| `dashboard_id` | (v0.83.0) The dashboard a dashboard node links to (required), or the dashboard a heading's title opens (optional). `UNIQUE`; foreign key to `metadata.dashboards` with no `ON DELETE` action (see Amendment: dashboards) |

Placement rules: depth at most 3 (root is 1); headings at the root or under a heading; entity nodes at the root, under a heading or under an entity node; no cycles; an entity node's `node_key` equals its target; a target must be a `public` table or a view registered in `metadata.entities`, the same eligibility test as `public.schema_entities` (virtual entities qualify).

### Where each rule lives

- **Database**: the `BEFORE INSERT OR UPDATE` row trigger `metadata.menu_nodes_validate()` enforces every structural rule above, including the depth of a moved subtree and cycles on UPDATE. SQL, init scripts and the RPC all pass through it.
- **Core** (`packages/core/src/menu/`): `validateMenuTree` mirrors the structural rules as data (error codes, in node order) so an editor reports problems before the round trip. `buildMenu` turns the flat rows plus the caller's entities into the visible tree. `menuBranchKeys` returns the ancestors of an entity entry so a host can open the active branch. All three are pure and total: cycles, orphans, duplicates and over-deep data degrade (a cycle breaks at its first node, an orphan becomes a root) and never throw or loop. Their `@consumer` tag is `app`, and the consumer for `MenuNodeKind` and the error types is `typed`.
- **App**: `SchemaService.getMenu()` combines entities (junction tables excluded), the cached nodes and `buildMenu` into a `MenuState` of `loading`, `error` or `ready`. `SidebarMenuComponent` renders a `ready` tree. `/admin/menu` (`AdminMenuPage` with the pure operations in `admin-menu.tree.ts`) edits it.

### `buildMenu` rules

1. `is_hidden` removes a node and its subtree. An entity with a hidden node is not treated as unplaced.
2. An entity node whose target is not among the caller's entities is dropped and its children take its place.
3. A heading with no visible descendant is dropped.
4. Siblings sort by (`sort_order` with NULL as 0, key in code point order). Entities with no node follow the root nodes, sorted among themselves by (entity `sort_order`, table name).
5. Label: the node's translated `display_name`, else the entity's display name. A blank node label counts as unset.

Sibling order is the same key as `schema_entities` (`ORDER BY COALESCE(sort_order, 0), table_name`), so a menu with no visible nodes reproduces the previous order exactly. Unplaced entities trail the root nodes rather than merging in among them: a heading placed at the root stays above every unplaced entity whatever their `sort_order` values, the editor can renumber root siblings (x10) without moving them past unplaced entities, and a newly created table appears at the end where an admin will notice it. Sibling nodes with equal `sort_order` tie-break by key in code point order, the order the revert and the functional test's depth-first walk use (`COLLATE "C"`); the editor writes distinct positions (x10), so only hand-written trees tie. Unplaced entities with equal `sort_order` keep their order in the entity list, which is the database's collation (`schema_entities` orders by `table_name` in the default collation, where `timeslots` precedes `time_slot`).

## Data flow

1. `public.schema_menu_nodes` (view) exposes the nodes. `display_name` goes through `metadata.t('menu_node', node_key || '.display_name', display_name)`; `base_display_name` is the untranslated label.
2. `SchemaClient.getMenuNodes()` fetches and caches the rows per context and shares the in-flight request. A failure rejects and is not cached, so the next call retries. `invalidateMenuNodes()` drops only the menu slot.
3. `metadata.menu_version` (one row) is stamped by statement-level triggers on every INSERT, UPDATE, DELETE and TRUNCATE of `menu_nodes`. The `menu` row of `schema_cache_versions` reads it. `MAX(updated_at)` would miss deletes, which is why the version is stamped instead.
4. `VersionService` compares the `menu` version on each navigation (`schemaVersionGuard`); a change calls `SchemaService.refreshMenuCache()`, which refetches the nodes. The entities cache is untouched: a menu edit never refetches entities or properties.
5. `refreshCache()` (used on a locale change) also refetches the nodes once the menu has been requested, because labels are translated server-side.

### Sidebar component

`SidebarMenuComponent` is an attribute component on the list itself (`<ul appSidebarMenu class="menu">`), so every `<li>` it renders is a direct child of a `<ul>`. Any host element between the two, even with `display: contents` and `role="none"`, fails axe's `list` rule. The page's own items are projected around the tree: children marked `menuStart` (Home, the load-failure notice) go before it, all others (About, Admin) after it. It renders the root level as sections (`sidebarSections()`): a root heading is a `<details>` whose summary is styled like the sidebar's About and Admin titles, and its entries sit at the root indent (the nested list drops DaisyUI's indent and guide line). A run of root entities that follows a heading, or the whole root when there is no heading, gets a **Data** section, because without the indent those entities would read as part of the heading above; a run before the first heading stays untitled under Home. Nested headings are ordinary DaisyUI `<details>` items. Parent entity nodes are a link plus a DaisyUI `.menu-dropdown-toggle` button (`aria-expanded`, `aria-controls`, translated `aria-label`) side by side in a two-column `li`, so both are direct `li` children (DaisyUI styles only those) and the toggle draws the same `::after` chevron as a summary; the child list is `.menu-dropdown` / `.menu-dropdown-show`. `src/styles.css` restores the open-summary chevron rotation, which DaisyUI 5.7.27 overrides by re-emitting its closed rule unprefixed in the responsive menu variants.

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

As built in v0.81.0, `public.save_menu_tree(p_nodes jsonb)` was `SECURITY DEFINER`, admin only (`is_admin()`), `PUBLIC` execute revoked; v0.81.2 changed the signature, security and guard (see Amendment). It rejects non-array input, rejects nodes with an unknown parent or on a cycle before writing, deletes every row, then inserts parents before children (ordered by depth), so the validation trigger sees each node with its real parent. Everything runs in one transaction, so a failed save leaves the old tree. It returns the node count, the skipped keys and the new menu version. An empty array empties the menu, after which every entity shows at the root.

**Dropped targets on save.** The editor sends every row back, including a node whose table was dropped after it was placed; re-inserting it would fail the trigger, so one dropped table would make the menu unsaveable. `save_menu_tree` therefore skips an input entity node when a node with the same key and target is already stored and the target is no longer in `schema_entities`, and gives its children their nearest kept ancestor as parent (the rendering rule). The stored-node condition keeps the trigger strict for everything new: a node first added with a bad target still raises, and so does sending the skipped node again after the save removed it. The trigger itself stays strict for direct inserts. A child lifted past a hidden skipped node is stored hidden, because the sidebar hid that subtree before the table was dropped (`buildMenu` checks `is_hidden` before the target).

**Heading keys and table names share `node_key`.** An entity node's key is its table name, and a heading's key is a slug, so a heading can hold a key that a later table takes. `add_guided_form_step` hides only an *entity* node for its step table and refuses (returns `success = false`) when a heading owns that key, rather than hiding the heading; an editor save that places a new table named like a heading fails on the primary key until the heading is replaced under another key.

In v0.81.0 `metadata.menu_nodes` granted SELECT only (policy: everyone reads); v0.81.2 replaced that policy and granted writes to `authenticated` under policies (see Amendment). Integrators write it from migrations and init scripts, which run as a database role.

## Decisions and tradeoffs

**Hard move of `show_in_sidebar`, not a kept column.** Two sources of truth (a flag and a node) would need a precedence rule and would let `schema_entities` and the tree disagree. Dropping the column makes the tree the only owner. The cost is a breaking change for install SQL: a script that writes the column or passes `p_show_in_sidebar` fails after the upgrade. The migration seeds a hidden root node only for each entity that had `show_in_sidebar = FALSE`; visible entities stay unplaced and keep their `sort_order` order, so an upgraded instance renders identically and reaches the same state as a fresh install (whose init scripts write their own hidden nodes), and the Integrator Guide gives the one-statement replacement. Dropping the column meant dropping and recreating `schema_entities` and its dependent views; the migration captures their definitions, options, comments and grants, drops without CASCADE (an unexpected non-view dependent stops the migration), and recreates them.

**Entities without a node still show.** The alternative (an entity is invisible until placed) would make every new table vanish and every integrator write a menu row for each one. The default matches the flat menu, and a hidden node is the explicit way to hide.

**`sort_order` keeps its meaning on `metadata.entities`.** It is the default entity order: Detail related sections, MCP `list_entities`, and the position of unplaced entities. Menu order is a different concern and has its own column. Reusing one column for both would make dragging in the menu editor reorder unrelated screens.

**A definer bridge view (v0.81.0, reversed in v0.81.2).** `schema_menu_nodes` was `SECURITY DEFINER` and on the view-security allowlist, on the reasoning that the menu is public wayfinding data. That was wrong: hidden nodes carry heading labels and the names of tables a caller cannot read (`schema_entities` filters by grants, so those names are otherwise private). See Amendment.

**Whole-tree save.** One RPC call replaces the tree, instead of per-node writes. Reordering touches many `sort_order` values and moves subtrees, and node-by-node edits can pass through states the trigger rejects (for example, a child briefly deeper than three levels). A single transaction avoids partial menus. The cost in v0.81.0 was no conflict detection (the last save won); v0.81.2 adds a version check (see Amendment).

**Depth cap of 3.** A deeper menu is hard to scan in a drawer, and the cap keeps the structure shallow. The cap is enforced in the trigger and mirrored in core, so it can be raised in one place later.

**Entity nodes may have entity children.** A sub-list (notes under a case) is a common shape and costs nothing. Headings cannot sit under an entity, because a heading under a link has no clear click target.

**`base_display_name` beside the translated label.** The editor needs the base label; the sidebar needs the translated one. One view returns both.

**Labels translate through the existing translation system** (`menu_node` source, `<node_key>.display_name`), so Translation Admin and coverage reports work. `get_translation_defaults()` gained the source.

**MCP is unaffected.** LLM clients address entities by name, not by menu position, and a grouping hint would need its own design.

**Core owns the rules.** `buildMenu` and `validateMenuTree` live in `@civic-os/core` so the generic app, the editor and future clients interpret the tree the same way. The app holds only binding and presentation.

## Amendment: per-caller reads, menu permission and stale saves (v0.81.2)

Migration `v0-81-2-menu-access` resolves five v0.81.0 follow-ups (#75, #86, #87, #94, #95).

### Reads filtered per caller (#94)

`schema_menu_nodes` was a definer view over a `USING (true)` policy, so an anonymous caller read hidden nodes, heading labels and table names it cannot see in `schema_entities`. The view is now `security_invoker`, and the `menu_nodes_select` policy admits a row when either holds:

- `metadata.can_read_full_menu()`: `is_admin()`, `metadata.menu_nodes:update` or `metadata.translations:update`. Translators need hidden labels because `get_translation_defaults()` is invoker and reads the table. Full readers get stored parents, and `buildMenu` filters their sidebar on the client as before.
- The node is in `metadata.menu_visible_tree(targets)`, where `targets` is the caller's `schema_entities` table names. The function walks the tree from the roots with the rules of `buildMenu`: a hidden node ends its branch, an entity node outside `targets` is dropped and its effective parent is carried down to its children, and headings left with no kept entity below are dropped. The view returns the effective parent for these callers through a `LEFT JOIN` on the same function. One `buildMenu` rule is not repeated: the app also drops junction tables, which it detects from foreign keys, so a node targeting a junction table the caller can read (or a heading holding only such nodes) still reaches the client and `buildMenu` drops it there. Its label names a table the caller already reads, so the rule stays client-side rather than duplicating junction detection in SQL.

**Why the targets are an argument.** `menu_visible_tree` is `SECURITY DEFINER` so it sees every row. Inside it, `information_schema` (and so `schema_entities`) would check the owner's privileges, not the caller's. The policy computes the list as the caller in an uncorrelated subquery (one evaluation per statement) and passes it in.

**Stubs for hidden entities.** `buildMenu` counts an entity as placed when any row targets it, hidden or not; an entity without a row is listed at the root as unplaced. Dropping every hidden row would therefore show guided-form step tables and entities carried over from `show_in_sidebar = false` to exactly the users who should not see them. So for an entity node inside a hidden subtree whose target is in `targets`, the walk keeps a stub: `node_key`, `node_kind`, `target_key`, `is_hidden = true`, every other column NULL. The stub names a table the caller already reads in `schema_entities`, so it leaks nothing. Hidden headings and hidden entity nodes outside `targets` are still dropped. `v0-81-2-menu-access-test.sh` checks, for each non-full caller, that `buildMenu` over the filtered rows equals `buildMenu` over all rows with that caller's entities.

### Menu permission

`metadata.menu_nodes:update` is seeded and mapped to admin, as `metadata.instance_config:update` is in v0.79.0. `metadata.can_manage_menu()` is `is_admin() OR has_permission('metadata.menu_nodes', 'update')`: the explicit `is_admin()` is the escape valve of `docs/development/PERMISSIONS_MODEL.md`, since `has_permission()` has no admin bypass. The insert, update and delete policies (`TO authenticated`) use it, and `authenticated` holds the table grants they need; `metadata` is not exposed by PostgREST, so those grants are reachable only from invoker SQL. The frontend gates the page and the Admin link with the same expression.

### Invoker save, version check and lock (#86)

`save_menu_tree(p_nodes jsonb, p_expected_version timestamptz DEFAULT NULL)` replaces the one-argument signature, which is dropped so PostgREST resolves one function. It is `SECURITY INVOKER`, so the write policies gate it; an up-front `can_manage_menu()` check gives a clear `42501`. It takes `pg_advisory_xact_lock(hashtext('civic_os.menu_tree'))` first, so concurrent saves queue instead of failing on the primary key, and then compares `p_expected_version` with `metadata.menu_version.changed_at` (granted SELECT to `authenticated` only, since anonymous callers never save). A mismatch raises `PT409` with a hint naming the stored version, which PostgREST returns as HTTP 409. `NULL` skips the check, for scripts and for a browser still running the previous app during a deploy.

The editor reads the `menu` row of `schema_cache_versions` before the nodes, so a save between the two reads can only cause a needless conflict, never a missed one. The service maps only `code === 'PT409'` to a conflict: PostgREST also answers 409 for unique and foreign key violations, which stay errors. On conflict the page shows a `role="alert"` message, moves focus to it, disables Save (a retry with the same version can only conflict again) and offers Reload beside Discard.

### Target eligibility without `schema_entities` (#95)

The validation trigger and the save evaluated `schema_entities` once per node. `metadata.menu_target_eligible(name)` applies the same eligibility rule (a public table, or a registered public view that is not `schema_%` or one of the excluded views) as index lookups on `pg_class` and `metadata.entities`, without privileges, as the definer paths always did. Because it restates the rule, `v0-81-2-menu-access-test.sh` compares it with superuser `schema_entities` for every relation in `public`, fixture views, a materialized view and a partitioned table included; a change to either side fails that test.

Making the save invoker exposed two more costs. Every per-node `INSERT` evaluated the insert policy, and every read inside the trigger applied the select policy (193 policy checks in a 100-node save). So `menu_nodes_validate()` became `SECURITY DEFINER` (its parent, depth and cycle checks must see every row anyway, whoever writes), and the save inserts the tree in one `INSERT ... SELECT ... ORDER BY depth`: `BEFORE ROW` triggers see the rows the same statement inserted earlier, and the parent foreign key is checked at the end of the statement. A 100-node save on neighborhood-hub went from a median of 138 to 208 ms (v0.81.1, two runs) to 88 to 114 ms, with 4 policy checks.

### Placement rules exported from core (#75)

`@civic-os/core` exports `MAX_MENU_DEPTH`, `MENU_HEADING_KEY` and `menuPlacementAllowed(kind, parentKind)`, which `validateMenuTree` uses; the editor's tree operations call them instead of keeping copies.

### Verify scripts (#87)

`verify/v0-81-0-menu-nodes.sql` now checks grants, but only properties that hold both right after v0.81.0 and once v0.81.2 is deployed, because `sqitch verify` runs every script against the current state. Functions are matched by name and checked for security properties, and a signature that may be gone is looked up with `to_regprocedure()`: a `'...'::regprocedure` literal is folded at plan time and fails even behind an existence guard.

## Amendment: dashboards (v0.83.0)

Migration `v0-83-0-menu-dashboard-nodes` (issue #124) lets dashboards into the tree. Before, a module's dashboards were reachable only from the navbar selector and from links inside other dashboards, so a module could not put its landing page or its management page next to its entities.

### Two forms

- **A dashboard node** (`node_kind = 'dashboard'`) links to `/dashboard/:id`. It is a leaf. It sits wherever an entity node may: the root, under a heading, or under an entity node.
- **A heading may open a dashboard** (`dashboard_id` on a heading). Its title is a link to the dashboard and its chevron toggles the section.

**Why a linked heading, not a dashboard node with children.** Dashboards are role-gated by design (v0.80.3), so whether a caller sees a dashboard varies by role far more often than whether they can read a table (grants, which rarely vary by role). The rule for a link node the caller cannot see is to drop it and lift its children to its parent, which works for the occasional unreadable entity but would flatten a whole module for every role that cannot see the module's dashboard. A heading keeps its place: when the caller cannot see its dashboard it is an ordinary heading, and its label is required, so no title of a dashboard the caller cannot open reaches them. It also keeps sub-headings possible, which an entity-style parent cannot hold. *Rejected:* dashboard nodes with children under the entity rules (the group falls apart for other roles, a root dashboard with children would render as an item in the Data run rather than a section, no sub-headings); leaves only at the root and under headings (a module heading could not open its dashboard).

**Why leaves may sit under entity nodes.** Once grouping is a heading's job, nothing needs to nest under a dashboard node, but nothing argues for keeping it out of the places an entity link goes (a dashboard about a table's records, under that table).

**Why nothing sits under a dashboard node.** A linked heading covers the "clickable group" case, and a single way to express it keeps the editor and the visibility rules simple. The rule is easy to relax later, while tightening it would break stored trees.

### Target typing and keys

`dashboard_id INT REFERENCES metadata.dashboards(id)`, `UNIQUE`, shared by both forms: one place in the menu per dashboard keeps the active entry and the forced-open branch unambiguous, and the unique index is the foreign key's index. `target_key` stays NULL for dashboard nodes, so it keeps meaning "a table or view". A table CHECK requires a dashboard node's key to be `dashboard:<id>`: the colon is outside the heading slug and any unquoted table name, so the key spaces cannot collide, and ids are the only stable dashboard identifier (dashboard translations key on ids too). Another CHECK keeps `dashboard_id` off entity nodes. *Rejected:* the id as text in `target_key` with triggers (re-implements a foreign key, mixes two meanings in one column); `dashboard_<id>` keys (collide with heading slugs and plausible table names); integrator-chosen keys (nothing to validate them against).

**No `ON DELETE` action.** An `ON DELETE SET NULL` or `CASCADE` runs its update or delete on `menu_nodes` for every deleted dashboard, and the statement trigger that stamps the menu version fires even when no row matches (verified on PostgreSQL 17), so every dashboard delete would move the menu version and conflict open editor drafts. Instead a `BEFORE DELETE` row trigger on `metadata.dashboards` (`menu_dashboard_deleted()`, definer, so deleting a dashboard needs no menu permission) deletes the dashboard's node and clears a heading's link, only when the dashboard is in the menu; the foreign key then only guards against dangling references. A heading keeps its subtree when its dashboard goes.

### Visibility

This is the first per-caller filter on menu leaves: entity nodes still show regardless of permission. `menu_visible_tree()` treats a dashboard node as kept when `metadata.can_see_dashboard(id)` holds, and a heading as kept when a kept leaf (entity or dashboard) is below it or its own link is visible. `can_see_dashboard()` evaluates `dashboard_visible()`, which reads the JWT claims (`is_admin()`, `current_user_id()`, `get_user_roles()`); a `SECURITY DEFINER` function does not change those, so the walk answers for the caller without a new argument, unlike `schema_entities`, whose privilege checks would run as the owner. Stubs are unchanged: they exist because `buildMenu` lists entities without a node at the root, and dashboards without a node are never listed, so a hidden dashboard node is simply left out.

`schema_menu_nodes` appends `dashboard_id` and `dashboard_display_name`, the translated title through a join on `metadata.dashboards`. The view is invoker, so the join runs under the caller's dashboards policy and the title is NULL exactly when the caller cannot see the dashboard. That NULL is the signal `buildMenu` uses: a dashboard node renders, and a heading carries `dashboardId`, only when the row has a title. Non-full readers never receive a dashboard node they cannot see; full readers (menu editors, translators) do, with a NULL title, and the editor marks those rows Not shown.

`save_menu_tree()` stores `dashboard_id` and checks no visibility: a non-admin menu editor's draft can hold links to dashboards they cannot see, and must save them back.

### Cache version

`menu_dashboard_stamp_version()` stamps `metadata.menu_version` after a change to a dashboard that is in the menu: an update of `display_name`, `is_public` or `created_by`, and any insert, update or delete of its `dashboard_roles` rows (direct writes, `set_dashboard_roles()`, the `dashboard_role_defaults` sync, role deletes). A dashboard outside the menu changes nothing in it, so it stamps nothing; a new dashboard is outside the menu. Title translations already move the `translations` version, which refetches the menu. The app also refetches the menu on impersonation start, stop and role change and on login and logout (`AppComponent`, the trigger `DashboardService` uses), because both dashboard visibility and full-reader status follow the roles.

Known cost: the editor's expected version is the same stamp, so a menu editor with an open draft gets a PT409 conflict if someone changes a placed dashboard's title or roles meanwhile. *Rejected:* a separate dashboards version folded into the `menu` row of `schema_cache_versions`, which the editor sends as its expected version, so it would conflict on every dashboard edit anyway, or need a second version source.

### Core and app

`MenuNodeKind` gains `dashboard`; `MenuNodeRow` gains `dashboard_id` and `dashboard_display_name`; `MenuEntry` gains `dashboardId` (dashboard entries, and headings whose link the caller can see). `buildMenu` keeps a heading with a visible link even with no entries, labels a dashboard node by its `display_name` else the dashboard title, and renders each dashboard once. `validateMenuTree` adds `dashboard-key`, `dashboard-children` and `duplicate-dashboard`. `menuPlacementAllowed` refuses any parent that is a dashboard node. `menuDashboardKey(id)` builds the key. `menuBranchKeys` accepts a table name or `{ dashboardId }`.

The sidebar parses `/dashboard/:id` as well as entity routes for the active entry, marks active links with `aria-current="page"`, and forces open the branch, a linked heading itself and a Data section that holds the active dashboard. A link cannot sit inside a `<summary>`, so a linked heading uses the link plus `.menu-dropdown-toggle` pattern of parent entity nodes; at the root it keeps the section title style. With no visible entries it is the link alone.

The editor reads `get_dashboards()` fresh (not `DashboardService`'s cache), lists dashboards without a row in a second tray, gives heading rows an "Opens dashboard" select limited to dashboards no other row holds, and fills `dashboard_display_name` from its own dashboards for the preview, so the preview applies the same visibility rule as the sidebar.

MCP is unchanged: it does not read the menu and has no dashboard tools.

### Tests

`tests/functional/v0-83-0-menu-dashboard-nodes-test.sh` covers the constraints and trigger, the rows each kind of caller gets, the version stamps, deletes and saves, and checks that `buildMenu` over each caller's rows equals `buildMenu` over the full rows with that caller's dashboard visibility applied. `v0-81-2-menu-access-test.sh` applies the same masking. Both now run in CI, with `v0-81-0-menu-nodes-test.sh`, after a package build.

Reverting v0.83.0 deletes dashboard nodes, clears heading links and restores the v0.81.2 functions and view.

## Revert

The revert script restores `metadata.entities.show_in_sidebar` and the previous `schema_entities`, dependents, `upsert_entity_metadata` (17 parameters), `add_guided_form_step`, `schema_cache_versions` and `get_translation_defaults`, then drops the menu objects. It is lossy by design. Every eligible entity (those with a node and the unplaced ones that follow the root nodes) gets `sort_order = rank * 10`, where rank is its position in the depth-first menu order (a hidden root entity node has no place in the menu, so it ranks with the unplaced entities by its entity `sort_order`, keeping the general entity order), and `show_in_sidebar = FALSE` when its node or any ancestor is hidden. Entities without a `metadata.entities` row get one. Headings, nesting, labels, icons, collapsed flags and menu translations are lost; export `schema_menu_nodes` first.

Reverting v0.81.2 (`sqitch revert --to v0-81-1-instance-config-translation-defaults`) restores the v0.81.0 select policy, definer view, trigger function and `save_menu_tree(jsonb)`, and drops the new functions, policies, grants and permission rows. Menu data is untouched.

## Out of scope and future

- **Custom-page nodes.** A fourth `node_kind` for custom pages (`docs/notes/CUSTOM_PAGES_DESIGN.md`) is a migration plus a `buildMenu` branch, and a heading could open one the way it opens a dashboard.
- **Per-role menus.** One tree for everyone; hiding is global. Dashboard nodes and heading links follow dashboard visibility (v0.83.0), but entity nodes and headings are not filtered by role. Role-specific visibility for them would need its own model.
- **MCP grouping hint.** Not done.
- **Plural names.** Set a node label per entity; there is no automatic pluralization.
