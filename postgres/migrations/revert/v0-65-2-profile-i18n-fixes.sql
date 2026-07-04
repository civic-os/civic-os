-- Revert civic_os:v0-65-2-profile-i18n-fixes from pg

BEGIN;

-- ============================================================================
-- 1. RESTORE RPCs (v0.65.0 versions with information_schema FK discovery)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_user_profile_extensions()
RETURNS TABLE (
  table_name NAME,
  sort_order INT,
  is_required BOOLEAN,
  display_name TEXT,
  description TEXT,
  user_fk_column NAME,
  has_record BOOLEAN
) AS $$
DECLARE
  v_user_id UUID;
  v_ext RECORD;
  v_fk_col NAME;
  v_has BOOLEAN;
BEGIN
  v_user_id := public.current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  FOR v_ext IN
    SELECT e.table_name AS tbl, e.sort_order, e.is_required,
           COALESCE(e.display_name, ent.display_name, e.table_name::TEXT) AS disp_name,
           e.description
    FROM metadata.user_profile_extensions e
    LEFT JOIN metadata.entities ent ON ent.table_name = e.table_name
    ORDER BY e.sort_order, e.table_name
  LOOP
    SELECT kcu.column_name INTO v_fk_col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = v_ext.tbl::TEXT
      AND ccu.table_name = 'civic_os_users'
    LIMIT 1;

    IF v_fk_col IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I = $1)',
      v_ext.tbl, v_fk_col
    ) INTO v_has USING v_user_id;

    table_name := v_ext.tbl;
    sort_order := v_ext.sort_order;
    is_required := v_ext.is_required;
    display_name := v_ext.disp_name;
    description := v_ext.description;
    user_fk_column := v_fk_col;
    has_record := v_has;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


CREATE OR REPLACE FUNCTION public.get_user_profile_extensions_admin(p_user_id UUID)
RETURNS TABLE (
  table_name NAME,
  sort_order INT,
  is_required BOOLEAN,
  display_name TEXT,
  description TEXT,
  user_fk_column NAME,
  has_record BOOLEAN
) AS $$
DECLARE
  v_ext RECORD;
  v_fk_col NAME;
  v_has BOOLEAN;
BEGIN
  IF NOT public.has_permission('civic_os_users_private', 'update') THEN
    RAISE EXCEPTION 'Permission denied: requires civic_os_users_private:update';
  END IF;

  FOR v_ext IN
    SELECT e.table_name AS tbl, e.sort_order, e.is_required,
           COALESCE(e.display_name, ent.display_name, e.table_name::TEXT) AS disp_name,
           e.description
    FROM metadata.user_profile_extensions e
    LEFT JOIN metadata.entities ent ON ent.table_name = e.table_name
    ORDER BY e.sort_order, e.table_name
  LOOP
    SELECT kcu.column_name INTO v_fk_col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = v_ext.tbl::TEXT
      AND ccu.table_name = 'civic_os_users'
    LIMIT 1;

    IF v_fk_col IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I = $1)',
      v_ext.tbl, v_fk_col
    ) INTO v_has USING p_user_id;

    table_name := v_ext.tbl;
    sort_order := v_ext.sort_order;
    is_required := v_ext.is_required;
    display_name := v_ext.disp_name;
    description := v_ext.description;
    user_fk_column := v_fk_col;
    has_record := v_has;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- ============================================================================
-- 2. DROP set_updated_at TRIGGER + user_fk_constraint COLUMN
-- ============================================================================
-- Must drop the VIEW first since it references user_fk_constraint

DROP VIEW IF EXISTS public.user_profile_extensions;
DROP TRIGGER IF EXISTS set_updated_at_trigger ON metadata.user_profile_extensions;
ALTER TABLE metadata.user_profile_extensions DROP COLUMN IF EXISTS user_fk_constraint;


-- ============================================================================
-- 3. RESTORE ORIGINAL user_profile_extensions VIEW (v0.65.0 pass-through)
-- ============================================================================

DROP VIEW IF EXISTS public.user_profile_extensions;

CREATE VIEW public.user_profile_extensions AS
SELECT id, table_name, sort_order, is_required, display_name, description,
       user_fk_column, created_at, updated_at
FROM metadata.user_profile_extensions;

ALTER VIEW public.user_profile_extensions SET (security_invoker = true);
GRANT SELECT ON public.user_profile_extensions TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.user_profile_extensions TO authenticated;


-- ============================================================================
-- 4. RESTORE schema_cache_versions VIEW (without profile_extensions)
-- ============================================================================

DROP VIEW IF EXISTS public.schema_cache_versions;

CREATE VIEW public.schema_cache_versions AS
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
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.translations) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties,
     constraint_messages, introspection, categories, and translations.';

GRANT SELECT ON public.schema_cache_versions TO authenticated, web_anon;


-- ============================================================================
-- 5. REVERT TRANSLATION SEEDS
-- ============================================================================

DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key IN ('profile.language', 'profile.user_profile', 'profile.user_not_found');


-- ============================================================================
-- 6. REVERT civic_os_users VIEW (remove first_name, last_name)
-- ============================================================================

DROP VIEW public.civic_os_users;

CREATE VIEW public.civic_os_users AS
SELECT
  u.id,
  u.display_name,
  u.created_at,
  u.updated_at,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.display_name
    ELSE NULL
  END AS full_name,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.email
    ELSE NULL
  END AS email,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.phone
    ELSE NULL
  END AS phone,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.locale
    ELSE NULL
  END AS locale,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN to_tsvector('english',
      COALESCE(u.display_name, '') || ' ' ||
      COALESCE(p.display_name, '') || ' ' ||
      COALESCE(replace(replace(p.email::text, '@', ' '), '.', ' '), '') || ' ' ||
      CASE WHEN p.phone IS NOT NULL
           THEN phone_search_tokens(p.phone)
           ELSE '' END)
    ELSE to_tsvector('english', COALESCE(u.display_name, ''))
  END AS civic_os_text_search
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id;

ALTER VIEW public.civic_os_users SET (security_invoker = true);
GRANT SELECT ON public.civic_os_users TO web_anon, authenticated;

COMMIT;
