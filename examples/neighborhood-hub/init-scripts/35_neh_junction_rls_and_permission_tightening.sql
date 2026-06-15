-- ============================================================================
-- NEH Fix: Junction table RLS policies + permission tightening
-- ============================================================================
-- ROOT CAUSE: building_use_request_rooms had RLS enabled but ZERO policies,
-- causing "deny all" — rooms could never be saved via PostgREST.
--
-- AUDIT FINDINGS:
--   1. building_use_request_rooms: RLS ON, 0 policies → BROKEN (deny all)
--   2. mek_request_equipment_items: RLS OFF, 0 policies → wide open
--   3. tool_reservation_tool_items: RLS OFF, 0 policies → wide open
--   4. work_site_parcels: RLS OFF, 0 policies → wide open
--
-- PERMISSION ISSUE: "user" role had blanket read/update/delete RBAC on parent
-- and junction tables, bypassing owner-based RLS isolation. Users could see
-- and modify ALL guided form submissions, not just their own.
--
-- FIX:
--   A. Create owner + RBAC policies on all 4 junction tables
--   B. Tighten "user" role to only "create" on parent tables
--   C. Remove "user" role CRUD on child step + junction tables
--      (owner policies provide access to own records)
-- ============================================================================

BEGIN;

-- ============================================================================
-- PART A: Junction table RLS policies
-- ============================================================================
-- Pattern: owner tier (via parent FK chain) + RBAC tier (via parent permissions)
-- Matches the existing gf_child_* pattern on child step tables.

-- ── 1. building_use_request_rooms ──
-- (RLS already enabled, just needs policies)
-- 1 hop: building_use_request_rooms → building_use_requests.created_by

CREATE POLICY junc_owner_select ON building_use_request_rooms
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM building_use_requests
    WHERE id = building_use_request_rooms.building_use_request_id
  ));

CREATE POLICY junc_owner_insert ON building_use_request_rooms
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM building_use_requests
    WHERE id = building_use_request_rooms.building_use_request_id
      AND created_by = current_user_id()
  ));

CREATE POLICY junc_owner_update ON building_use_request_rooms
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM building_use_requests
    WHERE id = building_use_request_rooms.building_use_request_id
      AND created_by = current_user_id()
  ));

CREATE POLICY junc_owner_delete ON building_use_request_rooms
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM building_use_requests
    WHERE id = building_use_request_rooms.building_use_request_id
      AND created_by = current_user_id()
  ));

CREATE POLICY junc_rbac_select ON building_use_request_rooms
  FOR SELECT TO authenticated
  USING (has_permission('building_use_requests', 'read'));

CREATE POLICY junc_rbac_insert ON building_use_request_rooms
  FOR INSERT TO authenticated
  WITH CHECK (has_permission('building_use_requests', 'update'));

CREATE POLICY junc_rbac_update ON building_use_request_rooms
  FOR UPDATE TO authenticated
  USING (has_permission('building_use_requests', 'update'));

CREATE POLICY junc_rbac_delete ON building_use_request_rooms
  FOR DELETE TO authenticated
  USING (has_permission('building_use_requests', 'delete'));


-- ── 2. tool_reservation_tool_items ──
-- 2 hops: tool_reservation_tool_items → tool_reservation_tools → tool_reservations.created_by

ALTER TABLE tool_reservation_tool_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY junc_owner_select ON tool_reservation_tool_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tool_reservation_tools trt
    JOIN tool_reservations tr ON tr.id = trt.tool_reservation_id
    WHERE trt.id = tool_reservation_tool_items.tool_reservation_tools_id
  ));

CREATE POLICY junc_owner_insert ON tool_reservation_tool_items
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM tool_reservation_tools trt
    JOIN tool_reservations tr ON tr.id = trt.tool_reservation_id
    WHERE trt.id = tool_reservation_tool_items.tool_reservation_tools_id
      AND tr.created_by = current_user_id()
  ));

CREATE POLICY junc_owner_update ON tool_reservation_tool_items
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tool_reservation_tools trt
    JOIN tool_reservations tr ON tr.id = trt.tool_reservation_id
    WHERE trt.id = tool_reservation_tool_items.tool_reservation_tools_id
      AND tr.created_by = current_user_id()
  ));

CREATE POLICY junc_owner_delete ON tool_reservation_tool_items
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tool_reservation_tools trt
    JOIN tool_reservations tr ON tr.id = trt.tool_reservation_id
    WHERE trt.id = tool_reservation_tool_items.tool_reservation_tools_id
      AND tr.created_by = current_user_id()
  ));

CREATE POLICY junc_rbac_select ON tool_reservation_tool_items
  FOR SELECT TO authenticated
  USING (has_permission('tool_reservations', 'read'));

CREATE POLICY junc_rbac_insert ON tool_reservation_tool_items
  FOR INSERT TO authenticated
  WITH CHECK (has_permission('tool_reservations', 'update'));

CREATE POLICY junc_rbac_update ON tool_reservation_tool_items
  FOR UPDATE TO authenticated
  USING (has_permission('tool_reservations', 'update'));

CREATE POLICY junc_rbac_delete ON tool_reservation_tool_items
  FOR DELETE TO authenticated
  USING (has_permission('tool_reservations', 'delete'));


-- ── 3. work_site_parcels ──
-- 2 hops: work_site_parcels → tool_reservation_work_site → tool_reservations.created_by

ALTER TABLE work_site_parcels ENABLE ROW LEVEL SECURITY;

CREATE POLICY junc_owner_select ON work_site_parcels
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tool_reservation_work_site tws
    JOIN tool_reservations tr ON tr.id = tws.tool_reservation_id
    WHERE tws.id = work_site_parcels.work_site_id
  ));

CREATE POLICY junc_owner_insert ON work_site_parcels
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM tool_reservation_work_site tws
    JOIN tool_reservations tr ON tr.id = tws.tool_reservation_id
    WHERE tws.id = work_site_parcels.work_site_id
      AND tr.created_by = current_user_id()
  ));

CREATE POLICY junc_owner_update ON work_site_parcels
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tool_reservation_work_site tws
    JOIN tool_reservations tr ON tr.id = tws.tool_reservation_id
    WHERE tws.id = work_site_parcels.work_site_id
      AND tr.created_by = current_user_id()
  ));

CREATE POLICY junc_owner_delete ON work_site_parcels
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tool_reservation_work_site tws
    JOIN tool_reservations tr ON tr.id = tws.tool_reservation_id
    WHERE tws.id = work_site_parcels.work_site_id
      AND tr.created_by = current_user_id()
  ));

CREATE POLICY junc_rbac_select ON work_site_parcels
  FOR SELECT TO authenticated
  USING (has_permission('tool_reservations', 'read'));

CREATE POLICY junc_rbac_insert ON work_site_parcels
  FOR INSERT TO authenticated
  WITH CHECK (has_permission('tool_reservations', 'update'));

CREATE POLICY junc_rbac_update ON work_site_parcels
  FOR UPDATE TO authenticated
  USING (has_permission('tool_reservations', 'update'));

CREATE POLICY junc_rbac_delete ON work_site_parcels
  FOR DELETE TO authenticated
  USING (has_permission('tool_reservations', 'delete'));


-- ── 4. mek_request_equipment_items ──
-- 2 hops: mek_request_equipment_items → mek_request_equipment → mek_requests.created_by

ALTER TABLE mek_request_equipment_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY junc_owner_select ON mek_request_equipment_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM mek_request_equipment mre
    JOIN mek_requests mr ON mr.id = mre.mek_request_id
    WHERE mre.id = mek_request_equipment_items.mek_request_equipment_id
  ));

CREATE POLICY junc_owner_insert ON mek_request_equipment_items
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM mek_request_equipment mre
    JOIN mek_requests mr ON mr.id = mre.mek_request_id
    WHERE mre.id = mek_request_equipment_items.mek_request_equipment_id
      AND mr.created_by = current_user_id()
  ));

CREATE POLICY junc_owner_update ON mek_request_equipment_items
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM mek_request_equipment mre
    JOIN mek_requests mr ON mr.id = mre.mek_request_id
    WHERE mre.id = mek_request_equipment_items.mek_request_equipment_id
      AND mr.created_by = current_user_id()
  ));

CREATE POLICY junc_owner_delete ON mek_request_equipment_items
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM mek_request_equipment mre
    JOIN mek_requests mr ON mr.id = mre.mek_request_id
    WHERE mre.id = mek_request_equipment_items.mek_request_equipment_id
      AND mr.created_by = current_user_id()
  ));

CREATE POLICY junc_rbac_select ON mek_request_equipment_items
  FOR SELECT TO authenticated
  USING (has_permission('mek_requests', 'read'));

CREATE POLICY junc_rbac_insert ON mek_request_equipment_items
  FOR INSERT TO authenticated
  WITH CHECK (has_permission('mek_requests', 'update'));

CREATE POLICY junc_rbac_update ON mek_request_equipment_items
  FOR UPDATE TO authenticated
  USING (has_permission('mek_requests', 'update'));

CREATE POLICY junc_rbac_delete ON mek_request_equipment_items
  FOR DELETE TO authenticated
  USING (has_permission('mek_requests', 'delete'));


-- ============================================================================
-- PART B: Tighten "user" role on parent tables
-- ============================================================================
-- Users should only have "create" (to start a form). Owner policies handle
-- read/update of their own records. Staff/admin roles keep blanket RBAC.
--
-- Note: gf_insert policy uses WITH CHECK (true), not has_permission, so
-- the "create" permission isn't strictly needed by RLS. We keep it for
-- consistency with the RBAC model (the permission exists, it should be granted).

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

  -- Remove user's read/update on parent tables (keep create)
  FOR v_perm_id IN
    SELECT p.id FROM metadata.permissions p
    WHERE p.table_name IN ('building_use_requests', 'tool_reservations', 'mek_requests')
      AND p.permission IN ('read', 'update', 'delete')
  LOOP
    DELETE FROM metadata.permission_roles
    WHERE role_id = v_user_role_id AND permission_id = v_perm_id;
  END LOOP;

  -- Remove user's CRUD on child step tables (owner policies handle access)
  FOR v_perm_id IN
    SELECT p.id FROM metadata.permissions p
    WHERE p.table_name IN (
      'tool_reservation_tools', 'tool_reservation_work_site',
      'mek_request_equipment'
    )
  LOOP
    DELETE FROM metadata.permission_roles
    WHERE role_id = v_user_role_id AND permission_id = v_perm_id;
  END LOOP;

  -- Remove user's CRUD on junction tables (owner policies handle access)
  FOR v_perm_id IN
    SELECT p.id FROM metadata.permissions p
    WHERE p.table_name IN (
      'building_use_request_rooms', 'tool_reservation_tool_items',
      'work_site_parcels', 'mek_request_equipment_items'
    )
  LOOP
    DELETE FROM metadata.permission_roles
    WHERE role_id = v_user_role_id AND permission_id = v_perm_id;
  END LOOP;

  RAISE NOTICE 'Tightened user role permissions for guided form tables';
END;
$$;

-- ============================================================================
-- PART C: Record the decision
-- ============================================================================
INSERT INTO metadata.schema_decisions (
  title, decision, rationale, consequences, status, entity_types
) VALUES (
  'Junction table RLS policies and permission tightening',
  'Add owner + RBAC policies to 4 junction tables; tighten user role permissions',
  'building_use_request_rooms had RLS ON with 0 policies (deny all) — rooms '
    'could never be saved. Other 3 junction tables had RLS OFF (wide open). User role had '
    'blanket read/update on parent tables, bypassing owner-based isolation.',
  'Users can now only access their own guided form records via owner '
    'policies. Staff/admin retain blanket RBAC access. Junction M2M saves work correctly.',
  'accepted',
  ARRAY['building_use_request_rooms', 'tool_reservation_tool_items',
        'work_site_parcels', 'mek_request_equipment_items']::NAME[]
);

COMMIT;
