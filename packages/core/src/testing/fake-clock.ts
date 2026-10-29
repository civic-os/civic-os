/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Clock } from '../state/clock.js';

/** A {@link Clock} a test can move. */
export interface FakeClock extends Clock {
  /** Replaces the current time. Throws a `RangeError` for an invalid date. */
  set(time: Date | number | string): void;
  /** Moves the time by `ms` milliseconds; negative values go back. */
  advance(ms: number): void;
}

function toTime(time: Date | number | string): number {
  const ms = new Date(time).getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Invalid time for fake clock: ${String(time)}`);
  return ms;
}

/**
 * Creates a {@link FakeClock} starting at `start`. `now()` returns a new
 * `Date` copy on every call.
 */
export function createFakeClock(start: Date | number | string): FakeClock {
  let ms = toTime(start);
  return {
    now: () => new Date(ms),
    set(time) {
      ms = toTime(time);
    },
    advance(delta) {
      const next = ms + delta;
      if (Number.isNaN(new Date(next).getTime())) throw new RangeError(`Invalid advance for fake clock: ${String(delta)}`);
      ms = next;
    },
  };
}
