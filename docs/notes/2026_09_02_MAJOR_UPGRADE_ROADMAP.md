# Major Dependency Upgrade Roadmap

Planned major version upgrades for Civic OS, ordered by urgency. Created September 2026 after the PostgREST v16.2 upgrade (v0.73.0) and dependency audit.

For the PostgREST upgrade procedure, see `docs/development/POSTGREST_UPGRADE_RUNBOOK.md`.

## Angular 20 → 22

**EOL: November 2026** — plan now, execute Q4 2026

Angular 22 ("signal-first") shipped June 2026 with selectorless components and stable Signal Forms. Civic OS already uses Signals + OnPush everywhere, so the migration should be primarily mechanical.

**Scope** (16 Angular packages + 6 companions):
- `@angular/*` v20 → v22 (core, common, forms, router, compiler, CDK, service-worker, etc.)
- `@angular-devkit/build-angular` + `@angular/cli` + `@angular/compiler-cli`
- `typescript` 5.8 → 7.0 (required by Angular 22)
- `keycloak-angular` 20 → 22
- `ngx-markdown` 20 → 22
- `ngx-mask` 20 → 22
- `@dintecom/ngx-currency` 20 → 22
- `angular-eslint` 20 → 22
- `ngx-matomo-client` 8 → 10

**Approach**:
1. Use `ng update @angular/core@22 @angular/cli@22` for guided migration
2. Update companion libraries after core upgrade
3. Run full test suite (3000+ unit tests) + pa11y accessibility gate
4. CI already uses Node 22 — no CI changes expected

**Risk**: MEDIUM — large dependency tree but no architectural changes needed. TypeScript 7.0 may surface new strict-mode warnings.

## Blockly 12 → 13

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

**Approach**:
1. Read Blockly v13 changelog for breaking changes
2. Upgrade in isolation (don't batch with other upgrades)
3. Update `sql-blocks.ts` if JSON format changed
4. Verify `civic-os-theme.ts` with new Theme API
5. Visually verify `/system/entity-code/:tableName`, `/system/functions`, `/system/policies` pages

**Risk**: HIGH — custom block definitions and theme API are the most fragile integration points.

## FullCalendar 6 → 7

**No deadline** — stable on v6, patches still shipping (6.1.21)

**Scope**: 5 packages (`@fullcalendar/angular`, `core`, `daygrid`, `interaction`, `timegrid`)

**Usage**:
- `TimeSlotCalendarComponent` — entity calendar views with day/week/month
- Dashboard calendar widgets
- RTL support via `api.setOption('direction', 'rtl')`

**Approach**:
1. Read FullCalendar v7 migration guide (major versions typically change plugin registration and theme API)
2. Test calendar pages and dashboard calendar widgets
3. Verify RTL behavior

**Risk**: MEDIUM — plugin registration API usually changes between FC majors.

## @pgsql/parser 1.2 → 1.5

**No deadline** — admin-only feature (code visualization), has regex fallback

**Scope**: WASM PostgreSQL parser used for PL/pgSQL → Blockly AST conversion.

**Known concerns**:
- Emscripten-generated WASM references `require('fs')` and `require('crypto')` behind runtime checks
- Angular's esbuild bundler resolves these statically — current workaround uses `/* @vite-ignore */` with variable import path to defer to runtime
- 3-minor-version jump (1.2 → 1.5) may change internal WASM module structure

**Files affected**:
- `src/app/services/sql-parser.service.ts` — WASM loading and caching

**Approach**:
1. Upgrade alone (never batch with other changes)
2. Test `/system/entity-code/:tableName` and `/system/functions` pages
3. Check browser console for WASM load errors
4. Verify no bundle size regression

**Fallback**: `SqlParserService.ensureLoaded()` returns null on failure — services fall back to regex-based parsing.

**Risk**: MEDIUM — WASM bundler interaction is fragile.

## Jasmine 5 → 7 + @types/jasmine 5 → 6

**No deadline** — test framework, no production impact

**Scope**: Test runner and assertion library used by 3000+ unit tests.

**Risk**: MEDIUM — assertion API changes could surface across many test files.

**Approach**: Upgrade in isolation, run full test suite, fix any assertion API changes.

## ESLint 9 → 10

**No deadline** — linter, no production impact

**Scope**: `eslint` 9 → 10, `@eslint/js` 9 → 10

**Risk**: LOW — mostly configuration format changes. Civic OS already uses flat config.

**Approach**: Follow ESLint migration guide, update config if needed, run `npm run lint`.
