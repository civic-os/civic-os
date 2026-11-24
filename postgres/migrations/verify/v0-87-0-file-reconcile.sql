-- Verify civic_os:v0-87-0-file-reconcile on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

SELECT 1 / COUNT(*) FROM pg_indexes WHERE schemaname = 'metadata' AND indexname = 'idx_files_unclaimed';

-- every function is a definer with a fixed search_path, closed to the API roles
SELECT 1 / (CASE WHEN COUNT(*) = 7 THEN 1 ELSE 0 END)
FROM pg_proc p
WHERE p.oid IN (
    'metadata._file_thumbnail_job_live(uuid)'::regprocedure,
    'metadata._file_reference_columns(boolean)'::regprocedure,
    'metadata.unclaimed_file_references(integer)'::regprocedure,
    'metadata.claim_file(uuid,name,name,text,timestamptz,text,text,text,text)'::regprocedure,
    'metadata.delete_orphaned_staged_files(interval,integer)'::regprocedure,
    'metadata.staged_file_states(uuid[])'::regprocedure,
    'metadata.delete_stale_upload_requests(interval)'::regprocedure)
  AND p.prosecdef
  AND p.proconfig IS NOT NULL
  AND NOT has_function_privilege('web_anon', p.oid, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');

SELECT 1 / (CASE WHEN COUNT(*) = 6 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'ui' AND source_key = 'error.attachment_expired'
  AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps');

ROLLBACK;
