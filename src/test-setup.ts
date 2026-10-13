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
