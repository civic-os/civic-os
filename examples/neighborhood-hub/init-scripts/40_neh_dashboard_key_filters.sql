-- Neighborhood Engagement Hub - Dashboard filtered_list widgets filter by status key
--
-- Scripts 10, 16 and 27 wrote widget filters as status.status_key. "status" names no column, so the
-- framework's key filters reject it. Since v0.80.0 a widget filters on <column>.status_key, and the
-- frontend resolves the key to an id through the cached statuses.
--
-- This script rewrites the filtered_list widgets:
--   filters:     status.status_key eq <key>  ->  <status column>.status_key eq <key>
--   showColumns: borrower.display_name       ->  borrower_id
--                status.display_name         ->  <status column>
--                tools_summary               ->  removed (computed field, not a
--                                                property, so it renders blank)
--
-- Widgets are matched by content, not id. Safe to re-run: only the old forms change.

BEGIN;

DO $$
DECLARE
    v_widget       RECORD;
    v_status_col   TEXT;
    v_filter       JSONB;
    v_column       JSONB;
    v_new_filters  JSONB;
    v_new_columns  JSONB;
    v_config       JSONB;
    v_changed      INT := 0;
BEGIN
    FOR v_widget IN
        SELECT id, entity_key, config
        FROM metadata.dashboard_widgets
        WHERE widget_type = 'filtered_list'
          AND entity_key IN ('tool_reservations', 'building_use_requests', 'mek_requests', 'borrowers')
        ORDER BY id
    LOOP
        v_status_col := CASE v_widget.entity_key
            WHEN 'tool_reservations' THEN 'workflow_status_id'
            ELSE 'status_id'
        END;
        v_config := v_widget.config;

        IF jsonb_typeof(v_config->'filters') = 'array' THEN
            v_new_filters := '[]'::jsonb;
            FOR v_filter IN SELECT value FROM jsonb_array_elements(v_config->'filters') LOOP
                IF v_filter->>'column' = 'status.status_key' THEN
                    v_filter := jsonb_set(v_filter, '{column}', to_jsonb(v_status_col || '.status_key'));
                END IF;
                v_new_filters := v_new_filters || jsonb_build_array(v_filter);
            END LOOP;
            v_config := jsonb_set(v_config, '{filters}', v_new_filters);
        END IF;

        IF jsonb_typeof(v_config->'showColumns') = 'array' THEN
            v_new_columns := '[]'::jsonb;
            FOR v_column IN SELECT value FROM jsonb_array_elements(v_config->'showColumns') LOOP
                CONTINUE WHEN v_column #>> '{}' = 'tools_summary';
                v_new_columns := v_new_columns || jsonb_build_array(
                    CASE v_column #>> '{}'
                        WHEN 'borrower.display_name' THEN to_jsonb('borrower_id'::text)
                        WHEN 'status.display_name'   THEN to_jsonb(v_status_col)
                        ELSE v_column
                    END
                );
            END LOOP;
            v_config := jsonb_set(v_config, '{showColumns}', v_new_columns);
        END IF;

        IF v_config IS DISTINCT FROM v_widget.config THEN
            UPDATE metadata.dashboard_widgets SET config = v_config WHERE id = v_widget.id;
            v_changed := v_changed + 1;
        END IF;
    END LOOP;

    RAISE NOTICE 'Rewrote % filtered_list widgets', v_changed;

    -- Record the decision only where this script applied it. An instance on id filters keeps them.
    IF v_changed > 0 THEN
        INSERT INTO metadata.schema_decisions (
            entity_types, migration_id,
            title, status, decision, rationale, consequences, decided_date
        )
        SELECT
            ARRAY['tool_reservations', 'building_use_requests', 'mek_requests', 'borrowers']::NAME[],
            'neh-40-dashboard-key-filters',
            'Dashboard widgets filter on status columns by key',
            'accepted',
            'filtered_list widgets filter on <status column>.status_key and list only real columns.',
            'status.status_key names no column, so the staff and admin queues did not load. Key filters keep '
            'instance-specific ids out of the widget config.',
            'Requires a framework version with key filters (v0.80.0). tools_summary is no longer listed; it '
            'was computed and never rendered.',
            CURRENT_DATE
        WHERE NOT EXISTS (
            SELECT 1 FROM metadata.schema_decisions WHERE migration_id = 'neh-40-dashboard-key-filters'
        );
    END IF;
END $$;

COMMIT;
