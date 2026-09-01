/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for PostgRESTClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PostgRESTClient, PostgRESTRequestError } from '../postgrest-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const headersMap = new Map(Object.entries({
    'Content-Type': 'application/json',
    ...headers,
  }));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => headersMap.get(key) ?? null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function mockFetch(response: Response) {
  return vi.fn().mockResolvedValue(response);
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

  // ---- GET ----

  describe('get()', () => {
    it('sends GET with correct URL and auth header', async () => {
      fetchMock.mockResolvedValue(mockResponse([{ id: 1 }]));

      await client.get('entities');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3000/entities');
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-jwt');
      expect(init.method).toBe('GET');
    });

    it('appends query params to URL', async () => {
      fetchMock.mockResolvedValue(mockResponse([]));

      await client.get('schema_entities', { order: 'sort_order.asc', limit: '10' });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.searchParams.get('order')).toBe('sort_order.asc');
      expect(parsed.searchParams.get('limit')).toBe('10');
    });

    it('removes trailing slash from baseUrl', async () => {
      const c = new PostgRESTClient({ baseUrl: 'http://localhost:3000///' });
      fetchMock.mockResolvedValue(mockResponse([]));

      await c.get('entities');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3000/entities');
    });

    it('returns parsed data from response', async () => {
      const records = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
      fetchMock.mockResolvedValue(mockResponse(records));

      const result = await client.get('users');

      expect(result.data).toEqual(records);
      expect(result.status).toBe(200);
    });

    it('parses Content-Range header with known total', async () => {
      fetchMock.mockResolvedValue(
        mockResponse([], 200, { 'Content-Range': '0-24/237' }),
      );

      const result = await client.get('entities');

      expect(result.contentRange).toEqual({ from: 0, to: 24, total: 237 });
    });

    it('parses Content-Range with unknown total (*)', async () => {
      fetchMock.mockResolvedValue(
        mockResponse([], 200, { 'Content-Range': '0-24/*' }),
      );

      const result = await client.get('entities');

      expect(result.contentRange).toEqual({ from: 0, to: 24, total: null });
    });

    it('returns undefined contentRange when header is absent', async () => {
      fetchMock.mockResolvedValue(mockResponse([]));

      const result = await client.get('entities');

      expect(result.contentRange).toBeUndefined();
    });

    it('returns undefined data for 204 responses', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 204,
        headers: { get: () => null },
        json: () => Promise.resolve(null),
      } as unknown as Response);

      const result = await client.get('entities');

      expect(result.data).toBeUndefined();
    });

    it('sends no Authorization header when token is not set', async () => {
      const noAuthClient = new PostgRESTClient({ baseUrl: 'http://localhost:3000' });
      fetchMock.mockResolvedValue(mockResponse([]));

      await noAuthClient.get('entities');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });
  });

  // ---- POST ----

  describe('post()', () => {
    it('sends POST with JSON body', async () => {
      fetchMock.mockResolvedValue(mockResponse({ id: 99 }, 201));

      const body = { name: 'Test', value: 42 };
      await client.post('entities', body);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3000/entities');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual(body);
    });

    it('sends POST with extra headers', async () => {
      fetchMock.mockResolvedValue(mockResponse({ id: 1 }, 201));

      await client.post('entities', { name: 'Test' }, { Prefer: 'return=representation' });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Prefer']).toBe('return=representation');
    });

    it('includes Content-Type application/json', async () => {
      fetchMock.mockResolvedValue(mockResponse({ id: 1 }, 201));

      await client.post('entities', { name: 'Test' });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });
  });

  // ---- PATCH ----

  describe('patch()', () => {
    it('sends PATCH with body and extra headers', async () => {
      fetchMock.mockResolvedValue(mockResponse({ id: 1, name: 'Updated' }));

      await client.patch(
        'entities',
        { name: 'Updated' },
        { id: 'eq.1' },
        { 'If-Match': '"etag-abc"' },
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({ name: 'Updated' });
      expect((init.headers as Record<string, string>)['If-Match']).toBe('"etag-abc"');
      expect(new URL(url).searchParams.get('id')).toBe('eq.1');
    });
  });

  // ---- DELETE ----

  describe('delete()', () => {
    it('sends DELETE with filter params', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 204,
        headers: { get: () => null },
      } as unknown as Response);

      await client.delete('entities', { id: 'eq.5' });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('DELETE');
      expect(new URL(url).searchParams.get('id')).toBe('eq.5');
    });
  });

  // ---- setToken ----

  describe('setToken()', () => {
    it('updates the Authorization header on subsequent requests', async () => {
      fetchMock.mockResolvedValue(mockResponse([]));

      client.setToken('new-token');
      await client.get('entities');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer new-token');
    });
  });

  // ---- Error handling ----

  describe('error handling', () => {
    it('throws PostgRESTRequestError on non-200 response with JSON body', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(
          { message: 'permission denied', code: '42501', details: null, hint: null },
          403,
        ),
      );

      await expect(client.get('entities')).rejects.toThrowError(PostgRESTRequestError);

      try {
        await client.get('entities');
      } catch (err) {
        const e = err as PostgRESTRequestError;
        expect(e.httpCode).toBe(403);
        expect(e.code).toBe('42501');
        expect(e.message).toBe('permission denied');
      }
    });

    it('throws PostgRESTRequestError with status message when body is not JSON', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => null },
        json: () => Promise.reject(new Error('not JSON')),
      } as unknown as Response);

      await expect(client.get('entities')).rejects.toThrowError('PostgREST returned 500');
    });

    it('throws PostgRESTRequestError with httpCode 0 on network failure', async () => {
      fetchMock.mockRejectedValue(new Error('Connection refused'));

      try {
        await client.get('entities');
        expect.fail('Should have thrown');
      } catch (err) {
        const e = err as PostgRESTRequestError;
        expect(e).toBeInstanceOf(PostgRESTRequestError);
        expect(e.httpCode).toBe(0);
        expect(e.message).toContain('Network error');
      }
    });

    it('includes details and hint from PostgREST error body', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(
          {
            message: 'duplicate key value',
            code: '23505',
            details: 'Key (email)=(a@b.com) already exists.',
            hint: null,
          },
          409,
        ),
      );

      try {
        await client.get('entities');
      } catch (err) {
        const e = err as PostgRESTRequestError;
        expect(e.details).toBe('Key (email)=(a@b.com) already exists.');
        expect(e.hint).toBeNull();
      }
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
