-- Deploy civic_os:v0-17-0-add-static-text to pg
-- requires: v0-16-0-add-entity-notes

BEGIN;

-- ============================================================================
-- STATIC TEXT SYSTEM
-- ============================================================================
-- Version: v0.17.0
-- Purpose: Static markdown text blocks that can appear on Detail/Edit/Create
--          pages alongside regular database properties. Configured via SQL and
--          integrated with the property rendering system via sort_order.
--
-- Tables:
--   metadata.static_text - Static text blocks per entity
--
-- Configuration:
--   1. INSERT into metadata.static_text with table_name, content, sort_order
--   2. Set show_on_* flags to control visibility on different page types
--   3. Done! Static text appears alongside properties on pages
--
-- Features:
--   - Full markdown support (headers, lists, bold, italic, links)
--   - Respects sort_order for positioning among properties
--   - Configurable visibility per page type (detail, create, edit)
--   - Column width control (1-8 columns, default 8 for full width)
-- ============================================================================


-- ============================================================================
-- 1. STATIC_TEXT TABLE
-- ============================================================================

CREATE TABLE metadata.static_text (
    id SERIAL PRIMARY KEY,

    -- Target entity
    table_name NAME NOT NULL,           -- Entity to display on: 'issues', 'reservations', etc.

    -- Content
    content TEXT NOT NULL,              -- Markdown content (full markdown support)

    -- Positioning
    sort_order INT NOT NULL DEFAULT 100, -- Position relative to properties (lower = earlier)
    column_width SMALLINT NOT NULL DEFAULT 8, -- 1-8 columns (default 8 = full width)

    -- Visibility per page type
    show_on_detail BOOLEAN NOT NULL DEFAULT TRUE,
    show_on_create BOOLEAN NOT NULL DEFAULT FALSE,
    show_on_edit BOOLEAN NOT NULL DEFAULT FALSE,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT content_not_empty CHECK (trim(content) != ''),
    CONSTRAINT content_max_length CHECK (length(content) <= 10000),
    CONSTRAINT valid_column_width CHECK (column_width >= 1 AND column_width <= 8)
);

COMMENT ON TABLE metadata.static_text IS
    'Static markdown text blocks displayed on Detail/Edit/Create pages.
     Text is positioned among properties via sort_order. Added in v0.17.0.';

COMMENT ON COLUMN metadata.static_text.table_name IS
    'Target entity table name (e.g., ''issues'', ''reservation_requests'')';

COMMENT ON COLUMN metadata.static_text.content IS
    'Markdown content. Supports full markdown: headers, lists, bold, italic, links, code.';

COMMENT ON COLUMN metadata.static_text.sort_order IS
    'Display position relative to properties. Lower values appear earlier.
     Default 100 typically places content after most properties.
     Use low values (5-10) for headers, high values (999) for footers.';

COMMENT ON COLUMN metadata.static_text.column_width IS
    'Width in grid columns: 1 = half width, 2 = full width (default)';

COMMENT ON COLUMN metadata.static_text.show_on_detail IS
    'Show on Detail pages (default TRUE)';

COMMENT ON COLUMN metadata.static_text.show_on_create IS
    'Show on Create pages (default FALSE)';

COMMENT ON COLUMN metadata.static_text.show_on_edit IS
    'Show on Edit pages (default FALSE)';

-- Timestamps trigger
CREATE TRIGGER set_static_text_updated_at
    BEFORE UPDATE ON metadata.static_text
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 2. INDEXES
-- ============================================================================

-- Primary lookup: static text for an entity
CREATE INDEX idx_static_text_table ON metadata.static_text(table_name);

-- Sorted listing (for merge with properties)
CREATE INDEX idx_static_text_sort ON metadata.static_text(table_name, sort_order);


-- ============================================================================
-- 3. ROW LEVEL SECURITY POLICIES
-- ============================================================================
-- Static text is display content - everyone can read, only admins can modify.

ALTER TABLE metadata.static_text ENABLE ROW LEVEL SECURITY;

-- Everyone can read static text (it's display content)
CREATE POLICY static_text_select ON metadata.static_text
    FOR SELECT TO PUBLIC USING (true);

-- Only admins can insert
CREATE POLICY static_text_insert ON metadata.static_text
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin());

-- Only admins can update
CREATE POLICY static_text_update ON metadata.static_text
    FOR UPDATE TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- Only admins can delete
CREATE POLICY static_text_delete ON metadata.static_text
    FOR DELETE TO authenticated
    USING (public.is_admin());


-- ============================================================================
-- 4. GRANTS
-- ============================================================================

-- Everyone can read (RLS allows SELECT for PUBLIC)
GRANT SELECT ON metadata.static_text TO web_anon, authenticated;

-- Admins can modify (RLS restricts to admins only)
GRANT INSERT, UPDATE, DELETE ON metadata.static_text TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.static_text_id_seq TO authenticated;


-- ============================================================================
-- 5. PUBLIC VIEW FOR POSTGREST ACCESS
-- ============================================================================
-- Expose metadata.static_text through public schema for PostgREST.
-- RLS on metadata.static_text handles permissions.

CREATE OR REPLACE VIEW public.static_text AS
SELECT
    id,
    table_name,
    content,
    sort_order,
    column_width,
    show_on_detail,
    show_on_create,
    show_on_edit,
    created_at,
    updated_at
FROM metadata.static_text;

COMMENT ON VIEW public.static_text IS
    'Read/write view of metadata.static_text for PostgREST access.
     RLS on underlying table handles permissions (everyone reads, admins modify).';

-- Grant full CRUD on view (RLS enforces actual permissions)
GRANT SELECT ON public.static_text TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.static_text TO authenticated;


-- ============================================================================
-- 6. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
