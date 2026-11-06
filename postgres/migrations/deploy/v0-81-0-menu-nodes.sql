-- Deploy civic_os:v0-81-0-menu-nodes
-- Requires: v0-80-3-dashboard-role-visibility
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- v0.81.0 -- Configurable sidebar menu: a node tree that owns show/hide.
--
--   metadata.menu_nodes       headings and entity links, nested up to three levels (root = 1)
--   metadata.menu_version     single row stamped by every write to menu_nodes (cache version, sees deletes)
--   public.schema_menu_nodes  definer bridge view for clients; labels go through metadata.t('menu_node', ...)
--   public.save_menu_tree()   admin RPC: replaces the whole tree in one transaction
--   public.schema_cache_versions  gains a 'menu' row (menu edits never invalidate the entities cache)
--   public.get_translation_defaults()  gains the 'menu_node' source
--
-- HARD MOVE: metadata.entities.show_in_sidebar is dropped. A hidden root entity node is created for each
-- metadata.entities row with show_in_sidebar = FALSE whose target is eligible, keeping the entity's
-- sort_order. Visible entities get no node: entities without a node follow the root nodes in the menu,
-- sorted by (sort_order, table_name), which on an upgrade is exactly today's order, and the same state a
-- fresh install reaches. public.schema_entities loses the column; upsert_entity_metadata loses p_show_in_sidebar;
-- add_guided_form_step records a hidden node for the step table. Install SQL that writes the column
-- (or passes p_show_in_sidebar) fails after this migration: upsert a hidden menu node instead, e.g.
--   INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, sort_order, is_hidden)
--   VALUES ('t', 'entity', 't', <entity sort_order>, TRUE)
--   ON CONFLICT (node_key) DO UPDATE SET is_hidden = TRUE;
--
-- sort_order: INT, nullable, no default, exactly like metadata.entities.sort_order. schema_entities orders
-- by COALESCE(sort_order, 0) then table_name, so clients order siblings by (COALESCE(sort_order, 0),
-- node_key), and the entities without a node, after the root nodes, by (COALESCE(sort_order, 0),
-- table_name). The copy keeps the raw (possibly NULL) value and the bridge view exposes it raw.
--
-- Placement rules enforced by the BEFORE row trigger: headings sit at the root or under a heading; entity
-- nodes at the root, under a heading or under an entity node; depth <= 3; no cycles (checked on UPDATE too,
-- and a move re-checks the depth of the moved subtree); an entity node's target must be eligible exactly
-- like public.schema_entities (a public base table, or a view registered in metadata.entities); heading
-- keys match ^[a-z][a-z0-9_]*$. node_kind cannot change.
--
-- Dependents of public.schema_entities (schema_properties, schema_entity_dependencies and anything an
-- integrator built on them) must be dropped to drop the column. They are captured with their definitions,
-- options, comments and grants, dropped without CASCADE, and recreated after the new schema_entities.
--
-- Framework migration: no schema decision (ADR) is recorded.

BEGIN;

-- ============================================================================
-- 1. TABLES
-- ============================================================================

CREATE TABLE metadata.menu_nodes (
    node_key TEXT PRIMARY KEY,
    node_kind TEXT NOT NULL CHECK (node_kind IN ('heading', 'entity')),
    target_key NAME,
    display_name TEXT,
    icon TEXT,
    parent_node_key TEXT REFERENCES metadata.menu_nodes(node_key) ON DELETE CASCADE,
    sort_order INT,
    is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
    collapsed_by_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT menu_nodes_target_unique UNIQUE (node_kind, target_key),
    CONSTRAINT menu_nodes_heading_check CHECK (
        node_kind <> 'heading' OR (target_key IS NULL AND display_name IS NOT NULL)),
    CONSTRAINT menu_nodes_entity_check CHECK (
        node_kind <> 'entity' OR (target_key IS NOT NULL AND node_key = target_key::TEXT))
);

CREATE INDEX idx_menu_nodes_parent_node_key ON metadata.menu_nodes(parent_node_key);

COMMENT ON TABLE metadata.menu_nodes IS
    'Sidebar menu tree: headings and entity links, nested up to three levels. Owns show/hide for the sidebar (is_hidden hides a node and its subtree). Entities without a node appear at the root, ordered by entity sort_order. Added in v0.81.0.';
COMMENT ON COLUMN metadata.menu_nodes.node_key IS 'Stable identifier. An entity node uses its table name; a heading uses a slug matching ^[a-z][a-z0-9_]*$.';
COMMENT ON COLUMN metadata.menu_nodes.node_kind IS 'heading (label, no target) or entity (link to an entity).';
COMMENT ON COLUMN metadata.menu_nodes.target_key IS 'Table or registered view an entity node links to; NULL for headings.';
COMMENT ON COLUMN metadata.menu_nodes.display_name IS 'Label override (required for headings; optional for entity nodes, which fall back to the entity name). Translatable via source type menu_node.';
COMMENT ON COLUMN metadata.menu_nodes.icon IS 'Material icon name (optional).';
COMMENT ON COLUMN metadata.menu_nodes.parent_node_key IS 'Parent node; NULL for root. Deleting a parent deletes its subtree, which leaves those entities unplaced.';
COMMENT ON COLUMN metadata.menu_nodes.sort_order IS 'Sibling order, ascending; NULL counts as 0 (like metadata.entities.sort_order); ties break by node_key.';
COMMENT ON COLUMN metadata.menu_nodes.is_hidden IS 'Hides this node and its whole subtree.';
COMMENT ON COLUMN metadata.menu_nodes.collapsed_by_default IS 'Headings and parent entity nodes start collapsed.';

-- One row; changed_at moves on every INSERT, UPDATE, DELETE or TRUNCATE of menu_nodes. MAX(updated_at)
-- would miss a delete, so the cache version is stamped by statement-level triggers instead.
CREATE TABLE metadata.menu_version (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO metadata.menu_version (singleton, changed_at) VALUES (TRUE, clock_timestamp());

COMMENT ON TABLE metadata.menu_version IS
    'Single row: when metadata.menu_nodes last changed (insert, update, delete or truncate). Read by schema_cache_versions as the menu version. Added in v0.81.0.';

-- ============================================================================
-- 2. TRIGGERS
-- ============================================================================

CREATE FUNCTION metadata.menu_nodes_validate()
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

CREATE TRIGGER menu_nodes_validate
    BEFORE INSERT OR UPDATE ON metadata.menu_nodes
    FOR EACH ROW
    EXECUTE FUNCTION metadata.menu_nodes_validate();

CREATE TRIGGER set_updated_at_trigger
    BEFORE UPDATE ON metadata.menu_nodes
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

CREATE FUNCTION metadata.menu_nodes_stamp_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, pg_catalog
AS $$
BEGIN
  INSERT INTO metadata.menu_version (singleton, changed_at) VALUES (TRUE, clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET changed_at = EXCLUDED.changed_at;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION metadata.menu_nodes_stamp_version() IS
    'Statement-level AFTER trigger of metadata.menu_nodes: stamps metadata.menu_version, so deletes (single row, all rows, truncate) move the menu cache version. Added in v0.81.0.';

CREATE TRIGGER menu_nodes_stamp_version
    AFTER INSERT OR UPDATE OR DELETE ON metadata.menu_nodes
    FOR EACH STATEMENT
    EXECUTE FUNCTION metadata.menu_nodes_stamp_version();

CREATE TRIGGER menu_nodes_stamp_version_truncate
    AFTER TRUNCATE ON metadata.menu_nodes
    FOR EACH STATEMENT
    EXECUTE FUNCTION metadata.menu_nodes_stamp_version();

REVOKE EXECUTE ON FUNCTION metadata.menu_nodes_validate() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION metadata.menu_nodes_stamp_version() FROM PUBLIC;

-- ============================================================================
-- 3. ROW LEVEL SECURITY AND GRANTS
-- ============================================================================
-- Everyone reads. No INSERT/UPDATE/DELETE is granted to API roles (and the metadata schema is not exposed
-- by PostgREST): writes go through public.save_menu_tree() (admin only) or migrations and init scripts.

ALTER TABLE metadata.menu_nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY menu_nodes_select ON metadata.menu_nodes
    FOR SELECT TO web_anon, authenticated USING (true);

GRANT SELECT ON metadata.menu_nodes TO web_anon, authenticated;

-- ============================================================================
-- 4. COPY: one hidden root entity node per hidden metadata.entities row with an eligible target
-- ============================================================================

INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, sort_order, is_hidden)
SELECT e.table_name::TEXT, 'entity', e.table_name, e.sort_order, TRUE
FROM metadata.entities e
WHERE e.show_in_sidebar IS FALSE
  AND EXISTS (SELECT 1 FROM public.schema_entities se WHERE se.table_name = e.table_name)
ORDER BY e.table_name;

-- ============================================================================
-- 5. HARD MOVE: drop metadata.entities.show_in_sidebar
-- ============================================================================
-- 5a. Capture and drop everything built on public.schema_entities (no CASCADE: an unexpected dependent
-- that is not a view stops the migration instead of vanishing).

CREATE TEMP TABLE _menu_dependent_views ON COMMIT DROP AS
WITH RECURSIVE chain AS (
  SELECT c.oid, 1 AS lvl
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  JOIN pg_class c ON c.oid = r.ev_class
  WHERE d.classid = 'pg_rewrite'::regclass
    AND d.refclassid = 'pg_class'::regclass
    AND d.refobjid = 'public.schema_entities'::regclass
    AND c.oid <> d.refobjid
  UNION ALL
  SELECT c.oid, ch.lvl + 1
  FROM chain ch
  JOIN pg_depend d ON d.refobjid = ch.oid AND d.refclassid = 'pg_class'::regclass AND d.classid = 'pg_rewrite'::regclass
  JOIN pg_rewrite r ON r.oid = d.objid
  JOIN pg_class c ON c.oid = r.ev_class
  WHERE c.oid <> ch.oid
)
SELECT n.nspname AS nsp,
       c.relname AS rel,
       c.relkind AS kind,
       max(ch.lvl) AS lvl,
       pg_get_viewdef(c.oid) AS viewdef,
       array_to_string(c.reloptions, ',') AS options,
       obj_description(c.oid, 'pg_class') AS comment,
       (SELECT string_agg(format('GRANT %s ON %I.%I TO %s', a.privilege_type, n.nspname, c.relname,
                                 CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END), '; ')
        FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner) AS grants
FROM chain ch
JOIN pg_class c ON c.oid = ch.oid
JOIN pg_namespace n ON n.oid = c.relnamespace
GROUP BY n.nspname, c.relname, c.relkind, c.oid;

DO $$
DECLARE r RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM _menu_dependent_views WHERE kind <> 'v') THEN
    RAISE EXCEPTION 'A materialized view depends on public.schema_entities; drop it before this migration';
  END IF;
  FOR r IN SELECT * FROM _menu_dependent_views ORDER BY lvl DESC, nsp, rel LOOP
    EXECUTE format('DROP VIEW %I.%I', r.nsp, r.rel);
  END LOOP;
END $$;

DROP VIEW public.schema_entities;
ALTER TABLE metadata.entities DROP COLUMN show_in_sidebar;

-- 5b. schema_entities without show_in_sidebar (v0.58.0 body otherwise unchanged)

CREATE VIEW public.schema_entities AS
SELECT
    metadata.t('entity', tables.table_name::text || '.display_name',
      COALESCE(entities.display_name, tables.table_name::text)) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    metadata.t('entity', tables.table_name::text || '.description',
      entities.description) AS description,
    entities.search_fields,
    COALESCE(entities.show_map, false) AS show_map,
    entities.map_property_name,
    tables.table_name,
    has_permission(tables.table_name::text, 'create'::text) AS insert,
    has_permission(tables.table_name::text, 'read'::text) AS "select",
    has_permission(tables.table_name::text, 'update'::text) AS update,
    has_permission(tables.table_name::text, 'delete'::text) AS delete,
    COALESCE(entities.show_calendar, false) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    COALESCE(entities.enable_notes, false) AS enable_notes,
    COALESCE(entities.supports_recurring, false) AS supports_recurring,
    entities.recurring_property_name,
    (tables.table_type::text = 'VIEW'::text) AS is_view,
    entities.guided_form_key,
    entities.map_color_property,
    COALESCE(entities.is_rich_junction, false) AS is_rich_junction,
    entities.fulltext_search_column,
    entities.substring_search_column
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text IN ('BASE TABLE', 'VIEW')
  AND (tables.table_type::text = 'BASE TABLE' OR entities.table_name IS NOT NULL)
  AND NOT (
    tables.table_type::text = 'VIEW' AND (
      tables.table_name::text LIKE 'schema_%'
      OR tables.table_name::text IN (
        'time_slot_series', 'time_slot_instances', 'civic_os_users', 'managed_users',
        'gallery_admin', 'photo_galleries', 'photo_gallery_files', 'photo_gallery_config'
      )
    )
  )
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view. Updated in v0.58.0 to wrap display_name and description '
    'with metadata.t() for multi-language support.';

GRANT SELECT ON public.schema_entities TO web_anon, authenticated;

-- 5c. Recreate the dependents from the captured definitions, parents first.

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM _menu_dependent_views ORDER BY lvl, nsp, rel LOOP
    EXECUTE format('CREATE VIEW %I.%I AS %s', r.nsp, r.rel, regexp_replace(r.viewdef, ';\s*$', ''));
    IF r.options IS NOT NULL AND r.options <> '' THEN
      EXECUTE format('ALTER VIEW %I.%I SET (%s)', r.nsp, r.rel, r.options);
    END IF;
    IF r.comment IS NOT NULL THEN
      EXECUTE format('COMMENT ON VIEW %I.%I IS %L', r.nsp, r.rel, r.comment);
    END IF;
    IF r.grants IS NOT NULL THEN
      EXECUTE r.grants;
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 6. upsert_entity_metadata() without p_show_in_sidebar
-- ============================================================================
-- Different parameter lists are separate overloads, so the old signature is dropped.

DROP FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, BOOLEAN, TEXT, NAME, NAME);

CREATE OR REPLACE FUNCTION public.upsert_entity_metadata(
  p_table_name NAME,
  p_display_name TEXT,
  p_description TEXT,
  p_sort_order INT,
  p_search_fields TEXT[] DEFAULT NULL,
  p_show_map BOOLEAN DEFAULT FALSE,
  p_map_property_name TEXT DEFAULT NULL,
  p_show_calendar BOOLEAN DEFAULT FALSE,
  p_calendar_property_name TEXT DEFAULT NULL,
  p_calendar_color_property TEXT DEFAULT NULL,
  p_enable_notes BOOLEAN DEFAULT FALSE,
  p_supports_recurring BOOLEAN DEFAULT FALSE,
  p_recurring_property_name TEXT DEFAULT NULL,
  p_map_color_property TEXT DEFAULT NULL,
  p_fulltext_search_column NAME DEFAULT NULL,
  p_substring_search_column NAME DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  INSERT INTO metadata.entities (
    table_name, display_name, description, sort_order,
    search_fields, show_map, map_property_name,
    show_calendar, calendar_property_name, calendar_color_property,
    enable_notes, supports_recurring, recurring_property_name,
    map_color_property,
    fulltext_search_column, substring_search_column
  )
  VALUES (
    p_table_name, p_display_name, p_description, p_sort_order,
    p_search_fields, p_show_map, p_map_property_name,
    p_show_calendar, p_calendar_property_name, p_calendar_color_property,
    p_enable_notes, p_supports_recurring, p_recurring_property_name,
    p_map_color_property,
    p_fulltext_search_column, p_substring_search_column
  )
  ON CONFLICT (table_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    search_fields = COALESCE(EXCLUDED.search_fields, metadata.entities.search_fields),
    show_map = EXCLUDED.show_map,
    map_property_name = EXCLUDED.map_property_name,
    show_calendar = EXCLUDED.show_calendar,
    calendar_property_name = EXCLUDED.calendar_property_name,
    calendar_color_property = EXCLUDED.calendar_color_property,
    enable_notes = EXCLUDED.enable_notes,
    supports_recurring = EXCLUDED.supports_recurring,
    recurring_property_name = EXCLUDED.recurring_property_name,
    map_color_property = EXCLUDED.map_color_property,
    fulltext_search_column = COALESCE(EXCLUDED.fulltext_search_column, metadata.entities.fulltext_search_column),
    substring_search_column = COALESCE(EXCLUDED.substring_search_column, metadata.entities.substring_search_column);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_entity_metadata IS
  'Insert or update entity metadata. Admin only. Updated in v0.55.2 to add '
  'fulltext_search_column and substring_search_column for hybrid search. '
  'v0.81.0: p_show_in_sidebar removed; sidebar visibility lives in metadata.menu_nodes.';

REVOKE EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT, NAME, NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT, NAME, NAME) TO authenticated;

-- ============================================================================
-- 7. add_guided_form_step() records a hidden menu node for the step table
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_guided_form_step(
    p_guided_form_key     NAME,
    p_step_key         NAME,
    p_display_name     VARCHAR(100),
    p_step_order       INT,
    p_step_table       NAME,
    p_parent_fk_column NAME,
    p_description      TEXT DEFAULT NULL,
    p_can_skip         BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_guided_form      metadata.guided_forms%ROWTYPE;
    v_gf_col           NAME;
BEGIN
    -- Admin guard: only admins can add guided form steps
    IF NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Admin access required';
    END IF;

    SELECT * INTO v_guided_form FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', format('Guided form %s not found', p_guided_form_key));
    END IF;

    -- Detect or create GF status column on step table. Do NOT rename.
    v_gf_col := public._gf_status_col(p_step_table);
    IF v_gf_col IS NULL THEN
        EXECUTE format(
            'ALTER TABLE public.%I ADD COLUMN status_id INTEGER REFERENCES metadata.statuses(id)',
            p_step_table
        );
        v_gf_col := 'status_id';
    END IF;
    EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT public.get_initial_status(''guided_form'')',
        p_step_table, v_gf_col
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_gf_status_id ON public.%I (%I)', p_step_table, p_step_table, v_gf_col);

    INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
    VALUES (p_step_table, v_gf_col, false, false, false, false)
    ON CONFLICT (table_name, column_name) DO UPDATE
      SET show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;

    INSERT INTO metadata.guided_form_steps (
        guided_form_key, step_key, display_name, description,
        step_table, parent_fk_column, step_order, can_skip
    ) VALUES (
        p_guided_form_key, p_step_key, p_display_name, p_description,
        p_step_table, p_parent_fk_column, p_step_order, p_can_skip
    );

    -- Upgrade FK constraint to ON DELETE CASCADE
    DECLARE
        v_fk_name TEXT;
    BEGIN
        SELECT conname INTO v_fk_name
        FROM pg_constraint
        WHERE conrelid = format('public.%I', p_step_table)::regclass
          AND confrelid = format('public.%I', v_guided_form.parent_table)::regclass
          AND contype = 'f';

        IF v_fk_name IS NOT NULL THEN
            EXECUTE format(
                'ALTER TABLE public.%I DROP CONSTRAINT %I',
                p_step_table, v_fk_name
            );
            EXECUTE format(
                'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE CASCADE',
                p_step_table, v_fk_name, p_parent_fk_column, v_guided_form.parent_table
            );
        END IF;
    END;

    -- Propagate guided_form_key, and hide the step table from the sidebar with a hidden menu node
    -- (an existing node keeps its sort_order and placement; only is_hidden is forced).
    INSERT INTO metadata.entities (table_name, display_name, guided_form_key)
    VALUES (p_step_table, p_display_name, p_guided_form_key)
    ON CONFLICT (table_name) DO UPDATE SET
        guided_form_key = p_guided_form_key;

    INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, sort_order, is_hidden)
    VALUES (
        p_step_table::TEXT, 'entity', p_step_table,
        (SELECT e.sort_order FROM metadata.entities e WHERE e.table_name = p_step_table),
        TRUE
    )
    ON CONFLICT (node_key) DO UPDATE SET is_hidden = TRUE;

    -- Ensure CRUD permission entries exist for the step table.
    INSERT INTO metadata.permissions (table_name, permission)
    SELECT p_step_table, p::metadata.permission
    FROM unnest(ARRAY['create', 'read', 'update', 'delete']) AS p
    ON CONFLICT (table_name, permission) DO NOTHING;

    -- Auto-create RLS policies on step table (inherits parent ownership).
    IF v_guided_form.ownership_column IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_step_table);

        -- === Tier 1: Ownership via parent FK ===
        EXECUTE format(
            'CREATE POLICY gf_child_select ON public.%I FOR SELECT TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_child_insert ON public.%I FOR INSERT TO authenticated '
            'WITH CHECK (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_child_update ON public.%I FOR UPDATE TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_child_delete ON public.%I FOR DELETE TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );

        -- === Tier 2: RBAC per-operation blanket access (inherits parent table permissions) ===
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_select ON public.%I FOR SELECT TO authenticated '
            'USING (public.has_permission(%L, ''read''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_insert ON public.%I FOR INSERT TO authenticated '
            'WITH CHECK (public.has_permission(%L, ''update''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_update ON public.%I FOR UPDATE TO authenticated '
            'USING (public.has_permission(%L, ''update''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_delete ON public.%I FOR DELETE TO authenticated '
            'USING (public.has_permission(%L, ''delete''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );
    END IF;

    RETURN jsonb_build_object('success', true, 'step_key', p_step_key);
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('success', false, 'message', format('Step %s already exists in guided form %s', p_step_key, p_guided_form_key));
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) IS
    'Add a step to a guided form definition with auto child RLS delegation. '
    'SECURITY DEFINER for RLS creation. '
    'v0.81.0: hides the step table with a hidden menu node (metadata.menu_nodes) instead of show_in_sidebar.';

-- ============================================================================
-- 8. public.schema_menu_nodes: the bridge view clients read
-- ============================================================================
-- A definer view on purpose (allowlisted in tests/functional/view-security-guard-test.sh): the menu is
-- public wayfinding data, like statuses, and the base table policy is "everyone can read". Labels go
-- through metadata.t(); the key is <node_key>.display_name. base_display_name is the untranslated label the menu
-- editor edits and saves, so an admin working in another locale never writes a translation back as the base.

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
-- 9. public.save_menu_tree(): replace the whole tree in one transaction
-- ============================================================================
-- p_nodes is a JSON array; each element uses the column names of metadata.menu_nodes (node_key, node_kind,
-- target_key, display_name, icon, parent_node_key, sort_order, is_hidden, collapsed_by_default); other
-- keys are ignored. Parents are inserted before children (ordered by depth); input that names an unknown
-- parent, or contains a cycle, is rejected before anything is written. The BEFORE trigger enforces the rest.
--
-- Dropped targets: a stored entity node whose target has since stopped being an entity (its table or view
-- was dropped, or the view unregistered) would make every later save fail, because the editor sends it
-- back unchanged and the trigger rejects it on re-insert. Such a node is skipped and its children are
-- lifted to its nearest kept ancestor, the rule buildMenu applies when rendering. Only a node stored with
-- the same key and target is skipped: a new node with a bad target still reaches the trigger and raises.
--
-- Returns {"nodes": <count>, "skipped": [<node_key>, ...], "menu_version": <timestamptz>}.

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
    SELECT k.node_key, k.parent_node_key AS cand, 0 AS steps FROM input k WHERE NOT k.skipped
    UNION ALL
    SELECT u.node_key, s.parent_node_key, u.steps + 1
    FROM up u JOIN input s ON s.node_key = u.cand AND s.skipped
    WHERE u.steps < 20
  ), lifted AS (
    SELECT DISTINCT ON (u.node_key) u.node_key, u.cand
    FROM up u
    WHERE NOT EXISTS (SELECT 1 FROM input s WHERE s.node_key = u.cand AND s.skipped)
    ORDER BY u.node_key, u.steps
  )
  SELECT
    -- No lifted row means the chain never left skipped nodes (a cycle): keep the given parent, which is
    -- then missing from the kept set, so the reachability check rejects the node.
    COALESCE((SELECT jsonb_agg(CASE WHEN l.node_key IS NULL THEN to_jsonb(i) - 'skipped'
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
-- 10. schema_cache_versions gains a 'menu' row
-- ============================================================================
-- Stays a definer view (allowlisted in tests/functional/view-security-guard-test.sh).

CREATE OR REPLACE VIEW public.schema_cache_versions AS
SELECT 'entities' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.entities),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permissions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.roles),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permission_roles)
       ) AS version
UNION ALL
SELECT 'properties' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.properties),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.validations)
       ) AS version
UNION ALL
SELECT 'constraint_messages' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.constraint_messages) AS version
UNION ALL
SELECT 'introspection' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_functions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.database_triggers),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.trigger_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.notification_triggers)
       ) AS version
UNION ALL
SELECT 'categories' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.categories),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.category_groups)
       ) AS version
UNION ALL
SELECT 'translations' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.translations) AS version
UNION ALL
SELECT 'profile_extensions' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)
        FROM metadata.user_profile_extensions) AS version
UNION ALL
SELECT 'instance_config' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)
        FROM metadata.instance_config) AS version
UNION ALL
SELECT 'statuses' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.statuses),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.status_types)
       ) AS version
UNION ALL
SELECT 'menu' AS cache_name,
       (SELECT COALESCE(MAX(changed_at), '1970-01-01'::timestamptz) FROM metadata.menu_version) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties,
     constraint_messages, introspection, categories, translations, profile_extensions, instance_config,
     statuses, and menu.';

-- ============================================================================
-- 11. get_translation_defaults() gains the menu_node source
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_translation_defaults()
RETURNS TABLE(source_type TEXT, source_key TEXT, default_text TEXT)
AS $$
BEGIN
  -- Force English locale so VIEWs (schema_entities, schema_properties, statuses,
  -- categories) return untranslated default text via metadata.t() short-circuit.
  -- Uses request.headers JSON blob (PostgREST 13+ format) that current_locale() reads.
  -- This is transaction-local and does not affect other concurrent requests.
  PERFORM set_config('request.headers', '{"accept-language":"en"}', true);

  RETURN QUERY
  -- UI strings from translations table
  SELECT t.source_type::TEXT, t.source_key, t.translated_text
  FROM metadata.translations t
  WHERE t.locale = 'en'

  UNION ALL

  -- Entity display names (from VIEW to include auto-detected entities)
  SELECT 'entity'::TEXT, se.table_name || '.display_name', se.display_name
  FROM public.schema_entities se

  UNION ALL

  -- Entity descriptions
  SELECT 'entity'::TEXT, se.table_name || '.description', se.description
  FROM public.schema_entities se
  WHERE se.description IS NOT NULL

  UNION ALL

  -- Property display names (from VIEW to include auto-detected properties)
  SELECT 'property'::TEXT, sp.table_name || '.' || sp.column_name || '.display_name',
    sp.display_name
  FROM public.schema_properties sp

  UNION ALL

  -- Property descriptions
  SELECT 'property'::TEXT, sp.table_name || '.' || sp.column_name || '.description',
    sp.description
  FROM public.schema_properties sp
  WHERE sp.description IS NOT NULL

  UNION ALL

  -- Status display names (from VIEW for translated defaults)
  SELECT 'status'::TEXT, s.entity_type || '.' || s.status_key || '.display_name',
    s.display_name
  FROM public.statuses s

  UNION ALL

  -- Status descriptions
  SELECT 'status'::TEXT, s.entity_type || '.' || s.status_key || '.description',
    s.description
  FROM public.statuses s
  WHERE s.description IS NOT NULL

  UNION ALL

  -- Category display names (from VIEW for translated defaults)
  SELECT 'category'::TEXT, c.entity_type || '.' || c.category_key || '.display_name',
    c.display_name
  FROM public.categories c

  UNION ALL

  -- Category descriptions
  SELECT 'category'::TEXT, c.entity_type || '.' || c.category_key || '.description',
    c.description
  FROM public.categories c
  WHERE c.description IS NOT NULL

  UNION ALL

  -- Entity action display names
  SELECT 'action'::TEXT, ea.table_name::TEXT || '.' || ea.action_name || '.display_name',
    ea.display_name
  FROM metadata.entity_actions ea

  UNION ALL

  -- Entity action descriptions
  SELECT 'action'::TEXT, ea.table_name::TEXT || '.' || ea.action_name || '.description',
    ea.description
  FROM metadata.entity_actions ea
  WHERE ea.description IS NOT NULL

  UNION ALL

  -- Entity action confirmation messages
  SELECT 'action'::TEXT, ea.table_name::TEXT || '.' || ea.action_name || '.confirmation_message',
    ea.confirmation_message
  FROM metadata.entity_actions ea
  WHERE ea.confirmation_message IS NOT NULL

  UNION ALL

  -- Entity action disabled tooltips
  SELECT 'action'::TEXT, ea.table_name::TEXT || '.' || ea.action_name || '.disabled_tooltip',
    ea.disabled_tooltip
  FROM metadata.entity_actions ea
  WHERE ea.disabled_tooltip IS NOT NULL

  UNION ALL

  -- Entity action success messages
  SELECT 'action'::TEXT, ea.table_name::TEXT || '.' || ea.action_name || '.success_message',
    ea.default_success_message
  FROM metadata.entity_actions ea
  WHERE ea.default_success_message IS NOT NULL

  UNION ALL

  -- Action param display names (JOIN to resolve table_name + action_name)
  SELECT 'action_param'::TEXT,
    ea.table_name::TEXT || '.' || ea.action_name || '.' || p.param_name || '.display_name',
    p.display_name
  FROM metadata.entity_action_params p
  JOIN metadata.entity_actions ea ON ea.id = p.entity_action_id

  UNION ALL

  -- Action param placeholders
  SELECT 'action_param'::TEXT,
    ea.table_name::TEXT || '.' || ea.action_name || '.' || p.param_name || '.placeholder',
    p.placeholder
  FROM metadata.entity_action_params p
  JOIN metadata.entity_actions ea ON ea.id = p.entity_action_id
  WHERE p.placeholder IS NOT NULL

  UNION ALL

  -- Guided form step display names
  SELECT 'guided_form_step'::TEXT,
    gfs.guided_form_key::TEXT || '.' || gfs.step_key::TEXT || '.display_name',
    gfs.display_name
  FROM metadata.guided_form_steps gfs

  UNION ALL

  -- Guided form step descriptions
  SELECT 'guided_form_step'::TEXT,
    gfs.guided_form_key::TEXT || '.' || gfs.step_key::TEXT || '.description',
    gfs.description
  FROM metadata.guided_form_steps gfs
  WHERE gfs.description IS NOT NULL

  UNION ALL

  -- Static text content
  SELECT 'static_text'::TEXT, st.table_name::TEXT || '.' || st.id::TEXT, st.content
  FROM metadata.static_text st

  UNION ALL

  -- Dashboard display names
  SELECT 'dashboard'::TEXT, 'dashboard.' || d.id::TEXT || '.display_name',
    d.display_name::TEXT
  FROM metadata.dashboards d

  UNION ALL

  -- Dashboard descriptions
  SELECT 'dashboard'::TEXT, 'dashboard.' || d.id::TEXT || '.description',
    d.description
  FROM metadata.dashboards d
  WHERE d.description IS NOT NULL

  UNION ALL

  -- Dashboard widget titles
  SELECT 'dashboard'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.title',
    w.title
  FROM metadata.dashboard_widgets w
  WHERE w.title IS NOT NULL

  UNION ALL

  -- Widget config: markdown content
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.content',
    w.config->>'content'
  FROM metadata.dashboard_widgets w
  WHERE w.widget_type = 'markdown' AND w.config ? 'content'

  UNION ALL

  -- Widget config: nav_buttons header
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.header',
    w.config->>'header'
  FROM metadata.dashboard_widgets w
  WHERE w.widget_type = 'nav_buttons' AND w.config ? 'header'

  UNION ALL

  -- Widget config: nav_buttons description
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.description',
    w.config->>'description'
  FROM metadata.dashboard_widgets w
  WHERE w.widget_type = 'nav_buttons' AND w.config ? 'description'

  UNION ALL

  -- Widget config: nav_buttons button text
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.buttons.' || (idx - 1)::TEXT || '.text',
    btn->>'text'
  FROM metadata.dashboard_widgets w,
    jsonb_array_elements(w.config->'buttons') WITH ORDINALITY AS t(btn, idx)
  WHERE w.widget_type = 'nav_buttons' AND w.config ? 'buttons' AND btn ? 'text'

  UNION ALL

  -- Widget config: dashboard_navigation backward text
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.backward.text',
    w.config #>> '{backward,text}'
  FROM metadata.dashboard_widgets w
  WHERE w.widget_type = 'dashboard_navigation' AND w.config #> '{backward,text}' IS NOT NULL

  UNION ALL

  -- Widget config: dashboard_navigation forward text
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.forward.text',
    w.config #>> '{forward,text}'
  FROM metadata.dashboard_widgets w
  WHERE w.widget_type = 'dashboard_navigation' AND w.config #> '{forward,text}' IS NOT NULL

  UNION ALL

  -- Widget config: dashboard_navigation chips text
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.chips.' || (idx - 1)::TEXT || '.text',
    chip->>'text'
  FROM metadata.dashboard_widgets w,
    jsonb_array_elements(w.config->'chips') WITH ORDINALITY AS t(chip, idx)
  WHERE w.widget_type = 'dashboard_navigation' AND w.config ? 'chips' AND chip ? 'text'

  UNION ALL

  -- Menu node labels (headings, and entity nodes that override the entity name)
  SELECT 'menu_node'::TEXT, n.node_key || '.display_name', n.display_name
  FROM metadata.menu_nodes n
  WHERE n.display_name IS NOT NULL
  ;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION public.get_translation_defaults() IS
  'Returns English default text for all translatable keys. UI strings from metadata.translations, instance metadata from source tables. Used by Translation Admin page.';

GRANT EXECUTE ON FUNCTION public.get_translation_defaults() TO web_anon, authenticated;

COMMIT;
