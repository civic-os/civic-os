-- Neighborhood Engagement Hub - Base Schema
-- Exercises options_source_rpc with cascading FKs, filtered dropdowns, and M:M editors

-- ============================================================================
-- LOOKUP TABLES
-- ============================================================================

-- Tool categories (e.g., Power Tools, Hand Tools, Accessibility Tools)
CREATE TABLE tool_categories (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    color hex_color DEFAULT '#3B82F6',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tool types (e.g., Chainsaw, Push Mower - belongs to a category)
CREATE TABLE tool_types (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    category_id INT NOT NULL REFERENCES tool_categories(id),
    inventory_module_id INT REFERENCES metadata.categories(id),
    description TEXT,
    is_qty_managed BOOLEAN DEFAULT false,
    total_quantity INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON tool_types(category_id);
CREATE INDEX ON tool_types(inventory_module_id);

-- Tool instances (e.g., Chainsaw #1, #2 - belongs to a type, has status)
CREATE TABLE tool_instances (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    tool_type_id INT NOT NULL REFERENCES tool_types(id),
    instance_number INT NOT NULL,
    status_id INT REFERENCES metadata.statuses(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON tool_instances(tool_type_id);
CREATE INDEX ON tool_instances(status_id);

-- ============================================================================
-- CORE ENTITIES
-- ============================================================================

-- Borrowers (community members who can borrow tools)
-- T-2: photo_id/address_proof (renamed from drivers_license_front/back)
-- T-3: liability_waiver (FileImage upload)
-- BR-2: phone_verified (staff checkbox)
-- BR-3: street/city/state/zip (structured address)
-- T-1: borrower_type (category: Resident, Non-Resident, Volunteer Group)
CREATE TABLE borrowers (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES metadata.civic_os_users(id),
    display_name TEXT,
    phone phone_number,
    email email_address,
    status_id INT REFERENCES metadata.statuses(id),
    borrower_type INT REFERENCES metadata.categories(id),
    phone_verified BOOLEAN DEFAULT false,
    street VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(2),
    zip VARCHAR(10),
    photo_id UUID REFERENCES metadata.files(id),
    address_proof UUID REFERENCES metadata.files(id),
    liability_waiver UUID REFERENCES metadata.files(id),
    civic_os_text_search tsvector GENERATED ALWAYS AS (
        to_tsvector('english',
            coalesce(display_name, '') || ' ' ||
            coalesce(email::text, '') || ' ' ||
            phone_search_tokens(phone) || ' ' ||
            coalesce(street, '') || ' ' ||
            coalesce(city, '') || ' ' ||
            coalesce(zip, '')
        )
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_borrowers_user_id ON borrowers(user_id);
CREATE INDEX idx_borrowers_phone ON borrowers(phone);
CREATE INDEX idx_borrowers_search ON borrowers USING gin(civic_os_text_search);
CREATE INDEX idx_borrowers_borrower_type ON borrowers(borrower_type);

-- Helper: resolve the current JWT user's borrower record (used as DEFAULT on tool_reservations)
CREATE OR REPLACE FUNCTION current_borrower_id()
RETURNS BIGINT
LANGUAGE SQL STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT id FROM borrowers WHERE user_id = current_user_id();
$$;

-- Parcels (properties with eligibility category and polygon boundary)
CREATE TABLE parcels (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    parcel_number VARCHAR(50),
    prop_num VARCHAR(20),
    prop_dir VARCHAR(10),
    prop_street VARCHAR(100),
    prop_city VARCHAR(50) DEFAULT 'FLINT',
    prop_zip VARCHAR(10),
    acreage DECIMAL(10,4),
    property_class INTEGER REFERENCES metadata.categories(id),
    eligibility INTEGER REFERENCES metadata.categories(id),
    lmi_status INTEGER REFERENCES metadata.categories(id),
    boundary postgis.geography(Polygon, 4326),
    civic_os_text_search tsvector GENERATED ALWAYS AS (
        to_tsvector('english',
            coalesce(display_name, '') || ' ' ||
            coalesce(parcel_number, '') || ' ' ||
            coalesce(prop_street, '') || ' ' ||
            coalesce(prop_zip, ''))
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_parcels_eligibility ON parcels(eligibility);
CREATE INDEX idx_parcels_lmi_status ON parcels(lmi_status);
CREATE INDEX idx_parcels_property_class ON parcels(property_class);
CREATE INDEX idx_parcels_text_search ON parcels USING GIN(civic_os_text_search);
CREATE INDEX idx_parcels_boundary ON parcels USING GIST(boundary);

-- Computed text field for PostgREST (same pattern as GeoPoint)
CREATE OR REPLACE FUNCTION public.boundary_text(rec public.parcels)
RETURNS text AS $$
  SELECT postgis.ST_AsText(rec.boundary);
$$ LANGUAGE SQL STABLE;

-- Census block groups (HUD CDBG LMI boundaries with polygon map)
CREATE TABLE census_block_groups (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(255) NOT NULL,
    geoid VARCHAR(12),                 -- Census GEOID (not UNIQUE — MultiPolygon splits share a GEOID)
    lowmod_pct DECIMAL(5,2),           -- LMI percentage
    lowmod INT,                        -- LMI person count
    lowmod_universe INT,               -- Total population
    low INT,                           -- Low-income person count
    lmi_status INTEGER REFERENCES metadata.categories(id),  -- Drives map color
    boundary postgis.geography(Polygon, 4326),
    civic_os_text_search tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(display_name, '') || ' ' || coalesce(geoid, ''))
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_cbg_lmi_status ON census_block_groups(lmi_status);
CREATE INDEX idx_cbg_geoid ON census_block_groups(geoid);
CREATE INDEX idx_cbg_text_search ON census_block_groups USING GIN(civic_os_text_search);
CREATE INDEX idx_cbg_boundary ON census_block_groups USING GIST(boundary);

-- Computed text field for PostgREST (function overload — same name, different arg type as parcels)
CREATE OR REPLACE FUNCTION public.boundary_text(rec public.census_block_groups)
RETURNS text AS $$
  SELECT postgis.ST_AsText(rec.boundary);
$$ LANGUAGE SQL STABLE;

-- Tool reservations (guided form: borrower submits reservation, staff approves)
-- NOTE: checkout_photos/return_photos/checkout_notes/return_notes moved to
-- tool_reservation_checkouts entity (v0.51.0)
-- T-6: site_review_completed (staff checkbox for site review)
CREATE TABLE tool_reservations (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    borrower_id BIGINT NOT NULL DEFAULT current_borrower_id() REFERENCES borrowers(id),
    reserved_date DATE NOT NULL DEFAULT CURRENT_DATE,
    timeslot time_slot,
    status_id INT REFERENCES metadata.statuses(id) DEFAULT get_initial_status('guided_form'),
    delivery_required BOOLEAN DEFAULT false,
    notes TEXT,
    site_review_completed BOOLEAN DEFAULT false,
    created_by UUID DEFAULT current_user_id(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON tool_reservations(borrower_id);
CREATE INDEX ON tool_reservations(status_id);

-- Auto-generate display_name from borrower name + date (guided form pattern)
CREATE OR REPLACE FUNCTION public.tool_reservation_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR OLD.borrower_id IS DISTINCT FROM NEW.borrower_id THEN
        NEW.display_name := COALESCE(
            (SELECT display_name FROM borrowers WHERE id = NEW.borrower_id),
            'Tool Reservation'
        ) || ' - ' || TO_CHAR(COALESCE(NEW.created_at, NOW()), 'YYYY-MM-DD');
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tool_reservation_display_name
    BEFORE INSERT OR UPDATE ON public.tool_reservations
    FOR EACH ROW EXECUTE FUNCTION public.tool_reservation_display_name();

-- Overlap check: enforced at approval time, checks through M:M junction tables
CREATE OR REPLACE FUNCTION check_tool_reservation_overlap()
RETURNS TRIGGER AS $$
DECLARE
    v_tool RECORD;
    v_conflict_count INT;
    v_available_count INT;
BEGIN
    -- Only check when transitioning TO approved/checked_out
    IF NEW.status_id NOT IN (
        SELECT id FROM metadata.statuses
        WHERE entity_type = 'tool_reservations'
        AND status_key IN ('approved', 'checked_out')
    ) THEN RETURN NEW; END IF;

    -- For each tool type in this reservation (via step junction)
    FOR v_tool IN
        SELECT tt.id as tool_type_id, tt.display_name, tt.is_qty_managed, tt.total_quantity
        FROM tool_reservation_tool_items trti
        JOIN tool_reservation_tools trt ON trt.id = trti.tool_reservation_tools_id
        JOIN tool_types tt ON tt.id = trti.tool_type_id
        WHERE trt.tool_reservation_id = NEW.id
    LOOP
        -- Count conflicting approved reservations with same tool_type
        SELECT COUNT(*) INTO v_conflict_count
        FROM tool_reservation_tool_items trti2
        JOIN tool_reservation_tools trt2 ON trt2.id = trti2.tool_reservation_tools_id
        JOIN tool_reservations tr2 ON tr2.id = trt2.tool_reservation_id
        JOIN metadata.statuses s ON tr2.status_id = s.id
        WHERE trti2.tool_type_id = v_tool.tool_type_id
          AND tr2.id != NEW.id
          AND tr2.timeslot && NEW.timeslot
          AND s.entity_type = 'tool_reservations'
          AND s.status_key IN ('approved', 'checked_out');

        -- Determine available count
        IF v_tool.is_qty_managed THEN
            v_available_count := COALESCE(v_tool.total_quantity, 0);
        ELSE
            SELECT COUNT(*) INTO v_available_count
            FROM tool_instances ti
            JOIN metadata.statuses s ON ti.status_id = s.id
            WHERE ti.tool_type_id = v_tool.tool_type_id
              AND s.status_key = 'in_service';
        END IF;

        IF v_conflict_count >= v_available_count THEN
            RAISE EXCEPTION '% is fully reserved for this time window (% available, % conflicting)',
                v_tool.display_name, v_available_count, v_conflict_count;
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger only on status changes (not INSERT — drafts don't need overlap checks)
CREATE TRIGGER tool_reservation_overlap_trigger
    BEFORE UPDATE OF status_id ON tool_reservations
    FOR EACH ROW EXECUTE FUNCTION check_tool_reservation_overlap();

-- ============================================================================
-- M:M JUNCTION TABLE - project_parcels (exercises options_source_rpc on M:M)
-- ============================================================================

-- Projects (neighborhood improvement projects)
CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    photos UUID REFERENCES metadata.photo_galleries(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_projects_photos ON projects(photos);

-- Junction: projects <-> parcels (M:M)
CREATE TABLE project_parcels (
    project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parcel_id INT NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, parcel_id)
);
CREATE INDEX ON project_parcels(project_id);
CREATE INDEX ON project_parcels(parcel_id);

-- ============================================================================
-- GUIDED FORM STEP TABLES (tool_reservation guided form)
-- ============================================================================

-- Step 1: Tool selection (child of tool_reservations)
CREATE TABLE tool_reservation_tools (
    id BIGSERIAL PRIMARY KEY,
    tool_reservation_id BIGINT NOT NULL REFERENCES tool_reservations(id) ON DELETE CASCADE,
    tool_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON tool_reservation_tools(tool_reservation_id);

-- Junction: tool_reservation_tools <-> tool_types (M:M, inline search modal)
CREATE TABLE tool_reservation_tool_items (
    tool_reservation_tools_id BIGINT NOT NULL REFERENCES tool_reservation_tools(id) ON DELETE CASCADE,
    tool_type_id INT NOT NULL REFERENCES tool_types(id) ON DELETE CASCADE,
    quantity INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tool_reservation_tools_id, tool_type_id)
);
CREATE INDEX ON tool_reservation_tool_items(tool_reservation_tools_id);
CREATE INDEX ON tool_reservation_tool_items(tool_type_id);

-- Step 2: Work site (child of tool_reservations)
CREATE TABLE tool_reservation_work_site (
    id BIGSERIAL PRIMARY KEY,
    tool_reservation_id BIGINT NOT NULL REFERENCES tool_reservations(id) ON DELETE CASCADE,
    site_description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON tool_reservation_work_site(tool_reservation_id);

-- Junction: work_site <-> parcels (M:M, inline search modal)
CREATE TABLE work_site_parcels (
    work_site_id BIGINT NOT NULL REFERENCES tool_reservation_work_site(id) ON DELETE CASCADE,
    parcel_id INT NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (work_site_id, parcel_id)
);
CREATE INDEX ON work_site_parcels(work_site_id);
CREATE INDEX ON work_site_parcels(parcel_id);

-- Computed field: tools_summary (for dashboards + notification templates)
CREATE OR REPLACE FUNCTION public.tools_summary(rec public.tool_reservations)
RETURNS text AS $$
  SELECT COALESCE(
    string_agg(tt.display_name::text, ', ' ORDER BY tt.display_name),
    '(no tools selected)'
  )
  FROM tool_reservation_tool_items trti
  JOIN tool_reservation_tools trt ON trt.id = trti.tool_reservation_tools_id
  JOIN tool_types tt ON tt.id = trti.tool_type_id
  WHERE trt.tool_reservation_id = rec.id;
$$ LANGUAGE SQL STABLE;

-- ============================================================================
-- CHECKOUT ENTITY (v0.51.0 — one checkout per reservation)
-- Placed after tools_summary() since requested_tools() delegates to it.
-- ============================================================================

-- Checkout record: staff assigns instances, takes photos at checkout/return
CREATE TABLE tool_reservation_checkouts (
    id BIGSERIAL PRIMARY KEY,
    tool_reservation_id BIGINT NOT NULL UNIQUE REFERENCES tool_reservations(id),
    checkout_photos UUID REFERENCES metadata.photo_galleries(id),
    return_photos UUID REFERENCES metadata.photo_galleries(id),
    checkout_notes TEXT,
    return_notes TEXT,
    damage_reported BOOLEAN DEFAULT false,
    status_id INT REFERENCES metadata.statuses(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON tool_reservation_checkouts(tool_reservation_id);
CREATE INDEX ON tool_reservation_checkouts(status_id);

-- Junction: checkout <-> tool_instances (M:M, which specific instances are checked out)
CREATE TABLE checkout_instances (
    checkout_id BIGINT NOT NULL REFERENCES tool_reservation_checkouts(id) ON DELETE CASCADE,
    tool_instance_id INT NOT NULL REFERENCES tool_instances(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (checkout_id, tool_instance_id)
);
CREATE INDEX ON checkout_instances(checkout_id);
CREATE INDEX ON checkout_instances(tool_instance_id);

-- Computed field: delegate to tools_summary() on the linked reservation
CREATE OR REPLACE FUNCTION public.requested_tools(rec public.tool_reservation_checkouts)
RETURNS text AS $$
  SELECT public.tools_summary(tr)
  FROM public.tool_reservations tr
  WHERE tr.id = rec.tool_reservation_id;
$$ LANGUAGE SQL STABLE;

-- Auto-create checkout record when reservation status changes to 'checked_out'
CREATE OR REPLACE FUNCTION public.auto_create_checkout()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_status_key TEXT;
    v_checkout_status_id INT;
BEGIN
    SELECT status_key INTO v_status_key
    FROM metadata.statuses WHERE id = NEW.status_id;

    IF v_status_key = 'checked_out' THEN
        SELECT id INTO v_checkout_status_id
        FROM metadata.statuses
        WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'checked_out';

        INSERT INTO public.tool_reservation_checkouts (tool_reservation_id, status_id)
        VALUES (NEW.id, v_checkout_status_id)
        ON CONFLICT (tool_reservation_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_create_checkout
    AFTER UPDATE OF status_id ON public.tool_reservations
    FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION public.auto_create_checkout();

-- Damage cascade: when checkout is returned_damaged, set linked instances to maintenance
CREATE OR REPLACE FUNCTION public.cascade_damage_to_instances()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_status_key TEXT;
    v_maintenance_status_id INT;
BEGIN
    SELECT status_key INTO v_status_key
    FROM metadata.statuses WHERE id = NEW.status_id;

    IF v_status_key = 'returned_damaged' AND NEW.damage_reported = true THEN
        SELECT id INTO v_maintenance_status_id
        FROM metadata.statuses
        WHERE entity_type = 'tool_instances' AND status_key = 'maintenance';

        UPDATE public.tool_instances
        SET status_id = v_maintenance_status_id
        WHERE id IN (
            SELECT tool_instance_id FROM checkout_instances WHERE checkout_id = NEW.id
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cascade_damage
    AFTER UPDATE OF status_id ON public.tool_reservation_checkouts
    FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION public.cascade_damage_to_instances();

-- ============================================================================
-- TRAINING RECORDS (T-5: certification tracking for borrowers)
-- ============================================================================

CREATE TABLE training_records (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(255) NOT NULL,
    borrower_id BIGINT NOT NULL REFERENCES borrowers(id),
    training_type INT NOT NULL REFERENCES metadata.categories(id),
    date_earned DATE NOT NULL,
    expiry_date DATE,
    trainer VARCHAR(255),
    notes TEXT,
    status_id INT REFERENCES metadata.statuses(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_training_records_borrower ON training_records(borrower_id);
CREATE INDEX idx_training_records_type ON training_records(training_type);
CREATE INDEX idx_training_records_expiry ON training_records(expiry_date);
CREATE INDEX idx_training_records_status ON training_records(status_id);
