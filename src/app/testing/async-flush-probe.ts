/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Async-emission probe (SDK program guardrail for Phase 1.2).
 *
 * Inert unless the environment variable SDK_ASYNC_FLUSH=microtask is set.
 * When active, TestRequest.prototype.flush is patched so the real flush runs
 * after several chained microtasks instead of synchronously. This simulates
 * the Promise hops that Phase 1.2 introduces when SchemaService/DataService
 * delegate to Promise-based core clients. A spec that asserts inside
 * subscribe() and relies on a synchronous flush then asserts after the test
 * ended (or never); under the probe the assertion-ledger count for such a test
 * drops, and any assertion that used to run now runs late.
 *
 * Usage: SDK_ASYNC_FLUSH=microtask node scripts/test-ledger.mjs
 * (see docs/development/TESTING.md, "Async-emission probe").
 */
import { TestRequest } from '@angular/common/http/testing';

/** Number of Promise hops the real flush is delayed by. */
export const ASYNC_FLUSH_HOPS = 3;

function probeEnabled(): boolean {
  try {
    return typeof process !== 'undefined' && process.env?.['SDK_ASYNC_FLUSH'] === 'microtask';
  } catch {
    return false;
  }
}

if (probeEnabled()) {
  const proto = TestRequest.prototype as any;
  if (!proto.__sdkAsyncFlushPatched) {
    const originalFlush = proto.flush;
    proto.flush = function (this: TestRequest, ...args: unknown[]): void {
      void (async () => {
        for (let i = 0; i < ASYNC_FLUSH_HOPS; i++) {
          await Promise.resolve();
        }
        originalFlush.apply(this, args);
      })();
    };
    proto.__sdkAsyncFlushPatched = true;
  }
}
