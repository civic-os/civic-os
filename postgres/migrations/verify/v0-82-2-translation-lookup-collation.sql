-- Verify civic_os:v0-82-2-translation-lookup-collation
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

DO $$
BEGIN
  IF (SELECT count(*)
      FROM regexp_matches(pg_get_functiondef('metadata.t(text,text,text)'::regprocedure),
                          'COLLATE "default"', 'g')) <> 6 THEN
    RAISE EXCEPTION 'metadata.t() does not compare its lookups under COLLATE "default"';
  END IF;
END $$;

ROLLBACK;
