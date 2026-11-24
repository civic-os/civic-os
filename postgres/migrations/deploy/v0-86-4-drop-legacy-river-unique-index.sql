-- Deploy civic_os:v0-86-4-drop-legacy-river-unique-index to pg
-- requires: v0-86-3-split-invoker
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Drops River's legacy unique index (issue #147).
--
-- v0-10-0-add-river-queue copied River migrations 005 and 006 by hand. 006 replaces the 005 index
-- river_job_kind_unique_key_idx (kind, unique_key), which ignores job state, with river_job_unique_idx
-- (unique_key, counting only the states a job declares in unique_states). Our copy dropped the old index
-- without its schema (DROP INDEX IF EXISTS river_job_kind_unique_key_idx) while River's tables live in
-- metadata, so the drop did nothing and both indexes stayed. While River's job cleaner keeps a completed
-- parse_all_source_code row (about 24 hours), the old index rejected every new parse job ("duplicate key
-- value violates unique constraint river_job_kind_unique_key_idx"), so System Functions and Entity Code
-- could show source up to a day old after a schema change.
--
-- River's 006 notes say to drop the old index once no job uses the old unique system (unique_key set,
-- unique_states NULL). The only such writer was the consolidated worker's scheduled-jobs scheduler, whose
-- hand-written insert used ON CONFLICT (kind, unique_key); since v0.86.4 it inserts through the River client
-- with UniqueOpts (every state), so river_job_unique_idx dedupes it. If this migration runs while a worker
-- from before v0.86.4 is still up, that worker's scheduler insert fails (no matching index) and logs an
-- error; the run stays due and the upgraded worker queues it on its next tick.

BEGIN;

DROP INDEX IF EXISTS metadata.river_job_kind_unique_key_idx;

COMMIT;
