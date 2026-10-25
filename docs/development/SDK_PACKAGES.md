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

Modules of core: `model` (interfaces), `schema` (property-type detection, select strings, relations, validation rules), `query` (filter compilation, response handling, and `query/typed` for the typed `with` API), `transform` (value transforms, the integrity-critical datetime handling), `conditions`, `errors`, `transport`, `client` (`SchemaClient`, `DataClient`, store), `names`, `handles`, `version` and `typed-client`. A second entry point, `@civic-os/core/testing`, is reserved for fixtures and fakes.

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

- An export with no consumer is removed from the barrel, not exempted. Helpers that only tests used were taken out of the public API and can be re-exported when a consumer exists: `compileDataQuery`, `CompileDataQueryOptions`, `CompiledDataQuery`, `FILTER_OPERATORS`, `FilterOperator`, `parseContentRangeTotal`, `parseMoneyOutput`, `extractConstraintName`, `ERROR_KIND_PRECEDENCE` and `createStore`, plus the test-only `evaluateCondition`, `ConditionCoercion`, `EvaluateConditionOptions`, `exactCaseInsensitivePattern` and `isSelectableColumn`. Their assertions live in core's own tests. The `Store` type stays public, tagged `typed SchemaClient`, because the public getter `SchemaClient.entitiesStore` returns it.
- `npm run check:dogfood:self-test` runs the checker against an in-memory fixture to prove that re-exports never count.

### Why `tests/sdk-consumer/` exists

The generic app deliberately never uses generated types: it reads the schema dynamically. So the custom-app surface (`bootstrapTypedSchema`, `compileWith`, `defineQuery`, `checkCompatibility`, the typed-client error classes and the type-level API) has no natural app or MCP caller. Rather than exempt those exports, the repository carries `tests/sdk-consumer/`: a small issue-triage program written the way an external custom app would use the SDK. It imports core only through its public entry point and the committed generated snapshot `tests/golden/codegen/pothole.ts`, runs against a fixture transport with `node:assert`, and is type-checked under both `exactOptionalPropertyTypes` settings. It is not a test file and has no runner. The `@consumer custom-app` tag is verified against it. When a real custom app exists, it replaces the fixture as the proof.

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
const triage = defineQuery<Database, 'Issue'>()({
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
- **`defineQuery<D, E>()`** is the hoisting helper: it returns its argument unchanged, typed as the exact literal, so a query defined away from its call site is checked and keeps its result type. Generated files export `Database` only; the app binds it as shown.
- **Order on an M:M embed throws** `QueryValidationError`. So do unknown entities, columns, relations and order columns, and `columns`, `with`, `limit` or `order` on a system embed (status, category, user, file, payment), which takes only `true`.
- **Duplicate foreign keys**: when two FKs of one table point at the same target, only the first inverse is exposed on the target (as `inverseRelationships` does for the app).
- **System embeds are not `Relations`.** Their targets are not entities; they are reached through `select` and typed by `Embedded`.
- **tsvector columns** leave the default row through one shared predicate (`isSelectableColumn` in `query/typed/graph.ts`) that codegen reuses, so the typed `Row` has exactly the keys a default select returns.
- **M:M results** are typed as target-row arrays: the shape after core's `transformManyToManyData`, not the raw PostgREST junction rows. A typed executor must apply that transform. Rich-junction `_junction` data is not typed yet.
- **Filters** accept PostgREST's full operator grammar in core (`not.` prefix, `(any)` and `(all)` quantifiers, `fts(lang)` language), so stored dashboard filters keep working; an operator outside it throws `QueryValidationError`. The MCP `list_records` tool deliberately offers a narrower, documented enum.

## Codegen: `civic-os gen types`

```bash
# from a captured raw variant directory (no network)
node packages/cli/dist/bin.js gen types --from-fixture tests/golden/raw/pothole/testadmin --out src/civic-os.types.ts

# from a live PostgREST API; use an admin token, which sees the full contract
npx civic-os gen types --url https://example.org/api --token "$ADMIN_JWT" --out src/civic-os.types.ts
```

Exactly one of `--from-fixture` and `--url` is required. The generator reads the same views the MCP schema cache reads, builds embed shapes by calling core's own select compiler (so the types cannot drift from what the app requests), and emits one committed file: `DOMAIN_VERSION`, `FRAMEWORK_VERSION`, `SCHEMA_HASH`, the `Database` interface (per entity `Row`, `Insert`, `Update`, `Embedded`, `Relations`, `Statuses`, `Actions`, `Features`) and data-derived `*StatusKey` unions. The `SCHEMA_HASH` is the instance's `contract_hash` from `schema_domain_version`; codegen reads it and never computes it. An instance older than v0.77.0 has no such view and the run stops with a message that says so. See `docs/INTEGRATOR_GUIDE.md` (Domain Version).

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
- **The floor always blocks.** If the instance's `min_client_domain_version` is above the app's `DOMAIN_VERSION`, bootstrap throws `ClientUpdateRequiredError` under every policy. The floor fails closed: when the instance sets one and a version is not valid semver, a `SchemaMismatchError` with reason `invalid` is thrown.
- **`onIncompatible` governs only** a hash mismatch, a missing `schema_domain_version` view (`unverifiable`) and a client ahead of the instance (`client-ahead`):

| Policy | On a mismatch | `mode` |
|---|---|---|
| `block` | throws `SchemaMismatchError` | not returned |
| `warn` | calls `onWarn` once (default `console.warn`), then trusts the accessors | `trusted-after-warning` |
| `verify` | calls `onWarn`, and re-checks presence on every accessor call | `per-call` |

On a match every policy yields `verified` and handles are resolved once and memoized.

- Error classes: `ClientUpdateRequiredError` (the floor), `SchemaMismatchError` (carries a `SchemaMismatch` with `reason`, hashes and versions), `SchemaContractError` (an entity, column or action the generated types promise is missing from the live store; `member` is `undefined` when the entity itself is missing).
- `checkCompatibility(instance, app)` is the pure comparison behind it, usable on its own.

## Adding to core

1. Put the code in the module that owns it, with the Apache header, relative imports ending in `.js`, and a `@consumer` tag.
2. Export it through the module's barrel `index.ts`.
3. Give it a real consumer, or tag it `typed <Export>` of an export that has one. Run `node scripts/check-dogfood.mjs`.
4. `npm run api:report` and commit the report diff.
5. Add unit tests (and a `*.test-d.ts` type test for type-level behavior); `npm run test:packages` must pass in every time zone.
6. If a golden or snapshot moves, regenerate it deliberately (`docs/development/TESTING.md`, Golden outputs).
