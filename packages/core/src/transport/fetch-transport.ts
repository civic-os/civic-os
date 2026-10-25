/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { TransportError } from './errors.js';
import type { AbortSignalLike, Transport, TransportRequest, TransportResponse } from './types.js';

/**
 * Headers of a `fetch` response, reduced to what the transport reads. The DOM
 * `Headers` object satisfies it.
 *
 * @consumer mcp
 */
export interface FetchLikeHeaders {
  forEach(callback: (value: string, key: string) => void): void;
}

/**
 * The part of a `fetch` response the transport reads.
 *
 * @consumer mcp
 */
export interface FetchLikeResponse {
  status: number;
  statusText?: string;
  headers: FetchLikeHeaders;
  text(): Promise<string>;
}

/**
 * Minimal `fetch` signature (core has no DOM or Node typings). The global
 * `fetch` of browsers, Node 20+, Bun and workers satisfies it.
 *
 * @consumer mcp
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignalLike;
  },
) => Promise<FetchLikeResponse>;

/**
 * Options for {@link fetchTransport}.
 *
 * @consumer mcp
 */
export interface FetchTransportOptions {
  /** Base URL of the PostgREST API. Credentials are sent only to URLs under it. */
  apiUrl: string;
  /**
   * Bearer token source, called once per request that targets the API; a falsy
   * result sends no Authorization header. An exception (or rejection) from it
   * propagates to the caller as-is, not wrapped in `TransportError`: a failing
   * token source is a configuration error, not a transport failure.
   */
  getToken: () => string | null | undefined | Promise<string | null | undefined>;
  /** `fetch` implementation; defaults to `globalThis.fetch`. Injectable for tests. */
  fetch?: FetchLike;
}

/** Normalizes an API base to end in `/`, so prefix tests cannot match a sibling host or path. */
function normalizeBase(apiUrl: string): string {
  return apiUrl.endsWith('/') ? apiUrl : apiUrl + '/';
}

/**
 * Whether `url` is the API itself or a path under it. Boundary-aware: with
 * `apiUrl` `https://api.example.com/`, `https://api.example.com/x` and
 * `https://api.example.com` match, `https://api.example.com.evil.test/x` and
 * `https://api.example.comx/` do not. Relative URLs never match: the clients
 * always prepend the absolute API base, so a relative URL is never the API.
 */
function isUnderApi(url: string, base: string): boolean {
  return url.startsWith(base) || url + '/' === base;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

/**
 * A {@link Transport} over `fetch` that attaches `Authorization: Bearer <token>`
 * only to requests whose URL is under `apiUrl` (path-boundary match), so a
 * token can never reach another origin through a caller-supplied URL. A
 * caller-set `Authorization` header is left alone.
 *
 * Other behavior:
 * - When a body is present and the caller set no `Content-Type`, sends
 *   `Content-Type: application/json` (PostgREST bodies are JSON; `fetch` would
 *   otherwise send `text/plain`).
 * - Every HTTP status resolves; header names are lowercased.
 * - A pre-aborted or mid-flight-aborted `signal` rejects with
 *   `TransportError('aborted')`; any other `fetch` failure rejects with
 *   `TransportError('network')`.
 * - `onUploadProgress` is NOT supported: `fetch` exposes no portable upload
 *   progress, so the callback is never invoked (no fabricated numbers). Use an
 *   XHR or Angular `HttpClient` transport when progress matters.
 *
 * @consumer mcp
 */
export function fetchTransport(options: FetchTransportOptions): Transport {
  const base = normalizeBase(options.apiUrl);

  return {
    async request(req: TransportRequest): Promise<TransportResponse> {
      if (req.signal?.aborted) {
        throw new TransportError('aborted');
      }

      const headers: Record<string, string> = { ...req.headers };
      if (isUnderApi(req.url, base) && !hasHeader(headers, 'authorization')) {
        const token = await options.getToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      }
      if (req.body !== undefined && !hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }

      // getToken may be slow: re-check before the network call.
      if (req.signal?.aborted) {
        throw new TransportError('aborted');
      }

      const doFetch = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
      if (!doFetch) {
        throw new TransportError('network', 'No fetch implementation available');
      }

      let response: Awaited<ReturnType<FetchLike>>;
      let text: string;
      try {
        response = await doFetch(req.url, {
          method: req.method,
          headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        });
        text = await response.text();
      } catch (cause) {
        throw req.signal?.aborted
          ? new TransportError('aborted', undefined, { cause })
          : new TransportError('network', undefined, { cause });
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        const name = key.toLowerCase();
        responseHeaders[name] = name in responseHeaders ? `${responseHeaders[name]}, ${value}` : value;
      });
      return {
        status: response.status,
        ...(response.statusText ? { statusText: response.statusText } : {}),
        headers: responseHeaders,
        text,
      };
    },
  };
}
