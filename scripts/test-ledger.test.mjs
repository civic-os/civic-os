/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Self-tests for scripts/test-ledger.mjs (the unit-test assertion ledger).
 *
 *   node --test scripts/test-ledger.test.mjs
 *
 * Every case runs the real script with --from <raw> --baseline <tmp file>, so
 * the repository baseline is never read or written and no test suite runs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'test-ledger.mjs');

const ACCEPT = {
  DECREASED: '--accept-decreases',
  DISAPPEARED: '--accept-disappeared',
  'NEWLY UNSTABLE': '--accept-new-unstable',
  'STATE REGRESSED': '--accept-state-regressions',
};
const ALL_ACCEPT_FLAGS = Object.values(ACCEPT);

const key = (name) => `src/app/example.spec.ts :: Example > ${name}`;

function baselineDoc(tests) {
  return { version: 1, totals: {}, leakers: [], uncountedButReal: [], acceptedChanges: [], tests };
}

/** Runs the ledger script against a temporary baseline and raw ledger. */
function runLedger({ baseline, raw, args = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-selftest-'));
  const baselinePath = join(dir, 'baseline.json');
  const rawPath = join(dir, 'raw.json');
  const before = JSON.stringify(baseline, null, 2);
  writeFileSync(baselinePath, before);
  writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  const res = spawnSync(process.execPath, [SCRIPT, '--from', rawPath, '--baseline', baselinePath, ...args], {
    encoding: 'utf8',
  });
  const after = readFileSync(baselinePath, 'utf8');
  return {
    status: res.status,
    output: `${res.stdout}\n${res.stderr}`,
    written: after !== before,
    baseline: JSON.parse(after),
  };
}

const passing = (assertions) => ({ state: 'passed', assertions });

// One baseline and one raw ledger per gated category; `other` is an unchanged
// test so no fixture is empty.
const SCENARIOS = {
  DECREASED: {
    baseline: { [key('a')]: passing(3), [key('other')]: passing(1) },
    tests: { [key('a')]: passing(2), [key('other')]: passing(1) },
  },
  DISAPPEARED: {
    baseline: { [key('b')]: passing(2), [key('other')]: passing(1) },
    tests: { [key('other')]: passing(1) },
  },
  'NEWLY UNSTABLE': {
    baseline: { [key('c')]: passing(1), [key('other')]: passing(1) },
    tests: { [key('c')]: { state: 'passed', assertions: 1, maxAssertions: 2 }, [key('other')]: passing(1) },
  },
  // A skipped test records 0 assertions; a baseline of 0 keeps this scenario
  // free of a DECREASED entry (in practice the two usually come together).
  'STATE REGRESSED': {
    baseline: { [key('d')]: passing(0), [key('other')]: passing(1) },
    tests: { [key('d')]: { state: 'skipped', assertions: 0 }, [key('other')]: passing(1) },
  },
};

describe('ledger --update: failing runs are never written (no waiver)', () => {
  test('refuses a run in which a baseline test now fails, even with every accept flag', () => {
    const r = runLedger({
      baseline: baselineDoc({ [key('x')]: passing(2) }),
      raw: { run: { reason: 'passed', unhandledErrors: 0 }, tests: { [key('x')]: { state: 'failed', assertions: 2 } } },
      args: ['--update', ...ALL_ACCEPT_FLAGS],
    });
    assert.equal(r.status, 1, r.output);
    assert.equal(r.written, false);
    assert.match(r.output, /refusing to update baseline: 1 test\(s\) failed/);
    assert.match(r.output, /Example > x/);
    // Not classified as a waivable STATE REGRESSED.
    assert.doesNotMatch(r.output, /STATE REGRESSED/);
  });

  test('refuses a run in which a new test fails', () => {
    const r = runLedger({
      baseline: baselineDoc({ [key('x')]: passing(2) }),
      raw: { tests: { [key('x')]: passing(2), [key('new')]: { state: 'failed', assertions: 0 } } },
      args: ['--update', ...ALL_ACCEPT_FLAGS],
    });
    assert.equal(r.status, 1, r.output);
    assert.equal(r.written, false);
    assert.match(r.output, /Example > new/);
  });

  test('refuses a --from file whose recorded run outcome is failed although every test passed', () => {
    const r = runLedger({
      baseline: baselineDoc({ [key('x')]: passing(2) }),
      raw: { run: { reason: 'failed', unhandledErrors: 0 }, tests: { [key('x')]: passing(2) } },
      args: ['--update', ...ALL_ACCEPT_FLAGS],
    });
    assert.equal(r.status, 1, r.output);
    assert.equal(r.written, false);
    assert.match(r.output, /records a failing run/);
  });

  test('refuses a --from file that recorded unhandled errors', () => {
    const r = runLedger({
      baseline: baselineDoc({ [key('x')]: passing(2) }),
      raw: { run: { reason: 'passed', unhandledErrors: 1 }, tests: { [key('x')]: passing(2) } },
      args: ['--update'],
    });
    assert.equal(r.status, 1, r.output);
    assert.equal(r.written, false);
    assert.match(r.output, /records a failing run/);
  });

  test('writes from a --from file with a passing recorded outcome', () => {
    const r = runLedger({
      baseline: baselineDoc({ [key('x')]: passing(2) }),
      raw: { run: { reason: 'passed', unhandledErrors: 0 }, tests: { [key('x')]: passing(3) } },
      args: ['--update'],
    });
    assert.equal(r.status, 0, r.output);
    assert.equal(r.written, true);
    assert.equal(r.baseline.tests[key('x')].assertions, 3);
  });

  test('writes from a legacy --from file without a recorded outcome when every test passed', () => {
    const r = runLedger({
      baseline: baselineDoc({ [key('x')]: passing(2) }),
      raw: { tests: { [key('x')]: passing(2), [key('y')]: passing(1) } },
      args: ['--update'],
    });
    assert.equal(r.status, 0, r.output);
    assert.equal(r.written, true);
    assert.ok(r.baseline.tests[key('y')]);
  });
});

describe('ledger --update: each accept flag waives only its own category', () => {
  for (const [category, scenario] of Object.entries(SCENARIOS)) {
    const own = ACCEPT[category];
    const others = ALL_ACCEPT_FLAGS.filter((f) => f !== own);

    test(`${category} is refused without ${own}`, () => {
      const r = runLedger({ baseline: baselineDoc(scenario.baseline), raw: { tests: scenario.tests }, args: ['--update'] });
      assert.equal(r.status, 1, r.output);
      assert.equal(r.written, false);
      assert.match(r.output, new RegExp(`refusing to write: 1 ${category}; review, then pass ${own}`));
    });

    test(`${category} is still refused with every other accept flag`, () => {
      const r = runLedger({
        baseline: baselineDoc(scenario.baseline),
        raw: { tests: scenario.tests },
        args: ['--update', ...others],
      });
      assert.equal(r.status, 1, r.output);
      assert.equal(r.written, false);
      assert.match(r.output, new RegExp(`pass ${own} to waive`));
    });

    test(`${category} is written with ${own} and recorded in acceptedChanges`, () => {
      const r = runLedger({ baseline: baselineDoc(scenario.baseline), raw: { tests: scenario.tests }, args: ['--update', own] });
      assert.equal(r.status, 0, r.output);
      assert.equal(r.written, true);
      const kinds = r.baseline.acceptedChanges.map((c) => c.kind);
      assert.deepEqual(kinds, [category]);
    });
  }

  test('with all four categories present, leaving out one flag refuses and names only that category', () => {
    const baseline = Object.assign({}, ...Object.values(SCENARIOS).map((s) => s.baseline));
    const tests = Object.assign({}, ...Object.values(SCENARIOS).map((s) => s.tests));
    for (const [category, flag] of Object.entries(ACCEPT)) {
      const r = runLedger({
        baseline: baselineDoc(baseline),
        raw: { tests },
        args: ['--update', ...ALL_ACCEPT_FLAGS.filter((f) => f !== flag)],
      });
      assert.equal(r.status, 1, `${category}: ${r.output}`);
      assert.equal(r.written, false);
      const refusals = r.output.split('\n').filter((l) => l.includes('refusing to write'));
      assert.equal(refusals.length, 1, r.output);
      assert.match(refusals[0], new RegExp(`${category}; review, then pass ${flag}`));
    }
    const all = runLedger({ baseline: baselineDoc(baseline), raw: { tests }, args: ['--update', ...ALL_ACCEPT_FLAGS] });
    assert.equal(all.status, 0, all.output);
    assert.deepEqual(all.baseline.acceptedChanges.map((c) => c.kind).sort(), Object.keys(ACCEPT).sort());
  });

  test('STATE REGRESSED covers passed -> todo; skipped -> passed is informational', () => {
    const r = runLedger({
      baseline: baselineDoc({ [key('t')]: passing(0), [key('s')]: { state: 'skipped', assertions: 0 } }),
      raw: { tests: { [key('t')]: { state: 'todo', assertions: 0 }, [key('s')]: passing(1) } },
      args: ['--update', '--accept-state-regressions'],
    });
    assert.equal(r.status, 0, r.output);
    const changes = r.baseline.acceptedChanges.map((c) => `${c.kind}:${c.from}->${c.to}`).sort();
    assert.deepEqual(changes, ['STATE CHANGED:skipped->passed', 'STATE REGRESSED:passed->todo']);
  });
});

describe('ledger compare mode with --from', () => {
  test('fails when the --from file records a failing run, even if counts match', () => {
    const r = runLedger({
      baseline: baselineDoc({ [key('x')]: passing(2) }),
      raw: { run: { reason: 'failed', unhandledErrors: 0 }, tests: { [key('x')]: passing(2) } },
    });
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /PROBLEM: .*records a failing run/);
    assert.match(r.output, /LEDGER FAIL/);
    assert.equal(r.written, false);
  });

  test('fails on passed -> failed', () => {
    const r = runLedger({
      baseline: baselineDoc({ [key('x')]: passing(2) }),
      raw: { run: { reason: 'passed', unhandledErrors: 0 }, tests: { [key('x')]: { state: 'failed', assertions: 2 } } },
    });
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /PASSED -> NOT PASSED/);
  });

  test('passes when counts match and the recorded run passed', () => {
    const r = runLedger({
      baseline: baselineDoc({ [key('x')]: passing(2) }),
      raw: { run: { reason: 'passed', unhandledErrors: 0 }, tests: { [key('x')]: passing(2), [key('n')]: passing(1) } },
    });
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /LEDGER OK/);
    assert.equal(r.written, false);
  });
});
