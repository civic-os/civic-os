/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { EntityPropertyType } from '../../model/index.js';
import type { SchemaEntityProperty, SchemaEntityTable } from '../../model/index.js';
import { inverseRelationships } from '../../schema/relations.js';

/**
 * What the graph reads: enriched properties of every table (M:M properties included) and the entity list.
 *
 * @consumer tooling
 */
export interface GraphContext {
  properties: readonly SchemaEntityProperty[];
  tables: readonly SchemaEntityTable[];
}

/**
 * One edge of the relation graph `with` addresses: a public foreign key (`fk`), a foreign key into a system
 * table (`system`: status, category, user, file, ...), a many-to-many (`m2m`) or an inverse foreign key.
 *
 * @consumer tooling
 */
export type RelationEdge =
  | { kind: 'fk'; prop: SchemaEntityProperty }
  | { kind: 'system'; prop: SchemaEntityProperty }
  | { kind: 'm2m'; prop: SchemaEntityProperty }
  | { kind: 'inverse'; sourceTable: string; sourceColumn: string };

/**
 * True for a stored column that a default select returns. The virtual many-to-many properties are
 * relations, and a tsvector column (`civic_os_text_search`) is an index payload for `wfts` filters, never a
 * value to ship to a client.
 *
 * @consumer tooling
 */
export function isSelectableColumn(prop: SchemaEntityProperty): boolean {
  return prop.type !== EntityPropertyType.ManyToMany && prop.udt_name !== 'tsvector';
}

/**
 * The columns of an entity a default select returns, in served order. The typed `Row` of an entity has
 * exactly these keys.
 *
 * @consumer tooling
 */
export function defaultColumns(properties: readonly SchemaEntityProperty[], entity: string): SchemaEntityProperty[] {
  return properties.filter(p => p.table_name === entity && isSelectableColumn(p));
}

/**
 * The relation graph of an entity: M:M properties, then FK columns, then inverse FKs, first name wins. The
 * keys are the names `compileWith` accepts under `with`.
 *
 * @consumer tooling
 */
export function relationGraph(ctx: GraphContext, entity: string): Map<string, RelationEdge> {
  const rels = new Map<string, RelationEdge>();
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
