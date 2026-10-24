/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Test helper: gives a `{ get, post, patch }` vi.fn mock the real client
 * surface the code now uses (`transport`, `data`, `getAll`). The real core
 * DataClient and SchemaClient run over a fake transport that decodes every
 * request back into the call the mocks were written for:
 *
 *   GET    -> get(path, params, headers)    (get(path) when there is neither)
 *   POST   -> post(path, body, headers)
 *   PATCH  -> patch(path, body, params, headers)
 *
 * and turns the mock's resolved value or thrown error into the HTTP response
 * PostgREST would send: `{ data, status, contentRange }` becomes a JSON body
 * with a Content-Range header, a thrown PostgRESTRequestError becomes its error
 * body at its status, a MaintenanceError becomes a 503 PT503 response, a code-0
 * PostgRESTRequestError a network failure, and any other rejection propagates.
 * So the tests drive the same code path production takes, and an assertion on
 * `get`'s arguments is an assertion on the request core built.
 */

import { TransportError, type Transport } from '@civic-os/core';
import { MaintenanceError, PostgRESTClient, PostgRESTRequestError } from '../postgrest-client.js';

const BASE = 'http://mock.test';

interface LegacyResult {
  data?: unknown;
  status?: number;
  headers?: Record<string, string>;
  contentRange?: { from: number; to: number; total?: number | null };
}

function toResponse(res: LegacyResult | undefined) {
  const headers: Record<string, string> = { ...(res?.headers ?? {}) };
  const range = res?.contentRange;
  if (range) {
    headers['content-range'] = `${range.from}-${range.to}/${range.total ?? '*'}`;
  }
  return { status: res?.status ?? 200, headers, text: JSON.stringify(res?.data ?? []) };
}

function toErrorResponse(err: unknown) {
  if (err instanceof MaintenanceError) {
    return {
      status: 503,
      headers: {},
      text: JSON.stringify({ code: 'PT503', message: err.message, hint: err.hint ?? null }),
    };
  }
  if (err instanceof PostgRESTRequestError) {
    if (err.httpCode === 0) throw new TransportError('network');
    return {
      status: err.httpCode,
      headers: {},
      text: JSON.stringify({ message: err.message, code: err.code, details: err.details, hint: err.hint }),
    };
  }
  throw err;
}

export function withTransport<T extends { get: (...args: any[]) => any }>(client: T): T & PostgRESTClient {
  const mock = client as any;
  const transport: Transport = {
    async request(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\//, '');
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) params[k] = v;
      const headers = req.headers ?? {};
      const hasParams = Object.keys(params).length > 0;
      const hasHeaders = Object.keys(headers).length > 0;
      const body = req.body === undefined ? undefined : JSON.parse(req.body);
      try {
        let res: LegacyResult | undefined;
        if (req.method === 'GET') {
          res = await (hasParams || hasHeaders ? mock.get(path, params, headers) : mock.get(path));
        } else if (req.method === 'POST') {
          res = await (hasHeaders ? mock.post(path, body, headers) : mock.post(path, body));
        } else if (req.method === 'PATCH') {
          res = await mock.patch(path, body, params, headers);
        } else {
          res = await mock.delete(path, params, headers);
        }
        return toResponse(res) as any;
      } catch (err) {
        return toErrorResponse(err) as any;
      }
    },
  };
  const real = new PostgRESTClient({ baseUrl: BASE, transport });
  return Object.assign(client, {
    transport,
    data: real.data,
    getAll: real.getAll.bind(real),
    setToken: mock.setToken ?? (() => undefined),
  }) as any;
}
