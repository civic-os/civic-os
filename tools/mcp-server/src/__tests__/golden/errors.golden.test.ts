/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Golden outputs (MCP): error-message parsing.
 *  - _example/errors.lookup.json: PostgRESTRequestError.toHumanMessage over
 *    EXACTLY the frontend artifact's payload set, with the example's
 *    constraint_messages loaded through the real SchemaCache. Same keys as the
 *    frontend artifact: `parseToHuman` holds toHumanMessage() (no lookup) and
 *    `parseToHumanWithLookup` holds toHumanMessage(constraintMessages);
 *    `unloaded` uses the cache's value before initialize() (an empty list).
 *  - _shared/errors.data-parse-api-error.json: the client path
 *    (PostgRESTClient.request over a stubbed fetch) for the same HTTP error
 *    cases as the frontend's DataService.parseApiError artifact.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MaintenanceError, PostgRESTClient, PostgRESTRequestError } from '../../postgrest-client.js';
import { SchemaCache } from '../../schema-cache.js';
import { adminVariant, checkGolden, expectNoOrphans, listExamples, loadFrontendArtifact } from './golden-io.js';
import { BASE, bootVariant, restoreFetch, FixtureBackend, type StubResponse } from './mcp-harness.js';
import { vi } from 'vitest';

afterEach(() => restoreFetch());

interface Payload { httpCode?: number; code?: string; message?: string; details?: string | null; hint?: string | null }

const toError = (p: Payload) =>
  new PostgRESTRequestError(p.message as string, p.httpCode as number, p.code, p.details, p.hint);

/** HTTP error cases of the frontend parseApiError artifact, as the MCP client would receive them. */
const CLIENT_CASES: Record<string, StubResponse> = {
  'postgrest 23505': { status: 409, body: { code: '23505', message: 'duplicate key', details: 'Key exists', hint: null } },
  'postgrest 23514 constraint': { status: 400, body: { code: '23514', message: 'violates check constraint "c1"', details: null, hint: 'h' } },
  'postgrest 42501': { status: 403, body: { code: '42501', message: 'permission denied' } },
  'postgrest P0001': { status: 400, body: { code: 'P0001', message: 'raised text' } },
  'postgrest no message': { status: 400, body: { code: 'XX000' } },
  'postgrest no message no statusText': { status: 500, body: { code: 'XX000' } },
  'string body': { status: 502, text: '<html>bad gateway</html>' },
  'null body': { status: 404, body: null },
  'network error status 0': { networkError: true },
  '401 empty': { status: 401, body: null },
  '503 PT503': { status: 503, body: { code: 'PT503', message: 'maintenance' } },
};

describe('golden (mcp): error messages', () => {
  for (const example of listExamples()) {
    it(`${example}: toHumanMessage over the frontend payload set with its constraint_messages`, async () => {
      const fe = loadFrontendArtifact(`${example}/_example/errors.lookup.json`);
      const ctx = await bootVariant(adminVariant(example));
      const messages = ctx.cache.constraintMessages;
      const results = fe.results.map((r: { payload: Payload }) => ({
        payload: r.payload,
        parseToHuman: toError(r.payload).toHumanMessage(),
        parseToHumanWithLookup: toError(r.payload).toHumanMessage(messages),
      }));
      const notLoaded = new SchemaCache(new PostgRESTClient({ baseUrl: BASE }), BASE).constraintMessages;
      const unloaded = fe.unloaded.map((r: { payload: Payload }) => ({
        payload: r.payload,
        parseToHumanWithLookup: toError(r.payload).toHumanMessage(notLoaded),
      }));
      checkGolden(`${example}/_example/errors.lookup.json`, { constraintMessages: messages, results, unloaded });
    });
  }

  it('PostgRESTClient error parsing over the frontend HttpErrorResponse cases', async () => {
    const fe = loadFrontendArtifact('_shared/errors.data-parse-api-error.json');
    expect(Object.keys(CLIENT_CASES).sort()).toEqual(Object.keys(fe).sort());
    const out: Record<string, unknown> = {};
    for (const [name, response] of Object.entries(CLIENT_CASES)) {
      const backend = new FixtureBackend(new Map());
      backend.responder = () => response;
      vi.stubGlobal('fetch', backend.fetch);
      const client = new PostgRESTClient({ baseUrl: BASE });
      try {
        await client.get('items');
        out[name] = { success: true };
      } catch (err) {
        if (err instanceof PostgRESTRequestError) {
          out[name] = {
            thrown: err.name,
            error: {
              code: err.code, details: err.details, hint: err.hint, httpCode: err.httpCode,
              humanMessage: err.toHumanMessage(), message: err.message,
            },
            success: false,
          };
        } else if (err instanceof MaintenanceError) {
          out[name] = { thrown: err.name, error: { hint: err.hint, message: err.message, mode: err.mode }, success: false };
        } else {
          throw err;
        }
      }
      restoreFetch();
    }
    checkGolden('_shared/errors.data-parse-api-error.json', out);
  });

  it('no orphan error golden files', () => {
    expectNoOrphans(rel => /\/errors\.[a-z-]+\.json$/.test(rel));
  });
});
