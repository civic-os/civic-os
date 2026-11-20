-- Verify civic_os:v0-85-0-compare-interface-registries on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- an unregistered dimension and module are reported as such, not as missing core features
SELECT 1 / COUNT(*) FROM public.compare_interface('{"elements":[{"element":"dimension","key":"__verify_none"}]}')
WHERE difference = 'missing_dimension';
SELECT 1 / COUNT(*) FROM public.compare_interface('{"elements":[{"element":"module","key":"__verify_none"}]}')
WHERE difference = 'missing_module';

-- grants survive CREATE OR REPLACE
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'public.compare_interface(jsonb)', 'EXECUTE') THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.compare_interface(jsonb)', 'EXECUTE') THEN 0 ELSE 1 END);

ROLLBACK;
