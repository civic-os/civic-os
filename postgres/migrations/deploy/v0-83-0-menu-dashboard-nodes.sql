-- Deploy civic_os:v0-83-0-menu-dashboard-nodes
-- Requires: v0-82-1-dashboard-selector-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- v0.83.0 -- Dashboards in the sidebar menu (issue #124).
--
--   metadata.menu_nodes.dashboard_id   a dashboard, two ways:
--     * a 'dashboard' node (a leaf, key 'dashboard:<id>') links to it. It sits wherever an entity node
--       may (root, under a heading, under an entity node), and nothing sits under it;
--     * a heading may link to one: its title opens the dashboard, its chevron toggles the section.
--     One node per dashboard (UNIQUE), so the active entry and the open branch are never ambiguous.
--   metadata.menu_visible_tree()        a dashboard leaf shows, and a heading links, only for callers that
--                                       can see the dashboard (metadata.dashboard_visible(), v0.80.3); a
--                                       heading whose link the caller can see is kept even with no entry below
--   public.schema_menu_nodes            gains dashboard_id and dashboard_display_name (the translated title,
--                                       NULL when the caller cannot see the dashboard)
--   public.save_menu_tree()             stores dashboard_id
--   metadata.dashboards                 BEFORE DELETE: deletes the dashboard's leaf and clears a heading's
--                                       link; title, is_public and created_by changes of a dashboard in the
--                                       menu move the menu cache version, as do dashboard_roles changes
--
-- Why a heading links instead of a dashboard node holding children: dashboards are role-gated by design,
-- and a link node a caller cannot see is dropped with its children lifted to its parent. A module grouped
-- under a role-gated dashboard would fall apart for every other role. A linked heading stays, unlinked,
-- and its label is required, so the title of a dashboard the caller cannot see never reaches them.
--
-- Why the foreign key has no ON DELETE action: an ON DELETE SET NULL (or CASCADE) runs its UPDATE on
-- metadata.menu_nodes for every deleted dashboard, which fires the statement trigger that stamps the menu
-- version even when no node points at the dashboard. The BEFORE DELETE trigger clears the references
-- itself, only when there are some, and the foreign key then only guards against dangling links.
--
-- Framework migration: no schema decision (ADR) is recorded.

BEGIN;

-- ============================================================================
-- 1. TABLE
-- ============================================================================

ALTER TABLE metadata.menu_nodes
    ADD COLUMN dashboard_id INT REFERENCES metadata.dashboards(id);

-- The unique constraint's index is also the index on the foreign key column.
ALTER TABLE metadata.menu_nodes
    ADD CONSTRAINT menu_nodes_dashboard_unique UNIQUE (dashboard_id);

ALTER TABLE metadata.menu_nodes DROP CONSTRAINT menu_nodes_node_kind_check;
ALTER TABLE metadata.menu_nodes
    ADD CONSTRAINT menu_nodes_node_kind_check CHECK (node_kind IN ('heading', 'entity', 'dashboard'));

ALTER TABLE metadata.menu_nodes
    ADD CONSTRAINT menu_nodes_dashboard_check CHECK (
        node_kind <> 'dashboard'
        OR (dashboard_id IS NOT NULL AND target_key IS NULL AND node_key = 'dashboard:' || dashboard_id::TEXT));

ALTER TABLE metadata.menu_nodes
    ADD CONSTRAINT menu_nodes_entity_dashboard_check CHECK (node_kind <> 'entity' OR dashboard_id IS NULL);

COMMENT ON TABLE metadata.menu_nodes IS
    'Sidebar menu tree: headings, entity links and dashboard links, nested up to three levels. Owns show/hide for the sidebar (is_hidden hides a node and its subtree). Entities without a node appear at the root, ordered by entity sort_order; dashboards without a node are not in the menu. Added in v0.81.0; dashboards since v0.83.0.';
COMMENT ON COLUMN metadata.menu_nodes.node_key IS 'Stable identifier. An entity node uses its table name; a heading uses a slug matching ^[a-z][a-z0-9_]*$; a dashboard node uses dashboard:<dashboard id>.';
COMMENT ON COLUMN metadata.menu_nodes.node_kind IS 'heading (label, no target, may link to a dashboard), entity (link to an entity) or dashboard (link to a dashboard, no children).';
COMMENT ON COLUMN metadata.menu_nodes.display_name IS 'Label override (required for headings; optional for entity and dashboard nodes, which fall back to the entity name or the dashboard title). Translatable via source type menu_node.';
COMMENT ON COLUMN metadata.menu_nodes.dashboard_id IS 'The dashboard a dashboard node links to (required), or the dashboard a heading''s title opens (optional). One node per dashboard. Shown only to callers who can see the dashboard. Deleting the dashboard deletes its dashboard node and clears a heading''s link. Added in v0.83.0.';

-- ============================================================================
-- 2. VALIDATION TRIGGER: nothing under a dashboard node
-- ============================================================================
-- Unchanged from v0.81.2 except the dashboard rule. The key, target and kind rules of a dashboard node are
-- table CHECKs, and the foreign key holds its existence.

CREATE OR REPLACE FUNCTION metadata.menu_nodes_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, pg_catalog
AS $$
DECLARE
  v_parent metadata.menu_nodes%ROWTYPE;
  v_depth INT := 1;      -- depth of NEW (root = 1)
  v_levels INT;          -- levels below NEW
  v_cur TEXT;
  v_steps INT := 0;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.node_kind IS DISTINCT FROM OLD.node_kind THEN
    RAISE EXCEPTION 'Menu node "%" cannot change kind from % to %; delete it and create a new node',
      OLD.node_key, OLD.node_kind, NEW.node_kind
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.node_kind = 'heading' THEN
    IF NEW.node_key !~ '^[a-z][a-z0-9_]*$' THEN
      RAISE EXCEPTION 'Menu heading key "%" must match ^[a-z][a-z0-9_]*$ (lowercase letters, digits and underscores, starting with a letter)',
        NEW.node_key
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.node_kind = 'entity' THEN
    -- Eligible exactly like public.schema_entities. A NULL target is left to the table CHECK.
    IF NEW.target_key IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.target_key IS DISTINCT FROM OLD.target_key)
       AND NOT metadata.menu_target_eligible(NEW.target_key) THEN
      RAISE EXCEPTION 'Menu target "%" is not an entity: it must be a table in the public schema, or a view registered in metadata.entities',
        NEW.target_key
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.parent_node_key IS NOT NULL THEN
    IF NEW.parent_node_key = NEW.node_key THEN
      RAISE EXCEPTION 'Menu node "%" cannot be its own parent (cycle)', NEW.node_key
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO v_parent FROM metadata.menu_nodes WHERE node_key = NEW.parent_node_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent menu node "%" of "%" does not exist', NEW.parent_node_key, NEW.node_key
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_parent.node_kind = 'dashboard' THEN
      RAISE EXCEPTION 'Menu node "%" cannot sit under dashboard node "%": a dashboard node has no children',
        NEW.node_key, v_parent.node_key
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.node_kind = 'heading' AND v_parent.node_kind <> 'heading' THEN
      RAISE EXCEPTION 'Menu heading "%" can only sit at the root or under a heading, not under entity node "%"',
        NEW.node_key, v_parent.node_key
        USING ERRCODE = 'check_violation';
    END IF;

    -- Walk up: depth of NEW, and a cycle if NEW appears among its own ancestors.
    v_depth := 2;
    v_cur := v_parent.parent_node_key;
    WHILE v_cur IS NOT NULL LOOP
      IF v_cur = NEW.node_key THEN
        RAISE EXCEPTION 'Moving menu node "%" under "%" would create a cycle', NEW.node_key, NEW.parent_node_key
          USING ERRCODE = 'check_violation';
      END IF;
      v_depth := v_depth + 1;
      v_steps := v_steps + 1;
      IF v_steps > 50 THEN
        RAISE EXCEPTION 'Menu tree above "%" is corrupt (more than 50 levels)', NEW.node_key
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT parent_node_key INTO v_cur FROM metadata.menu_nodes WHERE node_key = v_cur;
    END LOOP;
  END IF;

  -- Levels below NEW (a move carries its subtree along; a fresh INSERT has none).
  v_levels := 0;
  IF TG_OP = 'UPDATE' THEN
    WITH RECURSIVE sub(node_key, lvl) AS (
      SELECT n.node_key, 1 FROM metadata.menu_nodes n WHERE n.parent_node_key = NEW.node_key
      UNION ALL
      SELECT n.node_key, s.lvl + 1 FROM metadata.menu_nodes n JOIN sub s ON n.parent_node_key = s.node_key
      WHERE s.lvl < 50
    )
    SELECT COALESCE(MAX(lvl), 0) INTO v_levels FROM sub;
  END IF;

  IF v_depth + v_levels > 3 THEN
    RAISE EXCEPTION 'Menu node "%" would sit at depth % (subtree included); the menu is limited to 3 levels',
      NEW.node_key, v_depth + v_levels
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION metadata.menu_nodes_validate() IS
    'BEFORE row trigger of metadata.menu_nodes: key rules, entity target eligibility (menu_target_eligible), parent kind (nothing under a dashboard node), depth <= 3, no cycles. Added in v0.81.0; SECURITY DEFINER (sees every row) and target check without schema_entities since v0.81.2; dashboard nodes since v0.83.0.';

-- ============================================================================
-- 3. THE VISIBLE TREE: dashboard visibility per caller
-- ============================================================================
-- The rules of buildMenu (packages/core/src/menu/build-menu.ts) for the given targets:
--   * a hidden node ends its branch;
--   * an entity node whose target is not in p_targets, or a dashboard node whose dashboard the caller
--     cannot see, is dropped, and its children take the nearest kept ancestor as parent;
--   * a heading is dropped unless an entity or dashboard node is kept below it, or it links to a
--     dashboard the caller can see.
-- Stubs are unchanged: they exist because buildMenu lists entities without a node at the root, and a
-- dashboard without a node is never listed, so a hidden dashboard node is simply dropped.
-- metadata.can_see_dashboard() reads the caller's JWT claims (is_admin(), current_user_id(),
-- get_user_roles()), which a SECURITY DEFINER function does not change, so it answers for the caller here.

CREATE OR REPLACE FUNCTION metadata.menu_visible_tree(p_targets TEXT[])
RETURNS TABLE (node_key TEXT, parent_node_key TEXT, is_stub BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = metadata, pg_catalog
AS $$
  WITH RECURSIVE nodes AS (
    -- target_ok: the node's own target is shown to this caller. link_ok: a heading's dashboard link is.
    SELECT n.node_key, n.node_kind, n.target_key, n.parent_node_key, n.is_hidden,
           CASE n.node_kind
             WHEN 'heading' THEN TRUE
             WHEN 'entity' THEN COALESCE(n.target_key::TEXT = ANY (p_targets), FALSE)
             ELSE n.dashboard_id IS NOT NULL AND metadata.can_see_dashboard(n.dashboard_id)
           END AS target_ok,
           n.node_kind = 'heading' AND n.dashboard_id IS NOT NULL AND metadata.can_see_dashboard(n.dashboard_id) AS link_ok
    FROM metadata.menu_nodes n
  ), walk AS (
    -- hid: inside a hidden subtree. kept: rendered for this caller. carry: the parent its children get.
    SELECT n.node_key, n.node_kind, n.target_key, n.link_ok, h.hid, k.kept, NULL::TEXT AS eff_parent,
           CASE WHEN k.kept THEN n.node_key END AS carry, 1 AS depth
    FROM nodes n
    CROSS JOIN LATERAL (SELECT n.is_hidden AS hid) h
    CROSS JOIN LATERAL (SELECT NOT h.hid AND n.target_ok AS kept) k
    WHERE n.parent_node_key IS NULL
    UNION ALL
    SELECT c.node_key, c.node_kind, c.target_key, c.link_ok, h.hid, k.kept, w.carry,
           CASE WHEN k.kept THEN c.node_key ELSE w.carry END, w.depth + 1
    FROM walk w
    JOIN nodes c ON c.parent_node_key = w.node_key
    CROSS JOIN LATERAL (SELECT w.hid OR c.is_hidden AS hid) h
    CROSS JOIN LATERAL (SELECT NOT h.hid AND c.target_ok AS kept) k
    WHERE w.depth < 50
  ), live(node_key) AS (
    -- Every kept node above kept content (an entity or dashboard node, or a heading with a link the
    -- caller can see), through effective parents.
    SELECT w.eff_parent FROM walk w
    WHERE w.kept AND (w.node_kind <> 'heading' OR w.link_ok) AND w.eff_parent IS NOT NULL
    UNION
    SELECT w.eff_parent FROM live l JOIN walk w ON w.node_key = l.node_key WHERE w.eff_parent IS NOT NULL
  )
  SELECT w.node_key, w.eff_parent, FALSE
  FROM walk w
  WHERE w.kept AND (w.node_kind <> 'heading' OR w.link_ok OR w.node_key IN (SELECT l.node_key FROM live l))
  UNION ALL
  SELECT w.node_key, NULL, TRUE
  FROM walk w
  WHERE w.hid AND w.node_kind = 'entity' AND w.target_key::TEXT = ANY (p_targets);
$$;

COMMENT ON FUNCTION metadata.menu_visible_tree(TEXT[]) IS
    'The menu nodes buildMenu renders for a set of entity targets and the caller''s dashboard visibility, with effective parents, plus a stub per entity node inside a hidden subtree whose target is in the set. The caller passes its own schema_entities names. Added in v0.81.2; dashboard nodes and heading links since v0.83.0.';

-- ============================================================================
-- 4. public.schema_menu_nodes: dashboard id and title
-- ============================================================================
-- Unchanged from v0.81.2 except the two appended columns. dashboard_display_name comes through a join on
-- metadata.dashboards, which runs under the caller's dashboards policy (metadata.dashboard_visible()), so
-- it is NULL exactly when the caller cannot see the dashboard. Callers that are not full readers never
-- receive a dashboard node they cannot see; full readers (menu editors, translators) do, with a NULL title.

DROP VIEW public.schema_menu_nodes;

CREATE VIEW public.schema_menu_nodes
WITH (security_invoker = true) AS
WITH vis AS MATERIALIZED (
    SELECT v.node_key, v.parent_node_key, v.is_stub
    FROM metadata.menu_visible_tree(ARRAY(SELECT se.table_name::TEXT FROM public.schema_entities se)) v
    WHERE NOT (SELECT metadata.can_read_full_menu())
)
SELECT
    n.node_key,
    n.node_kind,
    n.target_key,
    metadata.t('menu_node', n.node_key || '.display_name', n.display_name) AS display_name,
    n.icon,
    CASE WHEN v.node_key IS NULL THEN n.parent_node_key ELSE v.parent_node_key END AS parent_node_key,
    n.sort_order,
    n.is_hidden,
    n.collapsed_by_default,
    n.display_name AS base_display_name,
    n.dashboard_id,
    CASE WHEN d.id IS NOT NULL
         THEN metadata.t('dashboard', 'dashboard.' || d.id::TEXT || '.display_name', d.display_name::TEXT)
    END AS dashboard_display_name
FROM metadata.menu_nodes n
LEFT JOIN vis v ON v.node_key = n.node_key AND NOT v.is_stub
LEFT JOIN metadata.dashboards d ON d.id = n.dashboard_id
UNION ALL
SELECT
    v.node_key,
    'entity'::TEXT,
    v.node_key::NAME,
    NULL::TEXT,
    NULL::TEXT,
    NULL::TEXT,
    NULL::INT,
    TRUE,
    FALSE,
    NULL::TEXT,
    NULL::INT,
    NULL::TEXT
FROM vis v
WHERE v.is_stub;

COMMENT ON VIEW public.schema_menu_nodes IS
    'Sidebar menu nodes for the frontend, filtered per caller (v0.81.2): menu managers and translators read every node; everyone else reads the nodes buildMenu renders for them, with effective parents, plus a stub (key and target only, hidden) for each hidden entity node whose entity they can see. display_name is translated through metadata.t() (source type menu_node, key <node_key>.display_name); base_display_name is the untranslated label for the menu editor. sort_order is raw (NULL counts as 0). dashboard_id is the dashboard a dashboard node or a linked heading opens; dashboard_display_name is its translated title, NULL when the caller cannot see it (v0.83.0). Added in v0.81.0.';

GRANT SELECT ON public.schema_menu_nodes TO web_anon, authenticated;

-- ============================================================================
-- 5. public.save_menu_tree(): stores dashboard_id
-- ============================================================================
-- Unchanged from v0.81.2 except dashboard_id in the input columns and the INSERT. No visibility check on
-- write: a menu editor's draft may hold links to dashboards they cannot see, and must be able to save them
-- back. The foreign key checks that the dashboard exists.

CREATE OR REPLACE FUNCTION public.save_menu_tree(p_nodes JSONB, p_expected_version TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_nodes JSONB;
  v_skipped JSONB;
  v_unreached TEXT;
  v_current TIMESTAMPTZ;
  v_count INT;
BEGIN
  IF NOT metadata.can_manage_menu() THEN
    RAISE EXCEPTION 'Permission to manage the menu is required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_nodes IS NULL OR jsonb_typeof(p_nodes) <> 'array' THEN
    RAISE EXCEPTION 'p_nodes must be a JSON array of menu nodes' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('civic_os.menu_tree'));

  -- Read after the lock: in READ COMMITTED this statement sees a save that committed while we waited.
  IF p_expected_version IS NOT NULL THEN
    SELECT changed_at INTO v_current FROM metadata.menu_version WHERE singleton;
    IF v_current IS DISTINCT FROM p_expected_version THEN
      RAISE EXCEPTION 'The menu was changed by someone else since it was loaded'
        USING ERRCODE = 'PT409',
              DETAIL = format('Expected menu version %s, stored menu version %s.', p_expected_version, v_current),
              HINT = format('Reload the menu (stored version %s) and apply your changes again.', v_current);
    END IF;
  END IF;

  -- Mark dropped targets, then give every kept node its nearest kept ancestor as parent. A parent that
  -- is not in the input stays as given, and the reachability check below rejects it.
  WITH RECURSIVE input AS (
    -- COALESCE: a NULL kind must stay a kept node, so the table's NOT NULL rejects it instead of it vanishing.
    SELECT x.*,
           COALESCE(x.node_kind = 'entity'
             AND EXISTS (SELECT 1 FROM metadata.menu_nodes m
                         WHERE m.node_key = x.node_key AND m.node_kind = 'entity' AND m.target_key = x.target_key)
             AND NOT metadata.menu_target_eligible(x.target_key::NAME),
             FALSE) AS skipped
    FROM jsonb_to_recordset(p_nodes) AS x(
      node_key TEXT, node_kind TEXT, target_key TEXT, display_name TEXT, icon TEXT,
      parent_node_key TEXT, sort_order INT, is_hidden BOOLEAN, collapsed_by_default BOOLEAN, dashboard_id INT)
  ), up AS (
    -- hid: a skipped node passed on the way up was hidden. The sidebar hides a hidden node's whole
    -- subtree whether or not its target exists, so a child lifted past one stays hidden.
    SELECT k.node_key, k.parent_node_key AS cand, 0 AS steps, FALSE AS hid FROM input k WHERE NOT k.skipped
    UNION ALL
    SELECT u.node_key, s.parent_node_key, u.steps + 1, u.hid OR COALESCE(s.is_hidden, FALSE)
    FROM up u JOIN input s ON s.node_key = u.cand AND s.skipped
    WHERE u.steps < 20
  ), lifted AS (
    SELECT DISTINCT ON (u.node_key) u.node_key, u.cand, u.hid
    FROM up u
    WHERE NOT EXISTS (SELECT 1 FROM input s WHERE s.node_key = u.cand AND s.skipped)
    ORDER BY u.node_key, u.steps
  )
  SELECT
    -- No lifted row means the chain never left skipped nodes (a cycle): keep the given parent, which is
    -- then missing from the kept set, so the reachability check rejects the node.
    COALESCE((SELECT jsonb_agg(CASE WHEN l.node_key IS NULL THEN to_jsonb(i) - 'skipped'
                                    WHEN l.hid THEN jsonb_set(jsonb_set(to_jsonb(i) - 'skipped', '{parent_node_key}',
                                                   COALESCE(to_jsonb(l.cand), 'null'::jsonb)), '{is_hidden}', 'true'::jsonb)
                                    ELSE jsonb_set(to_jsonb(i) - 'skipped', '{parent_node_key}',
                                                   COALESCE(to_jsonb(l.cand), 'null'::jsonb)) END)
              FROM input i LEFT JOIN lifted l ON l.node_key = i.node_key
              WHERE NOT i.skipped), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(i.node_key ORDER BY i.node_key) FROM input i WHERE i.skipped), '[]'::jsonb)
  INTO v_nodes, v_skipped;

  WITH RECURSIVE input AS (
    SELECT x.* FROM jsonb_to_recordset(v_nodes) AS x(node_key TEXT, parent_node_key TEXT)
  ), tree AS (
    SELECT i.node_key, 1 AS depth FROM input i WHERE i.parent_node_key IS NULL
    UNION ALL
    SELECT i.node_key, t.depth + 1 FROM input i JOIN tree t ON i.parent_node_key = t.node_key WHERE t.depth < 20
  )
  SELECT string_agg(i.node_key, ', ' ORDER BY i.node_key) INTO v_unreached
  FROM input i
  WHERE i.node_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tree t WHERE t.node_key = i.node_key);

  IF v_unreached IS NOT NULL THEN
    RAISE EXCEPTION 'Menu nodes with an unknown parent or part of a cycle: %', v_unreached
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  DELETE FROM metadata.menu_nodes WHERE TRUE;

  -- One statement, parents first: the row trigger sees the rows inserted before it in the same statement,
  -- the parent FK is checked at the end of it, and the insert policy is evaluated once, not once per node.
  INSERT INTO metadata.menu_nodes (
    node_key, node_kind, target_key, display_name, icon, parent_node_key,
    sort_order, is_hidden, collapsed_by_default, dashboard_id
  )
  WITH RECURSIVE input AS (
    SELECT x.* FROM jsonb_to_recordset(v_nodes) AS x(
      node_key TEXT, node_kind TEXT, target_key TEXT, display_name TEXT, icon TEXT,
      parent_node_key TEXT, sort_order INT, is_hidden BOOLEAN, collapsed_by_default BOOLEAN, dashboard_id INT)
  ), tree AS (
    SELECT i.*, 1 AS depth FROM input i WHERE i.parent_node_key IS NULL
    UNION ALL
    SELECT i.*, t.depth + 1 FROM input i JOIN tree t ON i.parent_node_key = t.node_key WHERE t.depth < 20
  )
  SELECT t.node_key, t.node_kind, t.target_key, t.display_name, t.icon, t.parent_node_key,
         t.sort_order, COALESCE(t.is_hidden, FALSE), COALESCE(t.collapsed_by_default, FALSE), t.dashboard_id
  FROM tree t
  ORDER BY t.depth, t.sort_order NULLS FIRST, t.node_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- An empty array deletes everything; the statement trigger has stamped the version either way.
  RETURN jsonb_build_object(
    'nodes', v_count,
    'skipped', v_skipped,
    'menu_version', (SELECT changed_at FROM metadata.menu_version WHERE singleton)
  );
END;
$$;

COMMENT ON FUNCTION public.save_menu_tree(JSONB, TIMESTAMPTZ) IS
    'Replace the whole sidebar menu tree in one transaction. Requires is_admin() or the metadata.menu_nodes:update permission (SECURITY INVOKER: the table policies apply). p_nodes: JSON array of objects keyed by metadata.menu_nodes column names (dashboard_id since v0.83.0). p_expected_version: the menu version the caller loaded; a different stored version raises PT409 (HTTP 409); NULL skips the check. Stored entity nodes whose target is no longer an entity are skipped and their children lifted. Returns the node count, the skipped keys and the new menu version. Added in v0.81.0; invoker with a version check since v0.81.2.';

-- ============================================================================
-- 6. DASHBOARD CHANGES REACH THE MENU
-- ============================================================================
-- A deleted dashboard takes its dashboard node with it and leaves a linked heading unlinked. Only when the
-- dashboard is in the menu: a statement on metadata.menu_nodes stamps the menu version, so a delete of a
-- dashboard outside the menu runs none.

CREATE FUNCTION metadata.menu_dashboard_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, pg_catalog
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM metadata.menu_nodes WHERE dashboard_id = OLD.id) THEN
    DELETE FROM metadata.menu_nodes WHERE node_kind = 'dashboard' AND dashboard_id = OLD.id;
    UPDATE metadata.menu_nodes SET dashboard_id = NULL WHERE dashboard_id = OLD.id;
  END IF;
  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION metadata.menu_dashboard_deleted() IS
    'BEFORE DELETE row trigger of metadata.dashboards: deletes the dashboard''s menu node and clears a heading''s link to it, when the dashboard is in the menu. SECURITY DEFINER: deleting a dashboard needs no menu permission. Added in v0.83.0.';

CREATE TRIGGER menu_dashboard_deleted
    BEFORE DELETE ON metadata.dashboards
    FOR EACH ROW
    EXECUTE FUNCTION metadata.menu_dashboard_deleted();

-- The menu shows a dashboard's title, and only to callers who can see it: a change of either moves the
-- menu cache version, so open browsers refetch the menu on their next navigation. Only for dashboards in
-- the menu; a dashboard not in the menu changes nothing there.

CREATE FUNCTION metadata.menu_dashboard_stamp_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, pg_catalog
AS $$
DECLARE
  v_ids INT[];
BEGIN
  IF TG_TABLE_NAME = 'dashboards' THEN
    v_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    v_ids := ARRAY[NEW.dashboard_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.dashboard_id];
  ELSE
    v_ids := ARRAY[OLD.dashboard_id, NEW.dashboard_id];
  END IF;

  IF EXISTS (SELECT 1 FROM metadata.menu_nodes WHERE dashboard_id = ANY (v_ids)) THEN
    INSERT INTO metadata.menu_version (singleton, changed_at) VALUES (TRUE, clock_timestamp())
    ON CONFLICT (singleton) DO UPDATE SET changed_at = EXCLUDED.changed_at;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION metadata.menu_dashboard_stamp_version() IS
    'AFTER row trigger of metadata.dashboards (title, is_public, created_by) and metadata.dashboard_roles: stamps metadata.menu_version when the dashboard is in the menu, because the menu shows its title to the callers who can see it. Added in v0.83.0.';

CREATE TRIGGER menu_dashboard_stamp_version
    AFTER UPDATE OF display_name, is_public, created_by ON metadata.dashboards
    FOR EACH ROW
    WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name
          OR OLD.is_public IS DISTINCT FROM NEW.is_public
          OR OLD.created_by IS DISTINCT FROM NEW.created_by)
    EXECUTE FUNCTION metadata.menu_dashboard_stamp_version();

CREATE TRIGGER menu_dashboard_stamp_version
    AFTER INSERT OR UPDATE OR DELETE ON metadata.dashboard_roles
    FOR EACH ROW
    EXECUTE FUNCTION metadata.menu_dashboard_stamp_version();

REVOKE EXECUTE ON FUNCTION metadata.menu_dashboard_deleted() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION metadata.menu_dashboard_stamp_version() FROM PUBLIC;

-- schema_menu_nodes gained columns: running PostgREST must reload its schema cache.
NOTIFY pgrst, 'reload schema';

COMMIT;
