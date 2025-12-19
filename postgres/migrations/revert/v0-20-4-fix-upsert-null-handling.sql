-- Revert v0-20-4-fix-upsert-null-handling
-- Restore v0.19.0 version with COALESCE pattern (has the NULL bug)

BEGIN;

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

COMMIT;
