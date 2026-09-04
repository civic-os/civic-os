# Major Dependency Upgrade Roadmap

Planned major version upgrades for Civic OS, ordered by urgency. Created September 2026 after the PostgREST v16.2 upgrade (v0.73.0) and dependency audit.

For the PostgREST upgrade procedure, see `docs/development/POSTGREST_UPGRADE_RUNBOOK.md`.

## Scope Decisions

- **In**: All 6 library upgrades + Karma→Jest migration (if Angular 22 deprecates Karma) + remove unused `ngx-tiptap`
- **Out**: No new features, no drive-by refactoring
- **Key risk**: `keycloak-angular` 20→22 touches auth — worst case is login breaks in production. Mitigated by isolating keycloak-angular into its own commit within Phase 1.
- **Reversibility**: High — each phase is a branch, no database migrations involved

---

## Library Reference

### Angular 20 → 22

**EOL: November 2026** — plan now, execute Q4 2026

Angular 22 ("signal-first") shipped June 2026 with selectorless components and stable Signal Forms. Civic OS already uses Signals + OnPush everywhere, so the migration should be primarily mechanical.

**Scope** (16 Angular packages + 6 companions):
- `@angular/*` v20 → v22 (core, common, forms, router, compiler, CDK, service-worker, etc.)
- `@angular-devkit/build-angular` + `@angular/cli` + `@angular/compiler-cli`
- `typescript` 5.8 → 6.0 (required by Angular 22; TS 7.0 is the Go-native rewrite)
- `keycloak-angular` 20 → 22
- `ngx-markdown` 20 → 22
- `ngx-mask` 20 → 22
- `@dintecom/ngx-currency` 20 → 22
- `angular-eslint` 20 → 22
- `ngx-matomo-client` 8 → 10

**Risk**: MEDIUM — large dependency tree but no architectural changes needed. TypeScript 6.0 may surface new strict-mode warnings.

### Blockly 12 → 13

**No deadline** — admin-only, read-only feature (code block visualization)

**Scope**: 1 package, but deeply integrated with custom blocks and theme.

**Files affected**:
- `src/app/blockly/sql-blocks.ts` — custom block definitions (JSON format)
- `src/app/blockly/civic-os-theme.ts` — custom theme via `Blockly.Theme.defineTheme()`
- `src/app/components/blockly-viewer/blockly-viewer.component.ts`
- `src/app/services/ast-to-blockly.service.ts`

**Known concerns**:
- `Theme.defineTheme()` requires a `name` property in its `ITheme` interface (already worked around in v12 — verify v13 API)
- Message loading changed between Blockly versions (`blockly/msg/en.mjs` export)
- Custom block JSON format may have structural changes

**Risk**: HIGH — custom block definitions and theme API are the most fragile integration points.

### FullCalendar 6 → 7

**No deadline** — stable on v6, patches still shipping (6.1.21)

**Scope**: 5 packages (`@fullcalendar/angular`, `core`, `daygrid`, `interaction`, `timegrid`)

**Usage**:
- `TimeSlotCalendarComponent` — entity calendar views with day/week/month
- Dashboard calendar widgets
- RTL support via `api.setOption('direction', 'rtl')`

**Risk**: MEDIUM — plugin registration API usually changes between FC majors.

### @pgsql/parser 1.2 → 1.5

**No deadline** — admin-only feature (code visualization), has regex fallback

**Scope**: WASM PostgreSQL parser used for PL/pgSQL → Blockly AST conversion.

**Known concerns**:
- Emscripten-generated WASM references `require('fs')` and `require('crypto')` behind runtime checks
- Angular's esbuild bundler resolves these statically — current workaround uses `/* @vite-ignore */` with variable import path to defer to runtime
- 3-minor-version jump (1.2 → 1.5) may change internal WASM module structure

**Files affected**:
- `src/app/services/sql-parser.service.ts` — WASM loading and caching

**Fallback**: `SqlParserService.ensureLoaded()` returns null on failure — services fall back to regex-based parsing.

**Risk**: MEDIUM — WASM bundler interaction is fragile.

### Jasmine 5 → 7 + @types/jasmine 5 → 6

**No deadline** — test framework, no production impact

**Scope**: Test runner and assertion library used by 3000+ unit tests.

**Risk**: MEDIUM — assertion API changes could surface across many test files.

### ESLint 9 → 10

**No deadline** — linter, no production impact

**Scope**: `eslint` 9 → 10, `@eslint/js` 9 → 10

**Risk**: LOW — mostly configuration format changes. Civic OS already uses flat config.

---

## Phased Execution Plan

### Phase 0: Pre-Flight (no code changes)

**Goal**: Establish a clean, green baseline and capture reference screenshots.

1. Run `npm run test:headless` — confirm all tests pass, save to `/tmp/test-baseline.txt`
2. Run `npm run lint` — confirm ESLint + a11y gate passes
3. Run `npm run build` — confirm production build succeeds within budget
4. Audit companion library npm pages for Angular 22 compatible versions:
   - `keycloak-angular`, `ngx-markdown`, `ngx-mask`, `@dintecom/ngx-currency`, `angular-eslint`, `ngx-matomo-client`, `ngx-image-cropper`
5. Document any blockers (libraries without Angular 22 releases yet)

#### Playwright: Capture reference screenshots

Start the dev server (`npm start`) and Docker stack. Use Playwright MCP to capture baseline screenshots for visual comparison after each phase:

```
1. Navigate → http://localhost:4200/ (dashboard home)
   → screenshot: "baseline-dashboard"

2. Navigate → http://localhost:4200/view/Issue (list page)
   → screenshot: "baseline-list"

3. Navigate → http://localhost:4200/view/Issue/1 (detail page)
   → screenshot: "baseline-detail"

4. Login as testadmin/testadmin via Keycloak
   → Navigate → /create/Issue (create page with form)
   → screenshot: "baseline-create-form"

5. Navigate → /edit/Issue/1 (edit page with populated form)
   → screenshot: "baseline-edit-form"

6. Navigate → /admin/users (user management table)
   → screenshot: "baseline-admin-users"

7. Navigate → /system/functions (blockly code viewer)
   → screenshot: "baseline-system-functions"

8. Navigate to an entity with show_calendar=true (if available)
   → screenshot: "baseline-calendar"

9. Navigate → /permissions (RBAC table)
   → screenshot: "baseline-permissions"
```

---

### Phase 1: Angular 20 → 22 + TypeScript 5.8 → 6.0 ⚡ URGENT

**Risk**: MEDIUM | **Deadline**: Before Nov 2026 EOL
**Blast radius**: ALL pages — Angular core touches everything

#### Scope (~22 packages)

| Group | Packages | From → To |
|-------|----------|-----------|
| Angular core | `@angular/*` (10 pkgs) | 20 → 22 |
| Angular tooling | `build-angular`, `cli`, `compiler-cli` | 20 → 22 |
| TypeScript | `typescript` | 5.8 → 6.0 |
| Companions | `keycloak-angular`, `ngx-markdown`, `ngx-mask`, `@dintecom/ngx-currency`, `angular-eslint`, `ngx-matomo-client` | 20→22 / 8→10 |

#### Execution (3 separate commits)

**Commit 1: Angular core + TypeScript**
1. Branch: `upgrade/angular-22`
2. `ng update @angular/core@22 @angular/cli@22` — review every schematic change
3. `ng update @angular/cdk@22`
4. Fix TypeScript 6.0 errors: `npx tsc --noEmit` — check `experimentalDecorators`, `useDefineForClassFields`
5. If Angular 22 deprecates Karma: migrate to Jest/Web Test Runner in this commit

**Commit 2: keycloak-angular (isolated — auth risk)**
6. Upgrade `keycloak-angular` 20 → 22 alone
7. Check if bug workaround on `app.config.ts:59` (manual `UserActivityService`/`AutoRefreshTokenService` providers) is still needed
8. Verify: login flow, token refresh, role checking, route guards, impersonation

**Commit 3: remaining companions**
9. Update: `ngx-markdown` → `ngx-mask` → `@dintecom/ngx-currency` → `angular-eslint` → `ngx-matomo-client` → `ngx-image-cropper`
10. Remove unused `ngx-tiptap` dependency

#### Key files to watch

- `src/app/app.config.ts` — `provideKeycloak()`, `provideMarkdown()`, `provideMatomo()` APIs
- `tsconfig.json` — `experimentalDecorators`, `useDefineForClassFields` flags
- `eslint.config.js` — `angular-eslint` config shape

#### Layer 1–2 verification

```bash
npx tsc --noEmit                    # zero type errors
npm run build                       # production build within budget
npm run test:headless               # all tests pass
npm run lint                        # ESLint + a11y passes
docker build -f docker/frontend/Dockerfile .   # container builds
```

#### Playwright MCP: Full regression (blast radius = everything)

Since Angular is the foundation, this phase requires testing every major UI surface. Start dev server + Docker stack, then:

**Auth flow (keycloak-angular blast radius)**:
```
1. Navigate → http://localhost:4200/
   → Verify: redirected to Keycloak login (or dashboard loads if public)
   → snapshot page

2. Login: fill #username=testadmin, #password=testadmin, click #kc-login
   → Verify: redirected back to app, sidebar renders, user name visible in navbar
   → screenshot: "phase1-auth-success"

3. Navigate → /settings (or open settings modal)
   → Verify: role impersonation dropdown renders, theme selector works
```

**CRUD flow (Angular core + forms + router)**:
```
4. Navigate → /view/Issue
   → Verify: table renders with data rows, column headers present
   → Verify: pagination/filter controls render
   → screenshot: "phase1-list-page"

5. Click first row → Detail page loads
   → Verify: property labels and values render
   → Verify: markdown static text blocks render (ngx-markdown blast radius)
   → Verify: entity notes section renders if present
   → screenshot: "phase1-detail-page"

6. Click Edit button → /edit/Issue/:id
   → Verify: form renders with populated values
   → Verify: phone/mask inputs format correctly (ngx-mask blast radius)
   → Verify: money inputs show currency symbol (ngx-currency blast radius)
   → Change a text field, click Save
   → Verify: redirected to detail page, updated value shown
   → screenshot: "phase1-edit-form"

7. Navigate → /create/Issue
   → Verify: empty form renders with correct field types
   → Verify: validation works (submit empty required field → error message)
   → Fill required fields, submit
   → Verify: redirected to detail page of new record
   → screenshot: "phase1-create-form"
```

**Dashboard (Angular + ngx-markdown widgets)**:
```
8. Navigate → /
   → Verify: dashboard loads, widget cards render
   → Verify: markdown widgets render formatted content
   → screenshot: "phase1-dashboard"
```

**Admin pages (Angular + Keycloak guards)**:
```
9. Navigate → /admin/users
   → Verify: user table renders with columns
   → screenshot: "phase1-admin-users"

10. Navigate → /permissions
    → Verify: RBAC table renders with role columns and checkboxes
    → screenshot: "phase1-permissions"

11. Navigate → /entity-management
    → Verify: entity cards render
    → screenshot: "phase1-entity-mgmt"
```

**System pages (Angular + lazy loading)**:
```
12. Navigate → /system/functions
    → Verify: function list renders (confirms lazy-loaded Blockly still works)
    → screenshot: "phase1-system-functions"

13. Navigate → /schema-editor
    → Verify: JointJS ERD canvas renders (confirms @joint/core compat)
    → screenshot: "phase1-schema-editor"
```

**Compare** all screenshots against Phase 0 baselines. Flag visual regressions.

#### Rollback

Abandon branch. Angular 20 still supported until November.

#### Phase 1 Results (2026-09-03)

**Status**: COMPLETE — all 3 commits merged, zero regressions.

**Branch**: `upgrade/angular-22` (3 commits on top of `main`)

| Commit | SHA | Description |
|--------|-----|-------------|
| 1 | `c09acc2` | Angular 20→22, TypeScript 5.8→6.0, CDK 20→22 |
| 2 | `01e91af` | keycloak-angular 20→22 |
| 3 | `e273f8c` | Companion libraries + remove ngx-tiptap |

**Key corrections to the plan**:
- TypeScript target was **6.0**, not 7.0. TS 7.0 is the Go-native rewrite (still in development).
- Angular requires **one-major-at-a-time** stepping (20→21→22), not direct 20→22. Same for CDK.
- Node.js minimum bumped from v22.20.0 to v22.22.3+ (upgraded to v22.23.2 via nvm).

**Angular 22 schematics applied**:
- 44 files: `*ngIf`/`*ngFor` → `@if`/`@for` block control flow (Angular 21 migration)
- 9 components: `ChangeDetectionStrategy.Default` → `ChangeDetectionStrategy.Eager` (Angular 22 rename)
- 53 test files: added `withXhr()` to `provideHttpClient()` calls (Angular 22 XHR opt-in)
- 9 templates: optional chaining wrapped with `$safeNavigationMigration()` (Angular 22)
- `tsconfig.json`: `lib` property removed by Angular 21 migration
- `tsconfig.app.json` + `tsconfig.spec.json`: extended diagnostics suppressions added

**Companion library issues resolved**:
- `@dintecom/ngx-currency`: `NgxCurrencyDirective` renamed to `NgxCurrency` (2 files updated)
- `ngx-markdown` v22: `prismjs` dropped as transitive dep (added as direct), `marked-katex-extension` now required (added)
- `angular-eslint` v22: new `prefer-on-push-component-change-detection` rule — disabled in eslint.config.js (non-a11y)
- `ngx-tiptap`: removed (confirmed never imported, markdown editor uses @tiptap/core directly)

**Verification results**:
- `npx tsc --noEmit`: zero type errors (spec files use separate tsconfig)
- `npm run build`: clean production build (3 existing CommonJS warnings from @unovis only)
- `npm run test:headless`: 3034 SUCCESS, 1 SKIPPED (same as baseline)
- `npm run lint`: 0 errors, 140 warnings (same as baseline)
- Playwright visual regression: 7 pages compared, zero regressions detected
- Docker build: initially failed — initial bundle grew from ~2.95 MB to 3.06 MB (Angular 22 core + prismjs + marked-katex-extension), exceeding the 3.00 MB `maximumError` budget. Fixed by bumping `angular.json` budget to 3.25 MB. Container builds clean after the fix.

**Actual versions installed** (from → to):
| Package | Before | After |
|---------|--------|-------|
| `@angular/*` | 20.3.30 | 22.1.5 |
| `@angular/cdk` | 20.2.14 | 22.1.5 |
| `@angular/cli` | 20.3.36 | 22.1.7 |
| `typescript` | 5.8.3 | 6.0.3 |
| `keycloak-angular` | 20.1.0 | 22.0.0 |
| `ngx-markdown` | 20.1.0 | 22.0.2 |
| `ngx-mask` | 20.0.3 | 22.1.0 |
| `@dintecom/ngx-currency` | 20.0.0 | 22.0.0 |
| `angular-eslint` | 20.7.0 | 22.2.0 |
| `ngx-matomo-client` | 8.0.0 | 10.0.0 |

---

### Phase 2: ESLint 9 → 10 (confidence builder)

**Risk**: LOW
**Blast radius**: Dev tooling only — no UI changes.

#### Scope (2 packages)

- `eslint` 9 → 10
- `@eslint/js` 9 → 10
- ~~`typescript-eslint` 8 → 9~~ — v9 doesn't exist; v8.69.0 already supports ESLint 10 via peer dep

#### Execution

1. Branch: `upgrade/angular-22` (continuing from Phase 1)
2. `npm install eslint@10 @eslint/js@10`
3. Review `eslint.config.js` for deprecated options — already uses flat config

#### Key file

- `eslint.config.js` — verify `tseslint.configs.recommended` and `angular.configs.*` compatibility

#### Verification

```bash
npm run lint                # passes — this IS the regression test for ESLint
npm run test:headless       # still passes (dev-only dep, but confirm no side effects)
npm run build               # still builds (ESLint is not in build path, but sanity check)
```

#### Playwright MCP: Smoke-only (no UI blast radius)

```
1. Navigate → http://localhost:4200/
   → Verify: dashboard loads without console errors
   → snapshot page — compare to Phase 1 screenshot (should be identical)
```

#### Rollback

Revert 2 devDependencies. Zero production impact.

#### Phase 2 Results (2026-09-04)

**Status**: COMPLETE — single commit, zero regressions.

**Branch**: `upgrade/angular-22` (continuing from Phase 1)

**Scope correction**: `typescript-eslint` v9 does not exist. The package stays on major version 8 (v8.69.0), which already declares `eslint: '^8.57.0 || ^9.0.0 || ^10.0.0'` in its peer deps. Only 2 packages upgraded, not 3.

| Package | Before | After |
|---------|--------|-------|
| `eslint` | 9.39.5 | 10.10.0 |
| `@eslint/js` | 9.39.5 | 10.0.1 |

**New `eslint:recommended` rule findings**: ESLint 10 adds 3 rules to `eslint:recommended`. Only `no-useless-assignment` fired (2 errors):
- `data.service.ts:150` — `let totalCount = 0` initializer dead (all branches reassign)
- `recurring.service.ts:599` — `let description = ''` initializer dead (switch has default case)

Both fixed by removing the initializer value (`let x = 0` → `let x: type`), which is correct since every code path assigns before use.

The other 2 new rules (`no-unassigned-vars`, `preserve-caught-error`) produced zero hits.

**Verification results**:
- `npm run lint`: 0 errors, 140 warnings (same warning count as Phase 1 baseline)
- `npm run test:headless`: 3034 SUCCESS, 1 SKIPPED (unchanged from baseline)
- `npm run build`: clean production build (same 2 CommonJS warnings from @unovis)

---

### Phase 3: Jasmine 5 → 7 (+ Karma→Jest if not done in Phase 1)

**Risk**: MEDIUM
**Blast radius**: Test infrastructure only — no production code changes. But test failures must be triaged.

**Rationale**: Test framework upgrade isolated from Angular changes so failures are unambiguous. Done before risky library upgrades so the test suite is current when we need it most.

#### Scope (2–4 packages)

- `jasmine-core` 5 → 7
- `@types/jasmine` 5 → 6
- If Karma→Jest was NOT done in Phase 1: migrate here
- If Karma is still supported: `karma-jasmine` + `karma` compatibility check

#### Execution

1. Branch: `upgrade/jasmine-7`
2. Read Jasmine 6 + 7 changelogs for matcher/async changes
3. `npm install jasmine-core@7 @types/jasmine@6`
4. Run and triage:
   ```bash
   npm run test:headless 2>&1 | tee /tmp/jasmine7-output.txt
   grep "FAILED" /tmp/jasmine7-output.txt
   ```
5. Watch for: `toBeTrue()`/`toBeFalse()` changes (216 uses across 29 files), `async` test handling, `jasmine.clock()` behavior
6. Compare test count to baseline (no accidental skips)

#### Playwright MCP: Smoke-only (no production blast radius)

```
1. Navigate → http://localhost:4200/
   → Verify: dashboard loads
   → snapshot — compare to Phase 2 (should be identical)

2. Navigate → /view/Issue
   → Verify: list page renders with data
```

#### Rollback

Revert devDependencies. Zero production impact.

---

### Phase 4: FullCalendar 6 → 7

**Risk**: MEDIUM | **No deadline**
**Blast radius**: Calendar views on list/detail pages + dashboard calendar widgets. RTL rendering.

#### Scope (5 packages)

- `@fullcalendar/angular`, `core`, `daygrid`, `interaction`, `timegrid` — all 6 → 7

#### Key files (2 components)

- `src/app/components/time-slot-calendar/time-slot-calendar.component.ts` — 437 lines, imperative API (`getApi()`, `addEventSource()`, `changeView()`, `gotoDate()`, `setOption()`)
- `src/app/components/widgets/calendar-widget/calendar-widget.component.ts`

#### Execution

1. Branch: `upgrade/fullcalendar-7`
2. Read FC v7 migration guide — focus on plugin registration API and Angular wrapper changes
3. `npm install @fullcalendar/angular@7 @fullcalendar/core@7 @fullcalendar/daygrid@7 @fullcalendar/interaction@7 @fullcalendar/timegrid@7`
4. Fix compilation errors in the 2 component files
5. Verify RTL behavior with `api.setOption('direction', 'rtl')`

#### Layer 1 verification

```bash
npm run test:headless    # calendar component specs must pass
npm run build            # production build succeeds
```

#### Playwright MCP: Calendar-focused regression

Need a running example with time_slot entities (e.g., community-center example). Start Docker stack for an example with calendar entities.

**Calendar on list pages**:
```
1. Navigate → list page for an entity with show_calendar=true
   → Verify: calendar renders in month view (grid of day cells visible)
   → screenshot: "phase4-calendar-month"

2. Click "Week" view button
   → Verify: week view renders with time grid
   → screenshot: "phase4-calendar-week"

3. Click "Day" view button
   → Verify: day view renders with hourly slots
   → screenshot: "phase4-calendar-day"

4. Click prev/next navigation arrows
   → Verify: calendar navigates to adjacent month/week/day
   → Verify: URL params update (date range reflected in URL)

5. Click on a calendar event
   → Verify: navigates to the entity's detail page
```

**Calendar on dashboard**:
```
6. Navigate → / (dashboard with calendar widget configured)
   → Verify: calendar widget card renders with events
   → screenshot: "phase4-dashboard-calendar"
```

**Calendar on detail pages (recurring time slots)**:
```
7. Navigate → detail page of an entity with time_slot property
   → Verify: inline calendar renders showing the entity's time slots
   → screenshot: "phase4-detail-calendar"
```

**RTL regression**:
```
8. If RTL locale available: switch to RTL language in settings
   → Navigate → calendar list page
   → Verify: calendar renders right-to-left (navigation arrows flipped, text aligned right)
   → screenshot: "phase4-calendar-rtl"
```

**Non-calendar pages (negative test — should be unaffected)**:
```
9. Navigate → /view/Issue (no calendar)
   → Verify: list page renders normally, no regressions
   → snapshot — compare to Phase 3 (should be identical)
```

#### Rollback

Revert 5 packages. FullCalendar v6 is stable with no EOL pressure.

---

### Phase 5: Blockly 12 → 13 + @pgsql/parser 1.2 → 1.5

**Risk**: HIGH | **No deadline** | **Admin-only features**
**Blast radius**: System pages only — `/system/functions`, `/system/policies`, `/system/entity-code/:tableName`

**Rationale**: Highest risk, lowest user impact. Affects only admin code-visualization pages. Done last so all other upgrades are stable. **Two separate commits** so either can be reverted independently.

#### Part A: Blockly 12 → 13

**Fragile integration points**:
1. Lazy import chain (`blockly/core` → `blockly/msg/en` → `blockly/blocks`) — ESM exports may change
2. `Object.assign(Blockly.Msg, en)` workaround
3. `Blockly.common.defineBlocks()` + `createBlockDefinitionsFromJsonArray()`
4. `Blockly.inject()` with zelos renderer
5. `Blockly.serialization.workspaces.load()`
6. `Blockly.svgResize()`

#### Part B: @pgsql/parser 1.2 → 1.5

**Key file**: `src/app/services/sql-parser.service.ts` — WASM loader with `/* @vite-ignore */` dynamic import

**Built-in fallback**: If WASM fails, `SqlBlockTransformerService` falls back to regex parsing automatically.

#### Layer 1 verification

```bash
npm run test:headless    # blockly-viewer and ast-to-blockly specs pass
npm run build            # production build succeeds (Blockly is lazy-loaded)
```

#### Playwright MCP: System page regression (admin-only blast radius)

Login as testadmin first (admin role required for system pages).

**System Functions page (Blockly + @pgsql/parser)**:
```
1. Navigate → /system/functions
   → Verify: function list renders with function names
   → screenshot: "phase5-system-functions-list"

2. Click on a function name (e.g., first function in the list)
   → Verify: code viewer panel opens
   → Verify: "Blocks" toggle/tab is visible
   → screenshot: "phase5-function-detail-sql"

3. Click "Blocks" toggle to switch to Blockly view
   → Verify: Blockly workspace renders with colored blocks
   → Verify: blocks are read-only (cannot drag)
   → Verify: no console errors (check browser_console_messages)
   → screenshot: "phase5-function-blockly-view"
```

**Theme switching (Blockly theme integration)**:
```
4. Open settings → change DaisyUI theme to a dark theme (e.g., "dark" or "dracula")
   → Navigate back to /system/functions → click a function → switch to Blocks view
   → Verify: Blockly theme swaps to dark variant (dark background, light text on blocks)
   → screenshot: "phase5-blockly-dark-theme"

5. Switch back to "corporate" (default light theme)
   → Verify: Blockly reverts to light theme
```

**Entity Code page (Blockly for VIEW definitions)**:
```
6. Navigate → /system/entity-code/Issue (or any entity table name)
   → Verify: SQL source code renders
   → Switch to Blocks view
   → Verify: Blockly workspace renders the VIEW definition as blocks
   → screenshot: "phase5-entity-code-blocks"
```

**System Policies page**:
```
7. Navigate → /system/policies
   → Verify: policy list renders
   → Click a policy → verify code visualization renders
   → screenshot: "phase5-policies"
```

**WASM fallback verification (@pgsql/parser specific)**:
```
8. Check browser console messages after steps 2-7
   → Verify: no WASM loading errors
   → If WASM errors present: verify regex fallback kicks in (blocks still render, just simpler structure)
```

**Non-system pages (negative test — should be unaffected)**:
```
9. Navigate → /view/Issue
   → Verify: list page renders normally
   → snapshot — compare to Phase 4 (should be identical)

10. Navigate → /
    → Verify: dashboard renders normally
    → snapshot — compare to Phase 4 (should be identical)
```

#### Rollback

Revert either package independently. Admin-only features with zero user data impact.

---

## Summary

| Phase | Scope | Pkgs | Risk | Blast Radius | Playwright Tests |
|-------|-------|------|------|--------------|-----------------|
| 0 | Pre-flight baseline | 0 | — | — | 9 reference screenshots |
| 1 | Angular 22 + TS 6 + companions | ~22 | MED | All pages | 13 tests: auth, CRUD, dashboard, admin, system |
| 2 | ESLint 10 | 2 | LOW | Dev tooling | 1 smoke test |
| 3 | Jasmine 7 | 2–4 | MED | Test infra | 2 smoke tests |
| 4 | FullCalendar 7 | 5 | MED | Calendar pages + dashboard widgets | 9 tests: month/week/day, nav, events, RTL, dashboard |
| 5 | Blockly 13 + pgsql/parser 1.5 | 2 | HIGH | System pages (admin-only) | 10 tests: functions, code viewer, blocks, theme, policies, WASM |

**Total**: ~9–14 days across all phases. Each phase on its own branch, independently deployable and revertable.

### Ordering rationale
1. **Angular first** — only upgrade with an EOL deadline
2. **ESLint second** — low-risk confidence builder, validates toolchain
3. **Jasmine third** — test framework current before risky library upgrades
4. **FullCalendar fourth** — user-facing but no deadline
5. **Blockly + parser last** — highest risk but admin-only, lowest blast radius
