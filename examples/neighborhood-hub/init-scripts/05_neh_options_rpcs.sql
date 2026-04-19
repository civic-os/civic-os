-- Neighborhood Engagement Hub - Options Source RPC Functions & Registration
-- These RPCs demonstrate three options_source_rpc scenarios:
--   1. Filtered FK: only approved borrowers appear in dropdown
--   2. Cascading FK: category → tool type (tool_type_id depends on category_id)
--   3. Filtered M:M: only eligible parcels appear in project_parcels editor

-- ============================================================================
-- SCENARIO 1: Filtered FK — only approved borrowers
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_eligible_borrowers(p_id TEXT, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT b.id, b.display_name::TEXT
    FROM borrowers b
    JOIN metadata.statuses s ON b.status_id = s.id
    WHERE s.status_key = 'approved'
    ORDER BY b.display_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_eligible_borrowers TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_eligible_borrowers TO web_anon;

-- Register: tool_reservations.borrower_id uses filtered borrower list with search modal (v0.45.0)
INSERT INTO metadata.properties (table_name, column_name, display_name, options_source_rpc, join_table, fk_search_modal)
VALUES ('tool_reservations', 'borrower_id', 'Borrower', 'get_eligible_borrowers', 'borrowers', true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      options_source_rpc = EXCLUDED.options_source_rpc,
      join_table = EXCLUDED.join_table,
      fk_search_modal = EXCLUDED.fk_search_modal;


-- ============================================================================
-- SCENARIO 2: Cascading FK — category → tool type
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_tool_types_by_category(p_id TEXT, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT tt.id, tt.display_name::TEXT
    FROM tool_types tt
    WHERE (p_depends_on->>'category_id') IS NULL
       OR tt.category_id = (p_depends_on->>'category_id')::INT
    ORDER BY tt.display_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_tool_types_by_category TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_tool_types_by_category TO web_anon;

-- Register: tool_reservations.tool_type_id uses cascading dropdown
INSERT INTO metadata.properties (table_name, column_name, display_name, options_source_rpc, depends_on_columns)
VALUES ('tool_reservations', 'tool_type_id', 'Tool Type', 'get_tool_types_by_category', '{category_id}')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      options_source_rpc = EXCLUDED.options_source_rpc,
      depends_on_columns = EXCLUDED.depends_on_columns;


-- ============================================================================
-- SCENARIO 3: Filtered M:M — eligible parcels only (with color)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_eligible_parcels(p_id TEXT, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT, color TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT p.id, p.display_name::TEXT,
           CASE p.eligibility
             WHEN 'good' THEN '#22c55e'
             WHEN 'few_issues' THEN '#f59e0b'
             ELSE '#ef4444'
           END
    FROM parcels p
    WHERE p.eligibility IN ('good', 'few_issues')
    ORDER BY p.display_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_eligible_parcels TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_eligible_parcels TO web_anon;

-- Register: project_parcels M:M uses filtered parcel list
-- M:M column name convention: {junction_table}_m2m
INSERT INTO metadata.properties (table_name, column_name, options_source_rpc)
VALUES ('projects', 'project_parcels_m2m', 'get_eligible_parcels')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET options_source_rpc = EXCLUDED.options_source_rpc;
