-- Revert civic_os:v0-80-0-widget-key-filters
--
-- Restores schema_cache_versions without the statuses row and get_categories_for_entity()
-- without category_key, with their comments and grants.

BEGIN;

DROP FUNCTION public.get_categories_for_entity(TEXT);

CREATE FUNCTION public.get_categories_for_entity(p_entity_type TEXT)
RETURNS TABLE (
  id INT,
  display_name VARCHAR(50),
  description TEXT,
  color hex_color,
  sort_order INT
)
LANGUAGE SQL
STABLE
AS $$
  SELECT id, display_name::VARCHAR(50), description, color, sort_order
  FROM public.categories
  WHERE entity_type = p_entity_type
  ORDER BY sort_order, display_name;
$$;

COMMENT ON FUNCTION public.get_categories_for_entity(TEXT) IS
  'Returns all category values for a given entity_type, ordered by sort_order.
   Used by frontend to populate category dropdowns.
   Example: SELECT * FROM get_categories_for_entity(''time_entry'');';

-- The previous function kept PUBLIC EXECUTE: it is on the anonymous allowlist of v0-76-5, and the
-- default privileges from that change would otherwise leave the re-created function without it.
GRANT EXECUTE ON FUNCTION public.get_categories_for_entity(TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_categories_for_entity(TEXT) TO web_anon, authenticated;

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
        FROM metadata.instance_config) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties,
     constraint_messages, introspection, categories, translations, profile_extensions, and instance_config.';

-- Delete only rows still holding the seeded text. A row an integrator customized stays.
DELETE FROM metadata.translations t
USING (VALUES
  ('dashboard.filter_unknown_key', 'en', 'This widget filters on "{{key}}", which does not exist for {{column}}.'),
  ('dashboard.filter_unknown_key', 'es', 'Este widget filtra por "{{key}}", que no existe para {{column}}.'),
  ('dashboard.filter_unknown_key', 'ar', 'تعتمد هذه الأداة في التصفية على "{{key}}"، وهي قيمة غير موجودة في {{column}}.'),
  ('dashboard.filter_unknown_key', 'fr', 'Ce widget filtre sur « {{key}} », qui n''existe pas pour {{column}}.'),
  ('dashboard.filter_unknown_key', 'de', 'Dieses Widget filtert nach "{{key}}", das für {{column}} nicht existiert.'),
  ('dashboard.filter_unknown_key', 'ps', 'دا ویجټ د "{{key}}" له مخې چاڼ کوي، چې د {{column}} لپاره شتون نه لري.'),
  ('dashboard.filter_invalid', 'en', 'This widget has an invalid filter on {{column}}.'),
  ('dashboard.filter_invalid', 'es', 'Este widget tiene un filtro no válido en {{column}}.'),
  ('dashboard.filter_invalid', 'ar', 'تحتوي هذه الأداة على عامل تصفية غير صالح في {{column}}.'),
  ('dashboard.filter_invalid', 'fr', 'Ce widget a un filtre non valide sur {{column}}.'),
  ('dashboard.filter_invalid', 'de', 'Dieses Widget hat einen ungültigen Filter für {{column}}.'),
  ('dashboard.filter_invalid', 'ps', 'دا ویجټ په {{column}} کې ناسم چاڼګر لري.'),
  ('dashboard.filter_unavailable', 'en', 'The filter values for {{column}} could not be loaded. Reload the page to try again.'),
  ('dashboard.filter_unavailable', 'es', 'No se pudieron cargar los valores de filtro de {{column}}. Recargue la página para volver a intentarlo.'),
  ('dashboard.filter_unavailable', 'ar', 'تعذر تحميل قيم التصفية لـ {{column}}. أعد تحميل الصفحة للمحاولة مرة أخرى.'),
  ('dashboard.filter_unavailable', 'fr', 'Les valeurs de filtre pour {{column}} n''ont pas pu être chargées. Rechargez la page pour réessayer.'),
  ('dashboard.filter_unavailable', 'de', 'Die Filterwerte für {{column}} konnten nicht geladen werden. Laden Sie die Seite neu, um es erneut zu versuchen.'),
  ('dashboard.filter_unavailable', 'ps', 'د {{column}} لپاره د چاڼ ارزښتونه پورته نشول. د بیا هڅې لپاره پاڼه بیا پورته کړئ.')
) AS seeded(source_key, locale, translated_text)
WHERE t.source_type = 'ui'
  AND t.source_key = seeded.source_key
  AND t.locale = seeded.locale
  AND t.translated_text = seeded.translated_text;

NOTIFY pgrst, 'reload schema';

COMMIT;
