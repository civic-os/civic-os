#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Keeps one tracking issue for the nightly full-stack workflow
 * (.github/workflows/nightly.yml) instead of a notification per failed run.
 *
 *   NEEDS_JSON='${{ toJSON(needs) }}' RUN_URL=... node scripts/nightly-report.mjs [--dry-run]
 *
 * A run with any job not `success` comments on the open issue labelled
 * `nightly-failure`, or opens one. A green run comments on that issue and
 * closes it. So at most one issue is open, and each closed issue spans one
 * failing stretch. --dry-run prints the gh calls instead of making them.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LABEL = 'nightly-failure';
export const TITLE = 'Nightly full-stack run failing';

/** Jobs whose result is not `success`, as `name (result)`, sorted by name. */
export function failedJobs(needs) {
  return Object.entries(needs)
    .filter(([, job]) => job?.result !== 'success')
    .map(([name, job]) => `${name} (${job?.result ?? 'unknown'})`)
    .sort();
}

/**
 * The gh calls for one run. `openIssue` is the number of the open tracking
 * issue, or null. Returns argument lists for `gh`, in order.
 */
export function plan({ needs, openIssue, runUrl }) {
  const failed = failedJobs(needs);
  const calls = [];
  if (failed.length > 0) {
    const body = [`Nightly run failed: ${runUrl}`, '', ...failed.map((j) => `- ${j}`)].join('\n');
    calls.push(['label', 'create', LABEL, '--color', 'B60205', '--description', 'The nightly full-stack workflow is failing', '--force']);
    if (openIssue === null) calls.push(['issue', 'create', '--title', TITLE, '--label', LABEL, '--body', body]);
    else calls.push(['issue', 'comment', String(openIssue), '--body', body]);
  } else if (openIssue !== null) {
    calls.push(['issue', 'comment', String(openIssue), '--body', `Nightly run green again: ${runUrl}`]);
    calls.push(['issue', 'close', String(openIssue)]);
  }
  return calls;
}

function gh(args) {
  const run = spawnSync('gh', args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${run.stderr.trim()}`);
  return run.stdout;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const needs = JSON.parse(process.env.NEEDS_JSON ?? '{}');
  const runUrl = process.env.RUN_URL ?? '(no run URL)';
  if (Object.keys(needs).length === 0) throw new Error('NEEDS_JSON is empty: pass toJSON(needs) from the workflow');
  const open = dryRun
    ? []
    : JSON.parse(gh(['issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number', '--limit', '1']));
  const calls = plan({ needs, openIssue: open[0]?.number ?? null, runUrl });
  for (const args of calls) {
    if (dryRun) console.log(['gh', ...args].map((a) => JSON.stringify(a)).join(' '));
    else gh(args);
  }
  console.log(calls.length === 0 ? 'green, no open tracking issue' : `${calls.length} gh call(s)${dryRun ? ' (dry run)' : ''}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
