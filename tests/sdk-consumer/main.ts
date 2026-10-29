/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// A custom app written the way an external one would use @civic-os/core: a small issue-triage
// program over the generated pothole types. It imports the SDK only through its public entry point
// (plus node: builtins for the fixture transport) and the generated snapshot from
// tests/golden/codegen/pothole.ts, never a copy of it. It is not a test file: no runner, just
// node:assert, run by `npm run test:sdk-consumer`. scripts/check-dogfood.mjs counts references from
// this folder as the `@consumer custom-app` expectation.
//
// Core exports it deliberately does not name (they stay reachable through the entry points they
// belong to, as `@consumer typed <entry point>`): RelationShape and EntityShape, which a generated
// Database satisfies structurally and an app never spells out.

import assert from 'node:assert/strict';
import {
  bootstrapTypedSchema,
  checkCompatibility,
  ClientUpdateRequiredError,
  compileWith,
  defineQuery,
  enrichPropertiesWithManyToMany,
  getPropertyType,
  SchemaClient,
  SchemaContractError,
  SchemaMismatchError,
} from '@civic-os/core';
import type {
  ActionKeysOf,
  AppVersions,
  CompatibilityResult,
  CompiledWith,
  DatabaseShape,
  EmbeddedOf,
  EntityAccessor,
  EntityName,
  ExactQuery,
  IncompatiblePolicy,
  InsertOf,
  InstanceVersions,
  QueryResult,
  RelationResult,
  RelationsOf,
  ResultShape,
  RowOf,
  SchemaMismatch,
  SchemaMismatchReason,
  SubQuery,
  TargetOf,
  TypedQuery,
  TypedSchema,
  TypedSchemaMode,
  TypedSchemaOptions,
  UpdateOf,
  With,
  WithInput,
  WithQueryInput,
  WithSchemaContext,
  WithSubQueryInput,
} from '@civic-os/core';
import { DOMAIN_VERSION, SCHEMA_HASH } from '../golden/codegen/pothole.js';
import type { Database } from '../golden/codegen/pothole.js';
import { API, fixtureTransport } from './transport.js';
import type { FixtureOptions } from './transport.js';
import { runStore } from './store.js';
import { runPlan } from './plan.js';

// ---- the app's own types, spelled with the generated Database ----

type IssueRow = RowOf<Database, 'Issue'>;
type NewIssue = InsertOf<Database, 'Issue'>;
type IssuePatch = UpdateOf<Database, 'Issue'>;
type IssueEmbedded = EmbeddedOf<Database, 'Issue'>;
type IssueRelations = RelationsOf<Database, 'Issue'>;
type PackageEntity = TargetOf<Database, 'Issue', 'work_package'>;
type IssueActionKeys = ActionKeysOf<Database, 'Issue'>;

// The pothole instance has no entity actions, so the generated key union is empty.
const noActionKeys: [IssueActionKeys] extends [never] ? true : false = true;

const draft: NewIssue = { display_name: 'Pothole on Main St' }; // everything else has a database default
const patch: IssuePatch = { severity_level: 3 };
const embeddedPackage: IssueEmbedded['work_package'] = { id: 7, display_name: 'Spring repairs' };

// A reusable fragment: the columns of a related work package, then embedded in an issue query.
const packageColumns = { columns: ['id', 'display_name'] } satisfies SubQuery<Database, 'WorkPackage'>;
const issueEmbeds = { work_package: packageColumns, issue_tags_m2m: { columns: ['display_name'], limit: 3 } } satisfies With<Database, 'Issue'>;

// The app's own typed wrapper: any issue query the generated types accept, compiled to a select string.
function issueSelect<const Q extends TypedQuery<Database, 'Issue'>>(
  query: Q & ExactQuery<Database, 'Issue', Q>,
  schema: WithSchemaContext,
): CompiledWith {
  return compileWith('Issue', query, schema);
}
type KnownEntity = EntityName<Database>;
const entityOfRecord: KnownEntity = 'Issue';

// The same compile from a query assembled at runtime (say, a saved view), so only structurally typed.
const savedViewSubQuery: WithSubQueryInput = { columns: ['id', 'display_name'] };
const savedViewEmbeds: WithInput = { work_package: savedViewSubQuery };
const savedView: WithQueryInput = { select: ['id', 'display_name'], with: savedViewEmbeds };

const triage = defineQuery<Database, 'Issue'>()({
  select: ['id', 'display_name', 'status'],
  with: {
    work_package: { columns: ['id', 'display_name'] },
    issue_tags_m2m: { columns: ['display_name'], limit: 3 },
    WorkDetail: { columns: ['id', 'display_name'], order: { column: 'id', direction: 'desc' }, limit: 5 },
  },
});
type TriageRow = QueryResult<Database, 'Issue', typeof triage>;
type TriageRelationPackage = RelationResult<Database, 'Issue', 'work_package', { columns: ['id'] }>;
type TriageShape = ResultShape<Database, 'Issue', 'id' | 'display_name', Record<never, never>>;

function describeTriage(row: TriageRow): string {
  const pkg = row.work_package; // nullable relation: the result type forces the null check
  return `${row.display_name} (${pkg ? pkg.display_name : 'unassigned'})`;
}

// ---- helpers ----

async function bootstrap<D extends DatabaseShape>(
  fixture: FixtureOptions,
  schemaHash: string,
  onIncompatible: IncompatiblePolicy,
  onWarn?: (m: SchemaMismatch) => void,
): Promise<{ typed: TypedSchema<D>; schema: SchemaClient }> {
  const schema = new SchemaClient({ transport: fixtureTransport(fixture), apiUrl: API });
  const options: TypedSchemaOptions = {
    schema,
    understands: { domain: DOMAIN_VERSION, schemaHash },
    onIncompatible,
    ...(onWarn ? { onWarn } : {}),
  };
  return { typed: await bootstrapTypedSchema<D>(options), schema };
}

async function main(): Promise<void> {
  // ---- a matching hash: verified, accessors trusted ----
  const { typed, schema } = await bootstrap<Database>({}, SCHEMA_HASH, 'block');
  const mode: TypedSchemaMode = typed.mode;
  assert.equal(mode, 'verified');
  assert.equal(typed.instance?.contractHash, SCHEMA_HASH);

  const issue: EntityAccessor<Database, 'Issue'> = typed.entities.Issue;
  assert.equal(issue.handle.name, 'Issue');
  assert.equal(issue.property('status').name, 'status');
  assert.equal(issue.optional('no_such_column'), undefined);
  assert.equal(noActionKeys, true);
  assert.equal(entityOfRecord, issue.handle.name);
  await issue.loadActions();
  assert.throws(() => issue.action('archive' as IssueActionKeys), SchemaContractError); // none declared, and the type says so

  // ---- compatibility, checked directly ----
  const instanceVersions: InstanceVersions = {
    domainVersion: typed.instance!.domainVersion,
    minClientDomainVersion: typed.instance!.minClientDomainVersion,
  };
  const appVersions: AppVersions = { domainVersion: DOMAIN_VERSION };
  const compat: CompatibilityResult = checkCompatibility(instanceVersions, appVersions);
  assert.deepEqual(compat, { status: 'ok' });
  assert.deepEqual(typed.compatibility, compat);
  const tooOld = checkCompatibility({ domainVersion: '2.0.0', minClientDomainVersion: '1.0.0' }, appVersions);
  assert.equal(tooOld.status, 'client-too-old');

  // ---- queries compiled against the loaded schema ----
  // The schema client hands out raw rows: like the app, type them and enrich the many-to-many columns.
  const tables = (await schema.getEntities());
  const typedRows = (await schema.getProperties()).map(p => ({ ...p, type: getPropertyType(p) }));
  const context: WithSchemaContext = {
    properties: enrichPropertiesWithManyToMany(typedRows, tables, await schema.getM2mMetadata()),
    tables,
  };
  const compiled = compileWith('Issue', triage, context);
  assert.equal(
    compiled.select,
    'id,display_name,status:statuses!status(id,display_name,color,status_key),' +
      'work_package:WorkPackage!work_package(id,display_name),' +
      'issue_tags_m2m:issue_tags!issue_id(Tag!tag_id(display_name)),' +
      'WorkDetail!issue(id,display_name)',
  );
  assert.deepEqual(compiled.params, ['issue_tags_m2m.limit=3', 'WorkDetail.order=id.desc', 'WorkDetail.limit=5']);
  assert.equal(issueSelect({ select: ['id'], with: issueEmbeds }, context).params.at(-1), 'issue_tags_m2m.limit=3');
  assert.equal(compileWith('Issue', savedView, context).select.includes('work_package:WorkPackage!work_package(id,display_name)'), true);

  const sample: TriageRow = {
    id: 1,
    display_name: 'Pothole on Main St',
    status: { id: 1, display_name: 'New', color: null, status_key: 'new' },
    work_package: embeddedPackage,
    issue_tags_m2m: [],
    WorkDetail: [],
  };
  assert.equal(describeTriage(sample), 'Pothole on Main St (Spring repairs)');
  const relation: IssueRelations['work_package']['target'] = 'WorkPackage' satisfies PackageEntity;
  const pkgOnly: TriageRelationPackage = { id: 7 };
  const shape: TriageShape = { id: 1, display_name: 'x' };
  const row: Pick<IssueRow, 'id'> = { id: sample.id };
  assert.deepEqual([relation, pkgOnly.id, shape.id, row.id, draft.display_name, patch.severity_level], ['WorkPackage', 7, 1, 1, 'Pothole on Main St', 3]);

  // ---- a deliberately mismatched hash ----
  await assert.rejects(bootstrap<Database>({}, 'sha256:0000', 'block'), (err: unknown) => {
    assert.ok(err instanceof SchemaMismatchError);
    const reason: SchemaMismatchReason = err.mismatch.reason;
    assert.equal(reason, 'hash-mismatch');
    return true;
  });
  const warned: SchemaMismatch[] = [];
  const trusting = await bootstrap<Database>({}, 'sha256:0000', 'warn', m => warned.push(m));
  assert.equal(trusting.typed.mode, 'trusted-after-warning');
  assert.equal(warned.length, 1);
  assert.equal((await bootstrap<Database>({}, 'sha256:0000', 'verify', () => undefined)).typed.mode, 'per-call');

  // ---- an instance that demands a newer client than this app ----
  const floor: FixtureOptions = {
    rewrite: { schema_domain_version: rows => rows.map(r => ({ ...r, min_client_domain_version: '9.0.0' })) },
  };
  await assert.rejects(bootstrap<Database>(floor, SCHEMA_HASH, 'warn'), (err: unknown) => {
    assert.ok(err instanceof ClientUpdateRequiredError);
    assert.equal(err.minClientDomainVersion, '9.0.0');
    return true;
  });

  // ---- an instance that lost a column the generated types promise ----
  const lost: FixtureOptions = {
    rewrite: { schema_properties: rows => rows.filter(r => !(r['table_name'] === 'Issue' && r['column_name'] === 'status')) },
  };
  const { typed: degraded } = await bootstrap<Database>(lost, SCHEMA_HASH, 'block'); // the hash is of the contract, which the rewrite does not touch
  assert.throws(
    () => degraded.entities.Issue.property('status'),
    (err: unknown) => err instanceof SchemaContractError && err.entity === 'Issue' && err.member === 'status',
  );

  await runStore();
  await runPlan();

  console.log('sdk-consumer ok');
}

await main();
