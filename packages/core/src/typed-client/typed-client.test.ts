/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { SchemaClient } from '../client/schema-client.js';
import type { EntityAction, SchemaEntityProperty, SchemaEntityTable } from '../model/entity.js';
import type { Transport, TransportRequest, TransportResponse } from '../transport/types.js';
import {
  ClientUpdateRequiredError,
  SchemaContractError,
  SchemaMismatchError,
  bootstrapTypedSchema,
} from './index.js';
import type { IncompatiblePolicy, SchemaMismatch } from './index.js';

const API = 'https://api.example.com/';
const HASH = 'sha256:aaaa';

type None = Record<never, never>;

interface Db {
  entities: {
    issues: { Row: { title: string }; Insert: None; Update: None; Embedded: None; Relations: None; Actions: { close_issue: None } };
  };
}

const versionRow = (over: Record<string, unknown> = {}) => ({
  contract_hash: HASH,
  decision_id: null,
  domain_version: '1.2.0',
  framework_version: '0.77.0',
  min_client_domain_version: null,
  set_by_migration: 'm',
  ...over,
});

const entity = { table_name: 'issues', display_name: 'Issues' } as SchemaEntityTable;
const prop = { table_name: 'issues', column_name: 'title', display_name: 'Title', data_type: 'text', udt_name: 'text' } as SchemaEntityProperty;
const action = { id: 1, table_name: 'issues', action_name: 'close_issue', display_name: 'Close', parameters: [] } as unknown as EntityAction;

/** Transport answering from mutable tables; `version: null` answers 404 like a pre-v0.77 instance. */
function world(over: { version?: unknown; entities?: SchemaEntityTable[]; properties?: SchemaEntityProperty[] } = {}) {
  const data = {
    version: 'version' in over ? over.version : versionRow(),
    entities: over.entities ?? [entity],
    properties: over.properties ?? [prop],
  };
  const requests: string[] = [];
  const transport: Transport = {
    request(req: TransportRequest): Promise<TransportResponse> {
      const path = req.url.slice(API.length);
      requests.push(path);
      if (path.startsWith('schema_domain_version')) {
        return Promise.resolve(
          data.version === null
            ? { status: 404, headers: {}, text: '{"code":"PGRST205"}' }
            : { status: 200, headers: {}, text: JSON.stringify([data.version]) },
        );
      }
      const body = path.startsWith('schema_entities')
        ? data.entities
        : path.startsWith('schema_properties')
          ? data.properties
          : path.startsWith('schema_entity_actions')
            ? [action]
            : [];
      return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify(body) });
    },
  };
  const schema = new SchemaClient({ transport, apiUrl: API });
  return { data, schema, requests };
}

const understands = (over: Partial<{ domain: string; schemaHash: string }> = {}) => ({ domain: '1.2.0', schemaHash: HASH, ...over });
const boot = (w: ReturnType<typeof world>, onIncompatible: IncompatiblePolicy, over = {}, onWarn?: (m: SchemaMismatch) => void) =>
  bootstrapTypedSchema<Db>({ schema: w.schema, understands: understands(over), onIncompatible, onWarn });

describe('bootstrapTypedSchema: hash and policy', () => {
  it('a matching hash is verified under every policy, without a warning', async () => {
    for (const policy of ['block', 'warn', 'verify'] as const) {
      const onWarn = vi.fn();
      const t = await boot(world(), policy, {}, onWarn);
      expect(t.mode).toBe('verified');
      expect(t.compatibility).toEqual({ status: 'ok' });
      expect(t.instance?.contractHash).toBe(HASH);
      expect(onWarn).not.toHaveBeenCalled();
    }
  });

  it('a hash mismatch: block rejects, warn trusts after one warning, verify goes per-call', async () => {
    const other = { schemaHash: 'sha256:bbbb' };
    const err = await boot(world(), 'block', other).catch(e => e);
    expect(err).toBeInstanceOf(SchemaMismatchError);
    expect(err.mismatch).toMatchObject({ reason: 'hash-mismatch', expectedHash: 'sha256:bbbb', liveHash: HASH });

    const onWarn = vi.fn();
    const warned = await boot(world(), 'warn', other, onWarn);
    expect(warned.mode).toBe('trusted-after-warning');
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![0]).toMatchObject({ reason: 'hash-mismatch' });

    expect((await boot(world(), 'verify', other, () => {})).mode).toBe('per-call');
  });

  it('a missing view is unverifiable under each policy', async () => {
    const err = await boot(world({ version: null }), 'block').catch(e => e);
    expect(err).toBeInstanceOf(SchemaMismatchError);
    expect(err.mismatch).toMatchObject({ reason: 'unverifiable', liveHash: undefined, instanceDomainVersion: undefined });

    const onWarn = vi.fn();
    const warned = await boot(world({ version: null }), 'warn', {}, onWarn);
    expect(warned).toMatchObject({ mode: 'trusted-after-warning', instance: undefined, compatibility: undefined });
    expect(onWarn).toHaveBeenCalledTimes(1);

    expect((await boot(world({ version: null }), 'verify', {}, () => {})).mode).toBe('per-call');
  });

  it('the floor blocks under all three policies, even when the hash matches', async () => {
    for (const policy of ['block', 'warn', 'verify'] as const) {
      const w = world({ version: versionRow({ min_client_domain_version: '1.5.0' }) });
      const err = await boot(w, policy, {}, () => {}).catch(e => e);
      expect(err, policy).toBeInstanceOf(ClientUpdateRequiredError);
      expect(err).toMatchObject({ appDomainVersion: '1.2.0', minClientDomainVersion: '1.5.0' });
    }
  });

  it('client-ahead follows the policy', async () => {
    const ahead = { domain: '1.3.0' };
    const err = await boot(world(), 'block', ahead).catch(e => e);
    expect(err).toBeInstanceOf(SchemaMismatchError);
    expect(err.mismatch).toMatchObject({ reason: 'client-ahead', appDomainVersion: '1.3.0', instanceDomainVersion: '1.2.0' });
    const warnCalls = vi.fn();
    expect((await boot(world(), 'warn', ahead, warnCalls)).mode).toBe('trusted-after-warning');
    expect(warnCalls).toHaveBeenCalledTimes(1);
    expect(warnCalls.mock.calls[0]![0]).toMatchObject({ reason: 'client-ahead' });
    const verifyCalls = vi.fn();
    expect((await boot(world(), 'verify', ahead, verifyCalls)).mode).toBe('per-call');
    expect(verifyCalls).toHaveBeenCalledTimes(1);
  });

  it('an invalid version is a mismatch that follows the policy', async () => {
    const w = () => world({ version: versionRow({ domain_version: 'nope' }) });
    const err = await boot(w(), 'block').catch(e => e);
    expect(err.mismatch.reason).toBe('invalid');
    const warnCalls = vi.fn();
    expect((await boot(w(), 'warn', {}, warnCalls)).mode).toBe('trusted-after-warning');
    expect(warnCalls).toHaveBeenCalledTimes(1);
    expect(warnCalls.mock.calls[0]![0]).toMatchObject({ reason: 'invalid' });
    const verifyCalls = vi.fn();
    expect((await boot(w(), 'verify', {}, verifyCalls)).mode).toBe('per-call');
    expect(verifyCalls).toHaveBeenCalledTimes(1);
  });

  // The three invalid fields checkCompatibility reports. With a floor the check cannot be enforced, so every
  // policy rejects; without one the policy governs.
  const invalidCases: [string, Record<string, unknown>, Record<string, string>][] = [
    ['instance.domainVersion', { domain_version: 'nope' }, {}],
    ['instance.minClientDomainVersion', { min_client_domain_version: 'nope' }, {}],
    ['app.domainVersion', {}, { domain: 'nope' }],
  ];

  it.each(invalidCases)('invalid %s with a floor fails closed under every policy', async (_field, versionOver, appOver) => {
    for (const policy of ['block', 'warn', 'verify'] as const) {
      const floor = _field === 'instance.minClientDomainVersion' ? {} : { min_client_domain_version: '1.0.0' };
      const onWarn = vi.fn();
      const w = world({ version: versionRow({ ...floor, ...versionOver }) });
      const err = await boot(w, policy, appOver, onWarn).catch(e => e);
      expect(err, policy).toBeInstanceOf(SchemaMismatchError);
      expect(err.mismatch.reason).toBe('invalid');
      expect(onWarn).not.toHaveBeenCalled();
    }
  });

  it.each(invalidCases.filter(c => c[0] !== 'instance.minClientDomainVersion'))(
    'invalid %s without a floor follows the policy',
    async (_field, versionOver, appOver) => {
      const mk = () => world({ version: versionRow(versionOver) });
      expect((await boot(mk(), 'block', appOver).catch(e => e)).mismatch.reason).toBe('invalid');
      const warnCalls = vi.fn();
      expect((await boot(mk(), 'warn', appOver, warnCalls)).mode).toBe('trusted-after-warning');
      expect(warnCalls).toHaveBeenCalledTimes(1);
      const verifyCalls = vi.fn();
      expect((await boot(mk(), 'verify', appOver, verifyCalls)).mode).toBe('per-call');
      expect(verifyCalls).toHaveBeenCalledTimes(1);
    },
  );

  it('warns through console.warn by default', async () => {
    const c = (globalThis as unknown as { console: { warn(...args: unknown[]): void } }).console;
    const original = c.warn;
    const warn = vi.fn();
    c.warn = warn;
    try {
      await boot(world(), 'warn', { schemaHash: 'sha256:bbbb' });
    } finally {
      c.warn = original;
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('accessors', () => {
  it('verified mode memoizes handles', async () => {
    const t = await boot(world(), 'block');
    const issues = t.entities.issues;
    expect(issues.handle).toBe(issues.handle);
    expect(issues.property('title')).toBe(issues.property('title'));
    expect(t.entities.issues).toBe(issues);
    expect(issues.property('title').exists).toBe(true);
  });

  it('per-call mode resolves afresh each call', async () => {
    const t = await boot(world(), 'verify', { schemaHash: 'sha256:bbbb' }, () => {});
    const issues = t.entities.issues;
    expect(issues.handle).not.toBe(issues.handle);
    expect(issues.property('title')).not.toBe(issues.property('title'));
  });

  it('absence throws SchemaContractError in each mode, naming entity and column', async () => {
    const modes: [IncompatiblePolicy, Record<string, string>][] = [['block', {}], ['warn', { schemaHash: 'sha256:bbbb' }], ['verify', { schemaHash: 'sha256:bbbb' }]];
    for (const [policy, over] of modes) {
      const t = await boot(world(), policy, over, () => {});
      const e = t.entities as unknown as Record<string, { handle: unknown; property(c: string): unknown }>;
      expect(() => e['ghost']!.handle, policy).toThrow(SchemaContractError);
      expect(() => e['ghost']!.handle).toThrow('"ghost"');
      let caught: unknown;
      try {
        t.entities.issues.property('missing' as 'title');
      } catch (err) {
        caught = err;
      }
      expect(caught, policy).toBeInstanceOf(SchemaContractError);
      expect(caught).toMatchObject({ entity: 'issues', member: 'missing' });
    }
  });

  it('a warn mismatch that really removed a column throws instead of returning undefined', async () => {
    const t = await boot(world({ properties: [] }), 'warn', { schemaHash: 'sha256:bbbb' }, () => {});
    expect(() => t.entities.issues.property('title')).toThrow(SchemaContractError);
  });

  it('optional never throws and returns undefined when absent', async () => {
    const t = await boot(world(), 'block');
    expect(t.entities.issues.optional('nope')).toBeUndefined();
    expect(t.entities.issues.optional('title')?.name).toBe('title');
    const e = t.entities as unknown as Record<string, { optional(c: string): unknown }>;
    expect(e['ghost']!.optional('x')).toBeUndefined();
  });

  it('actions need loading; the error says so', async () => {
    const t = await boot(world(), 'block');
    expect(() => t.entities.issues.action('close_issue')).toThrow(/not loaded/);
    await t.entities.issues.loadActions();
    expect(t.entities.issues.action('close_issue').key).toBe('close_issue');
    expect(() => t.entities.issues.action('other' as 'close_issue')).toThrow(SchemaContractError);
  });

  it('entities lists the live entities', async () => {
    const t = await boot(world(), 'block');
    expect(Object.keys(t.entities)).toEqual(['issues']);
    expect('issues' in t.entities).toBe(true);
    expect('ghost' in t.entities).toBe(false);
  });

  it('verified stays verified after clear(); memoized handles report absence until reload', async () => {
    const w = world();
    const t = await boot(w, 'block');
    const handle = t.entities.issues.handle;
    w.schema.clear();
    expect(t.mode).toBe('verified');
    expect(handle.exists).toBe(false);
    expect(() => t.entities.issues.handle).toThrow(SchemaContractError);
    await w.schema.getEntities();
    expect(handle.exists).toBe(true);
    expect(t.entities.issues.handle).toBe(handle);
  });

  it('a memoized property is re-checked: after clear() and a reload without the column it throws', async () => {
    for (const [policy, over] of [['block', {}], ['warn', { schemaHash: 'sha256:bbbb' }]] as const) {
      const w = world();
      const t = await boot(w, policy, over, () => {});
      const first = t.entities.issues.property('title');
      await t.entities.issues.loadActions();
      const act = t.entities.issues.action('close_issue');
      w.schema.clear();
      w.data.properties = [];
      await Promise.all([w.schema.getEntities(), w.schema.getProperties(), t.entities.issues.loadActions()]);
      let caught: unknown;
      try {
        t.entities.issues.property('title');
      } catch (err) {
        caught = err;
      }
      expect(caught, policy).toBeInstanceOf(SchemaContractError);
      expect(caught).toMatchObject({ entity: 'issues', member: 'title' });
      expect(first.exists).toBe(false);
      // the action still exists, and the memoized handle is returned while it does
      expect(t.entities.issues.action('close_issue')).toBe(act);
      w.schema.clear();
      expect(() => t.entities.issues.action('close_issue')).toThrow(SchemaContractError);
    }
  });

  it('per-call mode: a column removed later throws', async () => {
    const w = world();
    const t = await boot(w, 'verify', { schemaHash: 'sha256:bbbb' }, () => {});
    expect(t.entities.issues.property('title').exists).toBe(true);
    w.schema.clear();
    w.data.properties = [];
    await Promise.all([w.schema.getEntities(), w.schema.getProperties()]);
    expect(() => t.entities.issues.property('title')).toThrow(SchemaContractError);
  });

  it('the entities proxy is safe to await, serialize and probe with symbols', async () => {
    const t = await boot(world(), 'block');
    expect(await Promise.resolve(t.entities)).toBe(t.entities);
    expect(() => JSON.stringify(t.entities)).not.toThrow();
    const e = t.entities as unknown as Record<string | symbol, unknown>;
    expect(e['then']).toBeUndefined();
    expect(e['toJSON']).toBeUndefined();
    expect(e[Symbol.iterator]).toBeUndefined();
    expect(e[Symbol.toPrimitive]).toBeUndefined();
    expect(e[Symbol.toStringTag]).toBeUndefined();
    // none of those created an accessor
    expect(Object.keys(t.entities)).toEqual(['issues']);
  });
});
