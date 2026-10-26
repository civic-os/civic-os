/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for PostgRESTClient.
 */


import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PostgRESTClient, PostgRESTRequestError, MaintenanceError } from '../postgrest-client.js';

// The client is core's fetch transport and DataClient over a base URL and a
// token; these tests pin what the MCP keeps (base URL, token, the error and
// maintenance mapping, the 100-row limit). Requests, query strings and
// Content-Range parsing are core's and are covered by its tests.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgRESTClient', () => {
  let client: PostgRESTClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new PostgRESTClient({ baseUrl: 'http://localhost:3000', token: 'test-jwt' });
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastRequest(): { url: string; init: RequestInit; headers: Record<string, string> } {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
    return { url, init, headers: init.headers as Record<string, string> };
  }

  // ---- reads ----

  describe('data.getData()', () => {
    it('sends GET with the base URL and the bearer token', async () => {
      fetchMock.mockImplementation(async () => jsonResponse([{ id: 1 }]));

      const rows = await client.data.getData({ key: 'entities', fields: ['id'] });

      expect(rows).toEqual([{ id: 1 }]);
      expect(fetchMock).toHaveBeenCalledOnce();
      const { url, init, headers } = lastRequest();
      expect(url.startsWith('http://localhost:3000/entities?')).toBe(true);
      expect(headers['Authorization']).toBe('Bearer test-jwt');
      expect(init.method).toBe('GET');
    });

    it('removes trailing slashes from baseUrl', async () => {
      const c = new PostgRESTClient({ baseUrl: 'http://localhost:3000///' });
      fetchMock.mockImplementation(async () => jsonResponse([]));

      await c.data.getData({ key: 'entities', fields: ['id'] });

      expect(lastRequest().url.startsWith('http://localhost:3000/entities?')).toBe(true);
    });

    it('keeps a path prefix on the base URL', async () => {
      const c = new PostgRESTClient({ baseUrl: 'http://localhost:3000/api' });
      fetchMock.mockImplementation(async () => jsonResponse([]));

      await c.data.getData({ key: 'entities', fields: ['id'] });

      expect(lastRequest().url.startsWith('http://localhost:3000/api/entities?')).toBe(true);
    });

    it('sends no Authorization header when no token is set', async () => {
      const noAuthClient = new PostgRESTClient({ baseUrl: 'http://localhost:3000' });
      fetchMock.mockImplementation(async () => jsonResponse([]));

      await noAuthClient.data.getData({ key: 'entities', fields: ['id'] });

      expect(lastRequest().headers['Authorization']).toBeUndefined();
    });

    it('rejects a limit above the MCP maximum of 100 without sending a request (ledger Q-10)', async () => {
      await expect(client.data.getData({ key: 'entities', fields: ['id'], limit: 101 })).rejects.toThrow(/limit/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('data.getDataWindow()', () => {
    // Ledger Q-02 (Range window with count) and Q-16 (the total comes from the end of the header).
    it('requests a Range window with an exact count and returns the total', async () => {
      fetchMock.mockImplementation(async () => jsonResponse([{ id: 1 }], 206, { 'Content-Range': '0-24/237' }));

      const result = await client.data.getDataWindow({ key: 'entities', fields: ['id'], limit: 25, offset: 0 });

      expect(result).toEqual({ data: [{ id: 1 }], totalCount: 237 });
      const { headers } = lastRequest();
      expect(headers['Range']).toBe('0-24');
      expect(headers['Range-Unit']).toBe('items');
      expect(headers['Prefer']).toBe('count=exact');
    });

    it.each([
      ['*/0', 0],
      ['*/5', 5],
      ['0-0/1', 1],
      ['0-24/237', 237],
      ['0-24/*', null],
    ])('reads the total from Content-Range %j as %s', async (header, total) => {
      fetchMock.mockImplementation(async () => jsonResponse([], 200, { 'Content-Range': header }));

      const result = await client.data.getDataWindow({ key: 'entities', fields: ['id'] });

      expect(result.totalCount).toBe(total);
    });

    it('reports an unknown total when the header is absent', async () => {
      fetchMock.mockImplementation(async () => jsonResponse([]));

      const result = await client.data.getDataWindow({ key: 'entities', fields: ['id'] });

      expect(result.totalCount).toBeNull();
    });

    it('maps 416 to a PostgRESTRequestError with that status', async () => {
      fetchMock.mockImplementation(async () => jsonResponse({ message: 'Requested range not satisfiable', code: 'PGRST103' }, 416));

      await expect(client.data.getDataWindow({ key: 'entities', fields: ['id'], offset: 500 }))
        .rejects.toMatchObject({ name: 'PostgRESTRequestError', httpCode: 416 });
    });
  });

  describe('getAll()', () => {
    it('reads every column with the given order and no select', async () => {
      fetchMock.mockImplementation(async () => jsonResponse([{ id: 2 }]));

      const rows = await client.getAll('statuses', 'sort_order.asc');

      expect(rows).toEqual([{ id: 2 }]);
      const parsed = new URL(lastRequest().url);
      expect(parsed.pathname).toBe('/statuses');
      expect(parsed.searchParams.get('order')).toBe('sort_order.asc');
      expect(parsed.searchParams.has('select')).toBe(false);
    });
  });

  // ---- writes ----

  describe('writes', () => {
    it('createData posts the JSON body and asks for the representation', async () => {
      fetchMock.mockImplementation(async () => jsonResponse([{ id: 99 }], 201));

      const body = { name: 'Test', value: 42 };
      const created = await client.data.createData('entities', body);

      expect(created).toEqual([{ id: 99 }]);
      const { url, init, headers } = lastRequest();
      expect(url).toBe('http://localhost:3000/entities');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual(body);
      expect(headers['Prefer']).toBe('return=representation');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('editData patches by id with the representation', async () => {
      fetchMock.mockImplementation(async () => jsonResponse([{ id: 1, name: 'Updated' }]));

      const result = await client.data.editData('entities', 1, { name: 'Updated' });

      expect(result.body).toEqual([{ id: 1, name: 'Updated' }]);
      const { url, init } = lastRequest();
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({ name: 'Updated' });
      expect(new URL(url).searchParams.get('id')).toBe('eq.1');
    });

    it('editData encodes the id (ledger F-01)', async () => {
      fetchMock.mockImplementation(async () => jsonResponse([]));

      await client.data.editData('entities', 'a&b=c', { name: 'x' });

      expect(lastRequest().url).toContain('id=eq.a%26b%3Dc');
    });

    it('callRpc posts the parameters to rpc/<function>', async () => {
      fetchMock.mockImplementation(async () => jsonResponse({ success: true }));

      const result = await client.data.callRpc('approve', { p_entity_id: 5 });

      expect(result).toEqual({ success: true });
      const { url, init } = lastRequest();
      expect(url).toBe('http://localhost:3000/rpc/approve');
      expect(JSON.parse(init.body as string)).toEqual({ p_entity_id: 5 });
    });

    it('refreshCurrentUser posts an empty body to rpc/refresh_current_user', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(null));

      await client.data.refreshCurrentUser();

      const { url, init } = lastRequest();
      expect(url).toBe('http://localhost:3000/rpc/refresh_current_user');
      expect(JSON.parse(init.body as string)).toEqual({});
    });
  });

  // ---- setToken ----

  describe('setToken()', () => {
    it('updates the Authorization header on subsequent requests', async () => {
      fetchMock.mockImplementation(async () => jsonResponse([]));

      client.setToken('new-token');
      await client.data.getData({ key: 'entities', fields: ['id'] });

      expect(lastRequest().headers['Authorization']).toBe('Bearer new-token');
    });
  });

  // ---- Error handling ----

  describe('error handling', () => {
    it('throws PostgRESTRequestError on a non-2xx response with a JSON body', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(
        { message: 'permission denied', code: '42501', details: null, hint: null },
        403,
      ));

      const err = await client.data.getData({ key: 'entities', fields: ['id'] }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PostgRESTRequestError);
      const e = err as PostgRESTRequestError;
      expect(e.httpCode).toBe(403);
      expect(e.code).toBe('42501');
      expect(e.message).toBe('permission denied');
    });

    // E-04 keeps the raw PostgREST message, not arbitrary proxy output: a non-JSON, empty or null body gets the status message, as at base.
    it.each([
      ['an HTML proxy body', () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }), 502],
      ['an empty body', () => new Response('', { status: 401 }), 401],
      ['a JSON null body', () => new Response('null', { status: 404, headers: { 'Content-Type': 'application/json' } }), 404],
      ['a JSON string body', () => new Response('"oops"', { status: 500, headers: { 'Content-Type': 'application/json' } }), 500],
    ])('uses "PostgREST returned <status>" for %s', async (_name, make, status) => {
      fetchMock.mockImplementation(async () => make());

      const err = await client.data.getData({ key: 'entities', fields: ['id'] }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PostgRESTRequestError);
      const e = err as PostgRESTRequestError;
      expect(e.httpCode).toBe(status);
      expect(e.message).toBe(`PostgREST returned ${status}`);
      expect(e.code).toBeUndefined();
      expect(e.details).toBeUndefined();
      expect(e.hint).toBeUndefined();
    });

    it('sends Accept and Content-Type application/json on every request, as before the move to core', async () => {
      fetchMock.mockImplementation(async () => jsonResponse([]));

      await client.data.getData({ key: 'entities', fields: ['id'] });

      expect(lastRequest().headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' });
    });

    it('throws PostgRESTRequestError with httpCode 0 on a network failure', async () => {
      fetchMock.mockRejectedValue(new TypeError('Connection refused'));

      const err = await client.data.getData({ key: 'entities', fields: ['id'] }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PostgRESTRequestError);
      expect((err as PostgRESTRequestError).httpCode).toBe(0);
      expect((err as PostgRESTRequestError).message).toContain('Network error');
    });

    it('includes details and hint from the PostgREST error body', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(
        { message: 'duplicate key value', code: '23505', details: 'Key (email)=(a@b.com) already exists.', hint: null },
        409,
      ));

      const err = await client.data.getData({ key: 'entities', fields: ['id'] }).catch((e: unknown) => e);

      const e = err as PostgRESTRequestError;
      expect(e.details).toBe('Key (email)=(a@b.com) already exists.');
      expect(e.hint).toBeNull(); // a JSON null stays null, as at base
    });

    it('throws MaintenanceError with mode "readonly" for 503+PT503 with a read-only message', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(
        { message: 'System is in read-only maintenance mode', code: 'PT503', details: null, hint: null },
        503,
      ));

      const err = await client.data.createData('entities', { name: 'Test' }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MaintenanceError);
      expect((err as MaintenanceError).mode).toBe('readonly');
    });

    it('throws MaintenanceError with mode "full" for 503+PT503 without read-only in the message', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(
        { message: 'System is undergoing maintenance', code: 'PT503', details: null, hint: null },
        503,
      ));

      const err = await client.data.getData({ key: 'entities', fields: ['id'] }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MaintenanceError);
      expect((err as MaintenanceError).mode).toBe('full');
    });

    it('throws PostgRESTRequestError (not MaintenanceError) for 503 without the PT503 code', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(
        { message: 'Service Unavailable', code: null, details: null, hint: null },
        503,
      ));

      const err = await client.data.getData({ key: 'entities', fields: ['id'] }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PostgRESTRequestError);
      expect(err).not.toBeInstanceOf(MaintenanceError);
      expect((err as PostgRESTRequestError).httpCode).toBe(503);
    });
  });
});


// ---------------------------------------------------------------------------
// PostgRESTRequestError.toHumanMessage()
// ---------------------------------------------------------------------------

describe('PostgRESTRequestError.toHumanMessage()', () => {
  it('returns friendly message for network error (httpCode 0)', () => {
    const err = new PostgRESTRequestError('Network error', 0);
    expect(err.toHumanMessage()).toBe('Network error. Please check your connection.');
  });

  it('returns permission denied for code 42501', () => {
    const err = new PostgRESTRequestError('permission denied', 403, '42501');
    expect(err.toHumanMessage()).toBe('Permission denied. You do not have access to perform this action.');
  });

  it('returns duplicate message for code 23505', () => {
    const err = new PostgRESTRequestError('duplicate key', 409, '23505');
    expect(err.toHumanMessage()).toBe('A record with these values already exists (duplicate).');
  });

  it('returns not found for 404 httpCode', () => {
    const err = new PostgRESTRequestError('not found', 404);
    expect(err.toHumanMessage()).toBe('Record not found.');
  });

  it('returns authentication required for 401 httpCode', () => {
    const err = new PostgRESTRequestError('unauthorized', 401);
    expect(err.toHumanMessage()).toBe('Authentication required. Your session may have expired.');
  });

  it('returns optimistic concurrency message for 412 httpCode', () => {
    const err = new PostgRESTRequestError('precondition failed', 412);
    expect(err.toHumanMessage()).toBe('This record has been modified since you last read it. Please fetch the latest version and try again.');
  });

  it('returns the raw message for PL/pgSQL custom errors (P0001)', () => {
    const err = new PostgRESTRequestError('You cannot archive an active project.', 400, 'P0001');
    expect(err.toHumanMessage()).toBe('You cannot archive an active project.');
  });

  it('returns check constraint message from lookup for code 23514', () => {
    const err = new PostgRESTRequestError(
      'new row violates check constraint',
      422,
      '23514',
      'Failing row contains (...); constraint "projects_budget_positive".',
      null,
    );
    const constraintMessages = [
      { constraint_name: 'projects_budget_positive', error_message: 'Budget must be greater than zero.' },
    ];
    expect(err.toHumanMessage(constraintMessages)).toBe('Budget must be greater than zero.');
  });

  it('falls back to generic constraint message for 23514 when no lookup match', () => {
    const err = new PostgRESTRequestError(
      'check constraint violation',
      422,
      '23514',
      'constraint "unknown_constraint"',
      null,
    );
    expect(err.toHumanMessage([])).toContain('Invalid unknown constraint');
  });

  // E-01: the MCP keeps its base wording when a check violation names no constraint.
  it('uses the base wording for a 23514 that names no constraint', () => {
    const err = new PostgRESTRequestError('check constraint violation', 422, '23514', null, null);
    expect(err.toHumanMessage()).toBe('Invalid check constraint. Check the value and try again.');
  });

  it('returns exclusion conflict message for code 23P01', () => {
    const err = new PostgRESTRequestError(
      'conflicting key value violates exclusion constraint',
      409,
      '23P01',
      null,
      null,
    );
    expect(err.toHumanMessage()).toContain('conflicts with an existing record');
  });

  it('uses constraint lookup for 23P01 when available', () => {
    const err = new PostgRESTRequestError(
      'exclusion constraint violation',
      409,
      '23P01',
      'constraint "no_overlap".',
      null,
    );
    const constraintMessages = [
      { constraint_name: 'no_overlap', error_message: 'Time slots cannot overlap.' },
    ];
    expect(err.toHumanMessage(constraintMessages)).toBe('Time slots cannot overlap.');
  });

  it('returns generic error for unknown codes', () => {
    const err = new PostgRESTRequestError('Something went wrong', 500, '99999');
    expect(err.toHumanMessage()).toBe('Error: Something went wrong');
  });
});
