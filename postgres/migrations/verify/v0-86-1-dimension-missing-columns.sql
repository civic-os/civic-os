-- Verify civic_os:v0-86-1-dimension-missing-columns on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

SELECT missing_columns FROM public.schema_dimensions WHERE FALSE;
SELECT 1 / COUNT(*) FROM pg_class
WHERE oid = 'public.schema_dimensions'::regclass AND reloptions @> ARRAY['security_invoker=true'];
SELECT 1 / (CASE WHEN has_table_privilege('web_anon', 'public.schema_dimensions', 'SELECT') THEN 1 ELSE 0 END);

ROLLBACK;
