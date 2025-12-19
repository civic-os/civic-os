-- Deploy v0-20-4-fix-upsert-null-handling
-- Fix upsert_property_metadata to allow setting fields to NULL
--
-- Bug: v0.19.0 changed ON CONFLICT DO UPDATE to use COALESCE pattern:
--   description = COALESCE(EXCLUDED.description, metadata.properties.description)
--
-- This was intended for "partial updates" (NULL = keep existing), but it
-- makes it impossible to explicitly set a field to NULL. The fix restores
-- direct assignment for nullable fields.

BEGIN;

-- Recreate function with correct NULL handling
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
    -- Direct assignment allows explicit NULL values
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    column_width = EXCLUDED.column_width,
    sortable = EXCLUDED.sortable,
    filterable = EXCLUDED.filterable,
    show_on_list = EXCLUDED.show_on_list,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit,
    show_on_detail = EXCLUDED.show_on_detail,
    is_recurring = EXCLUDED.is_recurring;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) IS
    'Upsert property metadata. v0.20.4: Fixed to allow explicit NULL values.';

COMMIT;
