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
compose env file `env/<example>.compose-env` (compose interpolation values
passed with `--env-file`; deliberately not named `*.env`, so no tool loads
it as a dotenv file).

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
- `*/test-results/`: `error-context.md` (ARIA snapshot) and a screenshot of
  each failed flow. Tracing is off for the `flows` and `integrity` projects:
  saving a `retain-on-failure` trace in Playwright 1.59.1 stalled some failed
  tests until their timeout.
- `visual/report/report.txt` and its `*.diff.png` files

### npm scripts (root)

```bash
npm run e2e:install                            # npm --prefix tests/e2e ci && npx --prefix tests/e2e playwright install chromium
npm run e2e:lib                                # npm --prefix tests/e2e run test:lib
npm run e2e:equivalence -- <example> --compare # tests/e2e/run-equivalence.sh
npm run e2e:integrity                          # tests/e2e/run-integrity.sh (see "Data-integrity suite")
```

## Flows

| Example | Flows (role testadmin unless noted) |
|---|---|
| pothole | List with search, sort, page change, page size and a deep-link filter. Create WorkPackage (DateTimeLocal, Status, Money). Create Issue (FK select, user FK search modal, GeoPoint, phone, DateTime `observed_at`), then M:M tags on detail. Edit Issue (FileImage upload, two PhotoGallery uploads, DateTime change, coordinated save). WorkPackage detail with inverse relationship and a FilePDF upload. testeditor: status edit and delete. Spanish: switch to `es` in Preferences, list and detail with `Accept-Language: es` and translated metadata, switch back. anonymous: list, sort, detail. |
| community-center | List with the calendar (clock-pinned week, next week, month view) and sort. Create a reservation request (FK, time-slot range). testeditor: note plus the Approve action (confirmation). Resource create (Money, Color) and delete. Recurring series: "This and future occurrences" split from one occurrence. anonymous: resources list, sort, detail. |
| neighborhood-hub | Tool types hybrid search, sort and last page. Parcels filter bar. testeditor: tool instance create (FK, Status) plus a note. Project create with M:M parcels (search modal), then two gallery uploads. Borrower "Update Address" action with params, then a FileImage upload. Building-use guided form: parent step with per-field autosave, M:M rooms, Event Details step, review, submit. anonymous: tool types list, search, detail. |
| client-intake | Partner list: sort, page change, filter bar. Client create (Category, Date, M:M needs via modal). Client note plus the "Record Consent" action (category, two dates, file param). Newsletter: M:M recipients, Markdown body, DateTimeLocal edit, "Schedule" action (datetime_local param). Service category create and delete. anonymous: partner list, filter, detail. No guided form is configured in this example. |

`DateTime` (`timestamp`) is covered by pothole's `Issue.observed_at` (init
script `15_add_observed_at_timestamp.sql`): typed on create and changed on
edit, so the `:00` the app appends shows in the recorded bodies. The
data-integrity suite below checks the stored values.

The Spanish flow covers the locale interceptor. Switching through
Preferences also persists the choice (`rpc/set_user_locale`), so the flow
runs after the other testadmin flows and switches back to English at the
end.

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
PostgREST or MinIO request that starts outside any step (before the first
step, or between two steps, for example from a timer that outlived its step)
is kept as an **unattributed** entry of the flow, addressed by the step it
followed. It fails every comparison, and `--record` refuses to write
baselines that contain one (`cli.mjs normalize --strict`, exit 3): fix the
flow so the request falls inside a step. Requests inside a `harness.setup()`
step are deliberately not recorded. Keycloak calls outside steps are token
refreshes on keycloak-js timers and are ignored. A
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
| `UNATTRIBUTED` | A request started outside any step, in the current run or the baseline. Always a failure. |

`WARN ... RAW` lines show both raw URL lists. A raw-only diff is legal but
worth a look, for example an `in.(...)` list that is now percent-encoded.

## What is masked, and why

Masking only replaces values that differ between two runs of identical code.
Every other value stays exact, and that includes every value a flow types.

| Rule | Replacement | Why |
|---|---|---|
| Keycloak user ids of the test roles, anywhere | `<user:testadmin>`, ... | Keycloak assigns user ids per stack. `auth.setup.ts` captures each test role's id (the JWT `sub`) into `raw/_users.json`, so a request for another user's id (say, the editor picked instead of the admin) is a diff. |
| Other UUIDs anywhere (path, query, headers, body, MinIO path) | `<uuid:N>` | File ids, gallery ids and upload request ids are random per run. They are numbered by first appearance in canonical order, which is independent of network timing, so the same UUID keeps its token across steps and flows. Limit: two such UUIDs that each appear only once, in the same position, compare equal. |
| Ids of rows the run created, only where the position is known to refer to that row's table | `<Table:N>` | Mainly absorbs seed data whose size depends on the date. For example, community-center's init-time series expansion runs to `NOW() + 90 days`, which shifts the ids of every row created later. Each table's created ids are numbered in creation order before anything is masked, so `<Issue:5>` is the fifth Issue the run created, and opening the sixth instead is a diff. See the details below. |
| JWTs | `<jwt>` | Tokens are minted per login. |
| A run-time timestamp, only in a field declared in `RUNTIME_TS_FIELDS` (`lib/normalize.mjs`) | `<runtime-ts:shape>` | No field is declared today, because no flow sends a value generated from `new Date()` or the database's `now()`: every timestamp in a request stays exact. See below. |

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
Tokens are numbered per table in creation order: integer ids by ascending
value (the table's sequence order, which does not depend on the order the
responses were recorded in), other ids in registration order. Every
registered id gets its number, whether or not it ever appears in a request.

**Run-time timestamps.** A timestamp is masked only when all of these hold:
its JSON key or query parameter name is declared in `RUNTIME_TS_FIELDS`; the
whole value is an ISO-8601 date-time in the format declared for that field
(`zoned`: with `Z` or an offset; `wall`: zone-less); and its instant lies
within 5 minutes of one of the run's two clock windows (the fake client
clock, `CLOCK_T0` plus elapsed run time, and the real wall clock of the run).
A zone-less value is read as America/New_York wall time, never as UTC, so a
now-derived wall-clock value sent with UTC digits lands hours outside the
window and shows as a diff. The token keeps the value's shape
(`<runtime-ts:dddd-dd-ddTdd:dd:dd.dddZ>`), so a format change (`Z` versus an
offset, dropped milliseconds) also shows. The list is empty today. Adding a
field needs a written justification here.

Not masked:
- Dates without a time. "Today" is pinned by the fake clock.
- Calendar range bounds derived from the fake clock. They are deterministic.
- Anything typed. Flows type dates in 2031.

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
- `GET /files?id=eq.<uuid>&select=thumbnail_status`, the thumbnail polling
  of `FileUploadService.waitForThumbnails()`. Only that exact shape: the
  full-row `GET /files?id=eq.<uuid>` that follows an upload is counted
  exactly.

Nothing else is collapsed.

## Pinned state

| Pin | Value |
|---|---|
| Browser | Chromium headless shell from `@playwright/test` 1.59.1, viewport 1280x900, DPR 1, light scheme, reduced motion, service workers blocked |
| Timezone / locale | `America/New_York` / `en-US` |
| Clock | `page.clock.install({ time: CLOCK_T0 })`, Tuesday 2026-10-20 09:30 EDT. The clock then advances in real time. |
| Login | A real Keycloak UI login (`#username`, `#password`, `#kc-login`) per role per run, saved as `storageState`. The `anonymous` role is the app opened logged out, with the same localStorage pins. Its requests carry no `Authorization` header (`web_anon`). |
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

A flow can add masks for example seed data stamped with the database's
`NOW()` at stack start, through `harness.screenshotMasks`. Community-center
masks the "Weekly Yoga Class" series, which init script 14 seeds at
`NOW() + 1 day`. These masks affect screenshots only, never recordings.

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

## Data-integrity suite

Request equivalence proves that a refactor sends the same requests. It does
not prove that those requests store the right values. `integrity.spec.ts`
does: it types values through the pothole UI as `testadmin`, reads the stored
values with `psql`, and reopens the edit page to check that the inputs show
what was typed. It is the backstop for the transforms that move into the SDK
core (`transformValuesForApi`, `transformValueForControl`,
`parseDatetimeLocal`) and for Money, GeoPoint and M:M writes.

```bash
tests/e2e/run-integrity.sh       # fresh pothole stack, dev server, suite, teardown
```

A run takes about 4 minutes: 2.5 for the fresh stack, 1.2 for the suite.

`run-integrity.sh` is `run-equivalence.sh pothole --integrity`: the same lock,
fresh `sdk-pothole` stack (`down -v`, then `up`), dev server on `:4200`,
real Keycloak login and teardown. It prepares only the `testadmin` login and
records nothing. `--keep-stack`, `--reuse-stack` and `--grep` work as above;
never use them for gate runs. It needs a `psql` client on the host
(`E2E_PSQL` overrides the binary). The spec connects to
`localhost:15432/civic_os_db` as `postgres`, and `E2E_PG_HOST`, `E2E_PG_PORT`,
`E2E_PG_USER`, `E2E_PG_DB` and `E2E_PG_PASSWORD` override that.

**Expected values are derived by hand.** Each expected value in the spec is
written out from the typed input and the time-zone rules, with the derivation
in a comment next to it. No expectation is read from the app's output, so the
suite cannot drift along with a regression. Each browser context checks
first that it really runs under its zone's offsets (`getTimezoneOffset()` in
January and July).

| Area | Typed (context zone) | Stored (psql), derivation | Edit page shows |
|---|---|---|---|
| DateTimeLocal `WorkPackage.quote_due_date` (`timestamptz`) | `2026-11-01T01:30` (NY, fall-back overlap) | `2026-11-01T05:30Z`: a repeated local time resolves to the earlier instant, EDT (UTC-4) | `2026-11-01T01:30` |
| | `2026-03-08T02:30` (NY, spring-forward gap) | `2026-03-08T07:30Z`: a skipped local time takes the pre-transition offset, EST (UTC-5) | `2026-03-08T03:30` (see below) |
| | `2026-07-04T18:45` (NY, EDT) | `2026-07-04T22:45Z` | `2026-07-04T18:45`; in Kolkata `2026-07-05T04:15` |
| | `2026-07-04T09:15` (Kolkata, IST UTC+05:30) | `2026-07-04T03:45Z` | `2026-07-04T09:15` |
| | `2027-01-01T00:10` (Kolkata) | `2026-12-31T18:40Z` | `2027-01-01T00:10` |
| DateTime `Issue.observed_at` (`timestamp`) | `2026-03-08T02:30` and `2026-11-01T01:30` (NY), `2026-07-04T09:15` and `2027-01-01T00:10` (Kolkata) | exactly as typed, seconds `:00`, in every zone | exactly as typed, also from the other zone |
| Money `WorkPackage.cost` | `1234567.89`, `0.10`, keystrokes `987654321`, `$ 1,000,000.01`, `4321.00` | `cost::numeric` = `1234567.89`, `0.10`, `9876543.21`, `1000000.01`, `4321.00` (financial input mode: all typed digits count, the last two are cents) | |
| GeoPoint `Issue.location` | Latitude `43.0186` / Longitude `-83.6929`, then `42.9634` / `-85.6681` | `ST_AsText` = `POINT(-83.6929 43.0186)`, then `POINT(-85.6681 42.9634)` (x = longitude) | the typed coordinates |
| M:M `issue_tags` | Edit Tags: add Urgent and Road Surface; then remove Urgent, add Drainage | exactly {Road Surface, Urgent}, then {Drainage, Road Surface} | |

Unrelated edits (renaming, changing severity or cost, re-saving from the
other zone) must leave every stored value above unchanged; the spec checks
that too.

**The spring-forward gap.** 02:30 on 2026-03-08 does not exist in New York.
Chromium's `datetime-local` input accepts it as typed; the app then builds a
local `Date` from it, which ECMAScript resolves with the offset in effect
before the transition (EST), giving `07:30Z`. That instant is 03:30 EDT, so
the edit page shows `03:30`, not the `02:30` that was typed. Re-saving does
not move it again. The `timestamp` column stores the gap value exactly as
typed, because no zone is applied.

**Pinned state.** The same as the equivalence flows (locale, viewport,
localStorage, blocked third-party origins, fake clock at `CLOCK_T0`), except
the time zone, which each test sets to `America/New_York` or `Asia/Kolkata`.
The fake clock only fixes "today": every value under test is typed
explicitly.

**Failures.** Each assertion message names its case (for example `NY gap
02:30 -> pre-transition offset (EST)`). A failed test leaves
`error-context.md` (ARIA snapshot) and a screenshot under
`.artifacts/pothole/integrity/test-results/`. Tracing is off for this
project: saving a `retain-on-failure` trace stalled every failed test until
its timeout, with or without the fake clock.

**Order.** The five tests run in file order. The last one reopens the New York
records in a Kolkata context, so it fails too if an earlier New York test did
not leave its record behind.

## Layout

| Path | Purpose |
|---|---|
| `run-equivalence.sh` | Runner: lock, stack, dev server, Playwright, normalize, compare, visual; `--integrity` mode |
| `run-integrity.sh` | Data-integrity suite runner (`run-equivalence.sh pothole --integrity`) |
| `integrity.spec.ts` | Data-integrity suite: UI input, `psql` checks, edit-page round trip |
| `playwright.config.ts` | `auth` setup project, then the `flows` project for `$E2E_EXAMPLE`, or the `integrity` project |
| `flows/auth.setup.ts` | Real Keycloak UI login per role → `storageState`; captures the FK map, guided-form parents and role user ids into `raw/_*.json` |
| `flows/<example>.spec.ts` | Flows; one `test()` per flow, steps via `harness.step()` |
| `lib/harness.ts` | Fixtures: pinned context, recorder, `step`, `setup`, `api`, `registerIds` |
| `lib/recorder.mjs` | Passive recording and the quiet detection that ends a step |
| `lib/normalize.mjs` | Masking, canonicalization and collapse rules |
| `lib/compare.mjs` | Semantic and raw comparison, and the step-addressed report |
| `lib/visual.mjs` | Pixel comparison |
| `lib/files.mjs` | Deterministic PNG and PDF upload fixtures, generated at run time |
| `baselines/<example>/` | Committed normalized recordings, plus `meta.json` (base SHA, example and migrations tree hashes, harness version) |
