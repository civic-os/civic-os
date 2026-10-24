/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { TransportError } from '../transport/errors.js';
import type { Transport, TransportRequest, TransportResponse } from '../transport/types.js';
import { DataClientError } from './errors.js';
import { SchemaClient } from './schema-client.js';
import type { SchemaResource } from './schema-client.js';

const API = 'https://api.example.com/';

function reply(status: number, body: unknown): TransportResponse {
  return { status, headers: {}, text: typeof body === 'string' ? body : JSON.stringify(body) };
}

interface Pending {
  req: TransportRequest;
  resolve: (res: TransportResponse) => void;
  reject: (err: unknown) => void;
}

/** Transport whose replies the test controls; nothing settles until `resolve`/`reject` is called. */
function manualTransport() {
  const pending: Pending[] = [];
  const transport: Transport = {
    request(req) {
      return new Promise<TransportResponse>((resolve, reject) => {
        pending.push({ req, resolve, reject });
      });
    },
  };
  return { transport, pending };
}

/** Transport that answers every request immediately via `answer` (default: 200 with `[]`), recording each. */
function autoTransport(answer: (req: TransportRequest) => TransportResponse | Promise<TransportResponse> = () => reply(200, [])) {
  const requests: TransportRequest[] = [];
  const transport: Transport = {
    request(req) {
      requests.push(req);
      try {
        return Promise.resolve(answer(req));
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
  return { transport, requests };
}

function relative(req: TransportRequest): string {
  return req.url.slice(API.length);
}

const ENTITY = { table_name: 'issues', display_name: 'Issues' } as never;

describe('SchemaClient requests (URLs, headers, bodies as SchemaService sends them)', () => {
  const cases: Array<[string, (c: SchemaClient) => Promise<unknown>, string, string, unknown?]> = [
    ['getEntities', c => c.getEntities(), 'GET', 'schema_entities'],
    ['getProperties', c => c.getProperties(), 'GET', 'schema_properties'],
    ['fetchPropertiesFresh', c => c.fetchPropertiesFresh(), 'GET', 'schema_properties'],
    ['getM2mMetadata', c => c.getM2mMetadata(), 'GET', 'schema_m2m_properties'],
    ['getConstraintMessages', c => c.getConstraintMessages(), 'GET', 'constraint_messages'],
    ['getStaticText', c => c.getStaticText(), 'GET', 'static_text'],
    ['getGuidedFormDefinitions', c => c.getGuidedFormDefinitions(), 'GET', 'schema_guided_forms'],
    ['getGuidedFormSteps', c => c.getGuidedFormSteps(), 'GET', 'schema_guided_form_steps'],
    ['getStatuses', c => c.getStatuses('issue'), 'POST', 'rpc/get_statuses_for_entity', { p_entity_type: 'issue' }],
    ['getCategories', c => c.getCategories('issue'), 'POST', 'rpc/get_categories_for_entity', { p_entity_type: 'issue' }],
    ['getEntityActions', c => c.getEntityActions('issues'), 'GET', 'schema_entity_actions?table_name=eq.issues&order=sort_order.asc'],
    ['checkVersions', c => c.checkVersions(), 'GET', 'schema_cache_versions'],
  ];

  for (const [name, call, method, path, body] of cases) {
    it(`${name}: ${method} ${path}, no extra headers for the default locale`, async () => {
      const { transport, requests } = autoTransport();
      await call(new SchemaClient({ transport, apiUrl: API }));
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe(method);
      expect(relative(requests[0])).toBe(path);
      expect(requests[0].headers).toBeUndefined();
      expect(requests[0].body === undefined ? undefined : JSON.parse(requests[0].body)).toEqual(body);
    });

    it(`${name}: sends Accept-Language for a non-default locale`, async () => {
      const { transport, requests } = autoTransport();
      await call(new SchemaClient({ transport, apiUrl: API, locale: 'es' }));
      expect(requests[0].headers).toEqual({ 'Accept-Language': 'es' });
    });
  }

  it('adds the trailing slash to a base URL that lacks one', async () => {
    const { transport, requests } = autoTransport();
    await new SchemaClient({ transport, apiUrl: 'https://api.example.com' }).getEntities();
    expect(requests[0].url).toBe('https://api.example.com/schema_entities');
  });

  it('encodes the entity-actions query like HttpParams (space and percent encoded; @ : $ , ; = ? / kept)', async () => {
    const { transport, requests } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    await client.getEntityActions('a b%c&d@e:f$g,h;i=j?k/l+m');
    expect(relative(requests[0])).toBe(
      'schema_entity_actions?table_name=eq.a%20b%25c%26d@e:f$g,h;i=j?k/l%2Bm&order=sort_order.asc',
    );
  });
});

describe('SchemaClient issues requests synchronously on a cold cache', () => {
  const loads: Array<[string, (c: SchemaClient) => unknown]> = [
    ['getEntities', c => c.getEntities()],
    ['getProperties', c => c.getProperties()],
    ['fetchPropertiesFresh', c => c.fetchPropertiesFresh()],
    ['getM2mMetadata', c => c.getM2mMetadata()],
    ['getConstraintMessages', c => c.getConstraintMessages()],
    ['getStaticText', c => c.getStaticText()],
    ['getGuidedFormDefinitions', c => c.getGuidedFormDefinitions()],
    ['getGuidedFormSteps', c => c.getGuidedFormSteps()],
    ['getStatuses', c => c.getStatuses('issue')],
    ['getCategories', c => c.getCategories('issue')],
    ['getEntityActions', c => c.getEntityActions('issues')],
    ['checkVersions', c => c.checkVersions()],
  ];
  for (const [name, call] of loads) {
    it(`${name}: the request is recorded before the call returns control`, () => {
      const { transport, pending } = manualTransport();
      const client = new SchemaClient({ transport, apiUrl: API });
      void call(client);
      expect(pending).toHaveLength(1);
    });
  }

  it('a warm cache issues nothing, and a call joining an in-flight request issues nothing', async () => {
    const { transport, pending } = manualTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    const first = client.getEntities();
    void client.getEntities();
    expect(pending).toHaveLength(1);
    pending[0].resolve(reply(200, [ENTITY]));
    await first;
    void client.getEntities();
    expect(pending).toHaveLength(1);
  });
});

describe('SchemaClient caching and in-flight sharing', () => {
  it('shares one request among concurrent callers of the same resource and resolves all of them', async () => {
    const { transport, pending } = manualTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    const a = client.getProperties();
    const b = client.getProperties();
    const c = client.getProperties();
    expect(pending).toHaveLength(1);
    pending[0].resolve(reply(200, [{ column_name: 'x' }]));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toEqual([{ column_name: 'x' }]);
    expect(rb).toBe(ra);
    expect(rc).toBe(ra);
  });

  it('serves a loaded resource from cache with the same reference', async () => {
    const { transport, requests } = autoTransport(() => reply(200, [ENTITY]));
    const client = new SchemaClient({ transport, apiUrl: API });
    const first = await client.getEntities();
    const second = await client.getEntities();
    expect(second).toBe(first);
    expect(requests).toHaveLength(1);
  });

  it('keeps separate requests and caches for different resources', async () => {
    const { transport, requests } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    await Promise.all([client.getEntities(), client.getProperties(), client.getM2mMetadata(), client.getConstraintMessages()]);
    expect(requests.map(relative).sort()).toEqual(
      ['constraint_messages', 'schema_entities', 'schema_m2m_properties', 'schema_properties'].sort(),
    );
  });

  it('shares and caches statuses and categories per entity type', async () => {
    const { transport, pending } = manualTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    const a1 = client.getStatuses('issue');
    const a2 = client.getStatuses('issue');
    const b = client.getStatuses('request');
    const c = client.getCategories('issue');
    expect(pending.map(p => [relative(p.req), p.req.body])).toEqual([
      ['rpc/get_statuses_for_entity', '{"p_entity_type":"issue"}'],
      ['rpc/get_statuses_for_entity', '{"p_entity_type":"request"}'],
      ['rpc/get_categories_for_entity', '{"p_entity_type":"issue"}'],
    ]);
    pending[0].resolve(reply(200, [{ id: 1, display_name: 'Open', color: '#fff', status_key: 'open', sort_order: 1, extra: true }]));
    pending[1].resolve(reply(200, []));
    pending[2].resolve(reply(200, [{ id: 7, display_name: 'Bug', color: null, sort_order: 2 }]));
    expect(await a1).toBe(await a2);
    expect(await a1).toEqual([{ id: 1, display_name: 'Open', color: '#fff', status_key: 'open' }]);
    expect(await b).toEqual([]);
    expect(await c).toEqual([{ id: 7, display_name: 'Bug', color: null }]);
    expect(client.peekStatuses('issue')).toEqual(await a1);
    expect(client.peekStatuses('other')).toBeUndefined();
    expect(client.peekCategories('issue')).toEqual(await c);
  });

  it('tags static text rows with itemType', async () => {
    const { transport } = autoTransport(() => reply(200, [{ id: 3, table_name: 'issues', content: 'hi', sort_order: 1 }]));
    const rows = await new SchemaClient({ transport, apiUrl: API }).getStaticText();
    expect(rows).toEqual([{ id: 3, table_name: 'issues', content: 'hi', sort_order: 1, itemType: 'static_text' }]);
  });

  it('never caches entity actions', async () => {
    const { transport, requests } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    await client.getEntityActions('issues');
    await client.getEntityActions('issues');
    expect(requests).toHaveLength(2);
  });

  it('fetchPropertiesFresh bypasses and does not fill the cache', async () => {
    const { transport, requests } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    await client.getProperties();
    await client.fetchPropertiesFresh();
    expect(requests).toHaveLength(2);
    expect(client.peekProperties()).toEqual([]);
    const { transport: t2, requests: r2 } = autoTransport(() => reply(200, [{ column_name: 'fresh' }]));
    const c2 = new SchemaClient({ transport: t2, apiUrl: API });
    await c2.fetchPropertiesFresh();
    expect(c2.peekProperties()).toBeUndefined();
    await c2.getProperties();
    expect(r2).toHaveLength(2);
  });
});

describe('SchemaClient warm accessors', () => {
  it('return undefined when cold and the loaded value when warm', async () => {
    const { transport } = autoTransport(() => reply(200, [{ x: 1 }]));
    const client = new SchemaClient({ transport, apiUrl: API });
    expect(client.peekEntities()).toBeUndefined();
    expect(client.peekProperties()).toBeUndefined();
    expect(client.peekM2mMetadata()).toBeUndefined();
    expect(client.peekConstraintMessages()).toBeUndefined();
    expect(client.peekStaticText()).toBeUndefined();
    expect(client.peekGuidedFormDefinitions()).toBeUndefined();
    expect(client.peekGuidedFormSteps()).toBeUndefined();
    const pendingLoad = client.getEntities();
    expect(client.peekEntities()).toBeUndefined();
    const entities = await pendingLoad;
    expect(client.peekEntities()).toBe(entities);
    await client.getProperties();
    await client.getM2mMetadata();
    await client.getConstraintMessages();
    await client.getStaticText();
    await client.getGuidedFormDefinitions();
    await client.getGuidedFormSteps();
    expect(client.peekProperties()).toEqual([{ x: 1 }]);
    expect(client.peekM2mMetadata()).toEqual([{ x: 1 }]);
    expect(client.peekConstraintMessages()).toEqual([{ x: 1 }]);
    expect(client.peekStaticText()).toEqual([{ x: 1, itemType: 'static_text' }]);
    expect(client.peekGuidedFormDefinitions()).toEqual([{ x: 1 }]);
    expect(client.peekGuidedFormSteps()).toEqual([{ x: 1 }]);
  });
});

describe('SchemaClient error behaviour (as SchemaService)', () => {
  const rejecting: Array<[string, (c: SchemaClient) => Promise<unknown>]> = [
    ['getEntities', c => c.getEntities()],
    ['getProperties', c => c.getProperties()],
  ];
  for (const [name, call] of rejecting) {
    it(`${name}: an HTTP error rejects with DataClientError, is not cached, and the next call retries`, async () => {
      let n = 0;
      const { transport, requests } = autoTransport(() => (n++ === 0 ? reply(500, { message: 'boom', code: 'XX000' }) : reply(200, [{ ok: true }])));
      const client = new SchemaClient({ transport, apiUrl: API });
      const err = await call(client).catch(e => e);
      expect(err).toBeInstanceOf(DataClientError);
      expect((err as DataClientError).status).toBe(500);
      expect((err as DataClientError).shape.message).toBe('boom');
      expect(await call(client)).toEqual([{ ok: true }]);
      expect(requests).toHaveLength(2);
    });

    it(`${name}: a network failure rejects with the TransportError and is not cached`, async () => {
      let n = 0;
      const { transport, requests } = autoTransport(() => {
        if (n++ === 0) throw new TransportError('network', 'offline');
        return reply(200, []);
      });
      const client = new SchemaClient({ transport, apiUrl: API });
      const err = await call(client).catch(e => e);
      expect(err).toBeInstanceOf(TransportError);
      await call(client);
      expect(requests).toHaveLength(2);
    });

    it(`${name}: concurrent callers all reject on one failure, then a new call retries`, async () => {
      const { transport, pending } = manualTransport();
      const client = new SchemaClient({ transport, apiUrl: API });
      const a = call(client).catch(e => e);
      const b = call(client).catch(e => e);
      expect(pending).toHaveLength(1);
      pending[0].resolve(reply(503, { message: 'down' }));
      expect(await a).toBeInstanceOf(DataClientError);
      expect(await b).toBeInstanceOf(DataClientError);
      void call(client);
      expect(pending).toHaveLength(2);
    });
  }

  it('rejects on a 2xx body that is not JSON', async () => {
    const { transport } = autoTransport(() => reply(200, '<html>'));
    const err = await new SchemaClient({ transport, apiUrl: API }).getEntities().catch(e => e);
    expect(err).toBeInstanceOf(DataClientError);
    expect((err as DataClientError).kind).toBe('parse');
  });

  const degrading: Array<[string, SchemaResource, (c: SchemaClient) => Promise<unknown>, (c: SchemaClient) => unknown, string | undefined]> = [
    ['getM2mMetadata', 'm2m_properties', c => c.getM2mMetadata(), c => c.peekM2mMetadata(), undefined],
    ['getConstraintMessages', 'constraint_messages', c => c.getConstraintMessages(), c => c.peekConstraintMessages(), undefined],
    ['getStaticText', 'static_text', c => c.getStaticText(), c => c.peekStaticText(), undefined],
    ['getGuidedFormDefinitions', 'guided_forms', c => c.getGuidedFormDefinitions(), c => c.peekGuidedFormDefinitions(), undefined],
    ['getGuidedFormSteps', 'guided_form_steps', c => c.getGuidedFormSteps(), c => c.peekGuidedFormSteps(), undefined],
    ['getStatuses', 'statuses', c => c.getStatuses('issue'), c => c.peekStatuses('issue'), 'issue'],
    ['getCategories', 'categories', c => c.getCategories('issue'), c => c.peekCategories('issue'), 'issue'],
  ];
  for (const [name, resource, call, peek, detail] of degrading) {
    it(`${name}: an error is reported to onError, resolves [] and the [] stays cached`, async () => {
      const errors: Array<[SchemaResource, unknown, string | undefined]> = [];
      const { transport, requests } = autoTransport(() => reply(500, { message: 'boom' }));
      const client = new SchemaClient({ transport, apiUrl: API, onError: (r, e, d) => errors.push([r, e, d]) });
      expect(await call(client)).toEqual([]);
      expect(await call(client)).toEqual([]);
      expect(peek(client)).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0][0]).toBe(resource);
      expect(errors[0][1]).toBeInstanceOf(DataClientError);
      expect(errors[0][2]).toBe(detail);
    });

    it(`${name}: a network failure also resolves []`, async () => {
      const errors: unknown[] = [];
      const { transport } = autoTransport(() => {
        throw new TransportError('network');
      });
      const client = new SchemaClient({ transport, apiUrl: API, onError: (_r, e) => errors.push(e) });
      expect(await call(client)).toEqual([]);
      expect(errors[0]).toBeInstanceOf(TransportError);
    });
  }

  it('works without an onError hook', async () => {
    const { transport } = autoTransport(() => reply(500, {}));
    expect(await new SchemaClient({ transport, apiUrl: API }).getConstraintMessages()).toEqual([]);
  });

  it('getEntityActions: an error resolves [], reports onError with the table, and the next call retries', async () => {
    const errors: Array<[SchemaResource, string | undefined]> = [];
    let n = 0;
    const { transport, requests } = autoTransport(() => (n++ === 0 ? reply(401, { message: 'JWT expired' }) : reply(200, [{ id: 1 }])));
    const client = new SchemaClient({ transport, apiUrl: API, onError: (r, _e, d) => errors.push([r, d]) });
    expect(await client.getEntityActions('issues')).toEqual([]);
    expect(await client.getEntityActions('issues')).toEqual([{ id: 1 }]);
    expect(requests).toHaveLength(2);
    expect(errors).toEqual([['entity_actions', 'issues']]);
  });

  it('checkVersions rejects when the request fails and leaves the recorded versions alone', async () => {
    const { transport } = autoTransport(() => reply(500, { message: 'down' }));
    const client = new SchemaClient({ transport, apiUrl: API, knownVersions: { entities: 'v1' } });
    await expect(client.checkVersions()).rejects.toBeInstanceOf(DataClientError);
    expect(client.getKnownVersions()).toEqual({ entities: 'v1' });
  });
});

describe('SchemaClient locale and identity keyed cache', () => {
  it('a locale switch issues new requests with the new Accept-Language, and switching back is served from cache', async () => {
    const { transport, requests } = autoTransport(req =>
      reply(200, [{ table_name: req.headers?.['Accept-Language'] ?? 'en' }]),
    );
    const client = new SchemaClient({ transport, apiUrl: API });
    const en = await client.getEntities();
    expect(en).toEqual([{ table_name: 'en' }]);

    client.use({ locale: 'es' });
    expect(client.peekEntities()).toBeUndefined();
    const es = await client.getEntities();
    expect(es).toEqual([{ table_name: 'es' }]);
    expect(requests.map(r => r.headers)).toEqual([undefined, { 'Accept-Language': 'es' }]);

    client.use({ locale: 'en' });
    expect(client.peekEntities()).toBe(en);
    expect(await client.getEntities()).toBe(en);
    client.use({ locale: 'es' });
    expect(await client.getEntities()).toBe(es);
    expect(requests).toHaveLength(2);
  });

  it('applies the locale to every resource, including the POST rpc calls and version checks', async () => {
    const { transport, requests } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API, locale: 'ar' });
    await client.getStatuses('issue');
    await client.getCategories('issue');
    await client.getEntityActions('issues');
    await client.checkVersions();
    expect(requests.every(r => r.headers?.['Accept-Language'] === 'ar')).toBe(true);
  });

  it('an identity switch uses a separate cache and request, and switching back is served from cache', async () => {
    let n = 0;
    const { transport, requests } = autoTransport(() => reply(200, [{ n: ++n }]));
    const client = new SchemaClient({ transport, apiUrl: API, identity: 'alice' });
    const alice = await client.getEntities();
    client.use({ identity: 'bob' });
    expect(client.context).toEqual({ identity: 'bob', locale: 'en' });
    expect(client.peekEntities()).toBeUndefined();
    const bob = await client.getEntities();
    expect(bob).not.toBe(alice);
    expect(requests).toHaveLength(2);
    client.use({ identity: 'alice' });
    expect(await client.getEntities()).toBe(alice);
    expect(requests).toHaveLength(2);
  });

  it('keys by the pair: same identity with another locale and same locale with another identity are separate', async () => {
    const { transport, requests } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API, identity: 'a', locale: 'en' });
    await client.getProperties();
    client.use({ locale: 'fr' });
    await client.getProperties();
    client.use({ identity: 'b' });
    await client.getProperties();
    client.use({ identity: 'a', locale: 'en' });
    await client.getProperties();
    expect(requests).toHaveLength(3);
  });

  it('does not confuse identities whose concatenation collides', async () => {
    const { transport, requests } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API, identity: 'a', locale: 'b,c' });
    await client.getProperties();
    client.use({ identity: 'a","b', locale: 'c' });
    await client.getProperties();
    expect(requests).toHaveLength(2);
  });

  it('a response that arrives after a switch lands in the context that requested it', async () => {
    const { transport, pending } = manualTransport();
    const client = new SchemaClient({ transport, apiUrl: API, identity: 'alice' });
    const aliceLoad = client.getEntities();
    client.use({ identity: 'bob' });
    expect(client.peekEntities()).toBeUndefined();
    pending[0].resolve(reply(200, [{ owner: 'alice' }]));
    await aliceLoad;
    expect(client.peekEntities()).toBeUndefined();
    expect(client.entitiesStore.getSnapshot()).toBeUndefined();
    client.use({ identity: 'alice' });
    expect(client.peekEntities()).toEqual([{ owner: 'alice' }]);
    expect(client.entitiesStore.getSnapshot()).toEqual([{ owner: 'alice' }]);
    expect(pending).toHaveLength(1);
  });

  it('use() with the current context changes nothing', async () => {
    const { transport, requests } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API, identity: 'a', locale: 'es' });
    const first = await client.getEntities();
    client.use({ identity: 'a', locale: 'es' });
    client.use({});
    expect(await client.getEntities()).toBe(first);
    expect(requests).toHaveLength(1);
  });

  it('clear() drops every context and discards responses still in flight', async () => {
    const { transport, pending } = manualTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    const inflight = client.getEntities();
    client.clear();
    pending[0].resolve(reply(200, [ENTITY]));
    await inflight;
    expect(client.peekEntities()).toBeUndefined();
    void client.getEntities();
    expect(pending).toHaveLength(2);
    pending[1].resolve(reply(200, [ENTITY]));
    await Promise.resolve();
    client.use({ locale: 'es' });
    client.clear();
    client.use({ locale: 'en' });
    expect(client.peekEntities()).toBeUndefined();
    expect(client.entitiesStore.getSnapshot()).toBeUndefined();
  });
});

describe('SchemaClient version refresh', () => {
  const v = (entities: string, properties: string, constraintMessages = 'c1', profile = 'p1') => [
    { cache_name: 'entities', version: entities },
    { cache_name: 'properties', version: properties },
    { cache_name: 'constraint_messages', version: constraintMessages },
    { cache_name: 'profile_extensions', version: profile },
  ];

  async function warm(client: SchemaClient) {
    await Promise.all([
      client.getEntities(),
      client.getProperties(),
      client.getM2mMetadata(),
      client.getConstraintMessages(),
      client.getStaticText(),
      client.getGuidedFormDefinitions(),
      client.getGuidedFormSteps(),
      client.getStatuses('issue'),
      client.getCategories('issue'),
    ]);
  }

  function peeks(client: SchemaClient) {
    return {
      entities: client.peekEntities() !== undefined,
      properties: client.peekProperties() !== undefined,
      m2m: client.peekM2mMetadata() !== undefined,
      constraintMessages: client.peekConstraintMessages() !== undefined,
      staticText: client.peekStaticText() !== undefined,
      guidedForms: client.peekGuidedFormDefinitions() !== undefined,
      guidedFormSteps: client.peekGuidedFormSteps() !== undefined,
      statuses: client.peekStatuses('issue') !== undefined,
      categories: client.peekCategories('issue') !== undefined,
    };
  }

  const ALL_WARM = {
    entities: true,
    properties: true,
    m2m: true,
    constraintMessages: true,
    staticText: true,
    guidedForms: true,
    guidedFormSteps: true,
    statuses: true,
    categories: true,
  };

  it('records the first versions without flagging a change', () => {
    const { transport } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    const result = client.applyVersions(v('e1', 'p1'));
    expect(result).toEqual({
      entitiesNeedsRefresh: false,
      propertiesNeedsRefresh: false,
      constraintMessagesNeedsRefresh: false,
      profileExtensionsNeedsRefresh: false,
      hasChanges: false,
    });
    expect(client.getKnownVersions()).toEqual({ entities: 'e1', properties: 'p1', constraint_messages: 'c1', profile_extensions: 'p1' });
  });

  it('an unchanged check invalidates nothing', async () => {
    const { transport } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    client.applyVersions(v('e1', 'p1'));
    await warm(client);
    expect(client.applyVersions(v('e1', 'p1')).hasChanges).toBe(false);
    expect(peeks(client)).toEqual(ALL_WARM);
  });

  it('a changed entities version invalidates only the entities', async () => {
    const { transport } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    client.applyVersions(v('e1', 'p1'));
    await warm(client);
    const result = client.applyVersions(v('e2', 'p1'));
    expect(result).toMatchObject({ entitiesNeedsRefresh: true, propertiesNeedsRefresh: false, hasChanges: true });
    expect(peeks(client)).toEqual({ ...ALL_WARM, entities: false });
  });

  it('a changed properties version invalidates properties and M:M metadata only', async () => {
    const { transport } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    client.applyVersions(v('e1', 'p1'));
    await warm(client);
    const result = client.applyVersions(v('e1', 'p2'));
    expect(result).toMatchObject({ entitiesNeedsRefresh: false, propertiesNeedsRefresh: true, hasChanges: true });
    expect(peeks(client)).toEqual({ ...ALL_WARM, properties: false, m2m: false });
  });

  it('both changed invalidates both groups and nothing else', async () => {
    const { transport } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    client.applyVersions(v('e1', 'p1'));
    await warm(client);
    client.applyVersions(v('e2', 'p2'));
    expect(peeks(client)).toEqual({ ...ALL_WARM, entities: false, properties: false, m2m: false });
  });

  it('reports constraint_messages and profile_extensions changes without invalidating (the guard ignores them)', async () => {
    const { transport } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    client.applyVersions(v('e1', 'p1'));
    await warm(client);
    const result = client.applyVersions(v('e1', 'p1', 'c2', 'p2'));
    expect(result).toMatchObject({
      entitiesNeedsRefresh: false,
      propertiesNeedsRefresh: false,
      constraintMessagesNeedsRefresh: true,
      profileExtensionsNeedsRefresh: true,
      hasChanges: true,
    });
    expect(peeks(client)).toEqual(ALL_WARM);
    client.invalidateConstraintMessages();
    expect(peeks(client)).toEqual({ ...ALL_WARM, constraintMessages: false });
  });

  it('a row missing from a response is not a change and keeps the recorded version', () => {
    const { transport } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    client.applyVersions(v('e1', 'p1'));
    expect(client.applyVersions([{ cache_name: 'properties', version: 'p1' }]).hasChanges).toBe(false);
    expect(client.getKnownVersions()['entities']).toBe('e1');
    expect(client.applyVersions(v('e2', 'p1')).entitiesNeedsRefresh).toBe(true);
  });

  it('records the new version after a change, so the same version does not flag twice', () => {
    const { transport } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    client.applyVersions(v('e1', 'p1'));
    expect(client.applyVersions(v('e2', 'p1')).entitiesNeedsRefresh).toBe(true);
    expect(client.applyVersions(v('e2', 'p1')).entitiesNeedsRefresh).toBe(false);
  });

  it('knownVersions seeds the comparison', () => {
    const { transport } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API, knownVersions: { entities: 'e1' } });
    expect(client.applyVersions(v('e2', 'p1')).entitiesNeedsRefresh).toBe(true);
  });

  it('invalidates every cached context, not only the current one', async () => {
    const { transport, requests } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API, locale: 'en' });
    client.applyVersions(v('e1', 'p1'));
    await client.getEntities();
    client.use({ locale: 'es' });
    await client.getEntities();
    expect(requests).toHaveLength(2);
    client.applyVersions(v('e2', 'p1'));
    expect(client.peekEntities()).toBeUndefined();
    client.use({ locale: 'en' });
    expect(client.peekEntities()).toBeUndefined();
    await client.getEntities();
    expect(requests).toHaveLength(3);
  });

  it('checkVersions fetches schema_cache_versions and applies the result', async () => {
    let round = 0;
    const { transport, requests } = autoTransport(req =>
      relative(req) === 'schema_cache_versions' ? reply(200, round++ === 0 ? v('e1', 'p1') : v('e2', 'p1')) : reply(200, [ENTITY]),
    );
    const client = new SchemaClient({ transport, apiUrl: API });
    await client.getEntities();
    expect((await client.checkVersions()).hasChanges).toBe(false);
    expect(client.peekEntities()).toEqual([ENTITY]);
    const second = await client.checkVersions();
    expect(second.entitiesNeedsRefresh).toBe(true);
    expect(client.peekEntities()).toBeUndefined();
    expect(requests.map(relative)).toEqual(['schema_entities', 'schema_cache_versions', 'schema_cache_versions']);
  });

  it('a response in flight when its resource is invalidated is returned to its callers but not cached', async () => {
    const { transport, pending } = manualTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    const stale = client.getProperties();
    client.invalidateProperties();
    pending[0].resolve(reply(200, [{ version: 'old' }]));
    expect(await stale).toEqual([{ version: 'old' }]);
    expect(client.peekProperties()).toBeUndefined();
    const fresh = client.getProperties();
    expect(pending).toHaveLength(2);
    pending[1].resolve(reply(200, [{ version: 'new' }]));
    expect(await fresh).toEqual([{ version: 'new' }]);
    expect(client.peekProperties()).toEqual([{ version: 'new' }]);
  });

  it('a failure of an invalidated in-flight request does not poison the replacement request', async () => {
    const { transport, pending } = manualTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    const stale = client.getEntities().catch(e => e);
    client.invalidateEntities();
    const fresh = client.getEntities();
    expect(pending).toHaveLength(2);
    pending[0].resolve(reply(500, {}));
    expect(await stale).toBeInstanceOf(DataClientError);
    void client.getEntities();
    expect(pending).toHaveLength(2);
    pending[1].resolve(reply(200, [ENTITY]));
    expect(await fresh).toEqual([ENTITY]);
  });
});

describe('SchemaClient entitiesStore', () => {
  it('starts undefined, publishes the loaded entities once, and keeps a stable snapshot', async () => {
    const { transport } = autoTransport(() => reply(200, [ENTITY]));
    const client = new SchemaClient({ transport, apiUrl: API });
    const store = client.entitiesStore;
    expect(store.getSnapshot()).toBeUndefined();
    let notifications = 0;
    store.subscribe(() => notifications++);
    const loaded = await client.getEntities();
    expect(store.getSnapshot()).toBe(loaded);
    expect(notifications).toBe(1);
    await client.getEntities();
    expect(store.getSnapshot()).toBe(loaded);
    expect(notifications).toBe(1);
    expect(client.entitiesStore).toBe(store);
  });

  it('concurrent callers cause one notification', async () => {
    const { transport } = autoTransport(() => reply(200, [ENTITY]));
    const client = new SchemaClient({ transport, apiUrl: API });
    let notifications = 0;
    client.entitiesStore.subscribe(() => notifications++);
    await Promise.all([client.getEntities(), client.getEntities(), client.getEntities()]);
    expect(notifications).toBe(1);
  });

  it('follows the active context and returns to undefined on invalidation', async () => {
    const { transport } = autoTransport(req => reply(200, [{ locale: req.headers?.['Accept-Language'] ?? 'en' }]));
    const client = new SchemaClient({ transport, apiUrl: API });
    const seen: unknown[] = [];
    client.entitiesStore.subscribe(() => seen.push(client.entitiesStore.getSnapshot()));
    const en = await client.getEntities();
    client.use({ locale: 'es' });
    const es = await client.getEntities();
    client.use({ locale: 'en' });
    expect(client.entitiesStore.getSnapshot()).toBe(en);
    client.invalidateEntities();
    expect(client.entitiesStore.getSnapshot()).toBeUndefined();
    expect(seen).toEqual([en, undefined, es, en, undefined]);
  });

  it('does not notify for a switch between two cold contexts', () => {
    const { transport } = autoTransport();
    const client = new SchemaClient({ transport, apiUrl: API });
    let notifications = 0;
    client.entitiesStore.subscribe(() => notifications++);
    client.use({ locale: 'es' });
    client.use({ identity: 'bob' });
    expect(notifications).toBe(0);
  });

  it('is not updated by a failed load, and a stopped subscriber is not called', async () => {
    const { transport } = autoTransport(() => reply(500, {}));
    const client = new SchemaClient({ transport, apiUrl: API });
    let notifications = 0;
    const off = client.entitiesStore.subscribe(() => notifications++);
    await client.getEntities().catch(() => undefined);
    expect(notifications).toBe(0);
    off();
    expect(client.entitiesStore.getSnapshot()).toBeUndefined();
  });
});
