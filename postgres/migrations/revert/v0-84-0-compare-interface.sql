-- Revert civic_os:v0-84-0-compare-interface from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

DROP FUNCTION public.assert_interface(JSONB);
DROP FUNCTION public.compare_interface(JSONB);
DROP FUNCTION metadata._interface_type_difference(OID, INT, OID, INT);

NOTIFY pgrst, 'reload schema';

COMMIT;
