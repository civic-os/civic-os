-- Deploy civic_os:v0-65-2-profile-i18n-fixes
-- Requires: v0-65-1-auth-route-translations
--
-- v0.65.2 — Profile extension refactor: VIEW + PostgREST pattern
--   1. Add user_fk_constraint column + set_updated_at trigger
--   2. Replace user_profile_extensions VIEW with i18n, entities JOIN,
--      and computed FK constraint name for PostgREST embedding hints
--   3. Add profile_extensions to schema_cache_versions
--   4. Drop SECURITY DEFINER RPCs (replaced by VIEW + PostgREST embedding)
--   5. Seed missing translation keys
--   6. Add first_name, last_name to civic_os_users VIEW

BEGIN;

-- ============================================================================
-- 1. ADD user_fk_constraint COLUMN + set_updated_at TRIGGER
-- ============================================================================
-- Nullable column: if NULL, VIEW computes default from PostgreSQL convention
-- {table_name}_{user_fk_column}_fkey. Integrators can override for
-- non-standard FK constraint names.

ALTER TABLE metadata.user_profile_extensions
  ADD COLUMN IF NOT EXISTS user_fk_constraint NAME;

COMMENT ON COLUMN metadata.user_profile_extensions.user_fk_constraint IS
    'Optional: explicit FK constraint name for PostgREST embedding hints.
     If NULL, defaults to {table_name}_{user_fk_column}_fkey (PostgreSQL convention).
     Override when the FK constraint has a custom name.';

-- Ensure updated_at is bumped on changes (drives schema_cache_versions)
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.user_profile_extensions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 2. UPDATE user_profile_extensions VIEW
-- ============================================================================
-- Replaces the pass-through VIEW with one that:
--   - Wraps display_name/description with metadata.t() for i18n
--   - JOINs metadata.entities for fallback display_name
--   - Computes user_fk_constraint with COALESCE default
--   - Removes id, created_at, updated_at (metadata, not needed by frontend)

DROP VIEW IF EXISTS public.user_profile_extensions;

CREATE VIEW public.user_profile_extensions AS
SELECT
  e.table_name,
  e.sort_order,
  e.is_required,
  metadata.t('entity', e.table_name::TEXT || '.display_name',
    COALESCE(e.display_name, ent.display_name, e.table_name::TEXT)) AS display_name,
  metadata.t('entity', e.table_name::TEXT || '.description',
    e.description) AS description,
  e.user_fk_column,
  COALESCE(e.user_fk_constraint,
    e.table_name || '_' || e.user_fk_column || '_fkey') AS user_fk_constraint
FROM metadata.user_profile_extensions e
LEFT JOIN metadata.entities ent ON ent.table_name = e.table_name
ORDER BY e.sort_order, e.table_name;

ALTER VIEW public.user_profile_extensions SET (security_invoker = true);
GRANT SELECT ON public.user_profile_extensions TO web_anon, authenticated;


-- ============================================================================
-- 3. ADD profile_extensions TO schema_cache_versions
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
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.translations) AS version
UNION ALL
SELECT 'profile_extensions' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)
        FROM metadata.user_profile_extensions) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties,
     constraint_messages, introspection, categories, translations, and profile_extensions.';

GRANT SELECT ON public.schema_cache_versions TO authenticated, web_anon;


-- ============================================================================
-- 4. DROP SECURITY DEFINER RPCs
-- ============================================================================
-- Replaced by VIEW (metadata) + PostgREST resource embedding (has_record).
-- The RPCs used SECURITY DEFINER which bypassed RLS for has_record checks.
-- The new pattern uses the caller's permissions naturally.

DROP FUNCTION IF EXISTS public.get_user_profile_extensions();
DROP FUNCTION IF EXISTS public.get_user_profile_extensions_admin(UUID);


-- ============================================================================
-- 5. SEED MISSING TRANSLATION KEYS
-- ============================================================================

-- English
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.language', 'en', 'Language'),
('ui', 'profile.user_profile', 'en', 'User Profile'),
('ui', 'profile.user_not_found', 'en', 'User not found')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Spanish
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.language', 'es', 'Idioma'),
('ui', 'profile.user_profile', 'es', 'Perfil de Usuario'),
('ui', 'profile.user_not_found', 'es', 'Usuario no encontrado')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Arabic
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.language', 'ar', 'اللغة'),
('ui', 'profile.user_profile', 'ar', 'ملف المستخدم'),
('ui', 'profile.user_not_found', 'ar', 'المستخدم غير موجود')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Pashto
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.language', 'ps', 'ژبه'),
('ui', 'profile.user_profile', 'ps', 'د کارونکي پروفایل'),
('ui', 'profile.user_not_found', 'ps', 'کارونکی ونه موندل شو')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- French
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.language', 'fr', 'Langue'),
('ui', 'profile.user_profile', 'fr', 'Profil Utilisateur'),
('ui', 'profile.user_not_found', 'fr', 'Utilisateur non trouvé')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- German
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.language', 'de', 'Sprache'),
('ui', 'profile.user_profile', 'de', 'Benutzerprofil'),
('ui', 'profile.user_not_found', 'de', 'Benutzer nicht gefunden')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;


-- ============================================================================
-- 6. ADD first_name, last_name TO civic_os_users VIEW
-- ============================================================================

CREATE OR REPLACE VIEW public.civic_os_users AS
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
  END AS civic_os_text_search,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.first_name
    ELSE NULL
  END AS first_name,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.last_name
    ELSE NULL
  END AS last_name
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id;

COMMIT;
