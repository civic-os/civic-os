-- Template: Add RPC Function
-- This template shows the pattern for adding a new PostgreSQL function
-- exposed as an RPC endpoint through PostgREST
--
-- Usage: Copy this template and customize for your function
-- Example: cp templates/add_rpc_function.sql deploy/v0-4-0-add_get_related_issues.sql

-- Deploy civic_os:vX-Y-Z-add_your_function to pg
-- requires: previous_migration_name

BEGIN;

-- 1. Create the function in public schema (PostgREST exposes public schema)
CREATE OR REPLACE FUNCTION public.your_function_name(
  -- Input parameters
  param1 INT,
  param2 TEXT DEFAULT ''
)
RETURNS TABLE (
  -- Output columns
  id INT,
  display_name TEXT,
  result_column TEXT
)
LANGUAGE plpgsql
STABLE  -- Use STABLE for read-only, VOLATILE for writes
SECURITY DEFINER  -- Run with function owner's permissions
SET search_path = public, metadata, postgis
AS $$
BEGIN
  -- Function logic here
  RETURN QUERY
  SELECT
    t.id,
    t.display_name,
    t.some_column AS result_column
  FROM some_table t
  WHERE t.id = param1
    AND (param2 = '' OR t.name ILIKE '%' || param2 || '%');
END;
$$;

-- 2. Add function comment (shows up in PostgREST OpenAPI docs)
COMMENT ON FUNCTION public.your_function_name IS
'Description of what this function does. This comment appears in API documentation.';

-- 3. Grant execute permission
-- For read-only functions accessible to all authenticated users:
GRANT EXECUTE ON FUNCTION public.your_function_name TO authenticated;

-- For admin-only functions:
-- GRANT EXECUTE ON FUNCTION public.your_function_name TO admin;

-- 4. Revoke PUBLIC execute (PostgreSQL grants EXECUTE to PUBLIC by default;
--    the GRANT above does NOT remove it, so web_anon can still call the function)
REVOKE EXECUTE ON FUNCTION public.your_function_name FROM PUBLIC;

-- Examples of common RPC function patterns:

-- PATTERN 1: Simple lookup function
--
-- CREATE OR REPLACE FUNCTION public.get_user_by_email(user_email EMAIL_ADDRESS)
-- RETURNS TABLE (
--   id UUID,
--   display_name TEXT,
--   full_name TEXT
-- )
-- LANGUAGE sql
-- STABLE
-- SECURITY DEFINER
-- AS $$
--   SELECT id, display_name, full_name
--   FROM civic_os_users
--   WHERE email = user_email;
-- $$;

-- PATTERN 2: Aggregation function
--
-- CREATE OR REPLACE FUNCTION public.get_issue_stats(status_filter INT DEFAULT NULL)
-- RETURNS TABLE (
--   status_name TEXT,
--   issue_count BIGINT,
--   avg_severity NUMERIC
-- )
-- LANGUAGE sql
-- STABLE
-- AS $$
--   SELECT
--     s.display_name AS status_name,
--     COUNT(i.id) AS issue_count,
--     AVG(i.severity) AS avg_severity
--   FROM issues i
--   JOIN statuses s ON i.status_id = s.id
--   WHERE status_filter IS NULL OR i.status_id = status_filter
--   GROUP BY s.display_name
--   ORDER BY issue_count DESC;
-- $$;

-- PATTERN 3: Data modification function
--
-- CREATE OR REPLACE FUNCTION public.close_issue(issue_id BIGINT)
-- RETURNS BOOLEAN
-- LANGUAGE plpgsql
-- VOLATILE
-- SECURITY DEFINER
-- AS $$
-- DECLARE
--   closed_status_id INT;
-- BEGIN
--   -- Verify permission
--   IF NOT public.has_permission('issues:update') THEN
--     RAISE EXCEPTION 'Permission denied: issues:update required';
--   END IF;
--
--   -- Get closed status ID
--   SELECT id INTO closed_status_id
--   FROM statuses
--   WHERE display_name = 'Closed';
--
--   -- Update issue
--   UPDATE issues
--   SET status_id = closed_status_id,
--       updated_at = NOW()
--   WHERE id = issue_id;
--
--   RETURN FOUND;
-- END;
-- $$;

COMMIT;
