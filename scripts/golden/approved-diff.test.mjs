/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Self-tests for scripts/golden/approved-diff.mjs, on fixture data only.
 *
 *   node --test scripts/golden/approved-diff.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, diffTrees, flatten, matchApproved } from './approved-diff.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'approved-diff.mjs');

const tree = (o) => new Map(Object.entries(o));
const run = (base, cur, entries) => check({ tree: 'frontend', phase: '1.3', base: tree(base), cur: tree(cur), entries });

test('flatten: pointers are escaped and empty containers are leaves', () => {
  const m = flatten({ 'a/b': { '~': [1, {}] }, e: [] });
  assert.deepEqual([...m.keys()].sort(), ['/a~1b/~0/0', '/a~1b/~0/1', '/e']);
});

test('an exact match passes', () => {
  const r = run({ 'a.json': { x: 1, y: [1, 2] } }, { 'a.json': { x: 2, y: [1, 3] } }, [
    { row: 'S-02', file: 'a.json', pointer: '/x', before: 1, after: 2 },
    { row: 'S-02', file: 'a.json', pointer: '/y/1', before: 2, after: 3 },
  ]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^PASS /);
});

test('an unapproved change fails', () => {
  const r = run({ 'a.json': { x: 1, z: 1 } }, { 'a.json': { x: 2, z: 2 } }, [{ row: 'S-02', file: 'a.json', pointer: '/x', before: 1, after: 2 }]);
  assert.equal(r.code, 1);
  assert.match(r.text, /UNAPPROVED \(1\)/);
  assert.match(r.text, /\/z/);
  assert.doesNotMatch(r.text, /ABSENT/);
});

test('an approved change that does not occur fails', () => {
  const r = run({ 'a.json': { x: 1 } }, { 'a.json': { x: 1 } }, [{ row: 'S-02', file: 'a.json', pointer: '/x', before: 1, after: 2 }]);
  assert.equal(r.code, 1);
  assert.match(r.text, /APPROVED BUT ABSENT \(1\)/);
  assert.match(r.text, /\[S-02\]/);
});

test('duplicate entries approve at most one difference each', () => {
  const e = { row: 'S-02', file: 'a.json', pointer: '/x', before: 1, after: 2 };
  const r = run({ 'a.json': { x: 1 } }, { 'a.json': { x: 2 } }, [e, { ...e }]);
  assert.equal(r.code, 1);
  assert.match(r.text, /APPROVED BUT ABSENT \(1\)/);
  assert.doesNotMatch(r.text, /UNAPPROVED/);
});

test('an approved change with the wrong after value is both unapproved and absent', () => {
  const r = run({ 'a.json': { x: 1 } }, { 'a.json': { x: 2 } }, [{ row: 'S-02', file: 'a.json', pointer: '/x', before: 1, after: 3 }]);
  assert.equal(r.code, 1);
  assert.match(r.text, /UNAPPROVED \(1\)/);
  assert.match(r.text, /APPROVED BUT ABSENT \(1\)/);
});

test('an added file is a set of added leaves with no before', () => {
  const entries = [
    { row: 'Q-05', file: 'new.json', pointer: '/a', after: 1 },
    { row: 'Q-05', file: 'new.json', pointer: '/b/0', after: 'x' },
  ];
  assert.equal(run({}, { 'new.json': { a: 1, b: ['x'] } }, entries).code, 0);
  // An entry that claims a before value does not match an added leaf.
  const bad = run({}, { 'new.json': { a: 1, b: ['x'] } }, [{ ...entries[0], before: null }, entries[1]]);
  assert.equal(bad.code, 1);
});

test('a removed file and a removed leaf have no after', () => {
  const r = run({ 'gone.json': { a: 1 }, 'a.json': { x: 1, y: 2 } }, { 'a.json': { x: 1 } }, [
    { row: 'E-03', file: 'gone.json', pointer: '/a', before: 1 },
    { row: 'E-03', file: 'a.json', pointer: '/y', before: 2 },
  ]);
  assert.equal(r.code, 0, r.text);
  const wrong = run({ 'a.json': { x: 1, y: 2 } }, { 'a.json': { x: 1 } }, [{ row: 'E-03', file: 'a.json', pointer: '/y', before: 2, after: null }]);
  assert.equal(wrong.code, 1);
});

test('a leaf that becomes null differs from a removed leaf', () => {
  const r = run({ 'a.json': { y: 2 } }, { 'a.json': { y: null } }, [{ row: 'E-03', file: 'a.json', pointer: '/y', before: 2, after: null }]);
  assert.equal(r.code, 0, r.text);
});

test('a reordered object with equal values is no difference', () => {
  assert.deepEqual(diffTrees(tree({ 'a.json': { a: { x: 1, y: 2 }, b: [{ q: 1, r: 2 }] } }), tree({ 'a.json': { b: [{ r: 2, q: 1 }], a: { y: 2, x: 1 } } })), []);
  const r = run({ 'a.json': { a: 1, b: 2 } }, { 'a.json': { b: 2, a: 1 } }, []);
  assert.equal(r.code, 0);
  assert.match(r.text, /0 difference/);
});

test('object values compare by stable stringify', () => {
  const { unapproved, absent } = matchApproved(
    [{ file: 'a.json', pointer: '/x', before: {}, after: [] }],
    [{ row: 'S-02', file: 'a.json', pointer: '/x', before: {}, after: [] }],
  );
  assert.deepEqual([unapproved, absent], [[], []]);
});

// CLI against a temporary git repository --------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

function fixtureRepo(approved) {
  const root = mkdtempSync(join(tmpdir(), 'approved-diff-'));
  const put = (rel, value) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  git(root, 'init', '-q');
  put('tests/golden/ledger.json', { rows: [{ id: 'S-02', decision: { decision: 'fix' } }, { id: 'U-01', decision: null }] });
  put('tests/golden/derived/frontend/a.json', { x: 1, y: { z: 'old' } });
  put('tests/golden/derived/frontend/COVERAGE.md', 'ignored');
  put('tests/golden/approved-diffs/1.3.json', approved);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return { root, put };
}

const cli = (root, ...extra) => spawnSync(process.execPath, [SCRIPT, '--phase', '1.3', '--tree', 'frontend', '--root', root, ...extra], { encoding: 'utf8' });

test('CLI: pass on exact match, fail when unapproved, exit 2 on an unknown row', () => {
  const entry = { row: 'S-02', tree: 'frontend', file: 'a.json', pointer: '/y/z', before: 'old', after: 'new' };
  const { root, put } = fixtureRepo({ phase: '1.3', golden: [entry], harness: [] });
  try {
    put('tests/golden/derived/frontend/a.json', { y: { z: 'new' }, x: 1 });
    let r = cli(root);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^PASS /);

    put('tests/golden/derived/frontend/a.json', { y: { z: 'new' }, x: 2 });
    r = cli(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /UNAPPROVED \(1\)/);

    put('tests/golden/derived/frontend/a.json', { y: { z: 'old' }, x: 1 });
    r = cli(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /APPROVED BUT ABSENT/);

    put('tests/golden/approved-diffs/1.3.json', { phase: '1.3', golden: [{ ...entry, row: 'X-99' }] });
    r = cli(root);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /X-99.*not a row of the ledger/);

    put('tests/golden/approved-diffs/1.3.json', { phase: '1.3', golden: [{ ...entry, row: 'U-01' }] });
    r = cli(root);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /U-01 has no decision/);

    put('tests/golden/approved-diffs/1.3.json', { phase: '1.4', golden: [] });
    assert.equal(cli(root).status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: --base compares against another ref and entries for the other tree are ignored', () => {
  const entry = { row: 'S-02', tree: 'frontend', file: 'a.json', pointer: '/x', before: 1, after: 5 };
  const other = { row: 'S-02', tree: 'mcp', file: 'nothing.json', pointer: '/q', after: 1 };
  const { root, put } = fixtureRepo({ phase: '1.3', golden: [entry, other], harness: [] });
  try {
    put('tests/golden/derived/frontend/a.json', { x: 5, y: { z: 'old' } });
    git(root, 'commit', '-q', '-am', 'change');
    assert.equal(cli(root).status, 1, 'against HEAD there is no difference, so the entry is absent');
    const r = cli(root, '--base', 'HEAD~1');
    assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: a base ref without the derived tree exits 2', () => {
  const { root } = fixtureRepo({ phase: '1.3', golden: [], harness: [] });
  try {
    const r = cli(root, '--base', '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /wrong --base ref/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Draft emit ---------------------------------------------------------------------

test('CLI emit: draft has null rows, is refused unedited, and passes once rows are filled in', () => {
  const { root, put } = fixtureRepo({ phase: '1.3', golden: [], harness: [] });
  try {
    put('tests/golden/derived/frontend/a.json', { x: 2, y: { z: 'new' } });
    put('tests/golden/derived/frontend/b.json', { n: 1 });
    const out = join(root, 'draft.json');
    const r = cli(root, '--emit', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /3 new \(row null\)/);
    const draft = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(draft.golden.length, 3);
    assert.ok(draft.golden.every((e) => e.row === null && e.tree === 'frontend'));
    assert.deepEqual(draft.golden.find((e) => e.file === 'b.json'), { row: null, tree: 'frontend', file: 'b.json', pointer: '/n', after: 1 });

    const unedited = cli(root, '--file', out);
    assert.equal(unedited.status, 2);
    assert.match(unedited.stderr, /unattributed draft entry/);

    draft.golden.forEach((e) => (e.row = 'S-02'));
    writeFileSync(out, JSON.stringify(draft));
    const ok = cli(root, '--file', out);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI emit: re-emit keeps matched rows, the other tree and the harness entries', () => {
  const kept = { row: 'S-02', tree: 'frontend', file: 'a.json', pointer: '/x', before: 1, after: 2 };
  const stale = { row: 'S-02', tree: 'frontend', file: 'a.json', pointer: '/gone', before: 1, after: 2 };
  const mcp = { row: 'S-02', tree: 'mcp', file: 'm.json', pointer: '/q', after: 1 };
  const harness = { row: 'S-02', example: 'pothole', flow: 'f', step: 's', kind: 'KEYCLOAK', before: {}, after: { t: 1 } };
  const { root, put } = fixtureRepo({ phase: '1.3', golden: [kept, stale, mcp], harness: [harness] });
  try {
    put('tests/golden/derived/frontend/a.json', { x: 2, y: { z: 'new' } });
    const out = join(root, 'draft.json');
    const r = cli(root, '--emit', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 matched \(rows kept\), 1 new \(row null\), 1 existing entries dropped/);
    const draft = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(draft.harness, [harness]);
    assert.deepEqual(draft.golden[0], mcp);
    assert.deepEqual(draft.golden[1], kept);
    assert.deepEqual(draft.golden[2], { row: null, tree: 'frontend', file: 'a.json', pointer: '/y/z', before: 'old', after: 'new' });
    assert.equal(draft.golden.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
