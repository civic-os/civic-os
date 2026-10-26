/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EntityPropertyType,
  defaultColumns,
  enrichPropertiesWithManyToMany,
  getPropertyType,
  propertyToSelectString,
  relationGraph,
} from '@civic-os/core';
import type { SchemaEntityProperty, SchemaEntityTable, WithSchemaContext } from '@civic-os/core';
import { STATUS_KEY_TYPE, SYSTEM_SHAPES, parseSelect } from './embed.js';
import type { SelectItem } from './embed.js';
import type { RawSchema } from './load.js';
import { actionParamType, columnType } from './ts-types.js';

/**
 * A type in the generated file: scalar text, or an object of fields, optionally an array and optionally
 * nullable.
 *
 * @consumer tooling
 */
export interface TypeNode {
  /** Scalar or named type, as TypeScript text. Absent when `fields` is set. */
  text?: string;
  fields?: FieldNode[];
  many?: boolean;
  nullable: boolean;
}

/**
 * @consumer tooling
 */
export interface FieldNode {
  name: string;
  type: TypeNode;
}

/**
 * @consumer tooling
 */
export interface RowColumn {
  name: string;
  type: TypeNode;
  /** Insert accepts the column but does not require it (default, identity or nullable). */
  optional: boolean;
  /** Generated columns are not insertable. */
  generated: boolean;
  /** A comment line for the generated file. */
  note?: string;
}

/**
 * A column whose default select embeds related rows: `fields` are the embed's field list, parsed from core's
 * own `propertyToSelectString`.
 *
 * @consumer tooling
 */
export interface EmbeddedColumn {
  column: string;
  /** The default embed string `propertyToSelectString` returned for the column. */
  select: string;
  type: TypeNode;
}

/**
 * @consumer tooling
 */
export interface RelationModel {
  key: string;
  kind: 'one' | 'many';
  target: string;
  /** For `one` only. */
  nullable?: boolean;
  /** For a many-to-many only: its default embed is the target's id, display_name and color. */
  via?: 'junction';
}

/**
 * @consumer tooling
 */
export interface ActionModel {
  name: string;
  params: { name: string; type: string; required: boolean }[];
}

/**
 * @consumer tooling
 */
export interface FeatureFlags {
  notes: boolean;
  calendar: boolean;
  map: boolean;
  payment: boolean;
  guidedForm: boolean;
  recurring: boolean;
}

/**
 * @consumer tooling
 */
export interface EntityModel {
  name: string;
  /** `<Pascal>StatusKey` when the entity has a Status column. */
  statusKeyType: string | undefined;
  /** The data-derived `status_key` values of the entity's status types, sorted. */
  statusKeys: string[];
  row: RowColumn[];
  embedded: EmbeddedColumn[];
  relations: RelationModel[];
  actions: ActionModel[];
  features: FeatureFlags;
}

/**
 * The structured intermediate: everything the emitter prints and the cross-check test asserts against.
 *
 * @consumer tooling
 */
export interface CodegenModel {
  source: string;
  domainVersion: string;
  frameworkVersion: string | null;
  schemaHash: string;
  entities: EntityModel[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Interpret the raw views the way the app and the MCP server do: `getPropertyType` on every row, then M:M
 * enrichment. The result is what `compileWith` reads.
 *
 * @consumer tooling
 */
export function prepareContext(raw: RawSchema): WithSchemaContext {
  const tables = raw.entities;
  const rows = raw.properties.map(p => ({ ...p }));
  for (const p of rows) p.type = getPropertyType(p);
  return { tables, properties: enrichPropertiesWithManyToMany(rows, tables, raw.m2m) };
}

/** `reservation_requests` and `WorkPackage` to `ReservationRequests` and `WorkPackage`. */
function pascal(name: string): string {
  const id = name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1)).join('');
  return /^[0-9]/.test(id) ? `_${id}` : id || '_';
}

function scalar(text: string, nullable: boolean): TypeNode {
  return { text, nullable };
}

function rowType(prop: SchemaEntityProperty): TypeNode {
  return scalar(columnType(prop), prop.is_nullable);
}

/**
 * Build the model from the raw views.
 *
 * @consumer tooling
 */
export function buildModel(raw: RawSchema): CodegenModel {
  const ctx = prepareContext(raw);
  const entityNames = new Set(ctx.tables.map(t => t.table_name));

  // Status keys per status entity_type, sorted; a type name per entity, unique across entities.
  const keysByType = new Map<string, string[]>();
  for (const s of raw.statuses) {
    if (s.status_key === undefined || s.status_key === null) continue;
    const keys = keysByType.get(s.entity_type) ?? [];
    keys.push(s.status_key);
    keysByType.set(s.entity_type, keys);
  }
  const typeNames = new Map<string, string>();
  const taken = new Set<string>();
  for (const name of [...entityNames].sort(cmp)) {
    let ident = `${pascal(name)}StatusKey`;
    for (let n = 2; taken.has(ident); n++) ident = `${pascal(name)}StatusKey${n}`;
    taken.add(ident);
    typeNames.set(name, ident);
  }

  const propsOf = new Map<string, SchemaEntityProperty[]>();
  for (const p of ctx.properties) {
    const list = propsOf.get(p.table_name) ?? [];
    list.push(p);
    propsOf.set(p.table_name, list);
  }
  const column = (table: string, name: string): SchemaEntityProperty | undefined =>
    propsOf.get(table)?.find(p => p.column_name === name && p.type !== EntityPropertyType.ManyToMany);

  // A field of an embedded table: a system shape (fixed), or a column of the target entity.
  const embedField = (table: string, item: SelectItem, statusKeyType: string | undefined): FieldNode => {
    const sys = SYSTEM_SHAPES[table];
    if (item.children) {
      const nested = sys?.[item.name];
      const shape = nested?.table ? SYSTEM_SHAPES[nested.table] : undefined;
      if (!nested?.table || !shape) return { name: item.key, type: scalar('unknown', false) };
      return {
        name: item.key,
        type: {
          fields: item.children.map(c => embedField(nested.table!, c, statusKeyType)),
          many: nested.many === true,
          nullable: false,
        },
      };
    }
    if (sys) {
      const f = sys[item.name];
      if (!f?.ts) return { name: item.key, type: scalar('unknown', false) };
      const text = f.ts === STATUS_KEY_TYPE ? (statusKeyType ?? 'string') : f.ts;
      return { name: item.key, type: scalar(text, f.nullable === true) };
    }
    const prop = column(table, item.name);
    return { name: item.key, type: prop ? rowType(prop) : scalar('unknown', false) };
  };

  const entities: EntityModel[] = [...ctx.tables].sort((a, b) => cmp(a.table_name, b.table_name)).map(table => {
    const name = table.table_name;
    const columns = defaultColumns(ctx.properties, name);
    const statusTypes = [...new Set(columns.filter(p => p.type === EntityPropertyType.Status && p.status_entity_type)
      .map(p => p.status_entity_type!))].sort(cmp);
    const statusKeys = [...new Set(statusTypes.flatMap(t => keysByType.get(t) ?? []))].sort(cmp);
    const statusKeyType = statusTypes.length ? typeNames.get(name) : undefined;

    const row: RowColumn[] = columns.map(p => ({
      name: p.column_name,
      type: rowType(p),
      optional: p.column_default != null && p.column_default !== '' || p.is_identity || p.is_nullable,
      generated: p.is_generated,
      ...(p.type === EntityPropertyType.GeoPoint || p.type === EntityPropertyType.GeoPolygon
        ? { note: `${p.type === EntityPropertyType.GeoPoint ? 'geography(Point)' : 'geography(Polygon)'}: the default select returns the ${p.column_name}_text WKT string aliased to ${p.column_name}` }
        : {}),
    })).sort((a, b) => cmp(a.name, b.name));

    const embedded: EmbeddedColumn[] = [];
    for (const p of columns) {
      const select = propertyToSelectString(p);
      const top = parseSelect(select);
      const only = top[0];
      if (top.length !== 1 || !only?.children) continue; // plain columns and the geography alias are not embeds
      embedded.push({
        column: p.column_name,
        select,
        type: {
          fields: only.children.map(c => embedField(only.name, c, statusKeyType)),
          nullable: p.is_nullable,
        },
      });
    }
    embedded.sort((a, b) => cmp(a.column, b.column));

    const relations: RelationModel[] = [];
    for (const [key, edge] of relationGraph(ctx, name)) {
      if (edge.kind === 'system') continue; // statuses, categories, users and files are not entities; the default select embeds them
      if (edge.kind === 'fk') {
        if (!entityNames.has(edge.prop.join_table)) continue;
        relations.push({ key, kind: 'one', target: edge.prop.join_table, nullable: edge.prop.is_nullable });
      } else if (edge.kind === 'm2m') {
        const target = edge.prop.many_to_many_meta!.relatedTable;
        if (entityNames.has(target)) relations.push({ key, kind: 'many', target, via: 'junction' });
      } else if (entityNames.has(edge.sourceTable)) {
        relations.push({ key, kind: 'many', target: edge.sourceTable });
      }
    }
    relations.sort((a, b) => cmp(a.key, b.key));

    const seen = new Set<string>();
    const actions: ActionModel[] = raw.actions
      .filter(a => a.table_name === name && !seen.has(a.action_name) && seen.add(a.action_name))
      .map(a => ({
        name: a.action_name,
        params: [...(a.parameters ?? [])].sort((x, y) => cmp(x.param_name, y.param_name)).map(param => ({
          name: param.param_name,
          required: param.required,
          type: actionParamType(param.param_type, param.join_table ? idTypeOf(column(param.join_table, 'id')) : undefined),
        })),
      }))
      .sort((a, b) => cmp(a.name, b.name));

    return {
      name,
      statusKeyType,
      statusKeys,
      row,
      embedded,
      relations,
      actions,
      features: featuresOf(table),
    };
  });

  return {
    source: raw.source,
    domainVersion: raw.domainVersion.domain_version,
    frameworkVersion: raw.domainVersion.framework_version ?? null,
    schemaHash: raw.domainVersion.contract_hash,
    entities,
  };
}

function idTypeOf(prop: SchemaEntityProperty | undefined): string | undefined {
  return prop ? columnType(prop) : undefined;
}

function featuresOf(t: SchemaEntityTable): FeatureFlags {
  return {
    notes: t.enable_notes === true,
    calendar: t.show_calendar === true,
    map: t.show_map === true,
    payment: !!t.payment_initiation_rpc,
    guidedForm: !!t.guided_form_key,
    recurring: t.supports_recurring === true,
  };
}
