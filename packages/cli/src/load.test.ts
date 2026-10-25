/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodegenError, fixtureSource, loadRawSchema, urlSource } from './load.js';
import type { SchemaSource } from './load.js';

const VIEWS: Record<string, unknown[]> = {
  schema_entities: [],
  schema_properties: [],
  schema_m2m_properties: [],
  schema_entity_actions: [],
  statuses: [],
  schema_domain_version: [{ domain_version: '1.2.3', framework_version: '0.77.0', contract_hash: 'sha256:abc' }],
};
const memory = (views: Record<string, unknown[] | undefined>): SchemaSource => ({ label: 'memory', read: async v => views[v] });

describe('loadRawSchema', () => {
  it('reads every view through the one interface', async () => {
    const raw = await loadRawSchema(memory(VIEWS));
    expect(raw.source).toBe('memory');
    expect(raw.domainVersion.contract_hash).toBe('sha256:abc');
  });

  it('says the instance is older than v0.77.0 when the domain version view is missing or empty', async () => {
    for (const missing of [undefined, []]) {
      await expect(loadRawSchema(memory({ ...VIEWS, schema_domain_version: missing }))).rejects.toThrow(/older than Civic OS v0\.77\.0/);
    }
  });

  it('names any other missing view', async () => {
    await expect(loadRawSchema(memory({ ...VIEWS, statuses: undefined }))).rejects.toThrow(/"statuses" is missing/);
  });

  it('rejects a version row without a hash', async () => {
    await expect(loadRawSchema(memory({ ...VIEWS, schema_domain_version: [{ domain_version: '1.0.0' }] }))).rejects.toThrow(CodegenError);
  });
});

describe('fixtureSource', () => {
  it('reads <view>.json, labels the source relative to the cwd, and reports a missing file as undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'civic-os-cli-'));
    await writeFile(join(dir, 'statuses.json'), '[{"id":1}]');
    await writeFile(join(dir, 'bad.json'), '{}');
    const src = fixtureSource(dir, tmpdir());
    expect(src.label).toBe(dir.slice(tmpdir().length + 1));
    expect(await src.read('statuses')).toEqual([{ id: 1 }]);
    expect(await src.read('nope')).toBeUndefined();
    await expect(src.read('bad')).rejects.toThrow(/not a JSON array/);
  });
});

describe('urlSource', () => {
  it('sends a bearer token, labels by host, and reads a 404 as absent', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/gone') ? new Response('', { status: 404 }) : new Response('[1]', { status: 200 }));
    const src = urlSource('https://api.example.org/v1/', 'tok', fetchImpl as unknown as typeof fetch);
    expect(src.label).toBe('api.example.org');
    expect(await src.read('rows')).toEqual([1]);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.org/v1/rows', { headers: { Accept: 'application/json', Authorization: 'Bearer tok' } });
    expect(await src.read('gone')).toBeUndefined();
  });

  it('throws on any other failure and on a malformed URL', async () => {
    const boom = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(urlSource('https://x.test', undefined, boom).read('v')).rejects.toThrow(/HTTP 500/);
    expect(() => urlSource('not a url')).toThrow(/not a valid URL/);
  });
});
