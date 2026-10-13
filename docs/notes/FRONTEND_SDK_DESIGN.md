# Frontend SDK Design

**Status**: Design, not scheduled. No code exists. Written 2026-10-13 from an
architecture discussion; the embedding type model in Appendix A was verified
by compiling against TypeScript 6.0.3 under `--strict`.

**One-line summary**: Extract a framework-agnostic `@civic-os/core` that is
the sole interpreter of the metadata contract, consumed by the generic Angular
app, the MCP server, and custom apps alike. Custom apps get generated types, a
typed query and embedding API, and a presentation overlay that can subtract,
reorder, and group but never add semantics.

---

## 1. Motivation and thesis

Civic OS's promise is "the database is the application." The metadata
contract (`schema_entities`, `schema_properties`, statuses, actions,
validations, guided forms) describes an instance completely, and one
interpreter can turn it into a working app. The Angular frontend is the
*default projection* of that contract. The MCP server is already a second
projection. A custom app is a third: a bespoke, often customer-facing slice of
the same schema that still reads one truth.

Custom apps are needed when a slice of the schema deserves a more opinionated
interface than the generic CRUD pages, or when something must ship as a
deployed app (public portal, embedded widget, mobile). They are **not** a
replacement for the generic app, which stays the default view: good enough for
most, always good enough for data management.

### Are the core and the auto-assembled app in tension?

They complement each other, provided the core is defined as **the
interpreter of the metadata contract**, not as a client library. The threat to
the auto-assembled identity is not custom apps; it is drift between
interpreters. Today `tools/mcp-server/src/schema-cache.ts` hand-mirrors
`SchemaService.getPropertyType()` with zero shared code. A shared core makes
three consumers agree on what `metadata.properties` means.

### Relationship to Custom Pages

`docs/notes/CUSTOM_PAGES_DESIGN.md` already addresses bespoke screens by a
different route: a page defined in metadata (VIEW defines the shape,
`context_rpc` reads, `submit_rpc` writes, `is_readonly` per field) and
rendered by the generic app. The two are complementary and should be chosen
deliberately:

| Need | Reach for |
|---|---|
| A screen that mixes read-only context with a write form, or reads several tables and writes one, inside the generic app | Custom Pages |
| A customer-facing slice with its own navigation, branding, and deployment, or an embeddable widget | SDK custom app |

Custom Pages keep the whole application describable in the database and need
no frontend code, which aligns with the low/no-code direction. The SDK is a
developer-tools investment. Both must honor the dogfooding guarantee: a Custom
Page is the generic app, so it trivially does; a custom app must not reach a
capability the generic app lacks. The core's `recordEditor` facade should be
what renders a Custom Page too, so both routes share one implementation of
transforms and save orchestration.

The real tension is **escape-hatch gravity**: once custom apps exist, every
new need has two homes, metadata or app code, and app code is faster. If
sections and grouping are solved in an overlay and never in metadata, the
generic app falls behind, and the database stops being a complete description
of the instance. That failure mode is cultural, and the governing rules below
exist to prevent it.

---

## 2. Current-state assessment

Findings from the codebase at v0.76.4 that shape the design.

**The service layer is already API-only.** All 35 services depend on
`HttpClient`, rxjs, and `getPostgrestUrl()`; none touch the router, DOM, or
templates. `src/app/interfaces/*` (1,826 lines) imports nothing from Angular.
Only three pages bypass the service layer (`admin-files`, `admin-galleries`,
`admin-payments` inject `HttpClient` and write PostgREST filter strings).

**Orchestration lives in pages, not services.** This is the hard part to
extract and the part custom apps most want:

| Location | Logic | Approx. size |
|---|---|---|
| Create + Edit pages | `transformValuesForApi` (datetime/UTC, file UUIDs, gallery FK stripping), two divergent copies | 220 lines |
| Edit page | coordinated save (galleries, M:M, notes), series split/template update, auto-save | 500 lines |
| Detail page | action execution, param forms, RPC option loading, delete scopes, guided-form stepping | 800 lines |
| List page | one 530-line effect for filters/search/order/pagination/calendar | 600 lines |

The Detail page touches 62 distinct service members and signals.

**The presentation seam is thin.** `getPropsForDetail` filters on
`show_on_detail`; `getDetailRenderables` merges static text and sorts by
`sort_order`. About 25 lines. Everything expensive (type detection, select
strings, transforms, actions) sits downstream and never reads a `show_on_*`
flag. `ensureStructuralProps` already distinguishes "fetch this column" from
"render this column."

**rxjs is the real Angular coupling.** 196 `Observable<>` signatures across
services; 4 service files use `signal()`. Components were always going to be
framework-specific. Services were supposed to be portable and currently are
not.

**Enablers already in place**: `strictTemplates: true`; `schema_cache_versions`
for cache freshness; maintenance mode as precedent for server-driven client
behavior (GUC, header, 503); `metadata.schema_decisions` with `migration_id`;
`WidgetComponentRegistry` as an extension-point pattern; vitest-based unit test
builder.

**Not in place**: route resolvers, `withComponentInputBinding()`, npm
workspaces, `tsconfig` paths, any domain-level schema version.

**Churn** (6 months, non-spec): `edit-property` 36, widgets 34, list 32,
detail 29, edit 26, `fk-search-modal` 26, create 24. A library boundary
through these areas adds friction to every change, which argues for phasing.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Layer 0: Metadata contract (PostgreSQL views + tables)    │
└──────────────────────────────────────────────────────────┘
                            │
┌──────────────────────────────────────────────────────────┐
│ Layer 1: @civic-os/core — the interpreter                 │
│  schema model · type detection · query object + builder   │
│  embed compiler · transforms · validation rules           │
│  condition evaluator · actions · name resolution          │
│  error parsing · version check · codegen                  │
│  (no Angular, no rxjs, no signals)                        │
└──────────────────────────────────────────────────────────┘
          │                  │                   │
┌─────────────────┐ ┌─────────────────┐ ┌───────────────────┐
│ Generic Angular │ │ MCP server      │ │ Custom apps        │
│ app (default    │ │ (LLM projection)│ │ (@civic-os/angular │
│ projection)     │ │                 │ │  or @civic-os/react│
│ AnySchema       │ │ AnySchema       │ │  + generated types)│
└─────────────────┘ └─────────────────┘ └───────────────────┘
```

### Governing rules

1. **The core is the sole interpreter.** No consumer re-derives what metadata
   means. The MCP server's `detectPropertyType` is deleted in favor of the core.
2. **Overlays subtract, reorder, and group. They never add semantics.**
   Validation, transitions, actions, visibility conditions, FK behavior, and
   search configuration stay in the database. The core offers no hook for an
   app to define them in code.
3. **Anything two custom apps both need becomes a metadata feature plus a
   core feature**, never an SDK-only feature.
4. **Dogfooding guarantee, enforced in CI**: every exported symbol of
   `@civic-os/core` and `@civic-os/angular` has at least one call site in the
   generic app. The generic app always runs with an empty overlay, so it is
   the living proof that the contract is complete.
5. **Hide is not security.** An overlay's `hide` affects the render plan,
   never the select. RLS and column grants are the only data boundary, which
   matches `docs/development/PERMISSIONS_MODEL.md`.
6. **Version the contract, not the code.** See §9.

---

## 4. Schema truth vs presentation defaults

`SchemaEntityProperty` today carries two kinds of fact in one record:

- **Schema truth**: `data_type`, `udt_name`, `join_table`, `join_column`,
  `is_nullable`, `is_generated`, `is_identity`, `column_default`, `type`,
  `validation_rules`, `many_to_many_meta`, `options_source_rpc`,
  `depends_on_columns`. Every consumer wants all of it, unconditionally.
- **Presentation defaults**: `show_on_list/create/edit/detail`, `sort_order`,
  `column_width`, `display_name`, `sortable`, `filterable`; at entity level
  `show_in_sidebar`, `sort_order`. A custom app overrides or ignores these.

The SDK splits them into `PropertySchema` and `PropertyPresentation`, and
exposes a **render plan** as the output of a resolver with three inputs:
schema truth, metadata defaults, optional code overlay. The existing
`RenderableItem` pipeline (properties + static text sorted by `sort_order`)
becomes the plan, extended with a `section` item kind the database does not
have yet.

Precedent inside the framework: guided forms define which properties appear
in which step; dashboards define which entities appear where. Both are second
layouts over the same schema truth. A custom app is a layout that lives in
code instead of in `metadata`.

---

## 5. Packages

### `@civic-os/core` (framework-agnostic)

Pure TypeScript. Promises in, plain data out, plus a small subscribe-able
store for facade state. **No rxjs, no Angular signals.** Transport is a
`fetch`-shaped interface; auth is a `tokenProvider` interface.

Contents: schema model and type detection (from `SchemaService`), select
string and embed compilation (`propertyToSelectString()` rules, junction
paths, `!fk` disambiguation), query object and builder, value transforms
(`transformValuesForApi`, `transformValueForControl`, unified from the two
page copies), validation rules as data (not `ValidatorFn`), condition
evaluator, action execution and param handling, name resolution (from the MCP
server), error parsing, version/compatibility check, codegen.

### `@civic-os/angular`

Adapters: `provideCivicOs<DB>()` and DI tokens, `HttpClient` transport so the
existing interceptor chain (bearer, locale, impersonation, maintenance)
applies, Keycloak auth, resolvers, signal-based facades, `FormGroup`
integration, the translate pipe, and the component library.

### `@civic-os/react` (built alongside `@civic-os/angular`)

Decided 2026-10-13: a React library ships with the first SDK release, not
later. Consequences for the rest of the design:

- **The core's "no rxjs, no signals" rule is mandatory, not aspirational.**
  Facade state is a minimal store exposing `subscribe(listener)` and
  `getSnapshot()`, the exact contract React's `useSyncExternalStore` wants.
  The Angular adapter wraps the same store into a signal. The TC39 signals
  polyfill was considered and set aside: the plain store is smaller and
  carries no spec risk. This closes what was an open question.
- **Facades expose a framework-neutral form model.** `recordEditor` owns
  values, validation state, touched/dirty, and `setValue`, with validators as
  data. The Angular adapter projects that into a `FormGroup`; the React
  adapter exposes `getFieldProps(property)` and `errors`. Neither framework's
  form library leaks into the facade. This raises the bar for phase 2 and is
  the main reason phase 2 cannot be "move the Angular code and wrap it."
- **Hooks over facades**: `useCivicOs()`, `useEntity('Issue')`,
  `useRecordList`, `useRecordViewer`, `useRecordEditor`, plus
  `<CivicOsProvider client>` and a `createCivicOsClient<DB>()` factory that
  mirrors `provideCivicOs<DB>()`. Route resolvers have no React equivalent;
  presence is enforced by the hooks returning handles or `undefined` and by
  the same bootstrap hash check.
- **Components do not port; a subset is rebuilt.** The React component set
  covers what custom apps need, not the 65 Angular components: display and
  edit for every property type, FK search modal, M:M editor, pagination,
  loading and empty states, entity notes, file thumbnail, photo gallery,
  markdown. Admin pages, the schema editor, Blockly viewers, and dashboard
  widgets are generic-app-only and never ported. DaisyUI classes are plain
  CSS, so templates carry over by hand and theming is shared.
- **Dogfooding has a React leg.** The generic app is Angular, so "every
  exported symbol has a call site in the generic app" cannot cover
  `@civic-os/react`. A React example app in `examples/` exercises every
  React export, and the request-equivalence harness (§14) runs the same
  scripted flow against the Angular generic app and the React example and
  diffs the recorded PostgREST traffic. Parity of traffic is the proof that
  both adapters drive one interpreter.
- **Open**: whether to ship a `react-hook-form` adapter in addition to the
  neutral form model. Default is no; the neutral model is enough for the
  custom-app subset, and an adapter can be added without touching the core.

### Future, not designed against as requirements

- **Embeddable widget**: with React in hand, a widget is a React root mounted
  into a host page, or an Angular Element (`createCustomElement`) around a
  page like "report an issue". Either pairs naturally with the planned
  anonymous public submit design (`submit_public_form()` lives in the core;
  the widget runs with no Keycloak). A Lit-based `@civic-os/elements` is the
  lighter alternative if runtime weight ever matters.

The MCP server is the existing proof that the core's shape works with nothing
but `fetch`.

### Licensing and publishing

Decided 2026-10-13. SDK code is compiled into consuming apps, so under the
GPL family's combined-work reading an AGPL SDK would propagate to every custom
app built on it. A browser app conveys its bundle to every visitor, which is
ordinary distribution, so this is the clearest case rather than a gray one.

| Package | License | Reason |
|---|---|---|
| `@civic-os/core`, `@civic-os/angular`, `@civic-os/react`, `civic-os` CLI (codegen) | Apache-2.0 | Compiled into partner and customer apps |
| Generic frontend app | AGPL-3.0-or-later | Hosted and conveyed as a whole; platform copyleft unchanged |
| `@civic-os/mcp-server` | AGPL-3.0-or-later | Hosted server consumed over a network; imports the Apache core |
| Backend, migrations, workers, containers | AGPL-3.0-or-later | Unchanged |
| Generated types file in a customer app | none | The customer's file; codegen emits no license header |

Rules that follow:

- **Dependency direction is a license boundary.** Apache packages must never
  import from the AGPL app or MCP server. Enforce with a lint rule on the two
  package directories (`no-restricted-imports` or dependency-cruiser), not by
  convention.
- **SPDX headers change per file on extraction.** Civic OS, L3C is the sole
  copyright holder, so relicensing moved code is a decision, not a negotiation.
  Contributions to the Apache packages would raise the DCO/CLA question at
  that time.
- **Publish to npmjs under the `@civic-os` scope** (organization registered
  2026-10-13; `@civic-os/mcp-server` already uses the name). Lockstep versions
  with the framework, extending the existing tag/`package.json` check. Publish
  from the release workflow with npm trusted publishing (OIDC) and provenance;
  no stored token. GHCR stays for containers.
- **Internal consumers never need the registry.** The generic app and MCP
  server consume the core through npm workspaces. First publish is triggered
  by the first external consumer or by the codegen CLI, whichever comes first.

Prior art for the split: MongoDB (Apache drivers, SSPL server), MinIO (Apache
SDK, AGPL server), Grafana Labs (AGPL servers, permissive clients). iText and
Ghostscript sell commercial licenses on the propagation this split avoids.

---

## 6. Data interface: handles and presence

### Handles, not strings

The core never lets you address an entity or property by raw string past the
boundary. Resolvers return branded handles with private constructors; every
downstream API takes handles. A presence check is therefore unskippable by
construction ("parse, don't validate").

```ts
const cos = inject(CIVIC_OS);                 // CivicOsClient<Database>

const issue  = cos.schema.entity('Issue');    // EntityHandle | undefined   ('Isue' = compile error)
const status = issue?.property('status');     // PropertyHandle | undefined (only from an entity handle)

status?.schema.type;                 // truth: EntityPropertyType.Status
status?.schema.validators;           // truth: rules from metadata.validations
status?.presentation.showOn.list;    // default: app may ignore
issue?.structural.displayName;       // always fetched, regardless of visibility
issue?.can.insert;                   // permission flag from schema_entities
issue?.features.notes;               // from metadata.entities
issue?.action('close_issue');        // ActionHandle | undefined; visibility evaluated by core
```

`schema_entities` is not permission-filtered (it carries
`insert/select/update/delete` flags), so presence and permission remain
distinct checks.

### Verify once, then trust

A typed app's assumptions *are* its generated types file. Forcing `?.` on
every access punishes the app for having assumptions. Instead:

- At bootstrap the core compares the generated `SCHEMA_HASH` to the live
  instance. A match verifies every entity and property in the types file,
  once.
- Generated accessors are then non-optional:
  `cos.entities.Issue.property('contact_phone')` returns a handle.
- `cos.entities.Issue.optional('col')` returns `| undefined` for columns the
  app knows vary by instance.
- The dynamic path, `cos.schema.entity(string)`, keeps per-call checks. That
  is the generic app and the MCP server.
- Hash mismatch policy: `block`, `warn`, or `verify` (fall back to per-call
  checks for the session).

One hash comparison at startup is the same guarantee as a thousand `?.`
operators; the difference is when the check runs.

---

## 7. Query API

### The object is the contract; the builder is sugar

The core's API takes a plain, JSON-serializable query object. A fluent
builder compiles to it. Reasons specific to this codebase:

- `metadata.dashboard_widgets` already persists `filters` as JSON
  (`src/app/interfaces/dashboard.ts`), the List page stores filter state in
  the URL, and the MCP server takes filters as tool arguments. A serializable
  object is already the de facto contract in three places.
- Tests and the generic app read an object trivially; a builder needs
  `.toQuery()` anyway.

### What the builder knows that PostgREST does not

The DX win is not hiding PostgREST operators; it is knowing Civic OS types.

- Operators are constrained per column type from generated types: `gt/gte/lt/lte`
  on numbers and dates, `contains`/`startsWith` on text, `intersects` on
  geography, `eq/neq/in/is` everywhere. Never a raw `ov` or `fts` string.
- Semantic filters resolve through the core: `.whereStatus('in_progress')`
  turns a status key into an id using the name-resolver logic that the MCP
  server has today.
- `select` takes column names; the core applies `propertyToSelectString()`
  rules, so a plainly selected FK column embeds its display shape. The app
  never writes PostgREST syntax.

Query shape (see Appendix A for the exact types):

```ts
{
  select?: readonly (keyof Row)[];
  with?: { [relation]?: true | { columns?; with?; limit?; order? } };
  filters?: FilterCriteria[];      // existing shape, operators typed per column
  order?; pageSize?; page?;
}
```

---

## 8. Resource embedding

### Prior art reviewed

| Approach | Mechanism | Fit |
|---|---|---|
| postgrest-js | Parses the select *string* with template-literal types (`GetResult`/`ParseQuery`) | Poor. A parser in the type system; unresolved relations become an error *type* rather than a build failure; typing regressions after a parser change in early 2026; and you still write PostgREST syntax. |
| Prisma | `include`/`select` objects, `GetPayload<typeof args>`, `satisfies XDefaultArgs` | Good. The select-vs-include distinction is worth borrowing. Needs `satisfies` or `as const` on hoisted args. |
| Drizzle relational queries | `with: { posts: { with: { comments: true } } }` plus `columns`, per-level `where`/`orderBy`/`limit`, inferred nested results | Best. PostgREST embedding is also a tree with per-embed filter, order, and limit. Drizzle needs `relationName` to disambiguate; Civic OS gets that from `join_column` metadata. |
| EF `.Include().ThenInclude()` | Fluent chain over paths or lambdas | Poor TS inference for nested shapes; not the idiom. |
| GraphQL selection sets | Selection tree → result type via per-query codegen | Conceptually ideal, but requires per-query codegen. |

### Decision

Adopt the Drizzle `with` object, inferred by mapped and conditional types
over the generated `Database`, with no string parsing. Three tiers, the first
of which no ORM offers:

```ts
select: ['status']                                   // default embed: { id, display_name, status_key, color }
with: { work_package: { columns: ['id','cost'], with: { status: true } } }        // explicit, nested
with: { tags: true, work_details: { limit: 5, order: { column: 'created_at', direction: 'desc' } } }  // M:M and inverse
```

The core compiles each into today's select-string rules, including the
junction path (`issue_tags!issue_id(Tag!tag_id(id,display_name,color))`) and
`!fk` hints when two columns point at the same table. The relation graph is
generated from `join_table`, `join_column`, `many_to_many_meta`, and
`getInverseRelationships()`; apps never declare relations.

### Verified properties of the type model

Compiled with the repo's TypeScript 6.0.3, `--strict`, exit 0. Full proof in
Appendix A.

| Check | Result |
|---|---|
| Inferred result equals expected shape (8 cases incl. 3- and 5-level nesting) | holds |
| Invalid relation, column, nested column, nested relation, unselected property access, unknown entity, unknown query key (12 negatives) | all compile errors |
| Default embeds applied to plainly selected FK columns | holds |
| `with` wins over a same-named scalar FK in `select` | holds |
| Type-check cost | ~0.05s over an empty file; 46k instantiations |
| 20-level nesting probe | no TS2589; under 0.7s; 89k instantiations |

Findings that affect implementation:

- **Exactness needs an explicit type.** `Q extends Query<E>` alone lets
  `{ tags: true, bogus: true }` compile, because TypeScript only rejects extra
  keys when every key is wrong (weak-type detection). `ExactQuery<E, Q>` maps
  unknown keys to `never` and recurses through nested `with`; the function
  signature is `q: Q & ExactQuery<E, Q>`. Cost: an unknown relation reads as
  `'true' is not assignable to 'never'` rather than a "did you mean" hint.
  Unknown columns and entities get normal hints. A custom error type can
  improve this later.
- **Inline literals need no annotation; hoisted ones need `as const`.** The
  `const` type parameter is not load-bearing (the constraint already carries
  literal unions) but is kept because it makes `select` a readonly tuple.
- **`Simplify` was not needed.** The result is one mapped type over a key
  union with no intersections, so editor hovers show plain object types.
- **Cost scales with keys written, not string length.** Each `with` level is
  one mapped-type instantiation. This is the structural difference from
  postgrest-js.
- **Not yet tested**: `exactOptionalPropertyTypes`, `with: { x: undefined }`,
  relation keys that collide with Row column names beyond the FK case.

---

## 9. Versioning and compatibility

Three concerns, only one of which exists today:

| Concern | Exists? | What it is |
|---|---|---|
| Framework version | Yes | `package.json` + Sqitch tags. Shape of the metadata contract. |
| Cache freshness | Yes | `schema_cache_versions` timestamps. Tells a client to re-fetch; says nothing about compatibility. |
| Domain schema version | No | The instance's own tables and their evolution. No monotonic number anywhere. |

The generic app binds only to the framework version because it reads the
domain dynamically. A custom app binds to the domain too. This is a new
requirement that custom apps introduce.

### Design

- **Domain version record**, exposed through a PostgREST view alongside
  `schema_cache_versions`: framework version, domain version (semver, set by
  the integrator's migration), the migration id that set it, and
  `min_client_domain_version`. The core reads it at bootstrap and exposes a
  typed `instance` object.
- **Link ADRs, don't merge them.** The ADR is the *why*; the version is the
  *what*. The version record references an ADR; `metadata.schema_decisions`
  gains a `domain_version` column. ADR status and narrative never drive
  runtime behavior. `superseded_by_id` is already the right shape for history.
- **Capability checks over version sniffing.** An app never writes
  `if (domainVersion >= 3.2)`. It asks the core whether an entity has a
  property, action, or status, which the metadata already answers. The schema
  is its own feature flag. Version numbers are reserved for breaking changes.
- **The generated types file is the app's declaration of what it
  understands.** `DOMAIN_VERSION` and `SCHEMA_HASH` come from codegen, not
  hand maintenance.

### Forcing updates

A stale app has a stale requirement check and passes against a newer
database, so the floor has to come from the server.

- **Client-side at bootstrap**: the instance declares the minimum domain
  version a client must understand; the app declares what it understands; the
  core refuses to start when they do not meet and renders an "update
  required" screen. Adequate whenever the app is deployed with the instance.
  The PWA update toast is the precedent for prompting a reload.
- **Server-side rejection**: a client-version header checked in the
  pre-request hook (`check_jwt()`), returning 426 Upgrade Required.
  Maintenance mode is the exact precedent. This is the one backend change in
  this design. **Deferred** until an app ships independently of its instance
  (mobile or app-store distribution), where a reload cannot be forced.
- **CI diff**: regenerate types against the target instance and fail the
  build if the committed file differs. The compiler then lists every broken
  access.

---

## 10. Code generation

Follow the Supabase `gen types` shape, proven against PostgREST. The
generator reads the same views the MCP schema cache reads, as admin so it sees
the full contract, and emits one committed file. Shipped as a schematic
(`ng generate @civic-os/angular:types`) and a CLI (`civic-os gen types`).

```ts
export const DOMAIN_VERSION = '3.2.0' as const;
export const FRAMEWORK_VERSION = '0.76.4' as const;
export const SCHEMA_HASH = 'sha256:…' as const;

export interface Database {
  entities: {
    Issue: {
      Row: { id: number; display_name: string; status: number; work_package: number | null; /* … */ };
      Insert: { display_name: string; status?: number; work_package?: number | null; /* … */ };
      Update: Partial<Insert>;
      Embedded: {                       // default shapes per propertyToSelectString() rules
        status: { id: number; display_name: string; status_key: IssueStatusKey; color: string };
        created_user: { id: string; display_name: string };
        work_package: { id: number; display_name: string } | null;
      };
      Relations: {                      // graph for `with`
        status:       { kind: 'one';  target: 'IssueStatus'; nullable: false };
        work_package: { kind: 'one';  target: 'WorkPackage'; nullable: true };
        tags:         { kind: 'many'; target: 'Tag' };          // M:M via issue_tags
        work_details: { kind: 'many'; target: 'WorkDetail' };   // inverse FK
      };
      Statuses: IssueStatusKey;
      Actions: { close_issue: { params: { p_resolution_note?: string } }; /* … */ };
      Features: { notes: true; calendar: false; map: true; payment: false; guidedForm: false };
    };
  };
}
export type IssueStatusKey = 'reported' | 'triaged' | 'in_progress' | 'closed';  // data-derived
```

**Can promise**: column names, nullability, Insert/Update optionality (from
`is_generated`, `is_identity`, `column_default`, `is_nullable`), embed shapes,
relation graph, action names and param types, feature flags from
`metadata.entities`, dot-notation condition paths as template literal types.

**Cannot promise**: RLS, per-user permission flags, anything in rows. Status
keys are rows but exist for programmatic reference, so they are emitted and
marked data-derived.

**Risk**: the `User` embed selects a different shape than ordinary FKs.
Codegen must mirror `propertyToSelectString()` exactly or row types lie. The
cleanest guarantee is for codegen to call the core's own embed compiler.

---

## 11. Angular adapter

Most enforcement is TypeScript's job. Angular's contribution:

1. **Template type-checking** (`strictTemplates`, already on). With a typed
   client in scope, `[property]="'titel'"` fails the build.
2. **Resolvers plus `withComponentInputBinding()`**. `resolve: { entity:
   entityResolver('Issue') }` runs the presence check before activation and
   binds the verified handle into `input.required<EntityHandle>()`. The only
   source of handles is the resolver. Neither is used today; standard Angular
   16+.
3. **Signals for live presence**. `computed(() => schema.entity(key()))`
   re-evaluates on cache refresh; a property removed mid-session flips to
   `undefined` and `@if (prop(); as p)` drops it instead of crashing.
4. **Template narrowing**. `@if (x; as y)` narrows handle-or-undefined. A
   structural directive gets the same via `static ngTemplateGuard_`.
5. **`ngDevMode` assertions**: throw `MissingEntityError` in dev; degrade to
   the existing empty-state component in prod. Tree-shaken from production.
6. **`provideCivicOs<DB>()`** returning typed injection tokens.
7. **Schematic** for codegen.

### Facades

Headless, signal-based, no layout. Each owns logic currently in pages.

- **`recordList(entity, query?)`**: rows, loading, pagination, filter state as
  signals. `select` omitted → derived from `presentation.showOn.list`.
- **`recordViewer(entity, record, query?)`**: record signal, `prop()`,
  `action()` handles with `visible()`/`enabled()`/`run()`, features. Adds
  columns referenced by action conditions automatically (today's
  `extractConditionFields()`).
- **`recordEditor(entity, { mode, layout?, defaults?, onSaved })`**: form
  construction with validators from `metadata.validations`;
  `transformValuesForApi` (one implementation for Create and Edit);
  coordinated save ordering for galleries, M:M, notes; constraint-error
  parsing; `plan()` as the resolved render plan.

### Presentation overlay

```ts
const residentReportLayout = presentation<Database, 'Issue'>({
  create: {
    sections: [
      { title: 'What happened', properties: ['display_name', 'location'] },
      { title: 'How can we reach you', properties: ['contact_email', 'contact_phone'] },
    ],
    hide: ['work_package', 'status', 'created_user'],
    rename: { display_name: 'Short description' },   // display only; translation key allowed
  },
});
```

Checked against generated types: a typo in a column name is a compile error.
Can hide, reorder, rename, group. Cannot add a column, validator, or
transition.

---

## 12. Example: resident "Report a Pothole" portal

A customer-facing slice of a modernized `examples/pothole/` schema. Residents
report issues and see their own; work packages and bids never appear.

### Bootstrap

```ts
provideCivicOs<Database>({
  apiUrl: () => window.civicOsConfig?.postgrestUrl ?? environment.postgrestUrl,
  transport: withAngularHttp(),           // existing interceptors apply
  auth: withKeycloak(getKeycloakConfig()),
  understands: { domain: DOMAIN_VERSION, schemaHash: SCHEMA_HASH },
  onIncompatible: 'block',
}),
```

### Routes

```ts
{ path: 'my-issues', component: MyIssuesPage, resolve: { issue: entityResolver('Issue') } },
{ path: 'issues/:id', component: IssuePage,
  resolve: { issue: entityResolver('Issue'), record: recordResolver('Issue', { idParam: 'id' }) } },
{ path: 'report', component: ReportIssuePage, resolve: { issue: entityResolver('Issue', { require: ['insert'] }) } },
```

### List

```ts
export class MyIssuesPage {
  issue = input.required<EntityHandle<Database, 'Issue'>>();
  private cos = inject(CIVIC_OS);

  list = recordList(this.issue, {
    select: ['id', 'display_name', 'status', 'created_at'],   // 'status' auto-embeds
    filters: [{ column: 'created_user', operator: 'eq', value: this.cos.auth.userId }],  // presentation, not security
    order: { column: 'created_at', direction: 'desc' },
    pageSize: 20,
  });
}
```

```html
@for (row of list.rows(); track row.id) {
  <a [routerLink]="['/issues', row.id]">
    <cos-display [value]="row.display_name" [property]="issue().structural.displayName" />
    <cos-display [value]="row.status" [property]="issue().property('status')" />
  </a>
}
```

### Detail

```html
@if (viewer.record(); as rec) {
  <cos-display [value]="rec.status" [property]="viewer.prop('status')" />
  @if (viewer.prop('contact_phone'); as phone) {          <!-- degrade, don't crash -->
    <cos-display [value]="rec.contact_phone" [property]="phone" />
  }
  @if (viewer.action('close_issue'); as close) {          <!-- conditions from metadata -->
    @if (close.visible()) {
      <button [disabled]="!close.enabled()" (click)="close.run()">{{ close.label() }}</button>
    }
  }
  @if (viewer.features.notes) { <cos-entity-notes [record]="viewer" /> }
}
```

### Create with overlay

```ts
editor = recordEditor(this.issue, {
  mode: 'create',
  layout: residentReportLayout,
  onSaved: (row) => this.router.navigate(['/issues', row.id]),
});
```

```html
<form [formGroup]="editor.form" (ngSubmit)="editor.save()">
  @for (section of editor.plan().sections; track section.title) {
    <fieldset><legend>{{ section.title }}</legend>
      @for (item of section.items; track item.key) {
        @if (item.kind === 'property') {
          <cos-edit [property]="item.property" [control]="editor.control(item.property)" />
        } @else { <cos-static-text [block]="item.block" /> }
      }
    </fieldset>
  }
</form>
```

### The generic app is the same API

```ts
const cos = inject(CIVIC_OS);                               // CivicOsClient<AnySchema>
const entity = cos.schema.entity(route.params.entityKey);   // string key, same handle shape
editor = recordEditor(entity, { mode: 'create' });           // layout omitted → metadata plan
list   = recordList(entity);                                 // select omitted → showOn.list
```

---

## 13. What the interface deliberately does not offer

- No `visibleWhen` callback on actions. Conditions come from
  `metadata.entity_actions`.
- No `validators` option on `recordEditor`. Validation comes from
  `metadata.validations` and CHECK constraints.
- No `onBeforeSave` hook that can mutate data. Transforms are the core's.
- No raw PostgREST escape hatch on the typed client. A query the core cannot
  express is a core feature request, so the generic app gets it too.
- No way to hide a column from the API.

---

## 14. Testing and regression strategy

This refactor moves logic without changing behavior. The strongest regression
tool for that is **request equivalence**: for the same user action against the
same instance, the SDK-backed app must emit the same PostgREST requests
(URL, select string, filters, body) as the app does today. Everything below
is organized around establishing that baseline and defending it per phase.

### Existing assets

| Asset | Size | Role in this refactor |
|---|---|---|
| Angular unit specs | 105 files; `schema.service.spec` 2,422 lines, `data.service.spec` 2,030, Detail/List/Edit page specs 1,000+ each | Characterization suite. The service specs port almost directly to the core's vitest suite. |
| `tests/functional/postgrest-api-regression-test.sh` | curl against live PostgREST | Template for an API-level equivalence harness. |
| `tests/functional/v0-48-0-*-test.cjs` | `playwright-core` scripts | Template for browser flow tests. |
| `tools/mcp-server/tests/integration/run-tests.sh` | real PostgreSQL + PostgREST + Keycloak | Becomes a core consumer test for free once the MCP server imports the core. |
| `postgres/migrations/tests/run-tests.sh` | migration verify | Covers the domain-version record migration. |
| BackstopJS (5 scenarios), pa11y-ci, Lighthouse | visual and a11y | Gate for phases 2 and 3, where templates change. |
| `docs/development/E2E_VERIFICATION.md` | five-layer checklist | Remains the definition of done per phase. |

### Golden fixtures at the seam (build first, before any extraction)

Capture, for every example instance (`pothole`, `community-center`,
`staff-portal`, `neighborhood-hub`, `client-intake`), deterministic outputs
of the current code as committed JSON snapshots:

- `propertyToSelectString()` output for every property, including M:M
  junction paths and `!fk` hints.
- `getPropsForList/Detail/Create/Edit` and the `*Renderables` plans.
- `transformValuesForApi` and `transformValueForControl` for a fixture row
  per entity, covering DateTime, DateTimeLocal, File, PhotoGallery, Money.
- `getFormValidatorsForProperty` rule sets (as data, not `ValidatorFn`).
- `evaluateCondition` results for every action condition in the examples.
- Parsed error messages for a fixture set of PostgREST error payloads.

The core's test suite asserts byte-equality against these fixtures. The same
fixtures are consumed by the MCP server's tests, which is the mechanical
proof of "one interpreter." Fixtures regenerate only by an explicit script,
never on test run, so drift is a reviewed diff.

### Request-equivalence harness (full-stack)

A Playwright script drives the generic app through a scripted flow per
example instance and records every PostgREST request via route interception:
list with filter, sort, and page change; create with FK, M:M, DateTime,
DateTimeLocal, and file upload; edit with gallery and notes; detail with an
action that has params; delete; series split where `supports_recurring`;
guided form step-through where configured. The recording is normalized
(stable ordering, ids masked) and committed.

Run before the refactor to establish the baseline, and after each phase. Any
diff is either a bug or a deliberate change that must be explained in the PR.
This is the single gate that most directly answers "did the extraction change
behavior."

### Data-integrity verification (SQL layer)

The datetime transforms are flagged integrity-critical in
`docs/development/DATETIME_HANDLING.md`. Beyond request equivalence, a
functional test creates records through the UI with known wall-clock and
timezone inputs, then verifies stored values via `psql`, for `timestamp` and
`timestamptz` columns, in at least two browser timezones (Playwright
`timezoneId`). The same pattern covers Money precision, GeoPoint WKT
round-trip, and M:M junction row counts after coordinated save.

### Type-level tests

- The Appendix A pattern becomes a `vitest --typecheck` suite in the core:
  `Expect<Equal<>>` for inference, `@ts-expect-error` for rejection.
- Codegen snapshot: CI generates types from each example instance and diffs
  against a committed file. A fixture custom app in `examples/` compiles
  against them, so a codegen regression is a build failure.

### Per-phase gates

**Phase 1 (core)**: all existing Angular specs green with services backed by
the core through the adapter; core vitest suite green against golden
fixtures; MCP integration suite green with the duplicated type detection
deleted; request-equivalence diff empty; `postgrest-api-regression-test.sh`
green.

**Phase 2 (facades)**: phase 1 gates, plus Playwright flows green; datetime
and integrity SQL checks green; Backstop expanded to one scenario per CRUD
page per example and green, since templates change shape but not pixels;
pa11y green.

**Phase 3 (libraries)**: phase 2 gates, plus the fixture custom apps (one
Angular, one React) built against the published packages with their own
Playwright smoke flows; the dogfooding CI check (every `@civic-os/angular`
export has a call site in the generic app, every `@civic-os/react` export
has one in the React example); cross-framework request parity (the same
scripted flow against the Angular generic app and the React example records
identical PostgREST traffic); a11y lint on both libraries' templates.

### What unit tests will not catch

Interceptor ordering (bearer, locale, impersonation, maintenance) when the
transport moves behind an adapter; PostgREST embed disambiguation on real
schemas with two FKs to one table; RLS interaction with per-user
`schema_entities` flags; and timezone behavior, which depends on the
browser. Each of these is covered only by the full-stack layers above, which
is why they are gates and not nice-to-haves.

---

## 15. Phasing and estimates

Roughly 4–6 months for one senior engineer across all phases, with a usable
core in the first month. The React library accounts for most of the increase
over the earlier 3–4 month estimate. Stop after phase 1 until a concrete
custom app exists.

**Phase 1: `@civic-os/core`** (2–4 weeks, mostly mechanical). Move interfaces,
type detection, property filtering, select/embed compilation, query object,
condition evaluator, error parsing, transforms. Replace `HttpClient` with the
transport interface; replace rxjs with Promises and a store. Move the seven
`Validators.*` references in `SchemaService` to the Angular adapter. First
consumers: this app and the MCP server, which deletes its duplicated type
detection. Pays for itself regardless of custom apps.

**Phase 2: page decomposition into facades** (4–7 weeks, highest risk).
Create/Edit/Detail/List orchestration becomes `recordEditor`,
`recordViewer`, `recordList`, with a framework-neutral store and form model
(§5) so the React adapter is a projection rather than a reimplementation.
The datetime logic is flagged integrity-critical in
`docs/development/DATETIME_HANDLING.md`; the existing page specs are the
safety net. Unifies the two divergent `transformValuesForApi` copies.

**Phase 3a: `@civic-os/angular` library** (4–8 weeks, mostly packaging).
`window.civicOsConfig` → `provideCivicOs()`; 41 of 65 components use the
translate pipe, so the library ships i18n infrastructure; Tailwind/DaisyUI
templates require consumers to add the package to Tailwind content paths or
ship compiled CSS; heavy peers (Leaflet, Blockly, JointJS, xlsx,
keycloak-angular) need secondary entry points; npm workspaces, `tsconfig`
paths, Docker build, and the version-tag CI all assume one package today.

**Phase 3b: `@civic-os/react` library** (5–8 weeks, mostly new components).
Hooks and provider over the phase 2 facades (1–2 weeks); the custom-app
component subset rebuilt in React with the same DaisyUI classes (3–5 weeks);
a React example app in `examples/` as the dogfooding consumer and
request-equivalence target (1 week). 3a and 3b share packaging work and can
overlap once the facades are stable.

Not in any phase: codegen (small, belongs with phase 1 once the core's embed
compiler exists), the domain version record (one migration, phase 1 or 2),
server-side 426 (deferred, see §9).

---

## 16. Open questions

- **Status keys in codegen**: literal union (current design) or `string` plus
  runtime lookup? Literal union is better DX but makes inserting a status row
  a codegen-breaking change.
- **Overlay i18n**: `rename` should accept a translation key resolved through
  instance translation tables so custom apps do not fork i18n.
- **Error message quality for unknown relations**: the exactness trick yields
  `not assignable to 'never'`. A branded error type with a message is worth
  exploring.
- **Hoisted queries**: document the `as const` requirement, or provide a
  `defineQuery<E>()` identity helper that preserves literals.
- **React forms**: ship only the neutral form model, or also a
  `react-hook-form` adapter? Default is neutral only (see §5).
- **Monorepo tooling**: npm workspaces vs Nx. Single `package.json` version
  across packages avoids most versioning ceremony.

---

## Related

- `docs/notes/MCP_SERVER_DESIGN.md` — the existing second consumer;
  `schema-cache.ts` hand-mirrors `getPropertyType()` today.
- `docs/notes/DETERMINISTIC_SCHEMA_SDK_DESIGN.md` — types the contract on the
  write side; this design types it on the read side.
- `docs/notes/ANONYMOUS_PUBLIC_SUBMIT_DESIGN.md` — natural partner for an
  embeddable widget.
- `docs/notes/MAINTENANCE_MODE_DESIGN.md` — precedent for server-driven
  client behavior (version floor).
- `docs/development/PERMISSIONS_MODEL.md` — why `hide` is never a security
  boundary.
- `docs/development/DATETIME_HANDLING.md` — transforms `recordEditor` must
  absorb without behavior change.
- `docs/notes/ADMIN_PAGE_PITFALLS.md` — the effect-driven multi-phase loading
  pattern that facades replace.

Prior art consulted: [postgrest-js typing](https://tessl.io/registry/tessl/npm-supabase--postgrest-js),
[Drizzle relational queries](https://orm.drizzle.team/docs/rqb),
[Prisma GetPayload](https://www.prisma.io/docs/orm/v7/prisma-client/type-safety/operating-against-partial-structures-of-model-types),
[Prisma relation queries](https://www.prisma.io/docs/orm/v7/prisma-client/queries/relation-queries).

---

## Appendix A: embedding type proof

Compiled with `node_modules/.bin/tsc --noEmit --strict --target es2022
--moduleResolution bundler proof.ts` (TypeScript 6.0.3), exit 0, ~0.65s wall
(~0.61s for an empty file). Positive cases are checked with `Expect<Equal<>>`
(a wrong expectation is TS2344); negative cases use `@ts-expect-error` (a
line that does not error is TS2578). The full proof had 8 positive and 12
negative cases plus a 5-level nesting stress; representative cases are shown.

```ts
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// ---- generated schema (excerpt; Row / Embedded / Relations per entity) ----
interface Database {
  entities: {
    Issue: {
      Row: { id: number; display_name: string; status: number; work_package: number | null; created_user: string; contact_phone: string | null; created_at: string };
      Embedded: {
        status: { id: number; display_name: string; status_key: 'reported' | 'triaged' | 'in_progress' | 'closed'; color: string };
        work_package: { id: number; display_name: string } | null;
        created_user: { id: string; display_name: string };
      };
      Relations: {
        status:       { kind: 'one';  target: 'IssueStatus'; nullable: false };
        work_package: { kind: 'one';  target: 'WorkPackage'; nullable: true };
        tags:         { kind: 'many'; target: 'Tag' };
        work_details: { kind: 'many'; target: 'WorkDetail' };
      };
    };
    WorkPackage: {
      Row: { id: number; display_name: string; cost: number | null; status: number | null };
      Embedded: { status: { id: number; display_name: string } | null };
      Relations: {
        status: { kind: 'one'; target: 'WorkPackageStatus'; nullable: true };
        bids:   { kind: 'many'; target: 'Bid' };
        parent: { kind: 'one'; target: 'WorkPackage'; nullable: true };   // synthetic, for the nesting stress
      };
    };
    IssueStatus:       { Row: { id: number; display_name: string; status_key: string; color: string }; Embedded: {}; Relations: {} };
    WorkPackageStatus: { Row: { id: number; display_name: string }; Embedded: {}; Relations: {} };
    Tag:               { Row: { id: number; display_name: string; color: string }; Embedded: {}; Relations: {} };
    WorkDetail:        { Row: { id: number; display_name: string; issue: number; added_by: string }; Embedded: { added_by: { id: string; display_name: string } }; Relations: {} };
    Bid:               { Row: { id: number; display_name: string; total_cost: number }; Embedded: {}; Relations: {} };
  };
}

// ---- helpers ----
type DB = Database['entities'];
type Ent = keyof DB;
type RowOf<E extends Ent>  = DB[E]['Row'];
type EmbOf<E extends Ent>  = DB[E]['Embedded'];
type RelsOf<E extends Ent> = DB[E]['Relations'];
type TargetOf<E extends Ent, R extends keyof RelsOf<E>> =
  RelsOf<E>[R] extends { target: infer T extends Ent } ? T : never;

// ---- query shape ----
type SubQuery<T extends Ent> = {
  columns?: readonly (keyof RowOf<T>)[];
  with?: With<T>;
  limit?: number;
  order?: { column: keyof RowOf<T>; direction: 'asc' | 'desc' };
};
type With<E extends Ent>  = { [R in keyof RelsOf<E>]?: true | SubQuery<TargetOf<E, R>> };
type Query<E extends Ent> = { select?: readonly (keyof RowOf<E>)[]; with?: With<E> };

// ---- exactness: the constraint alone allows extra keys when mixed with valid ones ----
type ExactSub<T extends Ent, S> = {
  [K in keyof S]: K extends 'columns' | 'limit' | 'order' ? S[K]
    : K extends 'with' ? ExactWith<T, S[K]>
    : never;
};
type ExactWith<E extends Ent, W> = {
  [R in keyof W]: R extends keyof RelsOf<E>
    ? (W[R] extends true ? W[R] : ExactSub<TargetOf<E, R>, W[R]>)
    : never;
};
type ExactQuery<E extends Ent, Q> = {
  [K in keyof Q]: K extends 'select' ? Q[K] : K extends 'with' ? ExactWith<E, Q[K]> : never;
};

// ---- result inference ----
type ColResult<E extends Ent, C extends keyof RowOf<E>> = C extends keyof EmbOf<E> ? EmbOf<E>[C] : RowOf<E>[C];
type WithOf<S> = S extends { with: infer W } ? W : {};
type ColsOf<E extends Ent, S> = S extends { columns: readonly (infer C)[] } ? C & keyof RowOf<E> : keyof RowOf<E>;
type SelOf<E extends Ent, Q>  = Q extends { select: readonly (infer C)[] }  ? C & keyof RowOf<E> : keyof RowOf<E>;

type Shape<E extends Ent, C extends keyof RowOf<E>, W> = {
  [K in Exclude<C, keyof W> | (keyof W & keyof RelsOf<E>)]:
    K extends keyof W
      ? K extends keyof RelsOf<E> ? RelResult<E, K, W[K]> : never   // rule: `with` wins over a same-named FK in select
      : K extends keyof RowOf<E> ? ColResult<E, K> : never;
};
type Wrap<Rel, X> =
  Rel extends { kind: 'many' } ? X[]
  : Rel extends { kind: 'one'; nullable: true } ? X | null
  : X;
type RelResult<E extends Ent, R extends keyof RelsOf<E>, S> =
  Wrap<RelsOf<E>[R],
    S extends true
      ? Shape<TargetOf<E, R>, keyof RowOf<TargetOf<E, R>>, {}>
      : Shape<TargetOf<E, R>, ColsOf<TargetOf<E, R>, S>, WithOf<S>>>;
type Result<E extends Ent, Q> = Shape<E, SelOf<E, Q>, WithOf<Q>>;

declare function query<E extends Ent, const Q extends Query<E>>(entity: E, q: Q & ExactQuery<E, Q>): Result<E, Q>;

// ---- positive cases ----
const r1 = query('Issue', { select: ['id', 'display_name', 'status'] });
type _1 = Expect<Equal<typeof r1, { id: number; display_name: string; status: Database['entities']['Issue']['Embedded']['status'] }>>;

const r2 = query('Issue', { select: ['id'], with: { work_package: { columns: ['id', 'cost'], with: { status: true } } } });
type _2 = Expect<Equal<typeof r2, {
  id: number;
  work_package: { id: number; cost: number | null; status: { id: number; display_name: string } | null } | null;
}>>;

const r3 = query('Issue', { select: ['id'], with: { tags: true, work_details: { columns: ['id', 'display_name'], limit: 5 } } });
type _3 = Expect<Equal<typeof r3, {
  id: number;
  tags: Array<{ id: number; display_name: string; color: string }>;
  work_details: Array<{ id: number; display_name: string }>;
}>>;

const r4 = query('Issue', {});   // no select → full Row with default embeds
type _4 = Expect<Equal<typeof r4, {
  id: number; display_name: string;
  status: { id: number; display_name: string; status_key: 'reported' | 'triaged' | 'in_progress' | 'closed'; color: string };
  work_package: { id: number; display_name: string } | null;
  created_user: { id: string; display_name: string };
  contact_phone: string | null; created_at: string;
}>>;

const r4b = query('Issue', { select: ['id', 'work_package'], with: { work_package: { columns: ['id'] } } });
type _4b = Expect<Equal<typeof r4b, { id: number; work_package: { id: number } | null }>>;

// ---- negative cases ----
// @ts-expect-error unknown relation
query('Issue', { with: { bogus: true } });
// @ts-expect-error unknown nested column
query('Issue', { with: { work_package: { columns: ['nope'] } } });
// @ts-expect-error unknown top-level select column
query('Issue', { select: ['nope'] });
// @ts-expect-error `with` on relation absent from nested target (Tag has none)
query('Issue', { with: { tags: { with: { anything: true } } } });
const r10 = query('Issue', { select: ['id'] });
// @ts-expect-error not selected
r10.display_name;
// @ts-expect-error bogus mixed with valid relation (needs ExactQuery)
query('Issue', { with: { tags: true, bogus: true } });
// @ts-expect-error unknown top-level query key
query('Issue', { selct: ['id'] });
// @ts-expect-error unknown entity
query('Nope', {});

// ---- stress: 5 levels ----
const r7 = query('Issue', {
  select: ['id'],
  with: { work_package: { columns: ['id'], with: { parent: { columns: ['id'], with: { parent: { columns: ['id'], with: { parent: { columns: ['id', 'cost'], with: { parent: { columns: ['id', 'display_name'], with: { bids: true } } } } } } } } } } },
});
type P5 = { id: number; display_name: string; bids: Array<{ id: number; display_name: string; total_cost: number }> } | null;
type P4 = { id: number; cost: number | null; parent: P5 } | null;
type P3 = { id: number; parent: P4 } | null;
type P2 = { id: number; parent: P3 } | null;
type P1 = { id: number; parent: P2 } | null;
type _7 = Expect<Equal<typeof r7, { id: number; work_package: P1 }>>;
```
