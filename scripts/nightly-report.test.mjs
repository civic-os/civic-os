/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * node --test scripts/nightly-report.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedJobs, plan, LABEL, TITLE } from './nightly-report.mjs';

const URL = 'https://github.com/o/r/actions/runs/1';
const green = { integrity: { result: 'success' }, compare: { result: 'success' }, leaks: { result: 'success' } };
const red = { integrity: { result: 'failure' }, compare: { result: 'skipped' }, leaks: { result: 'success' } };

test('failedJobs lists every job that is not success, sorted', () => {
  assert.deepEqual(failedJobs(red), ['compare (skipped)', 'integrity (failure)']);
  assert.deepEqual(failedJobs(green), []);
  assert.deepEqual(failedJobs({ leaks: { result: 'cancelled' } }), ['leaks (cancelled)']);
});

test('a failing run with no open issue ensures the label and opens one', () => {
  const calls = plan({ needs: red, openIssue: null, runUrl: URL });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 3), ['label', 'create', LABEL]);
  assert.ok(calls[0].includes('--force'));
  assert.deepEqual(calls[1].slice(0, 6), ['issue', 'create', '--title', TITLE, '--label', LABEL]);
  assert.equal(calls[1][7], `Nightly run failed: ${URL}\n\n- compare (skipped)\n- integrity (failure)`);
});

test('a failing run with an open issue comments on it and opens no other', () => {
  const calls = plan({ needs: red, openIssue: 42, runUrl: URL });
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [['label', 'create', LABEL], ['issue', 'comment', '42']]);
});

test('a green run closes the open issue with a comment', () => {
  assert.deepEqual(plan({ needs: green, openIssue: 42, runUrl: URL }), [
    ['issue', 'comment', '42', '--body', `Nightly run green again: ${URL}`],
    ['issue', 'close', '42'],
  ]);
});

test('a green run with no open issue does nothing', () => {
  assert.deepEqual(plan({ needs: green, openIssue: null, runUrl: URL }), []);
});
