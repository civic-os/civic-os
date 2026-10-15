/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Fake time for specs that used to "let things settle" with fixed real-time
 * waits (`await new Promise(r => setTimeout(r, 100))`).
 *
 * A real-time wait races whatever it is waiting for (an RxJS debounceTime, a
 * polling setTimeout, Angular's change-detection scheduling) and loses when
 * the machine is starved of CPU. Under fake time the same step is
 * `await advanceTime(100)`: exactly 100 ms of fake timers run, in order, with
 * microtasks flushed between them, however slow the machine is.
 *
 * Faked: setTimeout/clearTimeout, setInterval/clearInterval (RxJS's async
 * scheduler) and Date (RxJS time-based operators compare Date.now()). Not
 * faked: animation frames and setImmediate (happy-dom implements
 * requestAnimationFrame on its own captured timers, so Angular's zoneless
 * scheduler still runs change detection), microtasks, and real I/O such as a
 * dynamic import: wait for those with `vi.waitFor` on the actual condition
 * (under fake timers it also advances fake time by its interval per check).
 */
export const SPEC_FAKE_TIMERS: ('setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval' | 'Date')[] = [
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date',
];

/**
 * Runs every test of the enclosing describe on fake time. Call it first in the
 * describe body so its beforeEach precedes the spec's own (timers created while
 * the fixture is built are fake too). Its afterEach runs after the spec's own
 * afterEach hooks and before TestBed teardown, clears what the last test left
 * pending and restores real timers.
 */
export function useFakeTimeInEachTest(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: SPEC_FAKE_TIMERS });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
}

// Captured at module load, before any spec installs fake timers.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/** One real macrotask (FIFO after real timers already due, e.g. a deferred HTTP delivery). */
function realTick(): Promise<void> {
  return new Promise<void>((resolve) => realSetTimeout(resolve, 0));
}

/**
 * The fake-time replacement for `await new Promise(r => setTimeout(r, ms))`:
 * yields one real macrotask, lets `ms` of fake time pass (timers in order,
 * microtasks flushed between them), then yields another real macrotask. The
 * real ticks keep work that is on real timers in the same order relative to
 * the fake timers as the old real-time wait did (the async-emission probe
 * delivers HTTP responses from a real setTimeout(0); happy-dom animation
 * frames run on real immediates).
 */
export async function advanceTime(ms: number): Promise<void> {
  await realTick();
  await vi.advanceTimersByTimeAsync(ms);
  await realTick();
}

/**
 * Advances fake time in small steps until `promise` settles, then returns it.
 * For awaiting a value whose producer is time-based (an observable behind
 * debounceTime, a polling loop, or a dynamic import followed by a timer)
 * without guessing how much time it needs:
 *
 *   const data = await runFakeTimeUntil(firstValueFrom(component.data$));
 *
 * Each step advances fake time by `stepMs` and yields one real macrotask, so
 * work on real timers or real I/O (a dynamic import, the async-emission
 * probe's deferred HTTP delivery) keeps moving. Gives up after `realBudgetMs`
 * of wall-clock time and returns the still-pending promise, so a value that
 * never arrives fails the test by its timeout, as before.
 */
export async function runFakeTimeUntil<T>(promise: Promise<T>, stepMs = 10, realBudgetMs = 4000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  const start = performance.now();
  while (!settled && performance.now() - start < realBudgetMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    if (!settled) await realTick();
  }
  return promise;
}
