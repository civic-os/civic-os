-- Verify civic_os:v0-86-3-split-invoker on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- The public RPC runs with the caller's rights, the internal one with definer rights
SELECT 1 / (CASE WHEN NOT prosecdef THEN 1 ELSE 0 END) FROM pg_proc
WHERE oid = 'public.split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb, bigint, jsonb)'::regprocedure;
SELECT 1 / (CASE WHEN prosecdef THEN 1 ELSE 0 END) FROM pg_proc
WHERE oid = 'metadata._split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb, bigint, jsonb)'::regprocedure;

-- authenticated may call both (the wrapper calls the internal function as the caller); PUBLIC may not
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'public.split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb, bigint, jsonb)', 'EXECUTE')
              AND has_function_privilege('authenticated', 'metadata._split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb, bigint, jsonb)', 'EXECUTE')
              AND NOT has_function_privilege('web_anon', 'metadata._split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb, bigint, jsonb)', 'EXECUTE')
            THEN 1 ELSE 0 END);

ROLLBACK;
