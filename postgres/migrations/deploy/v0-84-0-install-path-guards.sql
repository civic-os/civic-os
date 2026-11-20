-- Deploy civic_os:v0-84-0-install-path-guards to pg
-- requires: v0-83-0-menu-dashboard-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Install scripts run as the deployment role (the login role that runs core migrations: postgres,
-- doadmin, rds_admin) and carry no JWT, so the is_admin() guards on set_domain_version() and
-- create_schema_decision() refused them, and scripts fell back to direct INSERTs that skip the
-- validation tying a domain version to exactly one schema decision.
-- Design: docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md (section 2, Phasing step 1).
--
--   public.create_schema_decision()   guard is now metadata._is_db_admin(); body unchanged except the
--                                     refusal now carries SQLSTATE 42501
--   metadata._set_domain_version()    the one writer of metadata.domain_version: the body of
--                                     set_domain_version() without a guard and without an EXECUTE grant
--   public.set_domain_version()       guard is now metadata._is_db_admin(); calls the internal writer
--   public.bump_domain_version()      raises one part of the current version and calls the internal writer
--
-- _is_db_admin() admits an admin JWT, a superuser, or a login role with CREATEROLE. PostgREST connects as
-- authenticator, which has neither, so behavior over the API does not change: API callers still need an
-- admin JWT. No function here generates DDL.

BEGIN;

-- ============================================================================
-- 1. public.create_schema_decision(): _is_db_admin() guard
-- ============================================================================
-- Same signature and body as v0.30.0. author_id is NULL when there is no JWT (current_user_id() is NULL).

CREATE OR REPLACE FUNCTION public.create_schema_decision(
    p_title TEXT,
    p_decision TEXT,
    p_entity_types NAME[] DEFAULT NULL,
    p_property_names NAME[] DEFAULT NULL,
    p_context TEXT DEFAULT NULL,
    p_rationale TEXT DEFAULT NULL,
    p_consequences TEXT DEFAULT NULL,
    p_status TEXT DEFAULT 'accepted',
    p_migration_id TEXT DEFAULT NULL,
    p_supersedes_id INT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_decision_id INT;
    v_author UUID;
    v_entity NAME;
BEGIN
    -- Admin JWT, or the deployment role running an install script (SECURITY DEFINER bypasses RLS)
    IF NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
    END IF;

    -- Author from the JWT; NULL for a script without one
    v_author := current_user_id();

    IF p_status NOT IN ('proposed', 'accepted', 'deprecated', 'superseded') THEN
        RAISE EXCEPTION 'Invalid status: %. Must be one of: proposed, accepted, deprecated, superseded', p_status;
    END IF;

    IF p_entity_types IS NOT NULL THEN
        FOREACH v_entity IN ARRAY p_entity_types LOOP
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = v_entity::TEXT
            ) AND NOT EXISTS (
                SELECT 1 FROM information_schema.views
                WHERE table_schema = 'public' AND table_name = v_entity::TEXT
            ) THEN
                RAISE EXCEPTION 'Entity type does not exist: %', v_entity;
            END IF;
        END LOOP;
    END IF;

    IF p_property_names IS NOT NULL AND p_entity_types IS NULL THEN
        RAISE EXCEPTION 'property_names requires entity_types to be specified';
    END IF;

    IF p_supersedes_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM metadata.schema_decisions WHERE id = p_supersedes_id
        ) THEN
            RAISE EXCEPTION 'Superseded decision does not exist: %', p_supersedes_id;
        END IF;
    END IF;

    INSERT INTO metadata.schema_decisions (
        entity_types, property_names, migration_id,
        title, status, context, decision, rationale, consequences,
        author_id, decided_date
    ) VALUES (
        p_entity_types, p_property_names, p_migration_id,
        p_title, p_status, p_context, p_decision, p_rationale, p_consequences,
        v_author, CURRENT_DATE
    )
    RETURNING id INTO v_decision_id;

    IF p_supersedes_id IS NOT NULL THEN
        UPDATE metadata.schema_decisions
        SET status = 'superseded',
            superseded_by_id = v_decision_id
        WHERE id = p_supersedes_id;
    END IF;

    RETURN v_decision_id;
END;
$$;

COMMENT ON FUNCTION public.create_schema_decision(TEXT, TEXT, NAME[], NAME[], TEXT, TEXT, TEXT, TEXT, TEXT, INT) IS
    'Create a schema decision record (ADR). Accepts arrays of entity types and property names for cross-entity decisions; validates each entity type. If p_supersedes_id is given, marks the old decision as superseded. Returns the new decision id. Callable with an admin JWT or by the deployment role without one (metadata._is_db_admin(); author_id is then NULL). Added in v0.30.0; deployment role admitted in v0.84.0.';

-- ============================================================================
-- 2. metadata._set_domain_version(): the one writer
-- ============================================================================
-- The checks of set_domain_version() (v0.77.0), unchanged. SQLSTATEs: 22023 malformed version or a floor
-- above the version; 23502 no decision given; 23503 decision does not exist; 23505 decision already linked
-- to another version. No guard and no EXECUTE grant: only set_domain_version() and bump_domain_version()
-- (definers, owned by the same role) call it, after their own guard.

CREATE FUNCTION metadata._set_domain_version(
    p_domain_version TEXT,
    p_min_client_domain_version TEXT,
    p_migration TEXT,
    p_decision_id INT
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public
AS $$
DECLARE
  c_semver CONSTANT TEXT :=
    '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$';
  v_existing TEXT;
BEGIN
  IF p_domain_version IS NULL OR p_domain_version !~ c_semver THEN
    RAISE EXCEPTION 'Invalid domain version %: expected semver (MAJOR.MINOR.PATCH)', p_domain_version
      USING ERRCODE = '22023';
  END IF;
  IF p_min_client_domain_version IS NOT NULL AND p_min_client_domain_version !~ c_semver THEN
    RAISE EXCEPTION 'Invalid minimum client domain version %: expected semver (MAJOR.MINOR.PATCH)', p_min_client_domain_version
      USING ERRCODE = '22023';
  END IF;
  IF p_min_client_domain_version IS NOT NULL AND
     string_to_array(split_part(split_part(p_min_client_domain_version, '+', 1), '-', 1), '.')::int[]
       > string_to_array(split_part(split_part(p_domain_version, '+', 1), '-', 1), '.')::int[] THEN
    RAISE EXCEPTION 'Minimum client domain version % is above the domain version %', p_min_client_domain_version, p_domain_version
      USING ERRCODE = '22023';
  END IF;
  IF p_migration IS NULL OR trim(p_migration) = '' THEN
    RAISE EXCEPTION 'p_migration is required: name the migration that sets this version'
      USING ERRCODE = '22023';
  END IF;

  IF p_decision_id IS NULL THEN
    RAISE EXCEPTION 'A schema decision (ADR) is required to set a domain version: create one with create_schema_decision() and pass its id'
      USING ERRCODE = '23502';
  END IF;

  SELECT sd.domain_version INTO v_existing
  FROM metadata.schema_decisions sd
  WHERE sd.id = p_decision_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Schema decision % does not exist', p_decision_id
      USING ERRCODE = '23503';
  END IF;
  IF v_existing IS NOT NULL AND v_existing IS DISTINCT FROM p_domain_version THEN
    RAISE EXCEPTION 'Schema decision % is already linked to domain version %', p_decision_id, v_existing
      USING ERRCODE = '23505';
  END IF;

  UPDATE metadata.schema_decisions
  SET domain_version = p_domain_version
  WHERE id = p_decision_id;

  UPDATE metadata.domain_version
  SET domain_version = p_domain_version,
      min_client_domain_version = p_min_client_domain_version,
      set_by_migration = p_migration,
      decision_id = p_decision_id,
      updated_at = NOW()
  WHERE id;
END;
$$;

COMMENT ON FUNCTION metadata._set_domain_version(TEXT, TEXT, TEXT, INT) IS
    'Internal. The only writer of metadata.domain_version: validates the version, its floor and the migration name, requires a schema decision not linked to another version, stamps the decision and writes the row. No guard and no EXECUTE grant; called by set_domain_version() and bump_domain_version() after their guard. Added in v0.84.0.';

REVOKE EXECUTE ON FUNCTION metadata._set_domain_version(TEXT, TEXT, TEXT, INT) FROM PUBLIC;

-- ============================================================================
-- 3. public.set_domain_version(): _is_db_admin() guard, one writer
-- ============================================================================
-- CREATE OR REPLACE keeps the signature, owner and grants (EXECUTE for authenticated, not PUBLIC).

CREATE OR REPLACE FUNCTION public.set_domain_version(
    p_domain_version TEXT,
    p_min_client_domain_version TEXT,
    p_migration TEXT,
    p_decision_id INT
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

  PERFORM metadata._set_domain_version(p_domain_version, p_min_client_domain_version, p_migration, p_decision_id);
END;
$$;

COMMENT ON FUNCTION public.set_domain_version(TEXT, TEXT, TEXT, INT) IS
    'Sets the instance domain version, its minimum client floor and the migration that set it, and links the schema decision (ADR) that explains it; the decision is stamped with the version. Callable with an admin JWT or by the deployment role without one (metadata._is_db_admin()). Added in v0.77.0; deployment role admitted in v0.84.0.';

-- ============================================================================
-- 4. public.bump_domain_version()
-- ============================================================================
-- Raises one part of the current version and resets the lower parts, dropping pre-release and build
-- metadata first: 1.3.0 + minor = 1.4.0; 0.0.0 + minor = 0.1.0; 1.4.0-rc.1 + minor = 1.5.0;
-- 1.4.0-rc.1 + patch = 1.4.1. The floor is kept unless p_min_client_domain_version is given.
-- The single row is locked FOR UPDATE, so concurrent installs raise the version one after the other.
-- SQLSTATEs: 42501 not admin; 22023 unknown part; the internal writer's codes otherwise.

CREATE FUNCTION public.bump_domain_version(
    p_part TEXT,
    p_migration TEXT,
    p_decision_id INT,
    p_min_client_domain_version TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_current TEXT;
  v_floor TEXT;
  v_parts INT[];
  v_new TEXT;
BEGIN
  IF NOT metadata._is_db_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  IF p_part IS NULL OR p_part NOT IN ('major', 'minor', 'patch') THEN
    RAISE EXCEPTION 'Invalid version part %: expected major, minor or patch', p_part
      USING ERRCODE = '22023';
  END IF;

  SELECT d.domain_version, d.min_client_domain_version
    INTO v_current, v_floor
  FROM metadata.domain_version d
  WHERE d.id
  FOR UPDATE;

  v_parts := string_to_array(split_part(split_part(v_current, '+', 1), '-', 1), '.')::int[];

  v_new := CASE p_part
    WHEN 'major' THEN format('%s.0.0', v_parts[1] + 1)
    WHEN 'minor' THEN format('%s.%s.0', v_parts[1], v_parts[2] + 1)
    ELSE              format('%s.%s.%s', v_parts[1], v_parts[2], v_parts[3] + 1)
  END;

  PERFORM metadata._set_domain_version(
    v_new,
    COALESCE(p_min_client_domain_version, v_floor),
    p_migration,
    p_decision_id);

  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION public.bump_domain_version(TEXT, TEXT, INT, TEXT) IS
    'Raises the major, minor or patch part of the instance domain version (pre-release and build metadata dropped, lower parts reset), links the given schema decision and returns the new version. Keeps the minimum client floor unless one is given. Locks the row, so concurrent calls apply one after the other. Callable with an admin JWT or by the deployment role without one (metadata._is_db_admin()). Added in v0.84.0.';

REVOKE EXECUTE ON FUNCTION public.bump_domain_version(TEXT, TEXT, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bump_domain_version(TEXT, TEXT, INT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
