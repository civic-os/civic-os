-- Deploy v0-39-0-add-file-admin
-- Add file administration features: property_name tracking, tiered RLS, storage stats RPC,
-- file write RPCs (follows admin pattern: VIEWs for reads, RPCs for writes)

BEGIN;

-- ============================================================================
-- 1. PROPERTY NAME COLUMN
-- Track which entity property a file was uploaded for (e.g., 'photo', 'resume')
-- ============================================================================

ALTER TABLE metadata.files ADD COLUMN property_name TEXT;

COMMENT ON COLUMN metadata.files.property_name IS
  'Column name of the entity property that references this file (v0.39.0)';

-- ============================================================================
-- 2. TRIGRAM INDEX FOR FILENAME SEARCH
-- Enables efficient ILIKE/similarity searches on file_name
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_files_file_name_trgm
  ON metadata.files USING gin (file_name gin_trgm_ops);

-- ============================================================================
-- 3. HYBRID RLS HELPER: can_view_entity_record()
-- Delegates visibility check to the target table's own RLS policies.
-- SECURITY INVOKER ensures the calling user's permissions are evaluated.
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.can_view_entity_record(
  p_entity_type TEXT, p_entity_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_exists BOOLEAN;
BEGIN
  -- Guard: entity_type must be a real table in public schema
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = p_entity_type
  ) THEN RETURN FALSE; END IF;

  -- Dynamic SQL: delegates to target table's own RLS
  -- Try BIGINT first (most common PK type), then UUID fallback
  BEGIN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id = $1::BIGINT)', p_entity_type)
      INTO v_exists USING p_entity_id;
    RETURN v_exists;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    BEGIN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id = $1::UUID)', p_entity_type)
        INTO v_exists USING p_entity_id;
      RETURN v_exists;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN FALSE;
    END;
  END;
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER;

COMMENT ON FUNCTION metadata.can_view_entity_record(TEXT, TEXT) IS
  'Check if current user can view a specific entity record by delegating to target table RLS (v0.39.0)';

-- ============================================================================
-- 4. TIERED FILE VISIBILITY POLICY
-- Replaces the permissive USING(true) policy with a layered approach:
--   Tier 1: Admin (JWT check, fastest)
--   Tier 2: Own uploads (simple equality)
--   Tier 3: Table-level RBAC permission
--   Tier 4: Record-level RLS delegation (dynamic SQL, slowest)
-- PostgreSQL short-circuits OR left-to-right for optimal performance.
-- ============================================================================

DROP POLICY "Users can view files" ON metadata.files;

CREATE POLICY "Tiered file visibility" ON metadata.files FOR SELECT
USING (
  is_admin()
  OR created_by = current_user_id()
  OR has_permission(entity_type, 'read')
  OR metadata.can_view_entity_record(entity_type, entity_id)
);

COMMENT ON POLICY "Tiered file visibility" ON metadata.files IS
  'Tiered visibility: admin > own uploads > table RBAC > record-level RLS (v0.39.0)';

-- ============================================================================
-- 5. STORAGE STATS RPC
-- Returns aggregate file stats. SECURITY INVOKER means RLS applies:
-- admins see global stats, others see stats for their visible files only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_file_storage_stats()
RETURNS TABLE(total_count BIGINT, total_size_bytes BIGINT) AS $$
  SELECT COUNT(*)::BIGINT, COALESCE(SUM(file_size), 0)::BIGINT
  FROM metadata.files;
$$ LANGUAGE sql STABLE SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION public.get_file_storage_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_file_storage_stats() TO authenticated;

COMMENT ON FUNCTION public.get_file_storage_stats() IS
  'Get file storage statistics (count + total size). RLS-filtered per calling user (v0.39.0)';

-- ============================================================================
-- 6. FILES CRUD PERMISSIONS
-- Register all four CRUD permission types for the files table.
-- Only 'read' is used by the admin page now; others are ready for future use.
-- ============================================================================

INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('files', 'read'),
  ('files', 'create'),
  ('files', 'update'),
  ('files', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- ============================================================================
-- 7. FILE WRITE RPCs
-- Follows admin pattern: VIEWs for reads, RPCs for writes.
-- SECURITY DEFINER bypasses RLS for the INSERT, but the BEFORE INSERT trigger
-- (set_file_created_by) still fires and extracts created_by from the JWT.
-- The GRANT restricts access to authenticated users only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_file_record(
  p_id UUID,
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_file_name TEXT,
  p_file_type TEXT,
  p_file_size BIGINT,
  p_s3_bucket TEXT,
  p_s3_original_key TEXT,
  p_thumbnail_status TEXT DEFAULT 'not_applicable',
  p_property_name TEXT DEFAULT NULL
) RETURNS json AS $$
DECLARE
  v_result metadata.files;
BEGIN
  -- Validate caller has create permission on the target entity type
  IF NOT has_permission(p_entity_type, 'create') THEN
    RAISE EXCEPTION 'Not authorized to upload files for entity type %', p_entity_type
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO metadata.files (
    id, entity_type, entity_id, file_name, file_type, file_size,
    s3_bucket, s3_original_key, thumbnail_status, property_name
  ) VALUES (
    p_id, p_entity_type, p_entity_id, p_file_name, p_file_type, p_file_size,
    p_s3_bucket, p_s3_original_key, p_thumbnail_status, p_property_name
  )
  RETURNING * INTO v_result;

  RETURN row_to_json(v_result);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER;

-- PostgreSQL grants EXECUTE to PUBLIC by default — revoke before granting to authenticated only
REVOKE EXECUTE ON FUNCTION public.create_file_record(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_file_record(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.create_file_record IS
  'Create a file record after S3 upload. SECURITY DEFINER; created_by set by trigger from JWT (v0.39.0)';

-- Delete file record (ownership or admin check)
CREATE OR REPLACE FUNCTION public.delete_file_record(p_file_id UUID)
RETURNS void AS $$
DECLARE
  v_deleted BOOLEAN;
BEGIN
  -- Atomic ownership check + delete (eliminates TOCTOU race)
  WITH deleted AS (
    DELETE FROM metadata.files
    WHERE id = p_file_id
      AND (created_by = current_user_id() OR is_admin())
    RETURNING id
  )
  SELECT EXISTS(SELECT 1 FROM deleted) INTO v_deleted;

  IF NOT v_deleted THEN
    RAISE EXCEPTION 'Not authorized to delete this file or file not found'
      USING ERRCODE = '42501';
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.delete_file_record(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_file_record(UUID) TO authenticated;

COMMENT ON FUNCTION public.delete_file_record IS
  'Delete a file record. Only file owner or admin can delete (v0.39.0)';

-- ============================================================================
-- 8. REFRESH PUBLIC.FILES VIEW (READ-ONLY)
-- PostgreSQL SELECT * views don't auto-detect new columns on the base table.
-- Recreate to expose property_name through PostgREST API.
-- security_invoker=true ensures RLS on metadata.files evaluates as the
-- calling user, not the view owner. SELECT-only: writes go through RPCs.
-- ============================================================================

DROP VIEW IF EXISTS public.files;
CREATE VIEW public.files
  WITH (security_invoker = true)
  AS SELECT * FROM metadata.files;

-- SELECT only — no INSERT/UPDATE grants. Writes go through RPCs above.
GRANT SELECT ON public.files TO web_anon, authenticated;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
