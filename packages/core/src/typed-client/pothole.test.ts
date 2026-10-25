/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SchemaClient } from '../client/schema-client.js';
import type { Transport } from '../transport/types.js';
import { bootstrapTypedSchema } from './index.js';

// The pothole capture and the generated snapshot come in through Vite's glob (core has no Node types and may
// not import outside its package; the call must stay a literal `import.meta.glob(`).
const captures: Record<string, unknown> =
  // @ts-expect-error `glob` is a Vite extension of ImportMeta that core's lib set does not declare
  import.meta.glob('../../../../tests/golden/raw/pothole/testadmin/schema_*.json', { eager: true, import: 'default' });
const generated: Record<string, { DOMAIN_VERSION: string; SCHEMA_HASH: string }> =
  // @ts-expect-error as above
  import.meta.glob('../../../../tests/golden/codegen/pothole.ts', { eager: true });
const { DOMAIN_VERSION, SCHEMA_HASH } = Object.values(generated)[0]!;

const API = 'https://api.example.com/';
const transport: Transport = {
  request(req) {
    const view = req.url.slice(API.length).split('?')[0]!;
    const key = Object.keys(captures).find(k => k.endsWith(`/${view}.json`));
    const body = key ? captures[key] : [];
    return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify(body) });
  },
};

describe('pothole through a fake transport', () => {
  it('the generated SCHEMA_HASH matches the captured contract_hash: verified', async () => {
    const schema = new SchemaClient({ transport, apiUrl: API });
    const t = await bootstrapTypedSchema({
      schema,
      understands: { domain: DOMAIN_VERSION, schemaHash: SCHEMA_HASH },
      onIncompatible: 'block',
    });
    expect(t.mode).toBe('verified');
    const issue = (t.entities as Record<string, { property(c: string): { name: string }; handle: { name: string } }>)['Issue']!;
    expect(issue.handle.name).toBe('Issue');
    expect(issue.property('status').name).toBe('status');
  });
});
