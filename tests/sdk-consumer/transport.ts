/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// A fixture transport for the custom-app fixture: it answers the SDK's PostgREST requests from the
// captured pothole contract in tests/golden/raw/pothole/testadmin, one JSON file per path
// (`schema_entities?...` is schema_entities.json, `rpc/get_x` is rpc.get_x.json). A custom app would
// put fetch behind the same `Transport` seam; here the bytes come from disk.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Transport } from '@civic-os/core';

// Compiled to tests/sdk-consumer/dist/sdk-consumer/, three levels below tests/.
const RAW = resolve(import.meta.dirname, '..', '..', '..', 'golden', 'raw', 'pothole', 'testadmin');

export const API = 'https://pothole.example.test/';

type Rows = Record<string, unknown>[];

export interface FixtureOptions {
  /** Rewrites the rows of one served path, to stand in for an instance that differs from the capture. */
  rewrite?: Record<string, (rows: Rows) => Rows>;
}

export function fixtureTransport(options: FixtureOptions = {}): Transport & { readonly served: string[] } {
  const served: string[] = [];
  return {
    served,
    request(req) {
      const path = req.url.slice(API.length).split('?')[0]!;
      served.push(path);
      // A path the capture has no file for fails loudly: the fixture must not invent an empty instance.
      const rows = JSON.parse(readFileSync(join(RAW, `${path.replaceAll('/', '.')}.json`), 'utf8')) as Rows;
      const rewrite = options.rewrite?.[path];
      return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify(rewrite ? rewrite(rows) : rows) });
    },
  };
}
