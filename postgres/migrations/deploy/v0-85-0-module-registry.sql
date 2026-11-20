-- Deploy civic_os:v0-85-0-module-registry to pg
-- requires: v0-84-0-compare-interface
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- The smallest module registry: a way to ask "is module X installed, at what version?" from instance SQL.
-- Design: docs/notes/IMPACT_REPORTING_DESIGN.md (Module registry, decisions 5 and 8) and
-- docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md (section 3).
--
--   metadata.modules            one row per installed module, report pack (pack:<key>) or bridge (bridge:<key>)
--   public.register_module()    upsert; admin JWT or the deployment role (metadata._is_db_admin())
--   public.module_installed()   stable, callable by any role
--   metadata._is_deployer()     the deployment role without a JWT: superuser or CREATEROLE login, no is_admin()
--                               branch. Used where an application admin must not reach a code path that
--                               generates DDL (register_dimension() over the API, v0.85.0).
--
-- No dependency resolution, uninstall or upgrade logic: those belong to a later module-system design.
-- Rows are instance content written by install scripts; this migration creates only the shape.

BEGIN;

-- ============================================================================
-- 1. metadata._is_deployer()
-- ============================================================================
-- session_user is the login role (authenticator over PostgREST, postgres or doadmin for scripts); the
-- function is a definer, so current_user would always be the owner. A request with JWT claims is never a
-- deployer, whatever the login role.

CREATE FUNCTION metadata._is_deployer()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb = '{}'::jsonb
     AND EXISTS (
       SELECT 1 FROM pg_roles
       WHERE rolname = session_user AND (rolsuper OR rolcreaterole)
     );
$$;

COMMENT ON FUNCTION metadata._is_deployer() IS
    'True for the deployment role running a script without a JWT: a superuser or CREATEROLE login session with no request.jwt.claims. Unlike metadata._is_db_admin(), an admin JWT does not qualify. Added in v0.85.0.';

REVOKE EXECUTE ON FUNCTION metadata._is_deployer() FROM PUBLIC;

-- ============================================================================
-- 2. metadata.modules
-- ============================================================================

CREATE TABLE metadata.modules (
    module_key   TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    version      TEXT NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT modules_key_format CHECK (module_key ~ '^((pack|bridge):)?[a-z][a-z0-9_]*$'),
    CONSTRAINT modules_display_name_not_empty CHECK (btrim(display_name) <> ''),
    CONSTRAINT modules_version_semver CHECK (
        version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$')
);

COMMENT ON TABLE metadata.modules IS
    'Installed modules, report packs (pack:<key>) and bridges (bridge:<key>), each with its own semver. Written by register_module() from install scripts; read through module_installed() and compare_interface(). Added in v0.85.0.';
COMMENT ON COLUMN metadata.modules.module_key IS 'Lowercase key, optionally prefixed pack: or bridge:.';
COMMENT ON COLUMN metadata.modules.version IS 'The module''s own semver, distinct from the instance domain version.';
COMMENT ON COLUMN metadata.modules.installed_at IS 'When the module was first registered; kept on re-registration.';
COMMENT ON COLUMN metadata.modules.updated_at IS 'When the module was last registered (installed or upgraded).';

ALTER TABLE metadata.modules ENABLE ROW LEVEL SECURITY;

-- Signed-in users read the registry (compare_interface() runs as the caller); writes only through the definer RPC.
CREATE POLICY modules_select ON metadata.modules FOR SELECT TO authenticated USING (true);
GRANT SELECT ON metadata.modules TO authenticated;

-- ============================================================================
-- 3. public.register_module()
-- ============================================================================
-- Upsert: a re-registration (an upgrade, or a re-run) replaces the display name and version and keeps
-- installed_at. SQLSTATEs: 42501 neither an admin JWT nor the deployment role; 22023 malformed input.

CREATE FUNCTION public.register_module(
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

REVOKE EXECUTE ON FUNCTION public.register_module(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_module(TEXT, TEXT, TEXT) TO authenticated;

-- ============================================================================
-- 4. public.module_installed()
-- ============================================================================
-- A definer so anonymous callers and RLS-filtered roles get the same answer; it reveals only a boolean.

CREATE FUNCTION public.module_installed(p_module_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
  SELECT EXISTS (SELECT 1 FROM metadata.modules WHERE module_key = p_module_key);
$$;

COMMENT ON FUNCTION public.module_installed(TEXT) IS
    'True when the module, report pack (pack:<key>) or bridge (bridge:<key>) is registered. Callable by any role. Added in v0.85.0.';

REVOKE EXECUTE ON FUNCTION public.module_installed(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.module_installed(TEXT) TO web_anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
