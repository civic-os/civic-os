-- Deploy civic-os:v0-9-0-add-constraint-messages-view to pg
-- requires: v0-4-0-baseline

BEGIN;

-- ============================================================================
-- PUBLIC VIEW FOR CONSTRAINT MESSAGES
-- ============================================================================
-- Exposes metadata.constraint_messages to frontend via public schema
-- PostgREST only serves schemas configured in db-schemas (default: public)

CREATE OR REPLACE VIEW public.constraint_messages AS
SELECT
  constraint_name,
  table_name,
  column_name,
  error_message
FROM metadata.constraint_messages;

COMMENT ON VIEW public.constraint_messages IS
  'User-friendly error messages for database constraint violations. Read-only view of metadata.constraint_messages. Used by frontend ErrorService to display friendly messages instead of PostgreSQL error codes.';

-- Grant read access to unauthenticated and authenticated users
GRANT SELECT ON public.constraint_messages TO web_anon, authenticated;

-- ============================================================================
-- UPDATE CACHE VERSIONING VIEW
-- ============================================================================
-- Add constraint_messages to cache versioning system
-- Frontend checks these timestamps to detect stale caches and trigger refresh

-- Drop existing view
DROP VIEW IF EXISTS public.schema_cache_versions;

-- Recreate with constraint_messages row
CREATE VIEW public.schema_cache_versions AS
SELECT
  'entities' as cache_name,
  GREATEST(
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.entities),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permissions),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.roles),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permission_roles)
  ) as version
UNION ALL
SELECT
  'properties' as cache_name,
  GREATEST(
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.properties),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.validations)
  ) as version
UNION ALL
SELECT
  'constraint_messages' as cache_name,
  (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.constraint_messages) as version;

COMMENT ON VIEW public.schema_cache_versions IS
  'Returns last updated timestamps for cached metadata tables. Frontend uses these to detect stale caches and trigger refresh on navigation.';

-- Grant read access to unauthenticated and authenticated users
GRANT SELECT ON public.schema_cache_versions TO web_anon, authenticated;

COMMIT;
