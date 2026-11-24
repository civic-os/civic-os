-- Deploy civic_os:v0-87-0-file-reconcile to pg
-- requires: v0-86-4-import-modal-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- File reconcile (issue #141, v0.87.0). A file attached on a Create page is uploaded before its record
-- exists: it is staged as {entity_type}/_new/{file_id}/... with metadata.files.entity_id = '' (v0.86.5),
-- and since v0.86.5 the saved record's file column holds its id. The consolidated worker's
-- FileReconcileCron uses the functions below to move a staged file to its record's folder and to delete
-- staged files nothing references. Design: docs/notes/FILE_RECONCILE_DESIGN.md.
--
--   idx_files_unclaimed                          partial index on the staged rows
--   metadata._file_thumbnail_job_live(id)        true while a thumbnail_generate job may still write
--   metadata.unclaimed_file_references(limit)    staged files a public table references, first owner each
--   metadata.claim_file(...)                     moves the row to its record (guarded compare-and-set)
--   metadata.delete_orphaned_staged_files(ttl)   deletes unreferenced staged rows older than the TTL
--   metadata.staged_file_states(ids)             which staged-object ids still have a row, and whether claimed
--   metadata.delete_stale_upload_requests(age)   deletes old metadata.file_upload_requests rows
--   ui translation error.attachment_expired      shown when a save references a deleted staged file
--
-- All functions live in metadata (not exposed by PostgREST), are SECURITY DEFINER with a fixed
-- search_path, and are closed to PUBLIC: only the worker's database role calls them. No instance
-- content is changed.

BEGIN;

-- ---------------------------------------------------------------------------
-- Index: the staged rows (entity_id = '') are few; every function starts from them.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_files_unclaimed ON metadata.files (created_at) WHERE entity_id = '';

-- ---------------------------------------------------------------------------
-- A thumbnail job reads s3_original_key when it runs and writes its thumbnails beside it, so a file is
-- not moved or deleted while its job is queued, running or waiting to retry. The status column cannot
-- say this: the thumbnail worker never writes 'processing', and a failing job stays 'pending' through
-- its retries.
-- ---------------------------------------------------------------------------
CREATE FUNCTION metadata._file_thumbnail_job_live(p_file_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, metadata
AS $$
  SELECT EXISTS (
    SELECT 1 FROM metadata.river_job j
    WHERE j.kind = 'thumbnail_generate'
      AND j.args @> jsonb_build_object('file_id', p_file_id::text)
      AND j.state IN ('available', 'pending', 'retryable', 'running', 'scheduled')
  );
$$;

REVOKE EXECUTE ON FUNCTION metadata._file_thumbnail_job_live(UUID) FROM PUBLIC;

COMMENT ON FUNCTION metadata._file_thumbnail_job_live(UUID) IS
  'True while a thumbnail_generate River job for the file is queued, running or waiting to retry. The file reconcile functions leave such files alone. Worker only. Since v0.87.0.';

-- ---------------------------------------------------------------------------
-- The foreign-key columns that reference metadata.files(id): single-column constraints, declared on the
-- table itself (not cloned onto partitions). p_public_only limits them to public tables with a
-- single-column primary key, the ones a file can be claimed for.
-- ---------------------------------------------------------------------------
CREATE FUNCTION metadata._file_reference_columns(p_public_only BOOLEAN)
RETURNS TABLE (schema_name NAME, table_name NAME, column_name NAME, pk_name NAME, pk_type TEXT, pk_numeric BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, metadata
AS $$
  SELECT n.nspname, c.relname, a.attname, pk.attname, format_type(pk.atttypid, pk.atttypmod),
         pk.atttypid IN ('int2'::regtype, 'int4'::regtype, 'int8'::regtype, 'numeric'::regtype)
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
  LEFT JOIN pg_index i ON i.indrelid = con.conrelid AND i.indisprimary AND i.indnkeyatts = 1
  LEFT JOIN pg_attribute pk ON pk.attrelid = con.conrelid AND pk.attnum = i.indkey[0]
  WHERE con.contype = 'f'
    AND con.confrelid = 'metadata.files'::regclass
    AND con.conparentid = 0
    AND cardinality(con.conkey) = 1
    AND (NOT p_public_only OR (n.nspname = 'public' AND pk.attname IS NOT NULL))
  ORDER BY n.nspname, c.relname, a.attname;
$$;

REVOKE EXECUTE ON FUNCTION metadata._file_reference_columns(BOOLEAN) FROM PUBLIC;

COMMENT ON FUNCTION metadata._file_reference_columns(BOOLEAN) IS
  'Single-column foreign keys to metadata.files(id), read from pg_constraint. With true, only public tables with a single-column primary key (claimable owners). Worker only. Since v0.87.0.';

-- ---------------------------------------------------------------------------
-- Staged files that a public table references, with their first owner: the referencing table that sorts
-- first by name, then its lowest primary key (numerically for integer keys). Gallery files and files whose
-- thumbnail job is live are left out. The limit applies to the references returned, so a backlog of
-- unreferenced uploads waiting for the TTL never hides a referenced one.
-- ---------------------------------------------------------------------------
CREATE FUNCTION metadata.unclaimed_file_references(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (
  file_id UUID,
  table_name NAME,
  column_name NAME,
  entity_id TEXT,
  s3_bucket TEXT,
  s3_original_key TEXT,
  s3_thumbnail_small_key TEXT,
  s3_thumbnail_medium_key TEXT,
  s3_thumbnail_large_key TEXT,
  seen_updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, metadata
AS $$
DECLARE
  v_staged UUID[];
  v_refs TEXT;
BEGIN
  SELECT array_agg(f.id) INTO v_staged
  FROM metadata.files f
  WHERE f.entity_id = ''
    AND f.entity_type <> 'photo_gallery'
    AND NOT metadata._file_thumbnail_job_live(f.id);

  IF v_staged IS NULL THEN
    RETURN;
  END IF;

  SELECT string_agg(
           format(
             'SELECT %L::name AS table_name, %L::name AS column_name, t.%I::text AS entity_id, %s AS sort_num, t.%I AS file_id FROM public.%I t WHERE t.%I = ANY ($1)',
             r.table_name, r.column_name, r.pk_name,
             CASE WHEN r.pk_numeric THEN format('t.%I::numeric', r.pk_name) ELSE 'NULL::numeric' END,
             r.column_name, r.table_name, r.column_name),
           ' UNION ALL ')
  INTO v_refs
  FROM metadata._file_reference_columns(true) r;

  IF v_refs IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE format(
    $q$
    WITH refs AS (%s),
    firsts AS (
      SELECT DISTINCT ON (r.file_id) r.file_id, r.table_name, r.column_name, r.entity_id
      FROM refs r
      ORDER BY r.file_id, r.table_name, r.sort_num NULLS LAST, r.entity_id, r.column_name
    )
    SELECT f.id, x.table_name, x.column_name, x.entity_id, f.s3_bucket::text, f.s3_original_key,
           f.s3_thumbnail_small_key, f.s3_thumbnail_medium_key, f.s3_thumbnail_large_key, f.updated_at
    FROM firsts x
    JOIN metadata.files f ON f.id = x.file_id
    ORDER BY f.created_at, f.id
    LIMIT $2
    $q$, v_refs)
  USING v_staged, p_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION metadata.unclaimed_file_references(INTEGER) FROM PUBLIC;

COMMENT ON FUNCTION metadata.unclaimed_file_references(INTEGER) IS
  'Staged files (entity_id = '''') that a public table references, one row per file with its first owner (table name, then lowest primary key), oldest first. Skips photo_gallery files and files with a live thumbnail job. seen_updated_at is the claim_file() compare-and-set token. Worker only. Since v0.87.0.';

-- ---------------------------------------------------------------------------
-- Claims a staged file for its record once the worker has copied its objects to the record's folder.
-- Compare-and-set: the row must still be staged and unchanged since unclaimed_file_references() read it,
-- and the record must still reference it. Returns:
--   'claimed'            this call claimed it; the worker deletes the old objects
--   'claimed_elsewhere'  already claimed with these keys (another worker won); the copies are live, keep them
--   'stale'              changed or gone since it was read; the worker deletes its copies and retries later
--   'unreferenced'       the record no longer references it; the worker deletes its copies
-- ---------------------------------------------------------------------------
CREATE FUNCTION metadata.claim_file(
  p_file_id UUID,
  p_table NAME,
  p_column NAME,
  p_entity_id TEXT,
  p_seen_updated_at TIMESTAMPTZ,
  p_original_key TEXT,
  p_small_key TEXT,
  p_medium_key TEXT,
  p_large_key TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, metadata
AS $$
DECLARE
  v_col RECORD;
  v_found INTEGER;
BEGIN
  IF p_entity_id IS NULL OR p_entity_id = '' OR p_original_key IS NULL OR p_original_key = '' THEN
    RAISE EXCEPTION 'claim_file: an entity id and an original key are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_col
  FROM metadata._file_reference_columns(true) r
  WHERE r.table_name = p_table AND r.column_name = p_column;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'claim_file: public.%.% is not a column that references metadata.files', p_table, p_column
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM metadata.files f
  WHERE f.id = p_file_id AND f.entity_id = '' AND f.updated_at = p_seen_updated_at
  FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM metadata.files f
               WHERE f.id = p_file_id AND f.entity_id <> '' AND f.s3_original_key = p_original_key) THEN
      RETURN 'claimed_elsewhere';
    END IF;
    RETURN 'stale';
  END IF;

  EXECUTE format('SELECT 1 FROM public.%I t WHERE t.%I = $1::%s AND t.%I = $2 FOR KEY SHARE',
                 p_table, v_col.pk_name, v_col.pk_type, p_column)
    USING p_entity_id, p_file_id;
  GET DIAGNOSTICS v_found = ROW_COUNT;
  IF v_found = 0 THEN
    RETURN 'unreferenced';
  END IF;

  UPDATE metadata.files f
  SET entity_type = p_table::text,
      entity_id = p_entity_id,
      s3_original_key = p_original_key,
      s3_thumbnail_small_key = p_small_key,
      s3_thumbnail_medium_key = p_medium_key,
      s3_thumbnail_large_key = p_large_key,
      updated_at = NOW()
  WHERE f.id = p_file_id;

  RETURN 'claimed';
END;
$$;

REVOKE EXECUTE ON FUNCTION metadata.claim_file(UUID, NAME, NAME, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

COMMENT ON FUNCTION metadata.claim_file(UUID, NAME, NAME, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT) IS
  'Claims a staged file for public.<p_table> row p_entity_id, whose p_column references it: sets entity_type, entity_id and the object keys (already copied by the worker). Returns claimed, claimed_elsewhere (already claimed with these keys), stale (changed or gone since read at p_seen_updated_at) or unreferenced. Raises 22023 for a column that does not reference metadata.files. Worker only. Since v0.87.0.';

-- ---------------------------------------------------------------------------
-- Deletes staged rows older than the TTL that nothing references, in any schema (a CASCADE or SET NULL
-- reference must never be hit silently), and returns their keys so the worker deletes the objects after
-- the row: an object left behind is swept later, a row whose objects are gone would be a broken file.
-- Each row is locked and deleted on its own; one referenced since the check is skipped.
-- ---------------------------------------------------------------------------
CREATE FUNCTION metadata.delete_orphaned_staged_files(p_ttl INTERVAL, p_limit INTEGER DEFAULT 100)
RETURNS TABLE (
  file_id UUID,
  s3_bucket TEXT,
  s3_original_key TEXT,
  s3_thumbnail_small_key TEXT,
  s3_thumbnail_medium_key TEXT,
  s3_thumbnail_large_key TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, metadata
AS $$
#variable_conflict use_column
DECLARE
  v_candidates UUID[];
  v_refs TEXT;
  v_referenced UUID[];
  r RECORD;
BEGIN
  IF p_ttl IS NULL OR p_ttl < INTERVAL '1 hour' THEN
    RAISE EXCEPTION 'delete_orphaned_staged_files: the TTL must be at least 1 hour, got %', p_ttl
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(c.id) INTO v_candidates
  FROM (
    SELECT f.id
    FROM metadata.files f
    WHERE f.entity_id = ''
      AND f.entity_type <> 'photo_gallery'
      AND f.created_at < NOW() - p_ttl
      AND NOT metadata._file_thumbnail_job_live(f.id)
    ORDER BY f.created_at, f.id
    LIMIT p_limit
  ) c;

  IF v_candidates IS NULL THEN
    RETURN;
  END IF;

  SELECT string_agg(format('SELECT t.%I FROM %I.%I t WHERE t.%I = ANY ($1)',
                           r2.column_name, r2.schema_name, r2.table_name, r2.column_name),
                    ' UNION ')
  INTO v_refs
  FROM metadata._file_reference_columns(false) r2;

  IF v_refs IS NOT NULL THEN
    EXECUTE format('SELECT array_agg(x) FROM (%s) s(x)', v_refs) INTO v_referenced USING v_candidates;
  END IF;

  FOR r IN
    SELECT f.id, f.s3_bucket::text AS bucket, f.s3_original_key AS original_key,
           f.s3_thumbnail_small_key AS small_key, f.s3_thumbnail_medium_key AS medium_key,
           f.s3_thumbnail_large_key AS large_key
    FROM metadata.files f
    WHERE f.id = ANY (v_candidates)
      AND NOT (f.id = ANY (COALESCE(v_referenced, '{}'::uuid[])))
      AND f.entity_id = ''
    ORDER BY f.created_at, f.id
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      DELETE FROM metadata.files f WHERE f.id = r.id;
      file_id := r.id;
      s3_bucket := r.bucket;
      s3_original_key := r.original_key;
      s3_thumbnail_small_key := r.small_key;
      s3_thumbnail_medium_key := r.medium_key;
      s3_thumbnail_large_key := r.large_key;
      RETURN NEXT;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL; -- referenced since the check: keep it
    END;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION metadata.delete_orphaned_staged_files(INTERVAL, INTEGER) FROM PUBLIC;

COMMENT ON FUNCTION metadata.delete_orphaned_staged_files(INTERVAL, INTEGER) IS
  'Deletes staged files (entity_id = '''', not photo_gallery) older than p_ttl (at least 1 hour) that no foreign key in any schema references and whose thumbnail job is not live, oldest first, up to p_limit; returns their bucket and keys for the worker to delete the objects. Worker only. Since v0.87.0.';

-- ---------------------------------------------------------------------------
-- For the stray-object sweep: which of these file ids still have a row, and whether it is claimed.
-- Ids without a row are not returned.
-- ---------------------------------------------------------------------------
CREATE FUNCTION metadata.staged_file_states(p_ids UUID[])
RETURNS TABLE (file_id UUID, claimed BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, metadata
AS $$
  SELECT f.id, f.entity_id <> '' FROM metadata.files f WHERE f.id = ANY (p_ids);
$$;

REVOKE EXECUTE ON FUNCTION metadata.staged_file_states(UUID[]) FROM PUBLIC;

COMMENT ON FUNCTION metadata.staged_file_states(UUID[]) IS
  'For each id with a metadata.files row: whether the row is claimed (entity_id <> ''''). Used by the worker to sweep objects left under {type}/_new/. Worker only. Since v0.87.0.';

-- ---------------------------------------------------------------------------
-- The table comment of metadata.file_upload_requests has always promised cleanup after 24 hours.
-- ---------------------------------------------------------------------------
CREATE FUNCTION metadata.delete_stale_upload_requests(p_age INTERVAL DEFAULT INTERVAL '24 hours')
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, metadata
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_age IS NULL OR p_age < INTERVAL '1 hour' THEN
    RAISE EXCEPTION 'delete_stale_upload_requests: the age must be at least 1 hour, got %', p_age
      USING ERRCODE = '22023';
  END IF;
  DELETE FROM metadata.file_upload_requests r WHERE r.created_at < NOW() - p_age;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION metadata.delete_stale_upload_requests(INTERVAL) FROM PUBLIC;

COMMENT ON FUNCTION metadata.delete_stale_upload_requests(INTERVAL) IS
  'Deletes metadata.file_upload_requests rows older than p_age (default 24 hours, at least 1 hour); returns the count. Worker only. Since v0.87.0.';

-- ---------------------------------------------------------------------------
-- A Create page left open past the TTL saves a file id whose row was deleted: the save fails with a
-- foreign-key violation on metadata.files, and the page says which field to upload again.
-- The English row matches src/app/i18n/en.translations.ts.
-- ---------------------------------------------------------------------------
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'error.attachment_expired', 'en', '{{field}}: this attachment is no longer available. Upload the file again.'),
('ui', 'error.attachment_expired', 'es', '{{field}}: este archivo adjunto ya no está disponible. Vuelva a subir el archivo.'),
('ui', 'error.attachment_expired', 'fr', '{{field}} : cette pièce jointe n''est plus disponible. Téléversez à nouveau le fichier.'),
('ui', 'error.attachment_expired', 'de', '{{field}}: Dieser Anhang ist nicht mehr verfügbar. Laden Sie die Datei erneut hoch.'),
('ui', 'error.attachment_expired', 'ar', '{{field}}: هذا المرفق لم يعد متاحًا. يُرجى رفع الملف مرة أخرى.'),
('ui', 'error.attachment_expired', 'ps', '{{field}}: دا ضمیمه نور شتون نه لري. مهرباني وکړئ فایل بیا پورته کړئ.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
