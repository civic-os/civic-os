/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { fetchTransport } from './fetch-transport.js';
import type { FetchLike, FetchLikeResponse } from './fetch-transport.js';
import { TransportError } from './errors.js';
import type { AbortSignalLike } from './types.js';

// The core compiles without DOM typings; the test runtime (Node) provides AbortController.
declare const AbortController: new () => { readonly signal: AbortSignalLike; abort(): void };

const API = 'https://api.example.com/';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function response(status: number, text: string, headers: Record<string, string> = {}): FetchLikeResponse {
  return {
    status,
    headers: { forEach: cb => Object.entries(headers).forEach(([k, v]) => cb(v, k)) },
    text: async () => text,
  };
}

function recordingFetch(reply: () => Promise<FetchLikeResponse> = async () => response(200, '[]')) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    return reply();
  };
  return { calls, fetch };
}

describe('fetchTransport credentials', () => {
  it('sends the bearer token to URLs under the API', async () => {
    const { calls, fetch } = recordingFetch();
    const t = fetchTransport({ apiUrl: API, getToken: () => 'tok', fetch });
    await t.request({ method: 'GET', url: API + 'issues?select=id' });
    expect(calls[0].headers['Authorization']).toBe('Bearer tok');
  });

  it('accepts an apiUrl without a trailing slash and the bare API URL itself', async () => {
    const { calls, fetch } = recordingFetch();
    const t = fetchTransport({ apiUrl: 'https://api.example.com', getToken: () => 'tok', fetch });
    await t.request({ method: 'GET', url: 'https://api.example.com/issues' });
    await t.request({ method: 'GET', url: 'https://api.example.com' });
    expect(calls.map(c => c.headers['Authorization'])).toEqual(['Bearer tok', 'Bearer tok']);
  });

  it('never sends the token to an off-origin URL', async () => {
    const { calls, fetch } = recordingFetch();
    const t = fetchTransport({ apiUrl: API, getToken: () => 'tok', fetch });
    await t.request({ method: 'GET', url: 'https://other/' });
    await t.request({ method: 'GET', url: 'https://other.example.com/x' });
    expect(calls.every(c => !('Authorization' in c.headers))).toBe(true);
  });

  it('never sends the token to look-alike origins (path-boundary match, not string prefix)', async () => {
    const { calls, fetch } = recordingFetch();
    const t = fetchTransport({ apiUrl: API, getToken: () => 'tok', fetch });
    for (const url of [
      'https://api.example.com.evil.test/x',
      'https://api.example.comx/',
      'https://api.example.com@evil.test/x',
      'http://api.example.com/x',
      'HTTPS://api.example.com/x',
    ]) {
      await t.request({ method: 'GET', url });
    }
    expect(calls).toHaveLength(5);
    expect(calls.every(c => !('Authorization' in c.headers))).toBe(true);
  });

  it('does not send the token to a look-alike when apiUrl has no trailing slash either', async () => {
    const { calls, fetch } = recordingFetch();
    const t = fetchTransport({ apiUrl: 'https://api.example.com', getToken: () => 'tok', fetch });
    await t.request({ method: 'GET', url: 'https://api.example.com.evil.test/x' });
    expect(calls[0].headers).not.toHaveProperty('Authorization');
  });

  it('treats relative URLs as not under the API (no token)', async () => {
    const { calls, fetch } = recordingFetch();
    const t = fetchTransport({ apiUrl: API, getToken: () => 'tok', fetch });
    await t.request({ method: 'GET', url: '/issues' });
    await t.request({ method: 'GET', url: 'issues' });
    expect(calls.every(c => !('Authorization' in c.headers))).toBe(true);
  });

  it('awaits an async getToken, and calls it only for API requests', async () => {
    const { calls, fetch } = recordingFetch();
    let tokenCalls = 0;
    const t = fetchTransport({
      apiUrl: API,
      getToken: async () => {
        tokenCalls++;
        return 'async-tok';
      },
      fetch,
    });
    await t.request({ method: 'GET', url: API + 'a' });
    await t.request({ method: 'GET', url: 'https://other/' });
    expect(calls[0].headers['Authorization']).toBe('Bearer async-tok');
    expect(tokenCalls).toBe(1);
  });

  it('sends no Authorization header when getToken yields nothing', async () => {
    const { calls, fetch } = recordingFetch();
    for (const token of [null, undefined, '']) {
      await fetchTransport({ apiUrl: API, getToken: () => token, fetch }).request({ method: 'GET', url: API + 'a' });
    }
    expect(calls.every(c => !('Authorization' in c.headers))).toBe(true);
  });

  it('leaves a caller-set Authorization header untouched', async () => {
    const { calls, fetch } = recordingFetch();
    const t = fetchTransport({ apiUrl: API, getToken: () => 'tok', fetch });
    await t.request({ method: 'GET', url: API + 'a', headers: { authorization: 'Bearer caller' } });
    expect(calls[0].headers).toEqual({ authorization: 'Bearer caller' });
  });
});

describe('fetchTransport request shape', () => {
  it('passes method, URL, headers and body through unchanged, defaulting Content-Type for bodies', async () => {
    const { calls, fetch } = recordingFetch();
    const t = fetchTransport({ apiUrl: API, getToken: () => null, fetch });
    await t.request({ method: 'PATCH', url: API + 'issues?id=eq.a&b', headers: { Prefer: 'return=representation' }, body: '{"a":1}' });
    await t.request({ method: 'POST', url: API + 'x', headers: { 'content-type': 'text/csv' }, body: 'a,b' });
    await t.request({ method: 'DELETE', url: API + 'issues?id=eq.5' });
    expect(calls).toEqual([
      { url: API + 'issues?id=eq.a&b', method: 'PATCH', headers: { Prefer: 'return=representation', 'Content-Type': 'application/json' }, body: '{"a":1}' },
      { url: API + 'x', method: 'POST', headers: { 'content-type': 'text/csv' }, body: 'a,b' },
      { url: API + 'issues?id=eq.5', method: 'DELETE', headers: {} },
    ]);
  });
});

describe('fetchTransport responses', () => {
  it('resolves non-2xx statuses with status, text and headers', async () => {
    const { fetch } = recordingFetch(async () => response(409, '{"code":"23505"}', { 'Content-Type': 'application/json' }));
    const res = await fetchTransport({ apiUrl: API, getToken: () => null, fetch }).request({ method: 'POST', url: API + 'x', body: '{}' });
    expect(res).toEqual({ status: 409, text: '{"code":"23505"}', headers: { 'content-type': 'application/json' } });
  });

  it('lowercases header names and joins repeated ones', async () => {
    const { fetch } = recordingFetch(async () => ({
      status: 200,
      headers: {
        forEach: cb => {
          cb('0-24/237', 'Content-Range');
          cb('a', 'X-Multi');
          cb('b', 'x-multi');
        },
      },
      text: async () => '[]',
    }));
    const res = await fetchTransport({ apiUrl: API, getToken: () => null, fetch }).request({ method: 'GET', url: API + 'x' });
    expect(res.headers).toEqual({ 'content-range': '0-24/237', 'x-multi': 'a, b' });
  });
});

describe('fetchTransport failures', () => {
  it('maps a thrown fetch error to TransportError network, keeping the cause', async () => {
    const boom = new TypeError('fetch failed');
    const { fetch } = recordingFetch(async () => {
      throw boom;
    });
    const err = await fetchTransport({ apiUrl: API, getToken: () => null, fetch })
      .request({ method: 'GET', url: API + 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('network');
    expect((err as TransportError).cause).toBe(boom);
  });

  it('maps a body-read failure to network', async () => {
    const { fetch } = recordingFetch(async () => ({
      status: 200,
      headers: { forEach: () => {} },
      text: async () => {
        throw new Error('stream reset');
      },
    }));
    const err = await fetchTransport({ apiUrl: API, getToken: () => null, fetch })
      .request({ method: 'GET', url: API + 'x' })
      .catch((e: unknown) => e);
    expect((err as TransportError).kind).toBe('network');
  });

  it('rejects aborted before the request, without calling fetch or getToken', async () => {
    const { calls, fetch } = recordingFetch();
    let tokenCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const err = await fetchTransport({ apiUrl: API, getToken: () => (tokenCalls++, 'tok'), fetch })
      .request({ method: 'GET', url: API + 'x', signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('aborted');
    expect(calls).toHaveLength(0);
    expect(tokenCalls).toBe(0);
  });

  it('rejects aborted when the signal fires during an async getToken', async () => {
    const { calls, fetch } = recordingFetch();
    const controller = new AbortController();
    const t = fetchTransport({
      apiUrl: API,
      getToken: async () => {
        controller.abort();
        return 'tok';
      },
      fetch,
    });
    const err = await t.request({ method: 'GET', url: API + 'x', signal: controller.signal }).catch((e: unknown) => e);
    expect((err as TransportError).kind).toBe('aborted');
    expect(calls).toHaveLength(0);
  });

  it('rejects aborted when the signal fires during the request, and passes the signal to fetch', async () => {
    const controller = new AbortController();
    let seenSignal: unknown;
    let started!: () => void;
    const fetchStarted = new Promise<void>(resolve => (started = resolve));
    const fetch: FetchLike = (_url, init) => {
      seenSignal = init.signal;
      started();
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    };
    const pending = fetchTransport({ apiUrl: API, getToken: () => null, fetch })
      .request({ method: 'GET', url: API + 'x', signal: controller.signal })
      .catch((e: unknown) => e);
    await fetchStarted;
    controller.abort();
    const err = await pending;
    expect(seenSignal).toBe(controller.signal);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('aborted');
  });
});

describe('fetchTransport upload progress', () => {
  it('never calls onUploadProgress (fetch has no portable upload progress)', async () => {
    const { fetch } = recordingFetch();
    const progress: Array<[number, number | undefined]> = [];
    await fetchTransport({ apiUrl: API, getToken: () => null, fetch }).request({
      method: 'POST',
      url: API + 'x',
      body: '[1,2,3]',
      onUploadProgress: (loaded, total) => progress.push([loaded, total]),
    });
    expect(progress).toEqual([]);
  });
});
