-- =====================================================
-- Pot Hole Observation System - Editor Dashboard
-- =====================================================
-- Adds severity tracking and creates an Editor Workqueue dashboard
-- with filtered list widgets for issue triage and management.

-- =====================================================
-- PART 1: Add severity_level column to Issue table
-- =====================================================
-- Severity scale: 1 (Minor) to 5 (Critical)
-- This enables priority-based triage and filtering

ALTER TABLE public."Issue"
ADD COLUMN IF NOT EXISTS severity_level INT NOT NULL DEFAULT 3;

-- Add check constraint for valid severity range (1-5)
-- Use DO block to make constraint creation idempotent
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'issue_severity_level_range'
    AND conrelid = 'public."Issue"'::regclass
  ) THEN
    ALTER TABLE public."Issue"
    ADD CONSTRAINT issue_severity_level_range
    CHECK (severity_level >= 1 AND severity_level <= 5);
  END IF;
END $$;

-- Add frontend validation metadata for severity_level
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message)
VALUES
  ('Issue', 'severity_level', 'min', '1', 'Severity must be at least 1 (Minor)'),
  ('Issue', 'severity_level', 'max', '5', 'Severity cannot exceed 5 (Critical)')
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE
SET validation_value = EXCLUDED.validation_value,
    error_message = EXCLUDED.error_message;

-- Configure property metadata for severity_level
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('Issue', 'severity_level', 'Severity', 'Issue severity: 1 (Minor) to 5 (Critical)', 25, 1, TRUE, TRUE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    column_width = EXCLUDED.column_width,
    show_on_list = EXCLUDED.show_on_list;

-- =====================================================
-- PART 2: Create Editor Workqueue Dashboard
-- =====================================================

DO $$
DECLARE
  v_dashboard_id INT;
BEGIN
  -- Idempotent: Delete existing dashboard if re-running
  DELETE FROM metadata.dashboards WHERE display_name = 'Editor Workqueue';

  -- Create the Editor Workqueue dashboard
  INSERT INTO metadata.dashboards (display_name, description, is_default, is_public, sort_order)
  VALUES (
    'Editor Workqueue',
    'Issue triage and management dashboard for editors',
    FALSE,
    TRUE,
    10
  )
  RETURNING id INTO v_dashboard_id;

  -- Widget 1: New Issues (Triage Queue)
  -- Shows newly reported issues that need initial triage
  -- Sorted by newest first so editors see recent submissions
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'filtered_list',
    'Issue',
    'New Issues (Triage Queue)',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'status', 'operator', 'eq', 'value', 1)
      ),
      'orderBy', 'created_at',
      'orderDirection', 'desc',
      'limit', 10,
      'showColumns', jsonb_build_array('display_name', 'severity_level', 'created_at', 'created_user')
    ),
    1,  -- sort_order
    1,  -- width (half)
    1   -- height
  );

  -- Widget 2: High Severity Issues
  -- Shows critical/severe issues (severity 4-5) that need priority attention
  -- Sorted by severity descending, then by date
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'filtered_list',
    'Issue',
    'High Severity Issues',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'severity_level', 'operator', 'gte', 'value', 4)
      ),
      'orderBy', 'severity_level',
      'orderDirection', 'desc',
      'limit', 10,
      'showColumns', jsonb_build_array('display_name', 'severity_level', 'status', 'created_at')
    ),
    2,  -- sort_order
    1,  -- width (half)
    1   -- height
  );

  -- Widget 3: Awaiting Verification
  -- Shows issues in verification queue, sorted FIFO (oldest first)
  -- Editors work through these in order received
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'filtered_list',
    'Issue',
    'Awaiting Verification',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'status', 'operator', 'eq', 'value', 2)
      ),
      'orderBy', 'created_at',
      'orderDirection', 'asc',
      'limit', 15,
      'showColumns', jsonb_build_array('display_name', 'severity_level', 'created_user', 'created_at')
    ),
    3,  -- sort_order
    2,  -- width (full)
    1   -- height
  );

END $$;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
