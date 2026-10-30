/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { systemClock } from './clock.js';

describe('systemClock', () => {
  it('returns a fresh Date on every call', () => {
    const a = systemClock.now();
    const b = systemClock.now();
    expect(a).not.toBe(b);
    a.setDate(a.getDate() + 5);
    expect(b.getTime()).toBeLessThan(a.getTime());
  });

  it('is close to Date.now()', () => {
    const before = Date.now();
    const t = systemClock.now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t - before).toBeLessThan(1000);
  });
});
