# Frontend golden outputs: coverage checklist

What the frontend's current code produces from the raw metadata fixtures in `tests/golden/raw/`, captured as committed JSON. Phase 1 moves this logic into `@civic-os/core`; the core's tests must reproduce these bytes. The files are written only by `scripts/golden/derive-frontend.sh` (which runs the real services under the Angular unit-test runner with `GOLDEN_UPDATE=1`); a normal `npm run test:headless` compares and fails on any changed, missing or orphan file. Specs: `src/app/testing/golden/*.golden.spec.ts`.

## Layout

```
tests/golden/derived/frontend/
  <example>/<role>[.es]/          one dir per raw variant: 8 examples x (anon, testuser, testeditor, testmanager, testadmin) + pothole .es
    schema.properties.json        typed properties, select strings (3 variants), column span, default value, fresh-path types
    schema.views.json             getPropsFor{List,Detail,Create,Edit,Filter} column lists + {Detail,Create,Edit}Renderables plan
    schema.m2m.json               detected junction tables, M:M virtual properties (many_to_many_meta, parent hops), per-table relationships
    schema.inverse-menu.json      getInverseRelationships (with/without excludeTables), getEntitiesForMenu / ForManagement
    schema.validators.json        validator fingerprints: property -> signature, signature -> value matrix -> Angular error objects
    transforms.rows.json          synthetic rows per entity through CreatePage/EditPage transformValuesForApi and transformValueForControl, per time zone
    data.m2m-transform.json       DataService.transformManyToManyData over synthetic junction rows built from each M:M property's meta
  <example>/_example/             role-independent, per example (read from the testadmin variant)
    conditions.actions.json       evaluateCondition + extractConditionFieldNames for every visibility/enabled condition, flat / FK-embedded / dot-path records
    conditions.guided-forms.json  GuidedFormService.evaluateCondition / getEffectiveSteps / getLockedFields over the example's step conditions
    errors.lookup.json            parseToHuman vs parseToHumanWithLookup over the payload set with the example's constraint_messages
    data.queries.json             getData / getDataPaginated URL + headers per entity (list, order, pagination, filters, search, hybrid, calendar, detail, edit) and inverse-preview requests
  _synthetic/                     hand-built branch coverage, see below
    all/schema.*.json, all/transforms.rows.json, all/data.m2m-transform.json   same artifacts as a raw variant, generated through the same loadSchema path
    conditions.guided-forms.json  synthetic skip_if / require_if steps (multi-condition, every operator, unknown operators)
  _shared/                        example-independent
    transforms.dst-edges.json     DateTime / DateTimeLocal / Money / File / PhotoGallery edge matrix in UTC, America/New_York, Asia/Kolkata, Australia/Lord_Howe
    conditions.matrix.json        operator x condition-value x data-value matrix, dot-path cases, field-name extraction shapes
    conditions.guided-form-matrix.json
    errors.data-parse-api-error.json   DataService.parseApiError over HttpErrorResponse shapes
    data.query-matrix.json        special-character filters/search/order/pagination, headers as emitted
    data.content-range.json       Content-Range parsing, both variants
    data.mutation-requests.json   create/edit/delete/rpc/M:M/bulk request shapes, executeRpc normalization, editData -> checkEditResult outcomes
    data.compare-helpers.json     compare{DateTime,Date,Money,Color,TimeSlot,Geography}Values, checkEditResult, parseEWKBPoint
    data.hybrid-search.json       buildHybridSearchParams matrix, ListPage.buildSearchParams, ListPage.buildOrderField per property type
```

Conventions: keys sorted, 2-space indent, short flat arrays/objects inline, trailing newline. `undefined`-valued keys are dropped; `undefined` array items, `NaN`, `Infinity`, `-0`, `Date` and similar are written as `__undefined__`, `__NaN__`, ... markers. `selectForEdit` / `selectForList` are `"="` when equal to `select`. Time zones are switched in-process through `process.env.TZ` (proved and restored by the first test in `transforms.golden.spec.ts`), so the machine's zone does not matter: the generated files are byte-identical when derived under `TZ=Asia/Kolkata` or `TZ=Australia/Lord_Howe`. `transforms.rows.json` outputs are written under `"*"` when identical in all four zones, else per zone.

Observed quirks recorded as-is (do not "fix" in the move): DataService does not encode filter values (only the search term), `page <= 0` yields a negative `Range`, a fractional page yields a `Range` offset that is not a multiple of the page size, `DateTimeLocal` garbage becomes `NaN-NaN-NaNTNaN:NaN` in `transformValueForControl`, DateTime transforms ignore 19-character strings, `parseToHuman` has no message for 23503 / 23502 / 22P02 / PGRST* / PT503.

## Function checklist

### SchemaService (`src/app/services/schema.service.ts`)

| Function | Artifact |
|---|---|
| `getPropertyType` (private) | `schema.properties.json` `type`. Real examples cover only the branches their schemas use (no `timestamp`, no recurring `time_slot`, no `float*`, no `int8` Status/Category, no `payment_transactions` FK); the hand-built `_synthetic/all` variant covers every branch, including the Unknown fall-throughs. `freshTypes` re-derives the types through `getPropertiesForEntityFresh` |
| `propertyToSelectString`, `...ForEdit`, `...ForList` | `schema.properties.json` `select*` |
| `ensureStructuralProps` | `schema.views.json` (display_name / status_id / submitted_at appended to list, detail, edit) |
| `getPropsForList/Detail/Create/Edit/Filter` | `schema.views.json` |
| `getFormValidatorsForProperty` | `schema.validators.json` |
| `getDefaultValueForProperty`, `getColumnSpan` | `schema.properties.json` |
| `get{Detail,Create,Edit}Renderables`, `getRenderableColumnSpan` | `schema.views.json` `renderables` (static text included for community-center / mottpark) |
| `detectJunctionTables`, `detectParentHops`, `enrichPropertiesWithManyToMany` | `schema.m2m.json` `virtualProperties` (full object incl. `many_to_many_meta`, `parentHops`, flags merged from `schema_m2m_properties`) |
| `getManyToManyRelationships`, `getDetectedJunctionTables` | `schema.m2m.json` |
| `getInverseRelationships` + `getJunctionTableNamesFromProperties`, `getPreviewMode`, `groupBySourceTable`, `getDisplayNameForTable`, `shouldShowOnDetail`, `getPreviewLimit` | `schema.inverse-menu.json` |
| `getEntitiesForMenu`, `getEntitiesForManagement` | `schema.inverse-menu.json` |
| `getProperties` (type assignment, M:M enrichment, sort) | `schema.properties.json` order and content |
| `getStaticTextForEntity` | consumed by renderables |

Not covered, with reason: `getStatusesForEntity`, `getCategoriesForEntity`, `*OptionsSync`, `ensure*Loaded`, `invalidate*` (HTTP + signal caches, no interpretation logic); `getGuidedFormDefinitions/Steps/ForEntity` (fetch + join); `getEntityActions` (HTTP with `table_name=eq.` params; the conditions on its output are covered in `conditions.actions.json`); `refresh*Cache`, `localeEffect` (cache lifecycle); `getEntities` / `getEntity` (signal plumbing, exercised by every artifact).

### DataService (`src/app/services/data.service.ts`)

| Function | Artifact |
|---|---|
| `getData` (query builder) | `_example/data.queries.json`, `_shared/data.query-matrix.json` |
| `getDataPaginated` (builder, Range / Range-Unit / Prefer headers) | same, plus `_shared/data.content-range.json` |
| Content-Range regexes (both variants) | `_shared/data.content-range.json` |
| `getInverseRelationshipPreview`, `getInverseRelationshipData` | `_example/data.queries.json` `inversePreviews`, `_shared/data.content-range.json` `previewModes` |
| `transformManyToManyData` (static) | `<variant>/data.m2m-transform.json` |
| `compare*Values`, `checkEditResult`, `parseEWKBPoint`, `parseLE32`, `parseLE64Double` | `_shared/data.compare-helpers.json`; `checkEditResult` end-to-end in `_shared/data.mutation-requests.json` `editData results` |
| `executeRpc` normalization | `_shared/data.mutation-requests.json` `executeRpc` |
| `parseApiError` | `_shared/errors.data-parse-api-error.json` |
| `createData`, `editData`, `deleteData`, `refreshCurrentUser`, `callRpc`, `add/update/removeManyToManyRelation`, `bulkInsert`, `bulkInsertJunctions` request shapes | `_shared/data.mutation-requests.json` |

Not covered, with reason: `parseApiResponse` (dead code, no callers).

### Request building outside DataService

| Function | Artifact |
|---|---|
| `buildHybridSearchParams` (`utils/search.utils.ts`) | `_shared/data.hybrid-search.json` |
| `ListPage.buildSearchParams`, `ListPage.buildOrderField` (private, via prototype) | `_shared/data.hybrid-search.json`; used to build `_example/data.queries.json` |
| calendar `ov` filter | shape recorded in `_example/data.queries.json` ("calendar overlap filter"); value is a fixed literal |

Not covered, with reason: the `ListPage` query-assembly pipeline (`columns`, valid-filter pruning, `calculateDateRange`, search-versus-order precedence) is orchestration inside an RxJS pipeline over router state and `new Date()`; the request-equivalence harness (P0.4) records it end to end.

### Transforms

| Function | Artifact |
|---|---|
| `CreatePage.transformValuesForApi` (`create.page.ts:657`) | `<variant>/transforms.rows.json` (`createApi`), `_shared/transforms.dst-edges.json` (`create`) |
| `EditPage.transformValuesForApi` (`edit.page.ts:912`) | same (`editApi`, `edit`) |
| `EditPage.transformValueForControl` (`edit.page.ts:839`) | same (`control`) |
| `parseDatetimeLocal` (`utils/date.utils.ts`) | exercised through the DateTimeLocal paths of all three |

DST cases: America/New_York 2026-03-08T02:30 (gap) and 2026-11-01T01:30 (overlap), Australia/Lord_Howe 2026-04-05T01:45 (30-minute overlap) and 2026-10-04T02:15 (30-minute gap), invalid calendar days, leap day, year boundaries, 19-character strings.

### Conditions

| Function | Artifact |
|---|---|
| `evaluateCondition`, `extractConditionFieldNames` (`utils/condition-evaluator.ts`) | `_example/conditions.actions.json`, `_shared/conditions.matrix.json` |
| `GuidedFormService.evaluateCondition` | `_example/conditions.guided-forms.json`, `_shared/conditions.guided-form-matrix.json` |
| `GuidedFormService.getEffectiveSteps`, `getLockedFields` | `_example/conditions.guided-forms.json` (only neighborhood-hub has guided-form steps; the other examples write an empty record) |

Not covered, with reason: `GuidedFormService` HTTP methods and context loading (`loadContext`, `startGuidedForm`, `completeStep`, ...) are stateful I/O.

### Errors

| Function | Artifact |
|---|---|
| `ErrorService.parseToHuman` (static) | `_example/errors.lookup.json` |
| `ErrorService.parseToHumanWithLookup` | `_example/errors.lookup.json` (with each example's `constraint_messages` loaded through `SchemaService.getConstraintMessages`, plus the not-yet-loaded fallback) |

Not covered, with reason: `parseToHumanWithTracking` (adds only an analytics side effect around `parseToHumanWithLookup`).


## Synthetic variant (`_synthetic/`)

`src/app/testing/golden/synthetic-fixtures.ts` builds `schema_entities`, `schema_properties`, `schema_m2m_properties` and `static_text` rows in memory and flushes them through the same `loadSchema` path as the raw fixtures, so the synthetic entities get every `schema.*`, `transforms.rows` and `data.m2m-transform` artifact. Rows are named after the branch they cover (`status_int8`, `time_slot_recurring`, `transactions_public_schema_is_unknown`, ...). It covers: every `getPropertyType` branch and fall-through (Status / Category on int4 and int8 and the no-join-column cases, all File / User / Payment / PhotoGallery routes, FK, geography Polygon / Point / other, every scalar udt, Unknown udts); `getColumnSpan` (Markdown default and overrides, width 0); view-filter flags (`show_on_*` false and null, generated, identity, not updatable, `created_at` / `updated_at`, structural `status_id` / `submitted_at`, filterable per supported and unsupported type); every validation rule type with numeric, empty, missing and non-numeric values; `getPreviewMode` (`display_name` / `id` / `count`), grouping and self-reference; pure, color, rich, un-flagged rich, User-FK, parent-hop, ambiguous-hop and dead-end junctions with `schema_m2m_properties` overrides; static text per page flag. The synthetic guided-form steps cover `skip_if` / `require_if` with several conditions, all four operators, embedded FK parents, completed-step progress, and unknown operators.

## Validator contract

The fingerprints in `schema.validators.json` (rule signature -> Angular error objects over a fixed value matrix) ARE the contract. In P1.1b the core emits validation rules as data; a parity spec maps those rules through the Angular adapter, and the adapter must reproduce every fingerprint byte for byte. `getFormValidatorsForProperty` itself stays in the app as that adapter.

## Mutation evidence

Each row was a temporary edit of the named source line; the golden check failed with the artifact kinds listed (file counts are across all variants). Reverted afterwards. Re-run recipe: apply the edit, `scripts/golden/derive-frontend.sh --check`.

| Branch | Mutation | Failing artifact kinds |
|---|---|---|
| `getPropertyType` timestamp -> DateTime | returns DateTimeLocal | `_synthetic/all/schema.properties.json`, `transforms.rows.json` |
| time_slot + `is_recurring` -> RecurringTimeSlot | `&& false` | same |
| `payment_transactions` join table -> Payment | branch removed | same |
| float4 / float8 -> DecimalNumber | each removed from the list | same |
| Status on int8 | int8 removed from the Status guard | same |
| Category on int8 | int8 removed from the Category guard | same |
| `getColumnSpan` Markdown default 4 | returns 3 | `_synthetic/all/schema.properties.json`, `schema.views.json` |
| `getPreviewMode` count / id | always `count`; `id` -> `display_name` | `schema.inverse-menu.json` (synthetic and 12 more), `data.queries.json` |
| `getEffectiveSteps` require_if branch | filter picks skip_if | `_synthetic/conditions.guided-forms.json` |
| `getEffectiveSteps` multi-condition (first wins) | only the first skip_if / require_if evaluated | `_synthetic/conditions.guided-forms.json` |
| `compareTimeSlotValues` end bound; local-time parse under the TZ matrix | end ignored; `Z` stripped | `_shared/data.compare-helpers.json` (+ `data.mutation-requests.json` for the local-time case) |
| `pattern` rule matching `^\d{10}$` | `{10}` -> `{9}` | `schema.validators.json` (11 files; the matching probes `1234567890` / `0123456789` are in the matrix) |
| `parseToHuman` P0001 with missing message | `err.message || 'System Error'` | `errors.lookup.json` (8 files) |
| `transformManyToManyData` non-array guard | `!Array.isArray` removed | `_shared/data.compare-helpers.json` (`transformManyToManyGuards`) |

Not detectable by construction: removing the `break` after `isSkipped = true` / `isRequired = true` in `getEffectiveSteps` (the flags are idempotent, so behavior is identical), and stripping milliseconds in `compareTimeSlotValues` (`new Date` parses both forms to the same instant).

Transform inputs follow the real pages: inline M:M properties are in `currentProps` but excluded from the FormGroup, so their keys are never present in the form values, the raw row or the control map.
