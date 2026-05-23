-- Verify civic_os:v0-55-2-submit-form-status-fix

BEGIN;

-- ============================================================================
-- Part A: Verify hybrid search (pg_trgm + metadata columns)
-- ============================================================================

-- pg_trgm extension exists
SELECT 1/COUNT(*)::int FROM pg_extension WHERE extname = 'pg_trgm';

-- name_search_tokens does NOT exist (replaced by pg_trgm)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'name_search_tokens') THEN
    RAISE EXCEPTION 'name_search_tokens should not exist — replaced by pg_trgm';
  END IF;
END;
$$;

-- trgm index on civic_os_users_private.display_name exists
SELECT 1/COUNT(*)::int FROM pg_indexes
WHERE indexname = 'idx_cup_display_name_trgm';

-- civic_os_users VIEW exists and includes tsvector
SELECT civic_os_text_search FROM public.civic_os_users WHERE FALSE;

-- New metadata columns exist on metadata.entities
DO $$
BEGIN
  PERFORM 1 FROM information_schema.columns
  WHERE table_schema = 'metadata' AND table_name = 'entities'
    AND column_name = 'fulltext_search_column';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulltext_search_column column missing from metadata.entities';
  END IF;

  PERFORM 1 FROM information_schema.columns
  WHERE table_schema = 'metadata' AND table_name = 'entities'
    AND column_name = 'substring_search_column';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'substring_search_column column missing from metadata.entities';
  END IF;
END;
$$;

-- schema_entities VIEW exposes new columns
SELECT fulltext_search_column, substring_search_column
FROM public.schema_entities WHERE FALSE;

-- upsert_entity_metadata accepts new params (17-param signature)
SELECT 1/COUNT(*)::int FROM pg_proc
WHERE proname = 'upsert_entity_metadata' AND pronargs = 17;


-- ============================================================================
-- Part B: Verify column-agnostic guided form status
-- ============================================================================

-- Helper function exists
SELECT 1/COUNT(*)::int FROM pg_proc WHERE proname = '_gf_status_col';

-- Core functions are column-agnostic (reference _gf_status_col or use dynamic detection)
DO $$
DECLARE
    v_src TEXT;
    v_fn TEXT;
BEGIN
    -- Functions that should use _gf_status_col for dynamic column detection
    FOREACH v_fn IN ARRAY ARRAY['complete_guided_form_step', 'submit_guided_form', 'get_guided_form_context']
    LOOP
        SELECT prosrc INTO v_src FROM pg_proc WHERE proname = v_fn;
        ASSERT v_src IS NOT NULL, format('Function %s not found', v_fn);
        ASSERT v_src LIKE '%_gf_status_col%',
            format('Function %s should use _gf_status_col for column-agnostic access', v_fn);
    END LOOP;

    -- enforce_guided_form_lock uses _gf_status_col + to_jsonb for column-agnostic access
    SELECT prosrc INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'enforce_guided_form_lock' AND n.nspname = 'metadata';
    ASSERT v_src IS NOT NULL, 'enforce_guided_form_lock not found';
    ASSERT v_src LIKE '%_gf_status_col%',
        'enforce_guided_form_lock should use _gf_status_col';

    -- rebuild_guided_form_constraints uses _gf_status_col
    SELECT prosrc INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'rebuild_guided_form_constraints' AND n.nspname = 'metadata';
    ASSERT v_src IS NOT NULL, 'rebuild_guided_form_constraints not found';
    ASSERT v_src LIKE '%_gf_status_col%',
        'rebuild_guided_form_constraints should use _gf_status_col';

    -- register_guided_form uses _gf_status_col (does NOT hardcode rename)
    SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'register_guided_form';
    ASSERT v_src IS NOT NULL, 'register_guided_form not found';
    ASSERT v_src LIKE '%_gf_status_col%',
        'register_guided_form should use _gf_status_col';
    ASSERT v_src NOT LIKE '%RENAME COLUMN%',
        'register_guided_form should NOT rename columns (column-agnostic approach)';
END;
$$;

-- submit_guided_form ALWAYS sets GF status (no conditional on_submit_rpc branch)
DO $$
DECLARE
    v_src TEXT;
BEGIN
    SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'submit_guided_form';
    -- The fixed version always sets GF status via _gf_status_col, no conditional branch
    ASSERT v_src LIKE '%SET submitted_at = NOW()%',
        'submit_guided_form should always set submitted_at';
    -- The fixed version uses _gf_status_col (already checked above).
    -- Verify it does NOT have the old ELSE-branch pattern where submitted_at was set conditionally.
    ASSERT v_src NOT LIKE '%ELSE%SET submitted_at%END IF%',
        'submit_guided_form should not conditionally set submitted_at in ELSE branch';
END;
$$;

ROLLBACK;
