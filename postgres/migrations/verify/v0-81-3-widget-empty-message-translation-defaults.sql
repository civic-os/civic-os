-- Verify civic_os:v0-81-3-widget-empty-message-translation-defaults
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- A fresh database has no filtered_list widget to list, so check the function body for the branch.
DO $$
BEGIN
  IF pg_get_functiondef('public.get_translation_defaults()'::regprocedure) NOT LIKE '%emptyMessage%' THEN
    RAISE EXCEPTION 'get_translation_defaults() has no filtered_list emptyMessage branch';
  END IF;
END $$;
