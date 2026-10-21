/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Golden outputs (MCP): schema interpretation of every raw fixture variant.
 *  - schema.properties.json: detectPropertyType (run on the SchemaCache fetch
 *    path) and propertyToSelectString per property; same keying and field
 *    names as the frontend artifact (fields the MCP has no counterpart for,
 *    such as columnSpan, defaultValue, selectForEdit/ForList and freshTypes,
 *    are absent).
 *  - schema.views.json: filterProperties(list|detail|create|edit) per entity
 *    (the frontend's getPropsFor*; the MCP has no filter view and no
 *    renderables).
 *  - mcp.names.json (MCP-only): NameResolver entity / column / action
 *    resolution over each entity's own identifiers and display names.
 *  - _shared/mcp.type-probes.json (MCP-only): detectPropertyType and
 *    propertyToSelectString over synthetic properties covering every
 *    detection rule, including combinations no example exercises.
 */
import { afterEach, describe, it } from 'vitest';
import { EntityPropertyType } from '@civic-os/core';
import { type SchemaProperty } from '../../interfaces.js';
import { detectPropertyType } from '../../schema-cache.js';
import { filterProperties, propertyToSelectString } from '../../select-builder.js';
import { NameResolutionError } from '../../name-resolver.js';
import { adminVariant, checkGolden, expectNoOrphans, listAllVariants, listExamples } from './golden-io.js';
import { bootVariant, restoreFetch, type McpContext } from './mcp-harness.js';

afterEach(() => restoreFetch());

export function typeName(t: EntityPropertyType | undefined): string {
  return t === undefined ? '?undefined' : (EntityPropertyType[t] ?? `?${t}`);
}

const cols = (props: SchemaProperty[]) => props.map(p => p.column_name);

function attempt(fn: () => string): string {
  try {
    return fn();
  } catch (err) {
    if (err instanceof NameResolutionError) return `ERR ${err.message}`;
    throw err;
  }
}

function namesArtifact(ctx: McpContext) {
  const { cache, resolver } = ctx;
  const entities: Record<string, unknown> = {};
  const columns: Record<string, unknown> = {};
  const actions: Record<string, unknown> = {};
  let columnProbes = 0;
  let columnExpected = 0;
  let actionProbes = 0;
  let actionExpected = 0;

  for (const e of cache.entities) {
    const firstWord = e.display_name.trim().split(/\s+/)[0] ?? '';
    const probe = (input: string) => attempt(() => resolver.resolveEntity(input).table_name);
    entities[e.table_name] = {
      displayName: e.display_name,
      byTableName: probe(e.table_name),
      byDisplayName: probe(e.display_name),
      byUpperDisplayName: probe(e.display_name.toUpperCase()),
      byPaddedDisplayName: probe(`  ${e.display_name}  `),
      byFirstWord: probe(firstWord),
    };

    // Columns: anomalies only (probes that do not resolve to the column itself), plus counts.
    const colAnomalies: Record<string, Record<string, string>> = {};
    for (const p of cache.getProperties(e.table_name)) {
      const probes: Record<string, string> = {
        byColumnName: p.column_name,
        byDisplayName: p.display_name,
        byUpperDisplayName: p.display_name.toUpperCase(),
      };
      for (const [kind, input] of Object.entries(probes)) {
        columnProbes++;
        const got = attempt(() => resolver.resolveColumn(e.table_name, input).column_name);
        if (got === p.column_name) columnExpected++;
        else (colAnomalies[p.column_name] ??= {})[kind] = `${JSON.stringify(input)} -> ${got}`;
      }
    }
    if (Object.keys(colAnomalies).length) columns[e.table_name] = colAnomalies;

    const actAnomalies: Record<string, Record<string, string>> = {};
    for (const a of cache.getActions(e.table_name)) {
      for (const [kind, input] of Object.entries({ byActionName: a.action_name, byDisplayName: a.display_name })) {
        actionProbes++;
        const got = attempt(() => resolver.resolveAction(e.table_name, input).action_name);
        if (got === a.action_name) actionExpected++;
        else (actAnomalies[a.action_name] ??= {})[kind] = `${JSON.stringify(input)} -> ${got}`;
      }
    }
    if (Object.keys(actAnomalies).length) actions[e.table_name] = actAnomalies;
  }

  return {
    entities,
    columnAnomalies: columns,
    columnCounts: { probes: columnProbes, resolvedToSelf: columnExpected },
    actionAnomalies: actions,
    actionCounts: { probes: actionProbes, resolvedToSelf: actionExpected },
  };
}

function statusCategoryArtifact(ctx: McpContext) {
  const { cache, resolver } = ctx;
  const statuses: Record<string, Record<string, unknown>> = {};
  for (const s of cache.statuses) {
    const probe = (input: string) => attempt(() => String(resolver.resolveStatus(s.entity_type, input)));
    statuses[s.entity_type] ??= {};
    statuses[s.entity_type][`${s.id} ${s.display_name}`] = {
      statusKey: s.status_key ?? null,
      byStatusKey: s.status_key ? probe(s.status_key) : null,
      byDisplayName: probe(s.display_name),
      byUpperDisplayName: probe(s.display_name.toUpperCase()),
      byPaddedDisplayName: probe(` ${s.display_name} `),
    };
  }
  const categories: Record<string, Record<string, unknown>> = {};
  for (const c of cache.categories) {
    const probe = (input: string) => attempt(() => String(resolver.resolveCategory(c.entity_type, input)));
    categories[c.entity_type] ??= {};
    categories[c.entity_type][`${c.id} ${c.display_name}`] = {
      byDisplayName: probe(c.display_name),
      byUpperDisplayName: probe(c.display_name.toUpperCase()),
      byPaddedDisplayName: probe(` ${c.display_name} `),
    };
  }
  return { statuses, categories };
}

// ---------------------------------------------------------------------------
// Synthetic type-detection probes
// ---------------------------------------------------------------------------

function probeProp(overrides: Partial<SchemaProperty>): SchemaProperty {
  return {
    table_name: 'probe',
    column_name: 'col',
    display_name: 'Col',
    data_type: 'text',
    udt_name: 'text',
    udt_schema: 'pg_catalog',
    sort_order: 1,
    join_schema: null as unknown as string,
    join_table: null as unknown as string,
    join_column: null as unknown as string,
    geography_type: null as unknown as string,
    is_nullable: true,
    is_updatable: true,
    is_identity: false,
    is_generated: false,
    is_self_referencing: false,
    column_default: null as unknown as string,
    validation_rules: [],
    ...overrides,
  };
}

const fk = (udt: string, schema: string, table: string, column = 'id', dataType = udt === 'uuid' ? 'uuid' : 'integer') =>
  ({ udt_name: udt, data_type: dataType, join_schema: schema, join_table: table, join_column: column });
const fileRule = (value: string) => ({ validation_rules: [{ type: 'fileType', value, message: 'm' }] });
const geo = (geographyType: string | null, dataType = 'USER-DEFINED') =>
  ({ udt_name: 'geography', udt_schema: 'postgis', data_type: dataType, geography_type: geographyType as string });

/** name -> property overrides. Names are stable identifiers used by the ledger. */
export const TYPE_PROBES: Record<string, Partial<SchemaProperty>> = {
  'int4 fk public': fk('int4', 'public', 'parents'),
  'int8 fk public': fk('int8', 'public', 'parents', 'id', 'bigint'),
  'int4 join_column only': { udt_name: 'int4', data_type: 'integer', join_column: 'id' },
  'int4 join_table only': { udt_name: 'int4', data_type: 'integer', join_schema: 'public', join_table: 'parents' },
  'int4 fk join_column display_name': fk('int4', 'public', 'roles', 'display_name'),
  'int4 fk metadata.statuses without status_entity_type': fk('int4', 'metadata', 'statuses'),
  'int2 plain': { udt_name: 'int2', data_type: 'smallint' },
  'int2 fk': fk('int2', 'public', 'parents', 'id', 'smallint'),
  'status int4': { ...fk('int4', 'metadata', 'statuses'), status_entity_type: 'issue' },
  'status int8': { ...fk('int8', 'metadata', 'statuses', 'id', 'bigint'), status_entity_type: 'issue' },
  'status uuid fk': { ...fk('uuid', 'public', 'workflow_states'), status_entity_type: 'issue' },
  'status text fk': { ...fk('text', 'public', 'workflow_states', 'key', 'text'), status_entity_type: 'issue' },
  'status int4 join_column only': { udt_name: 'int4', data_type: 'integer', join_column: 'id', status_entity_type: 'issue' },
  'status without fk': { udt_name: 'int4', data_type: 'integer', status_entity_type: 'issue' },
  'category int4': { ...fk('int4', 'metadata', 'categories'), category_entity_type: 'kind' },
  'category varchar fk': { ...fk('varchar', 'public', 'kinds', 'code', 'character varying'), category_entity_type: 'kind' },
  'files uuid image/png': { ...fk('uuid', 'metadata', 'files'), ...fileRule('image/png') },
  'files uuid image/*': { ...fk('uuid', 'metadata', 'files'), ...fileRule('image/*') },
  'files uuid "image" (no slash)': { ...fk('uuid', 'metadata', 'files'), ...fileRule('image') },
  'files uuid pdf': { ...fk('uuid', 'metadata', 'files'), ...fileRule('application/pdf') },
  'files uuid other': { ...fk('uuid', 'metadata', 'files'), ...fileRule('text/csv') },
  'files uuid no rule': fk('uuid', 'metadata', 'files'),
  'files int8 fk': fk('int8', 'metadata', 'files', 'id', 'bigint'),
  'civic_os_users uuid': fk('uuid', 'metadata', 'civic_os_users'),
  'civic_os_users int8': fk('int8', 'metadata', 'civic_os_users', 'id', 'bigint'),
  'civic_os_users_private uuid': fk('uuid', 'metadata', 'civic_os_users_private'),
  'payment_transactions uuid': fk('uuid', 'public', 'payment_transactions'),
  'transactions uuid payments schema': fk('uuid', 'payments', 'transactions'),
  'transactions uuid public schema': fk('uuid', 'public', 'transactions'),
  'photo_galleries uuid': fk('uuid', 'metadata', 'photo_galleries'),
  'photo_galleries int4': fk('int4', 'metadata', 'photo_galleries'),
  'uuid plain': { udt_name: 'uuid', data_type: 'uuid' },
  'uuid fk public non-system': fk('uuid', 'public', 'documents'),
  'varchar fk': fk('varchar', 'public', 'codes', 'code', 'character varying'),
  'text fk': fk('text', 'public', 'codes', 'code', 'text'),
  'citext fk (unknown udt)': fk('citext', 'public', 'codes', 'code', 'USER-DEFINED'),
  'citext plain (unknown udt)': { udt_name: 'citext', data_type: 'USER-DEFINED' },
  'geography Point': geo('Point'),
  'geography Polygon': geo('Polygon'),
  'geography MultiPolygon': geo('MultiPolygon'),
  'geography LineString': geo('LineString'),
  'geography null geography_type': geo(null),
  'geography Point data_type not USER-DEFINED': geo('Point', 'geography'),
  'bpchar': { udt_name: 'bpchar', data_type: 'character' },
  'varchar': { udt_name: 'varchar', data_type: 'character varying' },
  'text': { udt_name: 'text', data_type: 'text' },
  'tsvector': { udt_name: 'tsvector', data_type: 'tsvector' },
  'jsonb': { udt_name: 'jsonb', data_type: 'jsonb' },
  'int4': { udt_name: 'int4', data_type: 'integer' },
  'int8': { udt_name: 'int8', data_type: 'bigint' },
  'numeric': { udt_name: 'numeric', data_type: 'numeric' },
  'float4': { udt_name: 'float4', data_type: 'real' },
  'float8': { udt_name: 'float8', data_type: 'double precision' },
  'money': { udt_name: 'money', data_type: 'money' },
  'bool': { udt_name: 'bool', data_type: 'boolean' },
  'date': { udt_name: 'date', data_type: 'date' },
  'timestamp': { udt_name: 'timestamp', data_type: 'timestamp without time zone' },
  'timestamptz': { udt_name: 'timestamptz', data_type: 'timestamp with time zone' },
  'hex_color': { udt_name: 'hex_color', data_type: 'character varying' },
  'email_address': { udt_name: 'email_address', data_type: 'character varying' },
  'phone_number': { udt_name: 'phone_number', data_type: 'character varying' },
  'markdown': { udt_name: 'markdown', data_type: 'text' },
  'time_slot': { udt_name: 'time_slot', data_type: 'tstzrange' },
  'time_slot recurring': { udt_name: 'time_slot', data_type: 'tstzrange', is_recurring: true },
};

describe('golden (mcp): schema interpretation', () => {
  for (const v of listAllVariants()) {
    it(`${v.example}/${v.variant}: property types and select strings`, async () => {
      const ctx = await bootVariant(v);
      const entities: Record<string, unknown[]> = {};
      for (const p of ctx.cache.properties) {
        (entities[p.table_name] ??= []).push({
          column: p.column_name,
          type: typeName(p.type),
          typeId: p.type,
          select: propertyToSelectString(p),
        });
      }
      checkGolden(`${v.example}/${v.variant}/schema.properties.json`, { entities });
    });

    it(`${v.example}/${v.variant}: filterProperties views`, async () => {
      const ctx = await bootVariant(v);
      const entities: Record<string, unknown> = {};
      for (const e of ctx.cache.entities) {
        const props = ctx.cache.getProperties(e.table_name);
        entities[e.table_name] = {
          list: cols(filterProperties(props, 'list')),
          detail: cols(filterProperties(props, 'detail')),
          create: cols(filterProperties(props, 'create')),
          edit: cols(filterProperties(props, 'edit')),
        };
      }
      checkGolden(`${v.example}/${v.variant}/schema.views.json`, { entities });
    });

    // The MCP never sends Accept-Language, so it never receives the translated
    // (.es) fixtures in production: no MCP-only artifacts for those variants.
    if (v.locale === 'en') {
      it(`${v.example}/${v.variant}: entity, column and action name resolution`, async () => {
        const ctx = await bootVariant(v);
        checkGolden(`${v.example}/${v.variant}/mcp.names.json`, namesArtifact(ctx));
      });
    }
  }

  for (const example of listExamples()) {
    it(`${example}: status and category name resolution`, async () => {
      const ctx = await bootVariant(adminVariant(example));
      checkGolden(`${example}/_example/mcp.names-status-category.json`, statusCategoryArtifact(ctx));
    });
  }

  it('synthetic type-detection probes', () => {
    const probes = Object.entries(TYPE_PROBES).map(([name, overrides]) => {
      const p = probeProp(overrides);
      const t = detectPropertyType(p);
      p.type = t;
      return { name, input: overrides, type: typeName(t), typeId: t, select: propertyToSelectString(p) };
    });
    checkGolden('_shared/mcp.type-probes.json', { base: probeProp({}), probes });
  });

  it('no orphan schema / names golden files', () => {
    expectNoOrphans(rel => /(^|\/)(schema\.[a-z-]+|mcp\.names|mcp\.names-status-category|mcp\.type-probes)\.json$/.test(rel));
  });
});
