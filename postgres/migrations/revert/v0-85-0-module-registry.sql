-- Revert civic_os:v0-85-0-module-registry from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

DROP FUNCTION public.module_installed(TEXT);
DROP FUNCTION public.register_module(TEXT, TEXT, TEXT);
DROP TABLE metadata.modules;
DROP FUNCTION metadata._is_deployer();

NOTIFY pgrst, 'reload schema';

COMMIT;
