-- Revert civic_os:v0-81-2-menu-access
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Restores the v0.81.0 objects: the definer save_menu_tree(jsonb) with its is_admin() guard, the definer
-- schema_menu_nodes view, the "everyone reads" policy and the trigger that checks targets through
-- schema_entities. Drops the v0.81.2 functions, write policies and grants, and the menu permission with
-- every role mapping of it. Menu data is untouched.

BEGIN;

-- ============================================================================
-- save_menu_tree(jsonb), SECURITY DEFINER (body as in v0.81.0)
-- ============================================================================

DROP FUNCTION public.save_menu_tree(JSONB, TIMESTAMPTZ);

CREATE FUNCTION public.save_menu_tree(p_nodes JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_nodes JSONB;
  v_skipped JSONB;
  v_unreached TEXT;
  v_count INT := 0;
  r RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_nodes IS NULL OR jsonb_typeof(p_nodes) <> 'array' THEN
    RAISE EXCEPTION 'p_nodes must be a JSON array of menu nodes' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Mark dropped targets, then give every kept node its nearest kept ancestor as parent. A parent that
  -- is not in the input stays as given, and the reachability check below rejects it.
  WITH RECURSIVE input AS (
    -- COALESCE: a NULL kind must stay a kept node, so the table's NOT NULL rejects it instead of it vanishing.
    SELECT x.*,
           COALESCE(x.node_kind = 'entity'
             AND EXISTS (SELECT 1 FROM metadata.menu_nodes m
                         WHERE m.node_key = x.node_key AND m.node_kind = 'entity' AND m.target_key = x.target_key)
             AND NOT EXISTS (SELECT 1 FROM public.schema_entities se WHERE se.table_name = x.target_key),
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

  FOR r IN
    WITH RECURSIVE input AS (
      SELECT x.* FROM jsonb_to_recordset(v_nodes) AS x(
        node_key TEXT, node_kind TEXT, target_key TEXT, display_name TEXT, icon TEXT,
        parent_node_key TEXT, sort_order INT, is_hidden BOOLEAN, collapsed_by_default BOOLEAN)
    ), tree AS (
      SELECT i.*, 1 AS depth FROM input i WHERE i.parent_node_key IS NULL
      UNION ALL
      SELECT i.*, t.depth + 1 FROM input i JOIN tree t ON i.parent_node_key = t.node_key WHERE t.depth < 20
    )
    SELECT * FROM tree ORDER BY depth, sort_order NULLS FIRST, node_key
  LOOP
    INSERT INTO metadata.menu_nodes (
      node_key, node_kind, target_key, display_name, icon, parent_node_key,
      sort_order, is_hidden, collapsed_by_default
    ) VALUES (
      r.node_key, r.node_kind, r.target_key, r.display_name, r.icon, r.parent_node_key,
      r.sort_order, COALESCE(r.is_hidden, FALSE), COALESCE(r.collapsed_by_default, FALSE)
    );
    v_count := v_count + 1;
  END LOOP;

  -- An empty array deletes everything; the statement trigger has stamped the version either way.
  RETURN jsonb_build_object(
    'nodes', v_count,
    'skipped', v_skipped,
    'menu_version', (SELECT changed_at FROM metadata.menu_version WHERE singleton)
  );
END;
$$;

COMMENT ON FUNCTION public.save_menu_tree(JSONB) IS
    'Replace the whole sidebar menu tree in one transaction. Admin only. p_nodes: JSON array of objects keyed by metadata.menu_nodes column names. Stored entity nodes whose target is no longer an entity are skipped and their children lifted. Returns the node count, the skipped keys and the new menu version. Added in v0.81.0.';

REVOKE EXECUTE ON FUNCTION public.save_menu_tree(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_menu_tree(JSONB) TO authenticated;

-- ============================================================================
-- schema_menu_nodes, definer (as in v0.81.0)
-- ============================================================================

DROP VIEW public.schema_menu_nodes;

CREATE VIEW public.schema_menu_nodes AS
SELECT
    n.node_key,
    n.node_kind,
    n.target_key,
    metadata.t('menu_node', n.node_key || '.display_name', n.display_name) AS display_name,
    n.icon,
    n.parent_node_key,
    n.sort_order,
    n.is_hidden,
    n.collapsed_by_default,
    n.display_name AS base_display_name
FROM metadata.menu_nodes n;

COMMENT ON VIEW public.schema_menu_nodes IS
    'Sidebar menu nodes for the frontend. display_name is translated through metadata.t() (source type menu_node, key <node_key>.display_name); base_display_name is the untranslated label for the menu editor. sort_order is raw (NULL counts as 0). Added in v0.81.0.';

GRANT SELECT ON public.schema_menu_nodes TO web_anon, authenticated;

-- ============================================================================
-- RLS: everyone reads, no API writes (as in v0.81.0)
-- ============================================================================

DROP POLICY menu_nodes_select ON metadata.menu_nodes;
DROP POLICY menu_nodes_insert ON metadata.menu_nodes;
DROP POLICY menu_nodes_update ON metadata.menu_nodes;
DROP POLICY menu_nodes_delete ON metadata.menu_nodes;

CREATE POLICY menu_nodes_select ON metadata.menu_nodes
    FOR SELECT TO web_anon, authenticated USING (true);

REVOKE INSERT, UPDATE, DELETE ON metadata.menu_nodes FROM authenticated;
REVOKE SELECT ON metadata.menu_version FROM authenticated;

-- ============================================================================
-- Trigger: target check through schema_entities (as in v0.81.0)
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.menu_nodes_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = metadata, public, pg_catalog
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
       AND NOT EXISTS (SELECT 1 FROM public.schema_entities se WHERE se.table_name = NEW.target_key) THEN
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
    'BEFORE row trigger of metadata.menu_nodes: key rules, entity target eligibility, parent kind, depth <= 3, no cycles. Added in v0.81.0.';

-- ============================================================================
-- Functions and permission
-- ============================================================================

DROP FUNCTION metadata.menu_visible_tree(TEXT[]);
DROP FUNCTION metadata.can_read_full_menu();
DROP FUNCTION metadata.can_manage_menu();
DROP FUNCTION metadata.menu_target_eligible(NAME);

DELETE FROM metadata.permission_roles
WHERE permission_id IN (SELECT id FROM metadata.permissions WHERE table_name = 'metadata.menu_nodes');
DELETE FROM metadata.permissions WHERE table_name = 'metadata.menu_nodes';

-- save_menu_tree changed signature: running PostgREST must reload its schema cache.
NOTIFY pgrst, 'reload schema';

COMMIT;
