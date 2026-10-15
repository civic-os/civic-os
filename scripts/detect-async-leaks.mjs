#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Async-leak gate for the unit suite (SDK program).
 *
 *   node scripts/detect-async-leaks.mjs [--runs N] [extra ng test args, e.g. --include=...]
 *
 * Runs `ng test --watch=false` with Vitest's `detectAsyncLeaks` enabled, which
 * reports every timer, immediate and promise that a spec file created and that
 * was still pending when the file finished. Vitest prints them but does not
 * fail the run on them, so this script registers itself as an extra reporter,
 * collects the leaks and exits 1 if there is any (or if the run itself failed).
 *
 * The always-on guard in src/app/testing/async-leak-guard.ts already fails a
 * spec file that leaves timers behind, in every `npm run test:headless`. This
 * gate additionally covers promise-only leaks (an unawaited dynamic import that
 * resolves after the file ended). It is slower (async hooks track every
 * promise), so it is a separate gate rather than part of every run.
 *
 * Leak detection depends on timing (a dynamic import is a leak only if it is
 * still pending when its file ends), so --runs N repeats the suite.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');

function firstFrame(stack) {
  const frames = stack.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('at '));
  return (
    frames.find((s) => s.includes('/src/')) ??
    frames.find((s) => !s.includes('node_modules') && !s.includes('node:')) ??
    ''
  );
}

/**
 * Vitest reporter half: writes the leaks Vitest collected to $SDK_LEAKS_OUT.
 * Vitest keeps them in its run state (`vitest.state.leakSet`), which is what its
 * own default reporter prints from; if a Vitest upgrade moves it, the gate
 * fails loudly instead of passing.
 */
export default class AsyncLeakReporter {
  onInit(vitest) {
    this.vitest = vitest;
  }

  onTestRunEnd(_testModules, unhandledErrors = [], reason) {
    const out = process.env.SDK_LEAKS_OUT;
    if (!out) return;
    const leakSet = this.vitest?.state?.leakSet;
    const root = this.vitest?.config?.root ?? process.cwd();
    const leaks = leakSet
      ? [...leakSet].map((l) => ({
          type: l.type,
          file: relative(root, l.filename).split('\\').join('/'),
          // First frame in the project's src/ tree (else outside node_modules), for the summary.
          at: firstFrame(l.stack ?? ''),
        }))
      : null;
    writeFileSync(
      out,
      JSON.stringify({ reason: reason ?? null, unhandledErrors: unhandledErrors.length, leaks }, null, 2) + '\n',
    );
  }
}

function runOnce(extraArgs, n, total) {
  const dir = mkdtempSync(join(tmpdir(), 'async-leaks-'));
  const config = join(dir, 'vitest.leaks.config.mjs');
  const out = join(dir, 'leaks.json');
  writeFileSync(config, 'export default { test: { detectAsyncLeaks: true } };\n');
  console.log(`\nasync-leaks: run ${n}/${total}`);
  const res = spawnSync(
    'npx',
    ['ng', 'test', '--watch=false', `--runner-config=${config}`, '--reporters=default', `--reporters=${SELF}`, ...extraArgs],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, SDK_LEAKS_OUT: out } },
  );
  if (!existsSync(out)) {
    return { ok: false, problems: [`run ${n}: no leak report written (run aborted, or the reporter was not loaded)`] };
  }
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const problems = [];
  if (report.leaks === null) problems.push(`run ${n}: Vitest no longer exposes state.leakSet; update scripts/detect-async-leaks.mjs`);
  if (res.status !== 0) problems.push(`run ${n}: ng test exited ${res.status} (run outcome: ${report.reason})`);
  for (const l of report.leaks ?? []) problems.push(`run ${n}: ${l.type} leaking in ${l.file}  ${l.at}`);
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const args = process.argv.slice(2);
  const runsIdx = args.indexOf('--runs');
  const runs = runsIdx >= 0 ? Math.max(1, parseInt(args[runsIdx + 1], 10) || 1) : 1;
  const extraArgs = runsIdx >= 0 ? args.filter((_, i) => i !== runsIdx && i !== runsIdx + 1) : args;
  const problems = [];
  for (let i = 1; i <= runs; i++) problems.push(...runOnce(extraArgs, i, runs).problems);
  if (problems.length) {
    console.error(`\nasync-leaks: FAIL (${problems.length})`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`\nasync-leaks: OK (${runs} run(s), no leaks)`);
}
