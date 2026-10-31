/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Tests for compare.mjs: the plain text report, and the approved-diffs mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareRuns } from './compare.mjs';
import { baselineRun, currentRun, fullApproval, req } from './compare-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const run = (approved, example = 'pothole') => compareRuns(baselineRun(), currentRun(), approved ? { approved, example } : {});

/** Failure headers, e.g. `[f1] step "s-changed"`. */
const failHeads = (r) => r.failures.map((f) => f.split('\n')[0]);

test('without approved diffs the text report is unchanged', () => {
  assert.equal(run().render() + '\n', readFileSync(join(HERE, 'fixtures/compare-plain.txt'), 'utf8'));
});

test('structured items are recorded for every semantic difference', () => {
  const items = run().items.map((i) => `${i.step} ${i.kind}`);
  assert.deepEqual(items, ['s-changed CHANGED', 's-missing MISSING', 's-extra EXTRA', 's-count COUNT', 's-kc KEYCLOAK', 's-kc MINIO']);
  const changed = run().items[0];
  assert.deepEqual([changed.flow, changed.method, changed.path], ['f1', 'GET', '/issues']);
  assert.equal('raw' in changed.before, false);
  assert.equal('n' in changed.before, false);
});

test('approved entries turn exactly their differences into INFO lines', () => {
  const r = run(fullApproval());
  assert.deepEqual(failHeads(r), ['[f1] step "s-count"', '[f2] flow missing from current run', '[f3] step list differs']);
  assert.equal(r.approvedCount, 5);
  assert.ok(r.infos.some((i) => i.startsWith('APPROVED F-01 [f1] step "s-changed" CHANGED GET /issues')));
  assert.ok(r.infos.some((i) => i.startsWith('APPROVED F-04 [f1] step "s-kc" KEYCLOAK')));
  assert.match(r.render(), /Semantic differences: 3\. Raw-only warnings: 1\. Approved differences: 5\.\nRESULT: FAIL/);
});

// A baseline/current pair whose only differences are the approvable ones.
function approvableOnly() {
  const b = baselineRun();
  const c = currentRun();
  for (const run of [b, c]) {
    run.flows.delete('f2');
    run.flows.delete('f3');
    const f1 = run.flows.get('f1');
    f1.steps = f1.steps.filter((s) => s.name !== 's-count');
  }
  return [b, c];
}

test('an exact match passes', () => {
  const [b, c] = approvableOnly();
  const r = compareRuns(b, c, { approved: fullApproval(), example: 'pothole' });
  assert.deepEqual(r.failures, []);
  assert.equal(r.approvedCount, 5);
  assert.match(r.render(), /Approved differences: 5\.\nRESULT: PASS/);
});

test('an unapproved difference fails', () => {
  const [b, c] = approvableOnly();
  const approved = fullApproval().filter((e) => e.row !== 'F-03');
  const r = compareRuns(b, c, { approved, example: 'pothole' });
  assert.deepEqual(failHeads(r), ['[f1] step "s-extra"']);
  assert.match(r.failures[0], /EXTRA/);
});

test('an approved entry that does not occur fails', () => {
  const [b, c] = approvableOnly();
  const absent = { row: 'F-09', example: 'pothole', flow: 'f1', step: 's-same', kind: 'MISSING', method: 'GET', path: '/same', before: { method: 'GET', path: '/same' } };
  const r = compareRuns(b, c, { approved: [...fullApproval(), absent], example: 'pothole' });
  assert.deepEqual(r.failures, ['APPROVED BUT ABSENT F-09 [f1] step "s-same" MISSING GET /same']);
});

test('an entry with a different before or after value does not approve', () => {
  const [b, c] = approvableOnly();
  const approved = fullApproval();
  approved[0] = { ...approved[0], after: { ...approved[0].after, status: '4xx' } };
  const r = compareRuns(b, c, { approved, example: 'pothole' });
  assert.equal(r.failures.length, 2, 'the CHANGED difference is unapproved and the entry is absent');
  assert.ok(r.failures.some((f) => f.startsWith('APPROVED BUT ABSENT F-01')));
  assert.ok(r.failures.some((f) => f.startsWith('[f1] step "s-changed"')));
});

for (const kind of ['CHANGED', 'MISSING', 'EXTRA']) {
  test(`${kind} is approved alone and its entry is single-use`, () => {
    const [b, c] = approvableOnly();
    const f1 = (run) => run.flows.get('f1');
    // Keep only the steps relevant to this kind.
    const keep = { CHANGED: 's-changed', MISSING: 's-missing', EXTRA: 's-extra' }[kind];
    for (const run of [b, c]) f1(run).steps = f1(run).steps.filter((s) => s.name === keep || s.name === 's-same');
    const entry = fullApproval().find((e) => e.kind === kind);
    const ok = compareRuns(b, c, { approved: [entry], example: 'pothole' });
    assert.deepEqual(ok.failures, []);
    assert.equal(ok.approvedCount, 1);
    const twice = compareRuns(b, c, { approved: [entry, { ...entry, row: 'F-99' }], example: 'pothole' });
    assert.deepEqual(twice.failures, [`APPROVED BUT ABSENT F-99 [f1] step "${keep}" ${kind} ${entry.method} ${entry.path}`]);
  });
}

test('an approved entry for another example is ignored', () => {
  const [b, c] = approvableOnly();
  const other = fullApproval().map((e) => ({ ...e, example: 'community-center' }));
  const r = compareRuns(b, c, { approved: other, example: 'pothole' });
  assert.equal(r.approvedCount, 0);
  assert.equal(r.failures.length, 4, 'nothing is approved, and its absent entries are not reported');
  assert.ok(!r.failures.some((f) => f.startsWith('APPROVED')));
  // For its own example the same file approves everything.
  assert.deepEqual(compareRuns(b, c, { approved: other, example: 'community-center' }).failures, []);
});

test('a COUNT entry without its request, step list, missing flow and new flow differences cannot be approved', () => {
  const approved = [
    ...fullApproval(),
    { row: 'F-06', example: 'pothole', flow: 'f1', step: 's-count', kind: 'COUNT', method: 'GET', path: '/c', before: 1, after: 2 },
  ];
  const r = run(approved);
  assert.deepEqual(failHeads(r).slice(0, 1), ['[f1] step "s-count"']);
  assert.ok(r.failures.some((f) => f.startsWith('APPROVED BUT ABSENT F-06')));
  assert.ok(r.failures.some((f) => f.startsWith('[f2] flow missing')));
  assert.ok(r.failures.some((f) => f.startsWith('[f3] step list differs')));
});

const countEntry = (extra = {}) => {
  const { raw, n, ...request } = req('GET', '/c');
  return { row: 'F-06', example: 'pothole', flow: 'f1', step: 's-count', kind: 'COUNT', method: 'GET', path: '/c', request, before: 1, after: 2, ...extra };
};

test('a GET COUNT is approved only when its request and both counts match exactly', () => {
  const ok = run([...fullApproval(), countEntry()]);
  assert.ok(!failHeads(ok).includes('[f1] step "s-count"'));
  assert.equal(ok.approvedCount, 6);
  assert.ok(ok.infos.some((i) => i.startsWith('APPROVED F-06 [f1] step "s-count" COUNT GET /c')));
  for (const wrong of [{ after: 3 }, { before: 2 }, { request: { ...countEntry().request, query: { a: '1' } } }]) {
    const r = run([...fullApproval(), countEntry(wrong)]);
    assert.ok(failHeads(r).includes('[f1] step "s-count"'), JSON.stringify(wrong));
    assert.ok(r.failures.some((f) => f.startsWith('APPROVED BUT ABSENT F-06')));
  }
});

test('a write sent a different number of times cannot be approved', () => {
  const [b, c] = [baselineRun(), currentRun()];
  for (const r of [b, c]) r.flows.get('f1').steps.find((s) => s.name === 's-count').postgrest[0].method = 'POST';
  const r = compareRuns(b, c, { approved: [...fullApproval(), countEntry({ method: 'POST', request: { ...countEntry().request, method: 'POST' } })], example: 'pothole' });
  assert.ok(failHeads(r).includes('[f1] step "s-count"'));
  assert.ok(r.failures.some((f) => f.startsWith('APPROVED BUT ABSENT F-06')));
});

// CLI ---------------------------------------------------------------------------

test('cli compare --approved: exit 0 on a match, 1 on a stray difference, 2 on an unknown row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compare-cli-'));
  try {
    const [b, c] = approvableOnly();
    const write = (name, runDoc) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'meta.json'), JSON.stringify(runDoc.meta));
      for (const [flow, doc] of runDoc.flows) writeFileSync(join(dir, name, `${flow}.json`), JSON.stringify(doc));
    };
    write('base', b);
    write('cur', c);
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ rows: [1, 2, 3, 4, 5].map((n) => ({ id: `F-0${n}`, decision: { decision: 'fix' } })) }));
    const approvedFile = (harness) => {
      writeFileSync(join(dir, 'approved.json'), JSON.stringify({ phase: '1.3', golden: [], harness }));
      return join(dir, 'approved.json');
    };
    const cli = (harness) =>
      spawnSync(process.execPath, [resolve(HERE, 'cli.mjs'), 'compare', '--baseline', join(dir, 'base'), '--current', join(dir, 'cur'), '--approved', approvedFile(harness), '--example', 'pothole', '--ledger', join(dir, 'ledger.json')], { encoding: 'utf8' });
    const ok = cli(fullApproval());
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /INFO APPROVED F-01/);
    assert.equal(cli(fullApproval().slice(1)).status, 1);
    const unknown = cli([{ ...fullApproval()[0], row: 'Z-01' }]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Z-01/);
    const writeCount = cli([{ ...countEntry({ method: 'POST' }), row: 'F-01' }]);
    assert.equal(writeCount.status, 2);
    assert.match(writeCount.stderr, /COUNT is approvable only for a GET/);
    const bare = cli([{ ...countEntry({ request: undefined }), row: 'F-01' }]);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /COUNT needs "request"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Draft emit --------------------------------------------------------------------

function emitFixture(pairFn) {
  const dir = mkdtempSync(join(tmpdir(), 'compare-emit-'));
  const [b, c] = pairFn();
  for (const [name, runDoc] of [['base', b], ['cur', c]]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'meta.json'), JSON.stringify(runDoc.meta));
    for (const [flow, doc] of runDoc.flows) writeFileSync(join(dir, name, `${flow}.json`), JSON.stringify(doc));
  }
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ rows: [1, 2, 3, 4, 5].map((n) => ({ id: `F-0${n}`, decision: { decision: 'fix' } })) }));
  const cli = (...extra) =>
    spawnSync(process.execPath, [resolve(HERE, 'cli.mjs'), 'compare', '--baseline', join(dir, 'base'), '--current', join(dir, 'cur'), '--example', 'pothole', '--ledger', join(dir, 'ledger.json'), ...extra], { encoding: 'utf8' });
  return { dir, cli };
}

test('cli compare --emit-approved: draft is refused unedited and passes once rows are filled in', () => {
  const { dir, cli } = emitFixture(approvableOnly);
  try {
    const out = join(dir, 'draft.json');
    const r = cli('--emit-approved', out, '--phase', '1.3');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /emitted 5 pothole entries .*: 0 matched \(rows kept\), 5 new \(row null\)/);
    assert.match(r.stdout, /^DRAFT EMITTED \(not a gate result\): no hard failures$/m);
    assert.match(r.stdout, /^INFO DRAFT /m);
    assert.doesNotMatch(r.stdout, /RESULT:|APPROVED \(unattributed\)/);
    const draft = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(draft.phase, '1.3');
    assert.deepEqual(draft.harness.map((e) => [e.row, e.kind]), [[null, 'CHANGED'], [null, 'MISSING'], [null, 'EXTRA'], [null, 'KEYCLOAK'], [null, 'MINIO']]);
    assert.deepEqual(draft.harness.find((e) => e.kind === 'MISSING'), { row: null, example: 'pothole', flow: 'f1', step: 's-missing', kind: 'MISSING', method: 'POST', path: '/x', before: fullApproval()[1].before });

    const unedited = cli('--approved', out);
    assert.equal(unedited.status, 2);
    assert.match(unedited.stderr, /unattributed draft entry/);

    draft.harness.forEach((e, i) => (e.row = `F-0${i + 1}`));
    writeFileSync(out, JSON.stringify(draft));
    const ok = cli('--approved', out);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli compare --emit-approved: re-emit keeps rows, other examples and golden entries; hard failures still fail', () => {
  const { dir, cli } = emitFixture(() => [baselineRun(), currentRun()]);
  try {
    const out = join(dir, 'draft.json');
    const mine = { ...fullApproval()[0], row: 'F-01' };
    const other = { ...fullApproval()[1], example: 'community-center', row: 'F-02' };
    const stale = { ...fullApproval()[2], row: 'F-03', step: 'no-such-step' };
    const golden = { row: 'F-04', tree: 'mcp', file: 'm.json', pointer: '/q', after: 1 };
    writeFileSync(out, JSON.stringify({ phase: '1.3', golden: [golden], harness: [mine, other, stale] }));
    const r = cli('--emit-approved', out);
    assert.equal(r.status, 1, 'step list and missing flow remain hard failures');
    assert.match(r.stdout, /FAIL \[f2\] flow missing/);
    assert.doesNotMatch(r.stdout, /FAIL \[f1\] step "s-count"/, 'a GET COUNT is drafted, not failed');
    assert.match(r.stdout, /^DRAFT EMITTED \(not a gate result\): hard failures remain$/m);
    assert.match(r.stdout, /1 matched \(rows kept\), 5 new \(row null\), 1 existing entries dropped/);
    const draft = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(draft.golden, [golden]);
    assert.equal(draft.phase, '1.3');
    assert.deepEqual(draft.harness[0], other);
    assert.deepEqual(draft.harness[1], mine);
    assert.equal(draft.harness.length, 7);
    assert.ok(!draft.harness.some((e) => e.row === 'F-03'));
    assert.deepEqual(draft.harness.find((e) => e.kind === 'COUNT'), { ...countEntry(), row: null });
    assert.equal(draft.harness.filter((e) => e.row === null).length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
