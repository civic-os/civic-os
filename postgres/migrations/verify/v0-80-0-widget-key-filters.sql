-- Verify civic_os:v0-80-0-widget-key-filters

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_cache_versions WHERE cache_name = 'statuses') THEN
    RAISE EXCEPTION 'schema_cache_versions has no statuses row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_cache_versions WHERE cache_name = 'instance_config') THEN
    RAISE EXCEPTION 'schema_cache_versions lost its instance_config row';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL unnest(p.proargnames) AS arg(name)
    WHERE p.oid = 'public.get_categories_for_entity(text)'::regprocedure
      AND arg.name = 'category_key'
  ) THEN
    RAISE EXCEPTION 'get_categories_for_entity does not return category_key';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) AS acl
    WHERE p.oid = 'public.get_categories_for_entity(text)'::regprocedure
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'get_categories_for_entity is executable by PUBLIC';
  END IF;
END $$;
