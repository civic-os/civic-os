# SDK Packages (`@civic-os/core`, `@civic-os/cli`)

Developer guide to the npm workspace packages under `packages/`. The design and the reasons behind it are in `docs/notes/FRONTEND_SDK_DESIGN.md`; this file is how to build, test, extend and release them.

## Layout and licensing

```
packages/core   @civic-os/core   Apache-2.0   framework-agnostic interpreter of the metadata contract
packages/cli    @civic-os/cli    Apache-2.0   `civic-os gen types`, built on core
src/            civic-os (app)   AGPL-3.0-or-later   the generic Angular app
tools/mcp-server @civic-os/mcp-server  AGPL-3.0-or-later   the MCP server
scripts/        build, check and golden tooling   AGPL-3.0-or-later
```

`@civic-os/core` is plain TypeScript with no runtime dependencies: no Angular, no rxjs, no signals, no `node:` builtins. Promises in, plain data out, a `fetch`-shaped transport interface, and a small subscribe-able store. Each module owns a barrel `index.ts`; `packages/core/src/index.ts` only re-exports the barrels. `@civic-os/cli` depends on core and may use `node:` builtins.

Modules of core: `model` (interfaces), `schema` (property-type detection, select strings, relations, validation rules), `query` (filter compilation, response handling, and `query/typed` for the typed `with` API), `transform` (value transforms, the integrity-critical datetime handling), `conditions`, `errors`, `transport`, `client` (`SchemaClient`, `DataClient`, store), `names`, `handles`, `version`, `typed-client`, and the facade foundation of Phase 2: `state` (the snapshot store and the clock port), `plan` (render plans and presentation overlays) and `forms` (the form backend port, the form store and validation as data), and `facades` (the page facades `recordList`, `recordViewer` and `recordEditor`). A second entry point, `@civic-os/core/testing`, holds fixtures and fakes (`createFakeClock`).

How each consumer resolves core:

- The Angular app maps `@civic-os/core` to `packages/core/src/index.ts` through `tsconfig.json` paths, so it always runs on source.
- The MCP server depends on `file:../../packages/core`; both packages expose a `@civic-os/source` export condition that points at `src/`. `docker/mcp-server/Dockerfile` copies each linked package's `package.json` and `src/`.
- `docker/frontend/Dockerfile` copies every workspace manifest before `npm ci`. `npm run check:docker-workspaces` fails when either Dockerfile drifts.

### Boundaries, SPDX headers, versions

- **Dependency direction is a license boundary.** Apache packages never import the AGPL app, `tools/**` or another AGPL package; core imports only relative paths; every runtime dependency of an Apache package must carry a permissive license. Enforced twice: `npm run check:boundaries` (manifests and imports) and the `packages/**` blocks of `eslint.config.js` (`npm run lint` runs `eslint packages`).
- **SPDX headers.** Every source file under `packages/` carries `Copyright (C) 2023-YYYY Civic OS, L3C` and `SPDX-License-Identifier: Apache-2.0`. No file outside `packages/` may carry the Apache identifier. `npm run check:spdx`.
- **Lockstep versions.** The root `package.json` version is the source of truth for the root app, every `packages/*` package and `tools/mcp-server`. Internal `@civic-os/*` dependency specs are pinned to exactly that version. `npm run check:versions` reports drift; `npm run sync-versions` rewrites manifests and lockfiles (it runs from the `postversion` hook).

## Building and testing

| Script | What it does |
|---|---|
| `npm run build:packages` | `tsc -b` for core and cli (emits `dist/`, which `golden:codegen` and `test:sdk-consumer` need) |
| `npm run test:packages` | Unit tests, type tests and the time-zone matrix, in that order |
| `npm run test:packages:unit` | Vitest for core and cli |
| `npm run test:packages:types` | Core type tests (`*.test-d.ts`) under both `exactOptionalPropertyTypes` settings |
| `npm run test:packages:tz` | Every package suite under UTC, America/New_York, Asia/Kolkata and Australia/Lord_Howe (`scripts/test-packages-tz.mjs`) |
| `npm run check:packages` | Build, publint, attw, `api:check`, SPDX, versions, boundaries, Docker workspaces, dogfood self-test, and `check-dogfood.mjs --strict` |
| `npm run check:dogfood` | The dogfooding report, informational (exit 0) |
| `npm run test:sdk-consumer` | Type-checks the consumer fixture under both `exactOptionalPropertyTypes` settings and runs it |
| `npm run golden:codegen` / `golden:codegen:check` | Regenerate / verify the generated-types snapshots |
| `npm run api:report` / `api:check` | Rewrite / verify the public API report |
| `npm run lint` | Includes `eslint packages` and its license-boundary rules |

Also run `npm run test:headless` (the app) and, in `tools/mcp-server`, `npm run build && npm test`: both consume core.

**CI** (`.github/workflows/test.yml`, job "SDK Packages", also triggered for `sdk/**` branches): install, `build:packages`, `test:packages`, `eslint packages`, publint, attw, `api:check`, SPDX, versions, boundaries, Docker workspaces, the dogfood self-test, `check-dogfood.mjs --strict`, `test:sdk-consumer`, `golden:codegen:check`, and the golden tooling self-test.

## The public API report

`packages/<name>/api-report.md` lists every name exported from each `exports` subpath with its kind, its checker-printed signature and its `@consumer` tag. It is generated by `scripts/api-report.mjs`; never edit it by hand.

```bash
npm run api:report   # rewrite after changing an export, then commit the diff
npm run api:check    # CI: fails when a committed report is stale
```

A diff in the report is a public API change and is reviewed as one.

## The dogfooding rule

Every export of `@civic-os/core` must be exercised by a real consumer, so the public API is the one the generic app and the MCP server actually run on. Each export may carry a TSDoc `@consumer` tag; an export without one defaults to `app`. `scripts/check-dogfood.mjs` finds references with the TypeScript language service (`findReferences`) and, under `--strict`, fails when an expectation is unmet.

| Tag | Met when |
|---|---|
| `app` (default) | The generic app has a call site in `src/**` (specs excluded) |
| `mcp` | The MCP server has a call site in `tools/mcp-server/src/**` (tests excluded) |
| `tooling` | The CLI (`packages/cli/src`, tests and test support excluded) or a script in `scripts/` that imports core has a call site |
| `custom-app` | The consumer fixture `tests/sdk-consumer/**` has a call site (`*.test.ts` there excluded) |
| `typed <Export>` | Part of the type surface of `<Export>` (an option type, result shape, union member); needs no call site of its own, but `<Export>` must itself be met |

The `typed` rule is transitive: `<Export>` must have an app, mcp, tooling or custom-app call site, or itself be `typed Z` with Z met. A cycle, or a chain ending at an export with no consumer, is unmet and the message names the chain end. Tags are verified, not trusted: a tag cannot certify itself.

What never counts as use, whatever its form: import bindings, and re-exports (`export { X } from`, `export type { X } from`, `export { X as Y }`, `export { X }` lists, `export default X`, `export * from`). Usages through a re-export shim do count. Test files (`*.spec.ts`, MCP tests, core's own tests and type tests) never satisfy an expectation either.

Two rules follow from this:

- An export with no consumer is removed from the barrel, not exempted. Helpers that only tests used were taken out of the public API and can be re-exported when a consumer exists: `compileDataQuery`, `CompileDataQueryOptions`, `CompiledDataQuery`, `FILTER_OPERATORS`, `FilterOperator`, `parseContentRangeTotal`, `parseMoneyOutput`, `extractConstraintName` and `ERROR_KIND_PRECEDENCE`, plus the test-only `evaluateCondition`, `ConditionCoercion`, `EvaluateConditionOptions`, `exactCaseInsensitivePattern` and `isSelectableColumn`. Their assertions live in core's own tests. The `Store` type stays public, tagged `typed SchemaClient`, because the public getter `SchemaClient.entitiesStore` returns it. `createStore` was removed in Phase 1 and returned in Phase 2 through the `state` barrel, once `tests/sdk-consumer/store.ts` gave it a `custom-app` caller.
- `npm run check:dogfood:self-test` runs the checker against an in-memory fixture to prove that re-exports never count.

### Why `tests/sdk-consumer/` exists

The generic app deliberately never uses generated types: it reads the schema dynamically. So the custom-app surface (`bootstrapTypedSchema`, `compileWith`, `defineQuery`, `checkCompatibility`, the typed-client error classes, the type-level API, and the Phase 2 `createStore`, `presentation`, `createFormStore` and `validate*` functions) has no natural app or MCP caller. Rather than exempt those exports, the repository carries `tests/sdk-consumer/`: a small issue-triage program written the way an external custom app would use the SDK. It imports core only through its public entry point and the committed generated snapshot `tests/golden/codegen/pothole.ts`, runs against a fixture transport with `node:assert`, and is type-checked under both `exactOptionalPropertyTypes` settings. It is not a test file and has no runner. The `@consumer custom-app` tag is verified against it. When a real custom app exists, it replaces the fixture as the proof.

## Handles

`SchemaClient.entity(name)` returns an `EntityHandle | undefined`; handles of properties and actions come from the entity handle. A handle stores only a name or key and re-reads the live schema store on every getter, so it never keeps a row alive: after an invalidation, a locale or identity switch, or a refresh that removes the entity, `exists` is `false` and getters return `undefined` instead of throwing or serving stale data. Handle constructors are private (core mints them), so a presence check cannot be skipped. Each getter is `X | undefined`, including `can`, `features` and `structural`.

```ts
const issue = schema.entity('Issue');           // EntityHandle | undefined
const allowed = issue?.can?.insert;             // boolean | undefined
const status = issue?.property('status');       // PropertyHandle | undefined
```

The app resolves its own entity lookups through handles. The MCP schema cache stays on its derived map, because a handle reports absence during a section refresh, which would change request-time behavior.

## Typed queries

The query is a plain, JSON-serializable object, `{ select?, with? }`, with a Drizzle-style `with` tree; the types are inferred from the generated `Database` by mapped and conditional types, with no string parsing. `compileWith(entity, query, schema)` compiles it with the same junction, `!fk` and default-embed rules as the app's select strings and returns `{ select, params }`. PostgREST takes an embed's `limit` and `order` as query parameters addressed by the embed's alias path, so append `params` to the request next to `select=<select>`.

```ts
const triage = defineQuery<'Issue'>()({
  select: ['id', 'display_name', 'status'],
  with: {
    work_package: { columns: ['id', 'display_name'] },
    issue_tags_m2m: { columns: ['display_name'], limit: 3 },
    WorkDetail: { columns: ['id', 'display_name'], order: { column: 'id', direction: 'desc' }, limit: 5 },
  },
});
```

(from `tests/sdk-consumer/main.ts`). Rules worth knowing:

- **Relation keys are the runtime names** of the relation graph: the M:M virtual property name (`issue_tags_m2m`), the FK column name, or the source table of an inverse FK (`WorkDetail`). They match the generated `Relations` block exactly.
- **`defineQuery`** is the hoisting helper: it returns its argument unchanged, typed as the exact literal, so a query defined away from its call site is checked and keeps its result type. Each generated file exports one bound to its `Database`, so a query names only its entity: `defineQuery<'Issue'>()`. A name that is not an entity of that `Database` fails to compile. Core's unbound `defineQuery<D, E>()` stays for code that is generic over the `Database` (the fixture keeps one such call, for the dogfood tag).
- **Order on an M:M embed throws** `QueryValidationError`. So do unknown entities, columns, relations and order columns, and `columns`, `with`, `limit` or `order` on a system embed (status, category, user, file, payment), which takes only `true`.
- **Duplicate foreign keys**: when two FKs of one table point at the same target, only the first inverse is exposed on the target (as `inverseRelationships` does for the app).
- **System embeds are not `Relations`.** Their targets are not entities; they are reached through `select` and typed by `Embedded`.
- **tsvector columns** leave the default row through one shared predicate (`isSelectableColumn` in `query/typed/graph.ts`) that codegen reuses, so the typed `Row` has exactly the keys a default select returns.
- **M:M results** are typed as target-row arrays: the shape after core's `transformManyToManyData`, not the raw PostgREST junction rows. A typed executor must apply that transform. Rich-junction `_junction` data is not typed yet. Codegen marks M:M relations `via: 'junction'`: `true` (or only a `limit`) sends the M:M property's own embed and types only the target's `id`, `display_name` and `color` (where it has one); `columns` and `with` pick from the whole target row. An inverse FK's `true` is the whole row.
- **Filters** accept PostgREST's full operator grammar in core (`not.` prefix, `(any)` and `(all)` quantifiers, `fts(lang)` language), so stored dashboard filters keep working; an operator outside it throws `QueryValidationError`. The MCP `list_records` tool deliberately offers a narrower, documented enum.

## Codegen: `civic-os gen types`

```bash
# from a captured raw variant directory (no network)
node packages/cli/dist/bin.js gen types --from-fixture tests/golden/raw/pothole/testadmin --out src/civic-os.types.ts

# from a live PostgREST API; use an admin token, which sees the full contract
npx civic-os gen types --url https://example.org/api --token "$ADMIN_JWT" --out src/civic-os.types.ts
```

Exactly one of `--from-fixture` and `--url` is required. The generator reads the same views the MCP schema cache reads, builds embed shapes by calling core's own select compiler (so the types cannot drift from what the app requests), and emits one committed file: `DOMAIN_VERSION`, `FRAMEWORK_VERSION`, `SCHEMA_HASH`, the `Database` interface (per entity `Row`, `Insert`, `Update`, `Embedded`, `Relations`, `Statuses`, `Actions`, `Features`), data-derived `*StatusKey` unions, and a `defineQuery` bound to that `Database`. The file imports core's `defineQuery`, so it needs `@civic-os/core` at compile and run time. The `SCHEMA_HASH` is the instance's `contract_hash` from `schema_domain_version`; codegen reads it and never computes it. An instance older than v0.77.0 has no such view and the run stops with a message that says so. See `docs/INTEGRATOR_GUIDE.md` (Domain Version).

### Snapshots

`tests/golden/codegen/<example>.ts` holds the generated file for the admin variant of every raw capture listed in `tests/golden/raw/MANIFEST.json`. A cross-check test compares every embedded shape with core's default select. CI runs `npm run golden:codegen:check` after the packages build.

```bash
npm run build:packages
npm run golden:codegen          # rewrite the snapshots, then review and commit the git diff
npm run golden:codegen:check    # compare only
```

Regenerate after changing the generator, core's select rules, the contract hash fixture, or any raw capture, and treat the diff as the change under review.

## The typed client

`bootstrapTypedSchema<Database>({ schema, understands, onIncompatible, onWarn })` loads the schema, reads the instance's domain version record, compares the generated `SCHEMA_HASH` once, and returns `{ entities, mode, instance, compatibility }`.

```ts
const typed = await bootstrapTypedSchema<Database>({
  schema,                                                    // a SchemaClient
  understands: { domain: DOMAIN_VERSION, schemaHash: SCHEMA_HASH },
  onIncompatible: 'block',
});
typed.entities.Issue.property('status');                     // PropertyHandle, never undefined
typed.entities.Issue.optional('contact_phone');              // PropertyHandle | undefined
await typed.entities.Issue.loadActions();                    // actions load lazily
```

- `entities` is a Proxy over the live store: one accessor per generated entity name, no runtime entity list in the generated file. An accessor exposes `handle`, `property(column)`, `optional(column)`, `action(key)` and `loadActions()`. After `clear()` the accessors throw `SchemaContractError` until the store reloads; `mode` stays as it was, because the hash is role-independent.
- **The floor always blocks.** If the instance's `min_client_domain_version` is above the app's `DOMAIN_VERSION`, bootstrap throws `ClientUpdateRequiredError` under every policy. The floor fails closed: when the instance sets one and a version is not valid semver, a `SchemaMismatchError` with reason `invalid` is thrown. Bootstrap reads the version with `SchemaClient.readDomainVersion()`, which resolves `undefined` only for an absent view (404 / PGRST205 / 42P01) or an empty result; any other failure rejects with its `DataClientError` or `TransportError`, so an unreachable instance never skips its floor. `getDomainVersion()` stays forgiving (any failure is `undefined` and goes to `onError`) for display, as in the About modal.
- **`onIncompatible` governs only** a hash mismatch, a missing `schema_domain_version` view (`unverifiable`) and a client ahead of the instance (`client-ahead`):

| Policy | On a mismatch | `mode` |
|---|---|---|
| `block` | throws `SchemaMismatchError` | not returned |
| `warn` | calls `onWarn` once (default `console.warn`), then trusts the accessors | `trusted-after-warning` |
| `verify` | calls `onWarn`, and re-checks presence on every accessor call | `per-call` |

On a match every policy yields `verified` and handles are resolved once and memoized.

- Error classes: `ClientUpdateRequiredError` (the floor), `SchemaMismatchError` (carries a `SchemaMismatch` with `reason`, hashes and versions), `SchemaContractError` (an entity, column or action the generated types promise is missing from the live store; `member` is `undefined` when the entity itself is missing).
- `checkCompatibility(instance, app)` is the pure comparison behind it, usable on its own.

## State: the store and the clock

`createStore<T>(initial)` is the one state primitive facades build on: `getSnapshot()`, `subscribe(listener)` (returns an unsubscribe) and `set(next)`. It is the contract React's `useSyncExternalStore` wants. A snapshot is the same reference until `set` replaces it, and `set` with the current value (by `Object.is`) notifies nobody. Core has no rxjs and no signals; the app reads a store as a signal with `storeToSignal`, or with `switchingStore` when the store changes over the page's life, as each page's facade does (`docs/development/ANGULAR.md`, Core stores in Angular).

`Clock` is a port with one method, `now(): Date`, returning a fresh `Date` on every call. `systemClock` is the real one. Code that computes ranges from "now" (calendar weeks, the list page's default calendar range) takes a clock instead of calling `new Date()`. Tests use `createFakeClock(start)` from `@civic-os/core/testing`, with `set(time)` and `advance(ms)`.

## Render plans and overlays

`resolvePlan(source, mode, overlay?)` merges three inputs into the ordered list a Detail, Create or Edit page renders: schema truth, the metadata presentation defaults (`show_on_*`, `sort_order`, `column_width`, `display_name`) and an optional code overlay. `source` is `{ properties, staticTexts }`: every property of the entity, M:M-enriched, and the entity's static text.

```ts
const plan = resolvePlan({ properties, staticTexts }, 'create', residentReport);
plan.sections;   // [{ title, items }]: items are { kind: 'property', key, property, label, span } or { kind: 'static_text', key, block, span }
plan.items;      // every section's items, concatenated in order
```

- **No overlay is today's page.** Without an overlay (or without an entry for the mode) the plan's items are exactly the renderables the pages rendered before: the same filter per mode, the same tagged property objects, the same spans, ordered by `compareBySortOrder` and nothing else. `SchemaService.get*Renderables` now returns `resolvePlan(...).items`, and the golden renderables did not move.
- **An overlay can only subtract, reorder, rename and group.** Per mode: `hide` drops properties, `order` moves the listed properties first (then everything else in metadata order), `rename` replaces a label with text or `{ translationKey }`, and `sections` groups properties under titles, with everything not listed (static text included) in one trailing untitled section. A property listed twice goes to its first section, and a section left with no items is dropped. A name the base plan does not hold (unknown, hidden by metadata, or hidden by `hide`) is ignored everywhere, so an overlay can never bring a field back. Static text is never hidden, renamed or listed, so under `order` it stays in metadata order among the properties `order` leaves unlisted, after the listed ones, and under `sections` it falls into the trailing untitled section. Layout is the custom app's choice: to keep the admin's ordering of fields and static text, resolve the plan without an overlay (or without `order` and `sections`); for its own layout, an app places its own static content or renders its own fields. Hiding is presentation only: it never changes a select.
- **`presentation<Database, 'Issue'>(overlay)`** is an identity helper that checks an overlay against generated types: names are the entity's stored columns plus its M:M relation keys. An unknown column, an inverse relation, or any key other than `hide`, `order`, `rename` and `sections` (`add`, `validators`, `transitions`) fails to compile. So does a `list` entry: list pages are not planned yet.

## The form model

Form logic is the facade's; form state is a backend's, behind the `FormBackend` port: values, errors, touched, dirty and enabled per field, bulk `setValues` and `reset`, plus `subscribe`. The Angular app backs it with a `FormGroup` (`formGroupBackend()`, see `docs/development/ANGULAR.md`); a custom app or a React adapter can back it with plain state.

- `createFormStore(plan, backend, { initial? })` registers one field per property item of the plan, in plan order, and calls `backend.register(fields)` once. A field's rules are `validationRules(property)`; its initial value is `initial[key]` when the key is present (own keys only), else `getDefaultValueForProperty(property)`. Which property types a page turns into fields (File, non-inline M:M) is the facade's decision, not the store's.
- `getSnapshot()` returns `{ fields, valid, dirty }`, the same reference until the backend notifies, and across a notification that changed nothing (failures compare by value, so a backend may map its errors to new objects on every read). `valid` is every enabled field without backend errors.
- `setValues(values)` writes several fields at once (a record load) and `reset(values?)` starts over: each field takes the given value, or its registered initial value for a key left out, with touched and dirty cleared. Each notifies once, so the store builds one snapshot for the whole write. `reset(currentValues)` marks a saved form pristine. An unknown key throws a `RangeError` before anything is written. Write through the store or the port, never around it: the store sees only what the backend notifies.
- `validate()` is core's own verdict from the rules, as data: `{ valid, failures }` per enabled field. `checkRule`, `validateValue` and `validateProperty` are the functions under it. Failures carry Angular's payload names (`required`, `min`/`max` with `actual`, `minLength`/`maxLength` with `requiredLength` and `actualLength`, `pattern` with `requiredPattern` and `actualValue`), and `other` holds an error a backend has that no rule produced, such as a server error. Each check reproduces the matching Angular validator's decision; `validator-parity.spec.ts` proves it for every property of every golden variant, for both core's functions and the `FormGroup` backend.

## Facades

A facade is a page's behavior without its layout. Three are built, in `packages/core/src/facades/`, and the generic app's pages run on them (design: `docs/notes/FRONTEND_SDK_DESIGN.md` section 11).

| Facade | Serves | Owns |
|---|---|---|
| `recordList(deps, entity, options?)` | List page | The normalized list state (page, size, sort, search, filters, calendar range), the request each state sends, latest-wins loading, filter chips, map and calendar projections |
| `recordViewer(deps, entity, recordId, options?)` | Detail page | The record and its detail properties, action handles (`visible`, `enabled`, `openParams`, `run`) with parameter options and dependency re-fetch, inverse previews, series membership, guided-form context, delete with series scopes, payment initiation, guided-form submit |
| `recordEditor(deps, entity, { mode: 'create' \| 'edit', ... })` | Create and Edit pages | The form (a store over a `FormBackend`), prefill, the transforms, plain and coordinated save, scoped series saves, guided-form steps and autosave (edit), galleries and many-to-many diffs |

Pages keep layout and map results to UI. A facade never navigates, opens a modal, words a message or touches a router; it returns keys, ids and raw server text. If a behavior would be identical in a React page, it belongs in the facade.

**Construct with deps.** `entity` is an `EntityHandle`. `deps` is `FacadeDeps`, `{ data, schema, clock }`: a `DataClient`, a `FacadeSchema` port (`properties(entity)`, which the app implements over `SchemaService` and a custom app builds from `SchemaClient`) and a `Clock`. The viewer takes `ViewerDeps` and the editor `EditorDeps`, which add the extra schema reads each needs. Construction schedules the first load in a microtask.

**Snapshot, commands, results.** Read `getSnapshot()` (stable between changes, `subscribe` for changes) and call commands. A command that can fail or branch resolves a union such as `saved | invalid | failed | steps | scope_required`; the page maps every member. The list's commands are synchronous and return the new normalized state, so a caller mirroring it into a URL knows what to write. Core has no URL API: the app's `src/app/sdk/list-url.ts` maps query params onto `set` and the stored page-size preference, and the page writes the state back.

**Lifecycle.** `dispose()` aborts the load in flight and stops notifications; later commands throw. Change of entity, record id or schema rows means a new facade: dispose the old one and build the next. `recordViewer.reload()` and the editors' `rebuild()` re-read without replacing the facade (the editor's `rebuild()` replaces the backend, form store and form together and disposes the old store). Edit mode's galleries register with `registerGallery` and unregister through the function it returns.

**Testing.** Specs run a facade over `fakeTransport` and `createFakeClock`, both from `@civic-os/core/testing`:

- `fakeTransport(respond?)` returns `{ client, requests, recorded() }`; `client` is a real `DataClient`, so the specs assert the exact requests a facade sends. Use `reply(status, body, headers?)` for answers. A request whose signal aborts rejects as an abort, which tests latest-wins loading.
- Build the deps from that client, a stub schema port and the fake clock, mint a handle, then drive commands and assert snapshots and requests (`record-list.test.ts`, `record-viewer.test.ts`, `record-editor.test.ts`, `record-editor-edit.test.ts`).
- Page specs in the app cover only what the page keeps: modal and navigation mapping for each result, templates, hover and scroll behavior.

The series-local `dtstart` builder the edit editor uses for a "this and following" split is `packages/core/src/transform/series-schedule.ts`; it stays private to core (see `docs/development/DATETIME_HANDLING.md`).

## Adding to core

1. Put the code in the module that owns it, with the Apache header, relative imports ending in `.js`, and a `@consumer` tag.
2. Export it through the module's barrel `index.ts`.
3. Give it a real consumer, or tag it `typed <Export>` of an export that has one. Run `node scripts/check-dogfood.mjs`.
4. `npm run api:report` and commit the report diff.
5. Add unit tests (and a `*.test-d.ts` type test for type-level behavior); `npm run test:packages` must pass in every time zone.
6. If a golden or snapshot moves, regenerate it deliberately (`docs/development/TESTING.md`, Golden outputs).
