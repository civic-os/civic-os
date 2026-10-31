/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A source of the current time, so code that computes ranges from "now" can be tested.
 *
 * @consumer typed systemClock
 */
export interface Clock {
  /** The current time. Each call returns a fresh `Date`, so callers may mutate it. */
  now(): Date;
}

/**
 * The real clock: a new `Date` on every call.
 *
 * @consumer app
 */
export const systemClock: Clock = { now: () => new Date() };
