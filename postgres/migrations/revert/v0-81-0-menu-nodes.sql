-- Revert civic_os:v0-81-0-menu-nodes
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Restores metadata.entities.show_in_sidebar and the pre-v0.81.0 objects (schema_entities, its dependents,
-- upsert_entity_metadata with p_show_in_sidebar, add_guided_form_step, schema_cache_versions,
-- get_translation_defaults), then drops the menu objects.
--
-- Lossy by design: the tree flattens. Every eligible entity (schema_entities) gets sort_order = rank * 10,
-- where rank is its position in the depth-first menu order (siblings by COALESCE(sort_order, 0), then key;
-- at the root, the entities without a node follow the root nodes), and show_in_sidebar = FALSE when its node or any ancestor
-- is hidden. Entities without a metadata.entities row get one. Headings, nesting, labels, icons and
-- collapsed flags are lost. Menu translations in metadata.translations are deleted.

BEGIN;

-- The restored bodies below are catalog output with unqualified names (entities, t(), has_permission()),
-- so pin the v0.32.0 database search_path in case the migrating role overrides it.
SET LOCAL search_path = public, metadata, plugins, postgis;

-- 1. Restore the column (v0.48.0 shape) and write the flattened menu into it.
ALTER TABLE metadata.entities ADD COLUMN show_in_sidebar BOOLEAN NOT NULL DEFAULT TRUE;
COMMENT ON COLUMN metadata.entities.show_in_sidebar IS
    'When FALSE, entity is hidden from sidebar navigation. Step tables are auto-hidden. Added in v0.48.0.';

-- Every eligible entity takes part: the nodes, plus the entities without a node, which the menu lists after
-- the root nodes by (sort_order, table_name). A hidden entity node at the root has no place in the menu, so
-- it ranks with the entities without a node, by its entity's sort_order: the general entity order (Detail
-- related sections, MCP) keeps its relative position. Siblings are numbered by (group, COALESCE(sort_order, 0),
-- key) with the key in "C" order, as schema_entities orders table_name (a name, so "C"); the depth-first walk
-- then orders by the path of those numbers. Entities without a metadata.entities row get one, so the flat
-- order holds for them too.
WITH RECURSIVE eligible AS (
  SELECT se.table_name::TEXT AS table_name, se.sort_order FROM public.schema_entities se
), items AS (
  SELECT n.node_key AS item_key, n.parent_node_key, n.node_kind, n.target_key::TEXT AS target_key,
         CASE WHEN r.unplaced THEN e.sort_order ELSE n.sort_order END AS sort_order,
         n.is_hidden, CASE WHEN r.unplaced THEN 1 ELSE 0 END AS grp
  FROM metadata.menu_nodes n
  LEFT JOIN eligible e ON e.table_name = n.target_key::TEXT
  CROSS JOIN LATERAL (SELECT n.parent_node_key IS NULL AND n.node_kind = 'entity' AND n.is_hidden AS unplaced) r
  UNION ALL
  SELECT e.table_name, NULL, 'entity', e.table_name, e.sort_order, FALSE, 1
  FROM eligible e
  WHERE NOT EXISTS (SELECT 1 FROM metadata.menu_nodes n WHERE n.node_kind = 'entity' AND n.target_key = e.table_name)
), numbered AS (
  SELECT i.*, row_number() OVER (
           PARTITION BY i.parent_node_key ORDER BY i.grp, COALESCE(i.sort_order, 0), i.item_key COLLATE "C") AS pos
  FROM items i
), walk AS (
  SELECT u.item_key, u.node_kind, u.target_key, u.is_hidden, ARRAY[u.pos] AS path
  FROM numbered u
  WHERE u.parent_node_key IS NULL
  UNION ALL
  SELECT u.item_key, u.node_kind, u.target_key, (w.is_hidden OR u.is_hidden), w.path || u.pos
  FROM numbered u
  JOIN walk w ON u.parent_node_key = w.item_key
), ranked AS (
  SELECT w.target_key, w.is_hidden, row_number() OVER (ORDER BY w.path) AS rnk
  FROM walk w
  WHERE w.node_kind = 'entity' AND EXISTS (SELECT 1 FROM eligible e WHERE e.table_name = w.target_key)
)
INSERT INTO metadata.entities (table_name, sort_order, show_in_sidebar)
SELECT r.target_key::NAME, (r.rnk * 10)::INT, NOT r.is_hidden
FROM ranked r
ON CONFLICT (table_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order,
      show_in_sidebar = EXCLUDED.show_in_sidebar;

-- 2. Drop the menu objects (the entity-node validation trigger reads schema_entities, so the table goes first).
DROP FUNCTION public.save_menu_tree(JSONB);
DROP VIEW public.schema_menu_nodes;
DROP TABLE metadata.menu_nodes;
DROP FUNCTION metadata.menu_nodes_validate();
DROP FUNCTION metadata.menu_nodes_stamp_version();

DELETE FROM metadata.translations WHERE source_type = 'menu_node';

-- 3. Drop and rebuild public.schema_entities with its dependents.
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
    RAISE EXCEPTION 'A materialized view depends on public.schema_entities; drop it before this revert';
  END IF;
  FOR r IN SELECT * FROM _menu_dependent_views ORDER BY lvl DESC, nsp, rel LOOP
    EXECUTE format('DROP VIEW %I.%I', r.nsp, r.rel);
  END LOOP;
END $$;

DROP VIEW public.schema_entities;

CREATE VIEW public.schema_entities AS
SELECT t('entity'::text, ((tables.table_name)::text || '.display_name'::text), COALESCE(entities.display_name, (tables.table_name)::text)) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    t('entity'::text, ((tables.table_name)::text || '.description'::text), entities.description) AS description,
    entities.search_fields,
    COALESCE(entities.show_map, false) AS show_map,
    entities.map_property_name,
    tables.table_name,
    has_permission((tables.table_name)::text, 'create'::text) AS insert,
    has_permission((tables.table_name)::text, 'read'::text) AS "select",
    has_permission((tables.table_name)::text, 'update'::text) AS update,
    has_permission((tables.table_name)::text, 'delete'::text) AS delete,
    COALESCE(entities.show_calendar, false) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    COALESCE(entities.enable_notes, false) AS enable_notes,
    COALESCE(entities.supports_recurring, false) AS supports_recurring,
    entities.recurring_property_name,
    ((tables.table_type)::text = 'VIEW'::text) AS is_view,
    entities.guided_form_key,
    COALESCE(entities.show_in_sidebar, true) AS show_in_sidebar,
    entities.map_color_property,
    COALESCE(entities.is_rich_junction, false) AS is_rich_junction,
    entities.fulltext_search_column,
    entities.substring_search_column
   FROM (information_schema.tables
     LEFT JOIN entities ON ((entities.table_name = (tables.table_name)::name)))
  WHERE (((tables.table_schema)::name = 'public'::name) AND ((tables.table_type)::text = ANY (ARRAY['BASE TABLE'::text, 'VIEW'::text])) AND (((tables.table_type)::text = 'BASE TABLE'::text) OR (entities.table_name IS NOT NULL)) AND (NOT (((tables.table_type)::text = 'VIEW'::text) AND (((tables.table_name)::text ~~ 'schema_%'::text) OR ((tables.table_name)::text = ANY (ARRAY['time_slot_series'::text, 'time_slot_instances'::text, 'civic_os_users'::text, 'managed_users'::text, 'gallery_admin'::text, 'photo_galleries'::text, 'photo_gallery_files'::text, 'photo_gallery_config'::text]))))))
  ORDER BY COALESCE(entities.sort_order, 0), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
  'Entity metadata view. Updated in v0.58.0 to wrap display_name and description with metadata.t() for multi-language support.';

GRANT SELECT ON public.schema_entities TO web_anon, authenticated;

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

-- 4. upsert_entity_metadata with p_show_in_sidebar
DROP FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT, NAME, NAME);

CREATE OR REPLACE FUNCTION public.upsert_entity_metadata(p_table_name name, p_display_name text, p_description text, p_sort_order integer, p_search_fields text[] DEFAULT NULL::text[], p_show_map boolean DEFAULT false, p_map_property_name text DEFAULT NULL::text, p_show_calendar boolean DEFAULT false, p_calendar_property_name text DEFAULT NULL::text, p_calendar_color_property text DEFAULT NULL::text, p_enable_notes boolean DEFAULT false, p_supports_recurring boolean DEFAULT false, p_recurring_property_name text DEFAULT NULL::text, p_show_in_sidebar boolean DEFAULT true, p_map_color_property text DEFAULT NULL::text, p_fulltext_search_column name DEFAULT NULL::name, p_substring_search_column name DEFAULT NULL::name)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  INSERT INTO metadata.entities (
    table_name, display_name, description, sort_order,
    search_fields, show_map, map_property_name,
    show_calendar, calendar_property_name, calendar_color_property,
    enable_notes, supports_recurring, recurring_property_name,
    show_in_sidebar, map_color_property,
    fulltext_search_column, substring_search_column
  )
  VALUES (
    p_table_name, p_display_name, p_description, p_sort_order,
    p_search_fields, p_show_map, p_map_property_name,
    p_show_calendar, p_calendar_property_name, p_calendar_color_property,
    p_enable_notes, p_supports_recurring, p_recurring_property_name,
    p_show_in_sidebar, p_map_color_property,
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
    show_in_sidebar = EXCLUDED.show_in_sidebar,
    map_color_property = EXCLUDED.map_color_property,
    fulltext_search_column = COALESCE(EXCLUDED.fulltext_search_column, metadata.entities.fulltext_search_column),
    substring_search_column = COALESCE(EXCLUDED.substring_search_column, metadata.entities.substring_search_column);
END;
$function$;

COMMENT ON FUNCTION public.upsert_entity_metadata IS
  'Insert or update entity metadata. Admin only. Updated in v0.55.2 to add '
  'fulltext_search_column and substring_search_column for hybrid search.';

REVOKE EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, BOOLEAN, TEXT, NAME, NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, BOOLEAN, TEXT, NAME, NAME) TO authenticated;

-- 5. add_guided_form_step (v0.56.1 body)
CREATE OR REPLACE FUNCTION public.add_guided_form_step(p_guided_form_key name, p_step_key name, p_display_name character varying, p_step_order integer, p_step_table name, p_parent_fk_column name, p_description text DEFAULT NULL::text, p_can_skip boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'metadata', 'public', 'pg_catalog'
AS $function$
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

    -- Hide step table from sidebar and propagate guided_form_key
    INSERT INTO metadata.entities (table_name, display_name, show_in_sidebar, guided_form_key)
    VALUES (p_step_table, p_display_name, FALSE, p_guided_form_key)
    ON CONFLICT (table_name) DO UPDATE SET
        show_in_sidebar = FALSE,
        guided_form_key = p_guided_form_key;

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
$function$;

REVOKE EXECUTE ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) IS
    'Add a step to a guided form definition with auto child RLS delegation. '
    'SECURITY DEFINER for RLS creation. '
    'v0.56.1: use metadata._is_db_admin() for managed DB compatibility.';

-- 6. schema_cache_versions without the menu row
CREATE OR REPLACE VIEW public.schema_cache_versions AS
SELECT 'entities'::text AS cache_name,
    GREATEST(( SELECT COALESCE(max(entities.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM entities), ( SELECT COALESCE(max(permissions.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM permissions), ( SELECT COALESCE(max(roles.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM roles), ( SELECT COALESCE(max(permission_roles.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM permission_roles)) AS version
UNION ALL
 SELECT 'properties'::text AS cache_name,
    GREATEST(( SELECT COALESCE(max(properties.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM properties), ( SELECT COALESCE(max(validations.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM validations)) AS version
UNION ALL
 SELECT 'constraint_messages'::text AS cache_name,
    ( SELECT COALESCE(max(constraint_messages.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.constraint_messages) AS version
UNION ALL
 SELECT 'introspection'::text AS cache_name,
    GREATEST(( SELECT COALESCE(max(rpc_functions.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM rpc_functions), ( SELECT COALESCE(max(database_triggers.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM database_triggers), ( SELECT COALESCE(max(rpc_entity_effects.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM rpc_entity_effects), ( SELECT COALESCE(max(trigger_entity_effects.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM trigger_entity_effects), ( SELECT COALESCE(max(notification_triggers.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM notification_triggers)) AS version
UNION ALL
 SELECT 'categories'::text AS cache_name,
    GREATEST(( SELECT COALESCE(max(categories.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.categories), ( SELECT COALESCE(max(category_groups.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM category_groups)) AS version
UNION ALL
 SELECT 'translations'::text AS cache_name,
    ( SELECT COALESCE(max(translations.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.translations) AS version
UNION ALL
 SELECT 'profile_extensions'::text AS cache_name,
    ( SELECT COALESCE(max(user_profile_extensions.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.user_profile_extensions) AS version
UNION ALL
 SELECT 'instance_config'::text AS cache_name,
    ( SELECT COALESCE(max(instance_config.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.instance_config) AS version
UNION ALL
 SELECT 'statuses'::text AS cache_name,
    GREATEST(( SELECT COALESCE(max(statuses.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.statuses), ( SELECT COALESCE(max(status_types.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM status_types)) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties,
     constraint_messages, introspection, categories, translations, profile_extensions, instance_config,
     and statuses.';

-- 6b. Nothing reads the menu version any more.
DROP TABLE metadata.menu_version;

-- 7. get_translation_defaults without the menu_node source
CREATE OR REPLACE FUNCTION public.get_translation_defaults()
 RETURNS TABLE(source_type text, source_key text, default_text text)
 LANGUAGE plpgsql
 STABLE
AS $function$
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
  ;
END;
$function$;

COMMENT ON FUNCTION public.get_translation_defaults() IS
  'Returns English default text for all translatable keys. UI strings from metadata.translations, instance metadata from source tables. Used by Translation Admin page.';

GRANT EXECUTE ON FUNCTION public.get_translation_defaults() TO web_anon, authenticated;

COMMIT;
