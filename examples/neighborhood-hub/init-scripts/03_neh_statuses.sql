-- Neighborhood Engagement Hub - Statuses

-- Borrower approval workflow
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('borrowers', 'Borrower', 'Approval status for tool borrowing')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, status_key, is_initial, is_terminal)
VALUES
  ('borrowers', 'Pending',  '#f59e0b', 1, 'pending',  true,  false),
  ('borrowers', 'Approved', '#22c55e', 2, 'approved', false, false),
  ('borrowers', 'Rejected', '#ef4444', 3, 'rejected', false, true);

-- Tool instance condition tracking
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('tool_instances', 'Tool Instance', 'Condition status for individual tools')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, status_key, is_initial, is_terminal)
VALUES
  ('tool_instances', 'In Service',  '#22c55e', 1, 'in_service',  true,  false),
  ('tool_instances', 'Maintenance', '#f59e0b', 2, 'maintenance', false, false),
  ('tool_instances', 'Retired',     '#6b7280', 3, 'retired',     false, true);
