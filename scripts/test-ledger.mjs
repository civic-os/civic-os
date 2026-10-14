#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Unit-test assertion ledger (SDK program).
 *
 *   node scripts/test-ledger.mjs                 run suite, compare to baseline
 *   node scripts/test-ledger.mjs --update        run suite N times (--runs N, default 5),
 *                                                rewrite baseline with per-test minimum
 *   node scripts/test-ledger.mjs --update --reset-unstable   rebuild unstable marks from scratch
 *   --update refuses to write on DECREASED / DISAPPEARED / NEWLY UNSTABLE /
 *   STATE REGRESSED (passed -> skipped or todo) unless --accept-decreases /
 *   --accept-disappeared / --accept-new-unstable / --accept-state-regressions
 *   is given; waived items, and every other STATE CHANGED (e.g. skipped ->
 *   passed, informational), are recorded in the baseline's acceptedChanges.
 *   node scripts/test-ledger.mjs --suggest-leakers   heuristic report, never writes
 *   node scripts/test-ledger.mjs --from <file>   use an existing raw ledger JSON
 *                                                (written by the vitest reporter
 *                                                when SDK_LEDGER_OUT is set)
 *   --baseline <file>                            compare with / write this file instead
 *                                                of tests/baselines/unit-ledger.json
 *
 * Fails (exit 1) if, versus tests/baselines/unit-ledger.json:
 *   - any test's assertion count decreased
 *   - any baseline test disappeared (a rename shows as disappeared + new)
 *   - any test that passed no longer passes
 *   - total test count decreased
 *   - skipped + todo count increased
 * New tests are reported but allowed. Other state changes (e.g. skipped ->
 * passed) are reported under STATE CHANGED and allowed.
 *
 * Unstable vs leakers: some specs assert after their own test ended (inside
 * async subscribe callbacks). Vitest's global assertion counter charges those
 * late assertions to whichever test is running at that moment. The tests that
 * receive them are `unstable` (counts inflated by assertions leaking from other
 * tests); the tests that leak are listed in the baseline's `leakers` array
 * (hand-curated checklist for repairing them). Hence --update runs the suite
 * several times and stores the minimum count plus `maxAssertions`; flags only
 * widen on later updates (reproducible) until --reset-unstable is passed
 * (use after the leakers are fixed).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const baselineIdx = args.indexOf('--baseline');
const BASELINE = baselineIdx >= 0 ? resolve(args[baselineIdx + 1] ?? '') : join(root, 'tests/baselines/unit-ledger.json');
const update = args.includes('--update');
const fromIdx = args.indexOf('--from');
const fromFile = fromIdx >= 0 ? resolve(args[fromIdx + 1] ?? '') : null;
const runsIdx = args.indexOf('--runs');
const runs = runsIdx >= 0 ? Math.max(1, parseInt(args[runsIdx + 1], 10) || 1) : 5;

function sortedTests(tests) {
  const out = {};
  for (const k of Object.keys(tests).sort()) {
    out[k] = { state: tests[k].state, assertions: tests[k].assertions };
    if (tests[k].maxAssertions !== undefined) {
      out[k].unstable = true;
      out[k].maxAssertions = tests[k].maxAssertions;
    }
  }
  return out;
}

function totals(tests) {
  const t = { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, assertions: 0, passedWithZeroAssertions: 0 };
  for (const e of Object.values(tests)) {
    t.tests++;
    t.assertions += e.assertions;
    if (e.state === 'passed') {
      t.passed++;
      if (e.assertions === 0) t.passedWithZeroAssertions++;
    } else if (e.state === 'failed') t.failed++;
    else if (e.state === 'todo') t.todo++;
    else t.skipped++;
  }
  return t;
}

function acquireCurrent() {
  if (fromFile) return { raw: JSON.parse(readFileSync(fromFile, 'utf8')), runExit: 0 };
  const dir = mkdtempSync(join(tmpdir(), 'unit-ledger-'));
  const out = join(dir, 'raw.json');
  const res = spawnSync('npm', ['run', 'test:headless'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SDK_LEDGER_OUT: out },
  });
  if (!existsSync(out)) {
    console.error('\nledger: test run produced no ledger file (reporter not registered, or run aborted).');
    process.exit(2);
  }
  return { raw: JSON.parse(readFileSync(out, 'utf8')), runExit: res.status ?? 1 };
}

function mergeRuns(rawRuns) {
  const merged = {};
  for (const k of Object.keys(rawRuns[0].tests)) {
    const entries = rawRuns.map((r) => r.tests[k]);
    if (entries.some((e) => !e || e.state !== entries[0].state)) {
      console.error(`ledger: test missing or state differs between runs: ${k}`);
      process.exit(1);
    }
    const counts = entries.map((e) => e.assertions);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    merged[k] = { state: entries[0].state, assertions: min };
    if (max !== min) merged[k].maxAssertions = max;
  }
  for (const r of rawRuns) {
    if (Object.keys(r.tests).length !== Object.keys(merged).length) {
      console.error('ledger: test set differs between runs');
      process.exit(1);
    }
  }
  return merged;
}

// Leakers: tests that assert after they ended (typically inside an async
// subscribe callback). Detected heuristically from source: a passing test whose
// recorded count is 0 although its body contains expect(, or whose body both
// subscribes and expects and asserts less than its expect( occurrences.
// Only used by --suggest-leakers (report, never writes). The authoritative
// `leakers` list in the baseline is curated by hand.
function findLeakers(tests) {
  const found = new Set();
  const cache = new Map();
  for (const [k, t] of Object.entries(tests)) {
    if (t.state !== 'passed') continue;
    const [file, full] = k.split(' :: ');
    const name = full.replace(/ #\d+$/, '').split(' > ').pop();
    if (!cache.has(file)) {
      const p = join(root, file);
      cache.set(file, existsSync(p) ? readFileSync(p, 'utf8').split('\n') : []);
    }
    const lines = cache.get(file);
    const idx = lines.findIndex(
      (l) => /^\s*(it|test)\(/.test(l) && (l.includes(`'${name}'`) || l.includes(`"${name}"`) || l.includes('`' + name + '`')),
    );
    if (idx < 0) continue;
    let end = idx + 1;
    while (end < lines.length && !/^\s*(it|test|describe|xit|beforeEach|afterEach)\(/.test(lines[end])) end++;
    const body = lines.slice(idx, end).join('\n');
    const expects = (body.match(/\bexpect\(/g) ?? []).length;
    const subscribes = /\.subscribe\(/.test(body);
    if (expects > 0 && (t.assertions === 0 || (subscribes && t.assertions < expects))) found.add(k);
  }
  return [...found].sort();
}

let raw, runExit;
if (update && !fromFile) {
  const rawRuns = [];
  runExit = 0;
  for (let i = 0; i < runs; i++) {
    console.log(`\nledger: baseline run ${i + 1}/${runs}`);
    const r = acquireCurrent();
    runExit ||= r.runExit;
    rawRuns.push(r.raw);
  }
  raw = { tests: runExit === 0 ? mergeRuns(rawRuns) : rawRuns[0].tests };
} else {
  ({ raw, runExit } = acquireCurrent());
}
const current = sortedTests(raw.tests);

if (args.includes('--suggest-leakers')) {
  // Report only; never writes. Heuristic candidates not already curated.
  const curated = new Set(
    existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, 'utf8')).leakers ?? []).map((l) => `${l.file} :: ${l.name}`) : [],
  );
  const cand = findLeakers(current).filter((k) => !curated.has(k));
  console.log(`\nledger: ${cand.length} heuristic leaker candidate(s) not in the curated list:`);
  for (const k of cand) console.log(`  - ${k}`);
  process.exit(0);
}

if (update) {
  if (runExit !== 0) {
    console.error('ledger: refusing to update baseline from a failing run.');
    process.exit(1);
  }
  const resetUnstable = args.includes('--reset-unstable');
  const existing = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
  if (existing && !resetUnstable) {
    // Reproducibility: once flagged unstable, a test stays unstable and its
    // range only widens (min of mins, max of maxes), regardless of what this
    // particular set of runs happened to observe.
    for (const [k, e] of Object.entries(existing.tests)) {
      const c = current[k];
      if (!e.unstable || !c) continue;
      c.assertions = Math.min(e.assertions, c.assertions);
      c.unstable = true;
      c.maxAssertions = Math.max(e.maxAssertions, c.maxAssertions ?? c.assertions);
    }
  }

  const decreased = [], disappeared = [], newlyUnstable = [], added = [], increased = [];
  const stateRegressed = [], stateChanged = [];
  if (existing) {
    for (const [k, e] of Object.entries(existing.tests)) {
      const c = current[k];
      if (!c) disappeared.push({ test: k, from: e.assertions, to: null });
      else {
        if (c.state !== e.state) {
          // passed -> skipped/todo loses coverage and is gated; anything else
          // (typically skipped -> passed) is informational.
          (e.state === 'passed' ? stateRegressed : stateChanged).push({ test: k, from: e.state, to: c.state });
        }
        if (c.assertions < e.assertions) decreased.push({ test: k, from: e.assertions, to: c.assertions });
        else if (c.assertions > e.assertions) increased.push({ test: k, from: e.assertions, to: c.assertions });
        if (c.unstable && !e.unstable) newlyUnstable.push({ test: k, from: e.assertions, to: c.assertions });
      }
    }
    for (const k of Object.keys(current)) if (!(k in existing.tests)) added.push({ test: k, from: null, to: current[k].assertions });
  }
  const show = (title, items, fmt) => {
    if (!items.length) return;
    console.log(`\n${title} (${items.length})`);
    for (const i of items) console.log(`  - ${i.test}${fmt ? '\n      ' + fmt(i) : ''}`);
  };
  console.log('\n=== Ledger update vs existing baseline ===');
  show('DECREASED', decreased, (i) => `${i.from} -> ${i.to}`);
  show('DISAPPEARED', disappeared);
  show('NEWLY UNSTABLE', newlyUnstable, (i) => `was stable at ${i.from}, now varies (min ${i.to})`);
  show('STATE REGRESSED', stateRegressed, (i) => `${i.from} -> ${i.to}`);
  show('STATE CHANGED (informational)', stateChanged, (i) => `${i.from} -> ${i.to}`);
  show('NEW', added);
  if (increased.length) console.log(`\nINCREASED (${increased.length}), allowed.`);

  const gates = [
    ['DECREASED', decreased, '--accept-decreases'],
    ['DISAPPEARED', disappeared, '--accept-disappeared'],
    ['NEWLY UNSTABLE', newlyUnstable, '--accept-new-unstable'],
    ['STATE REGRESSED', stateRegressed, '--accept-state-regressions'],
  ];
  const blocked = gates.filter(([, items, flag]) => items.length && !args.includes(flag));
  if (blocked.length) {
    for (const [name, items, flag] of blocked) console.error(`\nledger: refusing to write: ${items.length} ${name}; review, then pass ${flag} to waive.`);
    process.exit(1);
  }
  const now = new Date().toISOString();
  const accepted = [];
  for (const [name, items] of gates) for (const i of items) accepted.push({ at: now, kind: name, test: i.test, from: i.from, to: i.to });
  for (const i of stateChanged) accepted.push({ at: now, kind: 'STATE CHANGED', test: i.test, from: i.from, to: i.to });
  if (accepted.length) {
    console.log('\nACCEPTED CHANGES (recorded in baseline acceptedChanges):');
    for (const a of accepted) console.log(`  - [${a.kind}] ${a.test}  ${a.from} -> ${a.to}`);
  }
  const doc = {
    version: 1,
    totals: totals(current),
    leakers: existing?.leakers ?? [],
    uncountedButReal: existing?.uncountedButReal ?? [],
    acceptedChanges: [...(existing?.acceptedChanges ?? []), ...accepted],
    tests: sortedTests(current),
  };
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n');
  console.log(`ledger: baseline written (${doc.totals.tests} tests, ${doc.totals.assertions} assertions).`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('ledger: no baseline; run with --update first.');
  process.exit(2);
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const baseTests = base.tests;

const decreased = [];
const disappeared = [];
const regressed = [];
const stateChanged = [];
const added = [];
const increased = [];
for (const [k, b] of Object.entries(baseTests)) {
  const c = current[k];
  if (!c) {
    disappeared.push(k);
    continue;
  }
  if (c.assertions < b.assertions) decreased.push(`${k}\n      ${b.assertions} -> ${c.assertions} (state ${c.state})`);
  if (c.assertions > b.assertions) increased.push(k);
  if (b.state === 'passed' && c.state !== 'passed') regressed.push(`${k}\n      passed -> ${c.state}`);
  else if (b.state !== c.state) stateChanged.push(`${k}\n      ${b.state} -> ${c.state}`);
}
for (const k of Object.keys(current)) if (!(k in baseTests)) added.push(k);

const bt = totals(baseTests);
const ct = totals(current);
const problems = [];
if (runExit !== 0) problems.push(`test run exited ${runExit}`);
if (ct.tests < bt.tests) problems.push(`total test count decreased: ${bt.tests} -> ${ct.tests}`);
if (ct.skipped + ct.todo > bt.skipped + bt.todo)
  problems.push(`skipped+todo increased: ${bt.skipped + bt.todo} -> ${ct.skipped + ct.todo}`);

function section(title, items, note = '') {
  if (!items.length) return;
  console.log(`\n${title} (${items.length})${note ? ' ' + note : ''}`);
  for (const i of items) console.log(`  - ${i}`);
}

console.log('\n=== Assertion ledger ===');
console.log(`baseline: ${bt.tests} tests, ${bt.assertions} assertions, ${bt.skipped + bt.todo} skipped/todo`);
console.log(`current : ${ct.tests} tests, ${ct.assertions} assertions, ${ct.skipped + ct.todo} skipped/todo`);

section('ASSERTION COUNT DECREASED', decreased, '(possible vacuous test)');
section('BASELINE TEST DISAPPEARED', disappeared, '(a rename appears here AND under NEW; lead must approve)');
section('PASSED -> NOT PASSED', regressed);
section('STATE CHANGED', stateChanged, '(informational; e.g. skipped -> passed. Recorded in acceptedChanges by --update.)');
section('NEW TESTS', added, '(allowed; listed so renames are visible)');
if (increased.length) console.log(`\nassertion count increased on ${increased.length} test(s) (allowed).`);
for (const p of problems) console.log(`\nPROBLEM: ${p}`);

const failed = decreased.length || disappeared.length || regressed.length || problems.length;
console.log(failed ? '\nLEDGER FAIL' : '\nLEDGER OK');
process.exit(failed ? 1 : 0);
