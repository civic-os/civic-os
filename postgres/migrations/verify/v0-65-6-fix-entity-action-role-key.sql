-- Verify civic_os:v0-65-6-fix-entity-action-role-key on pg

DO $$
BEGIN
  -- Confirm function exists in metadata schema
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'metadata'
    AND p.proname = 'has_entity_action_permission'
  ) THEN
    RAISE EXCEPTION 'Function metadata.has_entity_action_permission does not exist';
  END IF;

  -- Confirm source uses role_key (not display_name)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'metadata'
    AND p.proname = 'has_entity_action_permission'
    AND p.prosrc LIKE '%role_key%'
  ) THEN
    RAISE EXCEPTION 'Function metadata.has_entity_action_permission does not contain role_key';
  END IF;
END $$;
