/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskClockDates, CLOCK_DATE_PLACEHOLDER as P } from './volatile.mjs';

const now = new Date('2026-10-15T03:00:00Z');

test('masks default_value equal to the capture day, the day before and the day after', () => {
  for (const d of ['2026-10-14', '2026-10-15', '2026-10-16']) {
    const r = maskClockDates([{ parameters: [{ default_value: d }] }], now);
    assert.equal(r.value[0].parameters[0].default_value, P);
    assert.equal(r.count, 1);
  }
});

test('output is independent of the capture day (same fixture on any day)', () => {
  const a = maskClockDates({ default_value: '2026-10-14' }, new Date('2026-10-14T12:00:00Z'));
  const b = maskClockDates({ default_value: '2026-10-20' }, new Date('2026-10-20T01:00:00Z'));
  assert.deepEqual(a.value, b.value);
});

test('leaves other dates, other keys and non-date defaults alone', () => {
  const v = { default_value: '2026-01-01', other: '2026-10-15', n: { default_value: 'now()' }, x: { default_value: null } };
  const r = maskClockDates(v, now);
  assert.deepEqual(r.value, v);
  assert.equal(r.count, 0);
});
