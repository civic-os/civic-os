/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { HttpRequest } from '@angular/common/http';
import { HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { advanceTime, realTick } from './fake-time';

/**
 * Yield one macrotask. Under fake timers (testing/fake-time.ts) this is
 * advanceTime(0): a real tick first (a deferred delivery runs), then the fake
 * timers due now (including a 0 ms timer that delivery scheduled), then another
 * real tick. Same ordering contract as advanceTime; pinned by fake-time.spec.ts.
 */
async function nextTick(): Promise<void> {
  if (vi.isFakeTimers()) {
    await advanceTime(0);
  } else {
    await realTick();
  }
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
