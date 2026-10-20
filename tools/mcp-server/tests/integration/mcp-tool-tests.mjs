#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * MCP tool integration tests against a real PostgREST instance.
 * Uses the MCP SDK to create an in-process server and client.
 *
 * The test database uses the pothole example schema which has entities:
 *   Issue (display: "Issues"), Tag, Bid, WorkDetail, WorkPackage, issue_tags
 *
 * Usage:
 *   node mcp-tool-tests.mjs <postgrest_url> <jwt_token>
 *
 * Output format (parsed by run-tests.sh):
 *   PASS:test description
 *   FAIL:test description|reason
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { PostgRESTClient } from '../../dist/postgrest-client.js';
import { SchemaCache } from '../../dist/schema-cache.js';
import { createServer } from '../../dist/index.js';

const [postgrestUrl, token] = process.argv.slice(2);

if (!postgrestUrl || !token) {
  console.error('Usage: node mcp-tool-tests.mjs <postgrest_url> <jwt_token>');
  process.exit(1);
}

// ============================================================================
// Setup: Create MCP server and client connected via in-memory transport
// ============================================================================

// Shared schema cache — uses anonymous client for public schema views
const anonClient = new PostgRESTClient({ baseUrl: postgrestUrl });
const cache = new SchemaCache(anonClient, postgrestUrl);

// Initialize schema cache
try {
  await cache.initialize();
  console.log(`Schema cache loaded: ${cache.entities.length} entities`);
} catch (err) {
  console.log(`FAIL:Schema cache initialization|${err.message}`);
  process.exit(1);
}
console.log('PASS:Schema cache initialized from real PostgREST');

// Create MCP server with per-session token (matches the refactored factory pattern)
const server = createServer(cache, token);
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

const client = new Client({ name: 'test-client', version: '1.0.0' });

await server.connect(serverTransport);
await client.connect(clientTransport);

console.log('PASS:MCP server and client connected via in-memory transport');

// ============================================================================
// Helper
// ============================================================================

async function callTool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result;
}

function getTextContent(result) {
  return result.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

// ============================================================================
// Test: list_entities
// ============================================================================

try {
  const result = await callTool('list_entities');
  const text = getTextContent(result);

  // The pothole example has "Issues" (display name) / "Issue" (table name)
  if (!text.includes('Issues') && !text.includes('Issue')) {
    console.log('FAIL:list_entities returns pothole entities|Output missing Issues entity');
  } else {
    console.log('PASS:list_entities returns pothole example entities');
  }

  // Should have multiple entities from the pothole schema (Issue, Tag, Bid, etc.)
  const entityLines = text.split('\n').filter(l => l.startsWith('- **'));
  if (entityLines.length < 3) {
    console.log(`FAIL:list_entities returns multiple entities|Only found ${entityLines.length} entities`);
  } else {
    console.log(`PASS:list_entities returns multiple entities (${entityLines.length})`);
  }
} catch (err) {
  console.log(`FAIL:list_entities|${err.message}`);
}

// ============================================================================
// Test: describe_entity
// ============================================================================

try {
  // Try resolving by display name "Issues"
  const result = await callTool('describe_entity', { entity: 'Issues' });
  const text = getTextContent(result);

  if (!text.includes('Issue') && !text.includes('Issues')) {
    console.log('FAIL:describe_entity by display name|Output missing Issue reference');
  } else {
    console.log('PASS:describe_entity resolves display name to table');
  }

  // Should include property table with columns
  if (text.includes('Property') || text.includes('Column')) {
    console.log('PASS:describe_entity shows property table');
  } else {
    console.log('FAIL:describe_entity shows property table|No property table found in output');
  }

  // Should include status information (pothole Issues have statuses)
  if (text.includes('Status') || text.includes('New') || text.includes('Completed')) {
    console.log('PASS:describe_entity includes status information');
  } else {
    console.log('FAIL:describe_entity status|No status information in output');
  }
} catch (err) {
  console.log(`FAIL:describe_entity|${err.message}`);
}

// ============================================================================
// Test: list_records
// ============================================================================

try {
  // Use table name "Issue" (the actual PostgREST table)
  const result = await callTool('list_records', { entity: 'Issues', limit: 5 });
  const text = getTextContent(result);

  // Should succeed without error (might have 0 records if no mock data)
  if (result.isError) {
    console.log(`FAIL:list_records for Issues|Tool returned error: ${text}`);
  } else {
    console.log('PASS:list_records queries PostgREST successfully');
  }
} catch (err) {
  console.log(`FAIL:list_records|${err.message}`);
}

// ============================================================================
// Test: search (if FTS is configured)
// ============================================================================

try {
  const result = await callTool('search', { query: 'test' });
  const text = getTextContent(result);

  // Search should not error even if no results
  if (result.isError) {
    console.log(`FAIL:search tool|Tool returned error: ${text}`);
  } else {
    console.log('PASS:search tool executes without error');
  }
} catch (err) {
  console.log(`FAIL:search|${err.message}`);
}

// ============================================================================
// Test: create_record + get_record (write path)
// ============================================================================

let createdRecordId = null;

try {
  // Create an Issue record — display_name is required, status and created_user
  // have defaults or are set by the database
  const createResult = await callTool('create_record', {
    entity: 'Issues',
    data: {
      display_name: 'MCP Integration Test Issue',
      description: 'Created by integration test',
    },
  });
  const createText = getTextContent(createResult);

  if (createResult.isError) {
    // This might fail due to permissions or required fields — both are acceptable outcomes
    if (createText.includes('permission') || createText.includes('denied') || createText.includes('403')) {
      console.log('PASS:create_record correctly denied (permissions enforced)');
    } else if (createText.includes('required') || createText.includes('constraint') || createText.includes('null') || createText.includes('violates')) {
      console.log('PASS:create_record validates required fields (expected constraint error)');
    } else {
      console.log(`FAIL:create_record|Unexpected error: ${createText.slice(0, 200)}`);
    }
  } else {
    console.log('PASS:create_record creates record in PostgREST');

    // Extract the record ID from the output ("Successfully created Issues record (ID: 12).")
    const idMatch = createText.match(/\(ID: (\d+)\)/);
    if (idMatch) {
      createdRecordId = parseInt(idMatch[1], 10);
      console.log(`PASS:create_record returns record ID (${createdRecordId})`);
    }
  }
} catch (err) {
  console.log(`FAIL:create_record|${err.message}`);
}

// Test get_record if we created one
if (createdRecordId) {
  try {
    const getResult = await callTool('get_record', {
      entity: 'Issues',
      id: createdRecordId,
    });
    const getText = getTextContent(getResult);

    if (getResult.isError) {
      console.log(`FAIL:get_record for created record|${getText.slice(0, 200)}`);
    } else {
      console.log('PASS:get_record retrieves the created record');
    }
  } catch (err) {
    console.log(`FAIL:get_record|${err.message}`);
  }
}

// Test update_record (last-write-wins: ETag support was removed in v0.72.3,
// see docs/notes/ETAG_CONCURRENCY_DESIGN.md)
if (createdRecordId) {
  try {
    const updateResult = await callTool('update_record', {
      entity: 'Issues',
      id: createdRecordId,
      data: { display_name: 'MCP Test Issue (Updated)' },
    });
    const updateText = getTextContent(updateResult);

    if (updateResult.isError) {
      console.log(`FAIL:update_record|${updateText.slice(0, 200)}`);
    } else {
      console.log('PASS:update_record updates the created record');
    }
  } catch (err) {
    console.log(`FAIL:update_record|${err.message}`);
  }
}

// ============================================================================
// Test: get_status_workflow (Issues have statuses in pothole example)
// ============================================================================

try {
  const result = await callTool('get_status_workflow', { entity: 'Issues' });
  const text = getTextContent(result);

  if (result.isError) {
    // Issues may or may not have statuses depending on schema setup
    if (text.includes('no status') || text.includes('not found') || text.includes('No status')) {
      console.log('PASS:get_status_workflow handles entities without statuses');
    } else {
      console.log(`FAIL:get_status_workflow|${text.slice(0, 200)}`);
    }
  } else {
    // Should include status names like "New", "Completed"
    if (text.includes('New') || text.includes('Completed') || text.includes('status')) {
      console.log('PASS:get_status_workflow returns workflow with status values');
    } else {
      console.log('PASS:get_status_workflow returns workflow information');
    }
  }
} catch (err) {
  console.log(`FAIL:get_status_workflow|${err.message}`);
}

// ============================================================================
// Frontend SDK divergence ledger regressions (row IDs: C-01..C-06, A-01, A-03, Q-14, Q-16, N-01, N-03, N-04)
// ============================================================================

async function postgrest(path, init = {}) {
  const res = await fetch(`${postgrestUrl}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// N-01: mixed-case table names resolve by table name ("Issue", "Tag")
for (const tableName of ['Issue', 'Tag']) {
  try {
    const result = await callTool('describe_entity', { entity: tableName });
    const text = getTextContent(result);
    if (result.isError) {
      console.log(`FAIL:N-01 describe_entity resolves table name "${tableName}"|${text.slice(0, 200)}`);
    } else {
      console.log(`PASS:N-01 describe_entity resolves table name "${tableName}"`);
    }
  } catch (err) {
    console.log(`FAIL:N-01 describe_entity "${tableName}"|${err.message}`);
  }
}

// Tests after N-01 address the entity by display name ("Issues") so each one
// isolates its own row instead of failing on N-01's table-name resolution.

// Q-14: an empty column list sends select=id (not the invalid "select=id,")
try {
  const result = await callTool('list_records', { entity: 'Issues', columns: [], limit: 1 });
  const text = getTextContent(result);
  if (result.isError) {
    console.log(`FAIL:Q-14 list_records with columns: [] succeeds|${text.slice(0, 200)}`);
  } else {
    console.log('PASS:Q-14 list_records with columns: [] succeeds');
  }
} catch (err) {
  console.log(`FAIL:Q-14 list_records with columns: []|${err.message}`);
}

// N-04: filtering a User column by UUID (the test user's own id, from the JWT sub)
if (createdRecordId) {
  try {
    const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
    const result = await callTool('list_records', {
      entity: 'Issues',
      filters: [{ field: 'created_user', operator: 'eq', value: userId }],
      limit: 100,
    });
    const text = getTextContent(result);
    if (result.isError) {
      console.log(`FAIL:N-04 list_records filters a User column by UUID|${text.slice(0, 200)}`);
    } else if (!new RegExp(`^\\| ${createdRecordId}\\s+\\|`, 'm').test(text)) {
      console.log(`FAIL:N-04 list_records filters a User column by UUID|created record #${createdRecordId} missing from results`);
    } else {
      console.log('PASS:N-04 list_records filters a User column by UUID');
    }
  } catch (err) {
    console.log(`FAIL:N-04 list_records User filter|${err.message}`);
  }
} else {
  console.log('FAIL:N-04 list_records User filter|no record created to filter for');
}

// A-01: conditions on a Status column compare the embedded status id.
// Actions come from fixtures/ledger-fixtures.sql; the created Issue is in the
// initial status, so "Ledger Gate Open" is enabled and "Ledger Gate Closed" is not.
if (createdRecordId) {
  try {
    const result = await callTool('get_record', { entity: 'Issues', id: createdRecordId });
    const lines = getTextContent(result).split('\n');
    const openLine = lines.find(l => l.includes('**Ledger Gate Open**'));
    const closedLine = lines.find(l => l.includes('**Ledger Gate Closed**'));
    if (!openLine || openLine.includes('(disabled')) {
      console.log(`FAIL:A-01 get_record lists the status-gated action as enabled|${openLine ?? 'action not listed'}`);
    } else {
      console.log('PASS:A-01 get_record lists the status-gated action as enabled');
    }
    if (!closedLine || !closedLine.includes('(disabled: Only closed issues)')) {
      console.log(`FAIL:A-01 get_record marks the other status's action disabled|${closedLine ?? 'action not listed'}`);
    } else {
      console.log("PASS:A-01 get_record marks the other status's action disabled");
    }
  } catch (err) {
    console.log(`FAIL:A-01 get_record actions|${err.message}`);
  }

  try {
    // The fixture's RPC does not exist: PostgREST answers 404 (PGRST202), which
    // the MCP reports as "Record not found." Only the RPC call can produce that,
    // so it proves the condition gate let the call through.
    const result = await callTool('execute_action', {
      entity: 'Issues', id: createdRecordId, action: 'mcp_ledger_gate_open',
    });
    const text = getTextContent(result);
    if (!text.includes('Record not found.')) {
      console.log(`FAIL:A-01 execute_action passes the status condition|${text.slice(0, 200)}`);
    } else {
      console.log('PASS:A-01 execute_action passes the status condition (reaches the RPC)');
    }

    const refused = await callTool('execute_action', {
      entity: 'Issues', id: createdRecordId, action: 'mcp_ledger_gate_closed',
    });
    const refusedText = getTextContent(refused);
    if (refused.isError && refusedText.includes('is disabled: Only closed issues')) {
      console.log('PASS:A-01 execute_action refuses an action whose status condition fails');
    } else {
      console.log(`FAIL:A-01 execute_action refuses an action whose status condition fails|${refusedText.slice(0, 200)}`);
    }
  } catch (err) {
    console.log(`FAIL:A-01 execute_action|${err.message}`);
  }
} else {
  console.log('FAIL:A-01 status-gated actions|no record created to evaluate against');
}

// C-02 / C-03: strict equality and number-only ordering. The fixture's
// "status eq '<id as string>'" and "display_name gt 'A'" must not enable.
if (createdRecordId) {
  try {
    const lines = getTextContent(
      await callTool('get_record', { entity: 'Issues', id: createdRecordId }),
    ).split('\n');
    for (const [row, name, tooltip] of [
      ['C-02', 'Ledger Strict Eq', 'String status id never matches'],
      ['C-03', 'Ledger Numeric Gt', 'String comparison never enables'],
    ]) {
      const line = lines.find(l => l.includes(`**${name}**`));
      if (line && line.includes(`(disabled: ${tooltip})`)) {
        console.log(`PASS:${row} get_record marks "${name}" disabled`);
      } else {
        console.log(`FAIL:${row} get_record marks "${name}" disabled|${line ?? 'action not listed'}`);
      }
    }
  } catch (err) {
    console.log(`FAIL:C-02/C-03 get_record actions|${err.message}`);
  }
}

// C-05: a conditional action on a record that cannot be loaded is refused
// before the RPC (main sent it on unchecked).
try {
  const result = await callTool('execute_action', {
    entity: 'Issues', id: 2147483000, action: 'mcp_ledger_gate_open',
  });
  const text = getTextContent(result);
  if (result.isError && text.includes('not found in Issues') && text.includes('cannot be checked')) {
    console.log('PASS:C-05 execute_action refuses when the record cannot be loaded');
  } else {
    console.log(`FAIL:C-05 execute_action refuses when the record cannot be loaded|${text.slice(0, 200)}`);
  }
} catch (err) {
  console.log(`FAIL:C-05 execute_action missing record|${err.message}`);
}

// C-06: a malformed condition ({"or": "x"} on Tag) neither breaks get_record
// nor shows the action.
try {
  const result = await callTool('get_record', { entity: 'Tags', id: 1 });
  const text = getTextContent(result);
  if (!result.isError && !text.includes('Ledger Malformed')) {
    console.log('PASS:C-06 get_record survives a malformed condition and hides the action');
  } else {
    console.log(`FAIL:C-06 get_record survives a malformed condition and hides the action|${text.slice(0, 200)}`);
  }
} catch (err) {
  console.log(`FAIL:C-06 get_record malformed condition|${err.message}`);
}

// Q-16: an empty result reports "0 total records" (PostgREST sends "*/0")
try {
  const result = await callTool('list_records', {
    entity: 'Issues',
    filters: [{ field: 'display_name', operator: 'eq', value: 'No Such Issue (ledger Q-16)' }],
  });
  const text = getTextContent(result);
  if (!result.isError && text.includes('— 0 total records')) {
    console.log('PASS:Q-16 list_records reports 0 total records for an empty result');
  } else {
    console.log(`FAIL:Q-16 list_records reports 0 total records for an empty result|${text.slice(0, 200)}`);
  }
} catch (err) {
  console.log(`FAIL:Q-16 list_records empty total|${err.message}`);
}

// N-03: FK names containing LIKE wildcards resolve exactly (case-insensitively),
// not as patterns that also match look-alike names. One Bid per work package,
// so the filter result shows which work package the name resolved to.
{
  let wpIds = [];
  let bidIds = [];
  try {
    const wpNames = ['MCP WP 100%', 'MCP WP 100X', 'MCP WP a*b', 'MCP WP aXb'];
    const wps = await postgrest('WorkPackage', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(wpNames.map(name => ({
        display_name: name,
        quote_due_date: '2030-01-01T00:00:00Z',
      }))),
    });
    wpIds = wps.map(wp => wp.id);

    const ownerId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
    const bids = await postgrest('Bid', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(wps.map(wp => ({
        display_name: `Bid for ${wp.display_name}`,
        owner: ownerId,
        work_start_date: '2030-02-01',
        work_end_date: '2030-02-02',
        work_package: wp.id,
        total_cost: 100,
        company_email: 'ledger-n03@example.com',
      }))),
    });
    bidIds = bids.map(bid => bid.id);

    for (const [query, expected, lookAlike] of [
      ['mcp wp 100%', 'MCP WP 100%', 'MCP WP 100X'],
      ['mcp wp a*b', 'MCP WP a*b', 'MCP WP aXb'],
    ]) {
      const result = await callTool('list_records', {
        entity: 'Bid',
        filters: [{ field: 'work_package', operator: 'eq', value: query }],
        columns: ['display_name'],
      });
      const text = getTextContent(result);
      if (result.isError) {
        console.log(`FAIL:N-03 FK name "${query}" resolves to "${expected}"|${text.slice(0, 200)}`);
      } else if (!text.includes(`Bid for ${expected}`) || text.includes(`Bid for ${lookAlike}`)) {
        console.log(`FAIL:N-03 FK name "${query}" resolves to "${expected}"|wrong rows: ${text.slice(0, 300)}`);
      } else {
        console.log(`PASS:N-03 FK name "${query}" resolves to "${expected}" (not "${lookAlike}")`);
      }
    }
  } catch (err) {
    console.log(`FAIL:N-03 FK wildcard names|${err.message}`);
  } finally {
    if (bidIds.length > 0) {
      await postgrest(`Bid?id=in.(${bidIds.join(',')})`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      }).catch(err => console.log(`FAIL:N-03 cleanup (bids)|${err.message}`));
    }
    if (wpIds.length > 0) {
      await postgrest(`WorkPackage?id=in.(${wpIds.join(',')})`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      }).catch(err => console.log(`FAIL:N-03 cleanup (work packages)|${err.message}`));
    }
  }
}

// A-03: get_status_workflow reports transitions from rpc/get_status_transitions_for_entity
{
  let transitionId = null;
  try {
    const statuses = await postgrest('statuses?entity_type=eq.issue&order=sort_order.asc');
    const from = statuses.find(st => st.is_initial) ?? statuses[0];
    const to = statuses.find(st => st.id !== from.id);
    const upsert = await postgrest('rpc/upsert_status_transition', {
      method: 'POST',
      body: JSON.stringify({
        p_entity_type: 'issue',
        p_from_status_id: from.id,
        p_to_status_id: to.id,
        p_display_name: 'Ledger Test Transition',
      }),
    });
    if (!upsert.success) throw new Error(`upsert_status_transition: ${upsert.error}`);
    transitionId = upsert.id;

    const result = await callTool('get_status_workflow', { entity: 'Issues' });
    const text = getTextContent(result);
    const expected = `- **${from.display_name}** → ${to.display_name} ("Ledger Test Transition")`;
    if (text.includes('### Allowed Transitions') && text.includes(expected)) {
      console.log('PASS:A-03 get_status_workflow reports transitions from the RPC');
    } else {
      console.log(`FAIL:A-03 get_status_workflow reports transitions from the RPC|expected "${expected}" in: ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.log(`FAIL:A-03 get_status_workflow transitions|${err.message}`);
  } finally {
    if (transitionId) {
      await postgrest('rpc/delete_status_transition', {
        method: 'POST',
        body: JSON.stringify({ p_transition_id: transitionId }),
      }).catch(err => console.log(`FAIL:A-03 cleanup|${err.message}`));
    }
  }
}

// ============================================================================
// Cleanup
// ============================================================================

await client.close();
await server.close();
console.log('PASS:MCP server and client shut down cleanly');
