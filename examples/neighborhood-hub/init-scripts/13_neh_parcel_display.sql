-- Neighborhood Engagement Hub - Parcel Display, Land Bank Category & Role Consolidation
-- 1. Rewrites default dashboard with NEH mission and login prompt
-- 2. Hides address component columns from list view
-- 3. Converts display_name to a generated column that includes zip code
-- 4. Converts land_bank_owned boolean to a Category (red/green badges)
-- 5. Collapses neh_borrower role into user (single-purpose instance)
-- 6. Records architectural decisions (ADRs) for scripts 12 and 13
BEGIN;

SET LOCAL request.jwt.claims = '{"sub":"init-script","realm_access":{"roles":["admin"]}}';
SET LOCAL search_path = public, metadata, postgis, pg_temp;

-- ============================================================================
-- 1. Rewrite default dashboard with NEH mission + login prompt
--    The core migration creates a generic "Welcome to Civic OS" dashboard.
--    Replace it with instance-specific content for anonymous visitors.
-- ============================================================================

UPDATE metadata.dashboards
SET display_name = 'Neighborhood Engagement Hub',
    description  = 'Public landing page with NEH mission and services overview',
    show_title   = false
WHERE is_default = true;

UPDATE metadata.dashboard_widgets
SET config = jsonb_build_object('content',
'# Neighborhood Engagement Hub

**Empowering Flint residents to strengthen their neighborhoods — one project at a time.**

The Neighborhood Engagement Hub provides free access to tools, building space, and event resources for community members working to improve their neighborhoods.

---

## What You Can Do

**Borrow Tools** — Our lending library includes over 80 types of tools for home repair, yard maintenance, and improvement projects. From power drills to pressure washers, we have what you need to get the job done.

**Reserve Building Space** — Book rooms at the Hub for meetings, classes, workshops, or community events.

**Request a Mobile Event Kit** — Planning a block party or community gathering? Borrow pre-packaged event equipment including tables, chairs, tents, and sound systems.

---

## Get Started

Sign in to your account to start making requests. New to the Hub? Create an account and our staff will get you set up.

Once approved, you can browse available tools, reserve what you need, book rooms, and track all your requests from your personal dashboard.',
'enableHtml', false)
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE is_default = true);

-- ============================================================================
-- 2. Hide address components from list view
-- ============================================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, show_on_list, filterable)
VALUES
  ('parcels', 'prop_num',    'Property Number', false, false),
  ('parcels', 'prop_dir',    'Direction',       false, false),
  ('parcels', 'prop_street', 'Street',          false, false),
  ('parcels', 'prop_city',   'City',            false, false),
  ('parcels', 'prop_zip',    'Zip Code',        false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    show_on_list = EXCLUDED.show_on_list,
    filterable = EXCLUDED.filterable;

-- ============================================================================
-- 3. Convert display_name to generated column with zip code
--    Before: "928 MC QUEEN ST"
--    After:  "928 MC QUEEN ST 48503"
--
--    Must drop civic_os_text_search first (it references display_name),
--    then drop display_name, re-add both as generated columns.
-- ============================================================================

-- 3a. Drop generated columns that depend on display_name
ALTER TABLE parcels DROP COLUMN IF EXISTS civic_os_text_search;

-- 3b. Convert display_name from static to generated
--     Uses COALESCE(NULLIF(col, '') || ' ', '') pattern because CONCAT_WS
--     is STABLE (not IMMUTABLE) and cannot appear in generated columns.
ALTER TABLE parcels DROP COLUMN display_name;
ALTER TABLE parcels ADD COLUMN display_name VARCHAR(100) GENERATED ALWAYS AS (
    TRIM(
        COALESCE(NULLIF(prop_num, '') || ' ', '') ||
        COALESCE(NULLIF(prop_dir, '') || ' ', '') ||
        COALESCE(NULLIF(prop_street, '') || ' ', '') ||
        COALESCE(NULLIF(prop_zip, ''), '')
    )
) STORED;

-- 3c. Recreate text search column
--     Cannot reference display_name (generated->generated not allowed in PG),
--     so inline the address components directly.
ALTER TABLE parcels ADD COLUMN civic_os_text_search tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
        coalesce(prop_num, '') || ' ' ||
        coalesce(prop_dir, '') || ' ' ||
        coalesce(prop_street, '') || ' ' ||
        coalesce(prop_zip, '') || ' ' ||
        coalesce(parcel_search_tokens(parcel_number), ''))
) STORED;

CREATE INDEX IF NOT EXISTS idx_parcels_text_search ON parcels USING GIN(civic_os_text_search);

-- ============================================================================
-- 4. Convert land_bank_owned boolean to Category
--    Boolean is unintuitive: the "good" state (not land-bank-owned) renders
--    as an unchecked box — invisible. A Category gives red/green badges that
--    are immediately scannable on list pages.
-- ============================================================================

-- 4a. Register category group and values
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('parcel_land_bank', 'Land Bank Ownership')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('parcel_land_bank', 'Land Bank', 'land_bank',  '#ef4444', 1),  -- red
  ('parcel_land_bank', 'Private',   'private',    '#22c55e', 2)   -- green
ON CONFLICT (entity_type, display_name) DO NOTHING;

-- 4b. Add the FK column
ALTER TABLE parcels ADD COLUMN land_bank_status INTEGER REFERENCES metadata.categories(id);
CREATE INDEX idx_parcels_land_bank_status ON parcels(land_bank_status);

-- 4c. Migrate boolean data to category
UPDATE parcels SET land_bank_status = (
    SELECT id FROM metadata.categories
    WHERE entity_type = 'parcel_land_bank' AND category_key = 'land_bank'
) WHERE land_bank_owned = TRUE;

UPDATE parcels SET land_bank_status = (
    SELECT id FROM metadata.categories
    WHERE entity_type = 'parcel_land_bank' AND category_key = 'private'
) WHERE land_bank_owned = FALSE;

-- 4d. Drop old boolean column and its index
DROP INDEX IF EXISTS idx_parcels_land_bank_owned;
ALTER TABLE parcels DROP COLUMN land_bank_owned;

-- 4e. Update property metadata: remove boolean, add category
DELETE FROM metadata.properties
WHERE table_name = 'parcels' AND column_name = 'land_bank_owned';

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail, filterable)
VALUES ('parcels', 'land_bank_status', 'Land Bank', 13, true, false, false, true, true)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    sort_order = EXCLUDED.sort_order,
    show_on_list = EXCLUDED.show_on_list,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit,
    show_on_detail = EXCLUDED.show_on_detail,
    filterable = EXCLUDED.filterable;

-- 4f. Replace enrichment RPC with category-aware version
CREATE OR REPLACE FUNCTION public.enrich_parcels_land_bank(p_parcel_ids TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
  v_marked INT;
  v_cleared INT;
  v_lb_id INT;
  v_private_id INT;
BEGIN
  IF NOT public.has_permission('parcels', 'update') THEN
    RAISE EXCEPTION 'Permission denied: parcels update required'
      USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_lb_id FROM metadata.categories
  WHERE entity_type = 'parcel_land_bank' AND category_key = 'land_bank';
  SELECT id INTO v_private_id FROM metadata.categories
  WHERE entity_type = 'parcel_land_bank' AND category_key = 'private';

  -- Mark matching parcels as land-bank-owned
  UPDATE parcels
  SET land_bank_status = v_lb_id
  WHERE land_bank_status IS DISTINCT FROM v_lb_id
    AND SUBSTRING(parcel_number FROM 3) = ANY(p_parcel_ids);

  GET DIAGNOSTICS v_marked = ROW_COUNT;

  -- Mark non-matching parcels as private
  UPDATE parcels
  SET land_bank_status = v_private_id
  WHERE land_bank_status IS DISTINCT FROM v_private_id
    AND SUBSTRING(parcel_number FROM 3) != ALL(p_parcel_ids);

  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'marked', v_marked,
    'cleared', v_cleared,
    'message', format('%s parcels marked land bank, %s marked private', v_marked, v_cleared)
  );
END;
$$;

COMMENT ON FUNCTION public.enrich_parcels_land_bank(TEXT[]) IS
  'Bulk-update land_bank_status category on parcels. Accepts array of 10-digit GCLB parcel IDs (county prefix stripped). Non-matching parcels are marked private.';

-- 4g. Replace eligible parcels RPC with category-aware filter
CREATE OR REPLACE FUNCTION public.get_eligible_parcels_new(p_id TEXT DEFAULT NULL, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT p.id, p.display_name::TEXT
    FROM parcels p
    WHERE p.lmi_status = (
        SELECT c.id FROM metadata.categories c
        WHERE c.entity_type = 'lmi_status'
        AND c.category_key = 'lmi_qualified'
    )
    AND p.land_bank_status = (
        SELECT c.id FROM metadata.categories c
        WHERE c.entity_type = 'parcel_land_bank'
        AND c.category_key = 'private'
    )
    ORDER BY p.display_name;
$$;

-- ============================================================================
-- 5. Collapse neh_borrower role into user
--    Every authenticated user on this single-purpose NEH instance is a
--    borrower. The borrower auto-creation trigger (script 08) already fires
--    for all users regardless of role, so neh_borrower adds an unnecessary
--    manual Keycloak role assignment step during onboarding.
-- ============================================================================

-- 5a. Copy all 50 neh_borrower RBAC permissions to user role
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT pr.permission_id, (SELECT id FROM metadata.roles WHERE role_key = 'user')
FROM metadata.permission_roles pr
WHERE pr.role_id = (SELECT id FROM metadata.roles WHERE role_key = 'neh_borrower')
ON CONFLICT (permission_id, role_id) DO NOTHING;

-- 5b. Grant guided form create permissions to user role
--     (tool_reservation from script 05, building_use_request from 07,
--      mek_request from 11)
SELECT public.grant_guided_form_permissions(
    'tool_reservation',
    (SELECT id FROM metadata.roles WHERE role_key = 'user'),
    ARRAY['create']);
SELECT public.grant_guided_form_permissions(
    'building_use_request',
    (SELECT id FROM metadata.roles WHERE role_key = 'user'),
    ARRAY['create']);
SELECT public.grant_guided_form_permissions(
    'mek_request',
    (SELECT id FROM metadata.roles WHERE role_key = 'user'),
    ARRAY['create']);

-- 5c. Reassign borrower dashboard from neh_borrower to user
INSERT INTO metadata.dashboard_role_defaults (role_id, dashboard_id, priority)
SELECT (SELECT id FROM metadata.roles WHERE role_key = 'user'),
       drd.dashboard_id, drd.priority
FROM metadata.dashboard_role_defaults drd
WHERE drd.role_id = (SELECT id FROM metadata.roles WHERE role_key = 'neh_borrower')
ON CONFLICT (role_id) DO UPDATE
SET dashboard_id = EXCLUDED.dashboard_id,
    priority = EXCLUDED.priority;

-- 5d. Delete neh_borrower role
--     permission_roles FK lacks ON DELETE CASCADE (baseline v0.4.0),
--     so explicit cleanup is required before role deletion.
DELETE FROM metadata.permission_roles
WHERE role_id = (SELECT id FROM metadata.roles WHERE role_key = 'neh_borrower');

DELETE FROM metadata.dashboard_role_defaults
WHERE role_id = (SELECT id FROM metadata.roles WHERE role_key = 'neh_borrower');

DELETE FROM metadata.roles WHERE role_key = 'neh_borrower';

-- ============================================================================
-- 6. Schema Decisions (ADRs) for scripts 12 and 13
--    Uses direct INSERT (not create_schema_decision RPC) because init
--    scripts run without full JWT context.
-- ============================================================================

-- ADR 1: Genesee County parcel ID domain type (script 12)
INSERT INTO metadata.schema_decisions (
    entity_types, property_names, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
) VALUES (
    ARRAY['parcels']::NAME[], ARRAY['parcel_number']::NAME[], 'neh-12-patches',
    'Genesee County parcel ID domain type with segment-level search',
    'accepted',
    'Flint parcels use Genesee County''s 12-digit CC-TT-SS-BBB-PPP format (county-city-section-block-parcel). No US national parcel ID standard exists; each county defines its own APN format. Source data mixed hyphenated and digits-only representations.',
    'Created genesee_parcel_id domain (VARCHAR(12) CHECK digits-only), format_parcel_id() for hyphenated display, and parcel_search_tokens() emitting each segment individually for GIN-indexed full-text search.',
    'Domain type enforces data integrity at the column level. Storing digits-only simplifies cross-system matching (GCLB CSV uses 10-digit IDs = digits without county prefix). Segment-level tokens enable searching by any piece of the parcel ID. PostgreSQL english text config treats hyphens as token separators producing tokens like ''-40'', so segments must be emitted explicitly as separate space-delimited values.',
    'Existing data migrated in-place (strip hyphens, ALTER COLUMN to domain). Generated parcel_number_formatted column shows hyphenated display on list/detail; raw parcel_number shown on create/edit. tsvector includes full 12-digit, 10-digit GCLB prefix, 6-digit block+parcel, plus each individual CC/TT/SS/BBB/PPP segment.',
    '2026-05-14'
);

-- ADR 2: Land bank ownership enrichment (script 12, refined in 13)
INSERT INTO metadata.schema_decisions (
    entity_types, property_names, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
) VALUES (
    ARRAY['parcels']::NAME[], ARRAY['land_bank_status']::NAME[], 'neh-12-patches',
    'Genesee County Land Bank ownership as Category with embedded parcel ID list',
    'accepted',
    'GCLB (Genesee County Land Bank) owns ~12,133 parcels in Flint. Land bank parcels should be excluded from tool reservation work site selection since they are not eligible for private improvement work. A boolean flag is unintuitive: the "good" state (not land-bank-owned) is invisible — an unchecked checkbox with no color.',
    'Added land_bank_status as a Category (FK to metadata.categories) with red "Land Bank" and green "Private" values. Enrichment via enrich_parcels_land_bank(TEXT[]) RPC with all 12,133 GCLB IDs embedded in init script for reproducible deployment. Script 12 created the initial boolean; script 13 converted it to a Category.',
    'Categories render as colored badges on list/detail pages, making land bank status immediately scannable. Red/green coloring matches user intuition (green = good/eligible, red = restricted). GCLB publishes ownership data as a CSV with 10-digit parcel IDs (county prefix stripped). ID mapping: SUBSTRING(parcel_number FROM 3) matches GCLB format.',
    'get_eligible_parcels_new() RPC filters on land_bank_status = private (category) instead of NOT land_bank_owned (boolean). Parcel list page shows colored badges for ownership. Enrichment RPC uses category IDs, supporting future expansion (e.g., "Contested", "Pending Transfer").',
    '2026-05-14'
);

-- ADR 3: Display name as generated column (script 13)
INSERT INTO metadata.schema_decisions (
    entity_types, property_names, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
) VALUES (
    ARRAY['parcels']::NAME[], ARRAY['display_name']::NAME[], 'neh-13-display-roles',
    'Parcel display_name as generated column including zip code',
    'accepted',
    'Static display_name (populated by import script) showed address without zip code. Adding zip code improves identification of similarly-named streets across different zip codes within Flint.',
    'Converted display_name from static VARCHAR to GENERATED ALWAYS AS stored column concatenating prop_num, prop_dir, prop_street, and prop_zip with COALESCE/NULLIF space handling. Inlined address components in civic_os_text_search tsvector.',
    'CONCAT_WS is marked STABLE in PostgreSQL (not IMMUTABLE) and cannot appear in generated columns. The COALESCE(NULLIF(col, '''') || '' '', '''') pattern achieves equivalent space handling using only IMMUTABLE operators. PostgreSQL also prohibits generated columns from referencing other generated columns, so civic_os_text_search must inline address components directly.',
    'Import script no longer populates display_name (auto-generated from components). civic_os_text_search inlines address components alongside parcel_search_tokens(). Future address component changes automatically propagate to both display_name and the search index.',
    '2026-05-15'
);

-- ADR 4: Role collapse neh_borrower into user (script 13)
INSERT INTO metadata.schema_decisions (
    entity_types, property_names, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
) VALUES (
    ARRAY['borrowers', 'tool_reservations', 'building_use_requests', 'mek_requests']::NAME[],
    NULL, 'neh-13-display-roles',
    'Collapse neh_borrower role into user for single-purpose instance',
    'accepted',
    'The NEH is a single-purpose Civic OS instance where every authenticated user is a community member who borrows tools. The neh_borrower role was designed for multi-tenant scenarios where not all users are borrowers. The borrower auto-creation trigger (script 08) already fires for all users regardless of role assignment.',
    'Copied all 50 neh_borrower permission grants to the user role, reassigned guided form create permissions (tool_reservation, building_use_request, mek_request) and the borrower dashboard to user, then deleted the neh_borrower role entirely.',
    'Every authenticated user receives the user role automatically via JWT. A separate neh_borrower role requiring manual Keycloak assignment added an unnecessary onboarding step. Role-aware RPCs (get_borrowers_for_reservation, check_borrower_approved) check for neh_staff/neh_admin/is_admin in their IF branch — the ELSE branch handles all regular users regardless of specific role name.',
    'New users can start borrowing tools immediately after account creation with no manual role assignment needed. neh_staff and neh_admin roles remain for elevated permissions. Borrower dashboard automatically displays for all authenticated users via the user role mapping. Reduces Keycloak administration burden.',
    '2026-05-15'
);

COMMIT;

NOTIFY pgrst, 'reload schema';
