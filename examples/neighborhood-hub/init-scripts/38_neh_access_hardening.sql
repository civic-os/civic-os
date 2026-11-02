-- 38_neh_access_hardening.sql
-- Neighborhood Hub example: row-level security on every table, staff-only borrower writes,
-- no anonymous access to personal data, and the wiring that goes with them.
--
-- Run after 37_revoke_public_execute.sql, which holds the role guards on the workflow RPCs.
--
--   1. Tighten the "user" role: table-wide permissions a has_permission policy would honor
--   2. Revoke anonymous access to everything that is not public reference data
--   3. Enable RLS, staff tier by permission, owner tier by borrower
--   4. Grants that staff writes need once the tables go through RLS
--   5. Action roles for Approve Request on building use requests
--   6. Require a timeslot when a tool reservation or event kit request is submitted
--   7. Indexes on foreign key columns
--   8. Portable action conditions, by status_key rather than numeric status id
--   9. Event kit submit for borrowers
--  10. Schema decision (ADR)
--
-- Borrowers read their own record and do not write it: status_id is what check_borrower_approved
-- relies on, so a borrower must never be able to set it. Staff keep the waiver and proof of
-- address uploads. SECURITY DEFINER RPCs run as the table owner, and with FORCE ROW LEVEL SECURITY
-- off they bypass these policies, so no owner UPDATE policy is needed for the workflow.
--
-- Safe to re-run.

BEGIN;

-- ===========================================================================
-- 1. Tighten the "user" role
-- Every signed-in user holds "user", so a row in this list would satisfy the staff tier below for
-- all rows. Same loop as script 35 part B. Kept on purpose: user read on tool_instances,
-- tool_types, projects, project_parcels and building_use_rooms, because INVOKER triggers and
-- option RPCs read them as the caller.
-- ===========================================================================

DO $$
DECLARE
  v_user_role_id INT;
  v_perm_id INT;
BEGIN
  SELECT id INTO v_user_role_id FROM metadata.roles WHERE role_key = 'user';
  IF v_user_role_id IS NULL THEN
    RAISE NOTICE 'No user role found, skipping permission tightening';
    RETURN;
  END IF;

  FOR v_perm_id IN
    SELECT p.id FROM metadata.permissions p
    WHERE (p.table_name = 'borrowers' AND p.permission IN ('read', 'update'))
       OR (p.table_name IN ('borrowers:notes', 'tool_instances:notes') AND p.permission = 'read')
       OR (p.table_name IN ('tool_reservation_checkouts', 'training_records') AND p.permission = 'read')
  LOOP
    DELETE FROM metadata.permission_roles
    WHERE role_id = v_user_role_id AND permission_id = v_perm_id;
  END LOOP;
END;
$$;

-- ===========================================================================
-- 2. Anonymous access
-- parcels, tool_types and census_block_groups stay public reference data.
-- ===========================================================================

REVOKE SELECT ON public.borrowers FROM web_anon;
REVOKE SELECT ON public.training_records FROM web_anon;
REVOKE SELECT ON public.tool_reservation_checkouts FROM web_anon;
REVOKE SELECT ON public.tool_instances FROM web_anon;
REVOKE SELECT ON public.projects FROM web_anon;
REVOKE SELECT ON public.project_parcels FROM web_anon;
REVOKE SELECT ON public.building_use_rooms FROM web_anon;

-- These two kept web_anon through script 37. Revoking web_anon alone would be a no-op while the
-- default PUBLIC entry remains, so both go. The explicit authenticated grants stay.
REVOKE EXECUTE ON FUNCTION public.get_approved_borrowers(text, jsonb) FROM PUBLIC, web_anon;
REVOKE EXECUTE ON FUNCTION public.get_room_options(text, jsonb) FROM PUBLIC, web_anon;

-- ===========================================================================
-- 3. Row-level security
-- One policy per operation. The (SELECT ...) wrapper makes has_permission an InitPlan evaluated
-- once per query: it is SECURITY DEFINER and not inlined, so a bare call would run per row across
-- the full parcel table.
-- ===========================================================================

DO $$
DECLARE
  v_table TEXT;
  v_select_roles TEXT;
  v_policy TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'borrowers', 'training_records', 'tool_reservation_checkouts',
    'tool_instances', 'projects', 'project_parcels', 'building_use_rooms',
    'parcels', 'tool_types', 'census_block_groups'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);

    FOREACH v_policy IN ARRAY ARRAY['rbac_select', 'rbac_insert', 'rbac_update', 'rbac_delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_policy, v_table);
    END LOOP;

    v_select_roles := CASE
      WHEN v_table IN ('parcels', 'tool_types', 'census_block_groups') THEN 'web_anon, authenticated'
      ELSE 'authenticated'
    END;

    EXECUTE format(
      'CREATE POLICY rbac_select ON public.%I FOR SELECT TO %s USING ((SELECT has_permission(%L, ''read'')))',
      v_table, v_select_roles, v_table);
    EXECUTE format(
      'CREATE POLICY rbac_insert ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT has_permission(%L, ''create'')))',
      v_table, v_table);
    EXECUTE format(
      'CREATE POLICY rbac_update ON public.%I FOR UPDATE TO authenticated USING ((SELECT has_permission(%L, ''update'')))',
      v_table, v_table);
    EXECUTE format(
      'CREATE POLICY rbac_delete ON public.%I FOR DELETE TO authenticated USING ((SELECT has_permission(%L, ''delete'')))',
      v_table, v_table);
  END LOOP;
END;
$$;

-- Owner tier: read-only. No owner UPDATE on borrowers, see the header.
DROP POLICY IF EXISTS owner_select ON public.borrowers;
CREATE POLICY owner_select ON public.borrowers
  FOR SELECT TO authenticated
  USING (user_id = (SELECT current_user_id()));

DROP POLICY IF EXISTS owner_select ON public.training_records;
CREATE POLICY owner_select ON public.training_records
  FOR SELECT TO authenticated
  USING (borrower_id = (SELECT current_borrower_id()));

-- tool_reservations has its own RLS, so this EXISTS is also bound by the caller's parent access.
DROP POLICY IF EXISTS owner_select ON public.tool_reservation_checkouts;
CREATE POLICY owner_select ON public.tool_reservation_checkouts
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.tool_reservations tr
    WHERE tr.id = tool_reservation_checkouts.tool_reservation_id
      AND tr.created_by = (SELECT current_user_id())
  ));

-- ===========================================================================
-- 4. Grants that staff writes depend on
-- ===========================================================================

GRANT USAGE, SELECT ON SEQUENCE public.borrowers_id_seq TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.building_use_rooms TO authenticated;

-- ===========================================================================
-- 5. Action roles
-- Same role set as Deny Request, and as the guard inside approve_building_use_request.
-- ===========================================================================

INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'building_use_requests'
  AND ea.action_name = 'approve_request'
  AND r.role_key IN ('neh_staff', 'neh_admin', 'admin')
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- 6. Guided form enforcement
-- rebuild_guided_form_constraints adds a wfcheck that exempts drafts. On a table with rows it adds
-- it NOT VALID, so existing rows are not re-checked.
-- ===========================================================================

INSERT INTO metadata.validations (table_name, column_name, validation_type, error_message, sort_order)
VALUES
  ('tool_reservations', 'timeslot', 'required', 'Choose a pickup and return time.', 10),
  ('mek_requests', 'timeslot', 'required', 'Choose a pickup and return time.', 10)
ON CONFLICT (table_name, column_name, validation_type) DO NOTHING;

SELECT metadata.rebuild_guided_form_constraints('tool_reservations');
SELECT metadata.rebuild_guided_form_constraints('mek_requests');

-- ===========================================================================
-- 7. Foreign key indexes
-- ===========================================================================

CREATE INDEX IF NOT EXISTS idx_borrowers_status_id ON public.borrowers(status_id);
CREATE INDEX IF NOT EXISTS idx_borrowers_photo_id ON public.borrowers(photo_id);
CREATE INDEX IF NOT EXISTS idx_borrowers_address_proof ON public.borrowers(address_proof);
CREATE INDEX IF NOT EXISTS idx_borrowers_liability_waiver ON public.borrowers(liability_waiver);
CREATE INDEX IF NOT EXISTS idx_building_use_requests_group_type ON public.building_use_requests(group_type);
CREATE INDEX IF NOT EXISTS idx_tool_reservation_checkouts_checkout_photos ON public.tool_reservation_checkouts(checkout_photos);
CREATE INDEX IF NOT EXISTS idx_tool_reservation_checkouts_return_photos ON public.tool_reservation_checkouts(return_photos);

-- ===========================================================================
-- 8. Portable action conditions
-- Numeric status ids differ between environments. Same change script 36 made for Deny Request.
-- ===========================================================================

UPDATE metadata.entity_actions ea
SET visibility_condition = c.condition,
    enabled_condition = c.condition
FROM (VALUES
  ('tool_reservations', 'approve',       '{"field": "workflow_status_id.status_key", "value": "pending", "operator": "eq"}'::jsonb),
  ('tool_reservations', 'deny',          '{"field": "workflow_status_id.status_key", "value": "pending", "operator": "eq"}'::jsonb),
  ('tool_reservations', 'check_out',     '{"field": "workflow_status_id.status_key", "value": "approved", "operator": "eq"}'::jsonb),
  ('tool_reservations', 'mark_returned', '{"field": "workflow_status_id.status_key", "value": "checked_out", "operator": "eq"}'::jsonb),
  ('tool_reservations', 'complete',      '{"field": "workflow_status_id.status_key", "value": "returned", "operator": "eq"}'::jsonb),
  ('tool_reservations', 'cancel',        '{"field": "workflow_status_id.status_key", "value": ["pending", "approved"], "operator": "in"}'::jsonb),
  ('mek_requests', 'approve',            '{"field": "status_id.status_key", "value": "pending", "operator": "eq"}'::jsonb),
  ('mek_requests', 'deny_request',       '{"field": "status_id.status_key", "value": "pending", "operator": "eq"}'::jsonb),
  ('mek_requests', 'check_out',          '{"field": "status_id.status_key", "value": "approved", "operator": "eq"}'::jsonb),
  ('mek_requests', 'complete',           '{"field": "status_id.status_key", "value": "returned", "operator": "eq"}'::jsonb),
  ('mek_requests', 'cancel',             '{"field": "status_id.status_key", "value": ["pending", "approved"], "operator": "in"}'::jsonb)
) AS c(table_name, action_name, condition)
WHERE ea.table_name = c.table_name::name
  AND ea.action_name = c.action_name;

-- ===========================================================================
-- 9. Event kit submit for borrowers
-- submit_guided_form sets submitted_at right after this RPC returns. Setting it here
-- too made that second UPDATE hit block_submitted_update, so only roles with
-- mek_requests update permission could submit. Same as submit_tool_reservation,
-- which leaves submitted_at to the framework.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_mek_request(p_parent_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, metadata, pg_catalog
AS $$
DECLARE
    v_pending_status_id INT;
BEGIN
    -- Validate at least one equipment item selected
    IF NOT EXISTS (
        SELECT 1 FROM mek_request_equipment_items mrei
        JOIN mek_request_equipment mre ON mre.id = mrei.mek_request_equipment_id
        WHERE mre.mek_request_id = p_parent_id
    ) THEN
        RAISE EXCEPTION 'At least one equipment item must be selected before submitting.';
    END IF;

    SELECT id INTO v_pending_status_id
    FROM metadata.statuses
    WHERE entity_type = 'mek_requests' AND status_key = 'pending';

    UPDATE public.mek_requests
       SET status_id = v_pending_status_id,
           display_name = CASE
               WHEN display_name LIKE '% - Submitted' THEN display_name
               ELSE COALESCE(display_name, 'Event Kit Request') || ' - Submitted'
           END
     WHERE id = p_parent_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Your event kit request has been submitted for review.',
        'navigate_to', '/view/mek_requests/' || p_parent_id
    );
END;
$$;

-- ===========================================================================
-- 10. Schema decision (ADR)
-- Direct INSERT because init scripts run without JWT context.
-- ===========================================================================

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['borrowers', 'training_records', 'tool_reservation_checkouts', 'tool_instances',
          'projects', 'project_parcels', 'building_use_rooms', 'parcels', 'tool_types',
          'census_block_groups']::NAME[],
    'neh-38-access-hardening',
    'RLS on every table, staff-only borrower writes',
    'accepted',
    'Every table now has RLS: one policy per operation from has_permission, as an InitPlan, plus an '
    'owner read tier on borrowers, training_records and tool_reservation_checkouts. Borrowers read '
    'their own record and do not write it; staff upload waivers and proof of address. The user role '
    'lost its table-wide permissions on those tables. Anonymous access is limited to parcels, '
    'tool_types and census_block_groups. Action conditions use status_key, and a timeslot is '
    'required at submit for tool and event kit requests. submit_mek_request no longer sets '
    'submitted_at.',
    'status_id on borrowers gates tool reservations through check_borrower_approved, so a borrower '
    'who can write their own row can approve themselves. Every signed-in user holds the user role, '
    'so its table-wide permissions would have satisfied a staff policy for all rows. '
    'submit_guided_form sets submitted_at after the on-submit RPC returns, and setting it inside '
    'the RPC tripped block_submitted_update for borrowers, who hold no update permission on '
    'mek_requests.',
    'Borrowers cannot correct their own profile: phone, address and photo changes go through staff. '
    'Borrowers lose read of notes on their own record. Staff writes depend on the permission rows '
    'and on the role guards in script 37. A new table needs its own policies, since nothing here '
    'applies them automatically.',
    CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions WHERE migration_id = 'neh-38-access-hardening'
);

NOTIFY pgrst, 'reload schema';

COMMIT;
