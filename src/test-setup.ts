/**
 * Global test setup for Vitest.
 *
 * This file runs before each test file. It patches missing browser APIs
 * that jsdom/happy-dom do not implement but our components rely on.
 */

// Specs that render <iframe src="..."> (markdown video embeds, sanitizer
// allowlist checks) must never reach the real network: by default happy-dom
// navigates iframes with a live HTTP request (youtube-nocookie.com, evil.com),
// which prints socket/ECONNREFUSED/document.write stack traces and makes the
// suite network-dependent.
if (typeof window !== 'undefined' && (window as any).happyDOM?.settings) {
  (window as any).happyDOM.settings.disableIframePageLoading = true;
}

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
// Shared-window guard. Angular's Vitest builder runs with isolate: false, so
// every spec file in a worker shares one happy-dom window. A test that
// navigates it (an un-stubbed <a download href="blob:..."> click is followed
// as a navigation) changes window.location for every later file and fails
// some unrelated spec later. This guard fails the test that left the window
// on a different URL, names it, and restores the base URL so the failure
// does not cascade. It only ever adds failures, it never passes a test.
// The end-of-test check runs in onTestFinished, i.e. after every afterEach
// (the spec's own restores and Angular's TestBed teardown), and an error
// there fails the test without skipping any other cleanup.
// ---------------------------------------------------------------------------
{
  const shared = globalThis as any;
  shared.__civicOsBaseHref ??= window.location.href;
  const baseHref: string = shared.__civicOsBaseHref;
  const label = (task: any): string => {
    let name: string | undefined = task.fullTestName;
    if (!name) {
      const names: string[] = [];
      for (let t = task; t && !('filepath' in t); t = t.suite) names.unshift(t.name);
      name = names.join(' > ');
    }
    return `${task.file?.name ?? '?'} > ${name}`;
  };
  const resetTo = (href: string) => (window as any).happyDOM?.setURL(href);

  beforeEach((ctx: any) => {
    ctx.onTestFinished(() => {
      shared.__civicOsLastTest = label(ctx.task);
      const href = window.location.href;
      if (href !== baseHref) {
        resetTo(baseHref);
        throw new Error(
          `This test left window.location at ${href} (expected ${baseHref}). The happy-dom window is ` +
          `shared by all spec files in a worker, so stub the navigation (for downloads: ` +
          `URL.createObjectURL and HTMLAnchorElement.prototype.click) or restore the URL. ` +
          `The URL has been reset.`,
        );
      }
    });

    const href = window.location.href;
    if (href !== baseHref) {
      resetTo(baseHref);
      throw new Error(
        `window.location was ${href} when this test started (expected ${baseHref}). ` +
        `It changed after "${shared.__civicOsLastTest ?? '(no earlier test)'}" ended: async work that ` +
        `outlived that test, or an afterAll hook that ran after it, navigated the shared happy-dom window. ` +
        `The URL has been reset.`,
      );
    }
  });
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

// Async-emission probe (inert unless SDK_ASYNC_FLUSH is set; see async-flush-probe.ts).
import './app/testing/async-flush-probe';
