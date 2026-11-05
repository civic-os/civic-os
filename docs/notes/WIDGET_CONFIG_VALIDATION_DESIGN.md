# Widget Config Validation - Design

**Status:** Research / directional design, not scheduled. Answers issue #52. Implementation is a separate follow-up.
**Scope:** `metadata.dashboard_widgets.config` (JSONB). Question 7 covers other JSONB metadata.

## Problem

`config` is free-form JSONB. A misspelled or misplaced key is stored without complaint and ignored. When the key drives something that fails loudly (a filter), someone notices. When it drives something optional (a heading), the widget renders without it and nobody notices. The neighborhood-hub dashboards shipped four dead keys (`entity`, `filter`, `columns`, `title`) this way, and the missing heading went unnoticed for six months.

## What exists today

| Piece | State |
|---|---|
| `metadata.widget_types.config_schema JSONB` | In the v0.4.0 baseline, "JSON Schema for validation (future Phase 3)". Never populated, never read (a type declaration and a test mock aside). |
| TypeScript interfaces | `packages/core/src/model/dashboard.ts` (`FilteredListWidgetConfig`, `MapWidgetConfig`, ...). Hand-written, never checked against stored rows, and already drifting from the docs: `orderBy` and `limit` are required in the interface but optional in `DASHBOARD_WIDGETS.md`; `FilterCondition.operator` is `string` where the docs list a closed operator set; `StatCardWidgetConfig` has no widget type behind it. |
| Widget components | `src/app/components/widgets/*` read their config through a `computed` cast (`as FilteredListWidgetConfig`). Unknown keys are ignored, missing keys fall back to defaults. `filtered_list` also reads `entityKey` from config as a fallback to the `entity_key` column. |
| `metadata.translate_widget_config()` | `v0-62-0-dashboard-translations.sql`. Hard-codes translatable paths for three types (`markdown.content`, `nav_buttons.header/description/buttons[].text`, `dashboard_navigation.backward.text/forward.text/chips[].text`). Every other type falls to `ELSE NULL`. |
| Key filters (v0.80.0) | Value-level semantics (`<column>.status_key`) resolved in the frontend; errors are translated at render (`dashboard.filter_unknown_key`). Shape validation never sees them. |
| Instance Management MCP | `add_widget` plans per-type validation, but only for calls through that server. |
| Database | `postgis/postgis:17-3.5` plus Sqitch (`docker/dev-postgres`); no JSON Schema extension. Production targets include managed Postgres. |

Authors who bypass any single layer: hand-written SQL (every instance today), LLM-generated SQL (Schema Assistant), deployment scripts outside this repo, and future UI. Only the database sees all of them.

## Recommendations

### 1. Where to enforce: layered, with the database as the backstop

[4/5] Enforce in four places that share one schema:

| Layer | Catches | Behavior on invalid |
|---|---|---|
| **Database trigger** (`BEFORE INSERT OR UPDATE OF config, widget_type`) | All authors, including raw SQL and deployment scripts | Mode-dependent (see 4): warning, or `check_violation` listing every issue |
| **`@civic-os/core` validator** (`validateWidgetConfig(type, config)`) | Instance Management MCP `add_widget`/`update_widget`, a future dashboard editor, the Schema Assistant eval harness | Returns issues; callers decide |
| **CI lint** | Example SQL in this repo and integrator CI | After example init, the issues view (see 4) must be empty |
| **Frontend render time** | Rows that predate or bypass the trigger | Never blocks rendering (below) |

A CI lint alone misses out-of-repo deployment scripts, which is where this bug lived. A trigger alone gives no feedback to LLM tool callers before they run SQL. Core alone is invisible to SQL authors. The trigger is the only layer that cannot be bypassed, so it is the one that must exist.

**What the frontend and MCP do with an invalid stored config:** keep today's tolerant behavior. Unknown keys are ignored and defaults apply, so an old bad row never takes a dashboard down. Only a structurally unusable config (a missing required key such as chart `valueColumns`) shows the widget's existing error state with a translated message. In development the app logs one `console.warn` per widget with the issue paths. An optional admin-only "config issue" badge is a follow-up, not part of the first cut. The MCP server returns issues as a tool error before sending SQL, and exposes `config_schema` in its schema overview so the model sees valid keys before writing.

### 2. Validating in Postgres: a PL/pgSQL interpreter for a JSON Schema subset

[4/5] Do not depend on `pg_jsonschema`. It is not in the image, it is a compiled Rust extension, and it is unavailable on some managed services, which would fork the portability story for every deployment. Do not validate outside the database only, for the bypass reason above.

Write `metadata.validate_widget_config(p_widget_type, p_config)` returning `TABLE(path text, code text, message text, hint text)`. It reads `widget_types.config_schema` and walks it recursively. The subset is deliberately small, because the widget shapes need little:

- `type` (object, array, string, number, integer, boolean), `properties`, `required`, `items`, `enum`, `minimum`/`maximum`, `additionalProperties` (default: unknown keys are warnings, not errors; see 4);
- vendor annotations `x-translatable`, `x-aliases`, `x-deprecated`, `x-schema-version` (see 5, 6).

No `$ref`, `oneOf` or `pattern` in v1. If a shape needs a union (for example number-or-boolean `dayMaxEvents`), express it as a list of allowed types in `type`. A recursive plpgsql walker is on the order of 100 to 150 lines. The cost is that the SQL and TypeScript interpreters must agree, which a shared fixture suite (valid and invalid configs with expected issue codes, run against both) enforces.

Trigger, not `CHECK`: a `CHECK` that reads another table (`widget_types`) is not a supported use, cannot emit warnings, and re-validates on every restore. `NOT VALID` checks give warn-then-enforce but only as a hard failure, never as a warning.

### 3. Single source of truth: the JSON Schema documents, TypeScript derived

[3/5] Author one JSON Schema document per widget type in `packages/core` (data files, the only artifact SQL, TypeScript and MCP can all consume). Then:

- A codegen step (same pattern as `golden:codegen` and its `:check`) emits the SQL seed migration body that fills `widget_types.config_schema`, and CI fails on drift.
- TypeScript interfaces are generated from the schemas. Phase 1 keeps the hand-written interfaces and adds a type-level conformance test (generated type and hand-written interface must be mutually assignable), so the interfaces can be replaced by generated ones once the test is green. This also surfaces the existing drift listed above.
- A coverage test asserts every widget component's config keys appear in its schema. Adding a key to a widget without updating the schema fails CI, which answers "who keeps them in step".

The alternative, TypeScript as source with a generator (`ts-json-schema-generator`, zod), keeps the type authoring ergonomics but makes the SQL artifact a build output of a TS toolchain and loses the ability to carry `x-` annotations cleanly. It is within one point; choose it if hand-authoring JSON Schema proves too painful.

Seeding `config_schema` is framework content (`widget_types` is a framework registry, like the types themselves), not instance content, so a migration may write it. A `NULL` schema means "no validation", which keeps integrator-registered types working.

### 4. Strictness and existing rows: warn first, enforce structure, never rewrite

[4/5]

- **Severity split.** Structural problems are errors: wrong type, missing required key, value outside an `enum`. Unknown keys are warnings, with a "did you mean" hint from `x-aliases` and edit distance (`entity` to `entityKey`, `columns` to `showColumns`, `filter` to `filters`; a `title` inside config points at the `title` column).
- **Mode.** A single instance setting selects `off | warn | error` (an integrator `instance_config` key, read by the trigger through `get_config()`). Default `warn` in the first release: the trigger issues `RAISE WARNING` and writes the row. A later release changes the default to `error` for structural issues only. A `strict` mode that also rejects unknown keys is opt-in until v1.0.
- **Validate on write only, and only when relevant.** The trigger fires on `INSERT` and `UPDATE OF config, widget_type`, and skips an update where both are unchanged (`IS NOT DISTINCT FROM` the old values). Existing rows with dead keys keep working and never block an unrelated update such as `sort_order`.
- **Never rewrite.** No migration touches stored configs, which keeps to the rule that migrations change schema shape, never instance content.
- **Finding bad rows in existing instances.** A `security_invoker` view `metadata.dashboard_widget_config_issues` returns one row per issue (`dashboard_id`, `widget_id`, `widget_type`, `path`, `code`, `message`). Operators run it after upgrading; CI runs it against each example.
- **What the integrator sees.** The error is `check_violation` with a `MESSAGE` that lists every issue (not just the first), `DETAIL` with the JSON path, and a `HINT` with the alias or valid keys. With `ON_ERROR_STOP` the Sqitch deploy fails at that statement and names the widget type.
- **Restore risk.** A restore replays rows through the trigger. `warn` mode cannot fail a restore. In `error` mode the exposure is rows that predate enforcement, so document disabling the trigger for `pg_restore` in the operator note.

### 5. Schema evolution: additive by default, aliases and a reader shim for breaks

[3/5]

- **Additive, optional keys** (the common case, such as the v0.80.0 key filters) need no versioning. The schema gains the key in the same migration as the widget feature, and the coverage test in 3 forces that.
- **Renames and removals** use `x-aliases` and `x-deprecated` in the schema: the old key still validates (as a warning) and a single `normalizeWidgetConfig()` in core maps old shapes to the current one. Widgets read the normalized config, so old rows keep working with no data migration. `x-schema-version` is an integer on the schema, bumped on a breaking change, and exposed so tools can say which version a row was checked against. Rows do not store a version.
- **Shape versus meaning.** The schema validates shape (`filters[]` is an array of `{column: string, operator: enum, value}`). Meaning (`status_id.status_key` resolves to a real Status key, a column exists on the entity) stays in render-time resolution and, optionally, a later warn-only `check_widget_references()`. Entities and statuses can legitimately be created after the widget, so these must never be trigger errors. The operator `enum` should come from the operator table in `DASHBOARD_WIDGETS.md`, including the v0.80.0 additions (`not.eq`, `not.in`).

### 6. Translation: declare translatable paths once, in the schema

[4/5] Today `translate_widget_config()` and the schema would each list the fields. Annotate string properties with `x-translatable: true` and add a parity test that the set of translatable paths in `translate_widget_config()` equals the schema's annotations, for every widget type. A follow-up can make the function walk the schema and delete the hard-coded `CASE`, behavior-preserving and covered by the same fixtures.

v0.80.2 added two optional keys to `filtered_list` widgets: `config.emptyMessage` (string, translatable) and `config.showSeeMore` (boolean, default `true`). Its migration `v0-80-2-widget-empty-message` gave `translate_widget_config()` a `filtered_list` branch for `emptyMessage` (source key `dashboard.{dashboard_id}.widget.{widget_id}.emptyMessage`), which before fell to `ELSE NULL`. Consequences:

- The `filtered_list` schema must include both keys, with `emptyMessage` marked `x-translatable`, so the parity test matches the existing branch from the start.
- Any later widget key follows the same rule: the schema change and any `translate_widget_config()` branch land together, and the parity test fails if either lands alone.

### 7. Scope: widget-first, generic validator, audit the rest later

[3/5] Build `validate_widget_config()` as a thin wrapper over a type-agnostic `metadata.validate_json_shape(p_schema, p_doc)`, so the walker is reusable. Do not generalize the registry or triggers now. Widgets have the strongest case: a registry column already exists, the shapes are many, and the failure is silent. Other JSONB metadata (guided-form step conditions, `validation_rules`, action parameter configuration, `static_assets.crop_state`) should be audited one at a time before extending: the questions for each are whether it has multiple shapes selected by a discriminator and whether errors are silent. Single-shape or typed-column metadata does not need this. Instance Management MCP tools should call the core validator for every JSONB metadata write they gain, whatever the database does.

## Phased plan

| Phase | Deliverable | Ships |
|---|---|---|
| 0 | Reconcile docs, interfaces and widget components (the drift listed above); decide the operator `enum`. No behavior change. | Docs and core model |
| 1 | JSON Schema documents for the eight widget types in `packages/core`; shared fixture suite; `validateWidgetConfig()` and `normalizeWidgetConfig()` in core; conformance and key-coverage tests. | `@civic-os/core` |
| 2 | Migration: `validate_json_shape()`, `validate_widget_config()`, seed `config_schema`, the issues view, and the trigger in `warn` mode. Parity test against the fixtures. Functional test script. | Core migration |
| 3 | CI lint over example init scripts; Instance Management MCP and Schema Assistant prompts consume the schemas; dev-only frontend warning. | Tooling |
| 4 | `x-translatable` parity test, then `translate_widget_config()` driven by the schema. | Core migration |
| 5 | Default mode becomes `error` for structural issues, announced one release ahead in release notes. `strict` stays opt-in until v1.0. | Core migration |

Each phase is independently shippable; phase 2 alone closes the silent-error gap for new writes.

## Risks and open questions

- Two interpreters (SQL and TypeScript) can disagree; the shared fixtures are the control, and they must run in CI for both.
- The JSON Schema subset limits expressiveness; if `oneOf` is needed in practice, extend the subset in both interpreters together.
- Mode storage: an `instance_config` integrator key is reachable per instance and from the admin page, and adds one read per widget write (negligible volume). An ENV-only switch would be simpler but not changeable at runtime.
- Generating TypeScript from JSON Schema may lose the explanatory comments on the current interfaces; carry them in schema `description` fields.
- Whether unknown keys ever become errors by default depends on how many deployed instances the issues view flags.

## References

- `docs/development/DASHBOARD_WIDGETS.md` (config reference), `docs/notes/DASHBOARD_DESIGN.md` (original Phase 3 item)
- `packages/core/src/model/dashboard.ts`, `src/app/components/widgets/`
- `postgres/migrations/deploy/v0-62-0-dashboard-translations.sql`, `v0-80-0-widget-key-filters.sql`
- `docs/notes/INSTANCE_MANAGEMENT_MCP_DESIGN.md` (`add_widget`)
