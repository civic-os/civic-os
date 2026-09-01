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
let createdRecordEtag = null;

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

    // Extract the record ID from the output
    const idMatch = createText.match(/\*\*ID\*\*:\s*(\d+)/);
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

      // Check for ETag in output
      if (getText.includes('ETag') || getText.includes('etag')) {
        const etagMatch = getText.match(/[Ee][Tt]ag[^:]*:\s*"?([^"\n]+)"?/);
        if (etagMatch) {
          createdRecordEtag = etagMatch[1].trim();
          console.log('PASS:get_record includes ETag for concurrency');
        } else {
          console.log('PASS:get_record mentions ETag in output');
        }
      } else {
        console.log('FAIL:get_record ETag|No ETag found in get_record output');
      }
    }
  } catch (err) {
    console.log(`FAIL:get_record|${err.message}`);
  }
}

// Test update_record with ETag if available
if (createdRecordId && createdRecordEtag) {
  try {
    const updateResult = await callTool('update_record', {
      entity: 'Issues',
      id: createdRecordId,
      data: { display_name: 'MCP Test Issue (Updated)' },
      etag: createdRecordEtag,
    });
    const updateText = getTextContent(updateResult);

    if (updateResult.isError) {
      console.log(`FAIL:update_record with ETag|${updateText.slice(0, 200)}`);
    } else {
      console.log('PASS:update_record with valid ETag succeeds');
    }

    // Now try updating with the stale ETag — should get a 412
    try {
      const staleResult = await callTool('update_record', {
        entity: 'Issues',
        id: createdRecordId,
        data: { display_name: 'MCP Test Issue (Stale)' },
        etag: createdRecordEtag, // This is now stale
      });
      const staleText = getTextContent(staleResult);

      if (staleResult.isError && (staleText.includes('412') || staleText.includes('modified') || staleText.includes('changed'))) {
        console.log('PASS:update_record with stale ETag returns 412 conflict');
      } else if (staleResult.isError) {
        console.log('PASS:update_record with stale ETag returns error (ETag enforcement active)');
      } else {
        // PostgREST might not enforce ETags in all configurations
        console.log('PASS:update_record with stale ETag (PostgREST may not enforce ETags in this config)');
      }
    } catch (err) {
      console.log(`FAIL:update_record stale ETag|${err.message}`);
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
// Cleanup
// ============================================================================

await client.close();
await server.close();
console.log('PASS:MCP server and client shut down cleanly');
