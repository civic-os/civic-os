# Test Harness Lifecycle After the SDK Program

The Frontend SDK program (`docs/notes/FRONTEND_SDK_DESIGN.md` §14) built several test harnesses to prove that moving logic into `@civic-os/core` changed nothing. Some of them test the product and stay useful for good. Others prove that a migration was faithful, and stop being useful once the migration ends: they then cost maintenance and protect nothing. This page sorts each harness into one of three groups, keep, reshape or retire, and says when to act. It also records where test coverage stood on 2026-10-31.

Short answer: about half of it is a lasting subset, and sorting the rest out is Phase 4 of the program. The data-integrity suite, the unit hygiene guards, the package contract checks, pa11y and the MCP integration suite stay as they are. The request-equivalence harness stays through Phase 3 and then becomes a smaller e2e regression suite. The assertion ledger, the divergence ledger and the "one interpreter" diff retire once the work they guard is finished.

## Keep for good

These test what the product does, not whether a refactor kept it the same.

| Harness | Where | Why it stays |
|---|---|---|
| Data-integrity suite | `tests/e2e/run-integrity.sh`, `integrity.spec.ts`, `integrity-series.spec.ts` | It is the only check that the database holds what the user typed: DateTime and DateTimeLocal across DST edges, Money, GeoPoint, M:M rows, series splits in the series zone, and "this and following" deletes (v0.78.1) that leave nothing for the worker to re-create. Bad rows outlive a code rollback, so this suite guards the worst kind of failure. Run it for any change to transforms, those controls, or the save paths. The nightly workflow, set up before Phase 3a starts, runs it in CI. |
| Unit hygiene guards | async-leak guard, frozen shared fixtures, the happy-dom window guard, `fake-time.ts`, `scripts/detect-async-leaks.mjs` | They keep the unit suite deterministic under `isolate: false`. They are unrelated to the SDK. |
| SDK package contract checks | `test:packages` (with the TZ matrix and type tests), `api:check`, `check:dogfood`, `test:sdk-consumer`, `golden:codegen:check`, publint, attw, `check:boundaries`, `check:spdx`, `check:versions` | `@civic-os/core` and `@civic-os/cli` are published packages. These checks are their public contract, for as long as they ship. |
| Raw golden captures | `tests/golden/raw` (8 examples × 5 roles) | They feed the codegen goldens and are the fixture set for core's schema-interpretation tests (see "Reshape" below). Refresh them when a migration changes the metadata views. |
| pa11y | `.github/workflows/accessibility.yml` | A product requirement (`CLAUDE.md`, Accessibility). |
| MCP integration suite | `tests/integration/run-tests.sh` | It tests the MCP server against real PostgreSQL, PostgREST and Keycloak. |
| `postgrest-api-regression-test.sh` | `tests/functional` | It checks the PostgREST upgrade contract, not the SDK. |

## Keep, reshaped

### Request-equivalence harness (`tests/e2e`, `run-equivalence.sh`)

The harness records every request a set of browser flows sends, then compares a later build's traffic and screenshots with that recording. Each flow also asserts what the user sees.

- **Through Phase 3, keep it whole.** Phase 3a swaps the forms to Signal Forms. Phase 3b needs request parity across frameworks (an Angular fixture app and a React fixture app sending the same requests). Both are the kind of change this harness is for.
- **Re-record the baselines on v0.78.0** once PR #30 merges. The baselines still date from `6a8274b5`, the commit before the P2b swaps, so each compare needs `--approved tests/golden/approved-diffs/2.json` to accept the F-18 to F-22 differences. After a re-record, Phase 3 compares start from zero approved differences.
- **After Phase 3**, the flows' interaction assertions and `--visual-base` remain a good e2e regression suite for the generic app. Exact-traffic baselines then become optional. They fail on any intended change to a query, and someone has to re-record them each time. Keep the recorder for refactors, but stop treating a baseline diff as a failure by default.
- The `alt` and `alt2` lanes and the lock files are there for parallel local runs and can stay.

### Frontend goldens (`src/app/testing/golden/*.golden.spec.ts`)

These compare the app's interpretation of each raw capture with the files in `tests/golden/derived/frontend`. Now that core is the only interpreter, the same checks belong in core as vitest specs that read the raw captures. Move them in Phase 4. At the same time, delete the goldens that still call app methods only to reproduce what the facades now own (for example `getPropsForEdit` and `getLockedFields`, which are kept only for these specs).

## Retire

These prove that the migration was faithful. Phase 4 retires each of them once its condition holds.

| Harness | Where | Retire when | What replaces it |
|---|---|---|---|
| Per-test assertion ledger and baseline | `tests/baselines/unit-ledger.json` (940 KB), `scripts/test-ledger.mjs`, the ledger reporter | Phase 4, once no more service logic moves behind Promise-based clients | Nothing in full. [3/5] Keep one cheap check, "no test runs zero assertions", through the reporter, without the per-test baseline. Today any test rename forces a ledger key rename. |
| Async-emission probe | `SDK_ASYNC_FLUSH` in `src/test-setup.ts` and `fake-time.ts` | Together with the ledger | `fake-time.spec.ts`'s ordering cases stay. |
| Divergence ledger and its tools | `tests/golden/ledger.json`, `docs/notes/SDK_DIVERGENCE_LEDGER.md`, the ledger models and mutation check | When the MCP server has no interpreter code of its own | The ledger is frozen at Gate 2 (82 rows; 68 still open). Before retiring it, sort the 68 open rows into issues or "won't fix". Do not just delete them. |
| "One interpreter" diff | `golden:interpreter`, `scripts/golden/interpreter-diff.mjs` | The same condition | `check:dogfood` already requires each core export to have a real consumer. |
| Approved-diff files | `tests/golden/approved-diffs/1.3.json`, `1.4.json`, `2.json` | After the baseline re-record above | Git history. |

`tests/golden` is 33 MB. Most of it is the raw captures, which stay. The derived MCP files and the ledger artifacts go once the conditions above hold.

## Coverage (measured 2026-10-31, v0.78.0 tree)

| Area | Statements | Branches | Functions | Lines | Reported in CI |
|---|---|---|---|---|---|
| Angular app (`ng test --coverage`) | 58.0% | 57.7% | 57.6% | 61.4% | Yes: Codecov, non-blocking, no threshold |
| `packages/core` (vitest v8; tests and `src/testing` excluded) | 97.8% | 95.6% | 99.5% | 98.8% | No |
| MCP server (`tools/mcp-server`) | 82.2% | 74.1% | 93.0% | 82.0% | No |
| Go services | not measured here | | | | Yes: Codecov |

App lines by area. Coverage counts Angular templates as lines, and most template lines run only in a rendered page, so TypeScript and HTML are shown apart:

| App area | Lines | Covered | Target in TESTING.md |
|---|---|---|---|
| `services` (TypeScript) | 2,516 | 68.8% | 85%+ |
| `components` (TypeScript) | 6,665 | 61.0% | 70%+ (smart) / 50%+ (simple) |
| `components` (templates) | 2,656 | 49.7% | |
| `pages` (TypeScript) | 4,906 | 60.9% | 60%+ |
| `pages` (templates) | 3,333 | 43.5% | |
| `sdk` (bindings) | 200 | 97.5% | |
| all TypeScript | 18,835 | 66.6% | |

Large files with the lowest coverage: `schema-editor.page.ts` (10%, 737 lines), `series-group-detail.component.ts` (32%), `user-management.page.ts` (39%), `recurrence-rule-editor.component.ts` (26%), `filter-bar.component.ts` (35%), `import-validation.worker.ts` (23%), `sql-block-transformer.service.ts` and `template-editor.component.ts` (under 1%). Several templates read 0% (`edit.page.html`, `list.page.html`) even though their page specs render them. Template line mapping is unreliable, so do not set targets on template lines.

What this means:

- **The program moved logic to where it is well tested.** The page orchestration that moved into the facades is now covered at about 98% in core. That number comes from facade specs over a fake transport, plus the harness flows, which unit coverage cannot see.
- **Nothing enforces the targets in TESTING.md.** Services are 16 points under theirs. The rest of the app's gap is in admin and editor pages that the SDK never touched.
- **Core and MCP coverage are invisible in CI.** That makes core's 98% the easiest number to lose without noticing, so core's thresholds come in Phase 3a, ahead of the rest of Phase 4.

## Phase 4: test consolidation

This work is Phase 4 of the SDK program (`docs/notes/FRONTEND_SDK_DESIGN.md` §15, gate in §14). It starts after Phase 3, because Phases 3a and 3b still need the request-equivalence harness and the assertion ledger as they stand. Three items come earlier, as preconditions of Phase 3a (Daniel, 2026-10-31):

- [4/5] **Re-record the equivalence baselines on v0.78.0 and drop `approved-diffs/2.json`** before 3a's first swap, so Phase 3 compares start from zero approved differences.
- [4/5] **Report core's coverage in CI, with thresholds.** Move core's include and exclude rules into its vitest config, add coverage to `test:packages:unit`, upload it to Codecov under its own flag, and set vitest `thresholds` a little below today's numbers (statements 97, branches 95, functions 99, lines 98). Core is the published interpreter, and 3a and 3b change it. Without a threshold, nothing in CI notices a drop. A drop there is a contract risk, not just a gap.

- [4/5] **A nightly CI workflow** (`schedule:` cron, plus `workflow_dispatch`) for the suites that need a full stack and are too slow for every PR. Moved here from Phase 4, so the 3a swaps run under it:
   - `e2e:integrity` on pothole and community-center, in both pinned zones. It goes first, because its failure means bad stored data.
   - The full-stack functional tests that CI's `test-migrations` cannot run on a bare database, starting with `tests/functional/v0-78-1-end-series-from-date-test.sh` (worker, PostgREST and Keycloak).
   - The request-equivalence `--compare` on the four harness examples, without `--visual-base`, which needs a second build.
   - `scripts/detect-async-leaks.mjs --runs 3`, which finds timing-dependent leaks that a single PR run misses.

   A failure opens or updates one tracking issue rather than emailing.

Phase 4 scope:

1. [4/5] **Trust the nightly**: 14 green nights in a row on the final Phase 3 tree, so a flaky suite is fixed before any harness it guards is retired.
2. [4/5] **Report MCP coverage in CI.** Align the MCP server's `@vitest/coverage-v8` with its `vitest`, add coverage to its `npm test`, and upload it to Codecov under its own flag. Add a floor at today's numbers once a few runs show them stable.
3. [4/5] **Put a no-regression floor on the app, not a target.** Set `thresholds` on the TypeScript files only, at today's numbers (about 66% of lines), and raise them as coverage grows. A target such as 85% would block unrelated work. A floor only stops things from getting worse.
4. [4/5] **Retire the migration harnesses**, as in the table above: the assertion ledger and the async probe, the divergence ledger (after sorting its open rows), the "one interpreter" diff, and the approved-diff files.
5. [3/5] **Move the frontend goldens into core** as vitest specs over the raw captures, and delete the app methods kept alive only for them.
6. [3/5] **Reshape request equivalence** into the generic app's e2e regression suite: the flows' interaction assertions and `--visual-base` stay, and a traffic diff becomes a report rather than a failure.

Outside Phase 4, as ongoing work:

- [3/5] **Spend new test effort by risk, not by percentage.** First come `filter-bar` (it builds PostgREST filters from user input), `import-validation.worker.ts` (bulk import correctness) and `series-group-detail` (recurring data). The schema editor and template editor matter less: they are visual and admin-only, so the harness's screenshots fit them better than unit tests. Alternative within one point: raise the services to 85% first, because services are where the TESTING.md target is clearest. Choose between the two by whether the next quarter's bugs come from the services or from these components.

## Measuring coverage locally

```bash
npm run test:ci                                                   # app; writes coverage/frontend
(cd packages/core && npx vitest run --coverage.enabled --coverage.provider=v8 \
  --coverage.include='src/**/*.ts' --coverage.exclude='src/**/*.test.ts' \
  --coverage.exclude='src/**/*.test-d.ts' --coverage.exclude='src/testing/**' \
  --coverage.reporter=text-summary)                               # core
(cd tools/mcp-server && npx vitest run --coverage.enabled \
  --coverage.reporter=text-summary)                               # MCP server
```

Core has no coverage block in its vitest config yet, so its include and exclude rules are passed on the command line. Phase 3a moves them into the config. The MCP server's `@vitest/coverage-v8` (5.0.0) trails its `vitest` (5.0.4), and vitest warns about the mismatch. Phase 4 aligns the two versions before MCP coverage goes into CI.

For the app's numbers per area, read `coverage/frontend/coverage-summary.json` and group the files by their directory under `src/app/`.
