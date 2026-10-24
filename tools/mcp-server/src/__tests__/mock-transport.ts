/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Test helper: gives a `{ get: vi.fn() }` PostgRESTClient mock the `transport`
 * the schema cache now builds its core SchemaClient on. Every transport GET is
 * forwarded to the mock's `get(path)`, so the existing path-keyed mocks keep
 * working. A MaintenanceError rejection becomes a 503 PT503 response (what
 * PostgREST sends); any other rejection propagates.
 */

import type { Transport } from '@civic-os/core';
import { MaintenanceError } from '../postgrest-client.js';
import type { PostgRESTClient } from '../postgrest-client.js';

export function withTransport<T extends { get: (...args: any[]) => any }>(client: T): T & PostgRESTClient {
  const transport: Transport = {
    async request(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\//, '');
      try {
        const res = await client.get(path);
        return { status: res.status ?? 200, headers: res.headers ?? {}, text: JSON.stringify(res.data ?? []) } as any;
      } catch (err) {
        if (err instanceof MaintenanceError) {
          return {
            status: 503,
            headers: {},
            text: JSON.stringify({ code: 'PT503', message: err.message, hint: err.hint ?? null }),
          } as any;
        }
        throw err;
      }
    },
  };
  return Object.assign(client, { transport }) as any;
}
