-- Verify civic_os:v0-82-2-normalize-current-locale
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

SELECT set_config('request.headers', '{"accept-language":"en-US,en;q=0.9"}', true);

DO $$
BEGIN
  IF metadata.current_locale() IS DISTINCT FROM 'en' THEN
    RAISE EXCEPTION 'current_locale() returns % for en-US,en;q=0.9, expected en', metadata.current_locale();
  END IF;
END $$;

ROLLBACK;
