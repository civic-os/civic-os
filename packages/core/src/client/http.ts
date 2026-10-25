/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Transport, TransportRequest, TransportResponse } from '../transport/types.js';
import { DataClientError } from './errors.js';

/**
 * Ensures the API base ends in `/` (the same normalization as the app's
 * `getPostgrestUrl()`), so request paths concatenate without a leading slash.
 */
export function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.endsWith('/') ? apiUrl : apiUrl + '/';
}

/** JSON.parse that returns `undefined` instead of throwing. Empty text is `null`, as `HttpClient` yields. */
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Parses a 2xx response as JSON (empty body is `null`) and turns anything else into a {@link DataClientError}. */
export function parseSuccess(response: TransportResponse): unknown {
  if (response.status < 200 || response.status >= 300) {
    const parsed = tryParseJson(response.text);
    throw new DataClientError('http', response, parsed.ok ? parsed.value : undefined);
  }
  const parsed = tryParseJson(response.text);
  if (!parsed.ok) {
    throw new DataClientError('parse', response, undefined);
  }
  return parsed.value;
}

/**
 * Issues one request and resolves the parsed body together with the response.
 * Deliberately not `async`: `transport.request` is called synchronously, in
 * the same tick as the caller, which the Angular `fromCore()` helper relies on
 * to issue HTTP inside `subscribe`.
 */
export function send(transport: Transport, req: TransportRequest): Promise<{ body: unknown; response: TransportResponse }> {
  return transport.request(req).then(response => ({ body: parseSuccess(response), response }));
}
