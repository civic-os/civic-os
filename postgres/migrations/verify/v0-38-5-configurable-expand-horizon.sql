-- Verify civic_os:v0-38-5-configurable-expand-horizon on pg

BEGIN;

-- Verify create_recurring_series has p_expand_horizon_days parameter
SELECT 1/(COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'create_recurring_series'
  AND pg_get_function_arguments(p.oid) LIKE '%p_expand_horizon_days integer%';

-- Verify update_series_schedule has p_expand_horizon_days parameter
SELECT 1/(COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'update_series_schedule'
  AND pg_get_function_arguments(p.oid) LIKE '%p_expand_horizon_days integer%';

-- Verify old 12-param create_recurring_series no longer exists
SELECT 1/(1 - COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'create_recurring_series'
  AND pg_get_function_arguments(p.oid) NOT LIKE '%p_expand_horizon_days%';

-- Verify old 4-param update_series_schedule no longer exists
SELECT 1/(1 - COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'update_series_schedule'
  AND pg_get_function_arguments(p.oid) NOT LIKE '%p_expand_horizon_days%';

ROLLBACK;
