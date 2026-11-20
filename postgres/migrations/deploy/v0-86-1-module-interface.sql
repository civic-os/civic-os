-- Deploy civic_os:v0-86-1-module-interface to pg
-- requires: v0-86-0-dimension-sort-column
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- An installed module keeps the interface it declared (v0.86.1). Answers Module Install Support open
-- question 1 ("store now, warn later"): the declaration an install script passes to assert_interface() is
-- saved on its registry row, so a later schema editor or Instance Management MCP warning can name the
-- modules that depend on a column. No warning is built here; modules installed from now on carry their
-- declarations when one is.
-- Design: docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md (Decisions after build) and
-- docs/notes/IMPACT_REPORTING_DESIGN.md (Module registry).
--
--   metadata.modules.interface               the declaration (compare_interface() format), or NULL
--   public.register_module(..., p_interface)  new four-argument form; validates the declaration (22023)
--   public.register_module(key, name, ver)    unchanged signature (v0.85.0 is released); registers with no
--                                             declaration
--
-- The interface follows the latest registration, like the version: re-registering without one clears it,
-- since it describes what the installed version depends on. Two overloads with no defaults keep every
-- existing call unambiguous.

BEGIN;

ALTER TABLE metadata.modules ADD COLUMN interface JSONB;

COMMENT ON COLUMN metadata.modules.interface IS
    'The interface the installed version declared (the compare_interface() declaration: tables, columns, RPCs, dimensions and modules it depends on), or NULL. Set by register_module(p_interface); follows the latest registration. Since v0.86.1.';

CREATE FUNCTION public.register_module(
    p_module_key TEXT,
    p_display_name TEXT,
    p_version TEXT,
    p_interface JSONB
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
  -- a malformed declaration raises 22023 from the parser; the comparison result itself is not checked here
  -- (assert_interface() is the install script's own gate)
  IF p_interface IS NOT NULL THEN
    PERFORM 1 FROM public.compare_interface(p_interface);
  END IF;

  INSERT INTO metadata.modules (module_key, display_name, version, interface)
  VALUES (p_module_key, p_display_name, p_version, p_interface)
  ON CONFLICT (module_key) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        version = EXCLUDED.version,
        interface = EXCLUDED.interface,
        updated_at = NOW();
END;
$$;

COMMENT ON FUNCTION public.register_module(TEXT, TEXT, TEXT, JSONB) IS
    'Registers or re-registers an installed module, report pack (pack:<key>) or bridge (bridge:<key>) with its semver and the interface it declared (compare_interface() format; NULL for none; malformed raises 22023); keeps the first installed_at. Admin JWT or the deployment role (metadata._is_db_admin()). Added in v0.86.1.';

REVOKE EXECUTE ON FUNCTION public.register_module(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_module(TEXT, TEXT, TEXT, JSONB) TO authenticated;

-- The v0.85.0 form registers with no declaration (and so clears one left by an earlier version).
CREATE OR REPLACE FUNCTION public.register_module(
    p_module_key TEXT,
    p_display_name TEXT,
    p_version TEXT
)
RETURNS VOID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
  SELECT public.register_module(p_module_key, p_display_name, p_version, NULL::jsonb);
$$;

COMMENT ON FUNCTION public.register_module(TEXT, TEXT, TEXT) IS
    'Registers or re-registers an installed module, report pack (pack:<key>) or bridge (bridge:<key>) with its semver and no declared interface; keeps the first installed_at. Admin JWT or the deployment role (metadata._is_db_admin()). Added in v0.85.0; since v0.86.1 the same as register_module(..., p_interface := NULL).';

NOTIFY pgrst, 'reload schema';

COMMIT;
