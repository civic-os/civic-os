-- Verify civic_os:v0-38-5-recurring-dtstart-local-time on pg

BEGIN;

-- Verify dtstart column is now TIMESTAMP (not TIMESTAMPTZ)
SELECT 1/(COUNT(*))::int
FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'time_slot_series'
  AND column_name = 'dtstart'
  AND data_type = 'timestamp without time zone';

-- Verify create_recurring_series has TIMESTAMP parameter (not TIMESTAMPTZ)
SELECT 1/(COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'create_recurring_series'
  AND pg_get_function_arguments(p.oid) LIKE '%p_dtstart timestamp without time zone%';

-- Verify split_series_from_date has TIMESTAMP parameter
SELECT 1/(COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'split_series_from_date'
  AND pg_get_function_arguments(p.oid) LIKE '%p_new_dtstart timestamp without time zone%';

-- Verify update_series_schedule has TIMESTAMP parameter
SELECT 1/(COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'update_series_schedule'
  AND pg_get_function_arguments(p.oid) LIKE '%p_dtstart timestamp without time zone%';

-- Verify no TIMESTAMPTZ versions of these functions remain
SELECT 1/(1 - COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN ('create_recurring_series', 'split_series_from_date', 'update_series_schedule')
  AND pg_get_function_arguments(p.oid) LIKE '%timestamp with time zone%';

ROLLBACK;
