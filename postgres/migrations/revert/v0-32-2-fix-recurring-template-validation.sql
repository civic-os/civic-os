-- Revert v0-32-2-fix-recurring-template-validation
-- Restores validate_entity_template() to use show_on_edit only (pre-fix behavior).

BEGIN;

CREATE OR REPLACE FUNCTION metadata.validate_entity_template(
    p_entity_table NAME,
    p_template JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_allowed_fields TEXT[];
    v_template_field TEXT;
    v_blocked_fields TEXT[] := ARRAY['id', 'created_at', 'created_by', 'updated_at', 'updated_by'];
BEGIN
    -- Validate entity_table exists
    IF NOT EXISTS (
        SELECT 1 FROM metadata.entities
        WHERE table_name = p_entity_table
    ) THEN
        RAISE EXCEPTION 'Invalid entity table: %', p_entity_table;
    END IF;

    -- Get fields that are editable (show_on_edit=true)
    -- Use show_on_edit since templates are managed by admins who can set fields
    -- that regular users cannot set on initial create (e.g., status)
    SELECT array_agg(column_name) INTO v_allowed_fields
    FROM metadata.properties
    WHERE table_name = p_entity_table
      AND show_on_edit = TRUE
      AND column_name != ALL(v_blocked_fields);

    IF v_allowed_fields IS NULL THEN
        v_allowed_fields := ARRAY[]::TEXT[];
    END IF;

    -- Check each template field is allowed
    FOR v_template_field IN SELECT jsonb_object_keys(p_template)
    LOOP
        -- Skip time_slot field (handled separately by expansion)
        IF v_template_field = 'time_slot' THEN
            CONTINUE;
        END IF;

        IF NOT v_template_field = ANY(v_allowed_fields) THEN
            RAISE EXCEPTION 'Template field "%" is not allowed for entity %. Allowed fields: %',
                v_template_field, p_entity_table, v_allowed_fields;
        END IF;
    END LOOP;

    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION metadata.validate_entity_template(NAME, JSONB) IS
    'Validates entity template JSONB against schema allowlist.
     Blocks audit fields and fields with show_on_edit=false.
     Uses show_on_edit since templates are managed by admins.
     Added in v0.19.0.';

COMMIT;
