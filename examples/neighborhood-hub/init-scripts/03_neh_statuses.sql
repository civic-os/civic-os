-- Neighborhood Engagement Hub - Statuses

-- Borrower approval workflow
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('borrowers', 'Borrower', 'Approval status for tool borrowing')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, status_key, is_initial, is_terminal)
VALUES
  ('borrowers', 'Pending',  '#f59e0b', 1, 'pending',  true,  false),
  ('borrowers', 'Approved', '#22c55e', 2, 'approved', false, false),
  ('borrowers', 'Rejected', '#ef4444', 3, 'rejected', false, true),
  ('borrowers', 'Barred',   '#dc2626', 4, 'barred',   false, true);

-- Tool instance condition tracking
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('tool_instances', 'Tool Instance', 'Condition status for individual tools')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, status_key, is_initial, is_terminal)
VALUES
  ('tool_instances', 'In Service',  '#22c55e', 1, 'in_service',  true,  false),
  ('tool_instances', 'Maintenance', '#f59e0b', 2, 'maintenance', false, false),
  ('tool_instances', 'Retired',     '#6b7280', 3, 'retired',     false, true);

-- Tool reservation workflow
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('tool_reservations', 'Tool Reservation', 'Workflow status for tool reservations')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, status_key, is_initial, is_terminal)
VALUES
  ('tool_reservations', 'Pending',     '#f59e0b', 1, 'pending',     true,  false),
  ('tool_reservations', 'Approved',    '#3b82f6', 2, 'approved',    false, false),
  ('tool_reservations', 'Checked Out', '#22c55e', 3, 'checked_out', false, false),
  ('tool_reservations', 'Returned',    '#8b5cf6', 4, 'returned',    false, false),
  ('tool_reservations', 'Completed',   '#6b7280', 5, 'completed',   false, true),
  ('tool_reservations', 'Denied',      '#ef4444', 6, 'denied',      false, true),
  ('tool_reservations', 'Cancelled',   '#94a3b8', 7, 'cancelled',   false, true);

-- Tool reservation checkout tracking
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('tool_reservation_checkouts', 'Checkout', 'Tracking status for tool checkouts')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, status_key, is_initial, is_terminal)
VALUES
  ('tool_reservation_checkouts', 'Checked Out',      '#f59e0b', 1, 'checked_out',      true,  false),
  ('tool_reservation_checkouts', 'Returned',         '#22c55e', 2, 'returned',         false, true),
  ('tool_reservation_checkouts', 'Returned Damaged', '#ef4444', 3, 'returned_damaged', false, true);

-- Building use request workflow
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('building_use_requests', 'Building Use Request', 'Workflow status for building use requests')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, status_key, is_initial, is_terminal)
VALUES
  ('building_use_requests', 'Pending',   '#f59e0b', 1, 'pending',   true,  false),
  ('building_use_requests', 'Approved',  '#22c55e', 2, 'approved',  false, false),
  ('building_use_requests', 'Denied',    '#ef4444', 3, 'denied',    false, true),
  ('building_use_requests', 'Cancelled', '#94a3b8', 4, 'cancelled', false, true),
  ('building_use_requests', 'Completed', '#6b7280', 5, 'completed', false, true);


