-- Revert v0-39-0-add-file-admin

BEGIN;

-- Restore permissive SELECT policy
DROP POLICY IF EXISTS "Tiered file visibility" ON metadata.files;

CREATE POLICY "Users can view files"
  ON metadata.files
  FOR SELECT
  USING (true);

COMMENT ON POLICY "Users can view files" ON metadata.files IS
  'Permissive view policy. Entity-specific access control should be implemented in application views.';

-- Drop file write RPCs
DROP FUNCTION IF EXISTS public.create_file_record(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.delete_file_record(UUID);

-- Drop helper function
DROP FUNCTION IF EXISTS metadata.can_view_entity_record(TEXT, TEXT);

-- Drop storage stats RPC
DROP FUNCTION IF EXISTS public.get_file_storage_stats();

-- Drop trigram index
DROP INDEX IF EXISTS metadata.idx_files_file_name_trgm;

-- Remove files permissions
DELETE FROM metadata.permission_roles
WHERE permission_id IN (
  SELECT id FROM metadata.permissions WHERE table_name = 'files'
);
DELETE FROM metadata.permissions WHERE table_name = 'files';

-- Drop VIEW before column (VIEW depends on property_name via SELECT *)
DROP VIEW IF EXISTS public.files;

-- Drop property_name column
ALTER TABLE metadata.files DROP COLUMN IF EXISTS property_name;

-- Restore original VIEW (definer, with INSERT/UPDATE grants)
CREATE VIEW public.files AS SELECT * FROM metadata.files;

GRANT SELECT ON public.files TO web_anon, authenticated;
GRANT INSERT, UPDATE ON public.files TO authenticated;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
