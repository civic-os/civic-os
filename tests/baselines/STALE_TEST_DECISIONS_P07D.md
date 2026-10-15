# Stale test decisions and findings, P0.7d

Lane P0.7d: async work that outlived its spec file (the 1-in-11 teardown flake), a standing guard against it, the ledger `--update --from` hole, and the sanitizer binding message. Application code was not changed; application bugs found on the way are listed in section 5 for Daniel.

## 1. The teardown flake

| | |
|---|---|
| Symptom | In 1 of 11 full runs Vitest exited 1 although 3092/3092 tests passed, with one unhandled error: `EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending`, attributed to `src/app/services/analytics.service.spec.ts`. |
| Mechanism | A `console.*` call made while a worker is shutting down. Angular's runner uses `isolate: false`, so async work started by one spec file keeps running through the later files of the same worker and can still be running when the worker closes its RPC channel. The error names whichever file ran last in that worker; `analytics.service.spec.ts` is synchronous and only happened to be last. |
| Sources (all removed) | At the base commit, leftover work that logs: (a) every `code-viewer.component.spec.ts` test rendered `BlocklyViewerComponent`, whose `initWorkspace()` finishes after the test (Blockly is a large dynamic import) and logs `console.error('Blockly initialization failed: Error: Cannot find module 'jsdom'')`; an ordered single-worker run shows all ten errors attributed to the file, not to a test, i.e. after its tests ended; (b) the 1.5 s auto-close timer in `entity-action-panel` emits `actionExecuted` on a destroyed component, which Angular reports with `console.warn` (NG0953; the spec's `emit` spy is restored at the end of the file); (c) `payment-checkout`'s confirmation poll logs with `console.log` 500 ms later and emits on the destroyed component. Any of them landing during shutdown gives exactly this error. Not reproduced deterministically (it needs a worker to close inside that window under full parallel load); every candidate is gone and the guard keeps new ones out. |

## 2. Leaks found and how each spec was fixed

Found with Vitest's `detectAsyncLeaks` (4 full runs), the new guard (section 3) over 30+ full runs, and worst-case probes (temporary, reverted, never committed): a 2 s delay in front of every application `await import(...)` makes the guard name every spec file that leaves a dynamic-import initialization running when its file ends; stretching every `setTimeout` created by application code 20x (capped at 2 s) names every spec file whose app timers would still be pending at file end on a slow machine. The second probe found the edit page's scroll-to-error timer. A third (the FK search modal's 60 ms focus-retention delay raised to 2 s) showed that `edit-property` is the only spec besides the modal's own that leaves it pending.

| Spec (test) | Leaked work (application code) | Fix in the spec | Assertions |
|---|---|---|---|
| `entity-action-panel` (execute on confirm; non-confirmation flow; pass param values) | 1.5 s auto-close timer after a successful action (`entity-action-panel.component.ts:266`) | Fake `setTimeout` installed after `whenStable()`, timer advanced inside the test | +7: `actionExecuted` emitted exactly once after 1.5 s (the test's title promised it but never asserted it), modal closed, success message cleared, param form dropped |
| `detail.page` (two gallery-action tests) | Same timer (`detail.page.ts:1382`) | Same | +3: modal closed; `refreshCounter` incremented when the response asks for a refresh |
| `entity-management.page`, `property-management.page` (save on blur, saved indicator, refresh cache) | 4 s fade and 5 s removal of the saved checkmark (`entity-management.page.ts:342,349`, `property-management.page.ts:398,405`) | Fake `setTimeout` before `onFieldBlur`; the real 10 ms waits became `advanceTimersByTimeAsync(10)`; timers advanced to the end | +6: checkmark fading after 4 s, gone after 5 s |
| `user-management.page` (create success, `onImportSuccess`) | 5 s reload and message clear (`user-management.page.ts:551-552, 739-740`) | Fake `setTimeout`, advanced 5 s | +4: one more `getManagedUsers` call, message cleared |
| `payment-checkout` (polling when no client secret) | 500 ms re-poll, up to 60 times (30 s), never stopped (`payment-checkout.component.ts:156`) | Fake `setTimeout` for the whole test; the real 100 ms wait removed; the poll is driven to its end | +5: one request per 500 ms, 61 in total, then the timeout error and `loading` false |
| `payment-checkout` (successful confirmation) | 500 ms delayed `paymentSuccess` emit with logging (`payment-checkout.component.ts:287`) | Fake `setTimeout`, advanced 500 ms | +3: not emitted before 500 ms, emitted with the payment id after, `processing` false |
| `create.page`, `edit.page` (Form Validation UX describes) | 100 ms `scrollToFirstError` timer (`create.page.ts:514`, `edit.page.ts:602`) that focuses an element of the shared document | Fake `setTimeout` per test; `afterEach` runs the pending timer while the fixture is alive, then restores real timers | none |
| `fk-search-modal` (whole file) | 60 ms focus-retention timer scheduled on every results render while open (`fk-search-modal.component.ts:254`), plus the flake below | The spec runs on fake `setTimeout`/`setInterval`/`Date`; `waitForData()` advances 100 ms instead of waiting 100 ms of real time; `afterEach` clears what the last render left | none (file time 7 to 15 s -> under 1 s) |
| `edit-property` (FK search tests) | Same focus-retention timer from the hosted modal | File-level `afterAll(waitOutFkSearchFocusRetention)` from `testing/lazy-components.ts` waits 60 ms (Node fires equal-duration timers in creation order) | none |
| `time-slot-calendar` (every test) | Animation frame requested by FullCalendar's destroy (happy-dom `requestAnimationFrame` is a `setImmediate`) | `afterEach` awaits one more animation frame after `fixture.destroy()` | none |
| `code-viewer`, `entity-code.page` | `BlocklyViewerComponent` lazy-loads Blockly and logs after the test (see 1a) | `BlocklyViewerComponent` replaced by `src/app/testing/blockly-viewer.stub.ts` (same selector and inputs); Blockly stays covered by its own spec | none |
| `blockly-viewer`, `markdown-editor`, `geo-point-map`, `display-property`, `edit-property`, `map-widget`, `list.page` | `await import()` of Blockly, TipTap, `leaflet.markercluster`; the continuation built a workspace, editor or Leaflet map on a detached element after the fixture was destroyed | `afterEach(async () => { await settleLazyComponents(fixture); })` from `src/app/testing/lazy-components.ts`: waits until every lazy component in the fixture whose view initialized has finished, so `ngOnDestroy` disposes what it built | none |

**Flake found on the way** (`fk-search-modal`, `Server Filter > should use serverFilter instead of rpcIdFilter when both are available` and `Fallback for unregistered entities > should fall back gracefully when entity not in SchemaService`): failed together in 1 of the first 15 verification runs, with the machine at load average 15 to 60 from other lanes. Both found `getDataPaginated` not yet called after `waitForData()`. Reloads go through `debounceTime(50)` on the real RxJS async scheduler (`setInterval` plus `Date.now()`), and `waitForData()` waited a fixed 100 ms of real time before asserting, so under heavy load the assertion could run before the debounced load. Converting the spec to fake timers (including `Date`, which `debounceTime` reads) makes the order deterministic. Same 58 tests, same assertions.

**Second load-sensitive test** (`list.page`, `Map Display Logic > should handle null location values in map markers`): failed once (markers empty after a fixed 100 ms real-time wait) in a later verification run; 0 failures in 5 isolated repeats. The three map tests that waited a fixed time for the debounced data path now wait for the condition (`vi.waitFor` with a throwing callback, so no extra assertion counts) and then assert exactly as before.

No assertion was weakened or removed; added assertions run inside their tests. Fake timers fake only `setTimeout`/`clearTimeout` so RxJS schedulers (`setInterval`), `Date` and Angular's animation-frame path stay real, and every file that installs them restores real timers in an `afterEach`.

## 3. Standing guard: `src/app/testing/async-leak-guard.ts`

- One `node:async_hooks` hook per worker (via `process.getBuiltinModule`, so the bundle needs no Node types) records each Timeout and Immediate created while a file runs, with an unformatted creation stack and the timer whose callback created it.
- A setup-level `afterAll`, registered from `src/test-setup.ts` and therefore last to run, waits one `setTimeout(0)` and one `setImmediate` (tracking stays on, so a loop's replacement timer is still seen), then fails the file by name if a timer is pending (not `_destroyed`, i.e. not cleared or fired, and `hasRef()`) whose own creation stack has a frame under the project's `src/`. The error lists each timer (`setTimeout(1500 ms)`, `setInterval(1000 ms)`, `setImmediate / requestAnimationFrame`) with its spec and app frames and where its chain started. The timers are then cancelled so the failure cannot cascade.
- False positives handled: Vitest's task-update throttle timer, happy-dom `AsyncTaskManager` bookkeeping after animation frames and Angular's zoneless scheduler have no `src/` frame of their own. An earlier variant that also attributed timers through their chain origin flagged six files for exactly such 1 ms happy-dom timers; attribution now requires an own `src/` frame. Cleared timers stay in the map until Node emits their batched destroy hook; `_destroyed` excludes them.
- Negative test (temporary spec, not committed): a 3 s timeout, a 200 ms polling chain, an interval, a `requestAnimationFrame` loop and a zero-delay polling loop were all reported (5 timers); a cleared timeout, a cleared immediate and an unref'd timeout were not.
- Cost: none measurable (full run 15.98 s with the guard vs 16.27 s before).
- Not covered by design: work pending only as a promise, and loops driven purely by library code. `node scripts/detect-async-leaks.mjs [--runs N]` runs Vitest's `detectAsyncLeaks` (it tracks promises and follows trigger chains) and exits 1 on any leak or failed run; Vitest itself only prints leaks. Negative test: a spec leaving `new Promise(() => {})` pending makes it fail with `PROMISE leaking in src/app/zz-leak-probe.spec.ts`. It roughly doubles run time, so it is a separate gate. Suggested root script for the lead: `"test:leaks": "node scripts/detect-async-leaks.mjs"`.

## 4. Ledger `--update --from` hole

`acquireCurrent()` returned `runExit: 0` for any `--from` file, so the "refusing to update baseline from a failing run" check never fired, and a passed -> failed test was classed as STATE REGRESSED, which `--accept-state-regressions` waived.

- `--update` now refuses, with no waiver flag, any run in which a test's current state is `failed` (new or existing test, with or without `--from`), and any `--from` file whose recorded run outcome is failing.
- `scripts/vitest-ledger-reporter.mjs` records the outcome (`run: { reason, unhandledErrors }`, from Vitest's `onTestRunEnd`), so a failed `afterAll` (for example the new guard) or an unhandled error counts even when every test passed. Raw files without `run` are judged by test state only. Compare mode reports a failing recorded outcome as a PROBLEM.
- STATE REGRESSED is now only passed -> skipped/todo; docs aligned (`docs/development/TESTING.md`, script header).
- `scripts/test-ledger.test.mjs` (`node --test`, 23 tests): failed state refused in update mode even with every accept flag (existing and new test); failing recorded outcome and unhandled errors refused; passing and legacy `--from` files written; for each of DECREASED, DISAPPEARED, NEWLY UNSTABLE and STATE REGRESSED: refused without its flag, still refused with the other three flags, written with its own flag and recorded in `acceptedChanges`; with all four present, omitting one flag names only that category; passed -> todo is STATE REGRESSED and skipped -> passed is STATE CHANGED; compare mode with `--from` fails on a failing outcome and on passed -> failed and passes otherwise. Mutation checks: disabling the failed-state refusal fails 2 tests; ignoring the recorded outcome fails 2 tests. Suggested root script: `"test:ledger:self": "node --test scripts/test-ledger.test.mjs"`.

## 5. Application bugs (not fixed; for Daniel)

1. **`payment-checkout` keeps polling after it is closed or destroyed** (`src/app/components/payment-checkout/payment-checkout.component.ts`; the component has no `ngOnDestroy`/`DestroyRef`). `pollPaymentStatus()` re-arms itself with `setTimeout(..., 500)` at line 156 for up to 60 attempts (30 s) while `provider_client_secret` is null, and nothing cancels it: neither `handleClose()` (line 318) nor destroying the component. Each attempt is a PostgREST `GET /payment_transactions?id=eq.<id>&select=id,amount,processing_fee,total_amount,provider_client_secret,status`, so closing the modal or navigating away during PaymentIntent creation leaves up to 60 requests running. Reopening the modal within that window starts a second loop next to the first (the `isOpen` effect calls `loadPaymentData()` again); both then set the client secret and both schedule `initializeStripe()` (line 176, 100 ms), which can mount two Payment Elements. After destroy, `initializeStripe()` still finds the old `paymentElementRef` and mounts Stripe's iframe into a detached element. After a confirmed payment, `pollForPaymentSuccess()` (line 298, 1 s up to 15 times) likewise outlives the component and finally emits `paymentSuccess` on a destroyed component (line 290 or 305; Angular dev mode warns NG0953 and the parent never hears it). Fix: keep the timeout handles (or use RxJS `timer` + `takeUntilDestroyed`), cancel them in `handleClose()` and on destroy, and guard `initializeStripe()` on a destroyed flag.
2. **Entity action auto-close fires after navigating away** (`src/app/pages/detail/detail.page.ts:1382`, `src/app/components/entity-action-panel/entity-action-panel.component.ts:266`). The 1.5 s timer after a successful action is never cleared. If the user leaves within 1.5 s, it still runs `router.navigate([navigateTo])` (detail line 1391, panel line 270), pulling the user back to the action's target page, or refreshes the old record (`refreshData()`, detail line 1393: extra PostgREST requests) / emits on a destroyed component (panel line 272, NG0953). `detail.page.ts:1365` also subscribes to `executeRpc` without `takeUntilDestroyed`.
3. **Timers outliving their page, harmless but leaky**: `user-management.page.ts:551-552, 739-740` (a reload 5 s after create/import still issues the user-list request after leaving the page); `create.page.ts:514` (`scrollToFirstError` may focus an invalid control of the next page within 100 ms); `entity-management.page.ts:342,349` and `property-management.page.ts:398,405` (checkmark timers, signals only); `fk-search-modal.component.ts:254` (focus-retention timer).
4. **Lazy components finish initializing after destroy** (`markdown-editor.component.ts:176`, `blockly-viewer.component.ts:115`, `geo-point-map.component.ts:131`, `geo-polygon-map.component.ts:111`): if the component is destroyed before its dynamic import resolves, the continuation still creates the TipTap editor, Blockly workspace or Leaflet map on a detached element, and `ngOnDestroy` has already run, so it is never disposed (Leaflet keeps its window listeners). A destroyed flag checked after the `await` fixes all four.

## 6. Sanitizer binding message

`markdown-sanitize.spec.ts` probed the binding by counting fresh-instance creations only, so a `markdownSanitize()` that switched to the shared global instance (`DOMPurify.addHook/sanitize`) was reported as "already loaded with the real dompurify". The probe now also counts calls on the fake's global instance and fails every test with one of two messages. Mutation check (temporary `const purify = DOMPurify;` in `markdown-sanitize.ts`, reverted): 9 failed, each with "markdownSanitize() called the shared global DOMPurify instance ... markdown-sanitize.ts is correctly bound to this spec's fake; the module itself changed." The real-dompurify message is unchanged in substance and now also mentions the remaining possibility that `markdownSanitize()` no longer calls DOMPurify at all.

## 7. Verification

Machine shared with other lanes; load average 10 to 60 on 10 cores during the runs.

| Check | Result |
|---|---|
| 15 consecutive `npm run test:headless`, final state (`c733d5a3`) | 15/15 exit 0, 3092/3092 passed, no guard failures, no unhandled errors (16.3 to 23.4 s per run) |
| Earlier batches (recorded, not hidden) | Batch 1 (before the FK search modal fix): 14/15; run 9 failed the two FK search modal tests above. Batch 2 (before the list fix): 13/15; run 12 took 84 s against 16 s normally (CPU starvation) and timed out five FullCalendar tests (`calendar-widget` x4, `time-slot-calendar` x1, 5 s test timeout, then `NG0205` from their teardown) and the real-time polling test `file-upload.service > should complete full upload workflow with thumbnails` (`expectOne` after a fixed 10 ms wait); run 15 failed the list map test above. The starvation failures were not reproduced in 5 isolated repeats and are left as is (see open questions in the hand-off). |
| `SDK_ASYNC_FLUSH=macrotask node scripts/test-ledger.mjs`, twice | LEDGER OK both times; 3092 tests, 5746 assertions (baseline 5718), 11 tests INCREASED, none decreased |
| `node scripts/test-ledger.mjs` | LEDGER OK, same numbers; the raw ledger now records `run: {"reason":"passed","unhandledErrors":0}` |
| `node scripts/detect-async-leaks.mjs --runs 3` | OK, 0 leaks in 3 full runs (plus 3 earlier detector runs after the first fixes, also 0) |
| `node --test scripts/test-ledger.test.mjs` | 23/23 pass |

Assertion increases (all from assertions added inside the tests, section 2): `entity-action-panel` execute on confirm 2 -> 5, non-confirmation 2 -> 4, pass param values 1 -> 3; `payment-checkout` polling 3 -> 8, successful confirmation 2 -> 5; `detail.page` gallery UUID 1 -> 3, skip gallery 1 -> 2; `entity-management` and `property-management` saved indicator 2 -> 5 each; `user-management` create success and `onImportSuccess` 3 -> 5 each.

## 8. Follow-up (lead decision): no fixed real-time waits anywhere in the unit suite

Lead decision on the open question: a test that fails under CPU starvation is flaky; convert, do not accept.

Sweep: every `setTimeout(resolve, N)` / `setTimeout(r, N)` wait, custom polling helper and `vi.waitFor` in `src/app/**/*.spec.ts` and `src/app/testing/**`. About 325 fixed waits in 24 spec files were converted. New helpers in `src/app/testing/fake-time.ts`: `useFakeTimeInEachTest()` (fake `setTimeout`/`setInterval`/`Date` per test, cleared and restored before TestBed teardown), `advanceTime(ms)` (real tick, `ms` of fake timers, real tick), `runFakeTimeUntil(promise)` (advance fake time until a time-based value arrives, 4 s wall-clock budget). `settle()`/`awaitRequest()` in `await-http.ts` now work on real and fake time.

| Spec | Waits converted | Other changes |
|---|---|---|
| `file-upload.service` | 24 (10, 550, 1050 ms steps of the upload workflow; 20 x 550 ms in the polling-timeout test) | Polling-timeout test advances the final 500 ms before awaiting the rejection; its explicit 15 s timeout removed (the test takes 54 ms, was 11.6 s) |
| `list.page` | 25 | `firstValueFrom(component.data$)` subscribes, advances 10 ms, then awaits; map tests keep the condition wait from `c733d5a3` |
| `many-to-many-editor` | 38 | |
| `property-management.page` | 33 | Per-test `setTimeout`-only fake timers from section 2 folded into the file-level fake time |
| `entity-management.page` | 20 | Same |
| `dashboard.page` | 25 | Mocks that emit after `setTimeout(50)` now run on fake time |
| `calendar-widget` | 26 | FullCalendar child stubbed (`testing/time-slot-calendar.stub.ts`); see below |
| `dashboard-selector` | 18 | Same as dashboard.page for its delayed mocks |
| `map-widget` | 15 | |
| `payment-checkout` | 14 | Section 2 per-test fake timers folded in |
| `filtered-list-widget` | 13 | |
| `edit-property` | 12 | |
| `edit.page` | 12 | Form Validation UX `afterEach` keeps `runOnlyPendingTimers()` |
| `theme.service` | 11 | |
| `detail.page` | 9 | 6 `await firstValueFrom(component.data$)` and one awaited emission promise wrapped in `runFakeTimeUntil` (the data path ends in `debounceTime(0)`) |
| `save-progress` | 8 | |
| `create.page` | 7 | As edit.page |
| `time-slot-calendar` | 5 | Explicit 20 s per-test budget, see below |
| `geo-point-map` | 3 | Its own polling `waitFor` (real `setTimeout` + `Date`) now delegates to `vi.waitFor` with a 4 s budget (the markercluster import is real I/O); the coordinates-emission test awaits via `runFakeTimeUntil` |
| `auth.service` | 2 (0 ms) | Uses the fake-time-aware `settle()` |
| `guided-form-review-section` | 2 | |
| `chart-widget` | its `settle()` helper | |
| `action-bar` | 1 (inside its polling helper) | |
| `fk-search-modal` | its `waitForData()` | Converted in `44eabab2` |

**FullCalendar timeouts** (`calendar-widget` x4, `time-slot-calendar` x1, run 12 of batch 2): nothing in them waits on time; each test renders a full FullCalendar view, a Preact tree built synchronously on change detection, about 300 to 900 ms of CPU under happy-dom, and the starved run was 5x slower overall. `calendar-widget` tests the widget, not the calendar, so its spec swaps in a stub with the same selector, inputs and outputs (file time ~1 s, was 3.5 to 10 s). The ledger then flagged `Deduplication > should prevent duplicate requests with same params` (1 -> 0): it read the range the real calendar reports on init and skipped its assertion when there was none. It now reports a range itself and asserts unconditionally (1 -> 2). `time-slot-calendar` is the FullCalendar wrapper's own spec, so the rendering is the subject under test; its describe declares `{ timeout: 20_000 }` with the reason in a comment (checked: with `{ timeout: 1 }` 16 of its 29 tests time out, so the option applies).

**Verification under CPU pressure** (spec code at `63ea6771`; the commit after it changes only docs):

| Check | Result |
|---|---|
| 15 consecutive `npm run test:headless` with 8 x `yes > /dev/null` running for the whole batch (plus other lanes; load average 143 at the start, 211 at the end, on 10 cores) | 15/15 exit 0, 3092/3092 passed, no guard failures, no unhandled errors (9.9 to 23.2 s per run) |
| `node scripts/test-ledger.mjs` | LEDGER OK: 3092 tests, 5747 assertions (baseline 5718), 12 increased, 0 decreased |
| `SDK_ASYNC_FLUSH=macrotask node scripts/test-ledger.mjs`, twice | LEDGER OK both times, same numbers |
| `node scripts/detect-async-leaks.mjs --runs 3` | OK, 0 leaks |
| `node --test scripts/test-ledger.test.mjs` | 23/23 |

The 12th increase is the calendar-widget deduplication test above (1 -> 2). Before the conversion a normal full run took about 16 s; the files converted to fake time now finish in well under a second each (file-upload 15 s -> 0.05 s, fk-search-modal 8 s -> 0.9 s, list 3-7 s -> 0.9 s).

