-- Verify civic_os:v0-81-4-revoke-public-temp
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

DO $$
BEGIN
  IF has_database_privilege('public', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'PUBLIC must not hold TEMPORARY on database %', current_database();
  END IF;
  IF NOT has_database_privilege('public', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'PUBLIC must keep CONNECT on database %', current_database();
  END IF;
END $$;
