-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Test-only metadata rows for the MCP integration tests (throwaway database).
-- Data only, no DDL: the pothole example defines no entity actions, so this
-- adds conditional actions on Issue (and one malformed one on Tag) to reproduce
-- SDK divergence ledger rows A-01, C-02, C-03 and C-06 end to end.
--
-- rpc_function names a function that does not exist on purpose: the tests only
-- check whether the MCP's condition gate lets the call through to the RPC.
-- Idempotent so ./run-tests.sh can re-run against a running stack.

-- Ledger A-01: conditions on a Status column compare the embedded status's id.
INSERT INTO metadata.entity_actions
  (table_name, action_name, display_name, rpc_function,
   visibility_condition, enabled_condition, disabled_tooltip, sort_order)
SELECT
  'Issue', 'mcp_ledger_gate_open', 'Ledger Gate Open', 'mcp_ledger_test_rpc',
  jsonb_build_object('field', 'status', 'operator', 'ne', 'value', terminal.id),
  jsonb_build_object('field', 'status', 'operator', 'eq', 'value', initial.id),
  'Only new issues', 900
FROM
  (SELECT id FROM metadata.statuses WHERE entity_type = 'issue' AND is_initial LIMIT 1) AS initial,
  (SELECT id FROM metadata.statuses WHERE entity_type = 'issue' AND is_terminal ORDER BY sort_order LIMIT 1) AS terminal
ON CONFLICT (table_name, action_name) DO NOTHING;

INSERT INTO metadata.entity_actions
  (table_name, action_name, display_name, rpc_function,
   enabled_condition, disabled_tooltip, sort_order)
SELECT
  'Issue', 'mcp_ledger_gate_closed', 'Ledger Gate Closed', 'mcp_ledger_test_rpc',
  jsonb_build_object('field', 'status', 'operator', 'eq', 'value', terminal.id),
  'Only closed issues', 901
FROM
  (SELECT id FROM metadata.statuses WHERE entity_type = 'issue' AND is_terminal ORDER BY sort_order LIMIT 1) AS terminal
ON CONFLICT (table_name, action_name) DO NOTHING;

-- Ledger C-02: strict equality. The value is the initial status id as a *string*;
-- the record's status id is a number, so the action must be disabled.
INSERT INTO metadata.entity_actions
  (table_name, action_name, display_name, rpc_function,
   enabled_condition, disabled_tooltip, sort_order)
SELECT
  'Issue', 'mcp_ledger_strict_eq', 'Ledger Strict Eq', 'mcp_ledger_test_rpc',
  jsonb_build_object('field', 'status', 'operator', 'eq', 'value', initial.id::text),
  'String status id never matches', 902
FROM
  (SELECT id FROM metadata.statuses WHERE entity_type = 'issue' AND is_initial LIMIT 1) AS initial
ON CONFLICT (table_name, action_name) DO NOTHING;

-- Ledger C-03: ordering operators need numbers. "display_name gt 'A'" compares
-- strings, so the action must be disabled.
INSERT INTO metadata.entity_actions
  (table_name, action_name, display_name, rpc_function,
   enabled_condition, disabled_tooltip, sort_order)
VALUES
  ('Issue', 'mcp_ledger_numeric_gt', 'Ledger Numeric Gt', 'mcp_ledger_test_rpc',
   '{"field": "display_name", "operator": "gt", "value": "A"}'::jsonb,
   'String comparison never enables', 903)
ON CONFLICT (table_name, action_name) DO NOTHING;

-- Ledger C-06: a malformed condition ("or" is not an array) must not break
-- get_record; it fails closed and hides the action. On Tag, not Issue, so a
-- crash cannot mask the Issue tests.
INSERT INTO metadata.entity_actions
  (table_name, action_name, display_name, rpc_function,
   visibility_condition, sort_order)
VALUES
  ('Tag', 'mcp_ledger_malformed', 'Ledger Malformed', 'mcp_ledger_test_rpc',
   '{"or": "x"}'::jsonb, 904)
ON CONFLICT (table_name, action_name) DO NOTHING;
