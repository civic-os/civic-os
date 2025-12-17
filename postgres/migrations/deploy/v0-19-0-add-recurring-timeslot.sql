-- Deploy civic_os:v0-19-0-add-recurring-timeslot to pg
-- requires: v0-18-1-refactor-entity-action-permissions

BEGIN;

-- ============================================================================
-- RECURRING TIMESLOT SYSTEM
-- ============================================================================
-- Version: v0.19.0
-- Purpose: RFC 5545 RRULE-compliant recurring time slots with hybrid storage
--          (both RRULE patterns AND expanded instances for GIST compatibility).
--
-- Architecture:
--   - Series Groups: User-facing logical containers ("Weekly Team Standup")
--   - Series: RRULE definitions + entity templates (versions after splits)
--   - Instances: Junction table mapping series to entity records
--
-- Key Features:
--   - No entity schema changes required (junction table pattern)
--   - Full exception handling (cancel, reschedule, modify)
--   - Series splits for "edit this and future"
--   - RBAC-based access via existing permissions system
--   - Conflict preview before creation
--
-- Tables:
--   metadata.time_slot_series_groups - Logical containers for series versions
--   metadata.time_slot_series - RRULE definitions and entity templates
--   metadata.time_slot_instances - Junction mapping series to entities
--   metadata.recurring_settings - Configuration settings
--
-- Functions:
--   validate_rrule() - DoS prevention for RRULE strings
--   validate_entity_template() - Template field allowlist validation
--   preview_recurring_conflicts() - Check conflicts before creation
--   create_recurring_series() - Create group + series + instances
--   expand_series_instances() - On-demand expansion
--   cancel_series_occurrence() - Cancel single instance
--   split_series_from_date() - "This + future" edits
--   update_series_template() - "All" edits
--   delete_series_with_instances() - Delete series atomically
--   delete_series_group() - Delete entire group
--
-- Views:
--   metadata.series_groups_summary - Aggregated stats for UI
--   public.schema_series_groups - PostgREST access with permissions
-- ============================================================================


-- ============================================================================
-- 1. METADATA ENTITIES EXTENSION (Entity-level recurring config)
-- ============================================================================
-- Add recurring configuration to entities table, following the calendar pattern
-- (show_calendar + calendar_property_name → supports_recurring + recurring_property_name)

ALTER TABLE metadata.entities
    ADD COLUMN IF NOT EXISTS supports_recurring BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS recurring_property_name NAME;

COMMENT ON COLUMN metadata.entities.supports_recurring IS
    'When true, enables recurring series UI for this entity type.
     Requires recurring_property_name to specify which time_slot column.
     Added in v0.19.0.';

COMMENT ON COLUMN metadata.entities.recurring_property_name IS
    'Name of the time_slot column to use for recurring schedules.
     Required when supports_recurring is true.
     Added in v0.19.0.';


-- ============================================================================
-- 1b. METADATA PROPERTIES EXTENSION (kept for backward compatibility)
-- ============================================================================
-- The is_recurring column on properties is kept for data migration but
-- the primary configuration is now at entity level (supports_recurring)

ALTER TABLE metadata.properties
    ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN metadata.properties.is_recurring IS
    'DEPRECATED: Use metadata.entities.supports_recurring instead.
     Kept for backward compatibility. Property-level flag for time_slot columns.
     Added in v0.19.0.';


-- ============================================================================
-- 1c. UPDATE upsert_entity_metadata RPC TO INCLUDE RECURRING
-- ============================================================================

-- Drop old function signature (11 parameters from v0.16.0)
DROP FUNCTION IF EXISTS public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN);

-- Create new function signature (13 parameters - adds supports_recurring, recurring_property_name)
CREATE OR REPLACE FUNCTION public.upsert_entity_metadata(
  p_table_name NAME,
  p_display_name TEXT,
  p_description TEXT,
  p_sort_order INT,
  p_search_fields TEXT[] DEFAULT NULL,
  p_show_map BOOLEAN DEFAULT FALSE,
  p_map_property_name TEXT DEFAULT NULL,
  p_show_calendar BOOLEAN DEFAULT FALSE,
  p_calendar_property_name TEXT DEFAULT NULL,
  p_calendar_color_property TEXT DEFAULT NULL,
  p_enable_notes BOOLEAN DEFAULT FALSE,
  p_supports_recurring BOOLEAN DEFAULT FALSE,
  p_recurring_property_name TEXT DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  -- Check if user is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Upsert the entity metadata
  INSERT INTO metadata.entities (
    table_name,
    display_name,
    description,
    sort_order,
    search_fields,
    show_map,
    map_property_name,
    show_calendar,
    calendar_property_name,
    calendar_color_property,
    enable_notes,
    supports_recurring,
    recurring_property_name
  )
  VALUES (
    p_table_name,
    p_display_name,
    p_description,
    p_sort_order,
    p_search_fields,
    p_show_map,
    p_map_property_name,
    p_show_calendar,
    p_calendar_property_name,
    p_calendar_color_property,
    p_enable_notes,
    p_supports_recurring,
    p_recurring_property_name
  )
  ON CONFLICT (table_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    search_fields = COALESCE(EXCLUDED.search_fields, metadata.entities.search_fields),
    show_map = EXCLUDED.show_map,
    map_property_name = EXCLUDED.map_property_name,
    show_calendar = EXCLUDED.show_calendar,
    calendar_property_name = EXCLUDED.calendar_property_name,
    calendar_color_property = EXCLUDED.calendar_color_property,
    enable_notes = EXCLUDED.enable_notes,
    supports_recurring = EXCLUDED.supports_recurring,
    recurring_property_name = EXCLUDED.recurring_property_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_entity_metadata IS
  'Insert or update entity metadata. Admin only. Updated in v0.19.0 to add recurring configuration.';

GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT) TO authenticated;


-- ============================================================================
-- 2. SERIES GROUPS TABLE
-- ============================================================================
-- Logical container for related series versions. This is what users see and
-- manage in the UI. Groups can contain multiple series versions (after splits).

CREATE TABLE metadata.time_slot_series_groups (
    id BIGSERIAL PRIMARY KEY,

    -- Display information
    display_name VARCHAR(255) NOT NULL,
    description TEXT,

    -- Visual identification (shared across all instances)
    color VARCHAR(7) CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),

    -- Audit
    created_by UUID REFERENCES metadata.civic_os_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata.time_slot_series_groups IS
    'Logical grouping of related series versions - what users see as "one recurring event".
     A group can contain multiple series versions after "edit this and future" splits.
     Added in v0.19.0.';

COMMENT ON COLUMN metadata.time_slot_series_groups.display_name IS
    'User-facing name for the recurring schedule (e.g., "Weekly Team Standup")';

COMMENT ON COLUMN metadata.time_slot_series_groups.color IS
    'Hex color for calendar display (e.g., "#3B82F6"). Shared by all instances.';

-- Timestamps trigger
CREATE TRIGGER set_series_groups_updated_at
    BEFORE UPDATE ON metadata.time_slot_series_groups
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 3. SERIES TABLE (Versions)
-- ============================================================================
-- Stores RRULE definition, entity template, and version info.
-- Multiple series can belong to one group (after "edit this and future" splits).

CREATE TABLE metadata.time_slot_series (
    id BIGSERIAL PRIMARY KEY,

    -- Link to logical group (NULL for standalone/legacy series)
    group_id BIGINT REFERENCES metadata.time_slot_series_groups(id) ON DELETE CASCADE,

    -- Version tracking within group
    version_number INT NOT NULL DEFAULT 1,
    effective_from DATE NOT NULL,
    effective_until DATE,  -- NULL means "ongoing"

    -- Target entity configuration
    entity_table NAME NOT NULL,

    -- Template data: JSONB of field values to copy into each instance
    -- Example: {"resource_id": 5, "purpose": "Team Standup", "attendee_count": 10}
    entity_template JSONB NOT NULL DEFAULT '{}',

    -- RRULE definition (RFC 5545 compliant)
    -- Examples:
    --   "FREQ=WEEKLY;BYDAY=MO,WE,FR"
    --   "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=12"
    --   "FREQ=DAILY;INTERVAL=2;UNTIL=20251231T235959Z"
    rrule TEXT NOT NULL,

    -- Series anchor point
    dtstart TIMESTAMPTZ NOT NULL,  -- First occurrence start time (UTC)
    duration INTERVAL NOT NULL,    -- Duration of each occurrence

    -- Optional timezone for display (IANA timezone name)
    timezone TEXT,  -- e.g., "America/New_York"

    -- Time slot property name (which column on the entity is the time_slot)
    time_slot_property NAME NOT NULL DEFAULT 'time_slot',

    -- Series status
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'needs_attention', 'ended')),

    -- Expansion tracking
    expanded_until DATE,

    -- Audit
    created_by UUID REFERENCES metadata.civic_os_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Template change tracking
    template_updated_at TIMESTAMPTZ,
    template_updated_by UUID REFERENCES metadata.civic_os_users(id) ON DELETE SET NULL
);

COMMENT ON TABLE metadata.time_slot_series IS
    'RRULE definitions and entity templates. Multiple versions per group after splits.
     Added in v0.19.0.';

COMMENT ON COLUMN metadata.time_slot_series.entity_template IS
    'JSONB template of field values copied to each expanded instance.
     Must contain only fields allowed for create (validated).';

COMMENT ON COLUMN metadata.time_slot_series.effective_from IS
    'Date this version of the series starts applying';

COMMENT ON COLUMN metadata.time_slot_series.effective_until IS
    'Date this version ends (NULL = ongoing, set when split occurs)';

COMMENT ON COLUMN metadata.time_slot_series.rrule IS
    'RFC 5545 RRULE string. SECONDLY and MINUTELY frequencies blocked for DoS prevention.';

COMMENT ON COLUMN metadata.time_slot_series.dtstart IS
    'First occurrence start time in UTC. RRULE expansion uses this as anchor.';

COMMENT ON COLUMN metadata.time_slot_series.timezone IS
    'IANA timezone for wall-clock DST handling (e.g., "America/New_York")';

COMMENT ON COLUMN metadata.time_slot_series.status IS
    'active = expanding normally, paused = manually stopped, needs_attention = schema drift, ended = effective_until passed';


-- ============================================================================
-- 4. INSTANCES TABLE (Junction)
-- ============================================================================
-- Maps series to entity records WITHOUT requiring entity schema changes.
-- Tracks exceptions (cancelled, modified, rescheduled).

CREATE TABLE metadata.time_slot_instances (
    id BIGSERIAL PRIMARY KEY,

    -- Link to series
    series_id BIGINT NOT NULL REFERENCES metadata.time_slot_series(id) ON DELETE CASCADE,

    -- Which occurrence this represents
    occurrence_date DATE NOT NULL,

    -- Link to entity record (polymorphic)
    -- NULL if cancelled or conflict-skipped (no entity record exists)
    entity_table NAME NOT NULL,
    entity_id BIGINT,

    -- Exception tracking
    is_exception BOOLEAN NOT NULL DEFAULT FALSE,
    exception_type VARCHAR(20) CHECK (exception_type IS NULL OR exception_type IN (
        'modified',          -- Entity data changed from template
        'rescheduled',       -- Moved to different time
        'cancelled',         -- User deleted this occurrence
        'conflict_skipped'   -- Never created due to conflict at expansion time
    )),

    -- Audit trail for exceptions
    original_time_slot TSTZRANGE,  -- What time it was before rescheduling
    exception_reason TEXT,
    exception_at TIMESTAMPTZ,
    exception_by UUID REFERENCES metadata.civic_os_users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT unique_series_occurrence UNIQUE(series_id, occurrence_date),
    CONSTRAINT unique_entity_instance UNIQUE(entity_table, entity_id)
);

COMMENT ON TABLE metadata.time_slot_instances IS
    'Junction table mapping series to entity records - enables recurrence without entity schema changes.
     Added in v0.19.0.';

COMMENT ON COLUMN metadata.time_slot_instances.entity_id IS
    'FK to actual entity record (NULL if cancelled or never created due to conflict)';

COMMENT ON COLUMN metadata.time_slot_instances.is_exception IS
    'TRUE if this instance differs from series template (modified, rescheduled, or cancelled)';

COMMENT ON COLUMN metadata.time_slot_instances.exception_type IS
    'Type of exception: modified (data changed), rescheduled (time changed), cancelled (user deleted), conflict_skipped (never created)';


-- ============================================================================
-- 5. INDEXES
-- ============================================================================

-- Series Groups
CREATE INDEX idx_series_groups_created_by ON metadata.time_slot_series_groups(created_by);

-- Series
CREATE INDEX idx_series_group ON metadata.time_slot_series(group_id);
CREATE INDEX idx_series_entity_table ON metadata.time_slot_series(entity_table);
CREATE INDEX idx_series_effective ON metadata.time_slot_series(effective_from, effective_until);
CREATE INDEX idx_series_status ON metadata.time_slot_series(status) WHERE status != 'ended';

-- Instances
CREATE INDEX idx_instances_series ON metadata.time_slot_instances(series_id);
CREATE INDEX idx_instances_entity ON metadata.time_slot_instances(entity_table, entity_id);
CREATE INDEX idx_instances_occurrence ON metadata.time_slot_instances(occurrence_date);
CREATE INDEX idx_instances_exceptions ON metadata.time_slot_instances(series_id) WHERE is_exception = TRUE;


-- ============================================================================
-- 6. VALIDATION FUNCTIONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 6.1 RRULE Validation (DoS Prevention)
-- ----------------------------------------------------------------------------
-- Blocks sub-hourly frequencies and optionally requires end conditions.

CREATE OR REPLACE FUNCTION metadata.validate_rrule(p_rrule TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_freq TEXT;
BEGIN
    -- Extract frequency from RRULE
    v_freq := substring(p_rrule from 'FREQ=([A-Z]+)');

    IF v_freq IS NULL THEN
        RAISE EXCEPTION 'Invalid RRULE: missing FREQ parameter';
    END IF;

    -- Reject sub-hourly frequencies (SECONDLY, MINUTELY)
    IF v_freq IN ('SECONDLY', 'MINUTELY') THEN
        RAISE EXCEPTION 'FREQ=% is not allowed. Use HOURLY or less frequent.', v_freq;
    END IF;

    -- Validate frequency is known
    IF v_freq NOT IN ('HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') THEN
        RAISE EXCEPTION 'Invalid RRULE FREQ=%', v_freq;
    END IF;

    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION metadata.validate_rrule(TEXT) IS
    'Validates RRULE strings for security. Blocks SECONDLY and MINUTELY frequencies.
     Added in v0.19.0.';

-- Add constraint to series table
ALTER TABLE metadata.time_slot_series
    ADD CONSTRAINT rrule_valid CHECK (metadata.validate_rrule(rrule));


-- ----------------------------------------------------------------------------
-- 6.2 Entity Template Validation
-- ----------------------------------------------------------------------------
-- Validates template fields against entity schema allowlist.

CREATE OR REPLACE FUNCTION metadata.validate_entity_template(
    p_entity_table NAME,
    p_template JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_allowed_fields TEXT[];
    v_template_field TEXT;
    v_blocked_fields TEXT[] := ARRAY['id', 'created_at', 'created_by', 'updated_at', 'updated_by'];
BEGIN
    -- Validate entity_table exists
    IF NOT EXISTS (
        SELECT 1 FROM metadata.entities
        WHERE table_name = p_entity_table
    ) THEN
        RAISE EXCEPTION 'Invalid entity table: %', p_entity_table;
    END IF;

    -- Get fields that are editable (show_on_edit=true)
    -- Use show_on_edit since templates are managed by admins who can set fields
    -- that regular users cannot set on initial create (e.g., status)
    SELECT array_agg(column_name) INTO v_allowed_fields
    FROM metadata.properties
    WHERE table_name = p_entity_table
      AND show_on_edit = TRUE
      AND column_name != ALL(v_blocked_fields);

    IF v_allowed_fields IS NULL THEN
        v_allowed_fields := ARRAY[]::TEXT[];
    END IF;

    -- Check each template field is allowed
    FOR v_template_field IN SELECT jsonb_object_keys(p_template)
    LOOP
        -- Skip time_slot field (handled separately by expansion)
        IF v_template_field = 'time_slot' THEN
            CONTINUE;
        END IF;

        IF NOT v_template_field = ANY(v_allowed_fields) THEN
            RAISE EXCEPTION 'Template field "%" is not allowed for entity %. Allowed fields: %',
                v_template_field, p_entity_table, v_allowed_fields;
        END IF;
    END LOOP;

    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION metadata.validate_entity_template(NAME, JSONB) IS
    'Validates entity template JSONB against schema allowlist.
     Blocks audit fields and fields with show_on_edit=false.
     Uses show_on_edit since templates are managed by admins.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 6.3 Schema Drift Detection
-- ----------------------------------------------------------------------------
-- Validates template against current entity schema for expansion.

CREATE OR REPLACE FUNCTION metadata.validate_template_against_schema(
    p_entity_table NAME,
    p_template JSONB
)
RETURNS TABLE(field TEXT, issue TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
    -- Check for missing required fields (join with information_schema for nullability info)
    RETURN QUERY
    SELECT c.column_name::TEXT, 'Required field missing from template'::TEXT
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = p_entity_table
      AND c.is_nullable = 'NO'
      AND c.column_default IS NULL
      AND c.column_name NOT IN ('id', 'created_at', 'created_by', 'updated_at', 'updated_by')
      AND c.column_name NOT IN ('time_slot')  -- Handled by expansion
      AND NOT p_template ? c.column_name;

    -- Check for fields that no longer exist
    RETURN QUERY
    SELECT t.key::TEXT, 'Field no longer exists in entity schema'::TEXT
    FROM jsonb_object_keys(p_template) t(key)
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = p_entity_table AND c.column_name = t.key
    );
END;
$$;

COMMENT ON FUNCTION metadata.validate_template_against_schema(NAME, JSONB) IS
    'Checks for schema drift between series template and current entity schema.
     Returns table of issues (empty if valid).
     Added in v0.19.0.';


-- ============================================================================
-- 7. HELPER FUNCTIONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 7.1 Modify RRULE UNTIL Clause
-- ----------------------------------------------------------------------------
-- Safely modifies RRULE to add/update UNTIL clause for series splits.

CREATE OR REPLACE FUNCTION metadata.modify_rrule_until(p_rrule TEXT, p_until DATE)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_result TEXT;
    v_until_str TEXT;
BEGIN
    v_until_str := to_char(p_until, 'YYYYMMDD') || 'T235959Z';

    -- Remove existing UNTIL or COUNT (can't have both)
    v_result := regexp_replace(p_rrule, ';?(UNTIL|COUNT)=[^;]+', '', 'g');

    -- Add new UNTIL
    v_result := v_result || ';UNTIL=' || v_until_str;

    -- Clean up any leading/trailing/duplicate semicolons
    v_result := regexp_replace(v_result, '^;|;$', '', 'g');
    v_result := regexp_replace(v_result, ';;+', ';', 'g');

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION metadata.modify_rrule_until(TEXT, DATE) IS
    'Modifies an RRULE string to set UNTIL clause. Removes existing COUNT/UNTIL.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 7.2 Prevent Direct Series Delete
-- ----------------------------------------------------------------------------
-- Forces use of RPC for proper cleanup.

CREATE OR REPLACE FUNCTION metadata.prevent_direct_series_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('recurring.allow_direct_delete', true) != 'true' THEN
        RAISE EXCEPTION 'Use delete_series_with_instances() RPC instead of direct DELETE';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER enforce_series_delete_rpc
    BEFORE DELETE ON metadata.time_slot_series
    FOR EACH ROW EXECUTE FUNCTION metadata.prevent_direct_series_delete();

COMMENT ON FUNCTION metadata.prevent_direct_series_delete() IS
    'Trigger function that prevents direct DELETE on series table.
     Forces use of delete_series_with_instances() RPC for proper cleanup.
     Added in v0.19.0.';


-- ============================================================================
-- 8. RPC FUNCTIONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 8.1 Preview Recurring Conflicts
-- ----------------------------------------------------------------------------
-- Check conflicts before creating a series.

CREATE OR REPLACE FUNCTION public.preview_recurring_conflicts(
    p_entity_table NAME,
    p_scope_column NAME,           -- e.g., 'resource_id'
    p_scope_value TEXT,            -- e.g., '5'
    p_time_slot_column NAME,       -- e.g., 'time_slot'
    p_occurrences TIMESTAMPTZ[][]  -- Array of [start, end] pairs
)
RETURNS TABLE (
    occurrence_index INTEGER,
    occurrence_start TIMESTAMPTZ,
    occurrence_end TIMESTAMPTZ,
    has_conflict BOOLEAN,
    conflicting_id BIGINT,
    conflicting_display TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
    v_idx INTEGER := 0;
    v_start TIMESTAMPTZ;
    v_end TIMESTAMPTZ;
    v_slot TSTZRANGE;
    v_query TEXT;
    v_conflict RECORD;
    v_scope_type TEXT;
BEGIN
    -- Get the column type for proper casting
    SELECT data_type INTO v_scope_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = p_entity_table
      AND column_name = p_scope_column;

    -- Build dynamic query for conflict detection
    FOR v_idx IN 1..array_length(p_occurrences, 1)
    LOOP
        v_start := p_occurrences[v_idx][1];
        v_end := p_occurrences[v_idx][2];
        v_slot := tstzrange(v_start, v_end, '[)');

        -- Check for overlapping records (cast scope_value to the column type)
        v_query := format(
            'SELECT id, COALESCE(display_name, ''#'' || id::text) as display_name
             FROM public.%I
             WHERE %I = $1::%s AND %I && $2
             LIMIT 1',
            p_entity_table,
            p_scope_column,
            COALESCE(v_scope_type, 'text'),
            p_time_slot_column
        );

        BEGIN
            EXECUTE v_query INTO v_conflict USING p_scope_value, v_slot;

            occurrence_index := v_idx;
            occurrence_start := v_start;
            occurrence_end := v_end;

            IF v_conflict.id IS NOT NULL THEN
                has_conflict := TRUE;
                conflicting_id := v_conflict.id;
                conflicting_display := v_conflict.display_name;
            ELSE
                has_conflict := FALSE;
                conflicting_id := NULL;
                conflicting_display := NULL;
            END IF;

            RETURN NEXT;
        EXCEPTION WHEN undefined_column THEN
            -- If display_name doesn't exist, try without it
            v_query := format(
                'SELECT id FROM public.%I WHERE %I = $1::%s AND %I && $2 LIMIT 1',
                p_entity_table, p_scope_column, COALESCE(v_scope_type, 'text'), p_time_slot_column
            );
            EXECUTE v_query INTO v_conflict USING p_scope_value, v_slot;

            occurrence_index := v_idx;
            occurrence_start := v_start;
            occurrence_end := v_end;
            has_conflict := v_conflict.id IS NOT NULL;
            conflicting_id := v_conflict.id;
            conflicting_display := CASE WHEN v_conflict.id IS NOT NULL THEN '#' || v_conflict.id::text END;
            RETURN NEXT;
        END;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION public.preview_recurring_conflicts(NAME, NAME, TEXT, NAME, TIMESTAMPTZ[][]) IS
    'Preview conflicts before creating a recurring series.
     Returns table of occurrences with conflict status.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 8.2 Create Recurring Series
-- ----------------------------------------------------------------------------
-- Creates group, series, and optionally initial instances via worker job.

CREATE OR REPLACE FUNCTION public.create_recurring_series(
    p_group_name TEXT,
    p_group_description TEXT DEFAULT NULL,
    p_group_color TEXT DEFAULT NULL,
    p_entity_table NAME DEFAULT NULL,
    p_entity_template JSONB DEFAULT '{}',
    p_rrule TEXT DEFAULT NULL,
    p_dtstart TIMESTAMPTZ DEFAULT NULL,
    p_duration INTERVAL DEFAULT NULL,
    p_timezone TEXT DEFAULT NULL,
    p_time_slot_property NAME DEFAULT 'time_slot',
    p_expand_now BOOLEAN DEFAULT FALSE,
    p_skip_conflicts BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_group_id BIGINT;
    v_series_id BIGINT;
    v_user_id UUID;
BEGIN
    -- Get current user
    v_user_id := public.current_user_id();

    -- Validate required fields
    IF p_entity_table IS NULL THEN
        RAISE EXCEPTION 'entity_table is required';
    END IF;
    IF p_rrule IS NULL THEN
        RAISE EXCEPTION 'rrule is required';
    END IF;
    IF p_dtstart IS NULL THEN
        RAISE EXCEPTION 'dtstart is required';
    END IF;
    IF p_duration IS NULL THEN
        RAISE EXCEPTION 'duration is required';
    END IF;

    -- Validate RRULE (will raise exception if invalid)
    PERFORM metadata.validate_rrule(p_rrule);

    -- Validate entity template
    PERFORM metadata.validate_entity_template(p_entity_table, p_entity_template);

    -- Create group
    INSERT INTO metadata.time_slot_series_groups (
        display_name, description, color, created_by
    ) VALUES (
        p_group_name, p_group_description, p_group_color, v_user_id
    ) RETURNING id INTO v_group_id;

    -- Create series
    INSERT INTO metadata.time_slot_series (
        group_id, version_number, effective_from, entity_table,
        entity_template, rrule, dtstart, duration, timezone,
        time_slot_property, status, created_by
    ) VALUES (
        v_group_id, 1, p_dtstart::DATE, p_entity_table,
        p_entity_template, p_rrule, p_dtstart, p_duration, p_timezone,
        p_time_slot_property, 'active', v_user_id
    ) RETURNING id INTO v_series_id;

    -- If expand_now is true, queue expansion job
    IF p_expand_now THEN
        -- Queue River job for expansion (90 days from TODAY)
        -- Note: expand_until must be ISO8601 timestamp for Go parsing
        INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at)
        VALUES (
            'available',
            'recurring',
            'expand_recurring_series',
            jsonb_build_object(
                'series_id', v_series_id,
                'expand_until', to_char((NOW() + INTERVAL '90 days')::TIMESTAMPTZ, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            ),
            3,
            NOW(),
            NOW()
        );
    END IF;

    RETURN jsonb_build_object(
        'success', TRUE,
        'group_id', v_group_id,
        'series_id', v_series_id,
        'message', 'Recurring series created successfully'
    );
END;
$$;

COMMENT ON FUNCTION public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMPTZ, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN) IS
    'Creates a new recurring series with group, series record, and triggers expansion.
     Returns JSONB with group_id and series_id.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 8.3 Expand Series Instances (On-demand)
-- ----------------------------------------------------------------------------
-- Triggers expansion of series instances up to a given date.
-- Actual expansion happens in Go worker; this just queues the job.

CREATE OR REPLACE FUNCTION public.expand_series_instances(
    p_series_id BIGINT,
    p_expand_until DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_series RECORD;
BEGIN
    -- Get series
    SELECT * INTO v_series
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Update expanded_until to signal worker
    UPDATE metadata.time_slot_series
    SET expanded_until = GREATEST(COALESCE(expanded_until, '1970-01-01'::DATE), p_expand_until)
    WHERE id = p_series_id;

    -- Queue River job (Go worker picks up and processes)
    -- Note: expand_until must be ISO8601 timestamp for Go parsing
    INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at)
    VALUES (
        'available',
        'recurring',
        'expand_recurring_series',
        jsonb_build_object('series_id', p_series_id, 'expand_until', to_char(p_expand_until::TIMESTAMPTZ, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        3,
        NOW(),
        NOW()
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', 'Expansion queued',
        'series_id', p_series_id,
        'expand_until', p_expand_until
    );
END;
$$;

COMMENT ON FUNCTION public.expand_series_instances(BIGINT, DATE) IS
    'Queues expansion of series instances up to the given date.
     Actual expansion is performed by Go worker.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 8.4 Cancel Series Occurrence
-- ----------------------------------------------------------------------------
-- Cancels a single occurrence, preserving junction record for history.

CREATE OR REPLACE FUNCTION public.cancel_series_occurrence(
    p_entity_table NAME,
    p_entity_id BIGINT,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_instance RECORD;
    v_user_id UUID;
BEGIN
    v_user_id := public.current_user_id();

    -- Get instance info
    SELECT * INTO v_instance
    FROM metadata.time_slot_instances
    WHERE entity_table = p_entity_table AND entity_id = p_entity_id;

    IF NOT FOUND THEN
        -- Not part of a series, just delete normally
        EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_entity_table) USING p_entity_id;
        RETURN jsonb_build_object(
            'success', TRUE,
            'message', 'Record deleted (not part of a series)'
        );
    END IF;

    -- Mark junction as cancelled (keep row for history)
    UPDATE metadata.time_slot_instances
    SET
        entity_id = NULL,
        is_exception = TRUE,
        exception_type = 'cancelled',
        exception_reason = p_reason,
        exception_at = NOW(),
        exception_by = v_user_id
    WHERE id = v_instance.id;

    -- Delete the entity record
    EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_entity_table) USING p_entity_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', 'Occurrence cancelled',
        'series_id', v_instance.series_id,
        'occurrence_date', v_instance.occurrence_date
    );
END;
$$;

COMMENT ON FUNCTION public.cancel_series_occurrence(NAME, BIGINT, TEXT) IS
    'Cancels a single occurrence of a recurring series.
     Marks junction as cancelled (preserves history) and deletes entity record.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 8.5 Split Series From Date
-- ----------------------------------------------------------------------------
-- Creates new series version for "edit this and future" operations.

CREATE OR REPLACE FUNCTION public.split_series_from_date(
    p_series_id BIGINT,
    p_split_date DATE,
    p_new_dtstart TIMESTAMPTZ,
    p_new_duration INTERVAL DEFAULT NULL,
    p_new_template JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_original RECORD;
    v_group_id BIGINT;
    v_new_version INT;
    v_new_series_id BIGINT;
    v_user_id UUID;
BEGIN
    v_user_id := public.current_user_id();

    -- Get original series
    SELECT * INTO v_original
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Ensure series has a group (create if standalone)
    IF v_original.group_id IS NULL THEN
        INSERT INTO metadata.time_slot_series_groups (display_name, created_by)
        VALUES (
            COALESCE(v_original.entity_template->>'purpose', 'Recurring Schedule'),
            v_user_id
        )
        RETURNING id INTO v_group_id;

        UPDATE metadata.time_slot_series
        SET group_id = v_group_id, version_number = 1
        WHERE id = p_series_id;
    ELSE
        v_group_id := v_original.group_id;
    END IF;

    -- Get next version number
    SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_new_version
    FROM metadata.time_slot_series
    WHERE group_id = v_group_id;

    -- Terminate original series
    UPDATE metadata.time_slot_series
    SET
        effective_until = (p_split_date - INTERVAL '1 day')::DATE,
        rrule = metadata.modify_rrule_until(v_original.rrule, (p_split_date - INTERVAL '1 day')::DATE)
    WHERE id = p_series_id;

    -- Merge new template with original (preserves required fields like resource_id)
    -- JSONB || operator: right side takes precedence for duplicate keys
    -- Example: {"resource_id": 1, "purpose": "A"} || {"purpose": "B"} = {"resource_id": 1, "purpose": "B"}
    IF p_new_template IS NOT NULL THEN
        p_new_template := v_original.entity_template || p_new_template;
        PERFORM metadata.validate_entity_template(v_original.entity_table, p_new_template);
    END IF;

    -- Create new version
    INSERT INTO metadata.time_slot_series (
        group_id, version_number, effective_from, effective_until,
        entity_table, entity_template, rrule, dtstart, duration, timezone,
        time_slot_property, status, created_by
    ) VALUES (
        v_group_id,
        v_new_version,
        p_split_date,
        NULL,  -- Ongoing
        v_original.entity_table,
        COALESCE(p_new_template, v_original.entity_template),
        v_original.rrule,
        p_new_dtstart,
        COALESCE(p_new_duration, v_original.duration),
        v_original.timezone,
        v_original.time_slot_property,
        'active',
        v_user_id
    )
    RETURNING id INTO v_new_series_id;

    -- Re-link future instances to new series
    UPDATE metadata.time_slot_instances
    SET series_id = v_new_series_id
    WHERE series_id = p_series_id
      AND occurrence_date >= p_split_date;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', 'Series split successfully',
        'original_series_id', p_series_id,
        'new_series_id', v_new_series_id,
        'group_id', v_group_id,
        'split_date', p_split_date
    );
END;
$$;

COMMENT ON FUNCTION public.split_series_from_date(BIGINT, DATE, TIMESTAMPTZ, INTERVAL, JSONB) IS
    'Splits a series for "edit this and future" operations.
     Creates new version in same group, terminates original.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 8.6 Update Series Template
-- ----------------------------------------------------------------------------
-- Updates template and propagates to non-exception instances.

CREATE OR REPLACE FUNCTION public.update_series_template(
    p_series_id BIGINT,
    p_new_template JSONB,
    p_skip_exceptions BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_series RECORD;
    v_user_id UUID;
    v_updated_count INT := 0;
    v_instance RECORD;
    v_set_clause TEXT;
    v_key TEXT;
    v_value JSONB;
BEGIN
    v_user_id := public.current_user_id();

    -- Get series
    SELECT * INTO v_series
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Merge new template with original (preserves required fields like resource_id)
    -- JSONB || operator: right side takes precedence for duplicate keys
    p_new_template := v_series.entity_template || p_new_template;

    -- Validate merged template
    PERFORM metadata.validate_entity_template(v_series.entity_table, p_new_template);

    -- Update series template
    UPDATE metadata.time_slot_series
    SET
        entity_template = p_new_template,
        template_updated_at = NOW(),
        template_updated_by = v_user_id
    WHERE id = p_series_id;

    -- Build dynamic SET clause for entity updates
    v_set_clause := '';
    FOR v_key, v_value IN SELECT * FROM jsonb_each(p_new_template)
    LOOP
        IF v_key != 'time_slot' THEN
            IF v_set_clause != '' THEN
                v_set_clause := v_set_clause || ', ';
            END IF;
            v_set_clause := v_set_clause || format('%I = %L', v_key, v_value #>> '{}');
        END IF;
    END LOOP;

    -- Update non-exception entity records
    IF v_set_clause != '' THEN
        FOR v_instance IN
            SELECT entity_id
            FROM metadata.time_slot_instances
            WHERE series_id = p_series_id
              AND entity_id IS NOT NULL
              AND (NOT p_skip_exceptions OR NOT is_exception)
        LOOP
            EXECUTE format(
                'UPDATE public.%I SET %s WHERE id = $1',
                v_series.entity_table,
                v_set_clause
            ) USING v_instance.entity_id;
            v_updated_count := v_updated_count + 1;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', format('Updated %s instances', v_updated_count),
        'series_id', p_series_id,
        'instances_updated', v_updated_count
    );
END;
$$;

COMMENT ON FUNCTION public.update_series_template(BIGINT, JSONB, BOOLEAN) IS
    'Updates series template and propagates to non-exception instances.
     Use for "edit all occurrences" operations.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 8.6b Update Series Group Info
-- ----------------------------------------------------------------------------
-- Updates group display info (name, description, color).

CREATE OR REPLACE FUNCTION public.update_series_group_info(
    p_group_id BIGINT,
    p_display_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_color TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_group RECORD;
    v_user_id UUID;
BEGIN
    v_user_id := public.current_user_id();

    -- Get group
    SELECT * INTO v_group
    FROM metadata.time_slot_series_groups
    WHERE id = p_group_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Group not found');
    END IF;

    -- Check permissions (creator or has update permission or admin)
    IF NOT (
        v_group.created_by = v_user_id
        OR public.has_permission('time_slot_series_groups', 'update')
        OR public.is_admin()
    ) THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Permission denied');
    END IF;

    -- Update group
    UPDATE metadata.time_slot_series_groups
    SET
        display_name = COALESCE(NULLIF(TRIM(p_display_name), ''), display_name),
        description = p_description,
        color = p_color,
        updated_at = NOW()
    WHERE id = p_group_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', 'Group updated',
        'group_id', p_group_id
    );
END;
$$;

COMMENT ON FUNCTION public.update_series_group_info(BIGINT, TEXT, TEXT, TEXT) IS
    'Updates series group display info (name, description, color).
     Requires creator, update permission, or admin.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 8.6c Update Series Schedule
-- ----------------------------------------------------------------------------
-- Updates series schedule (dtstart, duration, rrule) and regenerates instances.

CREATE OR REPLACE FUNCTION public.update_series_schedule(
    p_series_id BIGINT,
    p_dtstart TIMESTAMPTZ,
    p_duration INTERVAL,
    p_rrule TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_series RECORD;
    v_user_id UUID;
    v_entity_ids BIGINT[];
    v_deleted_count INT := 0;
    v_expand_until DATE;
BEGIN
    v_user_id := public.current_user_id();

    -- Get series
    SELECT * INTO v_series
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Check permissions (creator or has update permission or admin)
    IF NOT (
        v_series.created_by = v_user_id
        OR public.has_permission('time_slot_series', 'update')
        OR public.is_admin()
    ) THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Permission denied');
    END IF;

    -- Validate RRULE (will raise exception if invalid)
    PERFORM metadata.validate_rrule(p_rrule);

    -- Step 1: Collect entity IDs from non-exception instances
    SELECT array_agg(entity_id) INTO v_entity_ids
    FROM metadata.time_slot_instances
    WHERE series_id = p_series_id
      AND entity_id IS NOT NULL
      AND is_exception = FALSE;

    -- Step 2: Delete entity records
    IF v_entity_ids IS NOT NULL AND array_length(v_entity_ids, 1) > 0 THEN
        EXECUTE format(
            'DELETE FROM public.%I WHERE id = ANY($1)',
            v_series.entity_table
        ) USING v_entity_ids;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    -- Step 3: Delete non-exception instances
    DELETE FROM metadata.time_slot_instances
    WHERE series_id = p_series_id AND is_exception = FALSE;

    -- Step 4: Update series schedule and reset expansion tracking
    UPDATE metadata.time_slot_series
    SET
        dtstart = p_dtstart,
        duration = p_duration,
        rrule = p_rrule,
        expanded_until = NULL,  -- Reset to trigger fresh expansion
        effective_from = p_dtstart::DATE
    WHERE id = p_series_id;

    -- Step 5: Calculate expansion horizon (90 days from TODAY, not dtstart)
    -- This ensures series starting in the past expand up to the present + 90 days
    v_expand_until := (NOW() + INTERVAL '90 days')::DATE;

    -- Step 6: Queue River job for expansion
    INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at)
    VALUES (
        'available',
        'recurring',
        'expand_recurring_series',
        jsonb_build_object(
            'series_id', p_series_id,
            'expand_until', to_char(v_expand_until::TIMESTAMPTZ, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ),
        3,
        NOW(),
        NOW()
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', format('Schedule updated. Deleted %s old records. Expansion queued.', v_deleted_count),
        'series_id', p_series_id,
        'entities_deleted', v_deleted_count,
        'expand_until', v_expand_until
    );
END;
$$;

COMMENT ON FUNCTION public.update_series_schedule(BIGINT, TIMESTAMPTZ, INTERVAL, TEXT) IS
    'Updates series schedule (dtstart, duration, rrule) and regenerates instances.
     Deletes existing non-exception instances and entity records, then queues expansion.
     Requires creator, update permission, or admin.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 8.7 Delete Series With Instances
-- ----------------------------------------------------------------------------
-- Atomically deletes series and all its entity records.

CREATE OR REPLACE FUNCTION public.delete_series_with_instances(
    p_series_id BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_series RECORD;
    v_entity_ids BIGINT[];
    v_deleted_count INT := 0;
BEGIN
    -- Get series info
    SELECT * INTO v_series
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Collect all entity IDs
    SELECT array_agg(entity_id) INTO v_entity_ids
    FROM metadata.time_slot_instances
    WHERE series_id = p_series_id AND entity_id IS NOT NULL;

    -- Delete entity records
    IF v_entity_ids IS NOT NULL AND array_length(v_entity_ids, 1) > 0 THEN
        EXECUTE format(
            'DELETE FROM public.%I WHERE id = ANY($1)',
            v_series.entity_table
        ) USING v_entity_ids;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    -- Allow direct delete (bypass trigger)
    PERFORM set_config('recurring.allow_direct_delete', 'true', true);

    -- Delete series (cascades to instances via FK)
    DELETE FROM metadata.time_slot_series WHERE id = p_series_id;

    -- If this was the last series in the group, delete the group
    DELETE FROM metadata.time_slot_series_groups g
    WHERE g.id = v_series.group_id
      AND NOT EXISTS (
          SELECT 1 FROM metadata.time_slot_series s WHERE s.group_id = g.id
      );

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', format('Deleted series and %s entity records', v_deleted_count),
        'series_id', p_series_id,
        'entities_deleted', v_deleted_count
    );
END;
$$;

COMMENT ON FUNCTION public.delete_series_with_instances(BIGINT) IS
    'Atomically deletes a series and all its entity records.
     Cleans up group if this was the last series.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 8.8 Delete Series Group
-- ----------------------------------------------------------------------------
-- Deletes entire group with all versions.

CREATE OR REPLACE FUNCTION public.delete_series_group(
    p_group_id BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_series RECORD;
    v_total_deleted INT := 0;
    v_result JSONB;
    v_group_exists BOOLEAN;
BEGIN
    -- Check if group exists
    SELECT EXISTS(
        SELECT 1 FROM metadata.time_slot_series_groups WHERE id = p_group_id
    ) INTO v_group_exists;

    IF NOT v_group_exists THEN
        RETURN jsonb_build_object(
            'success', FALSE,
            'message', format('Group %s not found', p_group_id),
            'group_id', p_group_id
        );
    END IF;

    -- Delete each series in the group
    FOR v_series IN
        SELECT id FROM metadata.time_slot_series WHERE group_id = p_group_id
    LOOP
        v_result := public.delete_series_with_instances(v_series.id);
        IF v_result->>'success' = 'true' THEN
            v_total_deleted := v_total_deleted + COALESCE((v_result->>'entities_deleted')::INT, 0);
        END IF;
    END LOOP;

    -- Group should be deleted via cascade when last series is deleted
    -- But ensure it's gone
    DELETE FROM metadata.time_slot_series_groups WHERE id = p_group_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', format('Deleted group and %s entity records', v_total_deleted),
        'group_id', p_group_id,
        'entities_deleted', v_total_deleted
    );
END;
$$;

COMMENT ON FUNCTION public.delete_series_group(BIGINT) IS
    'Deletes an entire series group with all versions and entity records.
     Added in v0.19.0.';


-- ----------------------------------------------------------------------------
-- 8.9 Get Series Membership
-- ----------------------------------------------------------------------------
-- Check if an entity record belongs to a series.

CREATE OR REPLACE FUNCTION public.get_series_membership(
    p_entity_table NAME,
    p_entity_id BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
    v_instance RECORD;
BEGIN
    SELECT
        tsi.*,
        ts.rrule,
        ts.dtstart,
        ts.duration,
        ts.entity_template,
        ts.group_id,
        tsg.display_name AS group_name,
        tsg.color AS group_color
    INTO v_instance
    FROM metadata.time_slot_instances tsi
    JOIN metadata.time_slot_series ts ON ts.id = tsi.series_id
    LEFT JOIN metadata.time_slot_series_groups tsg ON tsg.id = ts.group_id
    WHERE tsi.entity_table = p_entity_table AND tsi.entity_id = p_entity_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('is_member', FALSE);
    END IF;

    RETURN jsonb_build_object(
        'is_member', TRUE,
        'series_id', v_instance.series_id,
        'group_id', v_instance.group_id,
        'group_name', v_instance.group_name,
        'group_color', v_instance.group_color,
        'occurrence_date', v_instance.occurrence_date,
        'is_exception', v_instance.is_exception,
        'exception_type', v_instance.exception_type,
        'original_template', v_instance.entity_template
    );
END;
$$;

COMMENT ON FUNCTION public.get_series_membership(NAME, BIGINT) IS
    'Check if an entity record belongs to a recurring series.
     Returns membership info including group name and template.
     Added in v0.19.0.';


-- ============================================================================
-- 9. SUMMARY VIEW
-- ============================================================================

CREATE OR REPLACE VIEW metadata.series_groups_summary AS
SELECT
    g.id,
    g.display_name,
    g.description,
    g.color,
    g.created_by,
    g.created_at,
    g.updated_at,

    -- Aggregate stats
    COUNT(DISTINCT s.id) AS version_count,
    MIN(s.effective_from) AS started_on,

    -- Entity table (should be same across all versions)
    (SELECT s2.entity_table FROM metadata.time_slot_series s2 WHERE s2.group_id = g.id LIMIT 1) AS entity_table,

    -- Current version info
    (
        SELECT jsonb_build_object(
            'series_id', cs.id,
            'rrule', cs.rrule,
            'dtstart', cs.dtstart,
            'duration', cs.duration,
            'status', cs.status,
            'entity_template', cs.entity_template
        )
        FROM metadata.time_slot_series cs
        WHERE cs.group_id = g.id AND cs.effective_until IS NULL
        ORDER BY cs.version_number DESC
        LIMIT 1
    ) AS current_version,

    -- Instance counts
    (
        SELECT COUNT(*)
        FROM metadata.time_slot_instances tsi
        JOIN metadata.time_slot_series s2 ON s2.id = tsi.series_id
        WHERE s2.group_id = g.id AND tsi.entity_id IS NOT NULL
    ) AS active_instance_count,

    (
        SELECT COUNT(*)
        FROM metadata.time_slot_instances tsi
        JOIN metadata.time_slot_series s2 ON s2.id = tsi.series_id
        WHERE s2.group_id = g.id AND tsi.is_exception = TRUE
    ) AS exception_count,

    -- Status derived from versions
    CASE
        WHEN EXISTS (
            SELECT 1 FROM metadata.time_slot_series s3
            WHERE s3.group_id = g.id AND s3.effective_until IS NULL AND s3.status = 'active'
        ) THEN 'active'
        WHEN EXISTS (
            SELECT 1 FROM metadata.time_slot_series s3
            WHERE s3.group_id = g.id AND s3.status = 'needs_attention'
        ) THEN 'needs_attention'
        ELSE 'ended'
    END AS status,

    -- Embedded instances as JSONB array (limited to 100 most recent)
    -- Includes upcoming and recent past occurrences for detail view display
    (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', tsi.id,
                'series_id', tsi.series_id,
                'occurrence_date', tsi.occurrence_date,
                'entity_table', tsi.entity_table,
                'entity_id', tsi.entity_id,
                'is_exception', tsi.is_exception,
                'exception_type', tsi.exception_type,
                'exception_reason', tsi.exception_reason
            ) ORDER BY tsi.occurrence_date ASC
        ), '[]'::jsonb)
        FROM (
            SELECT tsi2.*
            FROM metadata.time_slot_instances tsi2
            JOIN metadata.time_slot_series s4 ON s4.id = tsi2.series_id
            WHERE s4.group_id = g.id
            ORDER BY tsi2.occurrence_date ASC
            LIMIT 100
        ) tsi
    ) AS instances

FROM metadata.time_slot_series_groups g
LEFT JOIN metadata.time_slot_series s ON s.group_id = g.id
GROUP BY g.id;

COMMENT ON VIEW metadata.series_groups_summary IS
    'Aggregated view of series groups with stats and embedded instances for UI display.
     Added in v0.19.0.';


-- ============================================================================
-- 10. PUBLIC VIEW FOR POSTGREST ACCESS
-- ============================================================================

CREATE OR REPLACE VIEW public.schema_series_groups
WITH (security_invoker = true)
AS
SELECT
    id,
    display_name,
    description,
    color,
    created_by,
    created_at,
    updated_at,
    version_count,
    started_on,
    entity_table,
    current_version,
    active_instance_count,
    exception_count,
    status,
    instances
FROM metadata.series_groups_summary;

COMMENT ON VIEW public.schema_series_groups IS
    'Read-only view of series groups with embedded instances for PostgREST access.
     Uses security_invoker to evaluate permissions as calling user.
     Added in v0.19.0.';


-- ============================================================================
-- 10b. PUBLIC VIEWS FOR SERIES AND INSTANCES (for direct PostgREST access)
-- ============================================================================

-- Series view (read-only)
CREATE OR REPLACE VIEW public.time_slot_series
WITH (security_invoker = true)
AS
SELECT
    id,
    group_id,
    version_number,
    effective_from,
    effective_until,
    entity_table,
    entity_template,
    rrule,
    dtstart,
    duration,
    timezone,
    time_slot_property,
    status,
    expanded_until,
    created_by,
    created_at,
    template_updated_at,
    template_updated_by
FROM metadata.time_slot_series;

COMMENT ON VIEW public.time_slot_series IS
    'Read-only view of time slot series for PostgREST access.
     Uses security_invoker to evaluate permissions as calling user.
     Added in v0.19.0.';

-- Instances view (read-only)
CREATE OR REPLACE VIEW public.time_slot_instances
WITH (security_invoker = true)
AS
SELECT
    id,
    series_id,
    occurrence_date,
    entity_table,
    entity_id,
    is_exception,
    exception_type,
    original_time_slot,
    exception_reason,
    exception_at,
    exception_by,
    created_at
FROM metadata.time_slot_instances;

COMMENT ON VIEW public.time_slot_instances IS
    'Read-only view of time slot instances for PostgREST access.
     Uses security_invoker to evaluate permissions as calling user.
     Added in v0.19.0.';


-- ============================================================================
-- 11. ROW LEVEL SECURITY POLICIES
-- ============================================================================

ALTER TABLE metadata.time_slot_series_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.time_slot_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.time_slot_instances ENABLE ROW LEVEL SECURITY;

-- Series Groups: everyone reads, creators and admins modify
CREATE POLICY series_groups_select ON metadata.time_slot_series_groups
    FOR SELECT TO PUBLIC USING (true);

CREATE POLICY series_groups_insert ON metadata.time_slot_series_groups
    FOR INSERT TO authenticated
    WITH CHECK (
        public.has_permission('time_slot_series_groups', 'create')
        OR public.is_admin()
    );

CREATE POLICY series_groups_update ON metadata.time_slot_series_groups
    FOR UPDATE TO authenticated
    USING (
        created_by = public.current_user_id()
        OR public.has_permission('time_slot_series_groups', 'update')
        OR public.is_admin()
    )
    WITH CHECK (
        created_by = public.current_user_id()
        OR public.has_permission('time_slot_series_groups', 'update')
        OR public.is_admin()
    );

CREATE POLICY series_groups_delete ON metadata.time_slot_series_groups
    FOR DELETE TO authenticated
    USING (
        created_by = public.current_user_id()
        OR public.has_permission('time_slot_series_groups', 'delete')
        OR public.is_admin()
    );

-- Series: similar pattern
CREATE POLICY series_select ON metadata.time_slot_series
    FOR SELECT TO PUBLIC USING (true);

CREATE POLICY series_insert ON metadata.time_slot_series
    FOR INSERT TO authenticated
    WITH CHECK (
        public.has_permission('time_slot_series', 'create')
        OR public.is_admin()
    );

CREATE POLICY series_update ON metadata.time_slot_series
    FOR UPDATE TO authenticated
    USING (
        created_by = public.current_user_id()
        OR public.has_permission('time_slot_series', 'update')
        OR public.is_admin()
    )
    WITH CHECK (
        created_by = public.current_user_id()
        OR public.has_permission('time_slot_series', 'update')
        OR public.is_admin()
    );

-- Note: DELETE is blocked by trigger, must use RPC

-- Instances: read all, modify requires series permission
CREATE POLICY instances_select ON metadata.time_slot_instances
    FOR SELECT TO PUBLIC USING (true);

CREATE POLICY instances_insert ON metadata.time_slot_instances
    FOR INSERT TO authenticated
    WITH CHECK (
        public.has_permission('time_slot_instances', 'create')
        OR public.is_admin()
    );

CREATE POLICY instances_update ON metadata.time_slot_instances
    FOR UPDATE TO authenticated
    USING (
        public.has_permission('time_slot_instances', 'update')
        OR public.is_admin()
    )
    WITH CHECK (
        public.has_permission('time_slot_instances', 'update')
        OR public.is_admin()
    );

CREATE POLICY instances_delete ON metadata.time_slot_instances
    FOR DELETE TO authenticated
    USING (
        public.has_permission('time_slot_instances', 'delete')
        OR public.is_admin()
    );


-- ============================================================================
-- 12. GRANTS
-- ============================================================================

-- Series Groups
GRANT SELECT ON metadata.time_slot_series_groups TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.time_slot_series_groups TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.time_slot_series_groups_id_seq TO authenticated;

-- Series
GRANT SELECT ON metadata.time_slot_series TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.time_slot_series TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.time_slot_series_id_seq TO authenticated;

-- Instances
GRANT SELECT ON metadata.time_slot_instances TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.time_slot_instances TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.time_slot_instances_id_seq TO authenticated;

-- Summary view
GRANT SELECT ON metadata.series_groups_summary TO web_anon, authenticated;

-- Public views
GRANT SELECT ON public.schema_series_groups TO web_anon, authenticated;
GRANT SELECT ON public.time_slot_series TO web_anon, authenticated;
GRANT SELECT ON public.time_slot_instances TO web_anon, authenticated;

-- Functions
GRANT EXECUTE ON FUNCTION public.preview_recurring_conflicts(NAME, NAME, TEXT, NAME, TIMESTAMPTZ[][]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMPTZ, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expand_series_instances(BIGINT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_series_occurrence(NAME, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.split_series_from_date(BIGINT, DATE, TIMESTAMPTZ, INTERVAL, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_series_template(BIGINT, JSONB, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_series_group_info(BIGINT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_series_schedule(BIGINT, TIMESTAMPTZ, INTERVAL, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_series_with_instances(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_series_group(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_series_membership(NAME, BIGINT) TO authenticated;


-- ============================================================================
-- 13. REGISTER ENTITIES FOR PERMISSIONS UI
-- ============================================================================

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES
    ('time_slot_series_groups', 'Recurring Schedule Groups', 'Logical groupings of recurring schedules', 9900),
    ('time_slot_series', 'Recurring Series', 'RRULE definitions and entity templates', 9901),
    ('time_slot_instances', 'Series Instances', 'Individual occurrences within a recurring series', 9902)
ON CONFLICT (table_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description;


-- ============================================================================
-- 14. DEFAULT PERMISSIONS
-- ============================================================================
-- Create permission entries for the new tables and grant to admin role.

-- First, insert permissions for each table/action combo
INSERT INTO metadata.permissions (table_name, permission)
SELECT t.table_name::name, p.permission::metadata.permission
FROM (
    VALUES
        ('time_slot_series_groups'),
        ('time_slot_series'),
        ('time_slot_instances')
) AS t(table_name)
CROSS JOIN (
    VALUES ('create'), ('read'), ('update'), ('delete')
) AS p(permission)
ON CONFLICT (table_name, permission) DO NOTHING;

-- Then, link permissions to admin role
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('time_slot_series_groups', 'time_slot_series', 'time_slot_instances')
  AND r.display_name = 'admin'
ON CONFLICT (permission_id, role_id) DO NOTHING;


-- ============================================================================
-- 15. UPDATE PROPERTY MANAGEMENT RPC FOR IS_RECURRING
-- ============================================================================
-- Add is_recurring parameter to upsert_property_metadata function.
-- This allows admins to enable recurring schedules via Property Management UI.

CREATE OR REPLACE FUNCTION public.upsert_property_metadata(
  p_table_name NAME,
  p_column_name NAME,
  p_display_name TEXT,
  p_description TEXT,
  p_sort_order INT,
  p_column_width INT,
  p_sortable BOOLEAN,
  p_filterable BOOLEAN,
  p_show_on_list BOOLEAN,
  p_show_on_create BOOLEAN,
  p_show_on_edit BOOLEAN,
  p_show_on_detail BOOLEAN,
  p_is_recurring BOOLEAN DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  -- Check if user is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Upsert the property metadata
  INSERT INTO metadata.properties (
    table_name,
    column_name,
    display_name,
    description,
    sort_order,
    column_width,
    sortable,
    filterable,
    show_on_list,
    show_on_create,
    show_on_edit,
    show_on_detail,
    is_recurring
  )
  VALUES (
    p_table_name,
    p_column_name,
    p_display_name,
    p_description,
    p_sort_order,
    p_column_width,
    p_sortable,
    p_filterable,
    p_show_on_list,
    p_show_on_create,
    p_show_on_edit,
    p_show_on_detail,
    COALESCE(p_is_recurring, FALSE)
  )
  ON CONFLICT (table_name, column_name)
  DO UPDATE SET
    display_name = COALESCE(EXCLUDED.display_name, metadata.properties.display_name),
    description = COALESCE(EXCLUDED.description, metadata.properties.description),
    sort_order = COALESCE(EXCLUDED.sort_order, metadata.properties.sort_order),
    column_width = COALESCE(EXCLUDED.column_width, metadata.properties.column_width),
    sortable = COALESCE(EXCLUDED.sortable, metadata.properties.sortable),
    filterable = COALESCE(EXCLUDED.filterable, metadata.properties.filterable),
    show_on_list = COALESCE(EXCLUDED.show_on_list, metadata.properties.show_on_list),
    show_on_create = COALESCE(EXCLUDED.show_on_create, metadata.properties.show_on_create),
    show_on_edit = COALESCE(EXCLUDED.show_on_edit, metadata.properties.show_on_edit),
    show_on_detail = COALESCE(EXCLUDED.show_on_detail, metadata.properties.show_on_detail),
    is_recurring = COALESCE(EXCLUDED.is_recurring, metadata.properties.is_recurring);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) IS
    'Upsert property metadata including is_recurring flag. Updated in v0.19.0.';

-- Grant execute on new signature (old signature still works via default parameter)
GRANT EXECUTE ON FUNCTION public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) TO authenticated;


-- ============================================================================
-- 16. UPDATE SCHEMA_PROPERTIES VIEW TO INCLUDE IS_RECURRING
-- ============================================================================

-- Add is_recurring column to schema_properties view so frontend can detect
-- which properties support recurring schedules
CREATE OR REPLACE VIEW public.schema_properties AS
SELECT columns.table_catalog,
    columns.table_schema,
    columns.table_name,
    columns.column_name,
    COALESCE(properties.display_name, initcap(replace(columns.column_name::text, '_'::text, ' '::text))) AS display_name,
    properties.description,
    COALESCE(properties.sort_order, columns.ordinal_position::integer) AS sort_order,
    properties.column_width,
    COALESCE(properties.sortable, true) AS sortable,
    COALESCE(properties.filterable, false) AS filterable,
    COALESCE(properties.show_on_list,
        CASE
            WHEN columns.column_name::text = ANY (ARRAY['id'::text, 'civic_os_text_search'::text, 'created_at'::text, 'updated_at'::text]) THEN false
            ELSE true
        END) AS show_on_list,
    COALESCE(properties.show_on_create,
        CASE
            WHEN columns.column_name::text = ANY (ARRAY['id'::text, 'civic_os_text_search'::text, 'created_at'::text, 'updated_at'::text]) THEN false
            ELSE true
        END) AS show_on_create,
    COALESCE(properties.show_on_edit,
        CASE
            WHEN columns.column_name::text = ANY (ARRAY['id'::text, 'civic_os_text_search'::text, 'created_at'::text, 'updated_at'::text]) THEN false
            ELSE true
        END) AS show_on_edit,
    COALESCE(properties.show_on_detail,
        CASE
            WHEN columns.column_name::text = ANY (ARRAY['id'::text, 'civic_os_text_search'::text]) THEN false
            WHEN columns.column_name::text = ANY (ARRAY['created_at'::text, 'updated_at'::text]) THEN true
            ELSE true
        END) AS show_on_detail,
    columns.column_default,
    columns.is_nullable::text = 'YES'::text AS is_nullable,
    columns.data_type,
    columns.character_maximum_length,
    columns.udt_schema,
    COALESCE(pg_type_info.domain_name, columns.udt_name::name) AS udt_name,
    columns.is_self_referencing::text = 'YES'::text AS is_self_referencing,
    columns.is_identity::text = 'YES'::text AS is_identity,
    columns.is_generated::text = 'ALWAYS'::text AS is_generated,
    columns.is_updatable::text = 'YES'::text AS is_updatable,
    relations.join_schema,
    relations.join_table,
    relations.join_column,
    CASE
        WHEN columns.udt_name::text = ANY (ARRAY['geography'::text, 'geometry'::text]) THEN substring(pg_type_info.formatted_type, '\(([A-Za-z]+)'::text)
        ELSE NULL::text
    END AS geography_type,
    COALESCE(validation_rules_agg.validation_rules, '[]'::jsonb) AS validation_rules,
    properties.status_entity_type,
    COALESCE(properties.is_recurring, false) AS is_recurring
FROM information_schema.columns
LEFT JOIN ( SELECT schema_relations_func.src_schema,
        schema_relations_func.src_table,
        schema_relations_func.src_column,
        schema_relations_func.constraint_schema,
        schema_relations_func.constraint_name,
        schema_relations_func.join_schema,
        schema_relations_func.join_table,
        schema_relations_func.join_column
       FROM schema_relations_func() schema_relations_func(src_schema, src_table, src_column, constraint_schema, constraint_name, join_schema, join_table, join_column)) relations ON columns.table_schema::name = relations.src_schema AND columns.table_name::name = relations.src_table AND columns.column_name::name = relations.src_column
LEFT JOIN metadata.properties ON properties.table_name = columns.table_name::name AND properties.column_name = columns.column_name::name
LEFT JOIN ( SELECT c.relname AS table_name,
        a.attname AS column_name,
        format_type(a.atttypid, a.atttypmod) AS formatted_type,
        CASE
            WHEN t.typtype = 'd'::"char" THEN t.typname
            ELSE NULL::name
        END AS domain_name
       FROM pg_attribute a
         JOIN pg_class c ON a.attrelid = c.oid
         JOIN pg_namespace n ON c.relnamespace = n.oid
         LEFT JOIN pg_type t ON a.atttypid = t.oid
      WHERE n.nspname = 'public'::name AND a.attnum > 0 AND NOT a.attisdropped) pg_type_info ON pg_type_info.table_name = columns.table_name::name AND pg_type_info.column_name = columns.column_name::name
LEFT JOIN ( SELECT validations.table_name,
        validations.column_name,
        jsonb_agg(jsonb_build_object('type', validations.validation_type, 'value', validations.validation_value, 'message', validations.error_message) ORDER BY validations.sort_order) AS validation_rules
       FROM metadata.validations
      GROUP BY validations.table_name, validations.column_name) validation_rules_agg ON validation_rules_agg.table_name = columns.table_name::name AND validation_rules_agg.column_name = columns.column_name::name
WHERE columns.table_schema::name = 'public'::name AND (columns.table_name::name IN ( SELECT schema_entities.table_name FROM schema_entities));

COMMENT ON VIEW public.schema_properties IS
    'Property metadata view with is_recurring column. Updated in v0.19.0.';

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- ============================================================================
-- 17. UPDATE SCHEMA_ENTITIES VIEW TO INCLUDE RECURRING CONFIG
-- ============================================================================

-- Add supports_recurring and recurring_property_name to schema_entities view
-- following the same pattern as show_calendar + calendar_property_name
CREATE OR REPLACE VIEW public.schema_entities AS
SELECT
    COALESCE(entities.display_name, tables.table_name::text) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    entities.description,
    entities.search_fields,
    COALESCE(entities.show_map, false) AS show_map,
    entities.map_property_name,
    tables.table_name,
    has_permission(tables.table_name::text, 'create'::text) AS insert,
    has_permission(tables.table_name::text, 'read'::text) AS "select",
    has_permission(tables.table_name::text, 'update'::text) AS update,
    has_permission(tables.table_name::text, 'delete'::text) AS delete,
    COALESCE(entities.show_calendar, false) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    COALESCE(entities.enable_notes, false) AS enable_notes,
    -- Recurring configuration (v0.19.0)
    COALESCE(entities.supports_recurring, false) AS supports_recurring,
    entities.recurring_property_name
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name AND tables.table_type::text = 'BASE TABLE'::text
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view with recurring configuration. Updated in v0.19.0.';

GRANT SELECT ON public.schema_entities TO web_anon, authenticated;


-- ============================================================================
-- 18. ORPHANED INSTANCE CLEANUP FUNCTION
-- ============================================================================
-- When entity records are deleted directly (bypassing RPCs), this trigger
-- function marks the corresponding junction records as cancelled rather than
-- leaving them orphaned. Integrators must add this trigger to their entity tables.

CREATE OR REPLACE FUNCTION metadata.cleanup_orphaned_instances()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Mark the instance as cancelled instead of leaving orphaned junction record
    UPDATE metadata.time_slot_instances
    SET entity_id = NULL,
        is_exception = TRUE,
        exception_type = 'cancelled',
        exception_reason = 'Entity record deleted directly',
        exception_at = NOW()
    WHERE entity_table = TG_TABLE_NAME
      AND entity_id = OLD.id;
    RETURN OLD;
END;
$$;

COMMENT ON FUNCTION metadata.cleanup_orphaned_instances() IS
    'Trigger function for entity tables with recurring support.
     Marks junction records as cancelled when entity is deleted directly.
     Integrators should add: CREATE TRIGGER cleanup_series_on_delete
       BEFORE DELETE ON mytable FOR EACH ROW
       EXECUTE FUNCTION metadata.cleanup_orphaned_instances();
     Added in v0.19.0.';


-- ============================================================================
-- 19. RESCHEDULE OCCURRENCE RPC
-- ============================================================================
-- Reschedules a single occurrence to a new time slot while preserving
-- the original time for audit purposes.

CREATE OR REPLACE FUNCTION public.reschedule_occurrence(
    p_entity_table NAME,
    p_entity_id BIGINT,
    p_new_time_slot TSTZRANGE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_instance RECORD;
    v_old_slot TSTZRANGE;
    v_user_id UUID;
BEGIN
    v_user_id := public.current_user_id();

    -- Get instance info
    SELECT * INTO v_instance
    FROM metadata.time_slot_instances
    WHERE entity_table = p_entity_table AND entity_id = p_entity_id;

    IF NOT FOUND THEN
        -- Not part of a series, just update directly
        EXECUTE format('UPDATE public.%I SET time_slot = $1 WHERE id = $2', p_entity_table)
        USING p_new_time_slot, p_entity_id;
        RETURN jsonb_build_object(
            'success', TRUE,
            'message', 'Time slot updated (not part of a series)'
        );
    END IF;

    -- Get current time_slot for audit trail
    EXECUTE format('SELECT time_slot FROM public.%I WHERE id = $1', p_entity_table)
    INTO v_old_slot USING p_entity_id;

    -- Update entity time slot
    EXECUTE format('UPDATE public.%I SET time_slot = $1 WHERE id = $2', p_entity_table)
    USING p_new_time_slot, p_entity_id;

    -- Mark as rescheduled exception (preserves history)
    UPDATE metadata.time_slot_instances
    SET is_exception = TRUE,
        exception_type = 'rescheduled',
        original_time_slot = v_old_slot,
        exception_at = NOW(),
        exception_by = v_user_id
    WHERE id = v_instance.id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', 'Occurrence rescheduled',
        'series_id', v_instance.series_id,
        'occurrence_date', v_instance.occurrence_date,
        'original_time_slot', v_old_slot::TEXT,
        'new_time_slot', p_new_time_slot::TEXT
    );
END;
$$;

COMMENT ON FUNCTION public.reschedule_occurrence(NAME, BIGINT, TSTZRANGE) IS
    'Reschedules a single occurrence of a recurring series to a new time.
     Marks junction as rescheduled and stores original time for audit.
     Added in v0.19.0.';

GRANT EXECUTE ON FUNCTION public.reschedule_occurrence(NAME, BIGINT, TSTZRANGE) TO authenticated;


-- ============================================================================
-- 20. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
