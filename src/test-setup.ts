/**
 * Global test setup for Vitest.
 *
 * This file runs before each test file. It patches missing browser APIs
 * that jsdom/happy-dom do not implement but our components rely on.
 */

// jsdom does not implement window.alert / window.confirm
if (typeof window !== 'undefined') {
  window.alert = window.alert ?? vi.fn();
  window.confirm = window.confirm ?? (vi.fn() as any);
}

// jsdom does not implement HTMLDialogElement.showModal / .close
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}

// jsdom does not implement HTMLCanvasElement.getContext
if (typeof HTMLCanvasElement !== 'undefined' && !HTMLCanvasElement.prototype.getContext) {
  (HTMLCanvasElement.prototype as any).getContext = () => null;
}

// ---------------------------------------------------------------------------
// Assertion ledger (SDK program). Records, per test, how many expect() calls
// ran during the test lifecycle (body + hooks) so a vitest reporter
// (scripts/vitest-ledger-reporter.mjs) can emit a ledger. Assertions that run
// after the test finished (the "vacuous" async case) are deliberately not
// counted. Registered in the setup file so it is the last afterEach to run
// (vitest runs after-hooks in reverse registration order).
// ---------------------------------------------------------------------------
afterEach((ctx: any) => {
  try {
    // Vitest keeps assertionCalls on the global expect unless the test uses a
    // test-local expect (concurrent tests), mirroring its own bookkeeping.
    const source = ctx.task.context?._local ? ctx.expect : expect;
    ctx.task.meta.ledgerAssertions = source.getState().assertionCalls ?? 0;
  } catch {
    // never let instrumentation affect a test
  }
});
