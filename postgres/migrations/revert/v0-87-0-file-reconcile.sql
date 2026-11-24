-- Revert civic_os:v0-87-0-file-reconcile from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

DELETE FROM metadata.translations WHERE source_type = 'ui' AND source_key = 'error.attachment_expired';

DROP FUNCTION metadata.delete_stale_upload_requests(INTERVAL);
DROP FUNCTION metadata.staged_file_states(UUID[]);
DROP FUNCTION metadata.delete_orphaned_staged_files(INTERVAL, INTEGER);
DROP FUNCTION metadata.claim_file(UUID, NAME, NAME, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION metadata.unclaimed_file_references(INTEGER);
DROP FUNCTION metadata._file_reference_columns(BOOLEAN);
DROP FUNCTION metadata._file_thumbnail_job_live(UUID);

DROP INDEX metadata.idx_files_unclaimed;

COMMIT;
