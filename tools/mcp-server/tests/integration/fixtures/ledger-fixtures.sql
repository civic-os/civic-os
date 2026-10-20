-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Test-only metadata rows for the MCP integration tests (throwaway database).
-- Data only, no DDL: the pothole example defines no entity actions, so this
-- adds two status-gated actions on Issue to reproduce ledger A-01 end to end
-- (conditions on a Status column must compare the embedded status's id).
--
-- rpc_function names a function that does not exist on purpose: the tests only
-- check whether the MCP's condition gate lets the call through to the RPC.
-- Idempotent so ./run-tests.sh can re-run against a running stack.

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
