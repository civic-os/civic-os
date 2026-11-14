-- Revert civic_os:v0-81-4-revoke-public-temp
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Restores PostgreSQL's default: PUBLIC holds TEMPORARY on the database. The ACL stays explicit rather than
-- NULL, which grants the same privileges as the default.

BEGIN;

DO $$
BEGIN
    EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
END $$;

COMMIT;
