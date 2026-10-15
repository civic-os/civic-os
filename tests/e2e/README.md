# Request-equivalence harness

For the same user actions against the same fresh example instance, the app
must send the same PostgREST requests before and after a refactor. This
directory records those requests per scripted step, commits them as
baselines, and diffs later runs against them. It is the regression gate for
the Frontend SDK program (`docs/notes/FRONTEND_SDK_DESIGN.md` §14). It also
captures a screenshot per step for visual comparison between two git refs;
these replace BackstopJS.

It is a standalone npm package, not a root workspace member, and it runs only
locally. It is not part of CI.

## Setup

```bash
cd tests/e2e
npm ci
npx playwright install chromium
npm run test:lib          # unit tests for the normalizer and comparator
```

The root checkout also needs `npm ci`, because the runner starts `ng serve` from it.

## Running

```bash
tests/e2e/run-equivalence.sh <example> --compare               # the gate
tests/e2e/run-equivalence.sh <example> --record                # write baselines (lead only)
tests/e2e/run-equivalence.sh <example> --visual-base <git-ref> # screenshots: <ref>'s app vs this checkout's app
```

`<example>` is one of `pothole`, `neighborhood-hub`, `community-center` or
`client-intake`. Each has a flow file `flows/<example>.spec.ts` and a pinned
compose env file `env/<example>.env`.

Each run does the following:

1. Acquires the standard-port lock. Set the path with `E2E_STD_LOCK`; it
   defaults to `$TMPDIR/civic-os-e2e-std.lock`. If you already hold the lock,
   set `E2E_LOCK_HELD=1`.
2. Recreates the example stack as compose project `sdk-<example>` with
   `down -v` then `up -d --build`. It starts every service except
   `swagger-ui`, `mcp-server` and `payment-worker`.
3. Waits for PostgREST, the Keycloak realm, and init-time background jobs
   (`metadata.river_job`).
4. Starts `ng serve` from this checkout on exactly `:4200`.
5. Logs each role in through the real Keycloak login page.
6. Runs the flows, normalizes the recordings, and tears everything down
   again, including the lock.

Teardown only removes this project's own services, their anonymous volumes
and its named volumes. A container that merely carries the
`com.docker.compose.project=sdk-<example>` label, for example one started
from an image this project built, is reported and left alone.

On a loaded Docker VM, Postgres init (migrations plus init scripts on the
amd64 image) or Keycloak startup can overrun the compose healthcheck
window. The runner then prints the VM's memory and per-container usage,
waits up to 15 minutes for every healthcheck to report healthy, and starts
the remaining services. If the image build cannot reach the Docker registry
(base image metadata), the runner prints a WARNING and starts the images
this project built earlier. Those images may predate local changes under
`docker/` or `services/`.

If the host loses its network during a run, the app shows its offline
banner and flows fail. That is an environment failure, not a diff: re-run.

Development options:

| Option | Effect |
|---|---|
| `--keep-stack` | Leaves the stack and dev server up. |
| `--reuse-stack` | Uses a stack left up by `--keep-stack`. |
| `--grep <re>` | Runs a subset of flows. |
| `--keep-base` | With `--visual-base`, keeps the base worktree for the next run. |

Never use the first three options for gate runs. `--record` refuses
`--reuse-stack` and `--grep`.

Outputs go under `tests/e2e/.artifacts/<example>/` (gitignored):
- `compare/compare-report.txt`
- `compare/normalized/`
- `*/raw/`: the un-normalized recordings
- `*/screenshots/`
- `*/test-results/`: Playwright traces of failed flows
- `visual/report/report.txt` and its `*.diff.png` files

### npm scripts (root, proposed)

The root `package.json` belongs to the lead. These are the scripts this
package expects to be added there:

```bash
npm run e2e:install                            # npm --prefix tests/e2e ci && npx --prefix tests/e2e playwright install chromium
npm run e2e:lib                                # npm --prefix tests/e2e run test:lib
npm run e2e:equivalence -- <example> --compare # tests/e2e/run-equivalence.sh
```

## What is recorded

The recorder listens passively to the browser context's `request`,
`requestfinished` and `requestfailed` events. Routing is used for one thing
only: aborting every origin outside the local stack. That covers Matomo
(`stats.civic-os.org`), map tiles, Google Fonts, Stripe.js and YouTube.

| Origin | Recorded |
|---|---|
| PostgREST `:3000` | Fully: method, path, decoded query multimap, selected headers, canonical JSON body, response status |
| Keycloak `:8082` | Count of OIDC endpoint calls (`/protocol/openid-connect/*`) per step; bodies never diffed |
| MinIO `:9000` | XHR/fetch only (presigned PUT/GET): method, masked path, status; the presigned query is dropped. `<img>` loads are not recorded |
| App `:4200` | Not recorded |

The recorded headers are `Accept`, `Accept-Language`, `Accept-Profile`,
`Content-Profile`, `Content-Type`, `Prefer`, `Range`, `Range-Unit` and
`X-Impersonate-Roles`. `Authorization` is reduced to `Bearer <present>`.
`Accept` and the profile headers go beyond the minimum because they change
PostgREST semantics: a single-object response, or a different schema.

Every request belongs to the `test.step` that was active when it started. A
step ends only when nothing is in flight and nothing new has started for
2 s. The idle window is longer than the 1 s thumbnail poll, the
`debounceTime(300)` chains and the detail page's 1.5 s post-action refresh
timer. Flows also wait explicitly for the UI effect of such timers, for
example the action dialog closing. Inside a step, requests compare as a
multiset, because parallel requests such as `forkJoin` have no fixed order.

The 2 s window and the "dialog closed" waits mirror the app's 1.5 s
auto-close-then-refresh timer after an entity action
(`detail.page.ts` around line 1382, `entity-action-panel.component.ts`
around line 266). That timer is a known app bug. If it changes, revisit
these waits and the window, then re-record.

## Comparison levels

- **Semantic: fails the run.** Compares decoded, param-order-insensitive
  request multisets per step (with counts), Keycloak OIDC call counts, and
  MinIO call patterns. Missing or extra steps and flows also fail.
- **Raw: warns only.** For requests that are semantically equal, compares the
  exact URL as sent (parameter order and percent-encoding) and the body's key
  order.

### Reading a diff

`compare-report.txt` is addressed by flow and step. For example:

```
FAIL [01-list-issues] step "open Issues list"
    CHANGED GET /Issue
        query.select:
          baseline: id,display_name,status:statuses!status(id,display_name,color),...
          current:  id,display_name,status:statuses!status(id,display_name),...
          first difference at char 57: ...
```

The diff lines mean the following:

| Line | Meaning |
|---|---|
| `CHANGED` | Same method and path, but some field differs. The report lists each differing query param, header, body or status. |
| `MISSING` | The baseline sent this request and the current run did not. |
| `EXTRA` | The current run sent a request the baseline did not. |
| `COUNT` | Same request, different number of times. |
| `KEYCLOAK` | Different number of OIDC calls in the step. |
| `MINIO` | Different upload or download calls. |

`WARN ... RAW` lines show both raw URL lists. A raw-only diff is legal but
worth a look, for example an `in.(...)` list that is now percent-encoded.

## What is masked, and why

Masking only replaces values that differ between two runs of identical code.
Every other value stays exact, and that includes every value a flow types.

| Rule | Replacement | Why |
|---|---|---|
| UUIDs anywhere (path, query, headers, body, MinIO path) | `<uuid:N>` | File ids, gallery ids, upload request ids and Keycloak user ids are random per run. They are numbered by first appearance in canonical order, which is independent of network timing, so the same UUID keeps its token across steps and flows. |
| Ids of rows the run created, only where the position is known to refer to that row's table | `<Table:N>` | Mainly absorbs seed data whose size depends on the date. For example, community-center's init-time series expansion runs to `NOW() + 90 days`, which shifts the ids of every row created later. See the details below. |
| JWTs | `<jwt>` | Tokens are minted per login. |
| ISO-8601 timestamps whose instant falls inside the run's clock windows (±5 min) | `<runtime-ts>` | These are values generated from `new Date()` or the database's `now()` during the run. There are two windows: the fake client clock (`CLOCK_T0` plus elapsed run time) and the real wall clock of the run. Zone-less values are checked as UTC and as America/New_York wall time. |

**Created ids in detail.** Ids are tracked as `(table, id)` pairs, and a
number is masked only when its position is known to refer to that table.
Two rows with the same number in different tables, such as issue 5 and tag
5, can therefore never be confused.

Sources:
- ids returned by table inserts (`Prefer: return=representation`);
- the mapped result fields of a short allowlist of creating RPCs
  (`CREATING_RPCS` in `lib/recorder.mjs`);
- ids a flow registers with `harness.registerIds(table, ids)`. This covers
  rows created through API setup, or by the worker on the flow's behalf (for
  example, series occurrences).

The position's table is resolved like this:

| Position | Table |
|---|---|
| `/<table>?id=...`, and `id` in a body written to `/<table>` | `<table>` |
| `/<table>?<fk_column>=...`, the same column in a body, and inside `or`/`and` conditions | The FK target from `schema_properties.join_table`, captured from the instance as `raw/_foreign-keys.json` |
| `<prefix>_id` next to `<prefix>_type`, in a query (`entity_notes?entity_id=eq.7&entity_type=eq.Issue`) or in a body | The table named by the type value |
| RPC `*_id` arguments next to `p_entity_type` / `p_entity_table` / `p_table_name` | That table |
| RPC `p_series_id` / `p_group_id` | The recurring-series tables |
| RPC `p_parent_id` next to `p_guided_form_key` | That guided form's parent table, captured from `schema_guided_forms` as `raw/_guided-forms.json` |
| RPC `p_entity_id`, `p_parent_id`, `p_id` or `p_record_id` equal to the id in the page's route (`/view|/edit/:table/:id`) | The route's table |
| MinIO object path `/<bucket>/<Table>/<id>/...`, and object keys `<Table>/<id>/<uuid>/...` inside string values (`p_s3_original_key`) | `<Table>` |

Everything else stays exact. That includes `limit=10`, `severity_level: 3`,
seed ids such as a status or tag id, and ids nested inside JSON arguments.
Tokens are numbered per table, in order of first appearance after the
canonical in-step sort.

Not masked:
- Dates without a time. "Today" is pinned by the fake clock.
- Calendar range bounds derived from the fake clock. They are deterministic
  and fall outside the windows.
- Anything typed. Flows type dates in 2031, far from both windows.

**Status classes.** A 2xx response and a request the app cancelled itself
(`net::ERR_ABORTED`, from `switchMap` or a navigation) are both recorded as
`2xx|cancelled`. Whether a cancelled request's response arrived first is a
matter of timing, and the request was sent either way. Every other status
stays exact (`404`, `409`, `failed:net::ERR_FAILED`, ...). Two runs of
identical code send identical requests to the same database state, so the
exact 2xx code (`200` vs `206` vs `201`) carries no extra signal. A change
in `Prefer` or `Range` shows up in the recorded headers.

**Collapsed repeats.** These are polling requests whose repetition count
depends on worker timing. Each collapses to one entry with `n: ">=1"`:
- `GET /schema_cache_versions`
- `GET /rpc/get_upload_url`, the presigned-URL retries
- `GET /files?id=eq.<uuid>[&select=thumbnail_status]`, the thumbnail polling

Nothing else is collapsed.

## Pinned state

| Pin | Value |
|---|---|
| Browser | Chromium headless shell from `@playwright/test` 1.59.1, viewport 1280x900, DPR 1, light scheme, reduced motion, service workers blocked |
| Timezone / locale | `America/New_York` / `en-US` |
| Clock | `page.clock.install({ time: CLOCK_T0 })`, Tuesday 2026-10-20 09:30 EDT. The clock then advances in real time. |
| Login | A real Keycloak UI login (`#username`, `#password`, `#kc-login`) per role per run, saved as `storageState` |
| localStorage (app origin) | `civic-os-locale=en`, `civic_os_list_page_size=10`, `civic-os-theme=corporate`. No `civic_os_impersonation` and no `kc-*` callback keys. |
| Data | A fresh database every run. Flows create the records they need, through the UI or through unrecorded API setup. Otherwise they use only init-script data. No example depends on a faker or `random()` generator. |

**Clock.** The design called for `setFixedTime`. That freezes `Date.now()`,
and RxJS `debounceTime(n > 0)` reschedules forever under a frozen `now()`:
`emitWhenIdle` compares `now()` against `lastTime + dueTime`. Under a frozen
clock, list search, edit-property debounces and guided-form autosave never
fire. `install()` in Playwright 1.59 starts the fake clock at `CLOCK_T0` and
keeps it flowing in real time; only `pauseAt()` stops timers. "Today" is
therefore fixed, and runtime timestamps fall in the masked window.

**Autosave.** Guided-form drafts autosave 1.5 s after the last change. Flows
wait for each autosave `PATCH` before touching the next field, so the number
of autosaves is deterministic.

**Selectors.** Flows locate elements by role, label or text only, never by
component tag or CSS class. The harness must survive the phase 2 and 3
template changes. There is one exception: a native `input` scoped to a
group located by its text. It applies only where the control has no role
or label, namely date and file inputs among entity-action parameters (see
`actionParam()` in `lib/ui.ts`). The unnamed Markdown editor surface is
reached from its named toolbar (`markdownEditor()`). Both are accessibility
gaps in the app: the action-parameter inputs have no label, and the editor
surface has no name.

## Visual comparison

`--visual-base <ref>`:
1. Checks out `<ref>` into a temporary git worktree and runs `npm ci` there.
2. Serves that worktree's app.
3. Runs the same flows from this checkout. Each capture gets a fresh stack,
   built from this checkout's examples, so only the frontend differs.
4. Pixel-compares each step's full-page screenshot against the current app.

The comparison uses `pixelmatch` with threshold 0.1 and anti-aliased pixels
ignored. Any non-zero diff is reported with a `*.diff.png`. No bitmaps are
committed. `--keep-base` keeps the base worktree (and its `node_modules`)
for the next run against the same ref.

Screenshots are full-page and taken once the step is quiet, with the mouse
parked and animations disabled. Two runs of identical code still differ in
some text, so `runtimeTextMasks()` in `lib/harness.ts` paints it magenta:

- dates on the real calendar, ±1 day (server `created_at`/`updated_at`);
- date-times with seconds within ±60 days of the real date (seed rows
  stamped `NOW() ± interval` when the stack starts);
- date-times on the fake clock's day;
- relative times such as "3 minutes ago".

Map tiles are blocked, so maps render grey in both runs.

## Rules

- **Only the lead re-records baselines** (`--record`), at a clean commit. The
  lead reviews the baseline diff like code.
- A baseline change is either a bug or a deliberate behavior change. A
  deliberate change must be named in the PR.
- Never edit `baselines/**` by hand. Never loosen a mask or add a collapse
  rule to make a diff go away. A new rule needs a written justification
  above.
- Bump `HARNESS_VERSION` in `lib/config.mjs` when a harness change alters the
  baseline format or content, then re-record every example.
- A flow change requires re-recording that example.

## Layout

| Path | Purpose |
|---|---|
| `run-equivalence.sh` | Runner: lock, stack, dev server, Playwright, normalize, compare, visual |
| `playwright.config.ts` | `auth` setup project, then the `flows` project for `$E2E_EXAMPLE` |
| `flows/auth.setup.ts` | Real Keycloak UI login per role → `storageState` |
| `flows/<example>.spec.ts` | Flows; one `test()` per flow, steps via `harness.step()` |
| `lib/harness.ts` | Fixtures: pinned context, recorder, `step`, `setup`, `api`, `registerIds` |
| `lib/recorder.mjs` | Passive recording and the quiet detection that ends a step |
| `lib/normalize.mjs` | Masking, canonicalization and collapse rules |
| `lib/compare.mjs` | Semantic and raw comparison, and the step-addressed report |
| `lib/visual.mjs` | Pixel comparison |
| `lib/files.mjs` | Deterministic PNG and PDF upload fixtures, generated at run time |
| `baselines/<example>/` | Committed normalized recordings, plus `meta.json` (base SHA, example and migrations tree hashes, harness version) |
