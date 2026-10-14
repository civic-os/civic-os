# Stale test decisions and findings, P0.7c

Lane P0.7c: the cross-file flake in `runtime.spec.ts`, a sweep for the same class of leak, the last create/edit leakers, and DOMPurify write-up corrections. Application code was not changed.

## 1. Flake: `runtime.spec.ts` saw `window.location.href` = `blob:nodedata:...`

| | |
|---|---|
| Symptom | `Runtime Configuration Helpers > getKeycloakAccountUrl > should include URL-encoded referrer_uri parameter` failed in about 1 of 5 full runs with `referrer_uri=blob%3Anodedata%3A<uuid>`. |
| Culprit | `chart-widget.component.spec.ts > should have downloadCsv method callable without error` called the real `downloadCsv()` -> `exportChartAsCsv()` -> `triggerDownload()`: a real `URL.createObjectURL(blob)` and a real `<a download href="blob:...">.click()`. happy-dom follows an anchor click as a navigation (`HTMLAnchorElement.dispatchEvent` -> `window.open(href, '_self')`; main-frame navigation falls back to `Location[setURL]`), so `window.location` stayed on the blob URL for every later spec file in that worker. |
| Why it was intermittent | `isolate: false`: files in a worker share one happy-dom window, and the file-to-worker assignment changes per run. `runtime.spec.ts` failed only when it ran after `chart-widget.component.spec.ts` in the same worker. |
| Why it was hard to see | The same spec's `should handle DataService errors` installed `vi.spyOn(console, 'error').mockImplementation(() => {})` and never restored it, so every later `console.error` in that file (including leak instrumentation) was swallowed. Vitest restores spies only at the end of each file. |
| Deterministic repro | Temporary single-worker runner config with an ordering sequencer (recipe in `docs/development/TESTING.md`, "One happy-dom window per worker"). Order chart-widget -> runtime at base: 1 failed / 42 passed, received `referrer_uri=blob%3Anodedata%3A896e07b8-...`. Order runtime -> chart-widget: 43 passed. After the fix, order chart-widget -> runtime: 43 passed. |
| Fix (culprit) | The CSV test stubs `URL.createObjectURL`, `URL.revokeObjectURL` and `HTMLAnchorElement.prototype.click`, and now asserts the download (one blob of type `text/csv;charset=utf-8;`, one click, `.csv` filename, URL revoked). `downloadPng()` is awaited (`resolves.toBeUndefined()`) instead of checked with a synchronous `not.toThrow()` on a Promise. An `afterEach(() => vi.restoreAllMocks())` undoes the console and download stubs. |
| Fix (victim) | The `getKeycloakAccountUrl` describe sets the page URL explicitly with `happyDOM.setURL()` and restores it afterwards; the encoding test now asserts the exact encoded `referrer_uri` (it previously only matched `/referrer_uri=http/`). |
| Safety net | `src/test-setup.ts` fails any test that leaves `window.location` changed, names it, and resets the URL (check runs in `onTestFinished`, after every `afterEach`, so a failure does not skip TestBed teardown). A test that starts on a changed URL fails with the name of the previous test. Proven: with the old chart-widget spec it fails exactly `should have downloadCsv method callable without error` with "This test left window.location at blob:nodedata:..." and nothing else (1 failed / 42 passed). Independently, with the old chart-widget spec and without the guard, the new `runtime.spec.ts` passes in the failing order (43 passed) because it sets its own URL. The guard only adds failures. |

## 2. Sweep: global state that outlives a spec file

Method: a temporary instrumented `test-setup.ts` snapshotted, at the start of every spec file in every worker, `location.href`, `history`, `document.title`, `<html>`/`<body>` attributes and children, `localStorage`/`sessionStorage` keys (on the real storages), fake-timer state, `window.civicOsConfig`, and the identity of every own function/accessor on `globalThis`, `document`, `console`, `navigator`, `URL`, `Math`, `Date`, `JSON`, `history`, `location` and the common DOM/JS prototypes; differences from the worker's first snapshot were logged with the previous file. A per-test location check ran alongside. Plus one full run with Vitest's `detectAsyncLeaks: true`. Two full runs, all 123 files.

| State | Finding | Action |
|-------|---------|--------|
| `window.location` | Only `chart-widget.component.spec.ts` (`downloadCsv` test). | Fixed (section 1). |
| `console.error` spy | `chart-widget.component.spec.ts` left it mocked for the rest of the file. | Fixed (`afterEach(() => vi.restoreAllMocks())`). |
| Spies on globals/prototypes, `localStorage` getter | None survive into the next file: Vitest calls `vi.restoreAllMocks()` after each file. `theme.service.spec.ts` spies the `localStorage` getter without restoring it, but that only spans its own file. | None. |
| Storage contents | No keys left in `localStorage` or `sessionStorage` at any file boundary. | None. |
| `<html>` `data-theme`, `class`, `lang`, `dir`; `document.title` | Written by `ThemeService`, `LocaleService` and `Title` in many specs and never reset. Every spec that asserts them (`theme.service.spec.ts`, `locale.service.spec.ts`) sets them first in the same test. | None (benign, documented in TESTING.md). |
| Fake timers | No spec uses `vi.useFakeTimers`. | None. |
| DOM leftovers, new globals, prototype patches | None beyond `test-setup.ts`'s own polyfills. | None. |
| Timers outliving their file (`detectAsyncLeaks`, 15) | All created by application code, not tests: save-state fades in `entity-management`/`property-management` (4 s, 5 s), action auto-close in `detail.page` and `entity-action-panel`, `user-management` reloads after 5 s, `payment-checkout` status polling (500 ms, up to 60 times), pending dynamic imports in `markdown-editor`/`code-viewer`. Callbacks touch only the destroyed component's signals and mocks: no assertions, no navigation. | Not fixed (application code). `payment-checkout` polling continuing after the component is destroyed is reported to the lead as a minor app bug. |
| Module-level singletons | `auth-error.interceptor.ts` `isRedirecting` (reset in `login().finally`, and the spec's `login` mock resolves); `static nextInstanceId` counters (no spec asserts generated ids). | None. |

## 3. Last leakers (create/edit)

Each assertion now runs inside its test after awaiting. Every newly-effective assertion passed against current application code with no change to its expectation; nothing was stale.

| Test | Was | Now | Ledger |
|------|-----|-----|--------|
| `CreatePage > Form Validation UX > should hide error banner when form becomes valid` | Asserted inside `properties$.subscribe(async ...)` after a 50 ms wait, after the test ended. | `await firstValueFrom(properties$)`, submit, patch, `await fixture.whenStable()`, assert. | 1 -> 2 |
| `EditPage > Form Validation UX > should hide error banner when form becomes valid` | Same, on `data$`. | Same, on `data$`. | 1 -> 2 |
| `CreatePage > Token Refresh > should show 401 error modal when token refresh fails` | Assertions inside `properties$.subscribe(async ...)` after a 10 ms wait. | `await firstValueFrom(properties$)`, submit, in-test 10 ms wait (the same pattern as the sibling token tests), assert; adds `updateToken` called with 60. | 0 -> 5 |
| `CreatePage > Token Refresh > should not call createData when token refresh fails` | Same. | Same; the added `updateToken` assertion makes "createData not called" non-vacuous (it would also hold if `submitForm` returned early on an invalid form). | 0 -> 2 |

Mutation check (application code changed temporarily, then restored): removing the banner-hiding branch of the `statusChanges` subscription in `create.page.ts` and `edit.page.ts`, and the `showErrorModal.set(true)` in `create.page.ts`'s token-refresh `catch`, fails exactly the three tests that assert them (`hide error banner` x2, `show 401 error modal`).

The four tests that received these late assertions (`should call updateToken before form submission`, `should proceed with submission when token refresh succeeds`, `EditPage > Route Parameter Changes > should reload data when entityId changes`, `should add seconds to DateTime value on submit`) now record their baseline minimum on every run; they are no longer unstable.

## 4. DOMPurify under happy-dom (corrects P0.6 wording)

Probe (temporary spec, DOMPurify 3.4.14, happy-dom 20.14.0; `markdownSanitize` and plain `DOMPurify(window).sanitize` gave identical output):

| Input | Output under happy-dom |
|-------|------------------------|
| `<button onclick="alert(1)">Click</button>` | `Click` |
| `<h1>Title</h1><p>Text with <strong>bold</strong></p>` | `Title<p>Text with <strong>bold</strong></p>` |
| `<a href="https://example.com" target="_blank" rel="...">Link</a>` | `Link` |
| `<p>Hello</p><script>alert("xss")</script>` | `Hello<script>alert("xss")</script>` |
| `<span>x</span><button onclick="y">B</button>` | `x<button onclick="y">B</button>` |
| `<p>x</p><a href="javascript:alert(1)">j</a>` | `x<a href="javascript:alert(1)">j</a>` |
| `<div><a href="..." target="_blank">Link</a></div>` | `<a href="..." target="_blank">Link</a>` |

DOMPurify drops the tag of the first top-level element and returns that element's content and every later sibling untouched. An `uponSanitizeElement` hook is called twice without a `tagName` and never for the real elements.

Finding: the four iframe tests that remain in `markdown-sanitize.spec.ts` are vacuous under happy-dom. Mutation check: inverting the allowlist in `markdown-sanitize.ts` (allow non-YouTube, reject YouTube) left all 4 unit tests green, while `tests/functional/markdown-sanitize-browser-test.cjs` failed 5 of 10 on the same mutation (10/10 on clean code). The spec comment now says so. Kept as they are (they still show `markdownSanitize` runs under happy-dom); whether to delete them or replace them with a unit test of the hook logic is an open decision for the lead.

## 5. Verification

| Check | Result |
|-------|--------|
| 10 consecutive full `npm run test:headless` runs (with `SDK_LEDGER_OUT`) | 10/10 green: 123 files, 3087 passed, 0 skipped, 5689 assertions every run. No test varies in state or count across the 10 runs (no unstable tests remain). |
| 3 full runs under `SDK_ASYNC_FLUSH=macrotask` | 3/3 green; per-test counts identical to the plain runs (0 decreased, 0 increased, 0 state changes) for all 3087 tests. |
| Ordered repro (chart-widget -> runtime, one worker) | base: 1 failed; after: 43 passed. |
| `tests/functional/markdown-sanitize-browser-test.cjs` | 10/10 on clean code; 5/10 fail with the allowlist inverted. |

