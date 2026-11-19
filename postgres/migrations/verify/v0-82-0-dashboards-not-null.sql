-- Verify civic_os:v0-82-0-dashboards-not-null

DO $$
DECLARE
  v_nullable TEXT;
BEGIN
  SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'metadata' AND table_name = 'dashboards'
    AND column_name IN ('is_default', 'is_public', 'sort_order', 'created_at', 'updated_at', 'show_title', 'show_in_selector')
    AND is_nullable = 'YES';
  IF v_nullable IS NOT NULL THEN
    RAISE EXCEPTION 'metadata.dashboards columns still nullable: %', v_nullable;
  END IF;
END $$;
