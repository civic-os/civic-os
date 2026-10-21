/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Rule catalogue for the SDK divergence ledger (scripts/golden/ledger.mjs).
 *
 * One entry per distinct RULE on which the frontend and the MCP server
 * interpret the metadata contract differently, plus the frontend quirks the
 * P0.2b goldens captured. Instance counts are NOT written here: the ledger
 * engines compute them from the golden trees, attributing a difference only
 * when both sides match the reference models in ledger-models.mjs and the
 * rule's transformation explains it. Prose here states each side's behavior with code
 * citations; `checks` assert that the cited code still contains the quoted
 * text (`contains`; a stale citation fails the ledger run) and, for rows fixed
 * on main, that the removed code is gone (`absent`); `status` / `fixedIn` /
 * `fix` / `history` record a fix on main (see FIX below); `probes` (type detection)
 * name synthetic inputs from tests/golden/derived/mcp/_shared/mcp.type-probes.json
 * with the frontend result derived from the cited code, so latent rules carry
 * computed MCP evidence; `compute` adds instances for rows whose evidence is
 * not a frontend/MCP artifact pair.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SS = 'src/app/services/schema.service.ts';
const SC = 'tools/mcp-server/src/schema-cache.ts';
const SB = 'tools/mcp-server/src/select-builder.ts';
const EA = 'tools/mcp-server/src/tools/execute-action.ts';
const GR = 'tools/mcp-server/src/tools/get-record.ts';
const LR = 'tools/mcp-server/src/tools/list-records.ts';
const NR = 'tools/mcp-server/src/name-resolver.ts';
const PC = 'tools/mcp-server/src/postgrest-client.ts';
const CE = 'src/app/utils/condition-evaluator.ts';
const DS = 'src/app/services/data.service.ts';
const ES = 'src/app/services/error.service.ts';
const FEG = 'tests/golden/derived/frontend';
const MCG = 'tests/golden/derived/mcp';
const GSW = 'tools/mcp-server/src/tools/get-status-workflow.ts';

/**
 * The main-branch commit that fixed most of the MCP divergences this ledger
 * found (PR #12, released as v0.76.6 / v0.76.7 and squashed). Rows it changed
 * carry `status` (fixed-on-main, partially-fixed-on-main or changed-on-main),
 * `fixedIn`, a `fix` summary, live `checks` against the new code (`contains`
 * proves the fix is present, `absent` that the removed code has not come back)
 * and a `history` entry: a past-tense `summary`, the row as the pre-update
 * ledger (a7143cee) stated it, copied verbatim (`rule`, `frontend`, `mcp`,
 * `evidence`, `latent` / `unit`, `recommendation`, `reason`, and its `checks`
 * as `anchors`, kept as text and not checked), and its instance counts as of
 * the last ledger before the merge (74a13f05).
 */
const FIX = 'b3f2eeb8';
/** Instance summary as it was before the fix (from the committed ledger at 74a13f05). */
const was = (examples, entities, synthetic, occurrences, extra) => `${examples} in examples (${entities} entities)${synthetic ? `; ${synthetic} synthetic` : ''}; ${occurrences} occurrences${extra ? `; ${extra}` : ''}`;

export const AREAS = [
  { name: 'Type detection', intro: '`SchemaService.getPropertyType` (frontend) vs `detectPropertyType` (MCP). Artifacts: `<variant>/schema.properties.json` `type` on both sides; latent rules are demonstrated by `mcp/_shared/mcp.type-probes.json`. Every probe is compared: its frontend type comes from the transcription of `getPropertyType` in `scripts/golden/ledger-models.mjs` (`feType`), which is checked against the frontend type of every fixture property and of every row of the hand-built frontend `_synthetic` golden variant (which reaches every frontend result type, DateTime and RecurringTimeSlot included); branches neither exercises are anchored by that transcription only. The Coverage section lists them, computed: on the MCP side DateTime and RecurringTimeSlot (until P0.5 adds a real timestamp column), and udt values in no raw fixture such as int2, bpchar, float4 / float8, jsonb, MultiPolygon. Follow-up: run the probe inputs through the frontend golden harness.' },
  { name: 'Select strings', intro: '`SchemaService.propertyToSelectString[ForList]` vs MCP `propertyToSelectString`. Artifacts: `<variant>/schema.properties.json` `select`. Differences caused by a type rule are counted as that rule\'s effects.' },
  { name: 'View property lists', intro: '`getPropsForList/Detail/Create/Edit` vs MCP `filterProperties`. Artifacts: `<variant>/schema.views.json`. Order differences confined to `sort_order` ties are capture artifacts and not counted.' },
  { name: 'Condition evaluation', intro: '`utils/condition-evaluator.ts` vs MCP `evaluateCondition` over identical condition / record inputs. Artifacts: `_example/conditions.actions.json`, `_shared/conditions.matrix.json`, `mcp/_shared/mcp.conditions-extra.json`. Counts are (condition, record) pairs; `_shared` matrix cells are reported as synthetic. Since `b3f2eeb8` the MCP evaluator mirrors the frontend one on every golden input (C-01 to C-05 fixed); only malformed conditions, which no golden input contains, still differ (C-06).' },
  { name: 'Actions end to end', intro: 'Every conditional action run through the real MCP `execute_action` and `get_record` tools against records in the shape the MCP itself fetches (`mcp/_example/mcp.actions-execute.json`). This is the production consequence of the evaluator and select rules; a disagreement is counted as an effect of the open condition rule that explains it.' },
  { name: 'Error messages', intro: '`ErrorService.parseToHuman[WithLookup]` vs `PostgRESTRequestError.toHumanMessage` over the frontend payload set (`_example/errors.lookup.json`) and the client error path (`_shared/errors.data-parse-api-error.json`). Payloads without a constraint name are counted once (as `_shared`).' },
  { name: 'Request building', intro: '`DataService.getData/getDataPaginated` vs the MCP `list_records` / `get_record` tools, over the frontend\'s per-entity query inputs (`_example/data.queries.json`) and its special-character / pagination matrix (`_shared/data.query-matrix.json`). URLs are compared as PostgREST decodes them.' },
  { name: 'Name resolution', intro: 'MCP `NameResolver` (`mcp.names*.json`). The generic app\'s only counterpart is the import worker\'s FK name matching (`import-validation.worker.ts` `validateForeignKey` over `ImportExportService.buildForeignKeyLookup`), cited from code; a frontend golden for it is a follow-up.' },
  { name: 'Other MCP behavior', intro: 'MCP behavior with no golden counterpart on the frontend side, cited from code.' },
  { name: 'Frontend quirks', intro: 'Current frontend behavior captured by the P0.2b goldens and confirmed by its verifier (forwarded by the lead). All are recorded as-is; none is fixed in Phase 0. Where the MCP has a counterpart, its behavior is stated.' },
];

const T = 'Type detection';
const S = 'Select strings';
const V = 'View property lists';
const C = 'Condition evaluation';
const A = 'Actions end to end';
const E = 'Error messages';
const Q = 'Request building';
const N = 'Name resolution';
const X = 'Other MCP behavior';
const F = 'Frontend quirks';

export const RULES = [
  // ---------------------------------------------------------------- types
  {
    id: 'T-01', area: T,
    rule: 'Foreign key presence: MCP requires join_table AND join_column; frontend requires join_column != null (int4/int8 only)',
    frontend: 'Status, Category and ForeignKeyName need `join_column != null` and an int4/int8 udt; `join_table` is not checked.',
    mcp: '`hasFK = !!join_table && !!join_column` gates Status, Category, the system types and ForeignKeyName.',
    evidence: [`${SS}:636`, `${SS}:673`, `${SC}:412`],
    checks: [{ file: SC, contains: ['const hasFK = !!join_table && !!join_column;'] }, { file: SS, contains: ["['int4', 'int8'].includes(val.udt_name) && val.join_column != null) ? EntityPropertyType.ForeignKeyName"] }],
    probes: { 'int4 join_column only': 'ForeignKeyName', 'status int4 join_column only': 'Status' },
    latent: 'schema_properties always reports join_table with join_column in every example; demonstrated by the type probes',
    impact: {
      adoptFrontend: 'No generic-app change; the MCP would type a join_column-only property as a foreign key it cannot embed (no join_table for the select).',
      adoptMcp: 'Generic app stops treating a join_column-only integer as an FK, and a join_column-only column carrying status_entity_type / category_entity_type stops rendering as a Status / Category badge (latent: no example has such a column); today the frontend would build a select and dropdown with no target table for it.',
    },
    recommendation: 'adopt-mcp', reason: 'Strictly safer: an FK without join_table cannot be embedded or offered as options, so typing it as a plain integer is the correct fallback.',
  },
  {
    id: 'T-02', area: T,
    rule: 'Status / Category detection: MCP accepts any FK udt; frontend requires int4/int8',
    frontend: 'Status/Category only for int4/int8 columns with `status_entity_type`/`category_entity_type` and a join_column.',
    mcp: 'Any FK (join_table + join_column) with `status_entity_type`/`category_entity_type`, whatever the udt (uuid, text, varchar).',
    evidence: [`${SS}:636-645`, `${SC}:415-422`],
    checks: [{ file: SC, contains: ['if (prop.status_entity_type && hasFK) {'] }, { file: SS, contains: ["val.status_entity_type && ['int4', 'int8'].includes(val.udt_name)"] }],
    probes: { 'status uuid fk': 'Unknown', 'status text fk': 'TextLong', 'category varchar fk': 'TextShort' },
    latent: 'every Status/Category column in the examples is int4; demonstrated by the type probes',
    impact: {
      adoptFrontend: 'No generic-app change; the MCP stops embedding `statuses!col` on non-integer columns (an embed PostgREST would reject unless the FK targets statuses).',
      adoptMcp: 'Generic app would show status badges for non-integer status columns, whose ids cannot match `metadata.statuses.id`.',
    },
    recommendation: 'adopt-frontend', reason: 'Statuses and categories have integer ids; a non-integer column carrying status_entity_type is a misconfiguration, not a status.',
  },
  {
    id: 'T-03', area: T,
    rule: 'System types (File, User, Payment, PhotoGallery): MCP accepts any FK udt; frontend requires uuid',
    frontend: 'System types only for `udt_name = uuid` with a system join_table; an int FK to a system table is a ForeignKeyName (select falls back to the plain column because join_schema is not public, see S-02).',
    mcp: 'Any FK to files / civic_os_users / payment_transactions / transactions / photo_galleries becomes the system type, whatever the udt.',
    evidence: [`${SS}:648`, `${SC}:425-442`],
    checks: [{ file: SS, contains: ["val.udt_name === 'uuid' && val.join_table && isSystemType(val.join_table)"] }],
    probes: { 'files int8 fk': 'ForeignKeyName', 'civic_os_users int8': 'ForeignKeyName', 'photo_galleries int4': 'ForeignKeyName' },
    impact: {
      adoptFrontend: 'No generic-app change; the MCP shows the raw id for these columns instead of a user / file embed.',
      adoptMcp: 'Generic app renders the instances below as User / File components; correct only if the column really holds the system table\'s key.',
    },
    recommendation: 'needs-decision', reason: 'The one real instance (staff-portal staff_directory.id, int8 FK to civic_os_users) looks like a metadata error; decide whether the contract allows non-uuid system FKs before choosing a side.',
  },
  {
    id: 'T-04', area: T,
    rule: 'User type also for civic_os_users_private (MCP only)',
    frontend: 'User only when join_table is `civic_os_users`; an FK to `civic_os_users_private` is Unknown.',
    mcp: 'User for `civic_os_users` or `civic_os_users_private`, but the select still embeds `civic_os_users!col`, which does not match an FK to the private table.',
    evidence: [`${SS}:661`, `${SC}:433`, `${SB}:26-27`],
    checks: [{ file: SC, contains: ["join_table === 'civic_os_users' || join_table === 'civic_os_users_private'"] }],
    probes: { 'civic_os_users_private uuid': 'Unknown' },
    latent: 'no example has an FK to civic_os_users_private',
    impact: {
      adoptFrontend: 'No generic-app change; the MCP stops emitting an embed whose FK hint points at the wrong table.',
      adoptMcp: 'Generic app would render such columns as users, with a select that PostgREST cannot resolve.',
    },
    recommendation: 'adopt-frontend', reason: 'The MCP half-supports it: the type says User but the embed targets civic_os_users, so the request would fail.',
  },
  {
    id: 'T-05', area: T,
    rule: 'Payment type: MCP accepts any table named transactions; frontend requires join_schema payments',
    frontend: 'Payment for `payment_transactions`, or `transactions` only when `join_schema = payments`.',
    mcp: 'Payment for `payment_transactions` or any `transactions`, schema ignored.',
    evidence: [`${SS}:663-664`, `${SC}:436`],
    checks: [{ file: SS, contains: ["val.join_table === 'transactions' && val.join_schema === 'payments'"] }, { file: SC, contains: ["join_table === 'payment_transactions' || join_table === 'transactions'"] }],
    probes: { 'transactions uuid public schema': 'Unknown' },
    latent: 'both payment examples point at payments.transactions',
    impact: {
      adoptFrontend: 'No generic-app change; an integrator table named public.transactions stops being misread as a payment by the MCP.',
      adoptMcp: 'Generic app would show a Pay badge for any uuid FK to a table called transactions.',
    },
    recommendation: 'adopt-frontend', reason: 'Schema-qualified detection avoids a name collision with integrator tables.',
  },
  {
    id: 'T-06', area: T,
    rule: 'FileImage: MCP matches fileType values starting with "image"; frontend requires "image/"',
    frontend: '`fileType` validation value must start with `image/`.',
    mcp: '`fileType` value starting with `image` (no slash) is enough.',
    evidence: [`${SS}:654`, `${SC}:429`],
    checks: [{ file: SS, contains: ["fileTypeValidation.value.startsWith('image/')"] }, { file: SC, contains: ["fileTypeRule?.value?.startsWith('image')"] }],
    probes: { 'files uuid "image" (no slash)': 'File' },
    latent: 'every example uses MIME patterns with a slash',
    impact: {
      adoptFrontend: 'No generic-app change; a malformed fileType `image` makes the MCP report File instead of FileImage.',
      adoptMcp: 'Generic app shows image previews for `image`-prefixed non-MIME values.',
    },
    recommendation: 'adopt-frontend', reason: 'fileType values are MIME patterns; the slash check is the precise one.',
  },
  {
    id: 'T-07', area: T,
    rule: 'Geography: MCP maps MultiPolygon to GeoPolygon and every other geography to GeoPoint, and requires data_type USER-DEFINED',
    frontend: 'GeoPolygon only for `geography_type = Polygon`, GeoPoint only for `Point`; anything else is Unknown. data_type is not checked.',
    mcp: 'Requires `data_type = USER-DEFINED`; Polygon or MultiPolygon is GeoPolygon; LineString, null and anything else is GeoPoint.',
    evidence: [`${SS}:674-675`, `${SC}:445-450`],
    checks: [{ file: SC, contains: ["if (data_type === 'USER-DEFINED' && udt_name === 'geography') {"] }],
    probes: { 'geography MultiPolygon': 'Unknown', 'geography LineString': 'Unknown', 'geography null geography_type': 'Unknown', 'geography Point data_type not USER-DEFINED': 'GeoPoint' },
    latent: 'the examples only use Point and Polygon',
    impact: {
      adoptFrontend: 'No generic-app change; MultiPolygon columns become Unknown in the MCP too.',
      adoptMcp: 'Generic app renders MultiPolygon with the polygon map (good) but LineString and untyped geography as a point map (wrong).',
    },
    recommendation: 'needs-decision', reason: 'Split: MultiPolygon to GeoPolygon is strictly better (frontend shows Unknown); "everything else is a point" is wrong. Suggested core rule: Point, Polygon, MultiPolygon supported, rest Unknown.',
  },
  {
    id: 'T-08', area: T,
    rule: 'int2 (smallint): MCP types it IntegerNumber (ForeignKeyName with an FK); frontend Unknown',
    frontend: 'int2 is not in any branch: Unknown (rendered as raw text, no number input or FK dropdown).',
    mcp: '`int2` is IntegerNumber, or ForeignKeyName with join info.',
    evidence: [`${SS}:673-681`, `${SC}:473-475`],
    checks: [{ file: SC, contains: ["case 'int2':"] }],
    probes: { 'int2 plain': 'Unknown', 'int2 fk': 'Unknown' },
    latent: 'no example has a smallint column',
    impact: {
      adoptFrontend: 'MCP loses typing for smallint columns (no FK name resolution).',
      adoptMcp: 'Generic app gains number inputs, validation and FK dropdowns for smallint columns.',
    },
    recommendation: 'adopt-mcp', reason: 'Strictly better: smallint is an integer; Unknown is a gap, not a choice.',
  },
  {
    id: 'T-09', area: T,
    rule: 'uuid outside the system tables: MCP types a uuid FK as ForeignKeyName and a plain uuid as TextShort; frontend Unknown',
    frontend: 'uuid is only typed for system-table FKs; any other uuid (plain or FK to an integrator table) is Unknown.',
    mcp: 'uuid with FK info is ForeignKeyName (embed `(id,display_name)`); a plain uuid is TextShort.',
    evidence: [`${SS}:648-691`, `${SC}:476-478`],
    checks: [{ file: SC, contains: ["case 'uuid':"] }],
    probes: { 'uuid plain': 'Unknown', 'uuid fk public non-system': 'Unknown' },
    impact: {
      adoptFrontend: 'MCP shows these columns untyped (it already renders unknowns as text, so output barely changes).',
      adoptMcp: 'Generic app renders plain uuids as short text and edits them in a free-text input: neighborhood-hub `mek_checkouts.checkout_photos` / `return_photos` (show_on_edit, today Unknown with no control) would get a free-text uuid field; uuid FKs to integrator tables would get FK dropdowns.',
    },
    recommendation: 'needs-decision', reason: 'Display improves, but a free-text uuid editor is worse than no control. Suggested core rule: plain uuid is a read-only short text; uuid FK to a table with display_name is ForeignKeyName (verify the FK editor handles uuid keys).',
  },
  {
    id: 'T-10', area: T,
    rule: 'bpchar (char(n)): MCP TextShort; frontend Unknown',
    frontend: 'Only `varchar` and `text` are text types; `bpchar` is Unknown.',
    mcp: '`bpchar` is TextShort.',
    evidence: [`${SS}:689-690`, `${SC}:480`],
    checks: [{ file: SC, contains: ["case 'bpchar': return EntityPropertyType.TextShort;"] }],
    probes: { bpchar: 'Unknown' },
    latent: 'no example has a char(n) column',
    impact: { adoptFrontend: 'MCP loses text typing for char(n).', adoptMcp: 'Generic app gets a text input and length validation for char(n) columns.' },
    recommendation: 'adopt-mcp', reason: 'Strictly better: char(n) is text.',
  },
  {
    id: 'T-11', area: T,
    rule: 'Unknown udt with FK info: MCP falls back to ForeignKeyName; frontend Unknown',
    frontend: 'FK typing only for int4/int8; a domain or citext FK is Unknown.',
    mcp: 'Step 6 fallback: any remaining property with join_table and join_column is ForeignKeyName.',
    evidence: [`${SS}:673`, `${SC}:484-485`],
    checks: [{ file: SC, contains: ['// 6. Fallback: if it has FK info, treat as foreign key'] }],
    probes: { 'citext fk (unknown udt)': 'Unknown' },
    latent: 'no example has an FK on a non-integer, non-uuid domain',
    impact: {
      adoptFrontend: 'MCP stops resolving display names for such FKs.',
      adoptMcp: 'Generic app offers FK dropdowns for text-keyed FKs; the edit control and embed must then use join_column as the key (see S-01).',
    },
    recommendation: 'needs-decision', reason: 'Better in principle, but depends on S-01 (embed by join_column) and on the FK editor supporting non-integer keys.',
  },
  {
    id: 'T-12', area: T,
    rule: 'Many-to-many: the MCP has no M:M detection or virtual properties',
    frontend: 'Detects junction tables and adds virtual ManyToMany properties (with parent hops and rich junction columns) to both sides of each relation; they appear in selects, views and edit forms.',
    mcp: 'No junction detection; M:M relations are invisible except as the junction table itself.',
    evidence: [`${SS}:1160-1388`, `${SC}:410-488`, `${FEG}/<variant>/schema.m2m.json`],
    checks: [{ file: SS, contains: ['enrichPropertiesWithManyToMany'] }],
    impact: {
      adoptFrontend: 'No generic-app change; MCP list/get output gains M:M columns (related display names) and M:M select embeds.',
      adoptMcp: 'Not viable: the generic app would lose every M:M editor.',
    },
    recommendation: 'adopt-frontend', reason: 'The core owns junction detection; the MCP gains M:M for free (it may still choose not to render them).',
  },

  // ---------------------------------------------------------------- selects
  {
    id: 'S-01', area: S,
    rule: 'FK embed column: frontend selects the referenced column (join_column); MCP always selects id',
    frontend: '`col:join_table!col(<join_column>,display_name)`; with join_column = display_name this yields `(display_name,display_name)`.',
    mcp: '`col:join_table!col(id,display_name)` regardless of join_column.',
    evidence: [`${SS}:752`, `${SB}:21-24`],
    checks: [{ file: SB, contains: ['return `${col}:${prop.join_table}!${col}(id,display_name)`;'] }],
    impact: {
      adoptFrontend: 'No generic-app change; the MCP stops requesting `id` from target tables that are referenced by another column (and may have no id).',
      adoptMcp: 'Generic app requests `id` instead of the referenced key; breaks FKs whose target key is not id.',
    },
    recommendation: 'adopt-frontend', reason: 'The embed must select the referenced key. The frontend\'s own duplicate `(display_name,display_name)` for FKs that reference display_name is a separate decision (S-07).',
  },
  {
    id: 'S-02', area: S,
    rule: 'FK to a non-public schema: frontend selects the plain column; MCP embeds',
    frontend: 'Only `join_schema = public` FKs are embedded; FKs into metadata (statuses / categories without an entity type, int civic_os_users) select the raw id.',
    mcp: 'Embeds `col:<join_table>!col(id,display_name)` for every FK, relying on a public view with the same name.',
    evidence: [`${SS}:752`, `${SB}:21-24`],
    checks: [{ file: SS, contains: ["(prop.join_schema == 'public' && prop.join_column)"] }],
    impact: {
      adoptFrontend: 'MCP shows raw ids for these columns instead of names.',
      adoptMcp: 'Generic app shows names for metadata FKs, provided a public view of the same name exists and exposes the FK relationship to PostgREST.',
    },
    recommendation: 'needs-decision', reason: 'The MCP output is more useful, but embedding through metadata views depends on PostgREST resolving the relationship through a view; verify on the instances below (P0.4 harness) before adopting. Evidence confidence 4/5: the golden stub cannot reject a select, so these goldens do not show whether PostgREST accepts the MCP embed.',
  },
  {
    id: 'S-03', area: S,
    rule: 'User embed: MCP omits phone and email',
    frontend: '`(id,display_name,full_name,phone,email)`.',
    mcp: '`(id,display_name,full_name)`.',
    evidence: [`${SS}:751`, `${SB}:26-27`, 'tools/mcp-server/src/formatters/value.ts:104-110', 'docs/notes/MCP_SERVER_DESIGN.md (FK Embedding Depth)'],
    checks: [{ file: SB, contains: ['return `${col}:civic_os_users!${col}(id,display_name,full_name)`;'] }],
    impact: {
      adoptFrontend: 'MCP requests phone/email (RLS still applies); its formatter already renders only display_name/full_name, so LLM output does not change.',
      adoptMcp: 'Generic app loses phone/email in user popovers.',
    },
    recommendation: 'adopt-frontend', reason: 'No evidence the slimmer shape is intentional: select-builder.ts says it "mirrors" the frontend, the design doc only sets embed depth, and the select has not changed since the MCP was added (09627bb). The formatter (value.ts formatUser) already trims to display_name, so data minimization toward the LLM is preserved by trimming there, not in the select.',
  },
  {
    id: 'S-04', area: S,
    rule: 'File embed: MCP selects 4 file fields, frontend 12',
    frontend: '`(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_*_key,thumbnail_status,thumbnail_error,created_at)`.',
    mcp: '`(id,file_name,file_type,file_size)`.',
    evidence: [`${SS}:717-719`, `${SB}:35-38`],
    checks: [{ file: SB, contains: ['(id,file_name,file_type,file_size)'] }],
    impact: { adoptFrontend: 'MCP fetches S3 keys it does not render (formatter shows file name / type).', adoptMcp: 'Generic app loses thumbnails and download links.' },
    recommendation: 'adopt-frontend', reason: 'One embed definition in the core; the MCP formatter keeps its compact rendering.',
  },
  {
    id: 'S-05', area: S,
    rule: 'Payment embed: MCP omits refund aggregates, error_message and created_at',
    frontend: '`(id,amount,currency,status,effective_status,total_refunded,refund_count,pending_refund_count,display_name,error_message,created_at)`.',
    mcp: '`(id,amount,currency,status,effective_status,display_name)`.',
    evidence: [`${SS}:724-726`, `${SB}:40-41`],
    checks: [{ file: SB, contains: ['(id,amount,currency,status,effective_status,display_name)'] }],
    impact: { adoptFrontend: 'MCP can report refunds and payment errors (currently invisible to the LLM).', adoptMcp: 'Generic app loses the refund tooltip and error display.' },
    recommendation: 'adopt-frontend', reason: 'Refund state is decision-relevant for an LLM answering payment questions.',
  },
  {
    id: 'S-06', area: S,
    rule: 'PhotoGallery: the MCP uses the list variant (file ids only) everywhere, including get_record',
    frontend: 'Detail/edit embed gallery files with captions and file metadata; list uses `(id,photo_gallery_files(file_id))`.',
    mcp: 'Always `(id,photo_gallery_files(file_id))`.',
    evidence: [`${SS}:740-742`, `${SS}:827-831`, `${SB}:43-45`],
    checks: [{ file: SB, contains: ['(id,photo_gallery_files(file_id))'] }],
    impact: { adoptFrontend: 'get_record could list photo captions / file names.', adoptMcp: 'Generic app detail pages could not show photos.' },
    recommendation: 'adopt-frontend', reason: 'The core exposes the context-specific variants; the MCP picks list for list_records and detail for get_record.',
  },
  {
    id: 'S-07', area: S,
    rule: 'Frontend FK embed selects display_name twice when the FK references display_name',
    frontend: '`col:join_table!col(<join_column>,display_name)` with join_column = display_name gives `(display_name,display_name)`: the embed carries no id.',
    mcp: 'Not affected by this quirk (always `(id,display_name)`, see S-01).',
    evidence: [`${SS}:752`, `${FEG}/staff-portal/<variant>/schema.properties.json`],
    checks: [{ file: SS, contains: ["'(' + prop.join_column + ',display_name)'"] }],
    compute: ({ hit, readJson, FE, examples, variants }) => {
      for (const ex of examples()) {
        for (const v of variants(ex)) {
          for (const [t, list] of Object.entries(readJson(path.join(FE, ex, v, 'schema.properties.json')).entities)) {
            for (const p of list) if (p.select.endsWith('(display_name,display_name)')) hit('S-07', { example: ex, variant: v, entity: t, subject: p.column, detail: p.select });
          }
        }
      }
    },
    impact: { adoptFrontend: 'n/a (frontend-only quirk).', adoptMcp: 'n/a' },
    recommendation: 'needs-decision', reason: 'Selecting `(display_name)` once (or the key plus display_name) changes the generic app\'s select string: an approved golden diff, not a silent fix inside the move. Decide together with S-01.',
  },

  // ---------------------------------------------------------------- views
  {
    id: 'V-01', area: V,
    rule: 'Create/edit views: the MCP does not exclude created_at / updated_at',
    frontend: 'getPropsForCreate/Edit drop `created_at` and `updated_at` explicitly.',
    mcp: '`filterProperties` only drops identity/generated columns and `show_on_create/edit = false`.',
    evidence: [`${SS}:888-897`, `${SB}:107-126`],
    checks: [{ file: SS, contains: ["if (p.column_name === 'created_at' || p.column_name === 'updated_at') {"] }],
    latent: 'every example hides or marks the timestamps non-updatable, so V-02 covers them',
    impact: { adoptFrontend: 'MCP describe/create guidance stops listing timestamps as writable.', adoptMcp: 'Generic forms would show timestamp inputs.' },
    recommendation: 'adopt-frontend', reason: 'Trigger-managed columns are never user input.',
  },
  {
    id: 'V-02', area: V,
    rule: 'Create/edit views: the MCP ignores is_updatable',
    frontend: 'Create/edit require `is_updatable`.',
    mcp: 'Non-updatable columns (views, computed columns) stay in the create/edit lists.',
    evidence: [`${SS}:895`, `${SB}:107-126`],
    checks: [{ file: SS, contains: ['p.is_updatable &&'] }],
    impact: { adoptFrontend: 'MCP stops presenting read-only columns as writable (fewer failed create/update calls).', adoptMcp: 'Generic forms would render read-only columns as inputs.' },
    recommendation: 'adopt-frontend', reason: 'is_updatable is the database\'s own answer.',
  },
  {
    id: 'V-03', area: V,
    rule: 'Structural columns (display_name, status_id, submitted_at): the frontend always adds them to list/detail/edit; the MCP does not',
    frontend: '`ensureStructuralProps` appends them when hidden, for page headers, map markers, calendars and guided forms.',
    mcp: 'Only visibility flags count.',
    evidence: [`${SS}:838-846`, `${SB}:107-126`],
    checks: [{ file: SS, contains: ["const structuralColumns = ['display_name', 'status_id', 'submitted_at'];"] }],
    impact: { adoptFrontend: 'MCP list/get output gains display_name (helps the LLM identify records) and status columns.', adoptMcp: 'Generic app loses page headers and status badges for entities that hide them.' },
    recommendation: 'adopt-frontend', reason: 'The core\'s fetch plan includes structural columns; the MCP renders them.',
  },
  {
    id: 'V-04', area: V,
    rule: 'List view: the frontend adds the map property when the entity shows a map; the MCP does not',
    frontend: '`getPropsForList` appends `map_property_name` when `show_map` is on.',
    mcp: 'Not considered.',
    evidence: [`${SS}:855-863`],
    checks: [{ file: SS, contains: ['if (table.show_map && table.map_property_name) {'] }],
    impact: { adoptFrontend: 'MCP list output gains a WKT column on map entities.', adoptMcp: 'Generic list maps lose their markers.' },
    recommendation: 'adopt-frontend', reason: 'Part of the core fetch plan; the MCP may drop the column when rendering.',
  },

  // ---------------------------------------------------------------- conditions
  {
    id: 'C-01', area: C, status: 'fixed-on-main', fixedIn: FIX,
    fix: 'The MCP `resolveFieldValue` unwraps the `.id` of an embedded object for a plain field, as the frontend does; every golden (condition, record) pair now gets the frontend result.',
    rule: 'Plain condition field on an FK-embedded value: the frontend compares its .id; the MCP compared the object',
    frontend: 'For a field without a dot, an embedded object with an `id` is replaced by its id before comparing.',
    mcp: 'Same since b3f2eeb8: a plain field holding an embedded object with an `id` resolves to that id.',
    evidence: [`${CE}:55-59`, `${EA}:335-342`, `${MCG}/<example>/_example/conditions.actions.json`],
    checks: [{ file: CE, contains: ["if (value !== null && typeof value === 'object' && 'id' in value) {"] }, { file: EA, contains: ['if (!field.includes(\'.\')) {', 'return (value as Record<string, unknown>).id;'] }],
    history: [{
      before: FIX,
      summary: '`resolveFieldValue` returned the object; `eq` then compared `{id:5,...} == 5` (false), `ne` was always true, `in` always false.',
      rule: 'Plain condition field on an FK-embedded value: the frontend compares its .id; the MCP compares the object',
      frontend: 'For a field without a dot, an embedded object with an `id` is replaced by its id before comparing.',
      mcp: '`resolveFieldValue` returns the object; `eq` then compares `{id:5,...} == 5` (false), `ne` is always true, `in` always false.',
      evidence: [`${CE}:55-59`, `${EA}:236-283`, `${EA}:68`, `${GR}:66`],
      anchors: [{ file: CE, contains: ['if (value !== null && typeof value === \'object\' && \'id\' in value) {'] }],
      instances: was(35, 34, 70, 105),
      recommendation: 'mcp-bug', reason: 'The MCP fetches records with FK embeds (`buildSelectString(allProperties)` in execute-action.ts:68 and get-record.ts:66) but evaluates plain fields without unwrapping, so status-id conditions never match. Confirmed end to end in A-01.',
    }],
    impact: { adoptFrontend: 'Fixes every action in A-01 for MCP users (done on main).', adoptMcp: 'Breaks the generic app\'s status-gated actions the same way.' },
    recommendation: 'mcp-bug', reason: 'The MCP fetches records with FK embeds (`buildSelectString(allProperties)` in execute-action.ts and get-record.ts) and evaluated plain fields without unwrapping, so status-id conditions never matched. Confirmed end to end in A-01; fixed on main, the golden pairs now agree.',
  },
  {
    id: 'C-02', area: C, status: 'fixed-on-main', fixedIn: FIX,
    fix: '`eq` / `ne` use strict `===` / `!==` in the MCP evaluator.',
    rule: 'Equality: the MCP used loose == / !=; the frontend strict === / !==',
    frontend: 'Strict equality.',
    mcp: 'Strict equality since b3f2eeb8.',
    evidence: [`${CE}:113`, `${EA}:313-314`, `${FEG}/_shared/conditions.matrix.json`, `${MCG}/_shared/mcp.conditions-extra.json`],
    checks: [{ file: EA, contains: ["case 'eq': return recordValue === value;", "case 'ne': return recordValue !== value;"], absent: ["case 'eq': return recordValue == value;", "case 'ne': return recordValue != value;"] }],
    history: [{
      before: FIX,
      summary: '`recordValue == value` ("5" equals 5, false equals 0, [1,2] equals "1,2").',
      rule: 'Equality: the MCP uses loose == / !=; the frontend strict === / !==',
      frontend: 'Strict equality.',
      mcp: '`recordValue == value` ("5" equals 5, false equals 0, [1,2] equals "1,2").',
      evidence: [`${CE}:113`, `${EA}:254-255`],
      anchors: [{ file: EA, contains: ['case \'eq\': return recordValue == value;'] }],
      instances: was(26, 25, 42, 68),
      recommendation: 'adopt-frontend', reason: 'PostgREST returns typed JSON; strict equality is predictable and the frontend behavior is what integrators test against.',
    }],
    impact: { adoptFrontend: 'MCP stops matching string-typed values against numeric conditions (and vice versa).', adoptMcp: 'Generic app would match "5" against 5, hiding type mismatches in metadata.' },
    recommendation: 'adopt-frontend', reason: 'PostgREST returns typed JSON; strict equality is predictable and the frontend behavior is what integrators test against.',
  },
  {
    id: 'C-03', area: C, status: 'fixed-on-main', fixedIn: FIX,
    fix: '`gt` / `lt` / `gte` / `lte` require numbers on both sides in the MCP evaluator.',
    rule: 'Ordering operators: the MCP had no numeric guard',
    frontend: '`gt/lt/gte/lte` are false unless both sides are numbers.',
    mcp: 'Same numeric guard since b3f2eeb8.',
    evidence: [`${CE}:118-136`, `${EA}:315-318`, `${FEG}/_shared/conditions.matrix.json`],
    checks: [{ file: CE, contains: ["typeof fieldValue === 'number' &&"] }, { file: EA, contains: ["case 'gt': return typeof recordValue === 'number' && typeof value === 'number' && recordValue > value;"], absent: ['(recordValue as number) > (value as number)'] }],
    latent: 'no example action uses gt/lt/gte/lte; the synthetic matrix agrees on every cell since b3f2eeb8',
    history: [{
      before: FIX,
      summary: 'Applied `>`/`<` to whatever was there (string comparison, null coerced to 0).',
      rule: 'Ordering operators: the MCP has no numeric guard',
      frontend: '`gt/lt/gte/lte` are false unless both sides are numbers.',
      mcp: 'Applies `>`/`<` to whatever is there (string comparison, null coerced to 0).',
      evidence: [`${CE}:118-136`, `${EA}:256-259`],
      latent: 'no example action uses gt/lt/gte/lte; shown by the synthetic matrix',
      anchors: [{ file: CE, contains: ['typeof fieldValue === \'number\' &&'] }],
      instances: was(0, 0, 226, 226),
      recommendation: 'adopt-frontend', reason: 'Numeric operators on non-numbers are a metadata error; failing closed is safer.',
    }],
    impact: { adoptFrontend: 'MCP stops enabling actions on string comparisons such as "a" > "1".', adoptMcp: 'Generic app would compare strings lexically.' },
    recommendation: 'adopt-frontend', reason: 'Numeric operators on non-numbers are a metadata error; failing closed is safer.',
  },
  {
    id: 'C-04', area: C, status: 'fixed-on-main', fixedIn: FIX,
    fix: 'An unknown operator fails closed (`default: return false`) in the MCP evaluator.',
    rule: 'Unknown operator: the MCP returned true (fail open); the frontend false',
    frontend: 'Warns and returns false.',
    mcp: 'Returns false since b3f2eeb8.',
    evidence: [`${CE}:147-151`, `${EA}:322-324`, `${FEG}/_shared/conditions.matrix.json`],
    checks: [{ file: EA, contains: ['    default: return false;\n  }\n}'], absent: ['default: return true;'] }],
    latent: 'no example uses an unsupported operator; the synthetic matrix (between, EQ, empty) agrees since b3f2eeb8',
    history: [{
      before: FIX,
      summary: '`default: return true`.',
      rule: 'Unknown operator: the MCP returns true (fail open); the frontend false',
      frontend: 'Warns and returns false.',
      mcp: '`default: return true`.',
      evidence: [`${CE}:147-151`, `${EA}:263`],
      latent: 'no example uses an unsupported operator; shown by the synthetic matrix (between, EQ, empty)',
      anchors: [{ file: EA, contains: ['default: return true;'] }],
      instances: was(0, 0, 561, 561),
      recommendation: 'mcp-bug', reason: 'Fail-open on an unknown operator exposes actions the integrator meant to gate.',
    }],
    impact: { adoptFrontend: 'MCP stops showing/enabling actions whose condition it cannot evaluate.', adoptMcp: 'Generic app would expose actions on typos in operator names.' },
    recommendation: 'mcp-bug', reason: 'Fail-open on an unknown operator exposes actions the integrator meant to gate.',
  },
  {
    id: 'C-05', area: C, status: 'fixed-on-main', fixedIn: FIX,
    fix: 'The MCP evaluator returns false without a record, and execute_action refuses an action whose record cannot be loaded instead of calling the RPC unchecked.',
    rule: 'Missing record (null/undefined): the frontend returns false; the MCP evaluated every field as undefined',
    frontend: '`if (!data) return false`.',
    mcp: 'Same guard since b3f2eeb8; execute_action returns a tool error, without calling the RPC, when the condition fetch fails or finds no row. No golden reaches that path (the golden stub always serves the row), so the ledger runs the real execute-action.ts in-process (`probeExecuteAction` in ledger.mjs) and checks both refusals against the model; the anchors hold each refusal block, return included.',
    evidence: [`${CE}:88-90`, `${EA}:68-106`, `${EA}:291`, 'scripts/golden/ledger.mjs probeExecuteAction / executeActionProbeEngine'],
    checks: [
      { file: CE, contains: ['if (!data) {'] },
      {
        file: EA,
        contains: [
          'if (!record) return false;',
          // The two refusals themselves, each with its return, not only their message text.
          '          if (err instanceof PostgRESTRequestError) {\n            return {\n              content: [{\n                type: \'text\' as const,\n                text: `Could not load ${resolved.display_name} #${id} to check whether "${actionConfig.display_name}" is allowed: ` +\n                  err.toHumanMessage(cache.constraintMessages),\n              }],\n              isError: true,\n            };\n          }\n          throw err;\n        }',
          '        if (!currentRecord) {\n          return {\n            content: [{\n              type: \'text\' as const,\n              text: `Record #${id} not found in ${resolved.display_name} (or you cannot read it), ` +\n                `so the conditions for "${actionConfig.display_name}" cannot be checked.`,\n            }],\n            isError: true,\n          };\n        }',
        ],
        absent: ["// If we can't fetch the record, proceed"],
      },
    ],
    history: [{
      before: FIX,
      summary: 'No guard: `ne`, `is_null` and OR-branches could pass with no record; execute_action also skipped conditions entirely when the record fetch failed.',
      rule: 'Missing record (null/undefined): the frontend returns false; the MCP evaluates every field as undefined',
      frontend: '`if (!data) return false`.',
      mcp: 'No guard: `ne`, `is_null` and OR-branches can pass with no record; execute_action also skips conditions entirely when the record fetch fails.',
      evidence: [`${CE}:88-90`, `${EA}:62-76`],
      anchors: [{ file: CE, contains: ['if (!data) {'] }],
      instances: was(18, 9, 0, 18),
      recommendation: 'adopt-frontend', reason: 'Fail closed. The MCP should also stop proceeding to the RPC when the condition fetch fails (execute-action.ts:65-75 swallows the error).',
    }],
    impact: { adoptFrontend: 'MCP blocks actions it cannot verify.', adoptMcp: 'Generic app would show `ne` actions before the record loads.' },
    recommendation: 'adopt-frontend', reason: 'Fail closed. Done on main, including refusing the action when the condition fetch fails (before b3f2eeb8 execute-action.ts swallowed the error and called the RPC).',
  },
  {
    id: 'C-06', area: C, status: 'changed-on-main', fixedIn: FIX,
    fix: 'A missing (null / undefined) condition is now true on both sides, and the MCP evaluator no longer throws on any input. In place of the old divergence: the MCP returns false for a malformed condition, where the frontend throws or treats a malformed entry as no condition.',
    rule: 'Malformed condition (a scalar, a non-object entry inside `or` / `and`, a condition without a string field): the MCP fails closed; the frontend throws or treats the entry as no condition',
    frontend: '`if (!condition) return true`; `\'or\' in c` throws a TypeError on a scalar condition (`"x"`, `5`, `true`); a null or other falsy entry inside `or` / `and` is a missing condition, so `{or: [null]}` is true; a non-array `or` / `and` or a condition without a field reaches `field.includes(\'.\')`, which throws.',
    mcp: 'Since b3f2eeb8 evaluateCondition is total: a scalar condition, a non-object compound entry and a condition whose field is not a string are false (`{or: [null]}` cannot enable an action); list_actions describes them as never true.',
    evidence: [`${CE}:41-99`, `${EA}:283-326`, 'tools/mcp-server/src/tools/list-actions.ts:114-138'],
    checks: [
      { file: EA, contains: ["if (typeof condition !== 'object') return false;", 'return condition.or.some(c => isConditionObject(c) && evaluateCondition(c, record));', "if (typeof field !== 'string') return false;"], absent: ["if ('or' in condition) {"] },
      { file: CE, contains: ['return condition.or.some(sub => evaluateCondition(sub, data));', "if (field.includes('.')) {"] },
    ],
    unit: 'one instance is a (condition, record) pair, or an action case, whose condition is malformed (`isMalformedCondition` in ledger-models.mjs); a difference on a well-formed condition is never counted here and fails the run.',
    latent: 'no golden input is malformed, since the compound cases are well formed or null; the MCP side is anchored by the code and its unit tests in execute-action.test.ts and list-actions.test.ts, the frontend side by the transcription in ledger-models.mjs',
    history: [{
      before: FIX,
      summary: '`\'or\' in condition` threw a TypeError on null/undefined, and `condition.or.some` / `condition.and.every` threw on a non-array value; callers guarded only against a missing condition (`if (action.visibility_condition)`).',
      rule: 'Missing or malformed condition: the frontend returns true (null/undefined) or treats a non-array `or` / `and` as a simple condition; the MCP throws',
      frontend: '`if (!condition) return true`; `or` / `and` count as compounds only when they are arrays (`\'or\' in c && Array.isArray(c.or)`), so `{or: \'x\'}` or `{and: 5}` is evaluated as a simple condition.',
      mcp: '`\'or\' in condition` throws a TypeError on null/undefined, and `condition.or.some` / `condition.and.every` throw on a non-array value; callers guard only against a missing condition (`if (action.visibility_condition)`).',
      evidence: [`${CE}:83-86`, `${EA}:240`],
      latent: 'unreachable through current MCP callers; shown by the synthetic compound cases',
      anchors: [{ file: EA, contains: ['if (\'or\' in condition) {'] }],
      instances: was(0, 0, 2, 2, 'latent: unreachable through the MCP callers; shown by the synthetic compound cases'),
      recommendation: 'adopt-frontend', reason: 'A total function is the right core contract.',
    }],
    impact: { adoptFrontend: 'MCP would throw again (or let `{or: [null]}` enable an action) on malformed metadata; no golden output changes.', adoptMcp: 'The core evaluator is total and fails closed; the generic app stops throwing on malformed conditions and `{or: [null]}` stops counting as true.' },
    recommendation: 'adopt-mcp', reason: 'Strictly better: a total function that fails closed is the right core contract, and the frontend throws or fails open on the same inputs. Latent: no example has a malformed condition. Recommendation changed with the row (it was adopt-frontend when the MCP was the side that threw).',
  },

  // ---------------------------------------------------------------- actions
  {
    id: 'A-01', area: A, status: 'fixed-on-main', fixedIn: FIX,
    fix: 'Consequence of the C-01 fix: with `.id` unwrapping, every conditional action case in the examples gets the outcome the frontend evaluator gives (computed below).',
    rule: 'Status-gated actions were wrongly refused or wrongly listed through the MCP (none was wrongly executed)',
    frontend: 'Detail page evaluates conditions with .id extraction against its embedded record; actions behave as configured.',
    mcp: 'Since b3f2eeb8 execute_action and get_record evaluate the embedded record the way the frontend does, so status-gated actions run and are listed in the configured states. Evidence confidence 4/5: the golden stub cannot reject a select, so the record shape is the one the MCP\'s select requests (one embed per FK), not one PostgREST returned.',
    evidence: [`${MCG}/<example>/_example/mcp.actions-execute.json`, `${EA}:68-134`, `${GR}:96-123`, 'stub limit: tests/golden/derived/mcp/COVERAGE.md'],
    checks: [{ file: EA, contains: ['return (value as Record<string, unknown>).id;'] }],
    history: [{
      before: FIX,
      summary: 'With the record the MCP fetched (Status/FK columns embedded), `status_id eq 5` never held, so execute_action refused the action (disabled / not available) and get_record hid or greyed it; `status_id ne 6` always held, so an action stayed listed in the wrong state, but its `eq` enabled condition still refused it.',
      rule: 'Status-gated actions are wrongly refused or wrongly listed through the MCP (none is wrongly executed)',
      frontend: 'Detail page evaluates conditions with .id extraction against its embedded record; actions behave as configured.',
      mcp: 'With the record the MCP fetches (Status/FK columns embedded), `status_id eq 5` never holds, so execute_action refuses the action (disabled / not available) and get_record hides or greys it; `status_id ne 6` always holds, so an action stays listed in the wrong state, but its `eq` enabled condition still refuses it. Evidence confidence 4/5: the golden stub cannot reject a select, so the record shape is the one the MCP\'s select requests (one embed per FK), not one PostgREST returned.',
      evidence: [`${MCG}/<example>/_example/mcp.actions-execute.json`, `${EA}:62-110`, `${GR}:96-123`, 'stub limit: tests/golden/derived/mcp/COVERAGE.md'],
      anchors: [],
      instances: was(29, 8, 2, 40, '38 (action, case) pairs disagreed, none wrongly executed'),
      recommendation: 'mcp-bug', reason: 'Consequence of C-01 (and of embedding every FK in the condition fetch). Highest user impact of the ledger: core workflow actions cannot be run through the MCP in community-center, mottpark, neighborhood-hub and staff-portal.',
    }],
    impact: { adoptFrontend: 'MCP users can run approve/deny/cancel/check-out actions again, and get_record lists them in the right states.', adoptMcp: 'n/a' },
    recommendation: 'mcp-bug', reason: 'Consequence of C-01 (and of embedding every FK in the condition fetch). Highest user impact of the ledger: core workflow actions could not be run through the MCP in community-center, mottpark, neighborhood-hub and staff-portal. Fixed on main.',
  },
  {
    id: 'A-02', area: A,
    rule: 'Actions defined on civic_os_users (shown on the profile page) are unreachable through the MCP',
    frontend: '`ProfilePage` renders `<app-entity-action-panel tableName="civic_os_users">`, so these actions run from the profile page.',
    mcp: '`resolveEntity` only knows schema_entities, which does not list civic_os_users, so execute_action / get_record fail with "Entity not found".',
    evidence: ['src/app/pages/profile/profile.page.html:28-33', `${NR}:38-91`, `${MCG}/client-intake/_example/mcp.actions-execute.json`],
    checks: [{ file: 'src/app/pages/profile/profile.page.html', contains: ['tableName="civic_os_users"'] }],
    impact: { adoptFrontend: 'MCP would need a user-scoped entry point (e.g. resolve civic_os_users as a system entity).', adoptMcp: 'n/a' },
    recommendation: 'needs-decision', reason: 'Not an interpretation difference: decide whether the MCP should expose profile actions at all.',
  },
  {
    id: 'A-03', area: A, status: 'fixed-on-main', fixedIn: FIX,
    fix: 'get_status_workflow reads transitions per entity type through `rpc/get_status_transitions_for_entity`, the RPC the frontend uses; the schema cache no longer fetches the view. Judged from code only: no MCP golden runs get_status_workflow (the MCP unit tests in get-status-workflow.test.ts cover the RPC path).',
    rule: 'Status transitions: the MCP read a status_transitions view that does not exist',
    frontend: 'Admin and workflow UIs read transitions through `rpc/get_status_transitions_for_entity`.',
    mcp: 'Since b3f2eeb8 get_status_workflow POSTs `rpc/get_status_transitions_for_entity` with `p_entity_type`, lists the enabled transitions, says so when every configured transition is disabled, and reports "could not be loaded" instead of "no restrictions" when the call fails.',
    evidence: [`${GSW}:17-36`, `${GSW}:100-150`, 'src/app/services/status-admin.service.ts:152', 'tests/golden/raw/<example>/<role>/rpc.get_status_transitions_for_entity.<entity_type>.json'],
    unit: 'one instance would be an entity type whose transitions the RPC returns while the MCP sees none; none remain.',
    checks: [
      { file: GSW, contains: ["'rpc/get_status_transitions_for_entity',", '{ p_entity_type: entityType },'] },
      { file: SC, absent: ["this.client.get<StatusTransition[]>('status_transitions')", 'getTransitions('] },
      { file: 'src/app/services/status-admin.service.ts', contains: ["'rpc/get_status_transitions_for_entity'"] },
    ],
    history: [{
      before: FIX,
      summary: '`fetchTransitions` GETs `status_transitions` (404 PGRST205 in every example), swallowed the error and used an empty list, so get_status_workflow reported no transition restrictions.',
      rule: 'Status transitions: the MCP reads a status_transitions view that does not exist',
      frontend: 'Admin and workflow UIs read transitions through `rpc/get_status_transitions_for_entity`.',
      mcp: '`fetchTransitions` GETs `status_transitions` (404 PGRST205 in every example), swallows the error and uses an empty list, so get_status_workflow reports no transition restrictions.',
      evidence: [`${SC}:299-307`, 'src/app/services/status-admin.service.ts:152', 'tests/golden/raw/<example>/<role>/status_transitions.json', 'tests/golden/raw/<example>/<role>/rpc.get_status_transitions_for_entity.<entity_type>.json', `${GSW}:58`],
      unit: 'one instance is an entity type whose transitions the RPC returns while the MCP sees none.',
      anchors: [{ file: SC, contains: ['this.client.get<StatusTransition[]>(\'status_transitions\')'] }, { file: 'src/app/services/status-admin.service.ts', contains: ['\'rpc/get_status_transitions_for_entity\''] }],
      instances: was(13, 13, 0, 13, '43 transitions in 4 examples'),
      recommendation: 'mcp-bug', reason: 'The MCP should call the same RPC as the frontend (the core\'s status client).',
    }],
    compute: ({ miss, note, readJson, RAW, examples }) => {
      const ROLES = ['anon', 'testuser', 'testeditor', 'testmanager', 'testadmin'];
      let total = 0;
      const withTransitions = [];
      for (const ex of examples()) {
        const counts = new Map();
        for (const role of ROLES) {
          const dir = path.join(RAW, ex, role);
          const view = readJson(path.join(dir, 'status_transitions.json'));
          if (!(view && view.__status === 404)) miss('transitions', { example: ex, variant: role, detail: 'status_transitions view no longer 404' });
          for (const f of fs.readdirSync(dir).filter(x => x.startsWith('rpc.get_status_transitions_for_entity.')).sort()) {
            const type = f.slice('rpc.get_status_transitions_for_entity.'.length, -'.json'.length);
            const rows = readJson(path.join(dir, f));
            if (!Array.isArray(rows)) { miss('transitions', { example: ex, variant: role, subject: type, detail: 'RPC fixture is not a list' }); continue; }
            counts.set(type, [...(counts.get(type) ?? []), rows.length]);
          }
        }
        let exTotal = 0;
        for (const [type, perRole] of counts) {
          if (perRole.length !== ROLES.length || new Set(perRole).size !== 1) { miss('transitions', { example: ex, subject: type, detail: `transition count varies by role: ${perRole.join(',')}` }); continue; }
          if (perRole[0] === 0) continue;
          exTotal += perRole[0];
        }
        if (exTotal) { total += exTotal; withTransitions.push(`${ex} ${exTotal}`); }
      }
      note('A-03', `${total} transitions in ${withTransitions.length} examples (${withTransitions.join(', ')}), identical for all five roles, which the MCP now reads through the same RPC as the frontend; the other examples (pothole included) define none. The status_transitions view is still 404 in every raw fixture; nothing reads it any more.`);
    },
    impact: { adoptFrontend: 'MCP reports the real allowed transitions and on-transition RPCs (done on main).', adoptMcp: 'n/a' },
    recommendation: 'mcp-bug', reason: 'The MCP should call the same RPC as the frontend (the core\'s status client). Fixed on main.',
  },

  // ---------------------------------------------------------------- errors
  {
    id: 'E-01', area: E,
    rule: 'Different wording for errors both sides recognize (42501, 23505, 401, 404)',
    frontend: 'Short UI strings: "Permissions error", "Record must be unique", "Resource not found", "Your session has expired. Please refresh the page to log in again."',
    mcp: 'LLM-oriented sentences: "Permission denied. You do not have access to perform this action.", "A record with these values already exists (duplicate).", "Record not found.", "Authentication required. Your session may have expired."',
    evidence: [`${ES}:106-126`, `${PC}:207-258`],
    checks: [{ file: ES, contains: ['return "Permissions error";'] }, { file: PC, contains: ["return 'Permission denied. You do not have access to perform this action.';"] }],
    impact: { adoptFrontend: 'MCP messages get terser and lose action hints for the LLM.', adoptMcp: 'Generic app messages change wording (user-visible, untranslated today).' },
    recommendation: 'needs-decision', reason: 'Suggested: the core returns an error kind plus parameters (code, constraint, column); each consumer owns its wording (the frontend through i18n keys).',
  },
  {
    id: 'E-03', area: E,
    rule: 'Constraint violations without a configured message: different fallback text',
    frontend: '"Validation failed: <constraint_name>" (23514, name found), "Validation failed" (no name), "This conflicts with an existing record. Please check your input and try again." (23P01, name found), "This conflicts with an existing record." (23P01 without a name, and parseToHuman without lookup).',
    mcp: '"Invalid <constraint name without _check, underscores as spaces>. Check the value and try again." (23514; "Invalid check constraint. ..." without a name); 23P01 always gets the long sentence. The no-lookup call differs the same way.',
    evidence: [`${ES}:61-95`, `${PC}:208-224`],
    checks: [{ file: ES, contains: ['return `Validation failed: ${constraintName}`;'] }, { file: PC, contains: [".replace(/_check$/, '')"] }],
    impact: { adoptFrontend: 'MCP shows raw constraint names to the LLM.', adoptMcp: 'Generic app shows humanized constraint names instead of raw ones.' },
    recommendation: 'needs-decision', reason: 'Lookups that hit constraint_messages agree on both sides; only the miss path differs. The MCP humanization is friendlier; decide as part of E-01.',
  },
  {
    id: 'E-04', area: E,
    rule: 'Unrecognized error: frontend "System Error"; MCP "Error: <raw message>"',
    frontend: 'Generic "System Error".',
    mcp: 'Returns the PostgREST message verbatim, prefixed with "Error: ".',
    evidence: [`${ES}:125`, `${PC}:257`],
    checks: [{ file: PC, contains: ['return `Error: ${this.message}`;'] }],
    impact: { adoptFrontend: 'LLM loses the raw database message it can often act on.', adoptMcp: 'Generic app shows raw database text (may expose SQL details) to end users.' },
    recommendation: 'needs-decision', reason: 'Raw text is useful to an LLM and risky in a UI; keep it a per-consumer choice over a shared error kind.',
  },
  {
    id: 'E-06', area: E,
    rule: 'Error body without a message: different fallback for the raw message',
    frontend: 'Uses the HTTP status text ("Bad Request", "Unknown Error").',
    mcp: '"PostgREST returned <status>"; network failure: "Network error: unable to reach PostgREST...".',
    evidence: [`${DS}:662-700`, `${PC}:110-147`],
    checks: [{ file: PC, contains: ['errorBody?.message ?? `PostgREST returned ${response.status}`'] }],
    impact: { adoptFrontend: 'Cosmetic for the MCP.', adoptMcp: 'Cosmetic for the frontend (only surfaces through E-04 / logs).' },
    recommendation: 'needs-decision', reason: 'Cosmetic; settle together with E-01.',
  },

  // ---------------------------------------------------------------- requests
  {
    id: 'Q-01', area: Q,
    rule: 'Default order: the MCP always orders (display_name, else id, else first column); the frontend sends no order',
    frontend: 'Without a user sort, list and inverse queries have no `order`, so PostgREST returns rows in plan order and pagination is not stable.',
    mcp: '`order=display_name.asc`, else `id.asc`, else the first property.',
    evidence: [`${DS}:52-54`, `${LR}:234-249`],
    checks: [{ file: LR, contains: ["params['order'] = 'display_name.asc';"] }],
    impact: { adoptFrontend: 'MCP pages become unstable across calls.', adoptMcp: 'Generic list pages get a deterministic default order (display_name), which changes what users see first.' },
    recommendation: 'adopt-mcp', reason: 'Strictly better: paging without ORDER BY can skip or repeat rows. Neither side adds an `id` tie-breaker today (the MCP orders by display_name alone, so duplicate names still page unstably); the core should append `,id.asc` to every default and user order.',
  },
  {
    id: 'Q-02', area: Q,
    rule: 'Pagination transport: the MCP always sends Range (default 0-24) and Prefer count=exact; the frontend only for paginated calls and uses `limit=` otherwise',
    frontend: 'getData sends no Range; `limit` becomes `limit=N`. getDataPaginated sends Range + Prefer.',
    mcp: 'Every list_records call sends `Range: offset-(offset+limit-1)`, `Range-Unit: items`, `Prefer: count=exact`; never `limit=`.',
    evidence: [`${DS}:71-73`, `${DS}:136-143`, `${LR}:251-260`],
    checks: [{ file: LR, contains: ["'Prefer': 'count=exact',"] }],
    impact: { adoptFrontend: 'MCP could issue unbounded reads.', adoptMcp: 'Generic app adds a count(*) to every read (cost on large tables).' },
    recommendation: 'needs-decision', reason: 'Transport policy, not semantics: the core query object carries limit/offset and each transport chooses Range vs limit; count=exact only when the caller needs a total.',
  },
  {
    id: 'Q-03', area: Q,
    rule: 'id placement in the select: frontend appends `,id`; MCP prepends `id,`',
    frontend: 'Pushes `id` to the end of the field list (unless already present or a summary view).',
    mcp: '`buildSelectString` starts with `id` when the entity has one; list_records prepends `id,` when the display columns lack it.',
    evidence: [`${DS}:43-45`, `${SB}:72-77`, `${LR}:77-81`],
    checks: [{ file: DS, contains: ["query.fields.push('id');"] }],
    impact: { adoptFrontend: 'Select order changes for the MCP (no semantic effect).', adoptMcp: 'Same for the frontend.' },
    recommendation: 'adopt-frontend', reason: 'Semantically equivalent; pick the frontend order so the request-equivalence harness stays byte-equal.',
  },
  {
    id: 'Q-11', area: Q,
    rule: 'id inclusion: the frontend appends id unless the entity is a summary view (is_view and no insert); the MCP only when the entity has an id column',
    frontend: 'Junction tables (composite keys) and updatable views without id still get `id` appended, which PostgREST rejects. Summary views (is_view and no insert) are exempt only when the caller passes isSummaryView; the real list page does (list.page.ts:338), so FE-only ids on summary views come from the golden harness\'s other queries and are reported as harness-only.',
    mcp: 'Checks the properties for `id` / identity.',
    evidence: [`${DS}:43-45`, `${SB}:72-77`],
    checks: [{ file: DS, contains: ['if(!query.isSummaryView && !query.fields.includes(\'id\')) {'] }],
    impact: { adoptFrontend: 'MCP requests id on tables that have none (errors on junction tables).', adoptMcp: 'Generic app stops requesting a nonexistent id on junction tables and id-less views.' },
    recommendation: 'adopt-mcp', reason: 'Strictly better: derive id inclusion from the schema, not from an is_view/insert proxy.',
  },
  {
    id: 'Q-04', area: Q,
    rule: 'Sorting by an FK: the frontend orders by the embedded display_name; the MCP only by the raw column',
    frontend: '`order=col(display_name).asc` for FK/User/Status/Category columns.',
    mcp: 'Sort must resolve to a column; `owner(display_name)` is rejected, so FK sorts are by id.',
    evidence: ['src/app/pages/list/list.page.ts:859', `${LR}:230-233`],
    checks: [{ file: LR, contains: ["params['order'] = `${sortProp.column_name}.${descending ? 'desc' : 'asc'}`;"] }],
    impact: { adoptFrontend: 'MCP sorts FK columns alphabetically by name (what an LLM asked to "sort by client" expects).', adoptMcp: 'Generic app sorts FK columns by id.' },
    recommendation: 'adopt-frontend', reason: 'Name order is the expected meaning of sorting by a reference column.',
  },
  {
    id: 'Q-05', area: Q,
    rule: 'Search mapping: frontend legacy `civic_os_text_search=wfts.` (or hybrid `or=(...)`); MCP `<fulltext_search_column>=wfts(simple).`, else substring ilike, else display_name ilike',
    frontend: 'DataService searchQuery always targets `civic_os_text_search` with `wfts` and the server\'s default text-search config; the list page instead sends hybrid `or=(fts.wfts.x,col.ilike.*x*)` built from the entity config, URL-encoded.',
    mcp: 'Uses `fulltext_search_column` with `wfts(simple)`; else `substring_search_column` ilike; else falls back to `display_name=ilike.*term*` even when the entity has no such search configured. The term is not trimmed or escaped.',
    evidence: [`${DS}:49-51`, 'src/app/utils/search.utils.ts:20-45', `${LR}:218-227`],
    checks: [{ file: LR, contains: ['`wfts(simple).${search}`'] }, { file: DS, contains: ["'civic_os_text_search=wfts.' + encodeURIComponent"] }],
    impact: { adoptFrontend: 'MCP search uses the hybrid fts+substring strategy the list page uses.', adoptMcp: 'Generic app switches to the simple config (no stemming) and loses hybrid OR search.' },
    recommendation: 'needs-decision', reason: 'Pick one search builder for the core (the hybrid one is the newest). Verify against a live instance whether `wfts.` (default config) and `wfts(simple).` return the same rows for the simple-config tsvectors; if not, the frontend legacy path is a bug.',
  },
  {
    id: 'Q-06', area: Q,
    rule: 'Searching with a sort: the frontend drops the sort; the MCP keeps it',
    frontend: 'DataService does not send `order` when searchQuery is set, and ListPage clears orderField / orderDirection whenever any search is active, legacy or hybrid (list.page.ts:333-334).',
    mcp: 'Search and sort are independent.',
    evidence: [`${DS}:49-54`, `${LR}:218-249`],
    checks: [{ file: DS, contains: ["args.push('civic_os_text_search=wfts.'"] }],
    impact: { adoptFrontend: 'MCP search results lose the requested order.', adoptMcp: 'Generic app keeps the user\'s sort while searching.' },
    recommendation: 'adopt-mcp', reason: 'Dropping an explicit sort is surprising; `wfts` does not rank results, so there is no relevance order to preserve. Adopting it in the core alone changes nothing for the generic app: ListPage must also stop clearing the sort during search (list.page.ts:333-334).',
  },
  {
    id: 'Q-07', area: Q,
    rule: 'Blank or padded search terms: the frontend trims and skips blank terms; the MCP sends them as-is',
    frontend: '`searchQuery.trim()`; blank terms send no search parameter.',
    mcp: 'Sends `wfts(simple).   ` or `ilike.*   *`, matching only values containing the spaces.',
    evidence: [`${DS}:49-51`, `${LR}:218-227`],
    checks: [{ file: LR, contains: ['if (search && resolved.fulltext_search_column) {'] }],
    impact: { adoptFrontend: 'MCP ignores empty searches instead of returning nothing.', adoptMcp: 'n/a' },
    recommendation: 'mcp-bug', reason: 'A whitespace-only search should mean "no search".',
  },
  {
    id: 'Q-08', area: Q,
    rule: 'Empty / null filter values: the frontend skips them; the MCP sends or resolves them',
    frontend: 'Filters whose value is `\'\'`, null or undefined are dropped.',
    mcp: 'Sends `eq.` and `eq.null` for scalar columns; for FK / Status / Category columns tries to resolve `""` as a display name and fails the whole call.',
    evidence: [`${DS}:61`, `${LR}:112-193`],
    checks: [{ file: DS, contains: ["filter.value !== null && filter.value !== undefined && filter.value !== ''"] }],
    impact: { adoptFrontend: 'MCP ignores empty filter values (an LLM wanting IS NULL must use the `is` operator).', adoptMcp: 'Generic app would filter on empty strings.' },
    recommendation: 'needs-decision', reason: 'For the MCP an explicit null is arguably intentional; suggested core rule: null maps to `is.null`, empty string is dropped.',
  },
  {
    id: 'Q-09', area: Q,
    rule: 'Several filters on one column: the MCP groups them into `and=(...)`; the frontend repeats the parameter',
    frontend: '`col=gte.a&col=lt.b`.',
    mcp: '`and=(col.gte.a,col.lt.b)`.',
    evidence: [`${DS}:59-69`, `${LR}:195-214`, 'docs/notes/MCP_SERVER_DESIGN.md (Same-Column Multi-Condition Filters)'],
    checks: [{ file: LR, contains: ["params['and'] = `(${andClauses.join(',')})`;"] }],
    impact: { adoptFrontend: 'Equivalent for PostgREST; changes MCP URLs only.', adoptMcp: 'Equivalent; changes frontend URLs only.' },
    recommendation: 'needs-decision', reason: 'Both are valid PostgREST; the MCP needed `and=()` only because its params are a Record. Pick one canonical form for byte equality.',
  },
  {
    id: 'Q-10', area: Q,
    rule: 'Limit bounds: list_records accepts limit 1..100 and offset >= 0; the frontend accepts anything',
    frontend: 'No bounds (see F-02 for negative ranges); calendar range fetches use page size 1000.',
    mcp: 'Zod rejects limit 0, limit > 100 and negative offsets before any request.',
    evidence: [`${LR}:51-56`, 'src/app/pages/list/list.page.ts:~297'],
    checks: [{ file: LR, contains: ['z.number().int().min(1).max(100)'] }],
    impact: { adoptFrontend: 'MCP could request 1000-row pages.', adoptMcp: 'Generic app gets input validation (fixes F-02) but calendar views need a higher cap.' },
    recommendation: 'needs-decision', reason: 'Validation belongs in the core query builder; the maximum page size is consumer policy (MCP 100 for token economy, app 1000 for calendars).',
  },
  {
    id: 'Q-12', area: Q,
    unit: 'one instance is one (query, missing timestamp column) pair; the entity count is the number of distinct entities affected.',
    status: 'fixed-on-main', fixedIn: FIX,
    fix: '`buildSelectString` adds created_at / updated_at only when the entity has the column; every get_record select in the goldens now names existing columns only.',
    rule: 'get_record always selected created_at and updated_at, even on entities without those columns',
    frontend: 'Detail selects only existing properties.',
    mcp: 'Since b3f2eeb8 `includeTimestamps` adds a timestamp only when the entity has it (get_record still passes the option).',
    evidence: [`${GR}:66`, `${SB}:85-91`, `${MCG}/<example>/_example/data.queries.json`],
    checks: [
      { file: GR, contains: ['buildSelectString(allProperties, { includeTimestamps: true })'] },
      { file: SB, contains: ['if (properties.some(p => p.column_name === ts)) fields.add(ts);'], absent: ["fields.add('created_at');", "fields.add('updated_at');"] },
    ],
    history: [{
      before: FIX,
      summary: '`buildSelectString(allProperties, { includeTimestamps: true })` appended both unconditionally, so get_record failed on entities that lack them.',
      rule: 'get_record always selects created_at and updated_at, even on entities without those columns',
      frontend: 'Detail selects only existing properties.',
      mcp: '`buildSelectString(allProperties, { includeTimestamps: true })` appends both unconditionally, so get_record fails on entities that lack them.',
      evidence: [`${GR}:66`, `${SB}:85-88`],
      unit: 'one instance is one (query, missing timestamp column) pair; the entity count is the number of distinct entities affected.',
      anchors: [{ file: GR, contains: ['buildSelectString(allProperties, { includeTimestamps: true })'] }],
      instances: was(44, 28, 2, 46),
      recommendation: 'mcp-bug', reason: 'Append timestamps only when the entity has them.',
    }],
    impact: { adoptFrontend: 'get_record works on every entity (done on main).', adoptMcp: 'n/a' },
    recommendation: 'mcp-bug', reason: 'Append timestamps only when the entity has them. Fixed on main.',
  },
  {
    id: 'Q-13', area: Q,
    rule: 'Detail read: the MCP selects every property; the frontend only detail-visible ones',
    frontend: 'getPropsForDetail (show_on_detail + structural); condition fields come in through the same select.',
    mcp: 'get_record and the execute_action condition fetch select all properties so any condition field is present.',
    evidence: [`${GR}:62-66`, `${EA}:68-78`, 'docs/notes/MCP_SERVER_DESIGN.md (Dot-Notation and FK Embedding)'],
    checks: [{ file: GR, contains: ['// Use allProperties (not just displayProperties) so action condition evaluation'] }],
    impact: { adoptFrontend: 'MCP would need extractConditionFieldNames to add condition fields (as the frontend does).', adoptMcp: 'Generic app fetches hidden columns it never shows.' },
    recommendation: 'needs-decision', reason: 'Intentional on the MCP side (documented). Core option: detail plan = visible props + condition field roots, which serves both.',
  },
  {
    id: 'Q-14', area: Q, status: 'fixed-on-main', fixedIn: FIX,
    fix: 'list_records drops empty select parts: `select=id` for an empty column list, and no select at all when nothing is left; no golden request ends in a comma.',
    rule: 'Empty column list: the MCP sent `select=id,` (invalid); the frontend sends `select=id` (or no select)',
    frontend: '`select=id` for an empty field list; no select at all when fields is absent (every column).',
    mcp: 'Since b3f2eeb8 `select=id` for an empty column list (also when an entity has no list-visible column), and no select when the entity has no id either.',
    evidence: [`${LR}:75-88`, `${SB}:66-94`, `${MCG}/neighborhood-hub/_example/data.queries.json`],
    checks: [{ file: LR, contains: ["const selectStr = selectParts.filter(Boolean).join(',');", 'if (selectStr) params.select = selectStr;'], absent: ["selectStr = 'id,' + selectStr;"] }],
    history: [{
      before: FIX,
      summary: '`buildSelectString([])` was empty and list_records prepended `id,`, producing a trailing comma; also happened when an entity had no list-visible column.',
      rule: 'Empty column list: the MCP sends `select=id,` (invalid); the frontend sends `select=id` (or no select)',
      frontend: '`select=id` for an empty field list; no select at all when fields is absent (every column).',
      mcp: '`buildSelectString([])` is empty and list_records prepends `id,`, producing a trailing comma; also happens when an entity has no list-visible column.',
      evidence: [`${LR}:77-81`, `${SB}:66-91`],
      anchors: [{ file: LR, contains: ['selectStr = \'id,\' + selectStr;'] }],
      instances: was(4, 1, 1, 5),
      recommendation: 'mcp-bug', reason: 'PostgREST rejects a trailing comma in select; the neighborhood-hub instances below fail today.',
    }],
    impact: { adoptFrontend: 'list_records works for entities whose columns are all hidden from lists (done on main).', adoptMcp: 'n/a' },
    recommendation: 'mcp-bug', reason: 'PostgREST rejects a trailing comma in select; the neighborhood-hub instances failed before the fix on main.',
  },
  {
    id: 'Q-15', area: Q,
    rule: 'Frontend reads the MCP cannot express (edit-form read, raw parameters, calendar range pages, inverse previews)',
    frontend: 'Edit pages read raw FK ids; list pages pass rawQueryParams (hybrid search, calendar ranges); detail pages fetch inverse-relationship previews.',
    mcp: 'update_record PATCHes without reading; list_records has no raw parameter passthrough; there is no inverse-relationship tool.',
    evidence: [`${MCG}/<example>/_example/data.queries.json (inexpressible)`, `${FEG}/<example>/_example/data.queries.json (inversePreviews)`],
    impact: { adoptFrontend: 'n/a (capabilities, not interpretation).', adoptMcp: 'n/a' },
    recommendation: 'needs-decision', reason: 'Informational: these are MCP feature gaps, not divergences. They do not block parity for the shared functions.',
  },
  {
    id: 'Q-16', area: Q, status: 'partially-fixed-on-main', fixedIn: FIX,
    fix: 'The MCP reads the total from the end of the header with the frontend regex, so `*/0` gives 0, `items 0-24/237` gives 237 and `0-9/12abc` gives no total, as on the frontend. What remains: when there is no numeric total the frontend falls back to the row count and the MCP reports none, which the MCP design doc records as a deliberate known divergence (MCP_SERVER_DESIGN.md, Content-Range totals).',
    rule: 'Content-Range without a numeric total (missing or empty header, `0-24/*`, `0-24/`, garbage): the frontend falls back to the number of rows; the MCP reports no total',
    frontend: '`/\\/(\\d+|\\*)$/`; unknown or missing totals fall back to the number of rows on the page.',
    mcp: 'Since b3f2eeb8 the same `/\\/(\\d+|\\*)$/` for the total (from / to are null without a leading range); with no numeric total `total` is null or the range undefined, and list_records omits "N total records".',
    evidence: [`${DS}:148-161`, `${PC}:164-177`, `${FEG}/_shared/data.content-range.json`, `${MCG}/_shared/data.content-range.json`, 'docs/notes/MCP_SERVER_DESIGN.md (Content-Range totals)'],
    checks: [
      { file: PC, contains: ['const totalMatch = header.match(/\\/(\\d+|\\*)$/);'], absent: ['header.match(/^(\\d+)-(\\d+)\\/(\\d+|\\*)/)'] },
      { file: 'docs/notes/MCP_SERVER_DESIGN.md', contains: ['**Known divergence (rest of ledger row Q-16):**'] },
    ],
    history: [{
      before: FIX,
      summary: '`/^(\\d+)-(\\d+)\\/(\\d+|\\*)/` (anchored start, unanchored end): `*/0` (empty result) yielded no total, so list_records omitted "0 total records"; `0-9/12abc` parsed as 12.',
      rule: 'Content-Range parsing: the MCP reports no total for `*/0`, prefixed or malformed headers, and accepts trailing garbage',
      frontend: '`/\\/(\\d+|\\*)$/`; unknown or missing totals fall back to the number of rows (0 for `*/0`).',
      mcp: '`/^(\\d+)-(\\d+)\\/(\\d+|\\*)/` (anchored start, unanchored end): `*/0` (empty result) yields no total, so list_records omits "0 total records"; `0-9/12abc` parses as 12.',
      evidence: [`${DS}:148-161`, `${PC}:164-173`, `${FEG}/_shared/data.content-range.json`],
      anchors: [{ file: PC, contains: ['header.match(/^(\\d+)-(\\d+)\\/(\\d+|\\*)/)'] }],
      instances: was(0, 0, 9, 9),
      recommendation: 'mcp-bug', reason: 'PostgREST sends `*/0` for empty ranges; the core should parse it (see F-14 for the frontend\'s own two parsers).',
    }],
    impact: { adoptFrontend: 'MCP would report one page\'s row count as the total when PostgREST sends none, which an LLM reads as the size of the whole result.', adoptMcp: 'Generic app shows no total (instead of the page\'s row count) for a missing or uncounted Content-Range; with count=exact on every paginated read this only happens on malformed or proxied responses.' },
    recommendation: 'needs-decision', reason: 'The parse bug is fixed on main; the remaining fallback difference is deliberate on the MCP side and only reachable with a malformed or proxied response. Decide the core contract (total unknown vs row-count fallback) together with F-14. Recommendation changed with the row (it was mcp-bug for the `*/0` parse).',
  },

  // ---------------------------------------------------------------- names
  {
    id: 'N-01', area: N, status: 'fixed-on-main', fixedIn: FIX,
    fix: '`resolveEntity` matches the table name as typed before lowercasing, and a unique case-insensitive table name after the display names; every pothole mixed-case table now resolves by its table name in all five variants.',
    rule: 'Mixed-case table names never resolved by table name in the MCP',
    frontend: 'n/a (routes use the exact table name).',
    mcp: 'Since b3f2eeb8 `resolveEntity` tries the exact table name as typed, then lowercased ("FOO" still means table foo), then the display name, then a unique case-insensitive table name, then substrings (table names lowercased).',
    evidence: [`${NR}:40-84`, `${MCG}/pothole/<variant>/mcp.names.json`],
    checks: [{ file: NR, contains: ['const byTable = entities.find(e => e.table_name === trimmed)', 'const byTableCi = entities.filter(e => e.table_name.toLowerCase() === normalized);'], absent: ['const byTable = entities.find(e => e.table_name === normalized);'] }],
    history: [{
      before: FIX,
      summary: '`resolveEntity` lowercased the input before comparing it with `table_name`, so `Issue`, `Bid`, `Tag` fell through to display-name and substring matching (ambiguous or not found).',
      rule: 'Mixed-case table names never resolve by table name in the MCP',
      frontend: 'n/a (routes use the exact table name).',
      mcp: '`resolveEntity` lowercases the input before comparing it with `table_name`, so `Issue`, `Bid`, `Tag` fall through to display-name and substring matching (ambiguous or not found).',
      evidence: [`${NR}:34-38`, `${MCG}/pothole/<variant>/mcp.names.json`],
      anchors: [{ file: NR, contains: ['const byTable = entities.find(e => e.table_name === normalized);'] }],
      instances: was(2, 2, 0, 10),
      recommendation: 'mcp-bug', reason: 'Compare table names case-sensitively first (or case-insensitively on both sides).',
    }],
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'mcp-bug', reason: 'Compare table names case-sensitively first (or case-insensitively on both sides). Fixed on main.',
  },
  {
    id: 'N-02', area: N,
    rule: 'Status names: the MCP resolves status_key first, then display name; the import worker matches display names only',
    unit: 'one instance is a status whose status_key the MCP resolves (not a failure), or a display name that resolves to another status because a key matched first.',
    frontend: 'Excel import builds `status_<entity_type>` lookups from `statuses` display names (lowercased, trimmed); status keys are not accepted.',
    mcp: '`resolveStatus` tries `status_key`, then display name, case-insensitive.',
    evidence: [`${NR}:243-258`, 'src/app/services/import-export.service.ts:660-700', 'src/app/workers/import-validation.worker.ts:856-922'],
    checks: [{ file: NR, contains: ['const byKey = statuses.find(s => s.status_key?.toLowerCase() === normalized);'] }],
    impact: { adoptFrontend: 'MCP stops accepting status keys (LLMs often use them).', adoptMcp: 'Import accepts status keys too; a key equal to another status\'s display name would change which status a cell maps to.' },
    recommendation: 'needs-decision', reason: 'Both are name resolution over the same data; a single core resolver (key first) is the natural target, but it changes import semantics. Instances count statuses whose key the MCP resolves.',
  },
  {
    id: 'N-03', area: N, status: 'partially-fixed-on-main', fixedIn: FIX,
    fix: 'The case-insensitive fallback is an anchored, escaped `imatch` (exact match), so `*`, `%` and `_` no longer act as wildcards (computed below from the recorded requests). What remains: the MCP does not trim the name before either lookup, while the import worker does.',
    rule: 'FK display-name lookup: the MCP does not trim the name; the import worker matches trimmed, lowercased names',
    frontend: 'Import preloads `(id, display_name)` and matches lowercased, trimmed names exactly; ambiguous names are rejected.',
    mcp: 'Since b3f2eeb8 `display_name=eq.<name>` then `display_name=imatch.^<escaped name>$` (exact, case-insensitive); the name is sent untrimmed, so `"  padded  "` matches only a display name with the same spaces. Several matches are an error, as in the import.',
    evidence: [`${NR}:18-24`, `${NR}:165-218`, `${MCG}/_shared/mcp.names-fk-requests.json`, 'src/app/workers/import-validation.worker.ts:898'],
    unit: 'one instance is a lookup name with leading or trailing spaces in the "eq none, ilike one" stub scenario, which sends both lookups; the evidence is the request, since the stub does not answer `imatch`.',
    checks: [
      { file: NR, contains: ['display_name: `imatch.${exactCaseInsensitivePattern(displayName)}`,', "return `^${value.replace(/[\\\\^$.|?*+()[\\]{}]/g, '\\\\$&')}$`;"], absent: ['display_name: `ilike.${displayName}`,'] },
      { file: 'src/app/workers/import-validation.worker.ts', contains: ['const nameKey = String(value).toLowerCase().trim();'] },
    ],
    history: [{
      before: FIX,
      summary: '`display_name=eq.<name>` then `display_name=ilike.<name>`; `*`, `%` and `_` in the name acted as wildcards in the fallback.',
      rule: 'FK display-name lookup: the MCP falls back to an unescaped ilike; the import worker requires an exact case-insensitive match',
      frontend: 'Import preloads `(id, display_name)` and matches lowercased, trimmed names exactly; ambiguous names are rejected.',
      mcp: '`display_name=eq.<name>` then `display_name=ilike.<name>`; `*`, `%` and `_` in the name act as wildcards in the fallback.',
      evidence: [`${NR}:150-198`, `${MCG}/_shared/mcp.names-fk-requests.json`],
      anchors: [{ file: NR, contains: ['display_name: `ilike.${displayName}`,'] }],
      instances: was(0, 0, 3, 3),
      recommendation: 'mcp-bug', reason: 'Escape LIKE wildcards in the fallback (or use the exact case-insensitive comparison the import uses).',
    }],
    impact: { adoptFrontend: 'MCP trims FK names before looking them up, so an LLM\'s stray spaces still resolve.', adoptMcp: 'Import would stop accepting cells with stray spaces around a name.' },
    recommendation: 'mcp-bug', reason: 'The wildcard bug is fixed on main; trimming the name (as resolveEntity, resolveColumn and resolveStatus already do) closes the rest.',
  },
  {
    id: 'N-04', area: N, status: 'fixed-on-main', fixedIn: FIX,
    fix: 'list_records resolves FK-backed filter values through `resolveForeignKeyFilterValue`, which passes a UUID through as an id; the mottpark `reservation_requests` User filter now sends `col=eq.<uuid>` like the frontend, so that query reaches the request comparison (one more Q-01 and Q-03 instance and one S-03 effect, previously hidden behind the tool error).',
    rule: 'Filtering a User column by UUID failed in list_records',
    frontend: 'User filters send the uuid (`col=eq.<uuid>`).',
    mcp: 'Since b3f2eeb8 a UUID string on an FK-backed column passes through; other strings are looked up by display name (digit strings stay name lookups in filters, unlike create / update).',
    evidence: [`${LR}:155-170`, `${NR}:220-232`, `${MCG}/mottpark/_example/data.queries.json`],
    checks: [
      { file: LR, contains: ['value = await resolver.resolveForeignKeyFilterValue(prop.join_table, value);'], absent: ['value = await resolver.resolveForeignKeyValue(prop.join_table, value);'] },
      { file: NR, contains: ['    if (UUID_PATTERN.test(value)) return value;\n    return this.resolveForeignKeyValue(targetTable, value);'] },
    ],
    history: [{
      before: FIX,
      summary: 'list_records resolved every string on an FK column as a display name (no uuid shortcut, unlike resolveData), so a uuid filter ended in "not found in civic_os_users".',
      rule: 'Filtering a User column by UUID fails in list_records',
      frontend: 'User filters send the uuid (`col=eq.<uuid>`).',
      mcp: 'list_records resolves every string on an FK column as a display name (no uuid shortcut, unlike resolveData), so a uuid filter ends in "not found in civic_os_users".',
      evidence: [`${LR}:153-170`, `${NR}:335-341`],
      anchors: [{ file: LR, contains: ['value = await resolver.resolveForeignKeyValue(prop.join_table, value);'] }],
      instances: was(1, 1, 0, 1),
      recommendation: 'mcp-bug', reason: 'Share resolveValueForType\'s id/uuid shortcut with the filter path.',
    }],
    impact: { adoptFrontend: 'MCP can filter by user id (done on main).', adoptMcp: 'n/a' },
    recommendation: 'mcp-bug', reason: 'Share resolveValueForType\'s id/uuid shortcut with the filter path. Fixed on main.',
  },
  {
    id: 'N-05', area: N,
    rule: 'Locale: the MCP never sends Accept-Language',
    frontend: 'The locale interceptor sends the user\'s language; schema_entities / schema_properties return translated display names.',
    mcp: 'Always default-language display names; name resolution against translated names is impossible.',
    evidence: [`${PC}:100-106`, 'tests/golden/raw/pothole/<role>.es/schema_entities.json'],
    checks: [{ file: PC, contains: ["'Content-Type': 'application/json',"] }],
    impact: { adoptFrontend: 'MCP answers in the user\'s language when a locale is known.', adoptMcp: 'n/a' },
    recommendation: 'needs-decision', reason: 'Product choice: an MCP session has no UI locale; a per-session locale option would be needed.',
  },
  {
    id: 'N-06', area: N,
    rule: 'MCP-only name precedence: exact name, then the first exact display-name match, then substring; duplicate display names resolve to the first match',
    frontend: 'n/a (no free-text column names).',
    mcp: 'Exact column name, then exact display name (first match wins on duplicates), then substring. Entities since b3f2eeb8 (N-01): exact table name as typed, then lowercased, then exact display name, then a unique case-insensitive table name, then substring.',
    evidence: [`${NR}:40-84`, `${NR}:102-144`, `${MCG}/<variant>/mcp.names.json`],
    checks: [{ file: NR, contains: ['const byDisplay = properties.find('] }],
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'needs-decision', reason: 'MCP-only behavior that moves to the core with the resolver; decide whether duplicates should be reported as ambiguous.',
  },

  // ---------------------------------------------------------------- other MCP
  {
    id: 'X-01', area: X,
    rule: 'create_record / update_record send values verbatim (no value transforms)',
    frontend: '`transformValuesForApi`: DateTimeLocal wall time to UTC ISO, DateTime seconds appended, Money parsed, File/Gallery objects to ids, timestamps dropped.',
    mcp: 'Only display-name to id resolution (`resolveData`); dates, money and files go to PostgREST exactly as the LLM wrote them.',
    evidence: ['src/app/pages/create/create.page.ts:657-713', 'src/app/pages/edit/edit.page.ts:912-978', 'tools/mcp-server/src/tools/create-record.ts:60-81', `${NR}:320-376`],
    checks: [{ file: 'tools/mcp-server/src/tools/create-record.ts', contains: ['resolvedData = await resolver.resolveData(resolved.table_name, data);'] }],
    compute: ({ hit, readJson, FE, examples }) => {
      const TYPES = ['DateTime', 'DateTimeLocal', 'Money', 'File', 'FileImage', 'FilePDF', 'PhotoGallery'];
      for (const ex of examples()) {
        const views = readJson(path.join(FE, ex, 'testadmin/schema.views.json')).entities;
        const props = readJson(path.join(FE, ex, 'testadmin/schema.properties.json')).entities;
        for (const [table, v] of Object.entries(views)) {
          const types = new Map((props[table] ?? []).map(p => [p.column, p.type]));
          for (const col of v.create) {
            const t = types.get(col);
            if (TYPES.includes(t)) hit('X-01', { example: ex, entity: table, subject: col, detail: `${t} on the create form; the MCP passes the LLM's value through unchanged` });
          }
        }
      }
    },
    impact: { adoptFrontend: 'MCP writes get the same normalization (an LLM writing "2026-07-04T10:30" to a timestamptz would be stored in the server zone today).', adoptMcp: 'n/a' },
    recommendation: 'needs-decision', reason: 'The frontend transforms assume a browser time zone; the MCP has none. The core should expose the transforms with an explicit zone parameter; the MCP must decide which zone an LLM-supplied wall time means.',
  },
  {
    id: 'X-02', area: X,
    rule: 'Three admin pages build PostgREST queries by hand, bypassing DataService (and later the core)',
    frontend: 'admin-files, admin-galleries and admin-payments concatenate query strings: user search and filter values are not encoded (`file_name=ilike.*${q}*`, `or=(description.ilike.*${search}*,user_email.ilike.*${search}*)`, `entity_id=ilike.*${search}*`), pagination uses limit/offset instead of Range, totals come from a third Content-Range regex `/\\/(\\d+|\\*)/`, a raw `%` is sent in `like` patterns, and date filters use UTC day bounds (`T00:00:00Z` / `T23:59:59Z`) rather than the user\'s zone.',
    mcp: 'n/a (no admin tools).',
    evidence: ['src/app/pages/admin-files/admin-files.page.ts:207-225', 'src/app/pages/admin-files/admin-files.page.ts:464-505', 'src/app/pages/admin-galleries/admin-galleries.page.ts:151-180', 'src/app/pages/admin-payments/admin-payments.page.ts:227-270'],
    checks: [
      { file: 'src/app/pages/admin-files/admin-files.page.ts', contains: ['parts.push(`file_name=ilike.*${q}*`);', 'const match = contentRange.match(/\\/(\\d+|\\*)/);'] },
      { file: 'src/app/pages/admin-galleries/admin-galleries.page.ts', contains: ['params += `&entity_id=ilike.*${search}*`;'] },
      { file: 'src/app/pages/admin-payments/admin-payments.page.ts', contains: ['params.push(`or=(description.ilike.*${search}*,user_email.ilike.*${search}*)`);'] },
    ],
    compute: ({ hit }) => {
      hit('X-02', { example: 'app', entity: 'admin-files', subject: 'files / entity queries', detail: 'unencoded file name search and entity filters; limit/offset; own Content-Range regex' });
      hit('X-02', { example: 'app', entity: 'admin-galleries', subject: 'gallery_admin query', detail: 'unencoded entity_id search; limit/offset; own Content-Range regex' });
      hit('X-02', { example: 'app', entity: 'admin-payments', subject: 'payment_transactions query', detail: 'unencoded search inside or=(...) (a comma or parenthesis breaks the expression); limit/offset; own Content-Range regex' });
    },
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'frontend-bug', reason: 'Porting admin pages is out of SDK scope, but the encoding hazard (a search containing `&`, `,` or `)` corrupts the query) should be fixed separately, ideally by building these queries with the core query builder once it exists.',
  },

  // ---------------------------------------------------------------- frontend quirks (lead list, P0.2b verifier)
  {
    id: 'F-01', area: F,
    rule: 'Filter values and entityId are not URL-encoded (only the search term is)',
    frontend: 'Concatenates `col=op.value` and `id=eq.<id>` unencoded: `&`, `#`, `+`, `%`, `=` and `?` split or corrupt the query.',
    mcp: 'URLSearchParams encodes every parameter; the same inputs arrive intact (`<PGRST>/items?name=eq.a%26b`).',
    evidence: [`${DS}:55-69`, `${FEG}/_shared/data.query-matrix.json`, `${MCG}/_shared/data.query-matrix.json`],
    checks: [{ file: DS, contains: ["args.push('id=eq.' + query.entityId);"] }],
    impact: { adoptFrontend: 'n/a', adoptMcp: 'Generic app sends filter values intact (approved golden diff on the encoded cases).' },
    recommendation: 'frontend-bug', reason: 'Encode values in the core query builder; the MCP already does.',
  },
  {
    id: 'F-02', area: F,
    rule: 'page <= 0 gives a negative Range; pageSize 0 gives `0--1`; page 2.5 gives `15-24`',
    frontend: '`Range: -25--1` (page 0), `-50--26` (page -1), `0--1` (pageSize 0), `15-24` (page 2.5).',
    mcp: 'The equivalent offset/limit is rejected by list_records input validation (negative offset, limit 0); page 2.5 maps to offset 15, limit 10, the same Range.',
    evidence: [`${DS}:131-143`, `${FEG}/_shared/data.query-matrix.json`],
    checks: [{ file: `${FEG}/_shared/data.query-matrix.json`, contains: ['"Range": "-25--1"', '"Range": "0--1"', '"Range": "15-24"'] }],
    impact: { adoptFrontend: 'n/a', adoptMcp: 'Generic app validates pagination input.' },
    recommendation: 'frontend-bug', reason: 'Validate page >= 1 and pageSize >= 1 (integers) in the core.',
  },
  {
    id: 'F-03', area: F,
    rule: 'Garbage or empty DateTimeLocal becomes "NaN-NaN-NaNTNaN:NaN" in transformValueForControl',
    frontend: 'Invalid Date is formatted field by field without a validity check.',
    mcp: 'No counterpart (the MCP has no form controls).',
    evidence: ['src/app/pages/edit/edit.page.ts:839-880', `${FEG}/_shared/transforms.dst-edges.json`, `${FEG}/<variant>/transforms.rows.json`],
    checks: [{ file: `${FEG}/_shared/transforms.dst-edges.json`, contains: ['"dtl": "NaN-NaN-NaNTNaN:NaN"'] }],
    compute: ({ hit, FE, examples }) => {
      const scan = (file, example) => {
        if (!fs.existsSync(file)) return;
        const n = (fs.readFileSync(file, 'utf8').match(/NaN-NaN-NaNTNaN:NaN/g) ?? []).length;
        if (n) hit('F-03', { example, entity: path.basename(file), subject: 'NaN control value', detail: `${n} occurrence(s) of NaN-NaN-NaNTNaN:NaN` });
      };
      scan(path.join(FE, '_shared/transforms.dst-edges.json'), '_shared');
      for (const ex of examples()) scan(path.join(FE, ex, 'testadmin/transforms.rows.json'), ex);
    },
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'frontend-bug', reason: 'Return empty (or the raw value) for invalid dates.',
  },
  {
    id: 'F-04', area: F,
    rule: 'parseToHuman returns "System Error" for 23502, 22P02, 22007 / 22008 (and 412), where the MCP has a specific message',
    frontend: '"System Error" for all of these (PGRST301 is handled only through HTTP 401).',
    mcp: '23502 "Required field \\"c\\" is missing.", 22P02 names the expected type ("a whole number", "a date (YYYY-MM-DD)", ...), 22007/22008 "Invalid date format...", 412 "This record has been modified since you last read it...".',
    evidence: [`${ES}:106-126`, `${PC}:228-254`, 'tools/mcp-server/src/index.ts:215-231', `${FEG}/<example>/_example/errors.lookup.json`],
    checks: [{ file: PC, contains: ["if (this.code === '23502') {", "if (this.code === '22P02') {"] }],
    impact: { adoptFrontend: 'MCP loses its friendlier messages.', adoptMcp: 'Generic app explains missing required fields, bad numbers and bad dates instead of "System Error".' },
    recommendation: 'adopt-mcp', reason: 'Strictly better: these name the missing field or the expected format instead of "System Error".',
  },
  {
    id: 'F-17', area: F,
    rule: 'parseToHuman returns "System Error" for 23503, PGRST116 and PT503, where the MCP returns the raw PostgREST message (or a MaintenanceError)',
    frontend: '"System Error".',
    mcp: '23503 and PGRST116 fall back to "Error: <raw PostgREST message>"; PT503 makes the client throw MaintenanceError and index.ts returns a maintenance explanation (toHumanMessage alone gives "Error: <message>").',
    evidence: [`${ES}:106-126`, `${PC}:257`, 'tools/mcp-server/src/index.ts:215-231', `${FEG}/<example>/_example/errors.lookup.json`],
    checks: [{ file: PC, contains: ['return `Error: ${this.message}`;'] }],
    impact: { adoptFrontend: 'MCP loses the raw message an LLM can act on.', adoptMcp: 'Generic app would show raw PostgREST / database text ("Error: insert or update on table ... violates foreign key constraint ...") to end users.' },
    recommendation: 'needs-decision', reason: 'Wholesale adoption would surface raw messages in the UI. 23503 (FK violation) deserves a friendly message on both sides; PGRST116 likewise; PT503 is handled by the frontend\'s maintenance interceptor, so its parseToHuman text rarely shows.',
  },
  {
    id: 'F-05', area: F,
    rule: 'New York DST gap: 02:30 on 2026-03-08 is sent as 07:30Z (JavaScript forward-shift)',
    frontend: 'A nonexistent local time is shifted forward by the Date constructor and stored as 03:30 EDT.',
    mcp: 'No counterpart (values are sent verbatim, see X-01).',
    evidence: [`${FEG}/_shared/transforms.dst-edges.json`, 'src/app/utils/date.utils.ts'],
    checks: [{ file: `${FEG}/_shared/transforms.dst-edges.json`, contains: ['"create": {"dt": "2026-03-08T02:30:00", "dtl": "2026-03-08T07:30:00.000Z"}'] }],
    compute: ({ hit }) => hit('F-05', { example: '_shared', entity: 'transforms.dst-edges', subject: 'America/New_York 2026-03-08T02:30', detail: 'stored as 2026-03-08T07:30:00.000Z (03:30 EDT)' }),
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'needs-decision', reason: 'Forward-shift is a defensible policy; the alternative is rejecting nonexistent local times. Decide before the core fixes the semantics in its transforms.',
  },
  {
    id: 'F-06', area: F,
    rule: 'DateTime / DateTimeLocal transforms ignore 19-character strings (with seconds)',
    frontend: 'Only 16-character values are converted; `2026-07-04T10:30:00` is sent unchanged, so a DateTimeLocal with seconds reaches PostgreSQL without an offset and is read in the server zone.',
    mcp: 'No counterpart (values verbatim, X-01).',
    evidence: ['src/app/pages/create/create.page.ts:657-713', `${FEG}/_shared/transforms.dst-edges.json`],
    checks: [{ file: `${FEG}/_shared/transforms.dst-edges.json`, contains: ['"create": {"dt": "2026-07-04T10:30:00", "dtl": "2026-07-04T10:30:00"}'] }],
    compute: ({ hit }) => hit('F-06', { example: '_shared', entity: 'transforms.dst-edges', subject: '2026-07-04T10:30:00', detail: 'DateTimeLocal sent without conversion in every zone' }),
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'frontend-bug', reason: 'Data-integrity risk for any input that carries seconds (programmatic or pasted values).',
  },
  {
    id: 'F-07', area: F,
    rule: 'propertyToSelectStringForEdit drops parent hops and emits an invalid embed for parent-hop M:M',
    frontend: 'The edit variant ignores `parentHops` and builds `junction!col(target!target_col(...))` with the wrong related table.',
    mcp: 'No counterpart (no M:M, T-12).',
    evidence: [`${SS}:762-774`, `${FEG}/neighborhood-hub/<variant>/schema.properties.json`, `${FEG}/neighborhood-hub/<variant>/schema.m2m.json`],
    checks: [{ file: SS, contains: ['public static propertyToSelectStringForEdit(prop: SchemaEntityProperty): string {'] }],
    compute: ({ hit, readJson, FE, examples }) => {
      for (const ex of examples()) {
        const m2m = readJson(path.join(FE, ex, 'testadmin/schema.m2m.json')).virtualProperties ?? [];
        const props = readJson(path.join(FE, ex, 'testadmin/schema.properties.json')).entities;
        for (const vp of m2m) {
          if (!vp.many_to_many_meta?.parentHops?.length) continue;
          const p = (props[vp.table_name] ?? []).find(x => x.column === vp.column_name);
          if (p && p.selectForEdit !== '=') hit('F-07', { example: ex, entity: vp.table_name, subject: vp.column_name, detail: `edit select ${p.selectForEdit}` });
        }
      }
    },
    latent: 'latent in the app: parent-hop M:M fields are not on the edit form',
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'frontend-bug', reason: 'Build the edit variant from the same parent-hop logic, or exclude parent-hop M:M from edit selects explicitly.',
  },
  {
    id: 'F-08', area: F,
    rule: 'DateTime appends ":00" to ANY 16-character string, including garbage and impossible dates',
    frontend: '`2026-02-30T10:00` becomes `2026-02-30T10:00:00`; any 16-character text is accepted.',
    mcp: 'No counterpart (X-01).',
    evidence: ['src/app/pages/create/create.page.ts:657-713', `${FEG}/_shared/transforms.dst-edges.json`],
    checks: [{ file: `${FEG}/_shared/transforms.dst-edges.json`, contains: ['"create": {"dt": "2026-02-30T10:00:00", "dtl": "2026-02-30T10:00"}'] }],
    compute: ({ hit }) => hit('F-08', { example: '_shared', entity: 'transforms.dst-edges', subject: '2026-02-30T10:00', detail: 'DateTime sent as 2026-02-30T10:00:00 (PostgreSQL rejects it, the user sees a generic error)' }),
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'frontend-bug', reason: 'Validate before appending seconds.',
  },
  {
    id: 'F-09', area: F,
    rule: 'A 16-character DateTimeLocal that parseDatetimeLocal rejects is sent unconverted',
    frontend: 'Invalid day, month 13, hour 24 or garbage of length 16 is sent as the raw local string, so PostgreSQL either rejects it or reads it in the server zone.',
    mcp: 'No counterpart (X-01).',
    evidence: ['src/app/pages/create/create.page.ts:657-713', `${FEG}/_shared/transforms.dst-edges.json`],
    checks: [{ file: `${FEG}/_shared/transforms.dst-edges.json`, contains: ['"create": {"dt": "2026-13-01T10:00:00", "dtl": "2026-13-01T10:00"}', '"dtl": "2026-07-04T24:00"'] }],
    compute: ({ hit }) => {
      for (const v of ['2026-02-30T10:00', '2026-13-01T10:00', '2026-07-04T24:00']) hit('F-09', { example: '_shared', entity: 'transforms.dst-edges', subject: v, detail: `DateTimeLocal sent as ${v} (no zone)` });
    },
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'frontend-bug', reason: 'Reject invalid local times in the transform instead of passing them through.',
  },
  {
    id: 'F-10', area: F,
    rule: 'Date-only control values parse as UTC midnight; offset-less timestamps parse as local time',
    frontend: 'transformValueForControl for DateTimeLocal shows `2026-07-04` as 2026-07-03T20:00 in New York; `2026-07-04T17:30:00` (no offset) is treated as local.',
    mcp: 'No counterpart.',
    evidence: ['src/app/pages/edit/edit.page.ts:839-880', `${FEG}/_shared/transforms.dst-edges.json`],
    checks: [{ file: `${FEG}/_shared/transforms.dst-edges.json`, contains: ['"2026-07-04": {"dt": "2026-07-04", "dtl": "2026-07-03T20:00"}'] }],
    compute: ({ hit }) => hit('F-10', { example: '_shared', entity: 'transforms.dst-edges', subject: 'control 2026-07-04 (America/New_York)', detail: 'DateTimeLocal control shows 2026-07-03T20:00' }),
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'frontend-bug', reason: 'JavaScript Date parsing rules leak into the UI; the core transform should parse with explicit rules.',
  },
  {
    id: 'F-11', area: F,
    rule: 'Money control returns raw strings for (1.00), €10.00 and abc; "$1,2,3" becomes 123',
    frontend: 'Strips `$` and `,` then parses; anything else passes through as a string.',
    mcp: 'No counterpart (money is sent verbatim, X-01).',
    evidence: ['src/app/pages/edit/edit.page.ts:839-880', `${FEG}/_shared/transforms.dst-edges.json`],
    checks: [{ file: `${FEG}/_shared/transforms.dst-edges.json`, contains: ['"$1,2,3": 123', '"(1.00)": "(1.00)"'] }],
    compute: ({ hit }) => {
      for (const [k, v] of [['(1.00)', '"(1.00)"'], ['€10.00', '"€10.00"'], ['abc', '"abc"'], ['$1,2,3', '123']]) hit('F-11', { example: '_shared', entity: 'transforms.dst-edges money', subject: k, detail: `control value ${v}` });
    },
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'frontend-bug', reason: 'Parse PostgreSQL money output (negative parentheses, locale symbols) explicitly or reject.',
  },
  {
    id: 'F-12', area: F,
    rule: 'CreatePage deletes the PhotoGallery key only when the value is non-null, so null is sent',
    frontend: 'A null gallery is posted as `gallery: null` instead of being omitted (galleries are linked after insert).',
    mcp: 'No counterpart.',
    evidence: ['src/app/pages/create/create.page.ts:657-713', `${FEG}/_shared/transforms.dst-edges.json`],
    checks: [{ file: `${FEG}/_shared/transforms.dst-edges.json`, contains: ['"create": {"amount": null, "doc": null, "gallery": null'] }],
    compute: ({ hit }) => hit('F-12', { example: '_shared', entity: 'transforms.dst-edges shapes', subject: 'gallery null', detail: 'create payload keeps gallery: null' }),
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'frontend-bug', reason: 'Omit the key consistently (null is harmless today only because the column is nullable).',
  },
  {
    id: 'F-13', area: F,
    rule: 'The in filter emits `in.()`, `in.not-an-array` and empty items (`1,,`); `eq.false` and `eq.0` are emitted; in-list items are never quoted',
    frontend: '`in.(a,b,c d,(e),1,,)` for values containing commas or parentheses, which PostgREST splits.',
    mcp: 'Same `in.()` / `in.not-an-array` / unquoted items for the inputs it accepts (`and=(...)` in the per-entity cases, Q-09); rejects null items at input validation.',
    evidence: [`${DS}:61-66`, `${LR}:182-193`, `${FEG}/_shared/data.query-matrix.json`, `${FEG}/<example>/_example/data.queries.json`],
    checks: [{ file: `${FEG}/_shared/data.query-matrix.json`, contains: ['c=in.(a,b,c d,(e),1,,)'] }],
    compute: ({ hit, readJson, FE, MCP, examples }) => {
      for (const ex of examples()) {
        const fe = readJson(path.join(FE, ex, '_example/data.queries.json')).entities;
        const mc = readJson(path.join(MCP, ex, '_example/data.queries.json')).entities;
        for (const [table, e] of Object.entries(fe)) {
          e.queries.forEach((q, i) => {
            if (!q.request?.url?.includes('=in.()')) return;
            const m = mc[table]?.queries?.[i];
            const mUrl = m?.requests?.map(r => r.decoded.join('&')).join(' ; ') ?? '';
            hit('F-13', { example: ex, entity: table, subject: q.name, detail: `frontend sends in.() and in.not-an-array; MCP ${mUrl.includes('in.()') ? 'sends the same inside and=(...)' : m?.toolError ? `fails: ${m.toolError.slice(0, 60)}` : 'differs'}` });
          });
        }
      }
    },
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'needs-decision', reason: 'Both sides share the quoting gap (a value with a comma is split). Suggested core rule: drop empty in-lists, quote items, keep `eq.false` / `eq.0` (valid).',
  },
  {
    id: 'F-14', area: F,
    rule: 'The two frontend Content-Range parsers disagree on missing, empty or unknown totals',
    frontend: 'getDataPaginated uses `/\\/(\\d+|\\*)$/` and falls back to the row count; the inverse preview uses `/\\/(\\d+)$/` and falls back to 0 when the header is missing.',
    mcp: 'A third parser (Q-16).',
    evidence: [`${DS}:148-161`, `${DS}:723-728`, `${FEG}/_shared/data.content-range.json`],
    checks: [{ file: DS, contains: ['const match = contentRange.match(/\\/(\\d+)$/);'] }],
    compute: ({ hit, readJson, FE }) => {
      const d = readJson(path.join(FE, '_shared/data.content-range.json'));
      for (const [h, p] of Object.entries(d.paginated)) {
        const v = d.preview[h];
        if (v && v.totalCount !== p.totalCount) hit('F-14', { example: '_shared', entity: 'data.content-range', subject: JSON.stringify(h), detail: `paginated ${p.totalCount}, preview ${v.totalCount}` });
      }
    },
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'frontend-bug', reason: 'One parser in the core.',
  },
  {
    id: 'F-15', area: F,
    rule: 'P0001 without a message: parseToHuman returns undefined (the MCP returns ""); an empty message gives ""; under HTTP 401/404 the status wins over the code',
    frontend: 'A RAISE with no message property returns `err.message`, i.e. undefined (callers render whatever that becomes); an empty message gives ""; `{401, P0001}` reads "session expired", `{404, P0001}` "Resource not found".',
    mcp: 'PostgRESTRequestError passes the message to Error, so a missing message becomes "" and P0001 returns ""; 401/404 are checked before P0001 as on the frontend (only the wording differs, E-01).',
    evidence: [`${ES}:106-126`, `${PC}:250-255`, `${FEG}/<example>/_example/errors.lookup.json`],
    checks: [{ file: ES, contains: ["} else if(err.code == 'P0001') {"] }],
    impact: { adoptFrontend: 'MCP would return undefined for an empty RAISE.', adoptMcp: 'Generic app shows an empty message instead of undefined.' },
    recommendation: 'needs-decision', reason: 'Neither is a good message: an empty or missing RAISE message should fall back to a generic text on both sides. Status-over-code precedence is reasonable but should be explicit in the core.',
  },
  {
    id: 'F-16', area: F,
    rule: 'The guided-form and action condition evaluators disagree (String coercion vs strict equality; neq against null)',
    frontend: 'GuidedFormService compares `String(value) === condition.value` and returns true for `neq null` on a null field; the action evaluator is strict and returns false for `ne null` on null.',
    mcp: 'No guided forms; its action evaluator is a third behavior (C-02).',
    evidence: ['src/app/services/guided-form.service.ts:262-279', `${CE}`, `${FEG}/_shared/conditions.matrix.json`, `${FEG}/_shared/conditions.guided-form-matrix.json`],
    checks: [{ file: 'src/app/services/guided-form.service.ts', contains: ['return String(value) === condition.value;'] }],
    compute: ({ hit, readJson, FE }) => {
      const gf = readJson(path.join(FE, '_shared/conditions.guided-form-matrix.json')).matrix;
      const ac = readJson(path.join(FE, '_shared/conditions.matrix.json')).matrix;
      for (const [g, a] of [['eq null', 'eq null'], ['neq null', 'ne null'], ['is_null null', 'is_null null'], ['is_not_null null', 'is_not_null null']]) {
        for (const [dl, r] of Object.entries(gf[g] ?? {})) {
          if (dl in (ac[a] ?? {}) && ac[a][dl] !== r) hit('F-16', { example: '_shared', entity: 'conditions matrices', subject: `${g} / ${a} @ ${dl}`, detail: `guided form ${r}, action ${ac[a][dl]}` });
        }
      }
    },
    impact: { adoptFrontend: 'n/a', adoptMcp: 'n/a' },
    recommendation: 'needs-decision', reason: 'One condition evaluator in the core; guided-form conditions store string values, so the core needs an explicit coercion rule for them.',
  },
];

// ---------------------------------------------------------------- latent nondeterminism

function tiedGroups(rows, keyOf, nameOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(nameOf(r));
  }
  return [...groups.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => [k, [...v].sort()]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export const NONDETERMINISM = {
  intro: 'Product findings, not code divergences: the order below depends on the query plan because nothing breaks `sort_order` ties. The raw fixtures sort these ties by a fixed key, and the ledger ignores order differences confined to ties, so they are not counted as frontend/MCP divergences; in a live instance both consumers inherit whatever order PostgreSQL returns.',
  remedy: 'add a deterministic tie-breaker (`column_name` for properties, `id` for actions) to the `schema_properties` / `schema_entity_actions` views, or to the consumers\' sorts (the core).',
  items: [
    {
      title: 'Properties tied on sort_order within a table',
      evidence: '`schema_properties` has no ORDER BY; the frontend\'s stable sort by `sort_order` keeps arrival order (`schema.service.ts` getProperties), the MCP orders by `table_name, sort_order` only (`schema-cache.ts` fetchProperties).',
      effect: 'Tied fields render in query-plan-dependent order on list, detail and form pages, and in MCP tables.',
      compute: ({ readJson, RAW, examples }) => {
        const lines = [];
        let total = 0;
        let withTies = 0;
        for (const ex of examples()) {
          const rows = readJson(path.join(RAW, ex, 'testadmin/schema_properties.json'));
          const ties = tiedGroups(rows, r => `${r.table_name} @ ${r.sort_order}`, r => r.column_name);
          total += ties.length;
          if (ties.length) withTies++;
          lines.push(`${ex}: ${ties.length} tied groups${ties.length ? `, e.g. ${ties.slice(0, 2).map(([k, v]) => `${k.split(' @ ')[0]} {${v.join(', ')}} at ${k.split(' @ ')[1]}`).join('; ')}` : ''}`);
        }
        return { summary: `${total} tied (table, sort_order) groups across ${withTies}/${examples().length} examples (testadmin fixtures)`, examples: lines };
      },
    },
    {
      title: 'Actions tied on sort_order within a table',
      evidence: '`schema_entity_actions` is read without a tie-break (frontend unordered, MCP `order=table_name,sort_order`).',
      effect: 'Button order is plan-dependent where tied actions can be visible together: mottpark `close` vs `waive_all_fees` (both at 50). The client-intake `clients` and neighborhood-hub `tool_reservations` ties at 10 are mutually exclusive by condition, so harmless (lead analysis).',
      compute: ({ readJson, RAW, examples }) => {
        const lines = [];
        let total = 0;
        for (const ex of examples()) {
          const rows = readJson(path.join(RAW, ex, 'testadmin/schema_entity_actions.json'));
          for (const [k, v] of tiedGroups(rows, r => `${r.table_name} @ ${r.sort_order}`, r => r.action_name)) {
            total++;
            lines.push(`${ex}: ${k.split(' @ ')[0]} {${v.join(', ')}} at ${k.split(' @ ')[1]}`);
          }
        }
        return { summary: `${total} tied (table, sort_order) action groups`, examples: lines };
      },
    },
  ],
};
