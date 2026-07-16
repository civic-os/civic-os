-- Deploy civic_os:v0-66-1-profile-exempt-roles
-- Requires: v0-66-0-ical-change-detection
--
-- v0.66.1 — Add exempt_roles to profile extensions:
--   1. Add exempt_roles column to metadata.user_profile_extensions
--   2. Rewrite public.user_profile_extensions VIEW to compute is_required
--      server-side using get_user_roles() && exempt_roles
--   3. Record schema decision

BEGIN;

-- ============================================================================
-- 1. ADD exempt_roles COLUMN
-- ============================================================================
-- Roles listed here are exempt from the is_required enforcement.
-- Empty array (default) = no exemptions = original behavior.

ALTER TABLE metadata.user_profile_extensions
  ADD COLUMN exempt_roles NAME[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN metadata.user_profile_extensions.exempt_roles IS
    'Roles exempt from is_required enforcement. When the current user holds any
     listed role, the VIEW returns is_required=false. Empty array means no
     exemptions (original behavior). Added in v0.66.1.';


-- ============================================================================
-- 2. REWRITE user_profile_extensions VIEW
-- ============================================================================
-- Replace e.is_required with a computed value that checks whether the current
-- user holds any of the exempt roles. Also expose exempt_roles as a raw column.

DROP VIEW IF EXISTS public.user_profile_extensions;

CREATE VIEW public.user_profile_extensions AS
SELECT
  e.table_name,
  e.sort_order,
  e.is_required AND NOT (e.exempt_roles && metadata.get_user_roles()::NAME[]) AS is_required,
  metadata.t('entity', e.table_name::TEXT || '.display_name',
    COALESCE(e.display_name, ent.display_name, e.table_name::TEXT)) AS display_name,
  metadata.t('entity', e.table_name::TEXT || '.description',
    e.description) AS description,
  e.user_fk_column,
  COALESCE(e.user_fk_constraint,
    e.table_name || '_' || e.user_fk_column || '_fkey') AS user_fk_constraint,
  e.exempt_roles
FROM metadata.user_profile_extensions e
LEFT JOIN metadata.entities ent ON ent.table_name = e.table_name
ORDER BY e.sort_order, e.table_name;

ALTER VIEW public.user_profile_extensions SET (security_invoker = true);
GRANT SELECT ON public.user_profile_extensions TO web_anon, authenticated;


-- ============================================================================
-- 3. SCHEMA DECISION
-- ============================================================================

INSERT INTO metadata.schema_decisions
  (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences)
VALUES
  ('{user_profile_extensions}',
   '{exempt_roles}',
   'v0-66-1-profile-exempt-roles',
   'Add exempt_roles to profile completion guard',
   'accepted',
   'Admins and staff who log in to configure the system get nagged by the profile completion guard to fill out user-facing forms they will never use. There was no per-extension way to exempt certain roles from is_required enforcement.',
   'Added NAME[] exempt_roles column to metadata.user_profile_extensions with DEFAULT ''{}''. The public VIEW computes is_required server-side: is_required AND NOT (exempt_roles && get_user_roles()::NAME[]). Frontend guard logic is unchanged — it consumes the resolved boolean.',
   'Server-side resolution keeps the frontend simple and ensures any API consumer (PostgREST, psql, other services) gets the correct is_required value without reimplementing role-checking logic. NAME[] matches the type used by role_key throughout the RBAC system.',
   'Empty exempt_roles array preserves original behavior (fully backwards-compatible). The VIEW is slightly more expensive per-row due to the get_user_roles() call, but the table is tiny (typically <10 rows).');

COMMIT;
