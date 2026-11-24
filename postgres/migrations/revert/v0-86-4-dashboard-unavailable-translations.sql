-- Revert civic_os:v0-86-4-dashboard-unavailable-translations from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

DELETE FROM metadata.translations
WHERE source_type = 'ui' AND source_key IN ('dashboard.loading', 'dashboard.unavailable.title', 'dashboard.unavailable.message', 'dashboard.unavailable.sign_in_message', 'dashboard.unavailable.go_home');

COMMIT;
