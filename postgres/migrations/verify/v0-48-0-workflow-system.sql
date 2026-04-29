-- Verify civic_os:v0-48-0-workflow-system

BEGIN;

-- Helper function exists
SELECT 1/COUNT(*) FROM pg_proc WHERE proname = 'is_guided_form_draft' AND pronamespace = 'public'::regnamespace;

-- Metadata tables exist
SELECT 1/COUNT(*) FROM information_schema.tables
WHERE table_schema = 'metadata' AND table_name IN ('guided_forms', 'guided_form_steps', 'guided_form_step_conditions', 'guided_form_progress');

-- RLS enabled on guided_form_progress
SELECT 1/COUNT(*) FROM pg_class
WHERE relname = 'guided_form_progress' AND relrowsecurity = true;

-- Public views exist
SELECT 1/COUNT(*) FROM information_schema.views
WHERE table_schema = 'public' AND table_name IN ('schema_guided_forms', 'schema_guided_form_steps', 'guided_form_progress');

-- RPCs exist
SELECT 1/COUNT(*) FROM pg_proc
WHERE proname IN (
    'register_guided_form', 'add_guided_form_step', 'add_guided_form_step_condition',
    'start_guided_form', 'complete_guided_form_step', 'submit_guided_form',
    'cancel_guided_form', 'get_guided_form_progress', 'rebuild_guided_form_triggers',
    'grant_guided_form_permissions', 'ensure_guided_form_step_record',
    '_all_steps_condition_skipped', 'get_guided_form_context'
)
AND pronamespace = 'public'::regnamespace;

-- Verify authenticated role can execute key functions
SELECT has_function_privilege('authenticated', 'public._all_steps_condition_skipped(NAME, BIGINT)', 'EXECUTE');
SELECT has_function_privilege('authenticated', 'public.get_guided_form_context(NAME, NAME, BIGINT)', 'EXECUTE');

-- metadata.entities has new columns
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'entities'
AND column_name IN ('show_in_sidebar', 'guided_form_key');

ROLLBACK;
