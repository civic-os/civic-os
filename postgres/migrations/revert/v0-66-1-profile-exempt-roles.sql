-- Revert civic_os:v0-66-1-profile-exempt-roles from pg

BEGIN;

-- ============================================================================
-- 1. DROP VIEW (references exempt_roles column)
-- ============================================================================

DROP VIEW IF EXISTS public.user_profile_extensions;


-- ============================================================================
-- 2. DROP exempt_roles COLUMN
-- ============================================================================

ALTER TABLE metadata.user_profile_extensions
  DROP COLUMN IF EXISTS exempt_roles;


-- ============================================================================
-- 3. RESTORE ORIGINAL VIEW (from v0-65-2-profile-i18n-fixes)
-- ============================================================================

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
-- 4. REMOVE SCHEMA DECISION
-- ============================================================================

DELETE FROM metadata.schema_decisions
WHERE migration_id = 'v0-66-1-profile-exempt-roles';

COMMIT;
