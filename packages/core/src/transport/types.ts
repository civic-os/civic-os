/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal structural stand-in for the DOM `AbortSignal`. The core compiles with
 * `lib: ES2022` and `types: []`, so DOM and Node globals do not exist here; a
 * real `AbortSignal` satisfies this shape.
 *
 * @consumer app
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * One HTTP request, as the core clients describe it. `url` is absolute (the
 * clients prepend the API base) and is sent exactly as given: nothing in the
 * transport layer encodes or rewrites it.
 *
 * @consumer app
 */
export interface TransportRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  /** Request headers the caller sets explicitly. A transport may add its own (see `fetchTransport`). */
  headers?: Record<string, string>;
  /** Serialized body (JSON text); `undefined` sends no body. */
  body?: string;
  /** Aborting rejects the returned promise with `TransportError` `kind: 'aborted'`. */
  signal?: AbortSignalLike;
  /**
   * Upload progress callback for transports that can observe it (an XHR or
   * Angular `HttpClient` transport). `total` is `undefined` when the length is
   * unknown. Transports without progress support never call it.
   */
  onUploadProgress?: (loaded: number, total: number | undefined) => void;
}

/**
 * A completed HTTP exchange. Every status resolves, including 4xx and 5xx:
 * classifying a failed status is the caller's job, so that error bodies stay
 * available. Only a failure to complete the exchange rejects.
 *
 * @consumer app
 */
export interface TransportResponse {
  status: number;
  /** HTTP reason phrase when the transport knows it (absent under HTTP/2 and in some fakes). */
  statusText?: string;
  /** Response headers with lowercased names; repeated headers are joined with `, `. */
  headers: Record<string, string>;
  /** Raw response body text (empty string when there is no body). */
  text: string;
}

/**
 * The I/O seam of the core: everything that touches the network goes through
 * one `request` call. Implementations: `fetchTransport` (browsers, Node, Bun,
 * workers) and the app's Angular `HttpClient` transport.
 *
 * @consumer app
 */
export interface Transport {
  request(req: TransportRequest): Promise<TransportResponse>;
}
