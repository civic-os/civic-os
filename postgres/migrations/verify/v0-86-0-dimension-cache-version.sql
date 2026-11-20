-- Verify civic_os:v0-86-0-dimension-cache-version on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- the properties cache version follows the dimensions registry
SELECT 1 / COUNT(*) FROM pg_views
WHERE schemaname = 'public' AND viewname = 'schema_cache_versions' AND definition LIKE '%dimensions.updated_at%';

ROLLBACK;
