-- Deploy civic_os:v0-80-0-widget-key-filters
-- Requires: v0-79-0-instance-config-translations
--
-- v0.80.0 -- Support for dashboard widget filters that name a Status or Category by its key.
--   1. schema_cache_versions gains a `statuses` row, so a client's cached status values are
--      invalidated when metadata.statuses or metadata.status_types change. `categories` already
--      had a row. MAX(updated_at) cannot see a delete; a status or category referenced by a record
--      cannot be deleted, so a stale id filters to the same empty result.
--   2. get_categories_for_entity() returns category_key, as get_statuses_for_entity() returns
--      status_key. The return type changes, so the function is dropped and re-created.

BEGIN;

-- ============================================================================
-- 1. ADD statuses TO schema_cache_versions
-- ============================================================================
-- Stays a definer view: API roles cannot reach the metadata schema (see the allowlist in
-- tests/functional/view-security-guard-test.sh).

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
       ) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties,
     constraint_messages, introspection, categories, translations, profile_extensions, instance_config,
     and statuses.';


-- ============================================================================
-- 2. RETURN category_key FROM get_categories_for_entity()
-- ============================================================================

DROP FUNCTION public.get_categories_for_entity(TEXT);

CREATE FUNCTION public.get_categories_for_entity(p_entity_type TEXT)
RETURNS TABLE (
  id INT,
  display_name VARCHAR(50),
  description TEXT,
  color hex_color,
  sort_order INT,
  category_key VARCHAR(50)
)
LANGUAGE SQL
STABLE
AS $$
  SELECT id, display_name::VARCHAR(50), description, color, sort_order, category_key
  FROM public.categories
  WHERE entity_type = p_entity_type
  ORDER BY sort_order, display_name;
$$;

COMMENT ON FUNCTION public.get_categories_for_entity(TEXT) IS
  'Returns all category values for a given entity_type, ordered by sort_order.
   Used by frontend to populate category dropdowns.
   Example: SELECT * FROM get_categories_for_entity(''time_entry'');';

REVOKE EXECUTE ON FUNCTION public.get_categories_for_entity(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_categories_for_entity(TEXT) TO web_anon, authenticated;

-- Reload PostgREST schema cache so the new return shape is served
NOTIFY pgrst, 'reload schema';

COMMIT;
