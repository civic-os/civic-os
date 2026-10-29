/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createFakeClock } from './index.js';

describe('createFakeClock', () => {
  it('starts at the given time, from a Date, number or string', () => {
    expect(createFakeClock('2026-03-11T12:00:00Z').now().toISOString()).toBe('2026-03-11T12:00:00.000Z');
    expect(createFakeClock(0).now().getTime()).toBe(0);
    expect(createFakeClock(new Date(5)).now().getTime()).toBe(5);
  });

  it('set replaces the time and advance moves it, forward or back', () => {
    const clock = createFakeClock(1000);
    clock.advance(500);
    expect(clock.now().getTime()).toBe(1500);
    clock.advance(-2000);
    expect(clock.now().getTime()).toBe(-500);
    clock.set('2026-01-01T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns independent copies', () => {
    const clock = createFakeClock(0);
    const a = clock.now();
    a.setFullYear(2000);
    expect(clock.now().getTime()).toBe(0);
    expect(clock.now()).not.toBe(clock.now());
  });

  it('throws a RangeError on invalid input', () => {
    expect(() => createFakeClock('nope')).toThrow(RangeError);
    const clock = createFakeClock(0);
    expect(() => clock.set(Number.NaN)).toThrow(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => clock.advance(1e16)).toThrow(RangeError);
    expect(clock.now().getTime()).toBe(0);
  });
});
