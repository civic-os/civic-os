-- Verify civic_os:v0-86-4-drop-legacy-river-unique-index on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- The legacy index is gone and River's state-aware unique index remains
SELECT 1 / (CASE WHEN to_regclass('metadata.river_job_kind_unique_key_idx') IS NULL THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN to_regclass('metadata.river_job_unique_idx') IS NOT NULL THEN 1 ELSE 0 END);

ROLLBACK;
