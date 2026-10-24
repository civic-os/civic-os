/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Self-tests for scripts/golden/interpreter-diff.mjs.
 *
 *   node --test scripts/golden/interpreter-diff.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareDocs, globToRegExp } from './interpreter-diff.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'interpreter-diff.mjs');
const D = { decision: 'keep', detail: 'One sentence.', by: 'Daniel', date: '2026-10-24' };

/** A temp workspace: frontend/ and mcp/ trees, a two-row ledger (E-01 decided, E-02 undecided) and a manifest. */
function workspace({ frontend = {}, mcp = {}, manifest = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'interp-'));
  const put = (dir, files) => {
    for (const [rel, content] of Object.entries(files)) {
      const f = join(root, dir, rel);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
    }
  };
  put('frontend', frontend);
  put('mcp', mcp);
  writeFileSync(join(root, 'ledger.json'), JSON.stringify({ rows: [{ id: 'E-01', decision: null }, { id: 'E-02', decision: null }] }));
  writeFileSync(join(root, 'decisions.json'), JSON.stringify({ 'E-01': D }));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  const run = (extra = []) => {
    const r = spawnSync(process.execPath, [
      SCRIPT, '--manifest', join(root, 'manifest.json'), '--frontend', join(root, 'frontend'), '--mcp', join(root, 'mcp'),
      '--ledger', join(root, 'ledger.json'), '--decisions', join(root, 'decisions.json'), ...extra,
    ], { encoding: 'utf8' });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  return { root, run };
}

const policy = (over = {}) => ({ row: 'E-01', file: 'a.json', pointer: '^/msg$', reason: 'wording', ...over });

test('only keys present on both sides are compared; one-sided keys count as shapeOnly', () => {
  const r = compareDocs({ a: 1, onlyFe: 2, nested: { x: 1, f: 1 } }, { a: 1, onlyMcp: 3, nested: { x: 1, m: 1, m2: 2 } });
  assert.equal(r.compared, 2);
  assert.equal(r.shapeOnly, 1 + 1 + 1 + 2);
  assert.deepEqual(r.diffs, []);
});

test('a differing shared key is a difference at its JSON pointer, with ~ and / escaped', () => {
  const r = compareDocs({ 'a/b': { 'c~d': 1 } }, { 'a/b': { 'c~d': 2 } });
  assert.deepEqual(r.diffs.map((d) => [d.pointer, d.frontend, d.mcp]), [['/a~1b/c~0d', 1, 2]]);
});

test('arrays of objects match by identity key even when the order differs', () => {
  const r = compareDocs(
    { p: [{ column_name: 'a', v: 1 }, { column_name: 'b', v: 2 }] },
    { p: [{ column_name: 'b', v: 2 }, { column_name: 'a', v: 1 }] },
  );
  assert.deepEqual(r.diffs, []);
  assert.equal(r.compared, 4, 'column_name and v of each element');
});

test('identity keys are tried in order and a difference is reported under the id', () => {
  const r = compareDocs({ q: [{ name: 'x', id: 1, v: 1 }] }, { q: [{ name: 'x', id: 2, v: 1 }] });
  assert.deepEqual(r.diffs.map((d) => d.pointer), ['/q/x/id']);
});

test('arrays without a shared identity key match by index', () => {
  const r = compareDocs({ p: [{ v: 1 }, { v: 2 }] }, { p: [{ v: 2 }, { v: 1 }] });
  assert.deepEqual(r.diffs.map((d) => d.pointer), ['/p/0/v', '/p/1/v']);
  // duplicate ids on one side also fall back to index
  const dup = compareDocs({ p: [{ id: 1, v: 1 }, { id: 1, v: 2 }] }, { p: [{ id: 1, v: 1 }, { id: 2, v: 2 }] });
  assert.deepEqual(dup.diffs.map((d) => d.pointer), ['/p/1/id']);
});

test('an element on one side only is a difference at <array>/<id or index>', () => {
  const byId = compareDocs({ p: [{ key: 'a' }, { key: 'b' }] }, { p: [{ key: 'a' }] });
  assert.deepEqual(byId.diffs.map((d) => [d.pointer, d.kind]), [['/p/b', 'missing']]);
  const byIndex = compareDocs({ p: [{ v: 1 }] }, { p: [{ v: 1 }, { v: 2 }] });
  assert.deepEqual(byIndex.diffs.map((d) => [d.pointer, d.kind]), [['/p/1', 'missing']]);
});

test('arrays of scalars and other leaves use deep equality; a type mismatch is a difference', () => {
  const r = compareDocs({ s: [1, 2], t: 'x', u: { k: 1 } }, { s: [1, 3], t: 'x', u: [1] });
  assert.deepEqual(r.diffs.map((d) => [d.pointer, d.kind]), [['/s', 'value'], ['/u', 'type']]);
  assert.equal(r.compared, 3);
});

test('globs: * stays in a segment, ** crosses segments', () => {
  assert.ok(globToRegExp('a/*/c.json').test('a/b/c.json'));
  assert.ok(!globToRegExp('a/*/c.json').test('a/b/d/c.json'));
  assert.ok(globToRegExp('**/c.json').test('c.json'));
  assert.ok(globToRegExp('**/c.json').test('a/b/c.json'));
  assert.ok(globToRegExp('a/**').test('a/b/c.json'));
});

test('PASS: a covered difference, one-sided files listed, shapeOnly reported, non-JSON skipped (exit 0)', () => {
  const w = workspace({
    frontend: { 'a.json': { msg: 'x', same: 1, feOnly: 1 }, 'fe-only.json': {}, 'COVERAGE.md': 'fe' },
    mcp: { 'a.json': { msg: 'y', same: 1 }, 'mcp-only.json': {}, 'COVERAGE.md': 'mcp' },
    manifest: {
      oneSided: [{ side: 'frontend', pattern: 'fe-*.json', reason: 'ui' }, { side: 'mcp', pattern: '**/mcp-only.json', reason: 'tool' }],
      consumerPolicy: [policy()],
    },
  });
  const r = w.run(['--json', join(w.root, 'report.json')]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /PASS/);
  assert.match(r.out, /E-01=1/);
  assert.match(r.out, /shapeOnly keys:\s+1/);
  assert.match(r.out, /one-sided files: frontend 1, mcp 1/);
  assert.match(r.out, /skipped non-json: frontend 1, mcp 1/);
  const report = JSON.parse(readFileSync(join(w.root, 'report.json'), 'utf8'));
  assert.equal(report.pass, true);
  assert.equal(report.summary.comparedLeaves, 2);
});

test('FAIL: a difference no consumerPolicy entry covers, and --draft lists it with null row and reason', () => {
  const w = workspace({ frontend: { 'a.json': { msg: 'x' } }, mcp: { 'a.json': { msg: 'y' } }, manifest: {} });
  const r = w.run(['--draft', join(w.root, 'draft.json')]);
  assert.equal(r.status, 1);
  assert.match(r.out, /a\.json#\/msg\s+frontend="x"\s+mcp="y"/);
  const draft = JSON.parse(readFileSync(join(w.root, 'draft.json'), 'utf8'));
  assert.deepEqual(draft.consumerPolicy, [{ row: null, file: 'a.json', pointer: '^/msg$', reason: null }]);
});

test('FAIL: a one-sided file with no oneSided entry', () => {
  const w = workspace({ frontend: { 'a.json': { v: 1 }, 'extra.json': {} }, mcp: { 'a.json': { v: 1 } }, manifest: {} });
  const r = w.run(['--draft', join(w.root, 'draft.json')]);
  assert.equal(r.status, 1);
  assert.match(r.out, /\[frontend\] extra\.json/);
  assert.deepEqual(JSON.parse(readFileSync(join(w.root, 'draft.json'), 'utf8')).oneSided, [{ side: 'frontend', pattern: 'extra.json', reason: null }]);
});

test('a oneSided pattern only covers its own side', () => {
  const w = workspace({
    frontend: { 'a.json': { v: 1 } }, mcp: { 'a.json': { v: 1 }, 'tool.json': {} },
    manifest: { oneSided: [{ side: 'frontend', pattern: 'tool.json', reason: 'wrong side' }] },
  });
  const r = w.run();
  assert.equal(r.status, 1);
  assert.match(r.out, /\[mcp\] tool\.json/);
  assert.match(r.out, /stale oneSided entries/);
});

test('FAIL: a stale oneSided entry', () => {
  const w = workspace({
    frontend: { 'a.json': { v: 1 } }, mcp: { 'a.json': { v: 1 } },
    manifest: { oneSided: [{ side: 'mcp', pattern: 'gone.json', reason: 'was one-sided' }] },
  });
  const r = w.run();
  assert.equal(r.status, 1);
  assert.match(r.out, /stale oneSided entries \(1\)/);
});

test('FAIL: a stale consumerPolicy entry (its pointer no longer differs)', () => {
  const w = workspace({
    frontend: { 'a.json': { msg: 'same' } }, mcp: { 'a.json': { msg: 'same' } },
    manifest: { consumerPolicy: [policy()] },
  });
  const r = w.run();
  assert.equal(r.status, 1);
  assert.match(r.out, /stale consumerPolicy entries \(1\)/);
  assert.match(r.out, /E-01 a\.json \^\/msg\$/);
});

test('a consumerPolicy entry covers only the files its glob names', () => {
  const w = workspace({
    frontend: { 'a.json': { msg: 'x' }, 'b.json': { msg: 'x' } }, mcp: { 'a.json': { msg: 'y' }, 'b.json': { msg: 'y' } },
    manifest: { consumerPolicy: [policy()] },
  });
  const r = w.run();
  assert.equal(r.status, 1);
  assert.match(r.out, /b\.json#\/msg/);
  assert.doesNotMatch(r.out, /a\.json#\/msg/);
});

test('a shared file with no compared leaf fails unless noOverlap lists it; a stale noOverlap entry fails', () => {
  const trees = { frontend: { 'n.json': { only: { fe: 1 } } }, mcp: { 'n.json': { cases: { mc: 1 } } } };
  const bare = workspace({ ...trees, manifest: {} });
  const r1 = bare.run();
  assert.equal(r1.status, 1);
  assert.match(r1.out, /prove nothing/);
  assert.match(r1.out, /n\.json/);

  const listed = workspace({ ...trees, manifest: { noOverlap: [{ file: 'n.json', reason: 'mcp nests under /cases' }] } });
  const r2 = listed.run();
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /1 with no overlap/);

  const stale = workspace({
    frontend: { 'n.json': { v: 1 } }, mcp: { 'n.json': { v: 1 } },
    manifest: { noOverlap: [{ file: 'n.json', reason: 'now overlaps' }] },
  });
  const r3 = stale.run();
  assert.equal(r3.status, 1);
  assert.match(r3.out, /stale noOverlap entries \(1\)/);
});

test('exit 2: a row unknown to the ledger, a row without a decision, a malformed manifest, an unreadable tree', () => {
  const trees = { frontend: { 'a.json': { msg: 'x' } }, mcp: { 'a.json': { msg: 'y' } } };
  const unknown = workspace({ ...trees, manifest: { consumerPolicy: [policy({ row: 'Z-99' })] } }).run();
  assert.equal(unknown.status, 2);
  assert.match(unknown.err, /Z-99.*not a ledger row/);

  const undecided = workspace({ ...trees, manifest: { consumerPolicy: [policy({ row: 'E-02' })] } }).run();
  assert.equal(undecided.status, 2);
  assert.match(undecided.err, /E-02.*no decision/);

  const nullRow = workspace({ ...trees, manifest: { consumerPolicy: [policy({ row: null, reason: null })] } }).run();
  assert.equal(nullRow.status, 2, 'a --draft skeleton cannot pass as a manifest');

  const malformed = workspace({ ...trees, manifest: { oneSided: [{ side: 'both', pattern: '', reason: '' }], consumerPolicy: [policy({ pointer: '(' })], extra: [] } }).run();
  assert.equal(malformed.status, 2);
  assert.match(malformed.err, /oneSided\[0\]\.side/);
  assert.match(malformed.err, /not a valid regex/);
  assert.match(malformed.err, /unknown top-level key "extra"/);

  const w = workspace({ ...trees, manifest: {} });
  writeFileSync(join(w.root, 'manifest.json'), '{ not json');
  assert.equal(w.run().status, 2);

  const missing = workspace({ ...trees, manifest: {} });
  const r = spawnSync(process.execPath, [SCRIPT, '--manifest', join(missing.root, 'manifest.json'), '--frontend', join(missing.root, 'nope'), '--mcp', join(missing.root, 'mcp'),
    '--ledger', join(missing.root, 'ledger.json'), '--decisions', join(missing.root, 'decisions.json')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

// ---------------------------------------------------------------------------
// align and ignore
// ---------------------------------------------------------------------------

const PGRST = '<PGRST>';
const mcpDoc = { queries: [{ input: { entity: 'items' }, requests: [
  { url: `${PGRST}/parents?select=id`, method: 'GET' },
  { url: `${PGRST}/items?select=id,name`, method: 'GET' },
] }] };
const feDoc = { queries: [{ input: { entity: 'items' }, request: { url: `${PGRST}/items?select=id,name`, method: 'GET' } }] };
const alignRule = (over = {}) => ({
  side: 'mcp', file: 'q.json', from: '(/queries/[0-9]+)/requests', to: '$1/request', pick: 'lastRequestToEntity', reason: 'frontend records one request', ...over,
});

test('align moves a node on one side; pick keeps the last request that targets the entity itself', () => {
  const w = workspace({ frontend: { 'q.json': feDoc }, mcp: { 'q.json': mcpDoc }, manifest: { align: [alignRule()] } });
  const r = w.run(['--json', join(w.root, 'report.json')]);
  assert.equal(r.status, 0, r.out + r.err);
  const report = JSON.parse(readFileSync(join(w.root, 'report.json'), 'utf8'));
  assert.equal(report.summary.comparedLeaves >= 2, true, 'url and method of the picked request are compared');
});

test('align pick: a difference in the picked request is reported, an earlier FK lookup is not compared', () => {
  const mcp = { queries: [{ input: { entity: 'items' }, requests: [
    { url: `${PGRST}/parents?select=zzz`, method: 'GET' },
    { url: `${PGRST}/items?select=id`, method: 'GET' },
  ] }] };
  const w = workspace({ frontend: { 'q.json': feDoc }, mcp: { 'q.json': mcp }, manifest: { align: [alignRule()] } });
  const r = w.run();
  assert.equal(r.status, 1);
  assert.match(r.out, /q\.json#\/queries\/0\/request\/url/);
  assert.doesNotMatch(r.out, /zzz/);
});

test('align without pick moves the node whole; align with pick and no matching request places nothing', () => {
  const moved = workspace({
    frontend: { 'q.json': { out: { v: 1 } } }, mcp: { 'q.json': { inn: { v: 1 } } },
    manifest: { align: [{ side: 'mcp', file: 'q.json', from: '/inn', to: '/out', reason: 'rename' }] },
  });
  assert.equal(moved.run().status, 0);
  const none = workspace({
    frontend: { 'q.json': { queries: [{ input: { entity: 'items' }, request: { url: `${PGRST}/items`, method: 'GET' } }] } },
    mcp: { 'q.json': { queries: [{ input: { entity: 'items' }, requests: [{ url: `${PGRST}/other?x=1`, method: 'GET' }] }] } },
    manifest: { align: [alignRule()] },
  });
  none.run(['--json', join(none.root, 'report.json')]);
  const report = JSON.parse(readFileSync(join(none.root, 'report.json'), 'utf8'));
  assert.equal(report.differences.length, 0, 'nothing placed, so nothing to compare');
});

test('FAIL: a stale align entry (its pattern matches no node)', () => {
  const w = workspace({ frontend: { 'q.json': { a: 1 } }, mcp: { 'q.json': { a: 1 } }, manifest: { align: [alignRule()] } });
  const r = w.run();
  assert.equal(r.status, 1);
  assert.match(r.out, /stale align entries \(1\)/);
});

test('ignore: matching nodes are skipped and reported separately; an unmatched entry is stale and fails', () => {
  const trees = { frontend: { 'a.json': { call: 'getData', v: 1 } }, mcp: { 'a.json': { call: 'list_records', v: 1 } } };
  const ok = workspace({ ...trees, manifest: { ignore: [{ file: 'a.json', pointer: '^/call$', reason: 'harness label' }] } });
  const r = ok.run(['--json', join(ok.root, 'report.json')]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /ignored nodes:\s+1/);
  const report = JSON.parse(readFileSync(join(ok.root, 'report.json'), 'utf8'));
  assert.equal(report.summary.ignoredNodes, 1);
  assert.equal(report.summary.comparedLeaves, 1, 'the ignored leaf is not counted as compared');

  const stale = workspace({ ...trees, manifest: { ignore: [
    { file: 'a.json', pointer: '^/call$', reason: 'harness label' },
    { file: 'a.json', pointer: '^/nope$', reason: 'matches nothing' },
  ] } });
  const s = stale.run();
  assert.equal(s.status, 1);
  assert.match(s.out, /stale ignore entries \(1\)/);
});

test('an ignore entry only covers the files its glob names', () => {
  const w = workspace({
    frontend: { 'a.json': { call: 'x' }, 'b.json': { call: 'x' } }, mcp: { 'a.json': { call: 'y' }, 'b.json': { call: 'y' } },
    manifest: { ignore: [{ file: 'a.json', pointer: '^/call$', reason: 'label' }] },
  });
  const r = w.run();
  assert.equal(r.status, 1);
  assert.match(r.out, /b\.json#\/call/);
  assert.doesNotMatch(r.out, /a\.json#\/call/);
});

test('exit 2: malformed align and ignore entries', () => {
  const trees = { frontend: { 'a.json': { v: 1 } }, mcp: { 'a.json': { v: 1 } } };
  const bad = workspace({ ...trees, manifest: {
    align: [{ side: 'both', file: 'a.json', from: '(', to: 1, pick: 'nope', reason: '' }],
    ignore: [{ file: '', pointer: '(', reason: '' }],
  } }).run();
  assert.equal(bad.status, 2);
  assert.match(bad.err, /align\[0\]\.side/);
  assert.match(bad.err, /align\[0\]\.from/);
  assert.match(bad.err, /align\[0\]\.pick/);
  assert.match(bad.err, /ignore\[0\]/);
});

// ---------------------------------------------------------------------------
// request URLs and caseOneSided
// ---------------------------------------------------------------------------

test('request URLs compare as decoded parameters: order between keys is ignored, order within a key is not', () => {
  const same = compareDocs(
    { u: '<PGRST>/items?select=id&civic_os_text_search=wfts.a%20b&order=id.asc' },
    { u: '<PGRST>/items?select=id&order=id.asc&civic_os_text_search=wfts.a b' },
  );
  assert.deepEqual(same.diffs, [], 'reordered keys and %20 versus a space are the same request');
  const dup = compareDocs(
    { u: '<PGRST>/items?select=id&select=ignored' },
    { u: '<PGRST>/items?select=ignored&select=id' },
  );
  assert.equal(dup.diffs.length, 1, 'duplicate keys keep their order');
  const path = compareDocs({ u: '<PGRST>/items?a=1' }, { u: '<PGRST>/other?a=1' });
  assert.equal(path.diffs.length, 1, 'the path is compared');
  const value = compareDocs({ u: '<PGRST>/items?a=1' }, { u: '<PGRST>/items?a=2' });
  assert.equal(value.diffs.length, 1);
  const plain = compareDocs({ u: 'http://x/?b=1&a=2' }, { u: 'http://x/?a=2&b=1' });
  assert.equal(plain.diffs.length, 1, 'only <PGRST>/ strings get the URL comparison');
});

test('caseOneSided: nodes are skipped, counted per ledger row, and an unmatched entry is stale', () => {
  const trees = { frontend: { 'a.json': { c: { v: 1 }, d: { v: 1 } } }, mcp: { 'a.json': { c: { v: 2 }, d: { v: 1 } } } };
  const entry = (over = {}) => ({ row: 'E-01', file: 'a.json', pointer: '^/c(/.*)?$', reason: 'not expressible', ...over });
  const ok = workspace({ ...trees, manifest: { caseOneSided: [entry()] } });
  const r = ok.run(['--json', join(ok.root, 'report.json')]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /case-level one-sided: E-01=1/);
  const report = JSON.parse(readFileSync(join(ok.root, 'report.json'), 'utf8'));
  assert.deepEqual(report.summary.caseOneSidedByRow, { 'E-01': 1 });

  const stale = workspace({ ...trees, manifest: { caseOneSided: [entry(), entry({ pointer: '^/nope$' })] } }).run();
  assert.equal(stale.status, 1);
  assert.match(stale.out, /stale ignore entries \(1\)/);

  const bad = workspace({ ...trees, manifest: { caseOneSided: [entry({ row: 'E-02' })] } }).run();
  assert.equal(bad.status, 2, 'the row must be decided');
  const unknown = workspace({ ...trees, manifest: { caseOneSided: [entry({ row: 'Z-99' })] } }).run();
  assert.equal(unknown.status, 2);
});
