# Follow-up Task Queue — post-v0.67.0 (accessibility release)

**Purpose:** self-contained work queue for a future AI session (or contributor).
Each task below can be executed without access to the July 2026 accessibility
session that produced it. Written 2026-07-18, immediately after v0.67.0 shipped.

> **To a future Claude/Fable session:** pick ONE task, work it on a fresh branch
> off `main`, and follow the shared ground rules below. Tasks are ordered by
> value; none block each other. Session chips for these tasks may or may not
> still exist — this doc is the source of truth; don't duplicate work that has
> already landed (check `git log` for the task's files first).

---

## Shared ground rules (apply to every task)

1. **Gates before any commit:** `npm run test:headless` (all passing; baseline
   ~2,953), `npm run lint` (0 errors — the `@angular-eslint/template`
   accessibility rules are enforced errors, as are `button-has-type` and
   `label-has-associated-control`), `npx ng build` (success).
2. **Every new user-visible string — including every aria-label — goes through
   the translate pipe** with flat keys in `src/app/i18n/en.translations.ts`
   (`a11y.` prefix for accessibility strings). See CLAUDE.md's i18n requirement.
3. **No en/em dashes (`–`/`—`) in visible strings** (titles, placeholders,
   translations) — plain hyphens only. Code comments are exempt.
4. **CSS logical properties only** (`ms-`/`me-`/`start-`/`end-`) for RTL.
5. **Zero visual change unless the task explicitly sanctions one.**
6. Angular 20 idioms: signals, `@if`/`@for`, OnPush; do not add subscriptions or
   effects to existing reactive chains — passive `tap`/computed additions only.
7. Commit messages: concise summary style, no attribution lines (repo rule).
8. Key background docs: `docs/notes/ACCESSIBILITY_AUDIT_2026-07.md` (the full
   audit, remediation record, sweep notes, and future-work backlog these tasks
   come from), `docs/development/ACCESSIBILITY_MANUAL_TESTING.md` (human
   verification procedure + known VoiceOver quirks).

## Environment playbook (for tasks needing a live stack)

Condensed from seven example sweeps — every item below was hit in practice:

- One example stack at a time (shared ports). `docker ps` first; `docker compose
  down` any other example from ITS directory.
- `.env`: copy `.env.example` (or `../pothole/.env` if absent); ensure
  `POSTGRES_DB`/`POSTGRES_PASSWORD` are set; re-quote any value containing `<>`
  as ONE string (compose aborts otherwise).
- `touch jwt-secret.jwks` BEFORE first `docker compose up -d` (Docker otherwise
  creates it as a directory and PostgREST crash-loops).
- After Keycloak is up, fetch JWKS from the LOCAL realm regardless of what .env
  claims: `curl -s http://localhost:8082/realms/civic-os-dev/protocol/openid-connect/certs > jwt-secret.jwks`
  then `docker compose stop postgrest && docker compose up -d --force-recreate postgrest`
  (recreate, not restart — the bind-mount type is fixed at container creation).
- Stale volume symptoms ("password authentication failed", pre-existing tables)
  → `docker compose down -v && up -d`.
- Login: testadmin/testadmin (realm `civic-os-dev`, client `civic-os-dev-client`).
  Verify with a password-grant token against PostgREST → expect 200, not PGRST301.
- Dev server: `npm start` (4200). Check `lsof -ti :4200` first — another
  checkout's server may hold the port and serve the WRONG code; the tell is a
  bare "Civic OS" tab title on inner pages (correct builds show "Page - Civic OS").
- Playwright automation: move focus ONLY via Playwright actions (real clicks,
  real key presses) — element.focus()/.click() inside evaluate desyncs key
  delivery. Evaluate is for read-only inspection. FullCalendar and some
  signal-toggled modals ignore synthetic clicks; verify those statically and say so.

## Parallelization notes (for a session running multiple tasks)

The tasks are largely disjoint and suit worktree-isolated parallel agents, with
three contention points:

- **`en.translations.ts`**: tasks 3, 5, and 6 each append `a11y.*` keys
  (trivial append conflicts), and **task 2 should run LAST** — it translates the
  full key set, so running it before the key-adding tasks leaves their new keys
  untranslated.
- **`.github/workflows/accessibility.yml`**: tasks 4 and 7 both edit it —
  serialize those two relative to each other.
- **Live verification serializes on ports** even when implementation
  parallelizes: only one example stack (5432/3000/8082) and one dev server
  (4200) at a time. Implement in parallel worktrees; run the browser/stack
  verification steps one at a time.

Suggested waves:
1. **Wave 1 (parallel):** 1 (cos-modal), 4 (pa11y CI), 6 (schema editor),
   8 (FK search), 9 (inverse-relationship) — fully disjoint file sets.
2. **Wave 2 (parallel):** 3 (map markers), 5 (chart toggle), 7 (dash guard —
   after 4's workflow edit lands).
3. **Last:** 2 (translations), once all new keys exist.

Task 1 has the largest blast radius (cos-modal + consumer specs); merge it
before starting anything that touches modal specs, or keep it isolated in its
own worktree until the others land.

---

## Task 1 — Migrate cos-modal to the native `<dialog>` element (highest value)

> ✅ **DONE** (2026-07-18, branch `task/native-dialog-modal`). Also migrated
> `gallery-lightbox` to native `<dialog>` (required: a z-index lightbox opened
> from a photo-gallery action param inside a modal would paint under the top
> layer) and deleted `inert.utils.ts`. Escape works via both the native `cancel`
> event and a keydown fallback. Live-verified on pothole: settings modal, FK
> search modal in create form (selection + focus restore), delete confirmation
> (Escape cancel). Residual: dialog-over-dialog nesting (entity action modal →
> FK modal) and lightbox-over-modal are covered by unit tests and top-layer
> stacking guarantees but were not exercised live (pothole has no entity
> actions); spot-check when a stack with actions is next up.

Original task description:

Migrate `src/app/components/cos-modal/` from its div-based implementation
(`role="dialog"` + `aria-modal` + CDK `cdkTrapFocus` + sibling-walk `inert` via
`src/app/utils/inert.utils.ts` + manual body scroll lock) to native `<dialog>`
with `showModal()`. The browser then handles top-layer rendering, true
background inerting, Escape, and focus natively — the long-term ideal per TPGi's
modal-accessibility survey and W3C ARIA practices.

- Preserve the consumer API used by ~29 components: `[label]` (accessible name),
  `[isOpen]`, `(closed)`, `size` variants, `closeOnEscape`, `closeOnBackdrop`.
- Preserve the entrance animation (`::backdrop` + `@starting-style` or
  equivalent) and body scroll behavior.
- Update specs that assert `role`/`aria-modal`/ESC to native semantics.
- Remove `inert.utils.ts` usage from cos-modal; `gallery-lightbox` keeps it
  unless migrated too.
- Live-verify: settings modal, FK search modal (nested inside forms), delete
  confirmation, gallery-lightbox interplay.

## Task 2 — Translate `a11y.*` screen-reader strings for all locales

The ~90 `a11y.*` keys in `src/app/i18n/en.translations.ts` ship English-only;
other locales fall back to English for every announcement/aria-label.
Translations are DB-driven per instance (`metadata.translations`, managed at
`/admin/translations` which has a missing-coverage report).

- Enumerate missing keys per locale; add translations for the demo locales
  (client-intake/ECS ships es, ar, fr, de, ps) via example init-scripts.
- Document the requirement in `docs/INTEGRATOR_GUIDE.md` (Multi-Language
  section) as a pre-release checklist item for integrators.
- Verify one locale end-to-end in the browser (switch locale, inspect an
  aria-label in the accessibility tree).

## Task 3 — Descriptive accessible names for dashboard map markers

Dashboard map markers announce as "Marker"; clusters announce a bare count.

- Carry the record's display name onto each marker (aria-label/title on the
  Leaflet marker element — see `src/app/components/geo-point-map/` marker
  rendering and how the dashboard map widget supplies `MapMarker` data).
- Clusters: "15 participants" style (entity display name from widget config).
- Test surface: storymap example's clustered participant/sponsor dashboards.
- Verify via accessibility-tree inspection in the browser.

## Task 4 — Promote the pa11y CI job to an authenticated gate

> ✅ **DONE** (2026-07-18, branch `task/pa11y-authenticated-ci`).
> `continue-on-error` removed; the pa11y job now boots a slim stack
> (`docker/ci-a11y/docker-compose.yml`: postgres + PostgREST + Keycloak with
> the pothole schema), injects runtime config into the built bundle, applies
> the JWKS dance, seeds the detail-page record (including the
> `metadata.civic_os_users` row - it is empty before first login), serves the
> bundle with `serve -s` (http-server 404s SPA deep links - the old
> best-effort job was scanning 404 pages for guarded routes), and
> authenticates via pa11y actions driving the real Keycloak login form
> (`useIncognitoBrowserContext` so every URL gets a fresh login). Stale
> `/detail/:id`-style URLs in `.pa11yci.json` corrected to real routes. The
> first authenticated scans surfaced real defects, all fixed: ~100 unlabeled
> permission-matrix checkboxes, unlabeled user-management search/filter
> controls, unlabeled entity-management inline edit inputs, and a prohibited
> `aria-label` on the gallery dropzone (now `role="group"`). axe
> `color-contrast` is the one documented exclusion (theme-wide Phase 4 work,
> see `docs/development/ACCESSIBILITY_WCAG.md`). Verified locally end-to-end:
> 8/8 URLs pass against the exact CI configuration. Residual risk for the
> first real CI run: runner timing (Keycloak boot, amd64 image pulls) - the
> wait loops allow 5 min each.

Original task description:

`.github/workflows/accessibility.yml`'s pa11y job is `continue-on-error`
because it cannot log into Keycloak in CI — it only scans anonymous pages.

- Bring up a minimal stack in CI (postgres + PostgREST + Keycloak from an
  example compose, or a slimmed CI compose).
- Obtain a testadmin token via the password grant; inject into pa11y page loads
  (headers/actions API or localStorage token injection).
- Apply the environment playbook above (JWKS from local realm; recreate
  PostgREST).
- Once authenticated URLs scan reliably, remove `continue-on-error` so it gates
  PRs. Keep runtime ~5 min.

## Task 5 — Visible data-table toggle for chart widgets

> ✅ **DONE** (2026-07-18, branch `task/chart-table-toggle`, merged to main).
> Icon-only toggle button (aria-pressed state, constant "View as table"
> accessible name via `a11y.chart_view_as_table`) in the widget header next to
> the export control; the existing sr-only table markup is reused and swaps to
> visible `table table-zebra table-sm` when toggled - no markup duplication,
> no persistence. 4 new unit tests. Live-verified on a pothole dashboard with
> a seeded chart widget: default chart view, toggle renders the zebra table
> with caption and correct data, chart container hidden, toggle back restores
> the chart. Note: browser-pane real-click delivery was flaky during
> verification (playbook caveat); state changes confirmed via handler
> invocation + async CD settle.

Original task description:

`src/app/components/widgets/chart-widget/` renders an sr-only data table as the
chart's text alternative. Add a visible "View as table" toggle (real labeled
button in the widget header next to the export control) that swaps the chart
for the rendered table — serving low-vision and cognitive-load users.

- Reuse the existing sr-only table markup (caption, category column, one column
  per series); style visibly (`table table-zebra table-sm`) when toggled.
- Default to chart; no persistence. Translated strings via `a11y.*` keys.
- Verify on a dashboard with a grouped-bar chart (community-center or storymap).
- This task sanctions the visible toggle button as a UI addition.

## Task 6 — Keyboard node manipulation in the schema editor (low priority)

The JointJS ERD canvas (`src/app/pages/schema-editor/`, see
`docs/development/JOINTJS_INTEGRATION.md`) moves nodes by mouse drag only.

- Make entity nodes focusable (roving tabindex or overlay list); arrow keys
  nudge the focused node (Shift = larger step); announce moves via a polite
  live region (follow the reorder-announcement pattern in
  `entity-management.page.ts`); visible focus on the canvas node.
- Deliberately small scope: focus + arrow-nudge + announce. Auto-layout (the
  existing button) remains the primary accessible path. All underlying data is
  editable through accessible pages — do not over-engineer.

## Task 7 — CI guard banning typographic dashes in visible strings

> ✅ **DONE** (2026-07-18, branch `task/dash-guard`, stacked on
> `task/pa11y-authenticated-ci` since both edit accessibility.yml).
> `scripts/check-typographic-dashes.cjs` (npm run lint:dashes) scans template
> HTML minus HTML comments, inline `template:` strings in TS (nothing else in
> TS can trip it, so code comments are structurally exempt), and translation
> string VALUES in en.translations.ts. Runs as a step in the a11y-lint CI job.
> Verified: fails on a seeded violation, passes clean. The first run found and
> fixed 10 pre-existing violations: '—' empty-value placeholders (profile,
> admin-translations), an em dash in static-assets delete-confirm prose, and
> en-dash date ranges (series-version-timeline, series-group-management).

Original task description:

Convention (see ground rule 3) currently unenforced.

- Add a check in `.github/workflows/accessibility.yml` (or a package.json
  script it calls) that greps `src/app/**/*.html`, inline template strings in
  `src/app/**/*.ts`, and `src/app/i18n/en.translations.ts` values for `–`/`—`
  and fails with a helpful message. Custom ESLint rule acceptable instead.
- Zero false positives required: code comments (which legitimately contain many
  em dashes) and non-template TS must not trip it.
- Verify the guard fails on a seeded violation, passes on the clean codebase.

## Task 8 — Align FK modal user search with hybrid/trigram search (non-a11y)

> ✅ **DONE** (2026-07-18, branch `task/fk-modal-hybrid-search`). Frontend-side
> fix (the metadata question resolved: `civic_os_users` is not in
> `schema_entities` at all - the modal uses `SYSTEM_TYPE_MODAL_CONFIGS`, so no
> migration needed). The list page's hybrid builder is extracted to
> `src/app/utils/search.utils.ts` (`buildHybridSearchParams`) and shared by
> both surfaces. The modal now: (a) for `civic_os_users`, combines wfts on
> `civic_os_text_search` (phone tokens) with ILIKE on display_name/email via
> or=(); (b) for schema entities, honors
> `fulltext_search_column`/`substring_search_column` exactly like list pages
> (this misalignment existed for regular entities too, not just users);
> (c) falls back to the legacy wfts path when no hybrid columns exist. Search
> box now also shows for entities with hybrid columns but no legacy
> search_fields. Tests: util spec + 3 modal specs (the old wfts-only users
> assertion was updated to hybrid). Live-verified on pothole: "Smi" finds
> "Jane Smith" in the Created User modal with
> or=(civic_os_text_search.wfts.Smi,display_name.ilike.*Smi*,email.ilike.*Smi*).

Original task description:

The FK search modal's search for User-type fields appears to use full-text
search (whole-word lexeme matching) while list-page search uses the
hybrid/substring (ILIKE trigram) path — partial-name queries like "Smi" behave
differently in the modal than on list pages (observed live on client-intake).

- Compare query construction: `fk-search-modal.component`/`DataService` vs
  `list.page` (hybrid search: `fulltext_search_column` vs
  `substring_search_column`; see `docs/notes/HYBRID_SEARCH_DESIGN.md`).
- Check whether the `civic_os_users` VIEW registers only a
  `fulltext_search_column` in schema metadata — the gap may be
  metadata/migration-side rather than frontend.
- Make modal search consistent with list search (hybrid where both columns
  exist); add tests; verify live via a User FK field on a create page.

## Task 9 — Inverse-relationship previews 400 on tables without display_name (non-a11y)

> ✅ **DONE** (2026-07-18, branch `task/inverse-relationship-preview`). Fixed in
> the frontend metadata layer: `InverseRelationshipMeta` gains a `previewMode`
> (`display_name` | `id` | `count`) derived in
> `SchemaService.getInverseRelationships()` from the source table's actual
> columns (schema_properties exposes id/display_name rows, verified live);
> `DataService.getInverseRelationshipPreview()` builds the select accordingly
> (count mode = `select=<fk_column>&limit=0` + `Prefer: count=exact`, count
> parsed from `Content-Range: */N`). Count-only cards show badge + "View all"
> (new template condition in related-records). Regression tests added in
> schema.service.spec and data.service.spec. Live-verified on pothole against
> throwaway repro tables: old query shape 400s, new shapes 200/206 with correct
> rendering (#id links; count + View all).

Original task description:

Detail pages' related-records preview always selects `id,display_name` from
child/junction tables; tables lacking a `display_name` column (composite-PK
junctions like `team_rosters`, guided-form step tables like
`tool_reservation_tools`) return 400s and a broken preview panel. Observed on
neighborhood-hub and storymap.

- Fix in the detail page / SchemaService inverse-relationship query
  construction: when `schema_properties` shows no `display_name` for the
  related table, select only the PK and render the preview with ids or a count.
- Add a regression test. See `docs/notes/MANY_TO_MANY_DESIGN.md` for junction
  conventions.

---

*Origin: the July 2026 accessibility audit/remediation (v0.67.0). The a11y
tasks (1–7) mirror the "Future accessibility work" backlog in
`docs/notes/ACCESSIBILITY_AUDIT_2026-07.md`; tasks 8–9 were found during
example sweeps and live screen-reader testing. Delete each task from this doc
(or mark it done with the landing commit) as it ships.*
