-- Deploy civic_os:v0-16-0-add-entity-notes to pg
-- requires: v0-15-0-add-status-type

BEGIN;

-- ============================================================================
-- ENTITY NOTES SYSTEM
-- ============================================================================
-- Version: v0.16.0
-- Purpose: Framework-level notes system that any entity can opt into via
--          metadata configuration. Notes are polymorphic (one table serves
--          all entities) and support both human-authored and trigger-generated
--          content.
--
-- Tables:
--   metadata.entity_notes - Polymorphic notes storage
--
-- Configuration:
--   metadata.entities.enable_notes - Enable notes for an entity
--
-- Pattern:
--   1. Enable notes: SELECT enable_entity_notes('my_table');
--   2. (Optional) Add triggers for system notes
--   3. Done! Notes section appears on Detail pages
-- ============================================================================


-- ============================================================================
-- 1. ENTITY_NOTES TABLE
-- ============================================================================

CREATE TABLE metadata.entity_notes (
    id BIGSERIAL PRIMARY KEY,

    -- Polymorphic reference to parent entity
    entity_type NAME NOT NULL,           -- Table name: 'issues', 'reservations', etc.
    entity_id TEXT NOT NULL,             -- PK of parent (text for flexibility with UUID/int)

    -- Author (NULL for cron-triggered system notes, references actual table not view)
    author_id UUID REFERENCES metadata.civic_os_users(id) ON DELETE SET NULL,

    -- Content
    content TEXT NOT NULL,

    -- Categorization
    note_type VARCHAR(50) NOT NULL DEFAULT 'note',  -- 'note' (human), 'system' (trigger)

    -- Visibility
    is_internal BOOLEAN NOT NULL DEFAULT TRUE,  -- Hide from anonymous/public views

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Soft delete (optional)
    deleted_at TIMESTAMPTZ,

    -- Constraints
    CONSTRAINT content_not_empty CHECK (trim(content) != ''),
    CONSTRAINT content_max_length CHECK (length(content) <= 10000),
    CONSTRAINT valid_note_type CHECK (note_type IN ('note', 'system'))
);

COMMENT ON TABLE metadata.entity_notes IS
    'Polymorphic notes table for all entities. Notes are opt-in per entity via
     metadata.entities.enable_notes. Supports human-authored (note_type=note) and
     trigger-generated (note_type=system) content. Added in v0.16.0.';

COMMENT ON COLUMN metadata.entity_notes.entity_type IS
    'Table name of the parent entity (e.g., ''issues'', ''reservations'')';

COMMENT ON COLUMN metadata.entity_notes.entity_id IS
    'Primary key of the parent entity as text (supports both int and UUID)';

COMMENT ON COLUMN metadata.entity_notes.author_id IS
    'UUID of the user who created the note. For system notes, this is the user who triggered the action.';

COMMENT ON COLUMN metadata.entity_notes.content IS
    'Note content. Supports simple Markdown: **bold**, *italic*, [link](url)';

COMMENT ON COLUMN metadata.entity_notes.note_type IS
    'Type of note: ''note'' for human-authored, ''system'' for trigger-generated';

COMMENT ON COLUMN metadata.entity_notes.is_internal IS
    'When TRUE, note is hidden from anonymous/public views (default TRUE)';

-- Timestamps trigger
CREATE TRIGGER set_entity_notes_updated_at
    BEFORE UPDATE ON metadata.entity_notes
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 2. INDEXES
-- ============================================================================

-- Primary lookup: notes for a specific entity
CREATE INDEX idx_entity_notes_entity ON metadata.entity_notes(entity_type, entity_id);

-- Author lookup: all notes by a user
CREATE INDEX idx_entity_notes_author ON metadata.entity_notes(author_id);

-- Time-ordered listing
CREATE INDEX idx_entity_notes_created ON metadata.entity_notes(created_at DESC);

-- Soft delete filter
CREATE INDEX idx_entity_notes_active ON metadata.entity_notes(entity_type, entity_id)
    WHERE deleted_at IS NULL;


-- ============================================================================
-- 3. ADD enable_notes TO metadata.entities
-- ============================================================================

ALTER TABLE metadata.entities
    ADD COLUMN enable_notes BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN metadata.entities.enable_notes IS
    'When TRUE, notes section appears on Detail pages for this entity';


-- ============================================================================
-- 4. ROW LEVEL SECURITY POLICIES
-- ============================================================================
-- Notes use dedicated granular permissions ({entity}:notes:read and {entity}:notes:create)
-- separate from entity-level permissions. This allows scenarios like "citizens can read
-- issues but only staff can see notes."

ALTER TABLE metadata.entity_notes ENABLE ROW LEVEL SECURITY;

-- Read notes: requires {entity}:notes:read permission
CREATE POLICY entity_notes_select ON metadata.entity_notes
    FOR SELECT TO authenticated
    USING (
        has_permission(entity_type || ':notes', 'read')
        OR is_admin()
    );

-- Create notes: requires {entity}:notes:create permission
CREATE POLICY entity_notes_insert ON metadata.entity_notes
    FOR INSERT TO authenticated
    WITH CHECK (
        has_permission(entity_type || ':notes', 'create')
        OR is_admin()
    );

-- Update own notes: must be author AND have create permission
CREATE POLICY entity_notes_update ON metadata.entity_notes
    FOR UPDATE TO authenticated
    USING (
        author_id = current_user_id()
        AND (has_permission(entity_type || ':notes', 'create') OR is_admin())
    )
    WITH CHECK (
        author_id = current_user_id()
    );

-- Delete notes: own notes with create permission, OR admin can delete any note
CREATE POLICY entity_notes_delete ON metadata.entity_notes
    FOR DELETE TO authenticated
    USING (
        -- Admins can delete any note (moderation)
        is_admin()
        OR (
            -- Regular users can only delete their own notes
            author_id = current_user_id()
            AND has_permission(entity_type || ':notes', 'create')
        )
    );


-- ============================================================================
-- 5. GRANTS
-- ============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON metadata.entity_notes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.entity_notes_id_seq TO authenticated;


-- ============================================================================
-- 6. RPC: CREATE_ENTITY_NOTE
-- ============================================================================
-- Unified function for creating notes from UI or triggers.
-- Validates that notes are enabled for the entity type.

CREATE OR REPLACE FUNCTION public.create_entity_note(
    p_entity_type NAME,
    p_entity_id TEXT,
    p_content TEXT,
    p_note_type VARCHAR DEFAULT 'note',
    p_is_internal BOOLEAN DEFAULT TRUE,
    p_author_id UUID DEFAULT NULL  -- NULL = current_user_id()
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_note_id BIGINT;
    v_author UUID;
BEGIN
    -- Determine author
    v_author := COALESCE(p_author_id, current_user_id());

    -- Validate entity type has notes enabled
    IF NOT EXISTS (
        SELECT 1 FROM metadata.entities
        WHERE table_name = p_entity_type AND enable_notes = TRUE
    ) THEN
        RAISE EXCEPTION 'Notes are not enabled for entity type: %', p_entity_type;
    END IF;

    -- Validate content not empty
    IF TRIM(p_content) = '' THEN
        RAISE EXCEPTION 'Note content cannot be empty';
    END IF;

    -- Insert note
    INSERT INTO metadata.entity_notes (
        entity_type, entity_id, author_id, content, note_type, is_internal
    ) VALUES (
        p_entity_type, p_entity_id, v_author, p_content, p_note_type, p_is_internal
    )
    RETURNING id INTO v_note_id;

    RETURN v_note_id;
END;
$$;

COMMENT ON FUNCTION public.create_entity_note IS
    'Create a note on any entity. Use note_type=''system'' for trigger-generated notes.
     Returns the new note ID. Validates that notes are enabled for the entity type.';

GRANT EXECUTE ON FUNCTION public.create_entity_note TO authenticated;


-- ============================================================================
-- 7. HELPER FUNCTION: ENABLE_ENTITY_NOTES
-- ============================================================================
-- One-liner to enable notes for an entity and set up default permissions.

CREATE OR REPLACE FUNCTION public.enable_entity_notes(p_entity_type NAME)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Enable notes flag (upsert pattern)
    INSERT INTO metadata.entities (table_name, enable_notes)
    VALUES (p_entity_type, TRUE)
    ON CONFLICT (table_name) DO UPDATE SET enable_notes = TRUE;

    -- Create permissions (table_name stores virtual entity like 'issues:notes')
    INSERT INTO metadata.permissions (table_name, permission)
    VALUES
        (p_entity_type || ':notes', 'read'),
        (p_entity_type || ':notes', 'create')
    ON CONFLICT DO NOTHING;

    -- Grant read+create to editor role
    INSERT INTO metadata.permission_roles (permission_id, role_id)
    SELECT p.id, r.id
    FROM metadata.permissions p
    CROSS JOIN metadata.roles r
    WHERE p.table_name = p_entity_type || ':notes'
      AND r.display_name = 'editor'
    ON CONFLICT DO NOTHING;

    -- Grant read to user role
    INSERT INTO metadata.permission_roles (permission_id, role_id)
    SELECT p.id, r.id
    FROM metadata.permissions p
    CROSS JOIN metadata.roles r
    WHERE p.table_name = p_entity_type || ':notes'
      AND p.permission = 'read'
      AND r.display_name = 'user'
    ON CONFLICT DO NOTHING;
END;
$$;

COMMENT ON FUNCTION public.enable_entity_notes IS
    'Enable notes for an entity and create default permissions.
     Grants: user role gets read, editor role gets read+create.
     Usage: SELECT enable_entity_notes(''issues'');';

GRANT EXECUTE ON FUNCTION public.enable_entity_notes TO authenticated;


-- ============================================================================
-- 7.5 TRIGGER: AUTO-CREATE PERMISSIONS WHEN NOTES ENABLED
-- ============================================================================
-- When enable_notes changes from FALSE to TRUE (via any method: UI, RPC, SQL),
-- automatically create the permissions and role grants.

CREATE OR REPLACE FUNCTION metadata.on_entity_notes_enabled()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_old_enabled BOOLEAN;
BEGIN
    -- Handle INSERT (OLD is NULL) vs UPDATE
    IF TG_OP = 'INSERT' THEN
        v_old_enabled := FALSE;
    ELSE
        v_old_enabled := COALESCE(OLD.enable_notes, FALSE);
    END IF;

    -- Only act when enable_notes changes from FALSE/NULL to TRUE
    IF (NEW.enable_notes = TRUE) AND (v_old_enabled = FALSE) THEN
        -- Create permissions (idempotent with ON CONFLICT)
        INSERT INTO metadata.permissions (table_name, permission)
        VALUES
            (NEW.table_name || ':notes', 'read'),
            (NEW.table_name || ':notes', 'create')
        ON CONFLICT (table_name, permission) DO NOTHING;

        -- Grant read+create to editor role (idempotent)
        INSERT INTO metadata.permission_roles (permission_id, role_id)
        SELECT p.id, r.id
        FROM metadata.permissions p
        CROSS JOIN metadata.roles r
        WHERE p.table_name = NEW.table_name || ':notes'
          AND r.display_name = 'editor'
        ON CONFLICT (permission_id, role_id) DO NOTHING;

        -- Grant read to user role (idempotent)
        INSERT INTO metadata.permission_roles (permission_id, role_id)
        SELECT p.id, r.id
        FROM metadata.permissions p
        CROSS JOIN metadata.roles r
        WHERE p.table_name = NEW.table_name || ':notes'
          AND p.permission = 'read'
          AND r.display_name = 'user'
        ON CONFLICT (permission_id, role_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION metadata.on_entity_notes_enabled() IS
    'Trigger function to auto-create notes permissions when enable_notes is set to TRUE.
     Creates {entity}:notes read/create permissions and grants to editor (both) and user (read).';

CREATE TRIGGER entity_notes_enabled_trigger
    AFTER INSERT OR UPDATE OF enable_notes ON metadata.entities
    FOR EACH ROW
    EXECUTE FUNCTION metadata.on_entity_notes_enabled();

COMMENT ON TRIGGER entity_notes_enabled_trigger ON metadata.entities IS
    'Auto-creates notes permissions when enable_notes is enabled via any method (UI, RPC, SQL).';


-- ============================================================================
-- 8. UPDATE UPSERT_ENTITY_METADATA RPC TO SUPPORT ENABLE_NOTES
-- ============================================================================
-- Purpose: Allow Entity Management page to configure notes
-- Pattern: Similar to show_calendar parameter addition in v0.9.0
-- ============================================================================

-- Drop old function signature (10 parameters from v0.9.0)
DROP FUNCTION IF EXISTS public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT);

-- Create new function signature (11 parameters)
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
  p_enable_notes BOOLEAN DEFAULT FALSE
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
    enable_notes
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
    p_enable_notes
  )
  ON CONFLICT (table_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    search_fields = EXCLUDED.search_fields,
    show_map = EXCLUDED.show_map,
    map_property_name = EXCLUDED.map_property_name,
    show_calendar = EXCLUDED.show_calendar,
    calendar_property_name = EXCLUDED.calendar_property_name,
    calendar_color_property = EXCLUDED.calendar_color_property,
    enable_notes = EXCLUDED.enable_notes;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_entity_metadata IS
  'Insert or update entity metadata. Admin only. Updated in v0.16.0 to add enable_notes parameter.';

GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN) TO authenticated;


-- ============================================================================
-- 9. GENERIC STATUS CHANGE NOTE TRIGGER FUNCTION
-- ============================================================================
-- Reusable function for adding system notes when status changes.
-- Integrators attach this to their tables via CREATE TRIGGER.

CREATE OR REPLACE FUNCTION public.add_status_change_note()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_old_status TEXT;
    v_new_status TEXT;
BEGIN
    -- Get status display names
    SELECT display_name INTO v_old_status FROM metadata.statuses WHERE id = OLD.status_id;
    SELECT display_name INTO v_new_status FROM metadata.statuses WHERE id = NEW.status_id;

    -- Add system note
    PERFORM create_entity_note(
        p_entity_type := TG_TABLE_NAME::NAME,
        p_entity_id := NEW.id::TEXT,
        p_content := format('Status changed from **%s** to **%s**', v_old_status, v_new_status),
        p_note_type := 'system',
        p_author_id := current_user_id()
    );

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.add_status_change_note() IS
    'Trigger function to add system note when status changes. Attach to tables with:
     CREATE TRIGGER mytable_status_change_note
         AFTER UPDATE OF status_id ON mytable
         FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
         EXECUTE FUNCTION add_status_change_note();';

GRANT EXECUTE ON FUNCTION public.add_status_change_note() TO authenticated;


-- ============================================================================
-- 10. UPDATE schema_entities VIEW
-- ============================================================================
-- Add enable_notes column to the view.

CREATE OR REPLACE VIEW public.schema_entities AS
SELECT
    COALESCE(entities.display_name, tables.table_name::text) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    entities.description,
    entities.search_fields,
    COALESCE(entities.show_map, FALSE) AS show_map,
    entities.map_property_name,
    tables.table_name,
    public.has_permission(tables.table_name::text, 'create') AS insert,
    public.has_permission(tables.table_name::text, 'read') AS "select",
    public.has_permission(tables.table_name::text, 'update') AS update,
    public.has_permission(tables.table_name::text, 'delete') AS delete,
    COALESCE(entities.show_calendar, FALSE) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    -- Notes column added (v0.16.0)
    COALESCE(entities.enable_notes, FALSE) AS enable_notes
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
    AND tables.table_type::text = 'BASE TABLE'::text
ORDER BY COALESCE(entities.sort_order, 0), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Exposes entity metadata including notes configuration. Updated in v0.16.0 to add enable_notes column.';


-- ============================================================================
-- 11. PUBLIC VIEW FOR POSTGREST ACCESS
-- ============================================================================
-- Expose metadata.entity_notes through public schema for PostgREST.
-- RLS on metadata.entity_notes handles permissions.

CREATE OR REPLACE VIEW public.entity_notes AS
SELECT
    id,
    entity_type,
    entity_id,
    author_id,
    content,
    note_type,
    is_internal,
    created_at,
    updated_at,
    deleted_at
FROM metadata.entity_notes
WHERE deleted_at IS NULL;

COMMENT ON VIEW public.entity_notes IS
    'Read/write view of metadata.entity_notes for PostgREST access.
     Automatically filters soft-deleted notes. RLS on underlying table handles permissions.';

-- Grant full CRUD (RLS enforces actual permissions)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entity_notes TO authenticated;


-- ============================================================================
-- 12. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
