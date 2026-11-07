-- Deploy civic_os:v0-81-2-menu-access
-- Requires: v0-81-1-instance-config-translation-defaults
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- v0.81.2 -- Menu access: per-caller visibility, a menu permission, stale-save rejection, cheap target checks.
--
--   metadata.menu_target_eligible(name)   schema_entities' eligibility rule as catalog lookups (#95)
--   metadata.can_manage_menu()            is_admin() OR the metadata.menu_nodes:update permission
--   metadata.can_read_full_menu()         can_manage_menu() OR metadata.translations:update (translators)
--   metadata.menu_visible_tree(text[])    the tree buildMenu renders for a set of targets (#94)
--   metadata.menu_nodes                   RLS: full readers see every row, everyone else the visible tree;
--                                         writes need can_manage_menu()
--   public.schema_menu_nodes              security_invoker; effective parents and hidden-entity stubs for
--                                         callers that are not full readers
--   public.save_menu_tree(jsonb, timestamptz)  SECURITY INVOKER, serialized by an advisory lock, rejects
--                                         a stale p_expected_version with PT409 (HTTP 409) (#86)
--
-- Who sees what. A full reader (admin, the menu permission, or the translations permission, whose
-- get_translation_defaults() reads menu labels) reads every node with its stored parent; the menu editor
-- and the translations admin need hidden nodes. Everyone else reads only what buildMenu would render for
-- them: hidden subtrees end, an entity node whose target the caller cannot see is dropped and its
-- children move up to the nearest kept ancestor, and headings left without an entity are dropped. Before
-- this change web_anon read every node, hidden ones included, and so learned the names of tables it
-- could not read.
--
-- Stubs. buildMenu counts an entity as placed when any node targets it, hidden or not, and appends the
-- unplaced entities at the end of the menu. Dropping a hidden entity node would therefore show its
-- entity there (guided-form step tables, entities hidden before v0.81.0). So the view returns a stub
-- for each entity node inside a hidden subtree whose target the caller can see: node_key, node_kind,
-- target_key and is_hidden = TRUE, everything else NULL. A stub reveals only a table name the caller
-- already reads in schema_entities. Stubs come from menu_visible_tree() in the view, not from the table
-- policy, so a direct read of metadata.menu_nodes never returns a hidden node's label or icon.
--
-- Why the targets are an argument. schema_entities reads information_schema.tables, which lists only the
-- relations the current user has a privilege on. Inside a SECURITY DEFINER function the current user is
-- the owner, so menu_visible_tree() would see every table. The policy and the view evaluate
-- schema_entities as the caller (an uncorrelated subquery, once per statement) and pass the names in.
-- menu_visible_tree() is executable by API roles, so a direct SQL caller could pass arbitrary names and
-- learn the tree shape around them; the metadata schema is not exposed by PostgREST, so only SQL
-- sessions as web_anon or authenticated can do that.
--
-- Framework migration: no schema decision (ADR) is recorded.

BEGIN;

-- ============================================================================
-- 1. TARGET ELIGIBILITY WITHOUT schema_entities (#95)
-- ============================================================================
-- schema_entities builds the whole entity list (information_schema, metadata.t(), has_permission())
-- for each lookup; the trigger and save_menu_tree() did that once per node. This is the same rule as
-- index lookups. It ignores privileges, as the definer paths that used schema_entities always did.
-- The rule must stay equal to the WHERE clause of public.schema_entities, including its unescaped
-- LIKE 'schema_%'; tests/functional/v0-81-2-menu-access-test.sh compares the two for every relation.

CREATE FUNCTION metadata.menu_target_eligible(p_target NAME)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relname = p_target
      AND (
        c.relkind IN ('r', 'p')
        OR (
          c.relkind = 'v'
          AND EXISTS (SELECT 1 FROM metadata.entities e WHERE e.table_name = p_target)
          AND c.relname::text NOT LIKE 'schema_%'
          AND c.relname::text NOT IN (
            'time_slot_series', 'time_slot_instances', 'civic_os_users', 'managed_users',
            'gallery_admin', 'photo_galleries', 'photo_gallery_files', 'photo_gallery_config'
          )
        )
      )
  );
$$;

COMMENT ON FUNCTION metadata.menu_target_eligible(NAME) IS
    'Whether a relation may be a menu target: the eligibility rule of public.schema_entities (a public table, or a registered public view that is not excluded), without privileges. Added in v0.81.2.';

REVOKE EXECUTE ON FUNCTION metadata.menu_target_eligible(NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metadata.menu_target_eligible(NAME) TO authenticated;

-- SECURITY DEFINER since v0.81.2: the parent, depth and cycle checks must see every row, and writes now
-- come from invoker code (save_menu_tree, direct writes by menu editors) under the menu_nodes policies.
-- Before, the definer save_menu_tree gave it that view. Not callable through the API (a trigger function).
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
    'BEFORE row trigger of metadata.menu_nodes: key rules, entity target eligibility (menu_target_eligible), parent kind, depth <= 3, no cycles. Added in v0.81.0; SECURITY DEFINER (sees every row) and target check without schema_entities since v0.81.2.';

REVOKE EXECUTE ON FUNCTION metadata.menu_nodes_validate() FROM PUBLIC;

-- ============================================================================
-- 2. PERMISSION AND ACCESS PREDICATES
-- ============================================================================

INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('metadata.menu_nodes', 'update')
ON CONFLICT (table_name, permission) DO NOTHING;

DO $$
DECLARE
  v_admin_role_id SMALLINT;
  v_perm RECORD;
BEGIN
  SELECT id INTO v_admin_role_id FROM metadata.roles WHERE role_key = 'admin';
  IF v_admin_role_id IS NOT NULL THEN
    FOR v_perm IN
      SELECT id FROM metadata.permissions
      WHERE table_name = 'metadata.menu_nodes'
    LOOP
      INSERT INTO metadata.permission_roles (role_id, permission_id)
      VALUES (v_admin_role_id, v_perm.id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
END $$;

-- is_admin() is the escape valve (docs/development/PERMISSIONS_MODEL.md): has_permission() has no admin
-- bypass, so an admin whose role lost the permission still manages the menu.
CREATE FUNCTION metadata.can_manage_menu()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = metadata, public, pg_catalog
AS $$
  SELECT public.is_admin() OR public.has_permission('metadata.menu_nodes', 'update');
$$;

COMMENT ON FUNCTION metadata.can_manage_menu() IS
    'Whether the caller may edit the sidebar menu: is_admin() or the metadata.menu_nodes:update permission. Added in v0.81.2.';

CREATE FUNCTION metadata.can_read_full_menu()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = metadata, public, pg_catalog
AS $$
  SELECT metadata.can_manage_menu() OR public.has_permission('metadata.translations', 'update');
$$;

COMMENT ON FUNCTION metadata.can_read_full_menu() IS
    'Whether the caller reads every menu node with its stored parent, hidden ones included: menu managers, and translators (get_translation_defaults() lists menu labels). Added in v0.81.2.';

REVOKE EXECUTE ON FUNCTION metadata.can_manage_menu() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION metadata.can_read_full_menu() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metadata.can_manage_menu() TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION metadata.can_read_full_menu() TO web_anon, authenticated;

-- ============================================================================
-- 3. THE VISIBLE TREE (#94)
-- ============================================================================
-- The rules of buildMenu (packages/core/src/menu/build-menu.ts) for the given targets:
--   * a hidden node ends its branch;
--   * an entity node whose target is not in p_targets is dropped, and its children take the nearest
--     kept ancestor as parent;
--   * a heading with no kept entity below it is dropped.
-- Returns each kept node with its effective parent (is_stub = FALSE), and a stub (parent NULL,
-- is_stub = TRUE) for each entity node inside a hidden subtree whose target is in p_targets.
-- SECURITY DEFINER so it sees every row; the caller supplies the targets (see the header).

CREATE FUNCTION metadata.menu_visible_tree(p_targets TEXT[])
RETURNS TABLE (node_key TEXT, parent_node_key TEXT, is_stub BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = metadata, pg_catalog
AS $$
  WITH RECURSIVE walk AS (
    -- hid: inside a hidden subtree. kept: rendered for these targets. carry: the parent its children get.
    SELECT n.node_key, n.node_kind, n.target_key, h.hid, k.kept, NULL::TEXT AS eff_parent,
           CASE WHEN k.kept THEN n.node_key END AS carry, 1 AS depth
    FROM metadata.menu_nodes n
    CROSS JOIN LATERAL (SELECT n.is_hidden AS hid) h
    CROSS JOIN LATERAL (SELECT NOT h.hid AND (n.node_kind = 'heading' OR n.target_key::TEXT = ANY (p_targets)) AS kept) k
    WHERE n.parent_node_key IS NULL
    UNION ALL
    SELECT c.node_key, c.node_kind, c.target_key, h.hid, k.kept, w.carry,
           CASE WHEN k.kept THEN c.node_key ELSE w.carry END, w.depth + 1
    FROM walk w
    JOIN metadata.menu_nodes c ON c.parent_node_key = w.node_key
    CROSS JOIN LATERAL (SELECT w.hid OR c.is_hidden AS hid) h
    CROSS JOIN LATERAL (SELECT NOT h.hid AND (c.node_kind = 'heading' OR c.target_key::TEXT = ANY (p_targets)) AS kept) k
    WHERE w.depth < 50
  ), live(node_key) AS (
    -- Every kept node above a kept entity, through effective parents.
    SELECT w.eff_parent FROM walk w WHERE w.kept AND w.node_kind = 'entity' AND w.eff_parent IS NOT NULL
    UNION
    SELECT w.eff_parent FROM live l JOIN walk w ON w.node_key = l.node_key WHERE w.eff_parent IS NOT NULL
  )
  SELECT w.node_key, w.eff_parent, FALSE
  FROM walk w
  WHERE w.kept AND (w.node_kind = 'entity' OR w.node_key IN (SELECT l.node_key FROM live l))
  UNION ALL
  SELECT w.node_key, NULL, TRUE
  FROM walk w
  WHERE w.hid AND w.node_kind = 'entity' AND w.target_key::TEXT = ANY (p_targets);
$$;

COMMENT ON FUNCTION metadata.menu_visible_tree(TEXT[]) IS
    'The menu nodes buildMenu renders for a set of entity targets, with effective parents, plus a stub per entity node inside a hidden subtree whose target is in the set. The caller passes its own schema_entities names. Added in v0.81.2.';

REVOKE EXECUTE ON FUNCTION metadata.menu_visible_tree(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metadata.menu_visible_tree(TEXT[]) TO web_anon, authenticated;

-- ============================================================================
-- 4. ROW LEVEL SECURITY ON metadata.menu_nodes
-- ============================================================================
-- The predicates sit in scalar subqueries so each runs once per statement, not once per row.
-- INSERT, UPDATE and DELETE are granted to authenticated for the invoker save_menu_tree(); the metadata
-- schema is not exposed by PostgREST, so they are reachable only through SQL that runs as the caller.

DROP POLICY menu_nodes_select ON metadata.menu_nodes;

CREATE POLICY menu_nodes_select ON metadata.menu_nodes
    FOR SELECT TO web_anon, authenticated
    USING (
      (SELECT metadata.can_read_full_menu())
      OR node_key IN (
        SELECT v.node_key
        FROM metadata.menu_visible_tree(ARRAY(SELECT se.table_name::TEXT FROM public.schema_entities se)) v
        WHERE NOT v.is_stub
      )
    );

CREATE POLICY menu_nodes_insert ON metadata.menu_nodes
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT metadata.can_manage_menu()));

CREATE POLICY menu_nodes_update ON metadata.menu_nodes
    FOR UPDATE TO authenticated
    USING ((SELECT metadata.can_manage_menu()))
    WITH CHECK ((SELECT metadata.can_manage_menu()));

CREATE POLICY menu_nodes_delete ON metadata.menu_nodes
    FOR DELETE TO authenticated
    USING ((SELECT metadata.can_manage_menu()));

GRANT INSERT, UPDATE, DELETE ON metadata.menu_nodes TO authenticated;
GRANT SELECT ON metadata.menu_version TO authenticated;

-- ============================================================================
-- 5. public.schema_menu_nodes: invoker, per-caller tree
-- ============================================================================
-- Full readers get every row with its stored parent (the editor and the translations admin need hidden
-- nodes; buildMenu still filters their sidebar). Everyone else gets the rows the policy admits with
-- their effective parents, plus the hidden-entity stubs. Labels go through metadata.t(); the key is
-- <node_key>.display_name. base_display_name is the untranslated label the menu editor edits and saves.

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
    n.display_name AS base_display_name
FROM metadata.menu_nodes n
LEFT JOIN vis v ON v.node_key = n.node_key AND NOT v.is_stub
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
    NULL::TEXT
FROM vis v
WHERE v.is_stub;

COMMENT ON VIEW public.schema_menu_nodes IS
    'Sidebar menu nodes for the frontend, filtered per caller (v0.81.2): menu managers and translators read every node; everyone else reads the nodes buildMenu renders for them, with effective parents, plus a stub (key and target only, hidden) for each hidden entity node whose entity they can see. display_name is translated through metadata.t() (source type menu_node, key <node_key>.display_name); base_display_name is the untranslated label for the menu editor. sort_order is raw (NULL counts as 0). Added in v0.81.0.';

GRANT SELECT ON public.schema_menu_nodes TO web_anon, authenticated;

-- ============================================================================
-- 6. public.save_menu_tree(): invoker, serialized, optimistic version check (#86)
-- ============================================================================
-- The (jsonb) signature is dropped, so PostgREST resolves a single function; callers that send only
-- p_nodes still match through the default. p_expected_version is the menu version the caller loaded
-- (schema_cache_versions, cache_name 'menu'); when it differs from metadata.menu_version the save is
-- rejected with ERRCODE PT409, which PostgREST returns as HTTP 409. NULL skips the check (scripts, and
-- a browser still running the previous app during a deploy). The advisory lock queues concurrent saves,
-- so the second one sees the first one's version instead of failing on the primary key.
--
-- Everything else is unchanged from v0.81.0: dropped targets are skipped and their children lifted, the
-- input is checked for unknown parents and cycles, and the tree is replaced in one transaction.
-- Returns {"nodes": <count>, "skipped": [<node_key>, ...], "menu_version": <timestamptz>}.

DROP FUNCTION public.save_menu_tree(JSONB);

CREATE FUNCTION public.save_menu_tree(p_nodes JSONB, p_expected_version TIMESTAMPTZ DEFAULT NULL)
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
      parent_node_key TEXT, sort_order INT, is_hidden BOOLEAN, collapsed_by_default BOOLEAN)
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
    sort_order, is_hidden, collapsed_by_default
  )
  WITH RECURSIVE input AS (
    SELECT x.* FROM jsonb_to_recordset(v_nodes) AS x(
      node_key TEXT, node_kind TEXT, target_key TEXT, display_name TEXT, icon TEXT,
      parent_node_key TEXT, sort_order INT, is_hidden BOOLEAN, collapsed_by_default BOOLEAN)
  ), tree AS (
    SELECT i.*, 1 AS depth FROM input i WHERE i.parent_node_key IS NULL
    UNION ALL
    SELECT i.*, t.depth + 1 FROM input i JOIN tree t ON i.parent_node_key = t.node_key WHERE t.depth < 20
  )
  SELECT t.node_key, t.node_kind, t.target_key, t.display_name, t.icon, t.parent_node_key,
         t.sort_order, COALESCE(t.is_hidden, FALSE), COALESCE(t.collapsed_by_default, FALSE)
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
    'Replace the whole sidebar menu tree in one transaction. Requires is_admin() or the metadata.menu_nodes:update permission (SECURITY INVOKER: the table policies apply). p_nodes: JSON array of objects keyed by metadata.menu_nodes column names. p_expected_version: the menu version the caller loaded; a different stored version raises PT409 (HTTP 409); NULL skips the check. Stored entity nodes whose target is no longer an entity are skipped and their children lifted. Returns the node count, the skipped keys and the new menu version. Added in v0.81.0; invoker with a version check since v0.81.2.';

REVOKE EXECUTE ON FUNCTION public.save_menu_tree(JSONB, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_menu_tree(JSONB, TIMESTAMPTZ) TO authenticated;

COMMIT;
