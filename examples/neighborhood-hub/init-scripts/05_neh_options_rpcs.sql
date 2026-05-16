-- Neighborhood Engagement Hub - RPC Functions
BEGIN;

-- Fake admin JWT context for managed PostgreSQL (no true superuser)
SET LOCAL request.jwt.claims = '{"sub":"init-script","realm_access":{"roles":["admin"]}}';

-- Function to get borrower for current user
CREATE OR REPLACE FUNCTION public.get_borrower_for_current_user()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
  SELECT id
  FROM public.borrowers
  WHERE user_id = current_user_id()
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_borrower_for_current_user() IS
  'Returns the borrower ID for the currently authenticated user.';

GRANT EXECUTE ON FUNCTION public.get_borrower_for_current_user() TO authenticated;

-- Function to get approved borrowers
CREATE OR REPLACE FUNCTION public.get_approved_borrowers(p_id TEXT DEFAULT NULL, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id BIGINT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT b.id, b.display_name::TEXT
    FROM borrowers b
    JOIN metadata.statuses s ON b.status_id = s.id
    WHERE s.entity_type = 'borrowers' AND s.status_key = 'approved'
    ORDER BY b.display_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_approved_borrowers TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_approved_borrowers TO web_anon;

-- Function to get available tool types (toolshed only — excludes event_kit items)
CREATE OR REPLACE FUNCTION public.get_available_tool_types(p_id TEXT DEFAULT NULL, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT tt.id, tt.display_name::TEXT
    FROM tool_types tt
    LEFT JOIN metadata.categories c ON tt.inventory_module_id = c.id
    LEFT JOIN tool_instances ti ON tt.id = ti.tool_type_id AND ti.status_id IN (
      SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service'
    )
    WHERE (c.category_key IS DISTINCT FROM 'event_kit')
      AND (tt.is_qty_managed = true OR ti.id IS NOT NULL)
    ORDER BY tt.display_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_available_tool_types TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_available_tool_types TO web_anon;

-- Function to get eligible parcels
CREATE OR REPLACE FUNCTION public.get_eligible_parcels_new(p_id TEXT DEFAULT NULL, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT p.id, p.display_name::TEXT
    FROM parcels p
    WHERE p.eligibility IN (
        SELECT id FROM metadata.categories
        WHERE entity_type = 'parcel_eligibility'
        AND category_key IN ('good', 'few_issues')
    )
    ORDER BY p.display_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_eligible_parcels_new TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_eligible_parcels_new TO web_anon;

-- Role-aware borrower dropdown: staff see all approved, borrowers see only themselves
CREATE OR REPLACE FUNCTION public.get_borrowers_for_reservation(p_id TEXT DEFAULT NULL, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id BIGINT, display_name TEXT)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
BEGIN
    -- Staff and admin see all approved borrowers
    IF 'neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin() THEN
        RETURN QUERY
            SELECT b.id, b.display_name::TEXT
            FROM borrowers b
            JOIN metadata.statuses s ON b.status_id = s.id
            WHERE s.entity_type = 'borrowers' AND s.status_key = 'approved'
            ORDER BY b.display_name;
    ELSE
        -- Borrowers see only their own record
        RETURN QUERY
            SELECT b.id, b.display_name::TEXT
            FROM borrowers b
            WHERE b.user_id = current_user_id();
    END IF;
END;
$$;

COMMENT ON FUNCTION public.get_borrowers_for_reservation(TEXT, JSONB) IS
    'Role-aware borrower dropdown: staff see all approved borrowers, borrowers see only themselves.';

GRANT EXECUTE ON FUNCTION public.get_borrowers_for_reservation(TEXT, JSONB) TO authenticated;

-- ============================================================================
-- GUIDED FORM RPCs (tool_reservation)
-- ============================================================================

-- Precondition: block form start if current user's borrower isn't approved
CREATE OR REPLACE FUNCTION public.check_borrower_approved(p_guided_form_key NAME)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_borrower_id BIGINT;
    v_status_key TEXT;
BEGIN
    -- Staff and admin bypass: they create reservations on behalf of borrowers
    IF 'neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin() THEN
        RETURN jsonb_build_object('success', true);
    END IF;

    SELECT b.id INTO v_borrower_id
    FROM borrowers b
    WHERE b.user_id = current_user_id();

    IF v_borrower_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'You must have a borrower account to request tools. Please contact NEH staff.'
        );
    END IF;

    SELECT s.status_key INTO v_status_key
    FROM borrowers b
    JOIN metadata.statuses s ON b.status_id = s.id
    WHERE b.id = v_borrower_id;

    IF v_status_key IS DISTINCT FROM 'approved' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Your borrower account must be approved before you can request tools. Current status: ' || COALESCE(v_status_key, 'pending')
        );
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;

COMMENT ON FUNCTION public.check_borrower_approved(NAME) IS
    'Precondition RPC for tool_reservation guided form. Blocks start if borrower is not approved.';

GRANT EXECUTE ON FUNCTION public.check_borrower_approved(NAME) TO authenticated;

-- On-submit: set status to Pending (staff notification fires via status_change trigger)
CREATE OR REPLACE FUNCTION public.submit_tool_reservation(p_parent_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, metadata, pg_catalog
AS $$
DECLARE
    v_pending_status_id INT;
BEGIN
    SELECT id INTO v_pending_status_id
    FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'pending';

    UPDATE public.tool_reservations
       SET status_id = v_pending_status_id,
           display_name = CASE
               WHEN display_name LIKE '% - Submitted' THEN display_name
               ELSE COALESCE(display_name, 'Tool Reservation') || ' - Submitted'
           END
     WHERE id = p_parent_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Your tool reservation has been submitted for review.',
        'navigate_to', '/view/tool_reservations/' || p_parent_id
    );
END;
$$;

COMMENT ON FUNCTION public.submit_tool_reservation(BIGINT) IS
    'On-submit RPC for tool_reservation guided form. Sets status to Pending and appends Submitted to display_name.';

GRANT EXECUTE ON FUNCTION public.submit_tool_reservation(BIGINT) TO authenticated;

-- ============================================================================
-- GUIDED FORM REGISTRATION (tool_reservation)
-- ============================================================================

-- Unregister existing guided form first to allow parameter changes on re-runs
DELETE FROM metadata.guided_form_progress WHERE guided_form_key = 'tool_reservation';
DELETE FROM metadata.guided_form_step_conditions WHERE guided_form_step_id IN (
    SELECT id FROM metadata.guided_form_steps WHERE guided_form_key = 'tool_reservation'
);
DELETE FROM metadata.guided_form_steps WHERE guided_form_key = 'tool_reservation';
UPDATE metadata.entities SET guided_form_key = NULL WHERE guided_form_key = 'tool_reservation';
DELETE FROM metadata.guided_forms WHERE guided_form_key = 'tool_reservation';

-- Remove stale triggers (will be recreated by register_guided_form)
DROP TRIGGER IF EXISTS trg_block_submitted_update ON public.tool_reservations;
DROP TRIGGER IF EXISTS trg_guided_form_lock ON public.tool_reservations;

DO $$DECLARE v_result JSONB; BEGIN
    v_result := public.register_guided_form(
        'tool_reservation'::name,
        'tool_reservations'::name,
        'Reserve tools for neighborhood work.'::text,
        'submit_tool_reservation'::name,           -- on_submit_rpc
        'Reservation Details'::varchar,
        'Review your tool selections and work site before submitting.'::text,
        TRUE,                                      -- lock_on_submit
        'check_borrower_approved'::name            -- precondition_rpc
    );
    IF NOT (v_result->>'success')::boolean THEN
        RAISE EXCEPTION 'register_guided_form failed: %', v_result->>'message';
    END IF;
END $$;

-- Step 1: Tool selection (required — must pick at least one tool)
SELECT public.add_guided_form_step(
    'tool_reservation'::name,
    'tools'::name,
    'Select Tools'::varchar,
    1,
    'tool_reservation_tools'::name,
    'tool_reservation_id'::name,
    'Choose which tools you need for your project.'::text,
    FALSE   -- can_skip = FALSE
);

-- Step 2: Work site (optional — parcels not required for all jobs)
SELECT public.add_guided_form_step(
    'tool_reservation'::name,
    'work_site'::name,
    'Work Site'::varchar,
    2,
    'tool_reservation_work_site'::name,
    'tool_reservation_id'::name,
    'Select the parcels where you will use the tools.'::text,
    TRUE    -- can_skip = TRUE
);

-- Guided form permissions
-- Admin: full access
SELECT public.grant_guided_form_permissions('tool_reservation', (SELECT id FROM metadata.roles WHERE role_key = 'admin'), ARRAY['read', 'create', 'update', 'delete']);
-- NEH Admin: full access
SELECT public.grant_guided_form_permissions('tool_reservation', (SELECT id FROM metadata.roles WHERE role_key = 'neh_admin'), ARRAY['read', 'create', 'update', 'delete']);
-- NEH Staff: full access
SELECT public.grant_guided_form_permissions('tool_reservation', (SELECT id FROM metadata.roles WHERE role_key = 'neh_staff'), ARRAY['read', 'create', 'update', 'delete']);
-- NEH Borrower: create (start guided form); sees/edits own records via ownership RLS
SELECT public.grant_guided_form_permissions('tool_reservation', (SELECT id FROM metadata.roles WHERE role_key = 'neh_borrower'), ARRAY['create']);

-- ============================================================================
-- BULK ENRICHMENT RPCs
-- ============================================================================

-- Enrich parcels with LMI status based on spatial intersection with census block groups.
-- Resolves boundary-straddling parcels via centroid tiebreaker, then largest overlap area.
-- Clears stale LMI status for parcels no longer matching any block group.
CREATE OR REPLACE FUNCTION public.enrich_parcels_lmi_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, postgis, pg_temp
AS $$
DECLARE
  v_updated INT;
  v_cleared INT;
BEGIN
  -- Gate on parcels:update permission to prevent expensive spatial joins by unauthorized users
  IF NOT public.has_permission('parcels', 'update') THEN
    RAISE EXCEPTION 'Permission denied: parcels update required'
      USING ERRCODE = '42501';
  END IF;

  -- Update parcels that intersect a block group.
  -- DISTINCT ON + centroid tiebreaker handles parcels straddling boundaries:
  --   1. Prefer block group whose polygon contains the parcel's centroid
  --   2. Fall back to largest intersection area
  WITH best_match AS (
    SELECT DISTINCT ON (p.id) p.id AS parcel_id, cbg.lmi_status
    FROM parcels p
    JOIN census_block_groups cbg
      ON ST_Intersects(p.boundary, cbg.boundary)
    ORDER BY p.id,
      ST_Contains(cbg.boundary::geometry, ST_Centroid(p.boundary::geometry)) DESC,
      ST_Area(ST_Intersection(p.boundary::geometry, cbg.boundary::geometry)) DESC
  )
  UPDATE parcels p
  SET lmi_status = bm.lmi_status
  FROM best_match bm
  WHERE p.id = bm.parcel_id
    AND p.lmi_status IS DISTINCT FROM bm.lmi_status;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Clear stale LMI status for parcels no longer matching any block group
  WITH matched_ids AS (
    SELECT DISTINCT p.id
    FROM parcels p
    JOIN census_block_groups cbg
      ON ST_Intersects(p.boundary, cbg.boundary)
  )
  UPDATE parcels
  SET lmi_status = NULL
  WHERE lmi_status IS NOT NULL
    AND id NOT IN (SELECT id FROM matched_ids);

  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'updated', v_updated,
    'cleared', v_cleared,
    'message', format('%s parcels enriched, %s cleared', v_updated, v_cleared)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.enrich_parcels_lmi_status() TO authenticated;

COMMIT;
