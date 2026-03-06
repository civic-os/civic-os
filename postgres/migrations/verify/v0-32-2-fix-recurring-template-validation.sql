-- Verify v0-32-2-fix-recurring-template-validation
-- Confirms validate_entity_template() accepts show_on_create fields.

DO $$
DECLARE
    v_result BOOLEAN;
BEGIN
    -- Verify the function body includes show_on_create in its allowlist query.
    -- This checks the pg_proc source directly rather than calling the function,
    -- since we may not have a suitable test entity available at verify time.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE proname = 'validate_entity_template'
          AND prosrc LIKE '%show_on_create%'
    ) THEN
        RAISE EXCEPTION 'validate_entity_template does not include show_on_create in allowlist';
    END IF;

    RAISE NOTICE 'validate_entity_template correctly includes show_on_create in allowlist';
END;
$$;
