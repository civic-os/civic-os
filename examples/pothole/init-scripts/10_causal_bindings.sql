-- ============================================================================
-- Pothole Tracker: Causal Bindings (v0.33.0)
-- ============================================================================
-- The pothole example now uses the framework Status Type System (v0.15.0+).
-- Status transitions could be declared via metadata.status_transitions, but
-- this example has no workflow enforcement — any user with update permission
-- can set Issue.status to any valid status. The only automation is a
-- notification trigger on status change.
--
-- Note: Uses direct INSERT (not add_property_change_trigger helper RPC) because
-- init scripts run as postgres superuser without JWT claims.
-- ============================================================================


-- ============================================================================
-- 1. PROPERTY CHANGE TRIGGERS: Issue.status
-- ============================================================================

INSERT INTO metadata.property_change_triggers (table_name, property_name, change_type, change_value, function_name, display_name, description) VALUES
    ('Issue', 'status', 'any', NULL,
     'notify_issue_status_changed', 'Notify reporter on status change',
     'AFTER trigger: sends issue_status_changed email to created_user when Issue.status changes (and created_user is not NULL).');
