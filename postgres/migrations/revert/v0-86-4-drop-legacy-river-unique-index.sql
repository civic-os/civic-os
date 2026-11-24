-- Revert civic_os:v0-86-4-drop-legacy-river-unique-index from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Recreates River's legacy unique index. It fails while river_job holds two rows of one kind with the same
-- unique_key (for example a completed and a newer parse job); wait for River's job cleaner, or delete the
-- completed duplicates, and revert again. Workers before v0.86.4 need this index for their scheduler.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS river_job_kind_unique_key_idx
    ON metadata.river_job (kind, unique_key) WHERE unique_key IS NOT NULL;

COMMIT;
