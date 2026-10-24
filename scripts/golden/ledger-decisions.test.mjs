/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Self-tests for the ledger decisions file (scripts/golden/ledger-decisions.mjs
 * and its use in scripts/golden/ledger.mjs).
 *
 *   node --test scripts/golden/ledger-decisions.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDecisions, validateDecisions, mergeDecisions } from './ledger-decisions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'ledger.mjs');
const COMMITTED = resolve(HERE, '../../tests/golden/ledger-decisions.json');
const D = (decision) => ({ decision, detail: 'One sentence.', by: 'Daniel', date: '2026-10-23' });

test('mergeDecisions puts each decision on its row and lists rows without one', () => {
  const rows = [{ id: 'T-01', decision: null }, { id: 'T-02', decision: null }, { id: 'T-03', decision: null }];
  const { rows: merged, unknown, undecided } = mergeDecisions(rows, { 'T-01': D('adopt-mcp'), 'T-03': D('fix') });
  assert.deepEqual(merged.map((r) => r.decision?.decision ?? null), ['adopt-mcp', null, 'fix']);
  assert.deepEqual(merged[0].decision, D('adopt-mcp'));
  assert.deepEqual(unknown, []);
  assert.deepEqual(undecided, ['T-02']);
  assert.equal(rows[0].decision, null, 'the input rows are not mutated');
});

test('mergeDecisions reports ids that name no ledger row', () => {
  const { unknown } = mergeDecisions([{ id: 'T-01', decision: null }], { 'T-01': D('fix'), 'Z-99': D('fix'), 'A-00': D('fix') });
  assert.deepEqual(unknown, ['A-00', 'Z-99']);
});

test('validateDecisions rejects missing fields and bad dates', () => {
  assert.deepEqual(validateDecisions({ 'T-01': D('fix') }), []);
  const problems = validateDecisions({ 'T-01': { decision: 'fix', by: 'Daniel', date: '23/10/2026' }, 'T-02': 'fix' });
  assert.ok(problems.some((p) => /T-01: "detail"/.test(p)));
  assert.ok(problems.some((p) => /T-01: "date"/.test(p)));
  assert.ok(problems.some((p) => /T-02: must be an object/.test(p)));
});

test('the committed decisions file is well formed and mentions no private path', () => {
  const decisions = loadDecisions(COMMITTED);
  assert.deepEqual(validateDecisions(decisions), []);
  assert.doesNotMatch(readFileSync(COMMITTED, 'utf8'), /\.claude|knowledge ?base|\/Users\//i);
});

function runLedger(args, decisionsDoc) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-decisions-'));
  const file = join(dir, 'decisions.json');
  writeFileSync(file, JSON.stringify(decisionsDoc));
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LEDGER_DECISIONS_FILE: file } });
}

test('ledger.mjs fails non-zero in --check and generate mode when a decision names an unknown row', () => {
  const doc = { 'T-01': D('adopt-mcp'), 'Z-99': D('fix') };
  for (const args of [['--check'], []]) {
    const r = runLedger(args, doc);
    assert.notEqual(r.status, 0, `args ${JSON.stringify(args)}`);
    assert.match(r.stderr, /not in the ledger: Z-99/);
  }
});

test('ledger.mjs --check warns about rows without a decision and fails on the stale output', () => {
  const r = runLedger(['--check'], { 'T-01': D('adopt-mcp') });
  assert.match(r.stderr, /have no decision: T-02/);
  assert.notEqual(r.status, 0, 'the committed ledger carries other decisions, so it is stale against this file');
  assert.match(r.stderr, /stale ledger/);
});
