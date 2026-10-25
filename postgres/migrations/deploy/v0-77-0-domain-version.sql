-- Deploy civic_os:v0-77-0-domain-version to pg
-- requires: v0-76-10-view-relations-output-columns
--
-- Domain version record for the Frontend SDK (design: docs/notes/FRONTEND_SDK_DESIGN.md sections 9, 10).
--
--   metadata.domain_version          one row: the instance's domain version, the floor a client must
--                                    understand, the migration that set it, and the ADR that explains why
--   metadata.framework_version()     framework version, derived from the Sqitch registry (not stored)
--   metadata.schema_contract_hash()  role- and locale-independent hash of the typed-codegen contract
--   public.schema_domain_version     the PostgREST view clients read at bootstrap
--   public.set_domain_version()      the only write path; admin-only, and it requires an ADR
--
-- Every non-seed domain version must carry a schema decision (ADR): set_domain_version() requires an
-- existing decision id and stamps that decision's new domain_version column, so the ADR and the version
-- point at each other. The migration itself records no decision (framework changes do not log ADRs).
-- Instance content is untouched: only the shape is added, and the single row is seeded with
-- ON CONFLICT DO NOTHING.

BEGIN;

-- ============================================================================
-- 1. metadata.schema_decisions.domain_version
-- ============================================================================
-- Set only by set_domain_version(). Nullable: most decisions never bump the domain version.

ALTER TABLE metadata.schema_decisions
  ADD COLUMN domain_version TEXT
  CONSTRAINT schema_decisions_domain_version_semver
  CHECK (domain_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$');

COMMENT ON COLUMN metadata.schema_decisions.domain_version IS
    'Domain version (semver) this decision introduced. Set only by set_domain_version(); NULL for decisions that did not bump it. Added in v0.77.0.';

-- Re-create the public view in its existing definer form (allowlisted in view-security-guard-test.sh),
-- with the new column appended. CREATE OR REPLACE keeps the owner, comment and grants; the grant is repeated.
CREATE OR REPLACE VIEW public.schema_decisions AS
SELECT
    id,
    entity_types,
    property_names,
    migration_id,
    title,
    status,
    context,
    decision,
    rationale,
    consequences,
    superseded_by_id,
    author_id,
    decided_date,
    created_at,
    updated_at,
    domain_version
FROM metadata.schema_decisions;

GRANT SELECT ON public.schema_decisions TO authenticated;

-- ============================================================================
-- 2. metadata.domain_version (single row)
-- ============================================================================

CREATE TABLE metadata.domain_version (
    id BOOLEAN PRIMARY KEY DEFAULT true,
    domain_version TEXT NOT NULL,
    min_client_domain_version TEXT,
    set_by_migration TEXT NOT NULL,
    decision_id INT REFERENCES metadata.schema_decisions(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT domain_version_single_row CHECK (id),
    CONSTRAINT domain_version_semver CHECK (
        domain_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'),
    CONSTRAINT domain_version_min_client_semver CHECK (
        min_client_domain_version IS NULL OR
        min_client_domain_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'),
    CONSTRAINT domain_version_set_by_migration_not_empty CHECK (trim(set_by_migration) <> ''),
    -- only the seeded 0.0.0 row may lack an ADR
    CONSTRAINT domain_version_requires_decision CHECK (decision_id IS NOT NULL OR domain_version = '0.0.0')
);

-- FK columns are always indexed (inverse lookups, ON DELETE checks on the decision row)
CREATE INDEX idx_domain_version_decision_id ON metadata.domain_version(decision_id);

COMMENT ON TABLE metadata.domain_version IS
    'Single-row record of the instance''s domain schema version (semver), set by the integrator through set_domain_version(). The framework version is not stored here: see metadata.framework_version(). Added in v0.77.0.';
COMMENT ON COLUMN metadata.domain_version.id IS 'Always true; with the CHECK it makes the table single-row.';
COMMENT ON COLUMN metadata.domain_version.domain_version IS 'Semver of the instance''s own tables and their evolution. 0.0.0 until an integrator sets one.';
COMMENT ON COLUMN metadata.domain_version.min_client_domain_version IS 'Minimum domain version a client must understand to talk to this instance (NULL: no floor).';
COMMENT ON COLUMN metadata.domain_version.set_by_migration IS 'Name of the migration that set this version.';
COMMENT ON COLUMN metadata.domain_version.decision_id IS 'The schema decision (ADR) that explains this version. Required for every version except the seeded 0.0.0.';

ALTER TABLE metadata.domain_version ENABLE ROW LEVEL SECURITY;

-- Everyone reads; there is no write policy and no write grant, so set_domain_version() (definer) is the only writer.
CREATE POLICY domain_version_select ON metadata.domain_version FOR SELECT USING (true);

GRANT SELECT ON metadata.domain_version TO web_anon, authenticated;

INSERT INTO metadata.domain_version (id, domain_version, set_by_migration)
VALUES (true, '0.0.0', 'v0-77-0-domain-version')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 3. metadata.framework_version(): derived from the Sqitch registry
-- ============================================================================
-- The registry (sqitch.conf: registry = metadata) records every deployed change, so the framework
-- version is the highest vX-Y-Z prefix among this project's deployed changes. Storing it would only
-- add a second source of truth to keep in step with the plan. SECURITY DEFINER because API roles
-- cannot read the registry; returns only the version string. NULL when the registry is absent.

CREATE FUNCTION metadata.framework_version()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_version TEXT;
BEGIN
  IF to_regclass('metadata.changes') IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.parts[1] || '.' || c.parts[2] || '.' || c.parts[3]
    INTO v_version
  FROM (
    SELECT regexp_match(ch.change, '^v([0-9]+)-([0-9]+)-([0-9]+)') AS parts
    FROM metadata.changes ch
    WHERE ch.project = 'civic_os'
  ) c
  WHERE c.parts IS NOT NULL
  ORDER BY c.parts[1]::int DESC, c.parts[2]::int DESC, c.parts[3]::int DESC
  LIMIT 1;

  RETURN v_version;
END;
$$;

COMMENT ON FUNCTION metadata.framework_version() IS
    'Framework version (X.Y.Z): the highest vX-Y-Z change prefix in the Sqitch registry for project civic_os. NULL when the registry is absent. Added in v0.77.0.';

REVOKE EXECUTE ON FUNCTION metadata.framework_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metadata.framework_version() TO web_anon, authenticated;

-- ============================================================================
-- 4. metadata.schema_contract_hash()
-- ============================================================================
-- THE ONLY implementation of the contract hash. Codegen reads the value from public.schema_domain_version
-- and never computes it; its fixture mirror of this field list must stay in step with the list below.
--
-- CANONICAL FIELDS (what typed codegen depends on)
--   entities: the set in public.schema_entities, keyed by table_name, each with
--     table_name, is_view, is_rich_junction, show_map, map_property_name, show_calendar,
--     calendar_property_name, supports_recurring, recurring_property_name, enable_notes,
--     has_payment (payment_initiation_rpc IS NOT NULL), has_guided_form (guided_form_key IS NOT NULL)
--   properties: the rows of public.schema_properties for those entities, keyed by column_name, each with
--     column_name, data_type, udt_name, is_nullable, is_generated, is_identity,
--     has_default (column_default IS NOT NULL), join_schema, join_table, join_column,
--     geography_type, status_entity_type, category_entity_type, is_recurring
--   m2m: the (table_name, column_name) pairs of public.schema_m2m_properties for those entities
--   actions: public.schema_entity_actions rows for those entities, keyed by action_name, each with
--     action_name and its params keyed by param_name: param_name, param_type, required
-- EXCLUDED: status and category rows, every permission flag (insert/select/update/delete,
--   has_permission, can_execute), and every translated or presentation field (display names,
--   descriptions, sort order, show_on_*, column width, sortable, filterable, validation messages,
--   placeholders, icons, button styles, conditions).
--
-- Ordering: every array is built with an explicit ORDER BY (COLLATE "C"); jsonb normalizes object key order.
-- Role and locale independence: the function is SECURITY DEFINER (information_schema is filtered by the
-- caller's privileges) and reads only columns that no t() translation or permission check feeds.

CREATE FUNCTION metadata.schema_contract_hash()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_contract JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(e.obj ORDER BY e.table_name COLLATE "C"), '[]'::jsonb)
    INTO v_contract
  FROM (
    SELECT
      se.table_name::text AS table_name,
      jsonb_build_object(
        'table_name', se.table_name,
        'is_view', se.is_view,
        'is_rich_junction', se.is_rich_junction,
        'show_map', se.show_map,
        'map_property_name', se.map_property_name,
        'show_calendar', se.show_calendar,
        'calendar_property_name', se.calendar_property_name,
        'supports_recurring', se.supports_recurring,
        'recurring_property_name', se.recurring_property_name,
        'enable_notes', se.enable_notes,
        'has_payment', se.payment_initiation_rpc IS NOT NULL,
        'has_guided_form', se.guided_form_key IS NOT NULL,
        'properties', COALESCE((
          SELECT jsonb_agg(p.obj ORDER BY p.column_name COLLATE "C", p.obj::text COLLATE "C")
          FROM (
            SELECT sp.column_name::text AS column_name,
                   jsonb_build_object(
                     'column_name', sp.column_name,
                     'data_type', sp.data_type,
                     'udt_name', sp.udt_name,
                     'is_nullable', sp.is_nullable,
                     'is_generated', sp.is_generated,
                     'is_identity', sp.is_identity,
                     'has_default', sp.column_default IS NOT NULL,
                     'join_schema', sp.join_schema,
                     'join_table', sp.join_table,
                     'join_column', sp.join_column,
                     'geography_type', sp.geography_type,
                     'status_entity_type', sp.status_entity_type,
                     'category_entity_type', sp.category_entity_type,
                     'is_recurring', sp.is_recurring
                   ) AS obj
            FROM public.schema_properties sp
            WHERE sp.table_name = se.table_name
          ) p
        ), '[]'::jsonb),
        'm2m', COALESCE((
          SELECT jsonb_agg(m.column_name::text ORDER BY m.column_name::text COLLATE "C")
          FROM public.schema_m2m_properties m
          WHERE m.table_name = se.table_name
        ), '[]'::jsonb),
        'actions', COALESCE((
          SELECT jsonb_agg(a.obj ORDER BY a.action_name COLLATE "C")
          FROM (
            SELECT sa.action_name::text AS action_name,
                   jsonb_build_object(
                     'action_name', sa.action_name,
                     'params', COALESCE((
                       SELECT jsonb_agg(
                                jsonb_build_object('param_name', pr.param_name,
                                                   'param_type', pr.param_type,
                                                   'required', pr.required)
                                ORDER BY pr.param_name COLLATE "C")
                       FROM json_to_recordset(sa.parameters)
                            AS pr(param_name text, param_type text, required boolean)
                     ), '[]'::jsonb)
                   ) AS obj
            FROM public.schema_entity_actions sa
            WHERE sa.table_name = se.table_name
          ) a
        ), '[]'::jsonb)
      ) AS obj
    FROM public.schema_entities se
  ) e;

  RETURN 'sha256:' || encode(
           plugins.digest(convert_to(v_contract::text, 'UTF8'), 'sha256'),
           'hex');
END;
$$;

COMMENT ON FUNCTION metadata.schema_contract_hash() IS
    'sha256 over the canonical JSON of the typed-codegen contract (entities, properties, M:M, actions). Identical for every role and locale; excludes status/category rows, permissions and presentation. Field list: see the comment at the top of the function source. Added in v0.77.0.';

REVOKE EXECUTE ON FUNCTION metadata.schema_contract_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metadata.schema_contract_hash() TO web_anon, authenticated;

-- ============================================================================
-- 5. public.schema_domain_version
-- ============================================================================

CREATE VIEW public.schema_domain_version
WITH (security_invoker = true) AS
SELECT
    metadata.framework_version() AS framework_version,
    d.domain_version,
    d.min_client_domain_version,
    d.set_by_migration,
    d.decision_id,
    metadata.schema_contract_hash() AS contract_hash
FROM metadata.domain_version d;

COMMENT ON VIEW public.schema_domain_version IS
    'Framework version, domain version, minimum client domain version, the migration and ADR that set it, and the schema contract hash. Read by clients at bootstrap. Added in v0.77.0.';

GRANT SELECT ON public.schema_domain_version TO web_anon, authenticated;

-- ============================================================================
-- 6. public.set_domain_version()
-- ============================================================================
-- SQLSTATEs: 42501 not admin; 22023 malformed version or a floor above the version;
-- 23502 no decision given; 23503 decision does not exist; 23505 decision already linked to another version.

CREATE FUNCTION public.set_domain_version(
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
    '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$';
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

REVOKE EXECUTE ON FUNCTION public.set_domain_version(TEXT, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_domain_version(TEXT, TEXT, TEXT, INT) TO authenticated;

-- ============================================================================
-- 7. Reload PostgREST schema cache
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
