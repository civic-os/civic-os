/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Async-emission probe (SDK program guardrail for Phase 1.2).
 *
 * Inert unless the environment variable SDK_ASYNC_FLUSH is set to one of:
 *
 *   microtask  deliver after ASYNC_FLUSH_HOPS chained microtasks. Checks ordering
 *              assumptions (code that reads state right after flush()). It cannot
 *              detect assertions that moved back into subscribe(): the vitest
 *              afterEach hook runs more than 10 microtask hops later, so such a
 *              late assertion still lands inside the test's counted lifecycle.
 *   macrotask  deliver from a real setTimeout(0). This is the gate that detects
 *              assertions outside the test body (a subscribe() callback that is
 *              not awaited fires after the test ended, and its count is lost).
 *
 * TestRequest.prototype.flush, error and event are patched. The real setTimeout
 * is captured at module load so fake timers (vi.useFakeTimers) cannot stall
 * delivery. If the request is already cancelled when the method is called, the
 * original is called synchronously (it throws, as before). Otherwise delivery is
 * deferred and dropped if the request was cancelled by delivery time, which is
 * what production does with a late response to an unsubscribed request.
 *
 * Usage: SDK_ASYNC_FLUSH=macrotask node scripts/test-ledger.mjs
 * (see docs/development/TESTING.md, "Async-emission probe").
 */
import { TestRequest } from '@angular/common/http/testing';

/** Number of Promise hops used by the microtask mode. */
export const ASYNC_FLUSH_HOPS = 3;

type ProbeMode = 'microtask' | 'macrotask';

function probeMode(): ProbeMode | null {
  try {
    const mode = typeof process !== 'undefined' ? process.env?.['SDK_ASYNC_FLUSH'] : undefined;
    return mode === 'microtask' || mode === 'macrotask' ? mode : null;
  } catch {
    return null;
  }
}

const mode = probeMode();
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

if (mode) {
  const proto = TestRequest.prototype as any;
  if (!proto.__sdkAsyncFlushPatched) {
    for (const method of ['flush', 'error', 'event'] as const) {
      const original = proto[method];
      proto[method] = function (this: TestRequest, ...args: unknown[]): void {
        if (this.cancelled) {
          // Keep the synchronous throw for delivery to an already cancelled request.
          return original.apply(this, args);
        }
        const deliver = () => {
          if (this.cancelled) {
            return; // late response to an unsubscribed request is dropped
          }
          original.apply(this, args);
        };
        if (mode === 'macrotask') {
          realSetTimeout(deliver, 0);
        } else {
          void (async () => {
            for (let i = 0; i < ASYNC_FLUSH_HOPS; i++) {
              await Promise.resolve();
            }
            deliver();
          })();
        }
      };
    }
    proto.__sdkAsyncFlushPatched = true;
  }
}
