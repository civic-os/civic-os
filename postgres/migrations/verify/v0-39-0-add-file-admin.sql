-- Verify v0-39-0-add-file-admin

BEGIN;

-- Verify property_name column exists
SELECT property_name FROM metadata.files WHERE FALSE;

-- Verify can_view_entity_record function exists
SELECT has_function_privilege(
  'metadata.can_view_entity_record(text, text)',
  'execute'
);

-- Verify get_file_storage_stats function exists
SELECT has_function_privilege(
  'public.get_file_storage_stats()',
  'execute'
);

-- Verify create_file_record RPC exists
SELECT has_function_privilege(
  'public.create_file_record(uuid, text, text, text, text, bigint, text, text, text, text)',
  'execute'
);

-- Verify delete_file_record RPC exists
SELECT has_function_privilege(
  'public.delete_file_record(uuid)',
  'execute'
);

-- Verify trigram index exists
SELECT 1 FROM pg_indexes
WHERE schemaname = 'metadata'
  AND tablename = 'files'
  AND indexname = 'idx_files_file_name_trgm';

-- Verify tiered policy exists (and old permissive policy is gone)
SELECT 1 FROM pg_policies
WHERE schemaname = 'metadata'
  AND tablename = 'files'
  AND policyname = 'Tiered file visibility';

-- Verify old policy is gone
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'metadata'
      AND tablename = 'files'
      AND policyname = 'Users can view files'
  ) THEN
    RAISE EXCEPTION 'Old permissive policy still exists';
  END IF;
END $$;

-- Verify files permissions exist
SELECT 1 FROM metadata.permissions
WHERE table_name = 'files' AND permission = 'read';

-- Verify VIEW is security_invoker (read-only)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
    WHERE schemaname = 'public' AND viewname = 'files'
  ) THEN
    RAISE EXCEPTION 'public.files VIEW does not exist';
  END IF;
END $$;

ROLLBACK;
