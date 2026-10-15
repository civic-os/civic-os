/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRun, MaskContext, timestampInstant, COLLAPSE_RULES } from './normalize.mjs';
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

function run(requests, extra, users = []) {
  return normalizeRun([raw(requests, extra)], FKS, [], users)[0];
}

/** compareRuns over two one-flow runs built from request lists. */
function cmp(baseRequests, currentRequests, extra, users = []) {
  const B = { meta: { harness: '2' }, flows: new Map([['f', run(baseRequests, extra, users)]]) };
  const C = { meta: { harness: '2' }, flows: new Map([['f', run(currentRequests, extra, users)]]) };
  return compareRuns(B, C);
}

/** A masking context with both run windows and a custom runtime-timestamp allowlist. */
function maskWith(runtimeTsFields) {
  return new MaskContext({ registered: [], windows: [[T0, T0 + 60_000], [REAL, REAL + 60_000]], runtimeTsFields });
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

test('polymorphic entity_id follows its entity_type sibling', () => {
  const doc = run([
    { url: 'http://localhost:3000/entity_notes?entity_id=eq.9&entity_type=eq.Issue&select=id' },
    { url: 'http://localhost:3000/entity_notes?entity_id=eq.9&entity_type=eq.Tag&select=id' },
    { method: 'POST', url: 'http://localhost:3000/entity_notes', postData: '{"entity_type":"Issue","entity_id":9}' },
  ], { registered: [{ step: 's1', table: 'Issue', ids: ['9'] }] });
  const s = JSON.stringify(doc.steps[0].postgrest);
  assert.match(s, /"entity_id":"eq.<Issue:1>","entity_type":"eq.Issue"/);
  assert.match(s, /"entity_id":"eq.9","entity_type":"eq.Tag"/);
  assert.match(s, /"entity_id":"<Issue:1>","entity_type":"Issue"/);
});

test('object keys embedding a created record id are masked', () => {
  const doc = run([
    { method: 'POST', url: 'http://localhost:3000/rpc/create_file_record', postData: '{"p_s3_original_key":"Issue/13/aaaaaaaa-1111-4111-8111-111111111111/original.png","other":"Tag/13/aaaaaaaa-1111-4111-8111-111111111111/x"}' },
  ], { registered: [{ step: 's1', table: 'Issue', ids: ['13'] }] });
  const b = doc.steps[0].postgrest[0].body;
  assert.equal(b.p_s3_original_key, 'Issue/<Issue:1>/<uuid:1>/original.png');
  assert.equal(b.other, 'Tag/13/<uuid:1>/x');
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

test('no field is declared for run-time timestamps, so in-window values stay exact', () => {
  const doc = run([
    {
      method: 'PATCH',
      url: 'http://localhost:3000/Issue?id=eq.1',
      postData: JSON.stringify({ reviewed_at: '2026-10-20T13:31:05.123Z', quote_due_date: '2031-03-14T18:30:00.000Z', when: '2026-10-13T22:00:30+00:00', day: '2026-10-20' }),
    },
  ]);
  const body = doc.steps[0].postgrest[0].body;
  assert.equal(body.reviewed_at, '2026-10-20T13:31:05.123Z');
  assert.equal(body.when, '2026-10-13T22:00:30+00:00');
  assert.equal(body.quote_due_date, '2031-03-14T18:30:00.000Z');
  assert.equal(body.day, '2026-10-20');
});

test('verifier probe R2: a now-derived wall-clock value sent with UTC digits is a diff', () => {
  // Client "now" on the fake clock is 09:31 EDT; the regression sends 13:31 (UTC digits) into a timestamp column.
  const r = cmp(
    [{ method: 'PATCH', url: 'http://localhost:3000/X?id=eq.1', postData: '{"reviewed_at":"2026-10-20T09:31:00"}' }],
    [{ method: 'PATCH', url: 'http://localhost:3000/X?id=eq.1', postData: '{"reviewed_at":"2026-10-20T13:31:00"}' }],
  );
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /CHANGED PATCH \/X[\s\S]*body/);
  // A format change of a zoned run-time value (Z vs offset) is a diff too.
  const r2 = cmp(
    [{ method: 'PATCH', url: 'http://localhost:3000/X?id=eq.1', postData: '{"t":"2026-10-20T13:31:00.000Z"}' }],
    [{ method: 'PATCH', url: 'http://localhost:3000/X?id=eq.1', postData: '{"t":"2026-10-20T09:31:00-04:00"}' }],
  );
  assert.equal(r2.failures.length, 1);
});

test('a declared field masks only its own format, inside a run window, keeping the shape', () => {
  const ctx = maskWith([{ field: 'reviewed_at', format: 'wall' }, { field: 't', format: 'zoned' }]);
  const T0_WALL = '2026-10-20T09:30:40'; // T0 + 40 s as New York wall clock
  assert.equal(ctx.runtimeTimestamp('reviewed_at', T0_WALL), '<runtime-ts:dddd-dd-ddTdd:dd:dd>');
  // The same instant with UTC digits is 4 h outside the window when read as New York wall time.
  assert.equal(ctx.runtimeTimestamp('reviewed_at', '2026-10-20T13:30:40'), null);
  // Wrong format for the field: not masked.
  assert.equal(ctx.runtimeTimestamp('reviewed_at', '2026-10-20T13:30:40Z'), null);
  assert.equal(ctx.runtimeTimestamp('t', T0_WALL), null);
  // Zoned values keep their zone designator and precision in the token.
  assert.equal(ctx.runtimeTimestamp('t', '2026-10-20T13:30:40.123Z'), '<runtime-ts:dddd-dd-ddTdd:dd:dd.dddZ>');
  assert.equal(ctx.runtimeTimestamp('t', '2026-10-20T09:30:40-04:00'), '<runtime-ts:dddd-dd-ddTdd:dd:dd-04:00>');
  // Undeclared field, or a typed value far from both windows: exact.
  assert.equal(ctx.runtimeTimestamp('other', T0_WALL), null);
  assert.equal(ctx.runtimeTimestamp('reviewed_at', '2031-03-14T14:30'), null);
  // The real wall-clock window covers server now() values.
  assert.equal(ctx.runtimeTimestamp('t', '2026-10-13T22:00:30+00:00'), '<runtime-ts:dddd-dd-ddTdd:dd:dd+00:00>');
});

test('declared run-time fields are masked in bodies and query params; two runs a few seconds apart compare equal', () => {
  const fields = [{ field: 'reviewed_at', format: 'zoned' }];
  const mk = (ts) => normalizeRun([raw([
    { method: 'PATCH', url: `http://localhost:3000/X?id=eq.1&reviewed_at=gte.${encodeURIComponent(ts)}`, postData: JSON.stringify({ reviewed_at: ts }) },
  ])], FKS, [], [])[0];
  // normalizeRun uses the module allowlist (empty); exercise the masking context directly.
  const ctx = new MaskContext({ registered: [], windows: [[T0, T0 + 60_000]], runtimeTsFields: fields });
  const a = ctx.maskBody({ reviewed_at: '2026-10-20T13:30:05.000Z', note: '2026-10-20T13:30:05.000Z' }, { table: 'X' });
  assert.deepEqual(a, { note: '2026-10-20T13:30:05.000Z', reviewed_at: '<runtime-ts:dddd-dd-ddTdd:dd:dd.dddZ>' });
  assert.equal(ctx.maskQueryValue({ table: 'X' }, 'reviewed_at', 'gte.2026-10-20T13:30:05.000Z'), 'gte.<runtime-ts:dddd-dd-ddTdd:dd:dd.dddZ>');
  assert.equal(ctx.maskRawQuery('?reviewed_at=gte.2026-10-20T13%3A30%3A05.000Z&id=eq.1', { table: 'X' }), '?reviewed_at=gte.<runtime-ts:dddd-dd-ddTdd:dd:dd.dddZ>&id=eq.1');
  // Without the declaration the module default keeps both values exact.
  assert.equal(mk('2026-10-20T13:30:05.000Z').steps[0].postgrest[0].body.reviewed_at, '2026-10-20T13:30:05.000Z');
});

test('zone-less values are read as New York wall-clock time, across a DST transition', () => {
  assert.equal(timestampInstant('2026-10-20T09:30:10'), T0 + 10_000);
  assert.equal(timestampInstant('2026-10-20 09:30:10'), T0 + 10_000);
  assert.equal(timestampInstant('2026-10-20T13:30:10Z'), T0 + 10_000);
  assert.equal(timestampInstant('2026-10-20T09:30:10-0400'), T0 + 10_000);
  // Winter (EST, UTC-5) and summer (EDT, UTC-4).
  assert.equal(timestampInstant('2026-01-15T07:00'), Date.parse('2026-01-15T12:00:00Z'));
  assert.equal(timestampInstant('2026-07-15T08:00'), Date.parse('2026-07-15T12:00:00Z'));
  assert.equal(timestampInstant('2026-10-20'), null, 'a date without a time is never a run-time timestamp');
});

test('2xx and app-cancelled requests share a status class; errors stay exact', () => {
  const doc = run([
    { url: 'http://localhost:3000/a', status: 200 },
    { url: 'http://localhost:3000/b', status: null, failure: 'net::ERR_ABORTED' },
    { url: 'http://localhost:3000/c', status: 404 },
    { url: 'http://localhost:3000/d', status: 206 },
  ]);
  const st = Object.fromEntries(doc.steps[0].postgrest.map((e) => [e.path, e.status]));
  assert.deepEqual(st, { '/a': '2xx|cancelled', '/b': '2xx|cancelled', '/c': 404, '/d': '2xx|cancelled' });
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

// ---------------------------------------------------------------------------
// Created ids and user ids name one specific row / user (verifier probes R1, R1b)
// ---------------------------------------------------------------------------

const SEVEN_ISSUES = { registered: [{ step: 'setup', table: 'Issue', ids: ['101', '102', '103', '104', '105', '106', '107'] }] };

test('verifier probe R1: opening created row 106 instead of 105 is a diff', () => {
  const r = cmp([{ url: 'http://localhost:3000/Issue?id=eq.105&select=id' }], [{ url: 'http://localhost:3000/Issue?id=eq.106&select=id' }], SEVEN_ISSUES);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /query\.id:\s+baseline: eq\.<Issue:5>\s+current:  eq\.<Issue:6>/);
});

test('created ids are numbered per table in creation order, whatever order requests were recorded in', () => {
  const doc = run([
    { url: 'http://localhost:3000/Issue?id=eq.107&select=id' },
    { url: 'http://localhost:3000/Issue?id=in.(103,101)' },
  ], SEVEN_ISSUES);
  const q = doc.steps[0].postgrest.map((e) => e.query.id).sort();
  assert.deepEqual(q, ['eq.<Issue:7>', 'in.(<Issue:3>,<Issue:1>)']);
  // Ids from insert responses (createdIds) and from registerIds() share one numbering,
  // and a response recorded later but holding a smaller id still ranks first.
  const doc2 = run([
    { method: 'POST', url: 'http://localhost:3000/Issue', postData: '{"display_name":"b"}', createdIds: [{ table: 'Issue', id: '21' }] },
    { method: 'POST', url: 'http://localhost:3000/Issue', postData: '{"display_name":"a"}', createdIds: [{ table: 'Issue', id: '20' }] },
    { url: 'http://localhost:3000/Issue?id=eq.21' },
    { url: 'http://localhost:3000/Issue?id=eq.9' },
  ], { registered: [{ step: 's1', table: 'Issue', ids: ['9'] }] });
  const ids = doc2.steps[0].postgrest.filter((e) => e.method === 'GET').map((e) => e.query.id).sort();
  assert.deepEqual(ids, ['eq.<Issue:1>', 'eq.<Issue:3>']);
});

test('verifier probe R1b: a different role user is a diff; role users are named by role', () => {
  const A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const B = 'bbbbbbbb-2222-4222-8222-222222222222';
  const users = [{ role: 'testadmin', id: A }, { role: 'testeditor', id: B }];
  const doc = run([{ method: 'POST', url: 'http://localhost:3000/Issue', postData: `{"created_user":"${A.toUpperCase()}"}` }], {}, users);
  assert.equal(doc.steps[0].postgrest[0].body.created_user, '<user:testadmin>');
  const r = cmp(
    [{ method: 'POST', url: 'http://localhost:3000/Issue', postData: `{"created_user":"${A}"}` }, { url: `http://localhost:3000/civic_os_users?id=eq.${A}` }],
    [{ method: 'POST', url: 'http://localhost:3000/Issue', postData: `{"created_user":"${B}"}` }, { url: `http://localhost:3000/civic_os_users?id=eq.${B}` }],
    {}, users,
  );
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /<user:testadmin>[\s\S]*<user:testeditor>/);
});

test('remaining limit: two other UUIDs that each appear once still share a token position', () => {
  // UUIDs that are neither role users nor created ids (file ids, upload request ids) are
  // numbered by first appearance; swapping one never seen elsewhere for another stays equal.
  const r = cmp(
    [{ method: 'POST', url: 'http://localhost:3000/Issue', postData: '{"photo":"aaaaaaaa-1111-4111-8111-111111111111"}' }],
    [{ method: 'POST', url: 'http://localhost:3000/Issue', postData: '{"photo":"bbbbbbbb-2222-4222-8222-222222222222"}' }],
  );
  assert.equal(r.failures.length, 0);
});

// ---------------------------------------------------------------------------
// Requests outside any step
// ---------------------------------------------------------------------------

test('a request that starts between two steps is UNATTRIBUTED and fails the compare', () => {
  const base = [{ url: 'http://localhost:3000/Tag?select=id' }];
  const current = [
    { url: 'http://localhost:3000/Tag?select=id' },
    { url: 'http://localhost:3000/Issue?select=id', step: '(between steps)', stepKind: 'gap', afterStep: 's1' },
  ];
  const doc = run(current);
  assert.equal(doc.unattributed.length, 1);
  assert.equal(doc.unattributed[0].where, '(after step "s1")');
  assert.equal(doc.unattributed[0].postgrest[0].path, '/Issue');
  const r = cmp(base, current);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /UNATTRIBUTED requests in the current run[\s\S]*\(after step "s1"\) n=1: GET \/Issue\?select=id/);
  // A baseline that somehow holds one fails too, even against an identical run.
  assert.equal(cmp(current, current).failures.length, 2);
});

test('requests before the first step are UNATTRIBUTED; setup-step and Keycloak traffic is not', () => {
  const doc = run([
    { url: 'http://localhost:3000/Tag?select=id', step: '(before first step)', stepKind: 'pre' },
    { url: 'http://localhost:3000/Issue?select=id', step: 'setup: seed', stepKind: 'setup' },
    { kind: 'keycloak', method: 'POST', url: 'http://localhost:8082/realms/civic-os-dev/protocol/openid-connect/token', step: '(between steps)', stepKind: 'gap', afterStep: 's1' },
  ]);
  assert.equal(doc.unattributed.length, 1);
  assert.equal(doc.unattributed[0].where, '(before the first step)');
  assert.deepEqual(doc.unattributed[0].postgrest.map((e) => e.path), ['/Tag']);
  assert.equal(run([{ url: 'http://localhost:3000/Tag' }]).unattributed, undefined);
});

// ---------------------------------------------------------------------------
// Collapse rules
// ---------------------------------------------------------------------------

test('the two file polls collapse in their exact shapes only; every other /files GET is counted exactly', () => {
  const u = 'cccccccc-3333-4333-8333-333333333333';
  const poll = { url: `http://localhost:3000/files?id=eq.${u}&select=thumbnail_status` };
  const doc = run([poll, poll, poll]);
  assert.equal(doc.steps[0].postgrest.length, 1);
  assert.equal(doc.steps[0].postgrest[0].n, '>=1');
  // FileThumbnailComponent polls getFile() (full row) while a thumbnail is pending, so that
  // shape collapses too. Accepted limit (verifier probe R3): 4 such GETs instead of 1 compare equal.
  const full = { url: `http://localhost:3000/files?id=eq.${u}` };
  assert.equal(cmp([full], [full, full, full, full]).failures.length, 0);
  // Anything else stays exact.
  const sel = { url: `http://localhost:3000/files?id=eq.${u}&select=id,file_name` };
  const r = cmp([sel], [sel, sel]);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /COUNT GET \/files\?id=eq\.<uuid:1>&select=id,file_name.*baseline n=1, current n=2/);
  const status = COLLAPSE_RULES.find((c) => c.name === 'file thumbnail_status polling');
  const getFile = COLLAPSE_RULES.find((c) => c.name === 'file thumbnail component polling (getFile)');
  const entry = (query) => ({ method: 'GET', path: '/files', query });
  assert.ok(status.test(entry({ id: 'eq.<uuid:1>', select: 'thumbnail_status' })));
  assert.ok(!status.test(entry({ id: 'eq.<uuid:1>', select: 'id,thumbnail_status' })));
  assert.ok(!status.test(entry({ select: 'thumbnail_status' })));
  assert.ok(!status.test(entry({ id: 'in.(<uuid:1>)', select: 'thumbnail_status' })));
  assert.ok(getFile.test(entry({ id: 'eq.<uuid:1>' })));
  assert.ok(!getFile.test(entry({ id: 'eq.<uuid:1>', order: 'id' })));
  assert.ok(!getFile.test(entry({ id: 'eq.7' })), 'only a single file id (UUID) qualifies');
  assert.ok(!getFile.test(entry({ id: 'in.(<uuid:1>,<uuid:2>)' })));
  assert.ok(!getFile.test({ method: 'DELETE', path: '/files', query: { id: 'eq.<uuid:1>' } }));
});
