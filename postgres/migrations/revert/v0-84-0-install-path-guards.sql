-- Revert civic_os:v0-84-0-install-path-guards from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Restores the is_admin() guards and the v0.77.0 set_domain_version() body. Domain versions and decisions
-- written in the meantime stay.

BEGIN;

DROP FUNCTION public.bump_domain_version(TEXT, TEXT, INT, TEXT);

-- set_domain_version() as in v0.77.0 (its own copy of the checks), then drop the internal writer
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
DECLARE
  c_semver CONSTANT TEXT :=
    '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$';
  v_existing TEXT;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

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

COMMENT ON FUNCTION public.set_domain_version(TEXT, TEXT, TEXT, INT) IS
    'Admin only. Sets the instance domain version, its minimum client floor and the migration that set it, and links the schema decision (ADR) that explains it; the decision is stamped with the version. Added in v0.77.0.';

DROP FUNCTION metadata._set_domain_version(TEXT, TEXT, TEXT, INT);

-- create_schema_decision() as in v0.30.0
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
    -- Admin-only access (SECURITY DEFINER bypasses RLS, so check explicitly)
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'Admin access required';
    END IF;

    -- Determine author from JWT
    v_author := current_user_id();

    -- Validate status value
    IF p_status NOT IN ('proposed', 'accepted', 'deprecated', 'superseded') THEN
        RAISE EXCEPTION 'Invalid status: %. Must be one of: proposed, accepted, deprecated, superseded', p_status;
    END IF;

    -- Validate each entity_type in the array exists
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

    -- Validate property_names requires entity_types
    IF p_property_names IS NOT NULL AND p_entity_types IS NULL THEN
        RAISE EXCEPTION 'property_names requires entity_types to be specified';
    END IF;

    -- Validate supersedes_id exists if provided
    IF p_supersedes_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM metadata.schema_decisions WHERE id = p_supersedes_id
        ) THEN
            RAISE EXCEPTION 'Superseded decision does not exist: %', p_supersedes_id;
        END IF;
    END IF;

    -- Insert new decision
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

    -- Handle supersession: mark old decision as superseded
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
    'Create a schema decision record (ADR). Accepts arrays of entity types and
     property names for cross-entity decisions. Validates each entity_type against
     information_schema. If p_supersedes_id is provided, marks the old decision
     as superseded. Returns the new decision ID. Added in v0.30.0.';

NOTIFY pgrst, 'reload schema';

COMMIT;
