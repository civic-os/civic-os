-- Computed boolean column for server-side parcel filtering (v0.53.0)
-- PostgREST exposes this as a filterable column: ?is_eligible=is.true
--
-- This replaces the need to fetch all eligible IDs client-side via
-- options_source_rpc when the result set is large (70k+ parcels).

CREATE OR REPLACE FUNCTION is_eligible(parcels) RETURNS boolean
LANGUAGE SQL STABLE AS $$
  SELECT $1.eligibility IN (
    SELECT id FROM metadata.categories
    WHERE entity_type = 'parcel_eligibility'
    AND category_key IN ('good', 'few_issues')
  )
$$;

COMMENT ON FUNCTION is_eligible(parcels) IS
    'PostgREST computed column: returns true when parcel eligibility category is good or few_issues. '
    'Used as a server-side filter in FK search modals via options_filter_column metadata.';

-- Configure the M2M property to use computed filter instead of RPC ID pre-fetch
UPDATE metadata.properties
SET options_filter_column = 'is_eligible'
WHERE table_name = 'tool_reservation_work_site'
  AND column_name = 'work_site_parcels_m2m';
