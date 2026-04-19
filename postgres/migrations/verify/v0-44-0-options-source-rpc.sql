-- Verify civic_os:v0-44-0-options-source-rpc on pg

BEGIN;

-- Verify options_source_rpc column exists on metadata.properties
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'properties'
  AND column_name = 'options_source_rpc';

-- Verify depends_on_columns column exists on metadata.properties
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'properties'
  AND column_name = 'depends_on_columns';

-- Verify VIEW includes options_source_rpc column
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'schema_properties'
  AND column_name = 'options_source_rpc';

-- Verify VIEW includes depends_on_columns column
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'schema_properties'
  AND column_name = 'depends_on_columns';

-- Verify M:M helper RPC exists
SELECT 1/COUNT(*) FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'get_m2m_options_source_rpcs';

ROLLBACK;
