-- Computed boolean column for server-side parcel filtering (v0.53.0)
-- PostgREST exposes this as a filterable column: ?is_eligible=is.true
--
-- Eligibility is a composite of two conditions:
--   1. Parcel is LMI Qualified (lmi_status category)
--   2. Parcel is NOT Land Bank (land_bank_status = 'private')
--
-- This replaces the need to fetch all eligible IDs client-side via
-- options_source_rpc when the result set is large (70k+ parcels).

CREATE OR REPLACE FUNCTION is_eligible(parcels) RETURNS boolean
LANGUAGE SQL STABLE AS $$
  SELECT $1.lmi_status = (
    SELECT id FROM metadata.categories
    WHERE entity_type = 'lmi_status'
    AND category_key = 'lmi_qualified'
  )
  AND $1.land_bank_status = (
    SELECT id FROM metadata.categories
    WHERE entity_type = 'parcel_land_bank'
    AND category_key = 'private'
  )
$$;

COMMENT ON FUNCTION is_eligible(parcels) IS
    'PostgREST computed column: returns true when parcel is LMI Qualified AND Not Land Bank. '
    'Used as a server-side filter in FK search modals via options_filter_column metadata.';

-- Configure the M2M property to use computed filter instead of RPC ID pre-fetch
UPDATE metadata.properties
SET options_filter_column = 'is_eligible'
WHERE table_name = 'tool_reservation_work_site'
  AND column_name = 'work_site_parcels_m2m';
