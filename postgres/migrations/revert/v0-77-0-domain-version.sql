-- Revert civic_os:v0-77-0-domain-version from pg

BEGIN;

DROP VIEW public.schema_domain_version;
DROP FUNCTION public.set_domain_version(TEXT, TEXT, TEXT, INT);
DROP FUNCTION metadata.schema_contract_hash();
DROP FUNCTION metadata.framework_version();
DROP TABLE metadata.domain_version;

-- public.schema_decisions selects the new column, so drop it first, then restore the v0.30.0 form
DROP VIEW public.schema_decisions;
ALTER TABLE metadata.schema_decisions DROP COLUMN domain_version;

CREATE VIEW public.schema_decisions AS
SELECT
    id,
    entity_types,
    property_names,
    migration_id,
    title,
    status,
    context,
    decision,
    rationale,
    consequences,
    superseded_by_id,
    author_id,
    decided_date,
    created_at,
    updated_at
FROM metadata.schema_decisions;

COMMENT ON VIEW public.schema_decisions IS
    'Read-only view of schema decisions for PostgREST access.
     RLS on underlying table handles permissions. Added in v0.30.0.';

GRANT SELECT ON public.schema_decisions TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
