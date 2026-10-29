/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { DataClient } from '../client/data-client.js';
import { TransportError } from '../transport/errors.js';
import type { Transport, TransportRequest, TransportResponse } from '../transport/types.js';

/** The base URL a {@link fakeTransport} client sends to, unless the test names another. */
export const FAKE_API_URL = 'https://api.example.com/';

/** One request as a test compares it: the path after the API base, and the parsed JSON body. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Present, and `true`, only for a request whose signal aborted before its reply settled. */
  aborted?: true;
}

/** What {@link fakeTransport} returns. */
export interface FakeTransport {
  transport: Transport;
  /** A {@link DataClient} over `transport`. */
  client: DataClient;
  /** Every request in the order sent, as the client built it. */
  requests: TransportRequest[];
  /** `requests` with the API base stripped from each URL and each body parsed. */
  recorded(): RecordedRequest[];
}

/** Options for {@link fakeTransport}. */
export interface FakeTransportOptions {
  /** The client's base URL; defaults to {@link FAKE_API_URL}. */
  apiUrl?: string;
  /** The client's largest accepted `limit` / `pageSize`; unset means none. */
  maxLimit?: number;
}

/** A transport reply: `body` is serialized as JSON unless it is a string; `null` sends an empty body. */
export function reply(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers, text: typeof body === 'string' ? body : body === null ? '' : JSON.stringify(body) };
}

/**
 * A transport that records every request and answers with `respond` (by
 * default, 200 with `[]`). Like a real transport, it rejects with
 * `TransportError` `kind: 'aborted'` when the request's signal aborts before
 * the reply settles, so latest-wins loading can be tested.
 */
export function fakeTransport(
  respond: (req: TransportRequest) => Promise<TransportResponse> = async () => reply(200, []),
  options: FakeTransportOptions = {},
): FakeTransport {
  const apiUrl = options.apiUrl ?? FAKE_API_URL;
  const requests: TransportRequest[] = [];
  const aborted = new Set<TransportRequest>();
  const transport: Transport = {
    request(req) {
      requests.push(req);
      const signal = req.signal;
      if (!signal) return respond(req);
      if (signal.aborted) {
        aborted.add(req);
        return Promise.reject(new TransportError('aborted'));
      }
      return new Promise<TransportResponse>((resolve, reject) => {
        const onAbort = () => {
          aborted.add(req);
          reject(new TransportError('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        respond(req).then(
          res => {
            signal.removeEventListener('abort', onAbort);
            resolve(res);
          },
          err => {
            signal.removeEventListener('abort', onAbort);
            reject(err);
          },
        );
      });
    },
  };
  const client = new DataClient({
    transport,
    apiUrl,
    ...(options.maxLimit !== undefined ? { maxLimit: options.maxLimit } : {}),
  });
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  const recorded = (): RecordedRequest[] =>
    requests.map(r => ({
      method: r.method,
      path: r.url.startsWith(base) ? r.url.slice(base.length) : r.url,
      headers: r.headers ?? {},
      ...(r.body !== undefined ? { body: JSON.parse(r.body) } : {}),
      ...(aborted.has(r) ? { aborted: true as const } : {}),
    }));
  return { transport, client, requests, recorded };
}
