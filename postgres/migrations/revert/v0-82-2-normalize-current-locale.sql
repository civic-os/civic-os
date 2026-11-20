-- Revert civic_os:v0-82-2-normalize-current-locale
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- Restore the v0.58.0 body (raw Accept-Language header).
CREATE OR REPLACE FUNCTION metadata.current_locale()
RETURNS TEXT AS $$
  SELECT COALESCE(
    -- PostgREST 13+: headers as JSON blob
    NULLIF(current_setting('request.headers', true)::json->>'accept-language', ''),
    -- Legacy fallback (PostgREST < 12 with db-use-legacy-gucs)
    NULLIF(current_setting('request.header.accept-language', true), ''),
    'en'
  );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION metadata.current_locale() IS
    'Returns the current request locale from Accept-Language header, defaulting to en. '
    'Updated in v0.58.0 to read from PostgREST 13 JSON headers blob.';

COMMIT;
