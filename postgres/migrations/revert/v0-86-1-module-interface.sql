-- Revert civic_os:v0-86-1-module-interface from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Restores the v0.85.0 three-argument register_module() body, then drops the four-argument form and the column.

BEGIN;

CREATE OR REPLACE FUNCTION public.register_module(
    p_module_key TEXT,
    p_display_name TEXT,
    p_version TEXT
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
  IF NOT metadata._is_db_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  IF p_module_key IS NULL OR p_module_key !~ '^((pack|bridge):)?[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid module key %: lowercase letters, digits and underscores, optionally prefixed pack: or bridge:', p_module_key
      USING ERRCODE = '22023';
  END IF;
  IF p_display_name IS NULL OR btrim(p_display_name) = '' THEN
    RAISE EXCEPTION 'A module display name is required' USING ERRCODE = '22023';
  END IF;
  IF p_version IS NULL OR p_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' THEN
    RAISE EXCEPTION 'Invalid module version %: expected semver (MAJOR.MINOR.PATCH)', p_version
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO metadata.modules (module_key, display_name, version)
  VALUES (p_module_key, p_display_name, p_version)
  ON CONFLICT (module_key) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        version = EXCLUDED.version,
        updated_at = NOW();
END;
$$;

COMMENT ON FUNCTION public.register_module(TEXT, TEXT, TEXT) IS
    'Registers or re-registers an installed module, report pack (pack:<key>) or bridge (bridge:<key>) with its semver; keeps the first installed_at. Admin JWT or the deployment role (metadata._is_db_admin()). Added in v0.85.0.';

DROP FUNCTION public.register_module(TEXT, TEXT, TEXT, JSONB);

ALTER TABLE metadata.modules DROP COLUMN interface;

NOTIFY pgrst, 'reload schema';

COMMIT;
