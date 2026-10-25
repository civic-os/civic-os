/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { EntityPropertyType } from '../../model/index.js';
import type { SchemaEntityProperty, SchemaEntityTable } from '../../model/index.js';
import { inverseRelationships } from '../../schema/relations.js';
import { manyToManySelect, propertyToSelectString } from '../../schema/select.js';
import { QueryValidationError } from '../encode.js';

/**
 * Options for one embedded relation, as plain data (the typed query types are assignable to it).
 *
 * @consumer typed defineQuery
 */
export interface WithSubQueryInput {
  columns?: readonly string[];
  with?: WithInput;
  limit?: number;
  order?: { column: string; direction: 'asc' | 'desc' };
}

/**
 * A `with` object as plain data. An `undefined` value is skipped.
 *
 * @consumer typed defineQuery
 */
export interface WithInput {
  readonly [relation: string]: true | WithSubQueryInput | undefined;
}

/**
 * The runtime shape of a typed query.
 *
 * @consumer typed defineQuery
 */
export interface WithQueryInput {
  select?: readonly string[];
  with?: WithInput;
}

/**
 * What the compiler reads: enriched, typed properties of every table (M:M properties included, as
 * `enrichPropertiesWithManyToMany` returns them) and the entity list for inverse relations.
 *
 * @consumer typed defineQuery
 */
export interface WithSchemaContext {
  properties: readonly SchemaEntityProperty[];
  tables: readonly SchemaEntityTable[];
}

/**
 * A compiled `with` query. PostgREST takes per-embed `limit` and `order` as query parameters addressed by
 * the embed's alias path (`work_details.limit=5`, `work_package.status.order=display_name.asc`), not inside
 * the select string, so both come back: append `params` to the request next to `select=<select>`.
 *
 * @consumer typed defineQuery
 */
export interface CompiledWith {
  select: string;
  params: string[];
}

type Relation =
  | { kind: 'fk'; prop: SchemaEntityProperty }
  | { kind: 'system'; prop: SchemaEntityProperty }
  | { kind: 'm2m'; prop: SchemaEntityProperty }
  | { kind: 'inverse'; sourceTable: string; sourceColumn: string };

interface Ctx extends WithSchemaContext {
  params: string[];
}

/** Column properties of an entity, in served order; the virtual M:M properties are relations, not columns. */
function columnsOf(ctx: Ctx, entity: string): SchemaEntityProperty[] {
  return ctx.properties.filter(p => p.table_name === entity && p.type !== EntityPropertyType.ManyToMany);
}

/** The relation graph of an entity: M:M properties, then FK columns, then inverse FKs, first name wins. */
function relationsOf(ctx: Ctx, entity: string): Map<string, Relation> {
  const rels = new Map<string, Relation>();
  const own = ctx.properties.filter(p => p.table_name === entity);
  for (const p of own) {
    if (p.type === EntityPropertyType.ManyToMany && p.many_to_many_meta) rels.set(p.column_name, { kind: 'm2m', prop: p });
  }
  for (const p of own) {
    if (p.type === EntityPropertyType.ManyToMany || !p.join_table || !p.join_column || rels.has(p.column_name)) continue;
    rels.set(p.column_name, { kind: p.join_schema === 'public' ? 'fk' : 'system', prop: p });
  }
  for (const inv of inverseRelationships(ctx.properties, ctx.tables, entity)) {
    if (!rels.has(inv.sourceTable)) rels.set(inv.sourceTable, { kind: 'inverse', sourceTable: inv.sourceTable, sourceColumn: inv.sourceColumn });
  }
  return rels;
}

function level(ctx: Ctx, entity: string, columns: readonly string[] | undefined, withInput: WithInput | undefined, path: readonly string[]): string {
  const props = columnsOf(ctx, entity);
  if (!props.length && !ctx.properties.some(p => p.table_name === entity)) {
    throw new QueryValidationError(`unknown entity "${entity}"`);
  }
  const embeds = Object.entries(withInput ?? {}).filter((e): e is [string, true | WithSubQueryInput] => e[1] !== undefined);
  const embedded = new Set(embeds.map(([key]) => key));

  const items: string[] = [];
  for (const name of columns ?? props.map(p => p.column_name)) {
    if (embedded.has(name)) continue; // `with` wins over a same-named column
    const prop = props.find(p => p.column_name === name);
    if (!prop) throw new QueryValidationError(`unknown column "${name}" on "${entity}"`);
    items.push(propertyToSelectString(prop));
  }
  if (embeds.length) {
    const rels = relationsOf(ctx, entity);
    for (const [key, value] of embeds) {
      const rel = rels.get(key);
      if (!rel) throw new QueryValidationError(`unknown relation "${key}" on "${entity}"`);
      items.push(embed(ctx, entity, key, rel, value, path));
    }
  }
  return items.join(',');
}

function embed(ctx: Ctx, entity: string, key: string, rel: Relation, value: true | WithSubQueryInput, path: readonly string[]): string {
  const sub: WithSubQueryInput = value === true ? {} : value;
  const here = [...path, key];

  if (rel.kind === 'system') {
    if (value !== true) throw new QueryValidationError(`"${key}" on "${entity}" is a system embed and takes only true`);
    return propertyToSelectString(rel.prop);
  }

  if (rel.kind === 'm2m') {
    const meta = rel.prop.many_to_many_meta!;
    if (sub.order) throw new QueryValidationError(`order is not supported on the many-to-many "${key}" on "${entity}"`);
    if (!sub.columns && !sub.with) {
      limitParam(ctx, here, sub.limit);
      return propertyToSelectString(rel.prop);
    }
    const inner = level(ctx, meta.relatedTable, sub.columns, sub.with, [...here, meta.relatedTable]);
    limitParam(ctx, here, sub.limit);
    return manyToManySelect(rel.prop, meta, inner);
  }

  const target = rel.kind === 'fk' ? rel.prop.join_table : rel.sourceTable;
  const inner = level(ctx, target, sub.columns, sub.with, here);
  if (sub.order) {
    const dir = sub.order.direction;
    if (dir !== 'asc' && dir !== 'desc') throw new QueryValidationError(`order direction must be asc or desc, got ${String(dir)}`);
    if (!columnsOf(ctx, target).some(p => p.column_name === sub.order!.column)) {
      throw new QueryValidationError(`unknown order column "${sub.order.column}" on "${target}"`);
    }
    ctx.params.push(`${here.join('.')}.order=${sub.order.column}.${dir}`);
  }
  limitParam(ctx, here, sub.limit);
  return rel.kind === 'fk'
    ? `${key}:${target}!${rel.prop.column_name}(${inner})`
    : `${key === target ? '' : key + ':'}${target}!${rel.sourceColumn}(${inner})`;
}

function limitParam(ctx: Ctx, path: readonly string[], limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 0) throw new QueryValidationError(`limit must be an integer >= 0, got ${String(limit)}`);
  ctx.params.push(`${path.join('.')}.limit=${limit}`);
}

/**
 * Compile a typed query into a PostgREST select string (plus per-embed `limit`/`order` parameters).
 *
 * Rules, all through core's own builders so the output equals what the app sends today:
 * - A column in `select` (default: every column) embeds its default shape (`propertyToSelectString`).
 * - `with` wins over a same-named column in `select`.
 * - A relation is addressed by its name: M:M by the virtual property name (`issue_tags_m2m`), an FK by its
 *   column, an inverse FK by its source table. `true` embeds every column of the target with default
 *   shapes; a many-to-many `true` is exactly the property's own embed.
 * - `columns`, `with`, `limit` and `order` apply per embed and nest. A foreign key column pointing into the
 *   `metadata` schema (status, category, user, file, ...) takes only `true`.
 * - Unknown entities, columns, relations and order columns throw {@link QueryValidationError}.
 *
 * The caller adds `id`, `order`, filters and paging the way `compileDataQuery` does.
 *
 * @consumer typed defineQuery
 */
export function compileWith(entity: string, query: WithQueryInput, schema: WithSchemaContext): CompiledWith {
  const ctx: Ctx = { ...schema, params: [] };
  const select = level(ctx, entity, query.select, query.with, []);
  return { select, params: ctx.params };
}
