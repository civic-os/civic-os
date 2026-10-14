/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRun, MaskContext, timestampInstants } from './normalize.mjs';
import { compareRuns } from './compare.mjs';

const T0 = Date.parse('2026-10-20T09:30:00-04:00');
const REAL = Date.parse('2026-10-13T22:00:00Z');

function raw(requests, extra = {}) {
  return {
    test: '01 flow',
    clockT0: T0,
    realStart: REAL,
    realEnd: REAL + 60_000,
    steps: [{ name: 's1', kind: 'step' }, { name: 's2', kind: 'step' }],
    registered: [],
    ...extra,
    requests: requests.map((r, i) => ({
      seq: i + 1,
      step: 's1',
      kind: 'postgrest',
      method: 'GET',
      headers: { authorization: 'Bearer eyJhbGciOi.eyJzdWIiOi.sig', accept: 'application/json' },
      postData: null,
      status: 200,
      failure: null,
      createdIds: [],
      ...r,
    })),
  };
}

const FKS = [
  { table_name: 'issue_tags', column_name: 'issue_id', join_table: 'Issue' },
  { table_name: 'issue_tags', column_name: 'tag_id', join_table: 'Tag' },
  { table_name: 'WorkDetail', column_name: 'issue', join_table: 'Issue' },
  { table_name: 'notes', column_name: 'author_id', join_table: 'civic_os_users' },
];

function run(requests, extra) {
  return normalizeRun([raw(requests, extra)], FKS)[0];
}

test('query params are decoded and order-insensitive at the semantic level', () => {
  const a = run([{ url: 'http://localhost:3000/Issue?select=id,display_name&order=id.desc&limit=10' }]);
  const b = run([{ url: 'http://localhost:3000/Issue?limit=10&order=id.desc&select=id%2Cdisplay_name' }]);
  const sa = a.steps[0].postgrest[0];
  const sb = b.steps[0].postgrest[0];
  assert.deepEqual({ ...sa, raw: null }, { ...sb, raw: null });
  assert.notDeepEqual(sa.raw, sb.raw);
});

test('raw-only difference is a warning, a select change is a failure naming the request', () => {
  const base = { meta: { harness: '1' }, flows: new Map([['01-flow', run([{ url: 'http://localhost:3000/Issue?select=id,display_name&limit=10' }])]]) };
  const reordered = { meta: { harness: '1' }, flows: new Map([['01-flow', run([{ url: 'http://localhost:3000/Issue?limit=10&select=id,display_name' }])]]) };
  const changed = { meta: { harness: '1' }, flows: new Map([['01-flow', run([{ url: 'http://localhost:3000/Issue?select=id,display_name,status&limit=10' }])]]) };
  const r1 = compareRuns(base, reordered);
  assert.equal(r1.failures.length, 0);
  assert.equal(r1.warnings.length, 1);
  const r2 = compareRuns(base, changed);
  assert.equal(r2.failures.length, 1);
  assert.match(r2.failures[0], /step "s1"[\s\S]*CHANGED GET \/Issue[\s\S]*query\.select/);
});

test('created ids are tokenized only where the position refers to their table', () => {
  const doc = run([
    { method: 'POST', url: 'http://localhost:3000/Issue', postData: '{"display_name":"A","severity_level":13}', status: 201, createdIds: [{ table: 'Issue', id: '13' }] },
    { url: 'http://localhost:3000/Issue?id=eq.13&limit=13' },
    { url: 'http://localhost:3000/WorkDetail?issue=eq.13&id=eq.13' },
    { method: 'POST', url: 'http://localhost:3000/issue_tags', postData: '[{"issue_id":13,"tag_id":13}]', status: 201 },
    { method: 'POST', url: 'http://localhost:3000/rpc/request_upload_url', postData: '{"p_entity_type":"Issue","p_entity_id":"13"}' },
    { method: 'POST', url: 'http://localhost:3000/rpc/approve', postData: '{"p_entity_id":13}', frameUrl: 'http://localhost:4200/view/Issue/13' },
    { method: 'POST', url: 'http://localhost:3000/rpc/other', postData: '{"p_entity_id":13}', frameUrl: 'http://localhost:4200/view/Tag/13' },
  ]);
  const s = JSON.stringify(doc.steps[0].postgrest);
  assert.match(s, /"id":"eq.<Issue:1>","limit":"13"/);
  assert.match(s, /"severity_level":13/);
  assert.match(s, /"issue":"eq.<Issue:1>"/);
  assert.match(s, /"id":"eq.13","issue"/, 'WorkDetail.id 13 is not a created WorkDetail');
  assert.match(s, /"issue_id":"<Issue:1>","tag_id":13/);
  assert.match(s, /"p_entity_id":"<Issue:1>","p_entity_type":"Issue"/);
  assert.match(s, /\/rpc\/approve.*"p_entity_id":"<Issue:1>"/);
  assert.match(s, /\/rpc\/other.*"p_entity_id":13/);
});

test('in-lists and or-filters mask registered ids of the right table', () => {
  const doc = run([
    { url: 'http://localhost:3000/Issue?id=in.(7,8,99)' },
    { url: 'http://localhost:3000/notes?or=(issue.eq.7,author_id.eq.7)' },
  ], { registered: [{ step: 's1', table: 'Issue', ids: ['7', '8'] }] });
  const s = JSON.stringify(doc.steps[0].postgrest.map((e) => e.query));
  assert.match(s, /in\.\(<Issue:\d>,<Issue:\d>,99\)/);
  assert.match(s, /issue\.eq\.7,author_id\.eq\.7/, 'notes has no FK map entry for issue; nothing masked');
});

test('UUID tokens do not depend on arrival order of parallel requests', () => {
  const u1 = '11111111-1111-4111-8111-111111111111';
  const u2 = '22222222-2222-4222-8222-222222222222';
  const a = run([{ url: `http://localhost:3000/files?id=eq.${u1}&select=a` }, { url: `http://localhost:3000/files?id=eq.${u2}&select=b` }]);
  const b = run([{ url: `http://localhost:3000/files?id=eq.${u2}&select=b` }, { url: `http://localhost:3000/files?id=eq.${u1}&select=a` }]);
  assert.deepEqual(a, b);
});

test('runtime timestamps are masked, typed far-away values stay exact', () => {
  const doc = run([
    {
      method: 'PATCH',
      url: 'http://localhost:3000/Issue?id=eq.1',
      postData: JSON.stringify({ reviewed_at: '2026-10-20T13:31:05.123Z', quote_due_date: '2031-03-14T18:30:00.000Z', when: '2026-10-13T22:00:30+00:00', day: '2026-10-20' }),
    },
  ]);
  const body = doc.steps[0].postgrest[0].body;
  assert.equal(body.reviewed_at, '<runtime-ts>');
  assert.equal(body.when, '<runtime-ts>');
  assert.equal(body.quote_due_date, '2031-03-14T18:30:00.000Z');
  assert.equal(body.day, '2026-10-20');
});

test('zone-less wall clock values near the fake clock are treated as runtime', () => {
  const ctx = new MaskContext({ registered: [], windows: [[T0, T0 + 60_000]] });
  assert.ok(ctx.inWindow(timestampInstants('2026-10-20T09:30:10')));
  assert.ok(!ctx.inWindow(timestampInstants('2031-03-14T14:30')));
});

test('polling allowlist collapses to >=1 and JWT/authorization are reduced to presence', () => {
  const doc = run([
    { url: 'http://localhost:3000/schema_cache_versions' },
    { url: 'http://localhost:3000/schema_cache_versions' },
    { url: 'http://localhost:3000/schema_cache_versions' },
  ]);
  assert.equal(doc.steps[0].postgrest.length, 1);
  assert.equal(doc.steps[0].postgrest[0].n, '>=1');
  assert.equal(doc.steps[0].postgrest[0].headers.authorization, 'Bearer <present>');
});

test('keycloak calls are counted, minio paths masked', () => {
  const doc = run([
    { kind: 'keycloak', method: 'POST', url: 'http://localhost:8082/realms/civic-os-dev/protocol/openid-connect/token' },
    { kind: 'keycloak', method: 'GET', url: 'http://localhost:8082/resources/x.css' },
    { kind: 'minio', method: 'PUT', url: 'http://localhost:9000/civic-os-files/Issue/5/aaaaaaaa-1111-4111-8111-111111111111/a.png?X-Amz-Signature=abc' },
  ], { registered: [{ step: 's1', table: 'Issue', ids: ['5'] }] });
  const s = doc.steps[0];
  assert.deepEqual(s.keycloak, { 'POST /realms/civic-os-dev/protocol/openid-connect/token': 1 });
  assert.deepEqual(s.minio, ['PUT /civic-os-files/Issue/<Issue:1>/<uuid:1>/a.png -> 200']);
});
