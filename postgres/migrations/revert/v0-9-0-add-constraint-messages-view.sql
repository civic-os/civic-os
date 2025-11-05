-- Revert civic-os:v0-9-0-add-constraint-messages-view from pg

BEGIN;

-- Drop the public view
DROP VIEW IF EXISTS public.constraint_messages;

-- Drop existing view
DROP VIEW IF EXISTS public.schema_cache_versions;

-- Restore original schema_cache_versions view (without constraint_messages row)
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
  ) as version;

-- Restore grants on schema_cache_versions
GRANT SELECT ON public.schema_cache_versions TO web_anon, authenticated;

COMMIT;
