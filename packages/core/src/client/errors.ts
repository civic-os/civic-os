/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { classifyPostgrestError } from '../errors/classify.js';
import type { ClassifiedPostgrestError, PostgrestErrorShape } from '../errors/classify.js';
import type { TransportResponse } from '../transport/types.js';

/**
 * PostgREST error fields read from a failed response, with the HTTP status as
 * `httpCode`. Same shape as the app's `ApiError` minus the human message.
 *
 * @consumer typed DataClientError
 */
export interface DataClientErrorShape extends PostgrestErrorShape {
  hint?: string;
}

/**
 * Failure of a request that did get an HTTP response (a network failure or an
 * abort rejects with `TransportError` instead, and is never wrapped).
 *
 * - `kind: 'http'`: a non-2xx status. `body` is the response parsed as JSON
 *   (`undefined` when it is not JSON), `text` the raw text, `classified` the
 *   {@link classifyPostgrestError} result for `shape`.
 * - `kind: 'parse'`: a 2xx status whose body was not valid JSON.
 *
 * Both SchemaClient and DataClient throw it.
 *
 * @consumer app
 */
export class DataClientError extends Error {
  readonly kind: 'http' | 'parse';
  readonly status: number;
  readonly statusText: string | undefined;
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly body: unknown;
  readonly shape: DataClientErrorShape;
  readonly classified: ClassifiedPostgrestError;

  constructor(kind: 'http' | 'parse', response: TransportResponse, body: unknown) {
    const shape = errorShape(response, body);
    super(
      kind === 'parse'
        ? `Response body is not valid JSON (HTTP ${response.status})`
        : shape.message || response.statusText || `HTTP ${response.status}`,
    );
    this.name = 'DataClientError';
    this.kind = kind;
    this.status = response.status;
    this.statusText = response.statusText;
    this.headers = response.headers;
    this.text = response.text;
    this.body = body;
    this.shape = shape;
    this.classified = classifyPostgrestError(shape);
  }
}

function errorShape(response: TransportResponse, body: unknown): DataClientErrorShape {
  const shape: DataClientErrorShape = { httpCode: response.status };
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b['code'] === 'string') shape.code = b['code'];
    if (typeof b['details'] === 'string') shape.details = b['details'];
    if (typeof b['hint'] === 'string') shape.hint = b['hint'];
    if (typeof b['message'] === 'string') shape.message = b['message'];
  } else if (typeof body === 'string') {
    // A JSON string body ("foo"): HttpClient yields the parsed value, which is the message.
    shape.message = body;
  } else if (response.text) {
    // Unstructured error body: the text itself is the message.
    shape.message = response.text;
  }
  return shape;
}
