/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { HttpRequest } from '@angular/common/http';
import { HttpTestingController, TestRequest } from '@angular/common/http/testing';

// Captured at module load, before any spec installs fake timers.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/**
 * Yield one macrotask. Under fake timers (testing/fake-time.ts) also runs the
 * fake timers that are due now; the real macrotask still lets work scheduled on
 * real timers (the async-emission probe's deferred delivery) run first.
 */
async function nextTick(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  }
  await new Promise<void>(resolve => realSetTimeout(resolve, 0));
}

/**
 * Wait for exactly one matching request to be issued, then return it.
 *
 * Use this for the second and later requests of a multi-step flow, where the
 * next request is only issued after the previous response has been delivered.
 * Delivery may be synchronous (today) or a few microtasks after `flush()`
 * (promise-backed clients), so a bare `expectOne()` straight after `flush()`
 * is order-fragile. Mirrors `expectOne` semantics: fails if more than one
 * request matches, or if none appears within the wait budget.
 */
export async function awaitRequest(
  httpMock: HttpTestingController,
  match: string | ((req: HttpRequest<any>) => boolean),
  maxTicks = 100
): Promise<TestRequest> {
  for (let i = 0; i < maxTicks; i++) {
    const found = httpMock.match(match as any);
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new Error(`Expected one matching request, found ${found.length}`);
    }
    await nextTick();
  }
  // Budget exhausted: let Angular produce its standard "none found" diagnostics.
  return httpMock.expectOne(match as any);
}

/**
 * Let all pending microtask chains (response delivery, signal writes made in
 * subscribe callbacks, promise-backed clients) run to completion. Use after
 * `flush()` when the thing to assert is service state rather than an emitted
 * value, so the assertion does not depend on delivery being synchronous.
 * Contains no `expect`, so assertion counts stay deterministic.
 */
export function settle(): Promise<void> {
  return nextTick();
}
